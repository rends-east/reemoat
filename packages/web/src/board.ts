/** The task board's own rules: what is drawn, in which column, and what is remembered of a machine that is away (Q3.719). No DOM and no store in the module body: webcheck imports it. */

import {
  boardHash,
  columnById,
  columnForStatus,
  columnHolder,
  DEFAULT_BOARD,
  DEFAULT_BOARD_TEXT,
  isFlow,
  newerBoard,
  parseBoard,
  PHASES,
  roleByName,
  type Board,
  type Column,
  type FlowColumn,
  type ViewColumn,
} from "@reemoat/board";
import { drawnInNoList } from "./boardAgent";
import type { MachineId, SessionId, SessionRef } from "./ids";
import type { Reach } from "./machine";
import type { SessionRow } from "./store";
import {
  AGENT_IDS,
  type TaskAssignee,
  type TaskExitButton,
  type TaskPhase,
  type TaskSessionRef,
  type TaskSnapshot,
  type TaskStatus,
  type TaskTombstoneView,
} from "./wire";

export const TASKS_STORAGE_KEY = "reemoat.tasks";
/** The account's board as last drawn, so a relaunch draws its columns before any daemon has answered. */
export const BOARD_STORAGE_KEY = "reemoat.board";

/** While the board is on screen it is read at the session list's own pace, and seldom otherwise: only a count and a summary card need it then. */
export const BOARD_WATCH_MS = 4_000;
export const BOARD_IDLE_MS = 30_000;
/** How long a daemon with no /tasks route is left alone when it names no instance to compare. */
export const BOARD_ABSENT_MS = 5 * 60_000;
export const MAX_REMEMBERED_TASKS = 200;
/** A remembered task keeps enough of its brief to be recognised, never the brief. */
export const REMEMBERED_BRIEF_CHARS = 280;
/** How long a closed task stays on the board before only the `All` filter shows it. */
export const DONE_RECENT_MS = 24 * 60 * 60_000;
export const MAX_REMEMBERED_TOMBSTONES = 200;

/** `absent` is a daemon older than tasks: nothing of it is drawn and nothing is said (Q2.258). */
export type BoardRead = "known" | "failed" | "absent";

/** What `GET /tasks` says of the board a daemon runs; null is a daemon older than the configurable board. */
export interface BoardStamp {
  revision: number;
  hash: string;
}

export interface HeldBoard {
  tasks: TaskSnapshot[];
  /** When `tasks` was last read, on this device's clock. */
  at: number;
  read: BoardRead;
  /** The daemon instance that answered, where it said; an older one is asked again once another answers /health. */
  daemon: string | null;
  config: BoardStamp | null;
  /** Tasks that went from this machine to another. */
  tombstones: TaskTombstoneView[];
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
  /** Its daemon runs the configurable board; an older one's task stands where its status puts it. */
  configured: boolean;
  /** The column of the drawn board it stands in. */
  column: string;
  phase: TaskPhase;
}

/** Every status an older daemon may show, in the order work moves through the board. */
export const STATUS_ORDER: readonly TaskStatus[] = ["ready", "running", "needs_you", "review", "done"];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  ready: "Backlog",
  running: "Running",
  needs_you: "Needs you",
  review: "Review",
  done: "Done",
};

/** A status this build has never heard of asks to be looked at, which is the one group that claims nothing about it. */
export function shownStatus(status: string): TaskStatus {
  return (STATUS_ORDER as readonly string[]).includes(status) ? (status as TaskStatus) : "review";
}

export const PHASE_LABEL: Record<TaskPhase, string> = {
  needs_you: "Needs you",
  working: "Working",
  judging: "Deciding",
  moving: "Moving",
  queued: "Queued",
  waiting: "Waiting",
};

/** The client always draws the account's conversations without a task; where the board places no view of them it leads. */
export const SESSIONS_VIEW = "(chats)";

const CHATS_TITLE = "Chats";

