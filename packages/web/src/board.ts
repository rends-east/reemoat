/** The task board's own rules: what is drawn, in which group, and what is remembered of a machine that is away (Q3.719). No DOM and no store in the module body: webcheck imports it. */

import type { MachineId, SessionId, SessionRef } from "./ids";
import type { Reach } from "./machine";
import type { TaskAssignee, TaskSessionRef, TaskSnapshot, TaskStatus } from "./wire";

export const TASKS_STORAGE_KEY = "reemoat.tasks";

/** While the board is on screen it is read at the session list's own pace, and seldom otherwise: only a count and a summary card need it then. */
export const BOARD_WATCH_MS = 4_000;
export const BOARD_IDLE_MS = 30_000;
/** How long a daemon with no /tasks route is left alone when it names no instance to compare. */
export const BOARD_ABSENT_MS = 5 * 60_000;
export const MAX_REMEMBERED_TASKS = 200;
/** A remembered task keeps enough of its brief to be recognised, never the brief. */
export const REMEMBERED_BRIEF_CHARS = 280;
/** How long a finished task stays on the board before only the `All` filter shows it. */
export const DONE_RECENT_MS = 24 * 60 * 60_000;

/** `absent` is a daemon older than tasks: nothing of it is drawn and nothing is said (Q2.258). */
export type BoardRead = "known" | "failed" | "absent";

export interface HeldBoard {
  tasks: TaskSnapshot[];
  /** When `tasks` was last read, on this device's clock. */
  at: number;
  read: BoardRead;
  /** The daemon instance that answered, where it said; an older one is asked again once another answers /health. */
  daemon: string | null;
}

export interface BoardMachine {
  id: MachineId;
  name: string;
  reach: Reach;
}

export interface BoardTask {
  machineId: MachineId;
  machine: string;
  task: TaskSnapshot;
  /** Its machine is not being read now, so this is what it last said. */
  unavailable: boolean;
}

/** Every status a task may show, in the order work moves through the board. */
export const STATUS_ORDER: readonly TaskStatus[] = ["ready", "running", "needs_you", "review", "done"];

/**
 * The board's columns (Q3.727, Q3.732): the backlog, where an assignee moves nothing, an agent at work, its person looking,
 * done. A task waiting on its person stays in Running, where its agent still is.
 */
export const BOARD_COLUMNS = ["ready", "running", "review", "done"] as const satisfies readonly TaskStatus[];
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export function columnOf(status: TaskStatus): BoardColumn {
  return status === "needs_you" ? "running" : status;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  ready: "Backlog",
  running: "Running",
  needs_you: "Needs you",
  review: "Review",
  done: "Done",
};

/**
 * Who holds a task as the board draws it (Q3.727, Q3.732, Q3.736): in the backlog the agent somebody named, its person or
 * nobody, then the agent working on it, else its person.
 */
export type TaskHolder =
  | { kind: "nobody" }
  | { kind: "you" }
  | { kind: "agent"; agent: string; customAgent: string | null; nickname: string | null };

export function taskHolder(task: TaskSnapshot): TaskHolder {
  const status = shownStatus(task.status);
  const named: TaskHolder = { kind: "agent", agent: task.agent, customAgent: task.customAgent, nickname: null };
  if (status === "ready") return task.assignee === "agent" ? named : { kind: task.assignee };
  if (status !== "running" && status !== "needs_you") return { kind: "you" };
  const lead = leadSession(task);
  if (lead !== null) return { kind: "agent", agent: lead.agent, customAgent: null, nickname: lead.nickname };
  // Started a moment ago, the conversation not listed yet: the agent it was started with; let go there to be picked, nobody yet.
  return task.assignee === "agent" ? named : { kind: "nobody" };
}

/** A status this build has never heard of asks to be looked at, which is the one group that claims nothing about it. */
export function shownStatus(status: string): TaskStatus {
  return (STATUS_ORDER as readonly string[]).includes(status) ? (status as TaskStatus) : "review";
}

/**
 * The daemon's status, settled again by what this client last heard of the task's own sessions (Q3.726): a session's
 * stream and the list poll are fresher than the board's read, so a turn that ended or a request that came is drawn at once.
 * Done is its person's word and only the board says it, and so is a task put back for nobody (Q3.727).
 */
