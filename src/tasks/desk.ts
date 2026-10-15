import { randomBytes } from "node:crypto";
import { boardHash, columnById, formatBoardError, isFlow, parseBoard, type Phase } from "@reemoat/board";
import { BoardEngine, type Advanced, type BoardJudges, type FleetMachine, type TaskView } from "../board/engine.js";
import type { SessionStatus, TaskProposal } from "../events.js";
import type { PeerAnswer } from "../peers/channel.js";
import { address, parseAddress } from "../peers/envelope.js";
import { AgentUnavailableError } from "../acp/agents.js";
import type { ManagedSession, SessionRegistry, WorktreePolicy } from "../registry.js";
import type { PeerLink } from "../store/sqlite.js";
import {
  isTaskAssignee,
  MAX_TASKS,
  MAX_TASK_SUMMARY_CHARS,
  MAX_TASK_TITLE_CHARS,
  MemoryBoardConfigStore,
  TOMBSTONE_KEEP_MS,
  type BoardConfigStore,
  type StoredTaskStatus,
  type TaskAssignee,
  type TaskComment,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
  type TaskStore,
} from "./store.js";
import {
  DISPATCH_NICKNAME,
  isAgentRef,
  isProjectPath,
  parseProposals,
  MAX_BOARD_WHY_CHARS,
  parseTaskUpdate,
  type ProposedTask,
} from "./tools.js";

/** One list_tasks or list_projects fans out to every linked machine; as long as list_agents waits for one (Q2.259). */
export const REMOTE_BOARD_TIMEOUT_MS = 3_000;
export const REMOTE_BOARD_TTL_MS = 15_000;
const REMOTE_BOARD_CONCURRENCY = 8;
export const MAX_LISTED_PROJECTS = 100;
const MAX_REMOTE_TASKS = MAX_TASKS;
const MAX_REMOTE_AGENTS = 64;
const MAX_REMOTE_ID_CHARS = 64;
const MAX_REMOTE_STATUS_CHARS = 32;
const REMOTE_STATUS = /^[a-z_]+$/;

export interface TaskSessionRef {
  id: string;
  agent: string;
  nickname: string;
  status: SessionStatus;
  attachedAt: number;
}

/** A task as every reader is shown it: the record, where it stands on the board, and its sessions. Flat, for the hand mirror in wire.ts. */
export interface TaskSnapshot {
  id: string;
  title: string;
  brief: string;
  /** What a client from before the board reads, by the phase table (Q2.264). */
  status: TaskStatus;
  column: string;
  phase: Phase;
  epoch: number;
  run: TaskView["run"];
  code: TaskView["code"];
  waitingSince: number | null;
  holder: string;
  exits: TaskView["exits"];
  reason: string | null;
  budget: number;
  labels: string[];
  summary: string | null;
  summaryAt: number | null;
  summaryBy: string | null;
  agent: string;
  customAgent: string | null;
  assignee: TaskAssignee;
  cwd: string;
  key: string | null;
  createdAt: number;
  updatedAt: number;
  sessions: TaskSessionRef[];
}

export interface NewTask {
  title: string;
  brief: string;
  agent: string;
  customAgent: string | null;
  assignee: TaskAssignee;
  /** Where an older client puts it: the backlog, or a column a person dropped it into (Q2.262). */
  status: StoredTaskStatus;
  /** Where this one puts it, which wins over the status. */
  column?: string | null;
  cwd: string;
  key: string | null;
  labels?: string[];
}

export interface TaskChange {
  title?: string;
  brief?: string;
  /** `""` clears it. */
  summary?: string;
  status?: StoredTaskStatus;
  /** The assignee: what the next start launches, and where. */
  agent?: string;
  customAgent?: string | null;
  /** Nobody or its person; the agent it names stays what a start would launch. */
  assignee?: TaskAssignee;
  cwd?: string;
  labels?: string[];
}

/** The other machines' half, handed in: the hub's links and its switches (Q2.244). */
export interface TaskPeers {
  readonly machineId: string | null;
  /** Linked machines this caller's agent may ask now: none where messaging is off, isolated, or off for the conversation. */
  linksFor(callerId: string): PeerLink[];
  askLink(link: PeerLink, path: string, timeoutMs: number): Promise<PeerAnswer>;
  /** Links a task's run may cross, and one request over one; absent on a desk with no network. */
  handoffLinks?(): PeerLink[];
  request?(link: PeerLink, request: { method: "GET" | "POST"; path: string; body?: unknown }, timeoutMs?: number): Promise<PeerAnswer>;
}

export interface BoardMachine {
  /** null is this machine. */
  id: string | null;
  label: string | null;
  isThis: boolean;
}

export interface ProjectRows {
  machine: BoardMachine;
  agents: string[];
  projects: string[];
}