/** Every column drawn, in order: the board's own, with a view of conversations first where the board has none (stage 7). */
export function drawnColumns(board: Board): Column[] {
  if (board.columns.some((column) => column.kind === "view")) return board.columns;
  const chats: ViewColumn = { kind: "view", id: SESSIONS_VIEW, title: CHATS_TITLE, show: "sessions" };
  return [chats, ...board.columns];
}

export function flowColumns(board: Board): FlowColumn[] {
  return board.columns.filter(isFlow);
}

export function isFinal(board: Board, column: string): boolean {
  const at = columnById(board, column);
  return at !== null && at.kind === "wait" && at.final;
}

export function columnTitle(board: Board, column: string): string {
  if (column === SESSIONS_VIEW) return CHATS_TITLE;
  return columnById(board, column)?.title ?? column;
}

/** Where a task stands on the drawn board: its own column where the board has it as one that holds tasks, else the intake; an older daemon's by its status. */
export function columnOn(board: Board, task: Pick<TaskSnapshot, "column" | "status">): string {
  if (typeof task.column === "string") {
    const at = columnById(board, task.column);
    return isFlow(at) ? at.id : board.intake;
  }
  const status = shownStatus(task.status);
  return columnForStatus(board, status === "needs_you" ? "running" : status);
}

/** The daemon's phase, or the one an older daemon's status implies; a phase this build has never heard of claims nothing. */
export function phaseOf(task: Pick<TaskSnapshot, "phase" | "status">): TaskPhase {
  if (task.phase !== undefined) return (PHASES as readonly string[]).includes(task.phase) ? task.phase : "waiting";
  const status = shownStatus(task.status);
  return status === "needs_you" ? "needs_you" : status === "running" ? "working" : "waiting";
}

/**
 * The daemon's status, settled again by what this client last heard of the task's own sessions (Q3.726): a session's
 * stream and the list poll are fresher than the board's read, so a turn that ended or a request that came is drawn at once.
 * Done is its person's word and only the board says it, and so is a task put back for nobody (Q3.727). An older daemon's alone.
 */
export function liveTaskStatus(task: TaskSnapshot, live: (sessionId: string) => string | null): TaskStatus {
  const said = shownStatus(task.status);
  if (said === "done" || task.sessions.length === 0) return said;
  const statuses = task.sessions.map((session) => live(session.id) ?? session.status);
  if (statuses.includes("blocked")) return "needs_you";
  if (statuses.some((status) => status === "running" || status === "starting")) return "running";
  return said === "ready" ? "ready" : "review";
}

/**
 * A configured task's phase, sessions first as the daemon's own table reads them: one blocked needs you, one working works.
 * The column never moves for it: a conversation coming back to life in Review keeps the card in Review, working.
 */
export function livePhase(task: TaskSnapshot, live: (sessionId: string) => string | null): TaskPhase {
  const said = phaseOf(task);
  const statuses = task.sessions.map((session) => live(session.id) ?? session.status);
  if (statuses.includes("blocked")) return "needs_you";
  if (statuses.some((status) => status === "running" || status === "starting")) return "working";
  return said;
}

/** One entry, its column and phase resolved on the drawn board. */
export function placeTask(
  board: Board,
  base: Pick<BoardTask, "machineId" | "machine" | "unavailable" | "configured">,
  task: TaskSnapshot,
): BoardTask {
  return { ...base, task, column: columnOn(board, task), phase: phaseOf(task) };
}

/**
 * Every task this account's machines hold or last said they held, in the order the machines are drawn, on the drawn board.
 * A task two machines hold is the copy of the greater epoch (stage 6's handoff), and a copy its own machine's tombstone names
 * as gone is not drawn at all.
 */