export function liveTaskStatus(task: TaskSnapshot, live: (sessionId: string) => string | null): TaskStatus {
  const said = shownStatus(task.status);
  if (said === "done" || task.sessions.length === 0) return said;
  const statuses = task.sessions.map((session) => live(session.id) ?? session.status);
  if (statuses.includes("blocked")) return "needs_you";
  if (statuses.some((status) => status === "running" || status === "starting")) return "running";
  return said === "ready" ? "ready" : "review";
}

/** Every task this account's machines hold or last said they held, in the order the machines are drawn. */
export function boardTasks(machines: readonly BoardMachine[], held: ReadonlyMap<MachineId, HeldBoard>): BoardTask[] {
  const out: BoardTask[] = [];
  for (const machine of machines) {
    const board = held.get(machine.id);
    if (board === undefined || board.read === "absent") continue;
    // The drawn reach alone, which is held through a short drop: one failed read must not grey a board (reach.md).
    const unavailable = machine.reach === "offline";
    for (const task of board.tasks) out.push({ machineId: machine.id, machine: machine.name, task, unavailable });
  }
  return out;
}

/** Any harness's spelling of the tool: `mcp__reemoat__task_update`, `reemoat.task_update`, a bare `task_update`. */
const TASK_UPDATE = /(^|__|[./:\s])task_update$/i;

/**
 * Whether these events finished a task_update call, which is the moment its board says something new (Q3.726). A call's name
 * rides only its first event, so `calls` carries the ids named so far from one stretch of the conversation to the next.
 */
export function updatesTask(events: readonly { event: { type: string } }[], calls: Set<string>): boolean {
  let finished = false;
  for (const { event } of events) {
    if (event.type !== "tool_call" && event.type !== "tool_call_update") continue;
    const call = event as { toolCallId?: unknown; title?: unknown; status?: unknown };
    const id = typeof call.toolCallId === "string" ? call.toolCallId : "";
    if (typeof call.title === "string" && TASK_UPDATE.test(call.title.trim())) calls.add(id);
    if (calls.has(id) && (call.status === "completed" || call.status === "failed")) {
      calls.delete(id);
      finished = true;
    }
  }
  return finished;
}

export function taskRefKey(machineId: string, taskId: string): string {
  return `${machineId}\u0000${taskId}`;
}

/** Who a press named to hold a task: the three fields the daemon answers it in. */
export interface AskedAssignee {
  assignee: TaskAssignee;
  agent: string;
  customAgent: string | null;
}

/** What a press asked of a task, a status or an assignee or both, drawn until its daemon answers (Q3.728, Q3.732). */
export interface Asked {
  status?: TaskStatus;
  assignee?: AskedAssignee;
  /** The machine it is moving to, as drawn: the task here is deleted once it is made there, so this answers nothing (Q3.736). */
  machine?: string;
  /** When it was asked: the change it stands for is that new, so a task let go in Done is not hidden as done long ago. */
  at: number;
}

function answers(task: TaskSnapshot, pressed: Asked): boolean {
  const { assignee } = pressed;
  if (pressed.machine !== undefined) return false;
  if (pressed.status !== undefined && pressed.status !== shownStatus(task.status)) return false;
  if (assignee !== undefined && (assignee.assignee !== task.assignee || assignee.agent !== task.agent || assignee.customAgent !== task.customAgent)) return false;
  return pressed.at <= task.updatedAt;
}

/**
 * The board with every status settled by `liveTaskStatus`, then by what a press asked for and nobody has answered yet, which
 * wins: a card let go in a column stays there until its daemon says otherwise (Q3.728). An entry nothing changed keeps its identity.
 */
export function liveBoard(
  tasks: readonly BoardTask[],
  live: (machineId: MachineId, sessionId: string) => string | null,
  asked: ReadonlyMap<string, Asked> = new Map(),
): BoardTask[] {
  return tasks.map((entry) => {
    const pressed = asked.get(taskRefKey(entry.machineId, entry.task.id));
    if (pressed !== undefined && !answers(entry.task, pressed)) {
      const status = pressed.status ?? liveTaskStatus(entry.task, (id) => live(entry.machineId, id));
      return {
        ...entry,
        machine: pressed.machine ?? entry.machine,
        task: { ...entry.task, ...pressed.assignee, status, updatedAt: Math.max(entry.task.updatedAt, pressed.at) },
      };
    }
    if (pressed?.status !== undefined) return entry;
    const status = liveTaskStatus(entry.task, (id) => live(entry.machineId, id));
    return status === shownStatus(entry.task.status) ? entry : { ...entry, task: { ...entry.task, status } };
  });
}

