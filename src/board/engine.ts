// The board in the daemon: every task's next step, taken here whether or not any app is open (Q2.264).
import { randomBytes } from "node:crypto";
import {
  applyStep,
  boardHash,
  choiceNamed,
  columnById,
  columnCode,
  columnForStatus,
  columnHolder,
  DEFAULT_BOARD,
  DEFAULT_BOARD_TEXT,
  executorName,
  humanActed,
  humanExits,
  EXIT_NAME,
  MAX_COLUMN_TITLE_CHARS,
  MAX_EXIT_LABEL_CHARS,
  MAX_EXIT_MEANS_CHARS,
  MAX_CHOICE_CHARS,
  MAX_EXITS,
  MAX_ROLE_INSTRUCTIONS_CHARS,
  SEES,
  CLASSIFIER_TIMEOUT_MS,
  judged,
  judgePrompt,
  JUDGE_TIMEOUT_MS,
  MAX_SEEN_DIFF_BYTES,
  MAX_WAKE_TEXT_CHARS,
  parseVerdict,
  readVerdict,
  legacyStatus,
  MAX_STEPS_PER_EVENT,
  moveTask,
  parseBoard,
  pendingRun,
  phase,
  runRole,
  step,
  wakeable,
  wakeStep,
  withReport,
  withVerdict,
  withWake,
  type Actor,
  type Board,
  type BoardError,
  type BoardTask,
  type Executor,
  type MachineOffer,
  type Exit,
  type Phase,
  type ResolvedRole,
  type SeenContext,
  type Sees,
  type Step,
  type VerdictAnswer,
  type TaskSessionLink,
  type World,
  type WorldSession,
} from "@reemoat/board";
import { SessionLimitError, type ManagedSession, type SessionRegistry, type WorktreePolicy } from "../registry.js";
import type { SessionEvent, SessionStatus } from "../events.js";
import type { UploadRow } from "../uploads.js";
import { probeExists } from "../stall.js";
import {
  MAX_COMMENT_CHARS,
  MAX_PENDING_TASK_FILES,
  type BoardConfigStore,
  type BoardRevision,
  type StoredTaskStatus,
  type TaskComment,
  type TaskEvent,
  type TaskEventKind,
  type TaskFile,
  type TaskFlow,
  type TaskRecord,
  type TaskStore,
} from "../tasks/store.js";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { branchFor, TaskCodeOps } from "./code.js";
import { flowDefaults, readHandoff, type HandoffPayload } from "./handoff.js";

/** How often a task that waits for a machine, a slot or a day to pass is looked at again. */
export const BOARD_TICK_MS = 30_000;
const OFFER_TTL_MS = 10_000;
/** What a stop puts in the feed of the agent's last message, and what a judge is shown of it. */
export const MAX_LAST_MESSAGE_CHARS = 4_000;
/** A person's comments a run's note carries at most. */
const MAX_NOTES = 20;
const LOG_READ_BYTES = 4 * 1024 * 1024;

export interface BoardState {
  board: Board;
  revision: number;
  hash: string;
  text: string;
}

export type PutBoardResult =
  | { ok: true; state: BoardState; changed: boolean }
  | { ok: false; kind: "conflict"; state: BoardState }
  | { ok: false; kind: "invalid"; errors: BoardError[] };

/** What one pass did that a waiting route needs: the session it started, or the launch's refusal as thrown. */
export interface Advanced {
  started: ManagedSession | null;
  refused: unknown;
}

/** What a reader is shown of where a task stands, beside the record. */
export interface TaskView {
  column: string;
  phase: Phase;
  epoch: number;
  status: StoredTaskStatus | "needs_you";
  run: { n: number; column: string; state: string; executor: string | null; session: string | null; startedAt: number | null } | null;
  code: { branch: string; head: string | null; holder: string } | null;
  /** Since when the task has been its person's: a question, a stop, or a column they hold. */
  waitingSince: number | null;
  /** Who holds it now: you, nobody, or the executor of its run. */
  holder: string;
  /** The exits a person may press now. */
  exits: { name: string; label: string; to: string }[];
  /** Why it needs you, or what it waits for. */
  reason: string | null;
  budget: number;
  labels: string[];
}

/** What this daemon calls itself where nothing names it, as an executor `claude@local`: the app's word for this computer. */
const HERE = "local";

/** Another machine a run may go to, as its daemon last answered: what it runs, which projects it has, its board. */
export interface FleetMachine {
  offer: MachineOffer;
  boardRevision: number | null;
  boardHash: string | null;
}

/** One request to another machine's daemon over its link. */
export type FleetSend = (machine: string, request: { method: "GET" | "POST"; path: string; body?: unknown }, timeoutMs?: number) => Promise<
  { ok: true; status: number; body: unknown } | { ok: false; status: number; code: string }
>;

/** Pieces a task's code crosses the relay in: well under one answer's 1 MiB once written as base64 inside JSON. */
export const CODE_PIECE_BYTES = 512 * 1024;
/** A move another machine has not taken in this long is its person's (Q2.269). */
export const HANDOFF_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const HANDOFF_FIRST_RETRY_MS = 30_000;
const HANDOFF_MAX_RETRY_MS = 10 * 60_000;
const HANDOFF_TIMEOUT_MS = 30_000;
const CODE_CACHE_MS = 10 * 60_000;
const MAX_MOVED_COMMENT_CHARS = 2_000;
const MAX_MOVED_EVENTS = 50;

/** Who a role's question goes to: a harness through one bare ask, or a plugin's classifier. */
export interface BoardJudges {
  ask(agent: string, prompt: string, choices: { model: string | null; effort: string | null }, signal: AbortSignal): Promise<string>;
  classifiers?(): readonly { id: string; name: string }[];
  classify?(classifier: string, input: { exits: { name: string; means: string | null; label: string }[]; context: SeenContext }, signal: AbortSignal): Promise<unknown>;
}

/** A task's files as uploads of a run's session, ready to send; absent, a task's files reach no agent (Q2.273). */
export interface TaskFilePort {
  intoSession(taskId: string, files: readonly TaskFile[], sessionId: string): Promise<UploadRow[]>;
}

export interface BoardEngineOptions {
  registry: SessionRegistry;
  store: TaskStore;
  configs: BoardConfigStore;
  machineId: string | null;
  /** What its owner calls this machine, read at every use: the app says it after the daemon starts (Q2.274). */
  machineName?: string | (() => string | null);
  customAgents?: () => readonly { id: string; name: string; harness: string }[];
  now?: () => number;
  onWarning?: (detail: string) => void;
  /** 0 runs no timer: the drivers kick by hand. */
  tickMs?: number;
  judges?: BoardJudges | null;
  /** The owner's other machines a run may go to; absent, every run stays here. */
  fleet?: (() => Promise<FleetMachine[]>) | null;
  send?: FleetSend | null;
  /** Where a run of a `code: none` column gets its empty folder; absent, such a run fails to start. */
  codelessRoot?: string | null;
  files?: TaskFilePort | null;
}

export class BoardEngine {
  private readonly registry: SessionRegistry;
  private readonly store: TaskStore;
  private readonly configs: BoardConfigStore;
  private readonly now: () => number;
  private readonly code: TaskCodeOps;
  private state: BoardState;
  private readonly chains = new Map<string, Promise<Advanced>>();
  private readonly again = new Set<string>();
  private readonly watched = new Map<string, () => void>();
  private offerCache: { at: number; offer: Promise<MachineOffer> } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unwatch: (() => void) | null = null;
  /** What the request that starts a task asked of its first conversation: a nickname, a worktree policy. Spent by one launch. */
  private readonly launchWith = new Map<string, { nickname: string | null; worktree: WorktreePolicy | undefined }>();
  /** The fleet as last read, for names and for a judge asked elsewhere. */
  private fleetCache: FleetMachine[] = [];
  /** Tasks whose code is being fetched now, so a pass does not start a second fetch. */
  private readonly syncing = new Set<string>();
  /** Bundles this machine made for another, kept while it fetches them piece by piece. */
  private readonly bundles = new Map<string, { at: number; file: string; size: number; head: string }>();
  /** A folder's project identity, read once per path. */
  private readonly identities = new Map<string, Promise<string | null>>();

  constructor(private readonly options: BoardEngineOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.configs = options.configs;
    this.now = options.now ?? Date.now;
    this.code = new TaskCodeOps(options.registry.sessionRuntime.git());
    this.state = this.load();
  }

  nextLaunch(taskId: string, options: { nickname: string | null; worktree: WorktreePolicy | undefined }): void {
    this.launchWith.set(taskId, options);
  }