export function boardTasks(machines: readonly BoardMachine[], held: ReadonlyMap<MachineId, HeldBoard>, board: Board = DEFAULT_BOARD): BoardTask[] {
  const out: BoardTask[] = [];
  const at = new Map<string, number>();
  for (const machine of machines) {
    const one = held.get(machine.id);
    if (one === undefined || one.read === "absent") continue;
    // The drawn reach alone, which is held through a short drop: one failed read must not grey a board (reach.md).
    const unavailable = machine.reach === "offline";
    const gone = new Map(one.tombstones.map((stone) => [stone.id, stone.epoch]));
    for (const task of one.tasks) {
      const epoch = task.epoch ?? 0;
      const stone = gone.get(task.id);
      if (stone !== undefined && stone >= epoch) continue;
      const entry = placeTask(board, { machineId: machine.id, machine: machine.name, unavailable, configured: one.config !== null }, task);
      const seen = at.get(task.id);
      if (seen === undefined) {
        at.set(task.id, out.length);
        out.push(entry);
        continue;
      }
      const other = out[seen]!;
      if (newerCopy(entry, other)) out[seen] = entry;
    }
  }
  return out;
}

/** The greater epoch wins; of two at one epoch, one whose machine is being read wins over what an away one last said. */
function newerCopy(a: BoardTask, b: BoardTask): boolean {
  const ea = a.task.epoch ?? 0;
  const eb = b.task.epoch ?? 0;
  if (ea !== eb) return ea > eb;
  return b.unavailable && !a.unavailable;
}