/** Everything a drawn board shows of its tasks, as one string: a read that changed none of it redraws nothing and writes nothing. */
export function boardSignature(tasks: readonly BoardTask[]): string {
  return tasks
    .map((entry) =>
      [
        entry.machineId,
        entry.machine,
        entry.unavailable ? "1" : "0",
        entry.task.id,
        entry.task.status,
        entry.task.updatedAt,
        entry.task.title,
        `${entry.task.assignee}:${entry.task.agent}:${entry.task.customAgent ?? ""}`,
        entry.task.sessions.map((session) => `${session.id}:${session.status}:${session.nickname}`).join(","),
      ].join("\u0000"),
    )
    .join("\u0001");
}

export type DoneFilter = "recent" | "all";

export interface BoardView {
  /** null is every machine. */
  machine: MachineId | null;
  query: string;
  done: DoneFilter;
}

export interface TaskGroup {
  status: BoardColumn;
  tasks: BoardTask[];
}

/** The last path segment: a project is named as its folder is. */
export function projectName(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

/** Title, brief, project, agent and its sessions' nicknames, with or without the `@`. */
export function matchesTask(entry: BoardTask, needle: string): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length === 0) return true;
  const { task } = entry;
  const haystack = [task.title, task.brief, task.cwd, task.agent, ...task.sessions.map((session) => `@${session.nickname}`)];
  return haystack.some((field) => field.toLowerCase().includes(wanted));
}

/** The order inside a column: the newest task leads, and nothing the poll moves reorders it. */
export function columnOrder(a: BoardTask, b: BoardTask): number {
  return b.task.createdAt - a.task.createdAt || (a.task.id < b.task.id ? -1 : 1);
}

/** One group per column that has a task, in the board's order. */
export function taskGroups(tasks: readonly BoardTask[], view: BoardView, now: number): TaskGroup[] {
  const kept = tasks.filter((entry) => {
    if (view.machine !== null && entry.machineId !== view.machine) return false;
    if (shownStatus(entry.task.status) === "done" && view.done === "recent" && now - entry.task.updatedAt > DONE_RECENT_MS) return false;
    return matchesTask(entry, view.query);
  });
  return BOARD_COLUMNS.flatMap((column) => {
    const rows = kept.filter((entry) => columnOf(shownStatus(entry.task.status)) === column).sort(columnOrder);
    return rows.length === 0 ? [] : [{ status: column, tasks: rows }];
  });
}

/** How many tasks wait on their person, on one machine or on all; an unavailable one still counts, since it was waiting when last heard. */
export function needingYou(tasks: readonly BoardTask[], machine: MachineId | null = null): number {
  return tasks.filter((entry) => (machine === null || entry.machineId === machine) && shownStatus(entry.task.status) === "needs_you").length;
}

export function taskOfSession(tasks: readonly BoardTask[], ref: SessionRef): BoardTask | null {
  return (
    tasks.find((entry) => entry.machineId === ref.machineId && entry.task.sessions.some((session) => session.id === ref.sessionId)) ?? null
  );
}

/** The task a proposal became, on whichever machine holds it: the card's row is settled by the board, never by this client's memory. */
export function taskOfProposal(tasks: readonly BoardTask[], proposalId: string): BoardTask | null {
  return tasks.find((entry) => entry.task.key === proposalId) ?? null;
}

/** The session a task opens to: the one waiting, else the one working, else the newest attached; null before any start. */
export function leadSession(task: TaskSnapshot): TaskSessionRef | null {
  const sessions = task.sessions;
  return (
    sessions.find((session) => session.status === "blocked") ??
    sessions.find((session) => session.status === "running" || session.status === "starting") ??
    [...sessions].sort((a, b) => b.attachedAt - a.attachedAt)[0] ??
    null
  );
}

export function leadRef(entry: BoardTask): SessionRef | null {
  const lead = leadSession(entry.task);
  return lead === null ? null : { machineId: entry.machineId, sessionId: lead.id as SessionId };
}