/** What a machine's /peer/projects says beyond the rows list_projects prints: what the board needs to place a run there. */
export interface ProjectsAnswer {
  agents: string[];
  projects: string[];
  classifiers: string[];
  /** Each project's identity, its origin's name, where it has one. */
  repos: string[];
  /** 1 where the daemon runs the configurable board; an older one says nothing. */
  board: number | null;
  boardRevision: number | null;
  boardHash: string | null;
}

export interface ProjectListing {
  machines: ProjectRows[];
  unreachable: { machine: string; reason: string }[];
}

export interface TaskRow {
  machine: BoardMachine;
  id: string;
  title: string;
  status: string;
  agent: string;
  /** Who holds it in the backlog: the agent, its person, or nobody yet. */
  assignee: TaskAssignee;
  project: string;
  summary: string | null;
  sessions: string[];
}

export interface TaskListing {
  tasks: TaskRow[];
  unreachable: { machine: string; reason: string }[];
}

export type ProposeResult = { ok: true; proposals: TaskProposal[] } | { ok: false; message: string };
/** `recorded` is the status the agent wrote, where it wrote one: what the task reads once nothing is working on it. */
export type TaskUpdateResult = { ok: true; task: TaskSnapshot; recorded: StoredTaskStatus | null; working: boolean } | { ok: false; message: string };

type Remote<T> = T | { reason: string };

export interface TaskDeskOptions {
  registry: SessionRegistry;
  store: TaskStore;
  peers?: TaskPeers | null;
  now?: () => number;
  /** The board's revisions; a desk with none runs the default board. */
  configs?: BoardConfigStore;
  machineName?: string;
  customAgents?: () => readonly { id: string; name: string; harness: string }[];
  onWarning?: (detail: string) => void;
  /** 0 runs no timer, for the drivers. */
  tickMs?: number;
  /** Who a role's question goes to; absent, every role abstains. */
  judges?: BoardJudges | null;
}

export type MoveResult = { ok: true; task: TaskRecord } | { ok: false; code: "task_moved" | "task_working" | "no_column" | "no_exit"; message: string };

/** Every task on this machine and every door to one: the routes, the four tools, and what a linked machine may read. */
export class TaskDesk {
  private readonly registry: SessionRegistry;
  private readonly store: TaskStore;
  private readonly peers: TaskPeers | null;
  private readonly now: () => number;
  private readonly remote = new Map<string, { at: number; answer: Promise<Remote<unknown>> }>();
  readonly engine: BoardEngine;