/** The machine a task went to, where the machine it was on says so; null where it says nothing. */
export function followTombstone(held: ReadonlyMap<MachineId, HeldBoard>, machineId: MachineId, taskId: string): MachineId | null {
  const stone = held.get(machineId)?.tombstones.find((one) => one.id === taskId);
  return stone === undefined ? null : (stone.movedTo as MachineId);
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

/** What a press asked of a task, a column or an assignee or both, drawn until its daemon answers (Q3.728, Q3.732). */
export interface Asked {
  column?: string;
  assignee?: AskedAssignee;
  /** The machine it is moving to, as drawn: the task here is deleted once it is made there, so this answers nothing (Q3.736). */
  machine?: string;
  /** When it was asked: the change it stands for is that new, so a task let go in Done is not hidden as done long ago. */
  at: number;
}

function answers(entry: BoardTask, pressed: Asked): boolean {
  const { assignee } = pressed;
  const { task } = entry;
  if (pressed.machine !== undefined) return false;
  if (pressed.column !== undefined && pressed.column !== entry.column) return false;
  if (assignee !== undefined && (assignee.assignee !== task.assignee || assignee.agent !== task.agent || assignee.customAgent !== task.customAgent)) return false;
  return pressed.at <= task.updatedAt;
}

/**
 * The board with every phase settled by the sessions this client last heard, an older daemon's column by `liveTaskStatus`,
 * then by what a press asked for and nobody has answered yet, which wins: a card let go in a column stays there until its
 * daemon says otherwise (Q3.728). An entry nothing changed keeps its identity.
 */
export function liveBoard(
  tasks: readonly BoardTask[],
  live: (machineId: MachineId, sessionId: string) => string | null,
  asked: ReadonlyMap<string, Asked> = new Map(),
  board: Board = DEFAULT_BOARD,
): BoardTask[] {
  return tasks.map((entry) => {
    const heard = (id: string): string | null => live(entry.machineId, id);
    let settled = entry;
    if (entry.configured) {
      const phase = livePhase(entry.task, heard);
      if (phase !== entry.phase) settled = { ...entry, phase };
    } else {
      const status = liveTaskStatus(entry.task, heard);
      if (status !== shownStatus(entry.task.status)) settled = placeTask(board, entry, { ...entry.task, status });
    }
    const pressed = asked.get(taskRefKey(entry.machineId, entry.task.id));
    if (pressed === undefined || answers(entry, pressed)) return settled;
    const task: TaskSnapshot = { ...settled.task, ...pressed.assignee, updatedAt: Math.max(settled.task.updatedAt, pressed.at) };
    const moved = entry.configured && pressed.column !== undefined && pressed.column !== settled.column ? pressedInto(board, task, pressed.column) : null;
    return {
      ...settled,
      machine: pressed.machine ?? settled.machine,
      column: pressed.column ?? settled.column,
      ...(moved === null ? { task } : { task: { ...task, ...moved }, phase: moved.phase }),
    };
  });
}

/** A card let go in another column, drawn as its daemon will answer it: queued for the agent its run is for, or the column's holder. */
export function pressedInto(board: Board, task: TaskSnapshot, to: string): { column: string; phase: TaskPhase; holder: string } {
  const column = columnById(board, to);
  if (column === null || column.kind !== "work") return { column: to, phase: "waiting", holder: columnHolder(board, to) };
  const named = column.run.role === null ? null : roleByName(board, column.run.role);
  const own = task.assignee === "agent" ? (task.customAgent ?? task.agent) : null;
  const agent = column.run.role !== null ? (named?.agent ?? null) : (own ?? roleByName(board, "default")?.agent ?? null);
  return { column: to, phase: "queued", holder: agent ?? "nobody" };
}

/** Everything a drawn board shows of its tasks, as one string: a read that changed none of it redraws nothing and writes nothing. */
export function boardSignature(tasks: readonly BoardTask[]): string {
  return tasks
    .map((entry) =>
      [
        entry.machineId,
        entry.machine,
        entry.unavailable ? "1" : "0",
        entry.configured ? "1" : "0",
        entry.column,
        entry.phase,
        entry.task.id,
        entry.task.status,
        entry.task.epoch ?? 0,
        entry.task.updatedAt,
        entry.task.title,
        entry.task.holder ?? "",
        entry.task.reason ?? "",
        entry.task.waitingSince ?? "",
        (entry.task.exits ?? []).map((exit) => `${exit.name}>${exit.to}:${exit.label}`).join(","),
        entry.task.run === undefined || entry.task.run === null ? "" : `${entry.task.run.n}:${entry.task.run.state}:${entry.task.run.executor ?? ""}`,
        `${entry.task.assignee}:${entry.task.agent}:${entry.task.customAgent ?? ""}`,
        entry.task.sessions.map((session) => `${session.id}:${session.status}:${session.nickname}`).join(","),
      ].join("\u0000"),
    )
    .join("\u0001");
}

export type DoneFilter = "recent" | "all";

export interface BoardView {
  /** null is every machine: the search row's filter. */
  machine: MachineId | null;
  query: string;
  done: DoneFilter;
}

export interface TaskGroup {
  column: FlowColumn;
  tasks: BoardTask[];
}

/** The last path segment: a project is named as its folder is. */
export function projectName(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

/** Title, brief, project, agent, labels, who holds it and its sessions' nicknames, with or without the `@`. */
export function matchesTask(entry: BoardTask, needle: string): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length === 0) return true;
  const { task } = entry;
  const haystack = [
    task.title,
    task.brief,
    task.cwd,
    task.agent,
    task.holder ?? "",
    ...(task.labels ?? []),
    ...task.sessions.map((session) => `@${session.nickname}`),
  ];
  return haystack.some((field) => field.toLowerCase().includes(wanted));
}

/** The order inside a column: the newest task leads, and nothing the poll moves reorders it. */
export function columnOrder(a: BoardTask, b: BoardTask): number {
  return b.task.createdAt - a.task.createdAt || (a.task.id < b.task.id ? -1 : 1);
}

function kept(entry: BoardTask, view: BoardView, board: Board, now: number): boolean {
  if (view.machine !== null && entry.machineId !== view.machine) return false;
  if (view.done === "recent" && isFinal(board, entry.column) && now - entry.task.updatedAt > DONE_RECENT_MS) return false;
  return matchesTask(entry, view.query);
}

