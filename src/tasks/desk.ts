import { randomBytes } from "node:crypto";
import type { SessionStatus, TaskProposal } from "../events.js";
import type { PeerAnswer } from "../peers/channel.js";
import { address, parseAddress } from "../peers/envelope.js";
import type { ManagedSession, PromptResult, SessionRegistry } from "../registry.js";
import type { PeerLink } from "../store/sqlite.js";
import {
  isTaskAssignee,
  MAX_TASKS,
  MAX_TASK_SUMMARY_CHARS,
  MAX_TASK_TITLE_CHARS,
  type StoredTaskStatus,
  type TaskAssignee,
  type TaskRecord,
  type TaskStatus,
  type TaskStore,
} from "./store.js";
import {
  DISPATCH_NICKNAME,
  isAgentRef,
  isProjectPath,
  parseProposals,
  parseTaskUpdate,
  taskNote,
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

/** A task as every reader is shown it: the record, the status its sessions settle, and the sessions themselves. Flat, for the hand mirror in wire.ts. */
export interface TaskSnapshot {
  id: string;
  title: string;
  brief: string;
  status: TaskStatus;
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
  /** Where it is put: the backlog, or a column a person dropped it into (Q2.262). */
  status: StoredTaskStatus;
  cwd: string;
  key: string | null;
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
}

/** The other machines' half, handed in: the hub's links and its switches (Q2.244). */
export interface TaskPeers {
  readonly machineId: string | null;
  /** Linked machines this caller's agent may ask now: none where messaging is off, isolated, or off for the conversation. */
  linksFor(callerId: string): PeerLink[];
  askLink(link: PeerLink, path: string, timeoutMs: number): Promise<PeerAnswer>;
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
export type TaskUpdateResult = { ok: true; task: TaskSnapshot; recorded: StoredTaskStatus | null } | { ok: false; message: string };

type Remote<T> = T | { reason: string };

export interface TaskDeskOptions {
  registry: SessionRegistry;
  store: TaskStore;
  peers?: TaskPeers | null;
  now?: () => number;
}

/**
 * A task's status as shown: done is its person's word, running and needs_you are what its sessions do now, and otherwise
 * where it was put: the backlog while it is ready, review once an agent has been on it (Q2.258, Q2.260).
 */
export function taskStatus(stored: StoredTaskStatus, sessions: readonly SessionStatus[]): TaskStatus {
  if (stored === "done") return "done";
  if (sessions.includes("blocked")) return "needs_you";
  if (sessions.some((status) => status === "running" || status === "starting")) return "running";
  return stored === "ready" ? "ready" : "review";
}

/** Every task on this machine and every door to one: the routes, the four tools, and what a linked machine may read. */
export class TaskDesk {
  private readonly registry: SessionRegistry;
  private readonly store: TaskStore;
  private readonly peers: TaskPeers | null;
  private readonly now: () => number;
  private readonly remote = new Map<string, { at: number; answer: Promise<Remote<unknown>> }>();

  constructor(options: TaskDeskOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.peers = options.peers ?? null;
    this.now = options.now ?? Date.now;
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
      const oldestDone = all.filter((task) => task.status === "done").sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldestDone === undefined) return "full";
      this.store.remove(oldestDone.id);
    }
    const at = this.now();
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
    };
    this.store.save(task);
    return { task, existing: false };
  }

  /** A session just launched for the task: attached, named after it, and handed the brief as its first message. */
  begin(task: TaskRecord, managed: ManagedSession): PromptResult {
    this.attach(task, managed);
    if (managed.title === null) this.registry.setMeta(managed, { title: task.title });
    return managed.prompt(task.brief, [], null, { text: taskNote(task.title), mentions: [] });
  }

  /** Attaching moves a session off whatever task held it, and a task with a session is no longer waiting to start. */
  attach(task: TaskRecord, managed: ManagedSession): TaskRecord {
    const at = this.now();
    this.store.attach(task.id, managed.id, at);
    if (task.status !== "ready") return task;
    const started: TaskRecord = { ...task, status: "running", updatedAt: at };
    this.store.save(started);
    return started;
  }

  /** False when that session is not on that task. */
  detach(taskId: string, sessionId: string): boolean {
    const held = this.store.attachments().find((one) => one.sessionId === sessionId);
    if (held === undefined || held.taskId !== taskId) return false;
    this.store.detach(sessionId);
    return true;
  }

  change(id: string, change: TaskChange, by: string | null = null): TaskRecord | null {
    const task = this.store.get(id);
    if (task === null) return null;
    const at = this.now();
    const next: TaskRecord = { ...task, updatedAt: at };
    if (change.title !== undefined) next.title = change.title;
    if (change.brief !== undefined) next.brief = change.brief;
    if (change.status !== undefined) next.status = change.status;
    if (change.agent !== undefined) next.agent = change.agent;
    if (change.customAgent !== undefined) next.customAgent = change.customAgent;
    if (change.assignee !== undefined) next.assignee = change.assignee;
    if (change.cwd !== undefined) next.cwd = change.cwd;
    if (change.summary !== undefined) {
      next.summary = change.summary.length === 0 ? null : change.summary;
      next.summaryAt = next.summary === null ? null : at;
      next.summaryBy = next.summary === null ? null : by;
    }
    this.store.save(next);
    return next;
  }

  remove(id: string): boolean {
    if (this.store.get(id) === null) return false;
    this.store.remove(id);
    return true;
  }

  /** Once, after restore: the prune removes sessions before anything here is open, and their attachments name nobody. */
  sweep(): number {
    let dropped = 0;
    for (const attachment of this.store.attachments()) {
      if (this.registry.get(attachment.sessionId) !== undefined && this.store.get(attachment.taskId) !== null) continue;
      this.store.detach(attachment.sessionId);
      dropped += 1;
    }
    return dropped;
  }

  /** Whether this caller is the dispatcher: an ordinary session, known only by its nickname. */
  isDispatch(callerId: string): boolean {
    return this.registry.get(callerId)?.nickname === DISPATCH_NICKNAME;
  }

  /** task_update: the caller's own task and no other. */
  update(callerId: string, args: Record<string, unknown>): TaskUpdateResult {
    const parsed = parseTaskUpdate(args);
    if (typeof parsed === "string") return { ok: false, message: parsed };
    const task = this.taskOf(callerId);
    if (task === null) return { ok: false, message: "this conversation is attached to no task, so there is nothing to update" };
    const change: TaskChange = {};
    if (parsed.summary !== null) change.summary = parsed.summary;
    if (parsed.status !== null) change.status = parsed.status;
    const changed = this.change(task.id, change, callerId);
    if (changed === null) return { ok: false, message: "that task no longer exists" };
    return { ok: true, task: this.snapshot(changed), recorded: parsed.status };
  }

  /** propose_tasks: one card in the caller's own transcript; the task and its agent start on a press, never here (Q2.259). */
  async propose(callerId: string, args: Record<string, unknown>): Promise<ProposeResult> {
    const session = this.registry.get(callerId);
    if (session === undefined) return { ok: false, message: "this session no longer exists" };
    const parsed = parseProposals(args);
    if (typeof parsed === "string") return { ok: false, message: parsed };
    const listing = await this.listProjects(callerId);
    const proposals: TaskProposal[] = [];
    for (const one of parsed) {
      const target = resolveMachine(one, listing, this.peers?.machineId ?? null);
      if (typeof target === "string") return { ok: false, message: target };
      if (!target.agents.includes(one.agent)) {
        const where = target.machine.isThis ? "this machine" : (target.machine.label ?? "that machine");
        return {
          ok: false,
          message:
            target.agents.length === 0
              ? `${where} has no agent ready to run a task`
              : `${where} offers ${target.agents.join(", ")}; ${one.agent} is not one of them`,
        };
      }
      proposals.push({
        id: `tp_${randomBytes(9).toString("base64url")}`,
        machineId: target.machine.id,
        machine: target.machine.label,
        project: one.project,
        agent: one.agent,
        title: one.title,
        brief: one.brief,
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
      else machines.push({ machine: machineOf(link), ...answer });
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
    return { ...task, status: taskStatus(task.status, sessions.map((session) => session.status)), sessions };
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
function remoteProjectsOf(body: unknown): { agents: string[]; projects: string[] } | null {
  const answer = body as { agents?: unknown; projects?: unknown } | null;
  if (answer === null || typeof answer !== "object" || !Array.isArray(answer.agents) || !Array.isArray(answer.projects)) return null;
  return {
    agents: answer.agents.filter((one): one is string => typeof one === "string" && isAgentRef(one)).slice(0, MAX_REMOTE_AGENTS),
    projects: answer.projects
      .filter((one): one is string => typeof one === "string" && isProjectPath(one))
      .slice(0, MAX_LISTED_PROJECTS),
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