  constructor(options: TaskDeskOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.peers = options.peers ?? null;
    this.now = options.now ?? Date.now;
    this.engine = new BoardEngine({
      registry: options.registry,
      store: options.store,
      configs: options.configs ?? new MemoryBoardConfigStore(),
      machineId: options.peers?.machineId ?? null,
      ...(options.machineName === undefined ? {} : { machineName: options.machineName }),
      ...(options.customAgents === undefined ? {} : { customAgents: options.customAgents }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
      now: this.now,
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      judges: options.judges ?? null,
      fleet: options.peers?.handoffLinks === undefined ? null : () => this.fleet(),
      send: options.peers?.request === undefined ? null : (machine, request, timeoutMs) => this.send(machine, request, timeoutMs),
    });
    this.engine.start();
  }

  /** The owner's machines a run may go to, from their own listings: what each runs and which projects it has (Q2.269). */
  private async fleet(): Promise<FleetMachine[]> {
    const peers = this.peers;
    if (peers === null || peers.handoffLinks === undefined) return [];
    const out: FleetMachine[] = [];
    const links = peers.handoffLinks();
    const answers = await Promise.all(links.map((link) => this.askLink(peers, link, "/peer/projects", remoteProjectsOf)));
    links.forEach((link, index) => {
      const answer = answers[index]!;
      // An older daemon says nothing of the board, and is no place for a run: it would not know what to do with one.
      if ("reason" in answer || answer.board !== 1) return;
      out.push({
        offer: {
          key: link.targetMachineId,
          name: link.targetName,
          online: true,
          agents: [
            ...answer.agents.map((id) => ({ id, name: id, kind: "harness" as const, harness: null })),
            ...answer.classifiers.map((id) => ({ id, name: id.includes(":") ? id.slice(id.indexOf(":") + 1) : id, kind: "classifier" as const, harness: null })),
          ],
          projects: answer.repos,
          running: 0,
        },
        boardRevision: answer.boardRevision,
        boardHash: answer.boardHash,
      });
    });
    // A machine holding a newer board than this one is read from: the account has one board (Q2.266).
    const state = this.engine.current;
    const newer = out.find((one) => one.boardRevision !== null && one.boardHash !== null && (one.boardRevision > state.revision || (one.boardRevision === state.revision && one.boardHash < state.hash)));
    if (newer !== undefined) await this.engine.pullBoard(newer.offer.key);
    return out;
  }

  private async send(machine: string, request: { method: "GET" | "POST"; path: string; body?: unknown }, timeoutMs?: number) {
    const peers = this.peers;
    const link = peers?.handoffLinks?.().find((one) => one.targetMachineId === machine);
    if (peers == null || link === undefined || peers.request === undefined) return { ok: false as const, status: 0, code: "no_link" };
    const answer = await peers.request(link, request, timeoutMs);
    return answer.ok ? { ok: true as const, status: answer.status, body: answer.body } : { ok: false as const, status: answer.status, code: answer.code };
  }

  /** Once the daemon has restored its sessions: every task is looked at again, a run cut by the restart included. */
  resume(): void {
    this.engine.kickAll();
  }

  list(): TaskSnapshot[] {
    const bySession = this.attachedSessions();
    return this.store.list().map((task) => this.snapshotOf(task, bySession.get(task.id) ?? []));
  }

  get(id: string): TaskRecord | null {
    return this.store.get(id);
  }

  snapshot(task: TaskRecord): TaskSnapshot {
    return this.snapshotOf(task, this.attachedSessions().get(task.id) ?? []);
  }

  /** The task a session works on, which is the only one its agent may change. */
  taskOf(sessionId: string): TaskRecord | null {
    const attachment = this.store.attachments().find((one) => one.sessionId === sessionId);
    return attachment === undefined ? null : this.store.get(attachment.taskId);
  }

  /** A create naming a key a task already holds answers that task: a POST nobody heard the answer to is sent again. */
  create(input: NewTask): { task: TaskRecord; existing: boolean } | "full" {
    if (input.key !== null) {
      const held = this.store.byKey(input.key);
      if (held !== null) return { task: held, existing: true };
    }
    const all = this.store.list();
    if (all.length >= MAX_TASKS) {
      const oldestDone = all.filter((task) => this.isClosed(task)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldestDone === undefined) return "full";
      this.store.remove(oldestDone.id);
    }
    const at = this.now();
    const column = input.column ?? this.engine.columnForStatus(input.status);
    const task: TaskRecord = {
      id: `t_${randomBytes(9).toString("base64url")}`,
      title: input.title,
      brief: input.brief,
      status: input.status,
      summary: null,
      summaryAt: null,
      summaryBy: null,
      agent: input.agent,
      customAgent: input.customAgent,
      assignee: input.assignee,
      cwd: input.cwd,
      key: input.key,
      createdAt: at,
      updatedAt: at,
      flow: { ...this.engine.initialFlow(column), labels: input.labels ?? [] },
    };
    this.store.save(task);
    this.engine.event(task, "created", `created in ${this.columnTitle(column)}`);
    return { task, existing: false };
  }

  private columnTitle(id: string): string {
    return columnById(this.engine.current.board, id)?.title ?? id;
  }

  /** In a final column: closed, and the first to make room for a new task. */
  isClosed(task: TaskRecord): boolean {
    const column = columnById(this.engine.current.board, task.flow.column);
    return column !== null && column.kind === "wait" && column.final;
  }

  /** The board's first work column, where a start puts a task. */
  firstWorkColumn(): string | null {
    return this.engine.current.board.columns.find((column) => column.kind === "work")?.id ?? null;
  }

  /** A start: into the first work column by its person's hand, and its run started before this answers. */
  async startNow(task: TaskRecord, launch: { nickname: string | null; worktree: WorktreePolicy | undefined } | null = null): Promise<Advanced & { task: TaskRecord }> {
    const to = this.firstWorkColumn();
    if (to === null) return { task, started: null, refused: new Error("this board has no column that runs an agent") };
    if (launch !== null) this.engine.nextLaunch(task.id, launch);
    const moved = this.engine.move(task, to, "start");
    const advanced = await this.engine.kick(moved.id);
    const latest = this.store.get(task.id) ?? moved;
    if (advanced.started !== null || advanced.refused !== null) return { ...advanced, task: latest };
    // Nothing started and nothing refused: the board is waiting for an agent this machine cannot run, which a person's start is told.
    let hint: string | null = null;
    try {
      const own = (await this.registry.sessionRuntime.availability()).find((one) => one.id === latest.agent);
      if (own !== undefined && !own.available) hint = own.hint ?? `${latest.agent} is not available here`;
    } catch {
      // A probe that failed says nothing; the board's own words stand in.
    }
    const why = hint ?? latest.flow.wait?.detail ?? latest.flow.ask?.detail ?? "the board did not start this task";
    return { ...advanced, refused: hint !== null ? new AgentUnavailableError(why) : new Error(why), task: latest };
  }

  /** A person's move, by column or by exit; refused when the task is no longer where they saw it, or its run is at work. */
  move(id: string, target: { to?: string | null; exit?: string | null; from?: string | null }): MoveResult {
    const task = this.store.get(id);
    if (task === null) return { ok: false, code: "no_column", message: "no such task" };
    if (target.from != null && target.from !== task.flow.column) {
      return { ok: false, code: "task_moved", message: `the task is in ${this.columnTitle(task.flow.column)} now` };
    }
    const board = this.engine.current.board;
    let to = target.to ?? null;
    let exit = target.exit ?? null;
    if (exit !== null) {
      const column = columnById(board, task.flow.column);
      const found = isFlow(column) ? column.exits.find((one) => one.name === exit) : undefined;
      if (found === undefined) return { ok: false, code: "no_exit", message: `${this.columnTitle(task.flow.column)} has no exit ${JSON.stringify(exit)}` };
      to = found.to;
    }
    const column = to === null ? null : columnById(board, to);
    if (to === null || !isFlow(column)) return { ok: false, code: "no_column", message: "name a column that holds tasks" };
    if (this.engine.runBusy(task) && !(column.kind === "wait" && column.final)) {
      return { ok: false, code: "task_working", message: "its agent is at work: only a final column takes it now, or stop it first" };
    }
    const moved = this.engine.move(task, to, exit);
    void this.engine.kick(moved.id);
    return { ok: true, task: moved };
  }

  /** The session at work on the run, stopped so the task can be moved. */
  async stopRun(id: string): Promise<void> {
    const run = this.store.get(id)?.flow.run;
    const managed = run?.session == null ? undefined : this.registry.get(run.session);
    if (managed !== undefined) await managed.cancelTurn().catch(() => undefined);
  }

  /** Attaching moves a session off whatever task held it; a task in the intake moves on, and its conversation is sent nothing. */
  attach(task: TaskRecord, managed: ManagedSession): TaskRecord {
    const at = this.now();
    this.store.attach(task.id, managed.id, at);
    const links = { ...task.flow.links, [managed.id]: { column: null, executor: { agent: managed.agent, customAgent: managed.customAgent, machine: this.engine.machineKey } } };
    let flow = { ...task.flow, links };
    const to = this.firstWorkColumn();
    if (task.flow.column === this.engine.current.board.intake && to !== null) {
      // A conversation that already is the work: the task stands in the work column with no run, as one there before the board did.
      flow = { ...flow, column: to, entry: flow.entry + 1, enteredAt: at, visits: { ...flow.visits, [to]: (flow.visits[to] ?? 0) + 1 }, run: null, ask: null, wait: null };
    }
    const git = managed.workspace.git;
    if (flow.code === null && flow.workdir === null && git !== null && git.branch !== null) {
      flow = { ...flow, workdir: managed.workspace.root, code: { repo: git.repoRoot, branch: git.branch, base: git.baseCommit ?? "", head: null, holder: this.engine.machineKey } };
    }
    const next: TaskRecord = { ...task, flow, updatedAt: at };
    this.store.save(next);
    if (flow.column !== task.flow.column) this.engine.event(next, "moved", `a conversation was attached, so it moved to ${this.columnTitle(flow.column)}`);
    return this.store.get(task.id) ?? next;
  }

  /** False when that session is not on that task. */
  detach(taskId: string, sessionId: string): boolean {
    const held = this.store.attachments().find((one) => one.sessionId === sessionId);
    if (held === undefined || held.taskId !== taskId) return false;
    this.store.detach(sessionId);
    return true;
  }

  /** A person's edit, or the summary an agent wrote; a status from an older client moves the task to the column it stands for. */
  change(id: string, change: TaskChange, by: string | null = null): TaskRecord | null {
    let task = this.store.get(id);
    if (task === null) return null;
    if (by === null) task = this.engine.touched(task);
    if (change.status !== undefined) {
      const to = this.engine.columnForStatus(change.status);
      if (to !== task.flow.column) task = this.engine.move(task, to, null);
    }
    const at = this.now();
    const next: TaskRecord = { ...task, updatedAt: at };
    if (change.title !== undefined) next.title = change.title;
    if (change.brief !== undefined) next.brief = change.brief;
    if (change.agent !== undefined) next.agent = change.agent;
    if (change.customAgent !== undefined) next.customAgent = change.customAgent;
    if (change.assignee !== undefined) next.assignee = change.assignee;
    if (change.cwd !== undefined) next.cwd = change.cwd;
    if (change.labels !== undefined) next.flow = { ...next.flow, labels: change.labels };
    if (change.summary !== undefined) {
      next.summary = change.summary.length === 0 ? null : change.summary;
      next.summaryAt = next.summary === null ? null : at;
      next.summaryBy = next.summary === null ? null : by;
    }
    this.store.save({ ...next, status: this.store.get(id)?.status ?? next.status });
    void this.engine.kick(id);
    return this.store.get(id) ?? next;
  }

  /** Whether a status an older client sends would move a task its agent is at work on somewhere other than a final column. */
  statusRefused(task: TaskRecord, status: StoredTaskStatus): boolean {
    const to = this.engine.columnForStatus(status);
    if (to === task.flow.column || !this.engine.runBusy(task)) return false;
    const column = columnById(this.engine.current.board, to);
    return !(column !== null && column.kind === "wait" && column.final);
  }

  /** Put a task back as it was before a refused start: its record whole, and a line saying so. */
  restore(before: TaskRecord, why: string): void {
    this.store.save(before);
    this.engine.event(before, "note", why);
  }

  /** What went to another machine in the last month: where, and at which epoch. */
  tombstones(): { id: string; epoch: number; movedTo: string; at: number }[] {
    const since = this.now() - TOMBSTONE_KEEP_MS;
    return this.store
      .tombstones()
      .filter((stone) => stone.at >= since && this.store.get(stone.id) === null)
      .map((stone) => ({ id: stone.id, epoch: stone.epoch, movedTo: stone.movedTo, at: stone.at }));
  }

  /** A task on its way to another machine takes no edit here: the copy being sent would no longer be the task (Q2.269). */
  moving(id: string): boolean {
    return this.store.get(id)?.flow.handoff != null;
  }

  history(id: string): TaskEvent[] {
    return this.store.events(id);
  }

  comments(id: string): TaskComment[] {
    return this.store.comments(id);
  }

  async comment(id: string, text: string): Promise<TaskComment | null> {
    const task = this.store.get(id);
    return task === null ? null : this.engine.addComment(task, text);
  }

  /** The feed, each question read off its session: open with the request as the session holds it, or closed. */
  feed(id: string): (TaskComment & { state: "open" | "closed" | null; pending: unknown })[] {
    return this.store.comments(id).map((comment) => {
      if (comment.kind !== "question" || comment.request === null || comment.sessionId === null) return { ...comment, state: null, pending: null };
      const snapshot = this.registry.get(comment.sessionId)?.snapshot();
      const held =
        comment.request.kind === "permission"
          ? snapshot?.pendingPermissions.find((one) => one.permissionId === comment.request!.id)
          : snapshot?.pendingElicitations.find((one) => (one as { elicitationId?: string }).elicitationId === comment.request!.id);
      return { ...comment, state: held === undefined ? "closed" : "open", pending: held ?? null };
    });
  }

  remove(id: string): boolean {
    if (this.store.get(id) === null) return false;
    this.store.remove(id);
    return true;
  }

  /** Once, after restore: the prune removes sessions before anything here is open, and their attachments name nobody. */
  sweep(): number {
    let dropped = 0;
    const away = new Set(this.store.tombstones().map((stone) => stone.id));
    for (const attachment of this.store.attachments()) {
      const held = this.store.get(attachment.taskId) !== null || away.has(attachment.taskId);
      if (this.registry.get(attachment.sessionId) !== undefined && held) continue;
      this.store.detach(attachment.sessionId);
      dropped += 1;
    }
    return dropped;
  }

  /** Whether this caller is the dispatcher: an ordinary session, known only by its nickname. */
  isDispatch(callerId: string): boolean {
    return this.registry.get(callerId)?.nickname === DISPATCH_NICKNAME;
  }

  /** task_update: the caller's own task and no other. Its outcome is checked against the exits of the column the task is in. */
  update(callerId: string, args: Record<string, unknown>): TaskUpdateResult {
    const parsed = parseTaskUpdate(args);
    if (typeof parsed === "string") return { ok: false, message: parsed };
    const task = this.taskOf(callerId);
    if (task === null) return { ok: false, message: "this conversation is attached to no task, so there is nothing to update" };
    if (parsed.outcome !== null) {
      const column = columnById(this.engine.current.board, task.flow.column);
      const exits = isFlow(column) ? column.exits.map((exit) => exit.name) : [];
      if (!exits.includes(parsed.outcome)) {
        return {
          ok: false,
          message:
            exits.length === 0
              ? `the task's column, ${this.columnTitle(task.flow.column)}, has no exits to name; say status review when the work is done`
              : `outcome must be one of ${exits.join(", ")}: the exits of the task's column, ${this.columnTitle(task.flow.column)}`,
        };
      }
    }
    let written = task;
    if (parsed.summary !== null) {
      const at = this.now();
      const summary = parsed.summary.length === 0 ? null : parsed.summary;
      written = { ...written, summary, summaryAt: summary === null ? null : at, summaryBy: summary === null ? null : callerId, updatedAt: at };
      this.store.save(written);
    }
    written = this.engine.report(written, callerId, {
      summary: parsed.summary,
      outcome: parsed.outcome,
      review: parsed.status === null ? null : parsed.status === "review",
    });
    const recorded = parsed.status ?? (parsed.outcome !== null ? "review" : null);
    const status = this.registry.get(callerId)?.status;
    return { ok: true, task: this.snapshot(written), recorded, working: status === "running" || status === "starting" };
  }

  /** board_propose: the whole board as the agent wrote it, checked, as one card; nothing changes until its person applies it. */
  proposeBoard(callerId: string, args: Record<string, unknown>): { ok: true; revision: number } | { ok: false; message: string } {
    const session = this.registry.get(callerId);
    if (session === undefined) return { ok: false, message: "this session no longer exists" };
    const text = args["text"];
    const why = args["why"];
    if (typeof text !== "string" || text.trim().length === 0) return { ok: false, message: "text is the whole board, as YAML" };
    if (typeof why !== "string" || why.trim().length === 0 || why.length > MAX_BOARD_WHY_CHARS) {
      return { ok: false, message: `why says what it changes, in at most ${MAX_BOARD_WHY_CHARS} characters` };
    }
    const parsed = parseBoard(text);
    if (!parsed.ok) return { ok: false, message: `the board does not parse; nothing was shown:\n${parsed.errors.map(formatBoardError).join("\n")}` };
    const current = this.engine.current;
    if (boardHash(text) === current.hash) return { ok: false, message: "that is the board as it is now; there is nothing to apply" };
    const shown = session.proposeBoard({ id: `bp_${randomBytes(9).toString("base64url")}`, text, revision: current.revision, hash: current.hash, why: why.trim() });
    return shown ? { ok: true, revision: current.revision } : { ok: false, message: "this session is not running" };
  }

  /** propose_tasks: one card in the caller's own transcript; the task and its agent start on a press, never here (Q2.259). */
  async propose(callerId: string, args: Record<string, unknown>): Promise<ProposeResult> {
    const session = this.registry.get(callerId);
    if (session === undefined) return { ok: false, message: "this session no longer exists" };
    const parsed = parseProposals(args);
    if (typeof parsed === "string") return { ok: false, message: parsed };
    const listing = await this.listProjects(callerId);
    const board = this.engine.current.board;
    const proposals: TaskProposal[] = [];
    for (const one of parsed) {
      const target = resolveMachine(one, listing, this.peers?.machineId ?? null);
      if (typeof target === "string") return { ok: false, message: target };
      if (one.column !== null && !isFlow(columnById(board, one.column))) {
        const columns = board.columns.filter(isFlow).map((column) => column.id);
        return { ok: false, message: `the board has no column ${one.column} to put a task in; it has ${columns.join(", ")}` };
      }
      const role = one.role === null ? null : (board.roles.find((held) => held.name === one.role) ?? null);
      if (one.role !== null && role === null) {
        const roles = board.roles.map((held) => held.name);
        return { ok: false, message: roles.length === 0 ? `the board has no roles; leave role out` : `the board has no role ${one.role}; it has ${roles.join(", ")}` };
      }
      // A role's own agent where none is named: the machine it may be pinned to is the role's to keep.
      const agent = one.agent ?? role?.agent ?? null;
      if (agent !== null && !target.agents.includes(agent)) {
        const where = target.machine.isThis ? "this machine" : (target.machine.label ?? "that machine");
        return {
          ok: false,
          message:
            target.agents.length === 0
              ? `${where} has no agent ready to run a task`
              : `${where} offers ${target.agents.join(", ")}; ${agent} is not one of them`,
        };
      }
      proposals.push({
        id: `tp_${randomBytes(9).toString("base64url")}`,
        machineId: target.machine.id,
        machine: target.machine.label,
        project: one.project,
        agent,
        title: one.title,
        brief: one.brief,
        ...(one.column === null ? {} : { column: one.column }),
        ...(one.role === null ? {} : { role: one.role }),
      });
    }
    if (!session.proposeTasks(proposals)) return { ok: false, message: "this session is not running" };
    return { ok: true, proposals };
  }

  async listProjects(callerId: string): Promise<ProjectListing> {
    const machines: ProjectRows[] = [{ machine: THIS_MACHINE, ...(await this.localProjects()) }];
    const unreachable: ProjectListing["unreachable"] = [];
    for (const [link, answer] of await this.askLinks(callerId, "/peer/projects", remoteProjectsOf)) {
      if ("reason" in answer) unreachable.push({ machine: link.targetName, reason: answer.reason });
      else machines.push({ machine: machineOf(link), agents: answer.agents, projects: answer.projects });
    }
    return { machines, unreachable };
  }

  async listTasks(callerId: string): Promise<TaskListing> {
    const tasks = this.localRows().map((row) => ({ machine: THIS_MACHINE, ...row }));
    const unreachable: TaskListing["unreachable"] = [];
    for (const [link, answer] of await this.askLinks(callerId, "/peer/tasks", remoteTasksOf)) {
      if ("reason" in answer) unreachable.push({ machine: link.targetName, reason: answer.reason });
      else tasks.push(...answer.map((row) => ({ machine: machineOf(link), ...row })));
    }
    return { tasks, unreachable };
  }

  /** What a linked machine is shown of this one's board, and what list_tasks prints of it here. */
  localRows(): Omit<TaskRow, "machine">[] {
    return this.list().map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      agent: task.agent,
      assignee: task.assignee,
      project: task.cwd,
      summary: task.summary,
      sessions: task.sessions.map((session) => session.nickname),
    }));
  }

  /** What /peer/projects answers: the rows, and what the board needs to place a run here (Q2.269). */
  async peerProjects(): Promise<ProjectsAnswer> {
    const rows = await this.localProjects();
    const repos: string[] = [];
    for (const folder of rows.projects) {
      const identity = await this.engine.projectOf(folder);
      if (identity !== null && !repos.includes(identity)) repos.push(identity);
    }
    const state = this.engine.current;
    return { ...rows, classifiers: this.engine.classifierIds(), repos, board: 1, boardRevision: state.revision, boardHash: state.hash };
  }

  /** Folders work has run in or is waiting to, newest first, and the agents a launch here would find. */
  async localProjects(): Promise<{ agents: string[]; projects: string[] }> {
    const projects: string[] = [];
    const add = (folder: string): void => {
      if (projects.length < MAX_LISTED_PROJECTS && !projects.includes(folder)) projects.push(folder);
    };
    for (const session of [...this.registry.list()].sort((a, b) => b.createdAt - a.createdAt)) {
      add(session.workspace.git?.repoRoot ?? session.requestedCwd);
    }
    for (const task of [...this.store.list()].reverse()) add(task.cwd);
    const offered = this.registry.machineCatalogue;
    let agents: string[];
    try {
      agents = (await this.registry.sessionRuntime.availability()).filter((agent) => agent.available).map((agent) => agent.id);
    } catch {
      // A probe that failed says nothing about what would start, so everything enabled is named.
      agents = [...offered.harnessIds()];
    }
    return { agents: agents.filter((id) => offered.harnessState(id) === "enabled"), projects };
  }

  private attachedSessions(): Map<string, TaskSessionRef[]> {
    const byTask = new Map<string, TaskSessionRef[]>();
    for (const attachment of this.store.attachments()) {
      const managed = this.registry.get(attachment.sessionId);
      if (managed === undefined) continue;
      const refs = byTask.get(attachment.taskId) ?? [];
      refs.push({
        id: managed.id,
        agent: managed.agent,
        nickname: managed.nickname,
        status: managed.status,
        attachedAt: attachment.attachedAt,
      });
      byTask.set(attachment.taskId, refs);
    }
    return byTask;
  }

  private snapshotOf(task: TaskRecord, sessions: TaskSessionRef[]): TaskSnapshot {
    const { flow: _flow, ...record } = task;
    const view = this.engine.view(task);
    return {
      ...record,
      status: view.status,
      column: view.column,
      phase: view.phase,
      epoch: view.epoch,
      run: view.run,
      code: view.code,
      waitingSince: view.waitingSince,
      holder: view.holder,
      exits: view.exits,
      reason: view.reason,
      budget: view.budget,
      labels: view.labels,
      sessions,
    };
  }

  private async askLinks<T>(
    callerId: string,
    path: string,
    read: (body: unknown) => T | null,
  ): Promise<[PeerLink, Remote<T>][]> {
    const peers = this.peers;
    if (peers === null) return [];
    const links = peers.linksFor(callerId);
    const out: [PeerLink, Remote<T>][] = [];
    for (let i = 0; i < links.length; i += REMOTE_BOARD_CONCURRENCY) {
      const batch = links.slice(i, i + REMOTE_BOARD_CONCURRENCY);
      const answers = await Promise.all(batch.map((link) => this.askLink(peers, link, path, read)));
      batch.forEach((link, j) => out.push([link, answers[j]!]));
    }
    return out;
  }

  /** Cached briefly, as list_agents is: propose_tasks reads the listing list_projects just fetched. */
  private askLink<T>(peers: TaskPeers, link: PeerLink, path: string, read: (body: unknown) => T | null): Promise<Remote<T>> {
    const at = this.now();
    const key = `${link.id}\0${path}`;
    const cached = this.remote.get(key);
    if (cached !== undefined && at - cached.at < REMOTE_BOARD_TTL_MS) return cached.answer as Promise<Remote<T>>;
    const answer = peers.askLink(link, path, REMOTE_BOARD_TIMEOUT_MS).then((reply): Remote<T> => {
      if (!reply.ok) return { reason: reply.status === 503 ? "offline" : reply.code };
      // A route newer than that host answers a bare 404 (http-and-routes.md): its board is not there to read.
      if (reply.status === 404) return { reason: "its daemon is too old for tasks" };
      if (reply.status === 403) return { reason: "agent messaging is off or isolated there" };
      const rows = reply.status === 200 ? read(reply.body) : null;
      return rows ?? { reason: `answered ${reply.status}` };
    });
    this.remote.set(key, { at, answer });
    for (const [held, entry] of this.remote) if (at - entry.at >= REMOTE_BOARD_TTL_MS) this.remote.delete(held);
    return answer;
  }
}