/** One group per column that holds tasks, every one of them, in the board's order. */
export function taskGroups(tasks: readonly BoardTask[], view: BoardView, now: number, board: Board = DEFAULT_BOARD): TaskGroup[] {
  const shown = tasks.filter((entry) => kept(entry, view, board, now));
  return flowColumns(board).map((column) => ({ column, tasks: shown.filter((entry) => entry.column === column.id).sort(columnOrder) }));
}

/** How many tasks that wait on their person a view would draw; an unavailable one still counts, since it was waiting when last heard. */
export function needingYou(tasks: readonly BoardTask[], machine: MachineId | null = null): number {
  return tasks.filter((entry) => (machine === null || entry.machineId === machine) && entry.phase === "needs_you").length;
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

/** The session a task opens to: the one waiting, else the run's, else the one working, else the newest attached; null before any start. */
export function leadSession(task: TaskSnapshot): TaskSessionRef | null {
  const sessions = task.sessions;
  const run = task.run?.session ?? null;
  return (
    sessions.find((session) => session.status === "blocked") ??
    (run === null ? undefined : sessions.find((session) => session.id === run)) ??
    sessions.find((session) => session.status === "running" || session.status === "starting") ??
    [...sessions].sort((a, b) => b.attachedAt - a.attachedAt)[0] ??
    null
  );
}

export function leadRef(entry: Pick<BoardTask, "machineId" | "task">): SessionRef | null {
  const lead = leadSession(entry.task);
  return lead === null ? null : { machineId: entry.machineId, sessionId: lead.id as SessionId };
}

/**
 * Who holds a task as the board draws it (Q3.727, Q3.732): in the intake the agent somebody named, its person or nobody, since
 * that is who its next run is; anywhere else its daemon's word, `you`, `nobody` or the executor of its run (`claude@mac`). An
 * older daemon's is read off its status: the agent working on it, else its person.
 */
export type TaskHolder =
  | { kind: "nobody" }
  | { kind: "you" }
  | { kind: "agent"; agent: string; customAgent: string | null; nickname: string | null; at?: string | null };

export function taskHolder(task: TaskSnapshot, board: Board = DEFAULT_BOARD): TaskHolder {
  const column = columnOn(board, task);
  const named: TaskHolder = { kind: "agent", agent: task.agent, customAgent: task.customAgent, nickname: null };
  if (column === board.intake && phaseOf(task) !== "working" && phaseOf(task) !== "needs_you") {
    return task.assignee === "agent" ? named : { kind: task.assignee };
  }
  const lead = leadSession(task);
  const nickname = lead?.nickname ?? null;
  if (typeof task.holder === "string") {
    if (task.holder === "you" || task.holder === "nobody") return { kind: task.holder };
    const at = task.holder.lastIndexOf("@");
    const agent = at <= 0 ? task.holder : task.holder.slice(0, at);
    // An executor names an assembled agent by its own id and a harness by the harness's.
    const assembled = lead === null && !(AGENT_IDS as readonly string[]).includes(agent) && agent !== task.agent;
    return { kind: "agent", agent: lead?.agent ?? agent, customAgent: assembled ? agent : null, nickname, at: at <= 0 ? null : task.holder.slice(at + 1) };
  }
  const status = shownStatus(task.status);
  if (status !== "running" && status !== "needs_you") return { kind: "you" };
  if (lead !== null) return { kind: "agent", agent: lead.agent, customAgent: null, nickname };
  // Started a moment ago, the conversation not listed yet: the agent it was started with; let go there to be picked, nobody yet.
  return task.assignee === "agent" ? named : { kind: "nobody" };
}

/**
 * Who a card and its assignee control name (the owner's call, 2026-10-15): the agent a working column's run is on or queued for,
 * else the task's own assignee wherever it stands, so a move never takes one away. An older daemon's is its holder.
 */
export function cardHolder(entry: Pick<BoardTask, "configured" | "task">, board: Board = DEFAULT_BOARD): TaskHolder {
  const holder = taskHolder(entry.task, board);
  if (!entry.configured) return holder;
  if (holder.kind === "agent" && columnById(board, columnOn(board, entry.task))?.kind === "work") return holder;
  const { task } = entry;
  return task.assignee === "agent" ? { kind: "agent", agent: task.agent, customAgent: task.customAgent, nickname: null } : { kind: task.assignee };
}

/** The buttons a person may press on a task now; an older daemon offers none. */
export function exitsOf(task: TaskSnapshot): TaskExitButton[] {
  return Array.isArray(task.exits) ? task.exits : [];
}

/** What a task waiting on its person is waiting for, as the Me view and the card name it. */
export type NeedKind = "question" | "stop" | "failed" | "exits" | "other";

export function needOf(entry: BoardTask, live: (machineId: MachineId, sessionId: string) => string | null): NeedKind {
  const { task } = entry;
  if (task.sessions.some((session) => (live(entry.machineId, session.id) ?? session.status) === "blocked")) return "question";
  if (exitsOf(task).length > 0) return "exits";
  if (task.run?.state === "failed") return "failed";
  // A run that ended its turn without a report: its daemon names it, and an answer continues the same run.
  if (task.run?.state === "working" || (task.run?.state === "ended" && /report/i.test(task.reason ?? ""))) return "stop";
  return "other";
}

/** A conversation no task holds: what the Chats column lists, every one of them (stage 7). */
export function chatsWithoutTask(rows: readonly SessionRow[], tasks: readonly BoardTask[]): SessionRow[] {
  const held = new Set<string>();
  for (const entry of tasks) for (const session of entry.task.sessions) held.add(`${entry.machineId}\u0000${session.id}`);
  return rows.filter((row) => !drawnInNoList(row.snapshot) && !held.has(`${row.ref.machineId}\u0000${row.ref.sessionId}`));
}

/** A task in For you: since when it has been its person's, and what it waits on them for, where it needs them. */
export interface MeRow {
  entry: BoardTask;
  since: number;
  need: NeedKind | null;
}

/** Since when a task has been its person's: its daemon's word, else when it last changed. */
export function waitingSince(entry: BoardTask): number {
  const since = entry.task.waitingSince;
  return typeof since === "number" && Number.isFinite(since) ? since : entry.task.updatedAt;
}

function sinceOrder(a: MeRow, b: MeRow): number {
  const ka = `${a.entry.machineId}/${a.entry.task.id}`;
  const kb = `${b.entry.machineId}/${b.entry.task.id}`;
  return a.since - b.since || (ka < kb ? -1 : ka > kb ? 1 : 0);
}

/**
 * The tasks their person has a part in, across every machine and column (For you): what needs them first, then what they
 * hold, each oldest first. A closed task is nobody's to act on, and a conversation is not a task (the owner's call, 2026-10-15).
 */
export function meTasks(
  tasks: readonly BoardTask[],
  board: Board,
  live: (machineId: MachineId, sessionId: string) => string | null = () => null,
): MeRow[] {
  const needs: MeRow[] = [];
  const held: MeRow[] = [];
  for (const entry of tasks) {
    if (entry.phase === "needs_you") needs.push({ entry, since: waitingSince(entry), need: needOf(entry, live) });
    else if (!isFinal(board, entry.column) && taskHolder(entry.task, board).kind === "you") held.push({ entry, since: waitingSince(entry), need: null });
  }
  return [...needs.sort(sinceOrder), ...held.sort(sinceOrder)];
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

/** One copy of the account's board, as a daemon holds it, read with this build's own parser. */
export interface HeldConfig {
  revision: number;
  hash: string;
  text: string;
  board: Board;
}

/** The account's board: of every daemon's copy, the newest by revision, a tie going to the smaller hash; none read is the default preset. */
export interface AccountBoard {
  board: Board;
  /** null where no daemon's copy has been read, and the default preset stands. */
  revision: number | null;
  hash: string | null;
  text: string;
}

export const DEFAULT_ACCOUNT_BOARD: AccountBoard = { board: DEFAULT_BOARD, revision: null, hash: null, text: DEFAULT_BOARD_TEXT };

export function accountBoard(copies: Iterable<HeldConfig>): AccountBoard {
  let best: HeldConfig | null = null;
  for (const copy of copies) if (best === null || newerBoard(copy, best)) best = copy;
  return best === null ? DEFAULT_ACCOUNT_BOARD : { board: best.board, revision: best.revision, hash: best.hash, text: best.text };
}

/** A daemon's `GET /board` answer, read with this build's parser; a board this build cannot read is no copy, and the others stand. */
export function readBoardDocument(raw: unknown): HeldConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  const { revision, hash, text } = doc;
  if (typeof revision !== "number" || !Number.isInteger(revision) || typeof hash !== "string" || typeof text !== "string") return null;
  const parsed = parseBoard(text);
  return parsed.ok ? { revision, hash, text, board: parsed.board } : null;
}

/** The board this device last drew, read back as it was written; anything else is the default preset. */
export function recallAccountBoard(raw: string | null): AccountBoard {
  if (raw === null) return DEFAULT_ACCOUNT_BOARD;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A hand-edited or cut value: the default stands until a daemon answers.
    return DEFAULT_ACCOUNT_BOARD;
  }
  const copy = readBoardDocument(parsed);
  // The text is what was hashed: a copy whose hash is not its own was edited here, and is not believed.
  if (copy === null || boardHash(copy.text) !== copy.hash) return DEFAULT_ACCOUNT_BOARD;
  return { board: copy.board, revision: copy.revision, hash: copy.hash, text: copy.text };
}