/** Whether a machine's board is due to be asked: never while one is out, seldom when nobody is looking, and an absent route almost never. */
export function boardDue(
  held: Pick<HeldBoard, "read" | "daemon"> | undefined,
  askedAt: number,
  now: number,
  watching: boolean,
  daemon: string | null,
): boolean {
  if (held?.read === "absent") {
    // A daemon that was updated is another instance, and is the only news that can change the answer.
    if (daemon !== null && held.daemon !== null) return daemon !== held.daemon;
    return now - askedAt >= BOARD_ABSENT_MS;
  }
  return now - askedAt >= (watching ? BOARD_WATCH_MS : BOARD_IDLE_MS);
}

const SESSION_STATUSES: readonly string[] = ["starting", "idle", "running", "blocked", "stopping", "interrupted", "parked", "exited", "failed"];
const TASK_ASSIGNEES: readonly TaskAssignee[] = ["nobody", "agent", "you"];

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One task as a daemon or this device's memory gave it, re-read: a row that names nothing is dropped, an unknown status is kept for `shownStatus`. */
export function readTask(raw: unknown): TaskSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row["id"] !== "string" || row["id"].length === 0 || typeof row["title"] !== "string") return null;
  const sessions = Array.isArray(row["sessions"]) ? row["sessions"] : [];
  return {
    id: row["id"],
    title: row["title"],
    brief: text(row["brief"]),
    status: text(row["status"], "review") as TaskStatus,
    summary: nullableText(row["summary"]),
    summaryAt: nullableNumber(row["summaryAt"]),
    summaryBy: nullableText(row["summaryBy"]),
    agent: text(row["agent"]),
    customAgent: nullableText(row["customAgent"]),
    // An older daemon names no assignee, and every task in its backlog was drawn as nobody's.
    assignee: (TASK_ASSIGNEES as readonly unknown[]).includes(row["assignee"]) ? (row["assignee"] as TaskAssignee) : "nobody",
    cwd: text(row["cwd"]),
    key: nullableText(row["key"]),
    createdAt: nullableNumber(row["createdAt"]) ?? 0,
    updatedAt: nullableNumber(row["updatedAt"]) ?? 0,
    sessions: sessions.flatMap((one): TaskSessionRef[] => {
      if (typeof one !== "object" || one === null) return [];
      const session = one as Record<string, unknown>;
      if (typeof session["id"] !== "string") return [];
      const status = text(session["status"]);
      return [
        {
          id: session["id"],
          agent: text(session["agent"]),
          nickname: text(session["nickname"]),
          // A status from a newer daemon is neither working nor waiting here (compatibility.md rule 2).
          status: (SESSION_STATUSES.includes(status) ? status : "idle") as TaskSessionRef["status"],
          attachedAt: nullableNumber(session["attachedAt"]) ?? 0,
        },
      ];
    }),
  };
}

export function readTasks(raw: unknown): TaskSnapshot[] {
  return Array.isArray(raw) ? raw.flatMap((one) => readTask(one) ?? []) : [];
}

/** What is written down of each machine's board, so a machine that is away still shows what it held. */
export function rememberBoards(held: ReadonlyMap<MachineId, HeldBoard>): string {
  const out: Record<string, { at: number; tasks: TaskSnapshot[] }> = {};
  for (const [id, board] of held) {
    if (board.read === "absent" || board.tasks.length === 0) continue;
    out[id] = {
      at: board.at,
      tasks: board.tasks.slice(0, MAX_REMEMBERED_TASKS).map((task) => ({ ...task, brief: task.brief.slice(0, REMEMBERED_BRIEF_CHARS) })),
    };
  }
  return JSON.stringify(out);
}

/** Read back as `failed`: it is what the machine last said, and nothing has confirmed it since. */
export function recallBoards(raw: string | null): Map<MachineId, HeldBoard> {
  const out = new Map<MachineId, HeldBoard>();
  if (raw === null) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A hand-edited or cut value: nothing is remembered, and the next read writes a whole one.
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const board = value as { at?: unknown; tasks?: unknown } | null;
    if (board === null || typeof board !== "object") continue;
    const tasks = readTasks(board.tasks);
    if (tasks.length === 0) continue;
    out.set(id as MachineId, { tasks, at: nullableNumber(board.at) ?? 0, read: "failed", daemon: null });
  }
  return out;
}

/** A key for a create, so one sent twice makes one task: letters and digits only, as the daemon's rule for one reads. */
export function taskKey(random: () => number = Math.random): string {
  let out = "tk_";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let index = 0; index < 20; index += 1) out += alphabet[Math.floor(random() * alphabet.length)] ?? "a";
  return out;
}