const THIS_MACHINE: BoardMachine = { id: null, label: null, isThis: true };

function machineOf(link: PeerLink): BoardMachine {
  return { id: link.targetMachineId, label: link.targetName, isThis: false };
}

/** How a machine is printed and how the model names it back; this machine is named by leaving it out. */
export function machineAddress(machine: BoardMachine): string | null {
  return machine.id === null ? null : address(machine.label ?? "machine", machine.id);
}

/** The machine a proposal names and the agents it offers, or the refusal: one that did not answer could not take the task either. */
function resolveMachine(
  proposal: ProposedTask,
  listing: ProjectListing,
  ownId: string | null,
): { machine: BoardMachine; agents: string[] } | string {
  const own = listing.machines.find((row) => row.machine.isThis);
  const here = { machine: THIS_MACHINE, agents: own?.agents ?? [] };
  if (proposal.machine === null) return here;
  const asked = parseAddress(proposal.machine);
  if (asked.ref !== null && asked.ref === ownId) return here;
  const others = listing.machines.filter((row) => !row.machine.isThis);
  const byId = asked.ref === null ? undefined : others.find((row) => row.machine.id === asked.ref);
  if (byId !== undefined) return { machine: byId.machine, agents: byId.agents };
  const name = (asked.name ?? "").toLowerCase();
  if (asked.ref === null && (name === "this machine" || name === "this")) return here;
  const named = asked.ref === null ? others.filter((row) => (row.machine.label ?? "").toLowerCase() === name) : [];
  if (named.length === 1) return { machine: named[0]!.machine, agents: named[0]!.agents };
  const known = others.map((row) => machineAddress(row.machine)).filter((one): one is string => one !== null);
  const silent = listing.unreachable.map((one) => `${one.machine} (${one.reason})`);
  return (
    `no machine is called ${JSON.stringify(proposal.machine.slice(0, 64))}; ` +
    (known.length === 0 ? "only this machine can be reached now, so leave machine out" : `besides this one there are: ${known.join(", ")}`) +
    (silent.length === 0 ? "" : `; not answering: ${silent.join(", ")}`)
  );
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** What another machine says it offers, re-read: a row this build cannot hold is dropped, never trusted. */
function remoteProjectsOf(body: unknown): ProjectsAnswer | null {
  const answer = body as Record<string, unknown> | null;
  if (answer === null || typeof answer !== "object" || !Array.isArray(answer["agents"]) || !Array.isArray(answer["projects"])) return null;
  const names = (value: unknown, test: (one: string) => boolean, max: number): string[] =>
    Array.isArray(value) ? value.filter((one): one is string => typeof one === "string" && test(one)).slice(0, max) : [];
  const revision = answer["boardRevision"];
  const hash = answer["boardHash"];
  return {
    agents: names(answer["agents"], isAgentRef, MAX_REMOTE_AGENTS),
    projects: names(answer["projects"], isProjectPath, MAX_LISTED_PROJECTS),
    classifiers: names(answer["classifiers"], isAgentRef, MAX_REMOTE_AGENTS),
    repos: names(answer["repos"], (one) => one.length > 0 && one.length <= 512 && !/[\u0000-\u001f]/.test(one), MAX_LISTED_PROJECTS),
    board: answer["board"] === 1 ? 1 : null,
    boardRevision: typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : null,
    boardHash: typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null,
  };
}

function remoteTasksOf(body: unknown): Omit<TaskRow, "machine">[] | null {
  const rows = (body as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, MAX_REMOTE_TASKS).flatMap((raw) => {
    const row = raw as Record<string, unknown> | null;
    if (row === null || typeof row !== "object") return [];
    const { id, title, status, agent, assignee, project, summary, sessions } = row;
    if (!shortString(id, MAX_REMOTE_ID_CHARS) || !shortString(title, MAX_TASK_TITLE_CHARS)) return [];
    if (!shortString(status, MAX_REMOTE_STATUS_CHARS) || !REMOTE_STATUS.test(status)) return [];
    if (typeof agent !== "string" || !isAgentRef(agent) || typeof project !== "string" || !isProjectPath(project)) return [];
    return [
      {
        id,
        title,
        status,
        agent,
        // An older daemon says nothing, and a task in its backlog was nobody's.
        assignee: isTaskAssignee(assignee) ? assignee : "nobody",
        project,
        summary: shortString(summary, MAX_TASK_SUMMARY_CHARS) ? summary : null,
        sessions: Array.isArray(sessions)
          ? sessions.filter((one): one is string => shortString(one, MAX_REMOTE_ID_CHARS)).slice(0, 16)
          : [],
      },
    ];
  });
}