export function rememberAccountBoard(board: AccountBoard): string | null {
  if (board.revision === null || board.hash === null) return null;
  return JSON.stringify({ revision: board.revision, hash: board.hash, text: board.text });
}

const SESSION_STATUSES: readonly string[] = ["starting", "idle", "running", "blocked", "stopping", "interrupted", "parked", "exited", "failed"];
const TASK_ASSIGNEES: readonly TaskAssignee[] = ["nobody", "agent", "you"];
const RUN_STATES: readonly string[] = ["pending", "working", "ended", "failed"];

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readExits(raw: unknown): TaskExitButton[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((one): TaskExitButton[] => {
    if (typeof one !== "object" || one === null) return [];
    const exit = one as Record<string, unknown>;
    if (typeof exit["name"] !== "string" || typeof exit["to"] !== "string") return [];
    return [{ name: exit["name"], to: exit["to"], label: text(exit["label"], exit["name"]) }];
  });
}

/** The board's own fields of a row, each where the daemon sent one: an older daemon sent none, and its row stays as it was. */
function boardFields(row: Record<string, unknown>): Partial<TaskSnapshot> {
  const out: Partial<TaskSnapshot> = {};
  if (typeof row["column"] === "string") out.column = row["column"];
  // An unknown phase is kept for `phaseOf`, which reads it as waiting.
  if (typeof row["phase"] === "string") out.phase = row["phase"] as TaskPhase;
  const epoch = nullableNumber(row["epoch"]);
  if (epoch !== null) out.epoch = epoch;
  if ("waitingSince" in row) out.waitingSince = nullableNumber(row["waitingSince"]);
  if (typeof row["holder"] === "string") out.holder = row["holder"];
  if ("exits" in row) out.exits = readExits(row["exits"]);
  if ("reason" in row) out.reason = nullableText(row["reason"]);
  const budget = nullableNumber(row["budget"]);
  if (budget !== null) out.budget = budget;
  if (Array.isArray(row["labels"])) out.labels = row["labels"].filter((one): one is string => typeof one === "string");
  const run = row["run"];
  if (run === null) out.run = null;
  else if (typeof run === "object" && run !== undefined) {
    const r = run as Record<string, unknown>;
    const n = nullableNumber(r["n"]);
    if (n !== null && typeof r["column"] === "string") {
      out.run = {
        n,
        column: r["column"],
        // A state from a newer daemon is a run nobody can say is over.
        state: (RUN_STATES.includes(text(r["state"])) ? r["state"] : "working") as NonNullable<TaskSnapshot["run"]>["state"],
        executor: nullableText(r["executor"]),
        session: nullableText(r["session"]),
        startedAt: nullableNumber(r["startedAt"]),
      };
    }
  }
  const code = row["code"];
  if (code === null) out.code = null;
  else if (typeof code === "object" && code !== undefined) {
    const c = code as Record<string, unknown>;
    if (typeof c["branch"] === "string" && typeof c["holder"] === "string") out.code = { branch: c["branch"], head: nullableText(c["head"]), holder: c["holder"] };
  }
  return out;
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
    ...boardFields(row),
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

/** A daemon's tombstones, re-read; a row this build cannot hold is dropped. */
export function readTombstones(raw: unknown): TaskTombstoneView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((one): TaskTombstoneView[] => {
    if (typeof one !== "object" || one === null) return [];
    const stone = one as Record<string, unknown>;
    const epoch = nullableNumber(stone["epoch"]);
    if (typeof stone["id"] !== "string" || typeof stone["movedTo"] !== "string" || epoch === null) return [];
    return [{ id: stone["id"], epoch, movedTo: stone["movedTo"], at: nullableNumber(stone["at"]) ?? 0 }];
  });
}