  /** Watches every session, then looks at every task once; a judge asked before a restart is asked again. */
  start(): void {
    if (this.unwatch !== null) return;
    this.unwatch = this.registry.watchSessions((managed) => this.watch(managed));
    for (const managed of this.registry.list()) this.watch(managed);
    for (const record of this.store.list()) {
      if (record.flow.judging !== null || record.flow.moving !== null) this.save({ ...record, flow: { ...record.flow, judging: null, moving: null } });
    }
    const tick = this.options.tickMs ?? BOARD_TICK_MS;
    if (tick > 0) {
      this.timer = setInterval(() => this.kickWaiting(), tick);
      this.timer.unref();
    }
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    for (const off of this.watched.values()) off();
    this.watched.clear();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get machineKey(): string {
    return this.options.machineId ?? "";
  }

  /** What its owner calls this machine, or null before anybody has said. */
  ownName(): string | null {
    const named = this.options.machineName;
    return (typeof named === "function" ? named() : named) ?? null;
  }

  /** `claude@mac`: this machine by its name, another by the name its link gives it. */
  label(executor: Executor): string {
    const here = { key: this.machineKey, name: this.ownName() ?? HERE, online: true, agents: [], projects: null, running: 0 };
    return executorName(executor, [here, ...this.fleetCache.map((one) => one.offer)]);
  }

  get current(): BoardState {
    return this.state;
  }

  revisions(): BoardRevision[] {
    return this.configs.list();
  }

  private load(): BoardState {
    const row = this.configs.current();
    if (row === null) return { board: DEFAULT_BOARD, revision: 0, hash: boardHash(DEFAULT_BOARD_TEXT), text: DEFAULT_BOARD_TEXT };
    const parsed = parseBoard(row.text);
    if (parsed.ok) return { board: parsed.board, revision: row.revision, hash: row.hash, text: row.text };
    // A board a newer build wrote and this one cannot read: keep working on the default rather than stop (compatibility.md rule 2).
    this.warn(`board revision ${row.revision} does not parse here; running the default board`);
    return { board: DEFAULT_BOARD, revision: row.revision, hash: row.hash, text: row.text };
  }

  /** The same text again is no new revision; another revision than the one named is a conflict. */
  putBoard(text: string, ifRevision: number | null): PutBoardResult {
    if (ifRevision !== null && ifRevision !== this.state.revision) return { ok: false, kind: "conflict", state: this.state };
    const parsed = parseBoard(text);
    if (!parsed.ok) return { ok: false, kind: "invalid", errors: parsed.errors };
    const hash = boardHash(text);
    if (hash === this.state.hash) return { ok: true, state: this.state, changed: false };
    const revision = this.state.revision + 1;
    this.configs.save({ revision, hash, text, at: this.now() });
    this.state = { board: parsed.board, revision, hash, text };
    this.kickAll();
    return { ok: true, state: this.state, changed: true };
  }

  /** A revision another daemon holds, taken when it is the newer: higher, or the same with the smaller hash. */
  adopt(revision: BoardRevision): boolean {
    const newer = revision.revision > this.state.revision || (revision.revision === this.state.revision && revision.hash < this.state.hash);
    if (!newer || boardHash(revision.text) !== revision.hash) return false;
    const parsed = parseBoard(revision.text);
    if (!parsed.ok) return false;
    this.configs.save(revision);
    this.state = { board: parsed.board, revision: revision.revision, hash: revision.hash, text: revision.text };
    this.kickAll();
    return true;
  }

  // Reading.

  boardTask(record: TaskRecord): BoardTask {
    const flow = record.flow;
    const sessions: TaskSessionLink[] = this.store
      .attachments()
      .filter((one) => one.taskId === record.id)
      .map((one) => {
        const link = flow.links[one.sessionId];
        const managed = this.registry.get(one.sessionId);
        return {
          id: one.sessionId,
          column: link?.column ?? null,
          executor: link?.executor ?? { agent: managed?.agent ?? record.agent, customAgent: managed?.customAgent ?? null, machine: this.machineKey },
          attachedAt: one.attachedAt,
        };
      });
    // Sessions on other machines are known by its links alone: a run may continue one there.
    for (const [id, link] of Object.entries(flow.links)) {
      if (link.executor.machine !== this.machineKey && !sessions.some((one) => one.id === id)) {
        sessions.push({ id, column: link.column, executor: link.executor, attachedAt: link.at ?? 0 });
      }
    }
    return {
      id: record.id,
      title: record.title,
      brief: record.brief,
      summary: record.summary,
      column: flow.column,
      entry: flow.entry,
      enteredAt: flow.enteredAt,
      epoch: flow.epoch,
      budget: flow.budget ?? this.state.board.budget,
      own: record.assignee === "agent" ? { agent: record.agent, customAgent: record.customAgent } : null,
      labels: flow.labels,
      visits: flow.visits,
      project: flow.code?.repo ?? flow.project ?? record.cwd,
      code: flow.code,
      run: flow.run,
      runs: flow.runs,
      verdicts: flow.verdicts,
      ask: flow.ask,
      wait: flow.wait,
      judging: flow.judging,
      moving: flow.moving,
      woken: flow.woken ?? null,
      sessions,
      from: flow.from,
      last: flow.last,
      notes: flow.notes,
    };
  }

  /** What a session is, to the board: the phase reads running and starting as work, a step waits on more. */
  private sessionOf(managed: ManagedSession, forStep: boolean): WorldSession {
    const status = managed.status;
    const reason = managed.exit?.reason;
    const gone = managed.terminal && status !== "parked" && (reason === "stopped" || !managed.resumable || managed.resumeSettled);
    const shown = phaseSession(status);
    // A turn a restart cut is over: what the agent reported before it decides, never whether auto-resume comes back.
    const working = shown.working || (forStep && status === "stopping");
    const blocked = shown.blocked;
    const settled = !working && !blocked && (status === "idle" ? managed.parkable(this.now(), 0) : true);
    return { id: managed.id, blocked, working, lastTurnEnd: managed.turnsEnded, settled, gone };
  }

  phaseOf(record: TaskRecord): Phase {
    const task = this.boardTask(record);
    const seen = new Map<string, WorldSession>();
    for (const link of task.sessions) {
      const managed = this.registry.get(link.id);
      if (managed !== undefined) seen.set(link.id, this.sessionOf(managed, false));
    }
    return phase(task, seen);
  }

  view(record: TaskRecord): TaskView {
    const board = this.state.board;
    const task = this.boardTask(record);
    const taskPhase = this.phaseOf(record);
    const run = task.run !== null && task.run.n === task.entry ? task.run : null;
    const at = columnById(board, task.column);
    const exits = humanExits(task, board).map((exit) => ({ name: exit.name, label: exit.label, to: exit.to }));
    const executor = run?.executor ?? null;
    // Queued, its run is not placed yet: the agent it is for, with no machine.
    const queuedFor = at !== null && at.kind === "work" ? runRole(task, board, at) : null;
    const holder =
      at === null || at.kind !== "work"
        ? columnHolder(board, task.column)
        : executor !== null
          ? this.label(executor)
          : queuedFor === null
            ? "nobody"
            : this.queuedFor(queuedFor);
    return {
      column: task.column,
      phase: taskPhase,
      epoch: task.epoch,
      status: legacyStatus(taskPhase, task.column, board),
      run:
        run === null
          ? null
          : { n: run.n, column: run.column, state: run.state, executor: executor === null ? null : this.label(executor), session: run.session, startedAt: run.startedAt },
      code: task.code === null ? null : { branch: task.code.branch, head: task.code.head, holder: task.code.holder },
      waitingSince: this.waitingSince(record, task, taskPhase),
      holder,
      exits,
      reason: task.ask?.entry === task.entry ? task.ask.detail : task.wait?.entry === task.entry ? task.wait.detail : null,
      budget: task.budget,
      labels: [...task.labels],
    };
  }

  /** The agent a run is queued for, at the machine its role is pinned to: a card would otherwise draw it on the task's own. */
  private queuedFor(role: ResolvedRole): string {
    const agent = role.customAgent ?? role.agent;
    const pinned = role.on?.[0];
    if (pinned === undefined) return agent;
    const lower = pinned.toLowerCase();
    const known = [{ key: this.machineKey, name: this.ownName() ?? HERE }, ...this.fleetCache.map((one) => one.offer)].find(
      (one) => one.key === pinned || one.name.toLowerCase() === lower,
    );
    return `${agent}@${known?.name ?? pinned}`;
  }

  /** A question's own clock where a session waits, the stop's where the board asked, the entry's where the column is theirs. */
  private waitingSince(record: TaskRecord, task: BoardTask, taskPhase: Phase): number | null {
    if (taskPhase === "needs_you") {
      let earliest: number | null = null;
      for (const link of task.sessions) {
        const snapshot = this.registry.get(link.id)?.snapshot();
        for (const pending of [...(snapshot?.pendingPermissions ?? []), ...(snapshot?.pendingElicitations ?? [])]) {
          const raised = (pending as { raisedAt?: number }).raisedAt;
          if (typeof raised === "number" && (earliest === null || raised < earliest)) earliest = raised;
        }
      }
      return earliest ?? task.ask?.at ?? record.updatedAt;
    }
    if (taskPhase === "waiting" && columnHolder(this.state.board, task.column) === "you") return task.enteredAt;
    return null;
  }

  // Writing.

  private save(record: TaskRecord): void {
    this.store.save({ ...record, status: storedStatusOf(this.state.board, record.flow.column) });
  }

  private writeTask(record: TaskRecord, task: BoardTask): TaskRecord {
    const links: TaskFlow["links"] = { ...record.flow.links };
    for (const link of task.sessions) links[link.id] = { column: link.column, executor: link.executor, at: link.attachedAt };
    const flow: TaskFlow = {
      ...record.flow,
      column: task.column,
      entry: task.entry,
      enteredAt: task.enteredAt,
      epoch: task.epoch,
      budget: task.budget,
      labels: [...task.labels],
      visits: { ...task.visits },
      code: task.code,
      run: task.run,
      runs: task.runs,
      verdicts: [...task.verdicts],
      ask: task.ask,
      wait: task.wait,
      judging: task.judging,
      moving: task.moving,
      woken: task.woken ?? null,
      from: task.from,
      last: task.last,
      notes: [...task.notes],
      links,
    };
    const next = { ...record, flow, updatedAt: this.now() };
    this.save(next);
    return next;
  }

  event(record: TaskRecord, kind: TaskEventKind, text: string, extra: Partial<Omit<TaskEvent, "seq" | "at" | "kind" | "text">> = {}): void {
    this.store.addEvent(record.id, {
      at: this.now(),
      kind,
      entry: record.flow.entry,
      revision: this.state.revision,
      text,
      column: record.flow.column,
      to: null,
      exit: null,
      by: null,
      confidence: null,
      executor: null,
      session: null,
      ...extra,
    });
  }

  /** A fresh task's flow: in the column it was put in, with the board's whole budget. */
  initialFlow(column: string): TaskFlow {
    const at = this.now();
    const flow: TaskFlow = {
      column,
      entry: 1,
      enteredAt: at,
      epoch: 1,
      budget: this.state.board.budget,
      labels: [],
      visits: { [column]: 1 },
      code: null,
      workdir: null,
      run: null,
      runs: 0,
      verdicts: [],
      ask: null,
      wait: null,
      judging: null,
      moving: null,
      from: null,
      last: null,
      notes: [],
      links: {},
    };
    const target = columnById(this.state.board, column);
    if (target !== null && target.kind === "work") flow.run = pendingRun(1, column);
    return flow;
  }

  /** Where an older client's status puts a task on this board. */
  columnForStatus(status: StoredTaskStatus): string {
    return columnForStatus(this.state.board, status);
  }

  /** Whether the task's run is at work now: then only a final column takes it, or a person stops it first. */
  runBusy(record: TaskRecord): boolean {
    const run = record.flow.run;
    if (run === null || run.state !== "working" || run.n !== record.flow.entry || run.session === null) return false;
    const managed = this.registry.get(run.session);
    if (managed === undefined) return false;
    const status = managed.status;
    return status === "running" || status === "starting" || status === "blocked";
  }

  /** A person's move: the budget comes back whole. A move into a work column makes a run, which a kick then starts. */
  move(record: TaskRecord, to: string, exit: string | null, by: Actor = { kind: "human" }): TaskRecord {
    const task = this.boardTask(record);
    const moved = moveTask(task, this.state.board, to, exit, by, this.now());
    const written = this.writeTask(record, by.kind === "human" ? humanActed(moved, this.state.board) : moved);
    this.event(written, "moved", movedWords(this.state.board, record.flow.column, to, exit, by), {
      column: record.flow.column,
      to,
      exit,
      by: actorName(by),
      confidence: by.kind === "role" ? by.confidence : null,
    });
    return written;
  }

  /** A person did something on the task: the budget is whole again, and a stop waiting on them is answered. */
  touched(record: TaskRecord): TaskRecord {
    return this.writeTask(record, humanActed(this.boardTask(record), this.state.board));
  }

  kickAll(): void {
    for (const record of this.store.list()) void this.kick(record.id);
  }

  private kickWaiting(): void {
    for (const record of this.store.list()) {
      const run = record.flow.run;
      if (record.flow.wait !== null || record.flow.handoff != null || run?.state === "pending" || run?.state === "working") void this.kick(record.id);
    }
  }

  /** One pass at a time per task; a kick during a pass takes one more after it. */
  kick(id: string): Promise<Advanced> {
    const running = this.chains.get(id);
    if (running !== undefined) {
      this.again.add(id);
      return running;
    }
    const pass = (async (): Promise<Advanced> => {
      let result: Advanced = { started: null, refused: null };
      do {
        this.again.delete(id);
        const one = await this.advance(id).catch((error: unknown) => {
          this.warn(`board: task ${id}: ${error instanceof Error ? error.message : String(error)}`);
          return { started: null, refused: null };
        });
        if (one.started !== null || one.refused !== null) result = one;
      } while (this.again.has(id));
      return result;
    })().finally(() => this.chains.delete(id));
    this.chains.set(id, pass);
    return pass;
  }

  private offer(): Promise<MachineOffer> {
    const at = this.now();
    if (this.offerCache !== null && at - this.offerCache.at < OFFER_TTL_MS) return this.offerCache.offer;
    const offer = (async (): Promise<MachineOffer> => {
      const catalogue = this.registry.machineCatalogue;
      let ids: string[];
      try {
        ids = (await this.registry.sessionRuntime.availability()).filter((agent) => agent.available).map((agent) => agent.id);
      } catch {
        // A probe that failed says nothing about what would start, so everything enabled is offered.
        ids = [...catalogue.harnessIds()];
      }
      const harnesses = ids.filter((id) => catalogue.harnessState(id) === "enabled");
      const custom = (this.options.customAgents?.() ?? []).filter((one) => harnesses.includes(one.harness));
      return {
        key: this.machineKey,
        name: this.ownName() ?? HERE,
        online: true,
        agents: [
          ...harnesses.map((id) => ({ id, name: id, kind: "harness" as const, harness: null })),
          ...custom.map((one) => ({ id: one.id, name: one.name, kind: "custom" as const, harness: one.harness })),
          ...(this.options.judges?.classifiers?.() ?? []).map((one) => ({ id: one.id, name: one.name, kind: "classifier" as const, harness: null })),
        ],
        projects: null,
        running: 0,
      };
    })();
    this.offerCache = { at, offer };
    return offer;
  }

  private world(task: BoardTask, offer: MachineOffer, fleet: readonly FleetMachine[], localHead: string | null): World {
    const sessions = new Map<string, WorldSession>();
    for (const link of task.sessions) {
      const managed = this.registry.get(link.id);
      if (managed !== undefined) sessions.set(link.id, this.sessionOf(managed, true));
      // Another machine's session is taken to be there until its daemon says otherwise: its own pass decides.
      else if (link.executor.machine !== this.machineKey) sessions.set(link.id, { id: link.id, blocked: false, working: false, lastTurnEnd: 0, settled: true, gone: false });
    }
    const all = this.store.list();
    return {
      now: this.now(),
      self: this.machineKey,
      sessions,
      machines: [offer, ...fleet.map((one) => one.offer)],
      busy: (column, _machine, taskId) =>
        all.filter((one) => {
          const run = one.flow.run;
          if (one.id === taskId || run === null || run.column !== column || run.state !== "working" || run.session === null) return false;
          // A run stopped for its person still holds its slot: its conversation is the column's until it ends.
          const managed = this.registry.get(run.session);
          return managed !== undefined && !this.sessionOf(managed, true).gone;
        }).length,
      ahead: (one, column) =>
        all.filter(
          (other) =>
            other.id !== one.id &&
            other.flow.column === column &&
            other.flow.run?.state === "pending" &&
            other.flow.wait?.reason === "limit" &&
            (other.flow.enteredAt < one.enteredAt || (other.flow.enteredAt === one.enteredAt && other.id < one.id)),
        ).length,
      hasCode: (one) => one.code === null || one.code.holder === this.machineKey || (one.code.head !== null && localHead === one.code.head),
    };
  }

  private async advance(id: string): Promise<Advanced> {
    const out: Advanced = { started: null, refused: null };
    const fleet = await this.fleetNow();
    for (let i = 0; i < MAX_STEPS_PER_EVENT; i += 1) {
      const record = this.store.get(id);
      if (record === null) return out;
      // A move under way is its own to finish, and a fetch of the code too: the board steps again once either is over.
      if (record.flow.handoff != null) {
        if (record.flow.handoff.nextAt <= this.now()) await this.sendHandoff(id);
        return out;
      }
      if (this.syncing.has(id)) return out;
      const offer = await this.offer();
      if (record.flow.project === undefined) await this.readProject(record);
      const fresh = this.store.get(id);
      if (fresh === null) return out;
      const task = this.boardTask(fresh);
      const localHead = await this.localHead(fresh);
      const next = step(task, this.state.board, this.world(task, offer, fleet, localHead));
      if (next.kind === "nothing") return out;
      if (!(await this.apply(fresh, task, next, out))) return out;
    }
    return out;
  }

  private async fleetNow(): Promise<FleetMachine[]> {
    if (this.options.fleet == null) return [];
    try {
      this.fleetCache = await this.options.fleet();
    } catch {
      // A fleet nobody could read is no fleet: every run stays here this pass.
      this.fleetCache = [];
    }
    return this.fleetCache;
  }

  /** The folder's identity, once: an origin another machine's checkout can be matched by, or null where there is none. */
  private async readProject(record: TaskRecord): Promise<void> {
    const identity = await this.identityOf(record.cwd);
    const latest = this.store.get(record.id);
    if (latest !== null) this.save({ ...latest, flow: { ...latest.flow, project: identity } });
  }

  private identityOf(dir: string): Promise<string | null> {
    let held = this.identities.get(dir);
    if (held === undefined) {
      held = this.code.identity(dir);
      this.identities.set(dir, held);
    }
    return held;
  }

  /** A folder's project identity, read once; null where it has no origin. */
  projectOf(dir: string): Promise<string | null> {
    return this.identityOf(dir);
  }

  /** The classifiers this machine's plugins add, by the id a board names. */
  classifierIds(): string[] {
    return (this.options.judges?.classifiers?.() ?? []).map((one) => one.id);
  }

  /** This machine's checkout of a project, found among the folders its sessions and tasks have used. */
  async checkoutFor(identity: string): Promise<string | null> {
    const folders = new Set<string>();
    for (const session of this.registry.list()) folders.add(session.workspace.git?.repoRoot ?? session.requestedCwd);
    for (const task of this.store.list()) folders.add(task.cwd);
    for (const folder of folders) if ((await this.identityOf(folder)) === identity) return folder;
    return null;
  }

  /** The head of the task's branch as this machine holds it: its worktree's, else its checkout's branch. */
  private async localHead(record: TaskRecord): Promise<string | null> {
    const code = record.flow.code;
    if (code === null || code.holder === this.machineKey) return null;
    if (record.flow.workdir !== null) return this.code.head(record.flow.workdir);
    const checkout = await this.checkoutFor(code.repo);
    return checkout === null ? null : this.code.branchHead(checkout, code.branch);
  }

  /** True where the next step should be taken now. */
  private async apply(record: TaskRecord, task: BoardTask, next: Step, out: Advanced): Promise<boolean> {
    const board = this.state.board;
    const now = this.now();
    switch (next.kind) {
      case "nothing":
        return false;
      case "wait": {
        const before = record.flow.wait;
        const written = this.writeTask(record, applyStep(task, board, next, now));
        if (before === null || before.reason !== next.reason || before.entry !== task.entry) this.event(written, "waiting", next.detail);
        return false;
      }
      case "ask": {
        const before = record.flow.ask;
        const written = this.writeTask(record, applyStep(task, board, next, now));
        if (before !== null && before.reason === next.reason && before.entry === task.entry && next.reason !== "no_report") return false;
        if (next.reason === "no_report") {
          const said = this.lastMessage(task);
          this.comment(written, { kind: "stop", author: task.run?.session ?? "agent", text: said ?? "(the agent said nothing)", sessionId: task.run?.session ?? null });
          this.event(written, "stopped", "the agent ended its turn without a report", { session: task.run?.session ?? null });
        } else if (next.reason === "run_failed") {
          this.event(written, "failed", next.detail, { session: task.run?.session ?? null });
        } else {
          this.event(written, "asked", next.detail);
        }
        return false;
      }
      case "end": {
        const run = task.run!;
        let ended = task;
        const workdir = record.flow.workdir;
        if (workdir !== null && task.code !== null && run.executor !== null && columnCode(board, run.column) === "task") {
          const committed = await this.code.controlCommit(workdir, `board: ${run.column} #${run.n} ${this.label(run.executor)}`);
          const diff = run.startHead !== null && committed.head !== null ? await this.code.diffStat(workdir, run.startHead, committed.head) : null;
          ended = { ...task, run: { ...run, diff }, code: { ...task.code, head: committed.head, holder: this.machineKey } };
          if (committed.refused !== null) this.event(record, "note", `the control commit was refused: ${committed.refused}`);
        }
        const over = applyStep(ended, board, next, now);
        const written = this.writeTask(record, over.last === null ? over : { ...over, last: { ...over.last, message: this.lastMessage(task) } });
        this.event(written, "ended", run.report === null ? "the run ended" : `the run ended: ${oneLine(run.report)}`, {
          column: run.column,
          session: run.session,
          executor: run.executor === null ? null : this.label(run.executor),
        });
        return true;
      }
      case "move": {
        this.move(record, next.to, next.exit, next.by);
        // A wake's move into a work column takes its comment to the run there; one into a waiting column leaves it a note.
        if (task.woken != null && next.by.kind !== "config" && columnById(board, next.to)?.kind === "work") this.markDelivered(record.id, task.woken.comment);
        return true;
      }
      case "stay": {
        const written = this.writeTask(record, applyStep(task, board, next, now));
        const where = columnById(board, task.column)?.title ?? task.column;
        const why =
          next.by.kind === "config" ? `${where} has nowhere to send it` : next.by.kind === "human" ? "no judge sent it anywhere" : `${actorName(next.by)} kept it in ${where}`;
        this.event(written, "note", `${why}; the comment waits for the next run`, { by: actorName(next.by) });
        return false;
      }
      case "start": {
        let launched: { managed: ManagedSession; started: { session: string; startSeq: number; logFrom: number; startHead: string | null } };
        try {
          launched = await this.launch(record, next);
        } catch (error) {
          out.refused = error;
          const latest = this.store.get(record.id) ?? record;
          const again = this.boardTask(latest);
          if (error instanceof SessionLimitError) {
            this.writeTask(latest, applyStep(again, board, { kind: "wait", reason: "limit", detail: error.message }, now));
          } else {
            const detail = `the run could not start: ${error instanceof Error ? error.message : String(error)}`;
            this.writeTask(latest, applyStep(again, board, { kind: "ask", reason: "run_failed", detail }, now));
            this.event(latest, "failed", detail);
          }
          return false;
        }
        out.started = launched.managed;
        const stored = this.store.get(record.id) ?? record;
        // A task nobody was named on is the agent's that ran it from now on, so the intake does not draw it as nobody's again.
        const latest: TaskRecord =
          stored.assignee === "nobody" ? { ...stored, assignee: "agent", agent: next.executor.agent, customAgent: next.executor.customAgent } : stored;
        const written = this.writeTask(latest, applyStep(this.boardTask(latest), board, next, now, launched.started));
        this.event(
          written,
          "started",
          `${board.columns.find((one) => one.id === written.flow.column)?.title ?? written.flow.column} → ${this.label(next.executor)}: ${next.reason}` +
            (next.fresh === null ? "" : `; a new conversation, because ${next.fresh}`),
          { executor: this.label(next.executor), session: launched.managed.id },
        );
        return true;
      }
      case "judge": {
        const written = this.writeTask(record, applyStep(task, board, next, now));
        void this.judge(written.id, task.entry, next);
        return false;
      }
      case "handoff": {
        // Code a folder holds that is no repository cannot cross: its run stays where the code is (Q2.269).
        if (task.code === null && task.runs > 0) {
          const ask = { kind: "ask" as const, reason: "code_not_portable" as const, detail: "this project is no git repository, so its work stays on the machine that has it" };
          this.writeTask(record, applyStep(task, board, ask, now));
          this.event(record, "asked", ask.detail);
          return false;
        }
        if (this.options.send == null) {
          this.writeTask(record, applyStep(task, board, { kind: "wait", reason: "no_executor", detail: "waiting for another machine" }, now));
          return false;
        }
        const name = this.fleetName(next.to);
        let leaving = record;
        if (columnCode(board, task.column) === "task") {
          const ready = await this.codeLeaves(record, name);
          if (typeof ready === "string") {
            const written = this.writeTask(record, applyStep(task, board, { kind: "ask", reason: "code_dirty", detail: ready }, now));
            this.event(written, "asked", ready);
            return false;
          }
          leaving = ready;
        }
        const written = this.writeTask(leaving, applyStep(this.boardTask(leaving), board, next, now));
        this.save({ ...written, flow: { ...written.flow, handoff: { to: next.to, name, since: now, tries: 0, nextAt: now, epoch: written.flow.epoch + 1 } } });
        this.event(written, "moved", `the run goes to ${this.label(next.executor)}: ${next.reason}`, { executor: this.label(next.executor) });
        await this.sendHandoff(record.id);
        return false;
      }
      case "sync": {
        this.writeTask(record, applyStep(task, board, next, now));
        void this.syncCode(record.id);
        return false;
      }
    }
  }

  /** A new conversation, or the one it continues; the run's message goes in as its person's, the note after it. */
  private async launch(record: TaskRecord, next: Step & { kind: "start" }): Promise<{ managed: ManagedSession; started: { session: string; startSeq: number; logFrom: number; startHead: string | null } }> {
    let managed: ManagedSession;
    let workdir = record.flow.workdir;
    const codeless = columnCode(this.state.board, record.flow.column) === "none";
    const continued = next.session === null ? undefined : this.registry.get(next.session);
    const continues = continued !== undefined;
    if (continued !== undefined) {
      managed = continued;
    } else if (codeless) {
      const asked = this.launchWith.get(record.id);
      this.launchWith.delete(record.id);
      managed = await this.registry.create({
        agent: next.executor.agent,
        customAgent: next.executor.customAgent,
        cwd: await this.codelessFolder(record.id),
        worktree: "never",
        nickname: asked?.nickname ?? null,
        origin: "board",
      });
      if (managed.title === null) this.registry.setMeta(managed, { title: record.title });
    } else {
      const first = workdir === null && record.flow.runs === 0 && record.flow.code === null;
      // Code that came from another machine is checked out here once, on its own branch, in this machine's copy of the project.
      const arrived = workdir === null && record.flow.code !== null ? await this.checkoutFor(record.flow.code.repo) : null;
      const asked = this.launchWith.get(record.id);
      this.launchWith.delete(record.id);
      // A task made on one machine names that machine's folder: said in words where this one has none, not as a failed realpath.
      if (workdir === null && arrived === null && (await probeExists(record.cwd)) === false) throw new Error(`its folder ${record.cwd} is not on this machine`);
      managed = await this.registry.create({
        agent: next.executor.agent,
        customAgent: next.executor.customAgent,
        cwd: workdir ?? arrived ?? record.cwd,
        // One working copy per task on a machine: the first run makes it on the task's branch, every later run works in it.
        worktree: first ? asked?.worktree : arrived !== null ? "require" : "never",
        branch: first ? branchFor(this.registry.workspacePolicy.branchPrefix, record.id) : null,
        from: arrived !== null ? record.flow.code!.branch : null,
        nickname: asked?.nickname ?? null,
        origin: "board",
      });
      if (arrived !== null && managed.workspace.mode === "worktree") {
        workdir = managed.workspace.root;
        const latest = this.store.get(record.id) ?? record;
        this.save({ ...latest, flow: { ...latest.flow, workdir } });
      }
      if (managed.title === null) this.registry.setMeta(managed, { title: record.title });
      const git = managed.workspace.git;
      if (first && git?.createdBranch === true && git.branch !== null) {
        workdir = managed.workspace.root;
        const identity = (await this.code.identity(workdir)) ?? git.repoRoot;
        const latest = this.store.get(record.id) ?? record;
        this.save({
          ...latest,
          flow: {
            ...latest.flow,
            workdir,
            code: { repo: identity, branch: git.branch, base: git.baseCommit ?? "", head: git.baseCommit ?? null, holder: this.machineKey },
          },
        });
      }
    }
    // In this order: a model can change which efforts there are.
    if (next.model !== null) await this.pickModel(record, managed, next.model);
    if (next.effort !== null) await this.pickEffort(record, managed, next.effort);
    if (next.mode !== null) await this.pickMode(record, managed, next.mode);
    const startSeq = managed.turnsEnded;
    const logFrom = managed.log.stats().lastSeq;
    const startHead = codeless || workdir === null ? null : await this.code.head(workdir);
    const ready = await this.registry.readyForMessage(managed, "person");
    if (ready !== "ready") throw new Error(ready === "workspace_missing" ? "its folder is gone" : "its folder is not answering");
    const note = { text: next.note, mentions: [] };
    // A new conversation knows nothing of the task's files; one that worked on it had them with its first message.
    const pending = record.flow.pendingFiles ?? [];
    const attached = await this.filesFor(record, [...(continues ? [] : (record.flow.files ?? [])), ...pending], managed);
    const first = managed.prompt(next.message, attached, null, note);
    const sent = first.kind === "turn_in_flight" ? await managed.sendMidTurn(next.message, attached, null, note) : first;
    if (sent.kind !== "accepted" && sent.kind !== "steered" && sent.kind !== "queued") throw new Error(`the agent did not take the run's message (${sent.kind})`);
    if (pending.length > 0) {
      // Only those sent: a comment that came while this run started waits for the next.
      const sentIds = new Set(pending.map((file) => file.id));
      const latest = this.store.get(record.id) ?? record;
      this.save({ ...latest, flow: { ...latest.flow, pendingFiles: (latest.flow.pendingFiles ?? []).filter((file) => !sentIds.has(file.id)) } });
    }
    this.store.attach(record.id, managed.id, this.now());
    return { managed, started: { session: managed.id, startSeq, logFrom, startHead } };
  }

  /** This machine and every one a run may go to, as a placement would see them now: the names a board's `on` may say. */
  async machines(): Promise<MachineOffer[]> {
    const fleet = await this.fleetNow();
    return [await this.offer(), ...fleet.map((one) => one.offer)];
  }

  /** The files this machine holds, put into the session's own to send; one it cannot is a history note, and the message goes without it. */
  private async filesFor(record: TaskRecord, files: readonly TaskFile[], managed: ManagedSession): Promise<UploadRow[]> {
    if (files.length === 0) return [];
    const rows = (await this.options.files?.intoSession(record.id, files, managed.id)) ?? [];
    if (rows.length < files.length) {
      const missed = files.length - rows.length;
      this.event(record, "note", `${missed === 1 ? "a file" : `${missed} files`} of this task could not be sent: ${missed === 1 ? "it is" : "they are"} not on this machine, or the conversation has no room`);
    }
    return rows;
  }

  /** The role's model as the agent's own config option; a name it does not offer is its to refuse, and the run goes on. */
  private async pickModel(record: TaskRecord, managed: ManagedSession, model: string): Promise<void> {
    const options = (managed.snapshot().agentConfig?.options ?? []) as { id: string; category?: string | null; choices?: { value: string; name?: string }[] }[];
    const option = options.find((one) => one.category === "model");
    if (option === undefined) {
      this.event(record, "note", `${managed.agent} offers no model to pick, so ${model} was not set`);
      return;
    }
    const lower = model.toLowerCase();
    const choice =
      option.choices?.find((one) => one.value === model) ??
      option.choices?.find((one) => one.value.toLowerCase().includes(lower) || (one.name ?? "").toLowerCase().includes(lower));
    try {
      const result = await managed.setConfigOption(option.id, choice?.value ?? model);
      if (result.kind !== "ok") this.event(record, "note", `${managed.agent} did not take the model ${model} (${result.kind})`);
    } catch (error) {
      this.event(record, "note", `${managed.agent} did not take the model ${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The role's effort as the agent's own choice, on every run: the person may have changed it in the conversation since. */
  private async pickEffort(record: TaskRecord, managed: ManagedSession, effort: string): Promise<void> {
    const option = managed.snapshot().agentConfig.options.find((one) => one.category === "thought_level" && one.kind === "select");
    const value = option === undefined ? null : choiceNamed(option.choices, effort);
    if (option === undefined || value === null) {
      this.event(record, "note", `${managed.agent} offers no effort called ${effort}, so it was not set`);
      return;
    }
    if (option.value === value) return;
    await this.picked(record, managed, `the effort ${effort}`, () => managed.setConfigOption(option.id, value));
  }

  /** The role's mode, from the agent's modes or its mode control, whichever it publishes. */
  private async pickMode(record: TaskRecord, managed: ManagedSession, mode: string): Promise<void> {
    const config = managed.snapshot().agentConfig;
    const option = config.options.find((one) => one.category === "mode" && one.kind === "select");
    const choices = [...(config.modes?.available.map((one) => ({ value: one.id, name: one.name })) ?? []), ...(option?.choices ?? [])];
    const value = choiceNamed(choices, mode);
    if (value === null) {
      this.event(record, "note", `${managed.agent} offers no mode called ${mode}, so it was not set`);
      return;
    }
    if ((config.modes?.current ?? option?.value) === value) return;
    await this.picked(record, managed, `the mode ${mode}`, () => managed.setMode(value));
  }

  private async picked(record: TaskRecord, managed: ManagedSession, what: string, set: () => Promise<{ kind: string }>): Promise<void> {
    try {
      const result = await set();
      if (result.kind !== "ok") this.event(record, "note", `${managed.agent} did not take ${what} (${result.kind})`);
    } catch (error) {
      this.event(record, "note", `${managed.agent} did not take ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The agent's last message in its run, read from the session's own log: what a stop shows its person. */
  lastMessage(task: BoardTask): string | null {
    const run = task.run;
    if (run === null || run.session === null) return null;
    const managed = this.registry.get(run.session);
    if (managed === undefined) return null;
    const events = managed.log.read(run.logFrom + 1, 10_000, LOG_READ_BYTES).map((stored) => stored.event);
    return lastAgentMessage(events);
  }

  /** A role asked where the task goes: its answer is kept for the entry it was asked about, and a late one moves nothing. */
  private async judge(id: string, entry: number, next: Step & { kind: "judge" }): Promise<void> {
    const record = this.store.get(id);
    if (record === null) return;
    const task = this.boardTask(record);
    const column = columnById(this.state.board, task.column);
    if (column === null || column.kind === "view") return;
    const role = next.role;
    const exits = next.exits;
    // A wake's judge is asked about its comment, which leads what it reads (Q2.279).
    const comment = next.wake !== undefined && task.woken?.comment === next.wake ? task.woken.text : null;
    let answer: VerdictAnswer | null = null;
    let why: string | null = null;
    try {
      const offer = await this.offer();
      const context: SeenContext = { ...(comment === null ? {} : { comment }), ...(await this.seen(record, task, column.sees)) };
      const lower = role.agent.toLowerCase();
      const classifier = offer.agents.find((one) => one.kind === "classifier" && (one.id === role.agent || one.name.toLowerCase() === lower));
      const runnable = offer.agents.find((one) => one.kind !== "classifier" && (one.id === role.agent || (one.kind === "custom" && one.name.toLowerCase() === lower)));
      const judges = this.options.judges ?? null;
      if (classifier !== undefined && judges?.classify !== undefined) {
        const value = await bounded(CLASSIFIER_TIMEOUT_MS, (signal) =>
          judges.classify!(classifier.id, { exits: exits.map((exit) => ({ name: exit.name, means: exit.means, label: exit.label })), context }, signal),
        );
        answer = readVerdict(value, exits);
      } else if (runnable !== undefined && judges !== null) {
        const harness = runnable.kind === "custom" ? (runnable.harness ?? runnable.id) : runnable.id;
        const prompt = judgePrompt(task.title, column.title, exits, column.sees, context, role.instructions, comment);
        const text = await bounded(JUDGE_TIMEOUT_MS, (signal) => judges.ask(harness, prompt, { model: role.model, effort: role.effort }, signal));
        answer = parseVerdict(text, exits);
      } else {
        // Asked where the role's agent is: the context is gathered here, where the run ended, and the question goes with it.
        const there = this.fleetCache.find(
          (one) =>
            (role.on === null || role.on.some((name) => name.toLowerCase() === one.offer.name.toLowerCase() || name === one.offer.key)) &&
            one.offer.agents.some((agent) => agent.id === role.agent || agent.name.toLowerCase() === lower),
        );
        if (there !== undefined && this.options.send != null) {
          const reply = await this.options.send(there.offer.key, {
            method: "POST",
            path: "/peer/judge",
            body: {
              agent: role.agent,
              model: role.model,
              effort: role.effort,
              instructions: role.instructions,
              title: task.title,
              column: column.title,
              exits,
              sees: column.sees,
              context,
              ...(comment === null ? {} : { comment }),
            },
          }, JUDGE_TIMEOUT_MS + 5_000);
          answer = reply.ok && reply.status === 200 ? readVerdict(pickVerdict(reply.body), exits) : null;
          if (answer === null) why = `${there.offer.name} gave no answer it could read`;
        } else {
          why = runnable === undefined && classifier === undefined ? `nothing here runs ${role.agent}` : "this daemon asks no role";
        }
      }
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
    const verdict = why !== null ? { exit: null, confidence: null, abstained: why } : judged(answer, role.minConfidence);
    const latest = this.store.get(id);
    if (latest === null) return;
    if (latest.flow.entry !== entry || (next.wake !== undefined && latest.flow.woken?.comment !== next.wake)) {
      this.event(latest, "verdict", `${role.name} answered after the task moved on, which moves nothing`, { by: role.name, confidence: verdict.confidence });
      return;
    }
    const wake = next.wake === undefined ? {} : { wake: next.wake };
    const written = this.writeTask(latest, withVerdict(this.boardTask(latest), { entry, judge: role.name, exit: verdict.exit, confidence: verdict.confidence, at: this.now(), ...wake }));
    const percent = verdict.confidence === null ? "" : ` · ${Math.round(verdict.confidence * 100)}%`;
    this.event(
      written,
      "verdict",
      verdict.abstained !== null ? `${role.name} did not decide: ${verdict.abstained}` : `${role.name}: ${verdict.exit}${percent}`,
      { by: role.name, exit: verdict.exit, confidence: verdict.confidence },
    );
    void this.kick(id);
  }

  /** A role asked here by another machine's board: its context came with it, and only the answer goes back (Q2.269). */
  async judgeHere(raw: unknown): Promise<VerdictAnswer | string> {
    const body = raw as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") return "a question is an object";
    const agent = body["agent"];
    const exits = body["exits"];
    if (typeof agent !== "string" || agent.length === 0 || agent.length > 65) return "agent names who is asked";
    if (!Array.isArray(exits) || exits.length === 0 || exits.length > MAX_EXITS) return "exits are the column's exits";
    const named: Exit[] = [];
    for (const one of exits) {
      const exit = one as Record<string, unknown> | null;
      if (exit === null || typeof exit["name"] !== "string" || !EXIT_NAME.test(exit["name"])) return "every exit has a name";
      const means = typeof exit["means"] === "string" ? exit["means"].slice(0, MAX_EXIT_MEANS_CHARS) : null;
      const label = typeof exit["label"] === "string" ? exit["label"].slice(0, MAX_EXIT_LABEL_CHARS) : exit["name"];
      named.push({ name: exit["name"], to: "", means, label });
    }
    const sees = (Array.isArray(body["sees"]) ? body["sees"] : []).filter((one): one is Sees => (SEES as readonly unknown[]).includes(one));
    const raw_ = (body["context"] ?? {}) as Record<string, unknown>;
    const context: SeenContext = {};
    for (const one of sees) if (typeof raw_[one] === "string") context[one] = raw_[one] as string;
    const title = typeof body["title"] === "string" ? body["title"].slice(0, 120) : "a task";
    const column = typeof body["column"] === "string" ? body["column"].slice(0, MAX_COLUMN_TITLE_CHARS) : "a column";
    const model = typeof body["model"] === "string" ? body["model"].slice(0, 128) : null;
    // An older asker sends neither, and is judged as it was.
    const effort = typeof body["effort"] === "string" ? body["effort"].slice(0, MAX_CHOICE_CHARS) : null;
    const instructions = typeof body["instructions"] === "string" ? body["instructions"].slice(0, MAX_ROLE_INSTRUCTIONS_CHARS) : null;
    // A wake's question carries its comment; an older asker sends none.
    const comment = typeof body["comment"] === "string" ? body["comment"].slice(0, MAX_WAKE_TEXT_CHARS) : null;
    if (comment !== null) context.comment = comment;
    const offer = await this.offer();
    const lower = agent.toLowerCase();
    const judges = this.options.judges ?? null;
    if (judges === null) return { exit: null, confidence: null };
    try {
      const classifier = offer.agents.find((one) => one.kind === "classifier" && (one.id === agent || one.name.toLowerCase() === lower));
      if (classifier !== undefined && judges.classify !== undefined) {
        const value = await bounded(CLASSIFIER_TIMEOUT_MS, (signal) => judges.classify!(classifier.id, { exits: named.map((exit) => ({ name: exit.name, means: exit.means, label: exit.label })), context }, signal));
        return readVerdict(value, named) ?? { exit: null, confidence: null };
      }
      const runnable = offer.agents.find((one) => one.kind !== "classifier" && (one.id === agent || (one.kind === "custom" && one.name.toLowerCase() === lower)));
      if (runnable === undefined) return { exit: null, confidence: null };
      const harness = runnable.kind === "custom" ? (runnable.harness ?? runnable.id) : runnable.id;
      const prompt = judgePrompt(title, column, named, sees, context, instructions, comment);
      const text = await bounded(JUDGE_TIMEOUT_MS, (signal) => judges.ask(harness, prompt, { model, effort }, signal));
      return parseVerdict(text, named) ?? { exit: null, confidence: null };
    } catch {
      // No answer is an abstention, as it would be on the asking machine.
      return { exit: null, confidence: null };
    }
  }

  /** What a column's `sees` lets a judge read, from the run that just ended. A piece nobody could read is left out. */
  private async seen(record: TaskRecord, task: BoardTask, sees: readonly string[]): Promise<SeenContext> {
    const last = task.last;
    const out: SeenContext = {};
    if (sees.includes("brief")) out.brief = task.brief;
    if (sees.includes("summary")) out.summary = task.summary;
    if (sees.includes("report")) out.report = last?.report ?? null;
    if (sees.includes("last_message")) out.last_message = last?.message ?? null;
    if (sees.includes("diff_stat") && last?.diff != null) {
      out.diff_stat = `${last.diff.files} file(s), ${last.diff.lines} line(s) changed:\n${last.diff.paths.slice(0, 50).join("\n")}`;
    }
    if (sees.includes("diff") && last?.range != null && record.flow.workdir !== null) {
      out.diff = await this.code.diffText(record.flow.workdir, last.range.from, last.range.to, MAX_SEEN_DIFF_BYTES * 4);
    }
    return out;
  }

  /** Where a run without code works: one empty folder per task, made by this daemon and kept for the task's next such run. */
  private async codelessFolder(taskId: string): Promise<string> {
    const root = this.options.codelessRoot;
    if (root == null) throw new Error("this daemon has no folder for a run without code");
    const folder = join(root, taskId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return folder;
  }

  // Between machines (Q2.269).

  private fleetName(machine: string): string {
    return this.fleetCache.find((one) => one.offer.key === machine)?.offer.name ?? machine;
  }

  /**
   * Before a run that needs the code leaves for another machine: what is left in the worktree is committed, and then all of it
   * must be on the task's branch, or it stays here for its person (Q2.271). Only the machine holding the code can tell.
   */
  private async codeLeaves(record: TaskRecord, to: string): Promise<TaskRecord | string> {
    const code = record.flow.code;
    const workdir = record.flow.workdir;
    if (code === null || code.holder !== this.machineKey || workdir === null) return record;
    const before = await this.code.head(workdir);
    const committed = await this.code.controlCommit(workdir, `board: before the move to ${to}`);
    if (committed.refused !== null) return `the task's code here could not be committed, so it does not go to ${to}: ${committed.refused}`;
    const unsaved = await this.code.unsaved(workdir, code.branch);
    if (unsaved !== null) return `the task's code here is not all on its branch, so it does not go to ${to}: ${unsaved}`;
    if (committed.head === null || committed.head === code.head) return record;
    const moved: TaskRecord = { ...record, flow: { ...record.flow, code: { ...code, head: committed.head } } };
    this.save(moved);
    if (committed.head !== before) this.event(moved, "note", `what was left in the task's worktree was committed before the move to ${to}`);
    return moved;
  }

  /** What crosses with the task: its record and flow, the feed's last entries and some history, under the board it was placed by. */
  handoffPayload(record: TaskRecord, epoch: number, placedAs: string): HandoffPayload {
    const { flow, ...fields } = record;
    return {
      v: 1,
      id: record.id,
      epoch,
      placedAs,
      boardRevision: this.state.revision,
      boardHash: this.state.hash,
      task: {
        title: fields.title,
        brief: fields.brief,
        summary: fields.summary,
        summaryAt: fields.summaryAt,
        summaryBy: fields.summaryBy,
        agent: fields.agent,
        customAgent: fields.customAgent,
        assignee: fields.assignee,
        cwd: fields.cwd,
        key: fields.key,
        createdAt: fields.createdAt,
      },
      flow: { ...flow, epoch, workdir: null, handoff: null, moving: null, judging: null, wait: null, woken: null },
      comments: this.store.comments(record.id).map((one) => ({ ...one, text: one.text.slice(0, MAX_MOVED_COMMENT_CHARS) })),
      events: this.store.events(record.id).slice(-MAX_MOVED_EVENTS),
    };
  }

  /** One try at a move: taken, it leaves a tombstone here; refused, its person decides; unanswered, it is tried again later. */
  private async sendHandoff(id: string): Promise<void> {
    const record = this.store.get(id);
    const move = record?.flow.handoff;
    if (record == null || move == null || this.options.send == null) return;
    const payload = this.handoffPayload(record, move.epoch, move.name);
    const answer = await this.options.send(move.to, { method: "POST", path: `/peer/tasks/${encodeURIComponent(id)}/handoff`, body: payload }, HANDOFF_TIMEOUT_MS);
    const latest = this.store.get(id);
    if (latest === null || latest.flow.handoff == null) return;
    const taken = answer.ok && answer.status === 200 && (answer.body as { accepted?: unknown } | null)?.accepted === true;
    if (taken) {
      this.store.tombstone({ id, epoch: move.epoch, movedTo: move.to, at: this.now(), workdir: latest.flow.workdir, branch: latest.flow.code?.branch ?? null });
      this.store.retire(id);
      return;
    }
    const refused = answer.ok && answer.status >= 400 && answer.status < 500 && answer.status !== 404 && answer.status !== 429;
    const late = this.now() - move.since >= HANDOFF_GIVE_UP_MS;
    if (refused || late) {
      const said = answer.ok ? ((answer.body as { error?: { message?: unknown } } | null)?.error?.message ?? `answered ${answer.status}`) : answer.code;
      const detail = refused ? `${move.name} would not take the run: ${String(said)}` : `${move.name} did not take the run for a day`;
      const task = this.boardTask(latest);
      const asked = applyStep(task, this.state.board, { kind: "ask", reason: "handoff_failed", detail }, this.now());
      const written = this.writeTask({ ...latest, flow: { ...latest.flow, handoff: null } }, asked);
      this.save({ ...written, flow: { ...written.flow, handoff: null, moving: null } });
      this.event(written, "failed", detail);
      return;
    }
    const tries = move.tries + 1;
    const wait = Math.min(HANDOFF_FIRST_RETRY_MS * 2 ** move.tries, HANDOFF_MAX_RETRY_MS);
    this.save({ ...latest, flow: { ...latest.flow, handoff: { ...move, tries, nextAt: this.now() + wait } } });
  }

  /** A task another machine hands over: taken where nothing here is newer and this board lets the run be here. */
  async receiveHandoff(from: { machine: string; label: string }, raw: unknown): Promise<{ ok: true } | { ok: false; status: 400 | 409; code: string; message: string }> {
    const payload = readHandoff(raw);
    if (typeof payload === "string") return { ok: false, status: 400, code: "bad_request", message: payload };
    const held = this.store.get(payload.id);
    if (held !== null) {
      if (held.flow.epoch === payload.epoch) return { ok: true };
      if (held.flow.epoch > payload.epoch) return { ok: false, status: 409, code: "task_stale", message: `this machine holds the task at epoch ${held.flow.epoch}` };
    }
    const stone = this.store.tombstones().find((one) => one.id === payload.id) ?? null;
    if (stone !== null && stone.epoch >= payload.epoch) return { ok: false, status: 409, code: "task_stale", message: `this machine gave the task away at epoch ${stone.epoch}` };
    if (payload.boardRevision > this.state.revision || (payload.boardRevision === this.state.revision && payload.boardHash < this.state.hash)) {
      await this.pullBoard(from.machine);
    }
    if (payload.boardRevision > this.state.revision) return { ok: false, status: 409, code: "board_behind", message: `this machine could not read board revision ${payload.boardRevision}` };
    const column = columnById(this.state.board, payload.flow.column);
    const run = payload.flow.run;
    if (column === null || column.kind !== "work" || run === null || run.state !== "pending") {
      return { ok: false, status: 409, code: "not_a_run", message: "a task moves between machines only for a run of a work column" };
    }
    const role = column.run.role === null ? null : this.state.board.roles.find((one) => one.name === column.run.role);
    const lower = payload.placedAs.toLowerCase();
    if (role?.on != null && !role.on.some((name) => name.toLowerCase() === lower || name === this.machineKey)) {
      return { ok: false, status: 409, code: "role_not_here", message: `the board's ${role.name} runs on ${role.on.join(", ")}, and this machine is not one` };
    }
    const now = this.now();
    const record: TaskRecord = {
      id: payload.id,
      ...payload.task,
      status: storedStatusOf(this.state.board, payload.flow.column),
      updatedAt: now,
      flow: { ...flowDefaults(), ...payload.flow, workdir: held?.flow.workdir ?? stone?.workdir ?? null, handoff: null },
    };
    this.store.save(record);
    for (const comment of payload.comments) this.store.saveComment(record.id, comment);
    for (const event of payload.events) this.store.addEvent(record.id, { ...event });
    this.store.forgetTombstone(record.id);
    this.event(record, "moved", `came from ${from.label} to run here`);
    void this.kick(record.id);
    return { ok: true };
  }

  /** The newest board another machine holds, adopted where it is newer than this one's. */
  async pullBoard(machine: string): Promise<void> {
    if (this.options.send == null) return;
    const answer = await this.options.send(machine, { method: "GET", path: "/peer/board" }, HANDOFF_TIMEOUT_MS);
    if (!answer.ok || answer.status !== 200) return;
    const body = answer.body as { revision?: unknown; hash?: unknown; text?: unknown } | null;
    if (typeof body?.revision !== "number" || typeof body.hash !== "string" || typeof body.text !== "string") return;
    this.adopt({ revision: body.revision, hash: body.hash, text: body.text, at: this.now() });
  }

  /** The task's code fetched from the machine that holds it, then the board steps again: forward only, over a clean tree. */
  private async syncCode(id: string): Promise<void> {
    if (this.syncing.has(id)) return;
    this.syncing.add(id);
    let folder: string | null = null;
    try {
      const record = this.store.get(id);
      const code = record?.flow.code;
      if (record == null || code == null || this.options.send == null) return;
      const fail = (reason: "code_diverged" | "code_not_portable" | "code_dirty", detail: string): void => {
        const latest = this.store.get(id);
        if (latest === null) return;
        this.writeTask(latest, applyStep(this.boardTask(latest), this.state.board, { kind: "ask", reason, detail }, this.now()));
        this.event(latest, "asked", detail);
      };
      const checkout = record.flow.workdir ?? (await this.checkoutFor(code.repo));
      if (checkout === null) return fail("code_not_portable", `this machine has no checkout of ${code.repo}`);
      let have = record.flow.workdir !== null ? await this.code.head(record.flow.workdir) : await this.code.branchHead(checkout, code.branch);
      if (have === null && code.base.length > 0) {
        if (!(await this.code.hasCommit(checkout, code.base))) await this.code.fetchOrigin(checkout);
        if (await this.code.hasCommit(checkout, code.base)) have = code.base;
      }
      const pieces: Buffer[] = [];
      let size = 0;
      let head = code.head;
      for (let offset = 0; ; ) {
        const query = `have=${encodeURIComponent(have ?? "")}&offset=${offset}`;
        const answer = await this.options.send(code.holder, { method: "GET", path: `/peer/tasks/${encodeURIComponent(id)}/code?${query}` }, HANDOFF_TIMEOUT_MS);
        if (!answer.ok || answer.status >= 500) {
          const latest = this.store.get(id);
          if (latest !== null) this.writeTask(latest, applyStep(this.boardTask(latest), this.state.board, { kind: "wait", reason: "code_holder_offline", detail: `waiting for ${this.fleetName(code.holder)}, which has the code` }, this.now()));
          return;
        }
        const body = answer.body as { current?: unknown; head?: unknown; size?: unknown; piece?: unknown; done?: unknown; error?: { code?: unknown; message?: unknown } } | null;
        if (body?.error?.code === "code_dirty") {
          return fail("code_dirty", `the task's code on ${this.fleetName(code.holder)} is not all on its branch: ${String(body.error.message)}`);
        }
        if (answer.status !== 200 || body === null) return fail("code_diverged", `the code could not be fetched: ${String(body?.error?.message ?? answer.status)}`);
        if (typeof body.head === "string") head = body.head;
        if (body.current === true) break;
        if (typeof body.piece !== "string" || typeof body.size !== "number") return fail("code_diverged", "the code came in a shape this machine cannot read");
        const piece = Buffer.from(body.piece, "base64");
        pieces.push(piece);
        size = body.size;
        offset += piece.length;
        if (body.done === true || offset >= size || piece.length === 0) break;
      }
      if (pieces.length > 0) {
        folder = await mkdtemp(join(tmpdir(), "reemoat-arrived-"));
        const file = join(folder, "task.bundle");
        await writeFile(file, Buffer.concat(pieces));
        if (record.flow.workdir !== null) {
          const moved = await this.code.fastForward(record.flow.workdir, file, code.branch, head ?? "");
          if (moved !== "moved") {
            return fail("code_diverged", moved === "dirty" ? "this machine's copy of the task's code has changes of its own" : moved === "diverged" ? "this machine's copy of the task's branch went its own way" : moved.failed);
          }
        } else {
          const refused = await this.code.fetchBundle(checkout, file, code.branch);
          if (refused !== null) return fail("code_diverged", `the code could not be taken in: ${refused}`);
        }
      }
      const latest = this.store.get(id);
      if (latest !== null) {
        // The holder's branch is the code: a commit made there after its run ended is the head now, or this machine asks for it forever.
        const held = latest.flow.code;
        const settled = held !== null && head !== null && held.head !== head ? { ...held, head } : held;
        this.save({ ...latest, flow: { ...latest.flow, code: settled, moving: null } });
      }
    } finally {
      this.syncing.delete(id);
      if (folder !== null) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
    void this.kick(id);
  }

  /** One piece of the task's code since `have`, as the machine that holds it: a bundle made once and kept while it is fetched. */
  async codePiece(id: string, have: string | null, offset: number): Promise<{ status: 200 | 404 | 409 | 413; body: unknown }> {
    const record = this.store.get(id);
    const stone = this.store.tombstones().find((one) => one.id === id) ?? null;
    const workdir = record?.flow.workdir ?? stone?.workdir ?? null;
    const branch = record?.flow.code?.branch ?? stone?.branch ?? null;
    if (workdir === null || branch === null) return { status: 404, body: { error: { code: "no_code", message: "this machine holds no code for that task" } } };
    // Work that is not on the branch would be left behind without a word: the receiver's person is told instead (Q2.271).
    if (offset === 0) {
      const unsaved = await this.code.unsaved(workdir, branch);
      if (unsaved !== null) return { status: 409, body: { error: { code: "code_dirty", message: unsaved } } };
    }
    const key = `${id}\0${have ?? ""}`;
    let held = this.bundles.get(key);
    if (held === undefined || this.now() - held.at > CODE_CACHE_MS) {
      const made = await this.code.bundle(workdir, branch, have);
      if (made.kind === "current") return { status: 200, body: { current: true, head: made.head } };
      if (made.kind === "refused") return { status: made.message.includes("MiB") ? 413 : 409, body: { error: { code: "code_refused", message: made.message } } };
      held = { at: this.now(), file: made.file, size: made.size, head: made.head };
      this.bundles.set(key, held);
      for (const [other, one] of this.bundles) {
        if (this.now() - one.at > CODE_CACHE_MS) {
          this.bundles.delete(other);
          void rm(dirname(one.file), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    const handle = await open(held.file, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, Math.min(CODE_PIECE_BYTES, held.size - offset)));
      await handle.read(buffer, 0, buffer.length, offset);
      const done = offset + buffer.length >= held.size;
      return { status: 200, body: { head: held.head, size: held.size, offset, piece: buffer.toString("base64"), done } };
    } finally {
      await handle.close();
    }
  }

  // The feed.

  comment(record: TaskRecord, entry: Pick<TaskComment, "kind" | "author" | "text" | "sessionId"> & Partial<TaskComment>): TaskComment {
    const comment: TaskComment = {
      id: entry.id ?? `c_${randomBytes(6).toString("base64url")}`,
      at: this.now(),
      request: null,
      entry: record.flow.entry,
      delivered: false,
      ...entry,
      text: entry.text.slice(0, MAX_COMMENT_CHARS),
    };
    this.store.saveComment(record.id, comment);
    return comment;
  }

  /**
   * A person's comment: into the run's conversation while one is at work, as their own message, else into the next run's note.
   * On a task that waits, its column's wake sends it on, at once where it asks no judge (Q2.275, Q2.279).
   */
  async addComment(record: TaskRecord, text: string, files: readonly TaskFile[] = []): Promise<TaskComment> {
    const touched = this.touched(record);
    const run = touched.flow.run;
    const managed = run !== null && run.state === "working" && run.session !== null ? this.registry.get(run.session) : undefined;
    let delivered = false;
    if (managed !== undefined && !this.sessionOf(managed, true).gone) {
      const ready = await this.registry.readyForMessage(managed, "person");
      if (ready === "ready") {
        const attached = await this.filesFor(touched, files, managed);
        // A comment of files alone, none of which could go, has nothing left to say now; it waits for the next run.
        if (text.length > 0 || attached.length > 0) {
          const first = managed.prompt(text, attached, null, null);
          const sent = first.kind === "turn_in_flight" ? await managed.sendMidTurn(text, attached, null, null) : first;
          delivered = sent.kind === "accepted" || sent.kind === "steered" || sent.kind === "queued";
        }
      }
    }
    const id = `c_${randomBytes(6).toString("base64url")}`;
    let latest = this.store.get(record.id) ?? touched;
    let woke = false;
    if (!delivered) {
      const named = files.length === 0 ? "" : `(attached: ${files.map((file) => file.name).join(", ")})`;
      const line = text.length === 0 ? named : named.length === 0 ? text : `${text}\n${named}`;
      const pendingFiles = [...(latest.flow.pendingFiles ?? []), ...files].slice(-MAX_PENDING_TASK_FILES);
      latest = { ...latest, flow: { ...latest.flow, notes: [...latest.flow.notes, line].slice(-MAX_NOTES), pendingFiles } };
      this.save(latest);
      const task = this.boardTask(latest);
      if (latest.flow.handoff == null && wakeable(task, this.state.board)) {
        latest = this.writeTask(latest, withWake(task, { id, text: line }, this.now()));
        woke = true;
      }
    }
    const comment = this.comment(latest, {
      id,
      kind: "comment",
      author: "you",
      text,
      sessionId: delivered ? (managed?.id ?? null) : null,
      delivered,
      ...(files.length === 0 ? {} : { files: [...files] }),
    });
    // A wake that waits on no role is taken now, with nothing awaited since it was armed, so the answer says where the comment went.
    const column = woke ? columnById(this.state.board, latest.flow.column) : null;
    if (column !== null && column.kind === "wait") {
      const task = this.boardTask(latest);
      const next = wakeStep(task, this.state.board, column);
      if (next.kind === "move" || next.kind === "stay") await this.apply(latest, task, next, { started: null, refused: null });
    }
    void this.kick(record.id);
    return this.store.comments(record.id).find((one) => one.id === id) ?? comment;
  }

  /** A comment the task's wake carried to a run: it is that run's to read now, not a note left for later. */
  private markDelivered(taskId: string, commentId: string): void {
    const comment = this.store.comments(taskId).find((one) => one.id === commentId);
    if (comment !== undefined && !comment.delivered) this.store.saveComment(taskId, { ...comment, delivered: true });
  }

  /** task_update from a session: the summary is the task's, and the run's report only from the run's own session. */
  report(record: TaskRecord, sessionId: string, report: { summary: string | null; outcome: string | null; review: boolean | null }): TaskRecord {
    const task = this.boardTask(record);
    let next = withReport(task, { session: sessionId, summary: report.summary, outcome: report.outcome, review: report.review === true });
    // Saying running takes back what this run reported, while it is still this run's to take back.
    if (report.review === false && next.run !== null && next.run.session === sessionId && next.run.state === "working") {
      next = { ...next, run: { ...next.run, reported: false, outcome: null } };
    }
    const written = this.writeTask(record, next);
    if (report.summary !== null && report.summary.length > 0) this.comment(written, { kind: "report", author: sessionId, text: report.summary, sessionId });
    void this.kick(record.id);
    return written;
  }

  // Sessions.

  private watch(managed: ManagedSession): void {
    if (this.watched.has(managed.id)) return;
    const off = managed.log.subscribe((stored) => this.onEvent(managed, stored.event));
    this.watched.set(managed.id, off);
  }

  private onEvent(managed: ManagedSession, event: SessionEvent): void {
    if (!WAKING_EVENTS.has(event.type)) return;
    const attachment = this.store.attachments().find((one) => one.sessionId === managed.id);
    if (attachment === undefined) return;
    const record = this.store.get(attachment.taskId);
    if (record === null) return;
    if (event.type === "permission_request" && event.permissionId !== null) {
      this.comment(record, {
        id: `q_${managed.id}_${event.permissionId}`,
        kind: "question",
        author: managed.id,
        text: event.title,
        sessionId: managed.id,
        request: { kind: "permission", id: event.permissionId },
      });
    } else if (event.type === "elicitation_request") {
      this.comment(record, {
        id: `q_${managed.id}_${event.elicitationId}`,
        kind: "question",
        author: managed.id,
        text: event.message,
        sessionId: managed.id,
        request: { kind: "elicitation", id: event.elicitationId },
      });
    }
    // After the event's own synchronous fan-out: the session's status is read once it has settled.
    setImmediate(() => void this.kick(record.id));
  }

  private warn(detail: string): void {
    try {
      this.options.onWarning?.(detail);
    } catch {
      // There is no other way to report from here.
    }
  }
}

const WAKING_EVENTS = new Set<SessionEvent["type"]>([
  "turn_end",
  "status",
  "prompt",
  "permission_request",
  "permission_resolved",
  "elicitation_request",
  "elicitation_resolved",
  "session_started",
]);

/** What a session's status says to a task's phase: a request waiting is the person's, running and starting are work, the rest is rest. */
export function phaseSession(status: SessionStatus): { blocked: boolean; working: boolean } {
  return { blocked: status === "blocked", working: status === "running" || status === "starting" };
}

/** What an older build would have stored for a task in this column, should this one be rolled back. */
export function storedStatusOf(board: Board, column: string): StoredTaskStatus {
  if (column === board.intake) return "ready";
  const at = columnById(board, column);
  if (at === null) return "running";
  if (at.kind === "work") return "running";
  return at.kind === "wait" && at.final ? "done" : "review";
}

function actorName(by: Actor): string {
  switch (by.kind) {
    case "role":
      return by.role;
    case "human":
      return "you";
    case "config":
      return "board";
    default:
      return by.kind;
  }
}

function movedWords(board: Board, from: string, to: string, exit: string | null, by: Actor): string {
  const title = (id: string): string => board.columns.find((one) => one.id === id)?.title ?? id;
  const where = `${title(from)} → ${title(to)}${exit !== null && exit !== "next" ? ` (${exit})` : ""}`;
  if (by.kind === "config") return `${where}: the board no longer has that column`;
  return `${where} by ${actorName(by)}${by.kind === "role" && by.confidence !== null ? ` · ${Math.round(by.confidence * 100)}%` : ""}`;
}

function pickVerdict(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return null;
  const answer = body as Record<string, unknown>;
  return { exit: answer["exit"] ?? null, ...(answer["confidence"] === undefined || answer["confidence"] === null ? {} : { confidence: answer["confidence"] }) };
}

/** A call given its own deadline, its signal aborted when it passes. */
async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`no answer within ${Math.round(ms / 1000)} s`));
      reject(new Error(`no answer within ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 240 ? flat : `${flat.slice(0, 239)}…`;
}

/** The text of the agent's last message among these events: its chunks, joined, cut to a stop's bound. */
export function lastAgentMessage(events: readonly SessionEvent[]): string | null {
  let id: string | null | undefined;
  let text = "";
  for (const event of events) {
    if (event.type === "prompt") {
      id = undefined;
      text = "";
      continue;
    }
    if (event.type !== "text" || event.role !== "agent" || event.thought) continue;
    if (id === undefined || event.messageId !== id) {
      id = event.messageId;
      text = "";
    }
    text += event.text;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_LAST_MESSAGE_CHARS ? trimmed : `${trimmed.slice(0, MAX_LAST_MESSAGE_CHARS - 1)}…`;
}