/** What `GET /tasks` says of the board its daemon runs: only `board: 1` with both stamps is a configured daemon. */
export function readStamp(list: { board?: unknown; boardRevision?: unknown; boardHash?: unknown }): BoardStamp | null {
  if (list.board !== 1) return null;
  const revision = nullableNumber(list.boardRevision);
  return revision === null || typeof list.boardHash !== "string" ? null : { revision, hash: list.boardHash };
}

/** What is written down of each machine's board, so a machine that is away still shows what it held. */
export function rememberBoards(held: ReadonlyMap<MachineId, HeldBoard>): string {
  const out: Record<string, { at: number; tasks: TaskSnapshot[]; config?: BoardStamp; tombstones?: TaskTombstoneView[] }> = {};
  for (const [id, board] of held) {
    if (board.read === "absent" || (board.tasks.length === 0 && board.tombstones.length === 0)) continue;
    out[id] = {
      at: board.at,
      tasks: board.tasks.slice(0, MAX_REMEMBERED_TASKS).map((task) => ({ ...task, brief: task.brief.slice(0, REMEMBERED_BRIEF_CHARS) })),
      ...(board.config === null ? {} : { config: board.config }),
      ...(board.tombstones.length === 0 ? {} : { tombstones: board.tombstones.slice(-MAX_REMEMBERED_TOMBSTONES) }),
    };
  }
  return JSON.stringify(out);
}

/** Read back as `failed`: it is what the machine last said, and nothing has confirmed it since. An entry from before the board reads as an older daemon's. */
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
    const board = value as { at?: unknown; tasks?: unknown; config?: unknown; tombstones?: unknown } | null;
    if (board === null || typeof board !== "object") continue;
    const tasks = readTasks(board.tasks);
    const tombstones = readTombstones(board.tombstones);
    if (tasks.length === 0 && tombstones.length === 0) continue;
    const stamp = board.config as { revision?: unknown; hash?: unknown } | null | undefined;
    const config = typeof stamp === "object" && stamp !== null ? readStamp({ board: 1, boardRevision: stamp.revision, boardHash: stamp.hash }) : null;
    out.set(id as MachineId, { tasks, at: nullableNumber(board.at) ?? 0, read: "failed", daemon: null, config, tombstones });
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

export type { Board, Column, FlowColumn };
