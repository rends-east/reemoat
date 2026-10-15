// What somebody wants done on this machine, and the sessions doing it (Q2.258). Implemented in store/sqlite.ts.
import type { AskReason, Executor, LastRun, TaskCode, TaskRun, Verdict, WaitReason } from "@reemoat/board";

export const TASK_STATUSES = ["ready", "running", "needs_you", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** needs_you is never written down: the daemon answers it while a request waits in one of the task's sessions. */
export type StoredTaskStatus = Exclude<TaskStatus, "needs_you">;
export const STORED_TASK_STATUSES: readonly StoredTaskStatus[] = ["ready", "running", "review", "done"];
/** Where a create may put a task: running is a start's own (Q2.262). */
export const CREATED_TASK_STATUSES: readonly StoredTaskStatus[] = ["ready", "review", "done"];

/** Who holds a task in the backlog: nobody yet, the agent a start would launch, or its person (Q2.261, Q2.262). */
export const TASK_ASSIGNEES = ["nobody", "agent", "you"] as const;
export type TaskAssignee = (typeof TASK_ASSIGNEES)[number];

export function isTaskAssignee(value: unknown): value is TaskAssignee {
  return (TASK_ASSIGNEES as readonly unknown[]).includes(value);
}

/** Past it a create takes the place of the oldest done task, and is refused only where none is done. */
export const MAX_TASKS = 500;
export const MAX_TASK_TITLE_CHARS = 120;
/** A brief is a first prompt, so it stays well under the prompt route's own bound. */
export const MAX_TASK_BRIEF_CHARS = 16_000;
export const MAX_TASK_SUMMARY_CHARS = 2_000;
export const MAX_TASK_KEY_CHARS = 64;
/** What a board's rules match a task's `labels` fact against. */
export const MAX_TASK_LABELS = 16;
export const MAX_TASK_LABEL_CHARS = 32;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Labels as a person gave them, or null where one is not a word; absent is none. */
export function labelsOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TASK_LABELS) return null;
  const out: string[] = [];
  for (const one of value) {
    if (typeof one !== "string" || one.length > MAX_TASK_LABEL_CHARS || !LABEL.test(one)) return null;
    if (!out.includes(one)) out.push(one);
  }
  return out;
}

/** Where a task stands on its board: what the engine reads and writes, kept whole in one row (Q2.264). */
export interface TaskFlow {
  column: string;
  entry: number;
  enteredAt: number;
  /** Raised on every handoff; of two copies the higher one is the task. */
  epoch: number;
  /** Automatic moves left; null is the board's whole budget. */
  budget: number | null;
  labels: string[];
  visits: Record<string, number>;
  code: TaskCode | null;
  /** This machine's checkout of the code: one worktree per task per machine. */
  workdir: string | null;
  run: TaskRun | null;
  runs: number;
  verdicts: Verdict[];
  ask: { reason: AskReason; entry: number; at: number; detail: string } | null;
  wait: { reason: WaitReason; entry: number; since: number; detail: string } | null;
  judging: { judge: string; entry: number; since: number } | null;
  moving: { kind: "handoff" | "sync"; since: number } | null;
  from: { column: string; exit: string | null } | null;
  last: LastRun | null;
  notes: string[];
  /** The column each of its sessions last ran a run in, who ran it, and when; on every machine it has been on. */
  links: Record<string, { column: string | null; executor: Executor; at?: number }>;
  /** The project's identity, read once from its folder: what another machine's checkouts are matched by. */
  project?: string | null;
  /** A move to another machine under way: where, since when, and when it is next sent (Q2.269). */
  handoff?: { to: string; name: string; since: number; tries: number; nextAt: number; epoch: number } | null;
}

/** The four statuses an older build stored, and the default board's column each stands for. */
export const LEGACY_COLUMNS: Readonly<Record<StoredTaskStatus, string>> = { ready: "backlog", running: "running", review: "review", done: "done" };

/** A task from before the board, where it stood: in the column its status names, with no run (Q2.264). */
export function flowOf(status: StoredTaskStatus, at: number): TaskFlow {
  return {
    column: LEGACY_COLUMNS[status],
    entry: 0,
    enteredAt: at,
    epoch: 0,
    budget: null,
    labels: [],
    visits: {},
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
}

export interface TaskRecord {
  id: string;
  title: string;
  brief: string;
  /** What an older build reads: the default board's column this task's column is nearest, written on every save. */
  status: StoredTaskStatus;
  summary: string | null;
  summaryAt: number | null;
  /** The session whose agent wrote the summary; null when a person did. */
  summaryBy: string | null;
  /** What a start launches: the harness, an assembled agent's id when there is one, and the folder. */
  agent: string;
  customAgent: string | null;
  /** Who holds it in the backlog; outside it the status and the sessions say who (Q2.261, Q2.262). */
  assignee: TaskAssignee;
  cwd: string;
  /** The creating client's name for this create, so one sent twice makes one task. */
  key: string | null;
  createdAt: number;
  updatedAt: number;
  flow: TaskFlow;
}

/** One line of a task's history: what moved it, who decided, and under which board. */
export interface TaskEvent {
  seq: number;
  at: number;
  kind: TaskEventKind;
  entry: number;
  /** The board revision it happened under. */
  revision: number;
  text: string;
  column: string | null;
  to: string | null;
  exit: string | null;
  /** Who acted: auto, self, rules, a role's name, you, the board. */
  by: string | null;
  confidence: number | null;
  executor: string | null;
  session: string | null;
}

export const TASK_EVENT_KINDS = ["created", "moved", "started", "ended", "stopped", "failed", "verdict", "waiting", "asked", "note"] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** A task's history is kept to its last this many lines. */
export const MAX_TASK_EVENTS = 200;
/** And its feed to its last this many entries, which travel with it. */
export const MAX_TASK_COMMENTS = 200;
export const MAX_COMMENT_CHARS = 8_000;

export const COMMENT_KINDS = ["question", "stop", "report", "comment"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/** An entry in a task's feed. A question is a window on a request in a session, never a copy of it (Q2.265). */
export interface TaskComment {
  id: string;
  at: number;
  kind: CommentKind;
  /** you, or the session whose agent wrote it. */
  author: string;
  text: string;
  sessionId: string | null;
  request: { kind: "permission" | "elicitation"; id: string } | null;
  entry: number;
  /** A person's comment reached its agent: into a working run's session, or the run it sent the task back for. */
  delivered: boolean;
}

/** What is left here of a task that went to another machine: where it went, and this machine's checkout of its code, which it may still be asked for. */
export interface TaskTombstone {
  id: string;
  epoch: number;
  movedTo: string;
  at: number;
  workdir: string | null;
  branch: string | null;
}

/** How long a tombstone is kept for a reader to follow, and a holder to be asked for the code. */
export const TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface TaskAttachment {
  taskId: string;
  sessionId: string;
  attachedAt: number;
}

export interface TaskStore {
  list(): TaskRecord[];
  get(id: string): TaskRecord | null;
  byKey(key: string): TaskRecord | null;
  save(task: TaskRecord): void;
  /** The task and every attachment to it; its sessions are left as they are. */
  remove(id: string): void;
  attachments(): TaskAttachment[];
  /** A session works on one task: attaching it moves it. */
  attach(taskId: string, sessionId: string, at: number): void;
  detach(sessionId: string): void;
  /** Newest last, at most `MAX_TASK_EVENTS` kept. */
  events(taskId: string): TaskEvent[];
  addEvent(taskId: string, event: Omit<TaskEvent, "seq">): TaskEvent;
  comments(taskId: string): TaskComment[];
  saveComment(taskId: string, comment: TaskComment): void;
  tombstones(): TaskTombstone[];
  tombstone(stone: TaskTombstone): void;
  /** The task gone to another machine: its row, history and feed go, its sessions stay attached for when it comes back. */
  retire(id: string): void;
  forgetTombstone(id: string): void;
}

/** A board's YAML as it was written, one row per revision, the last `MAX_BOARD_REVISIONS` kept. */
export interface BoardRevision {
  revision: number;
  hash: string;
  text: string;
  at: number;
}

export const MAX_BOARD_REVISIONS = 20;

export interface BoardConfigStore {
  current(): BoardRevision | null;
  list(): BoardRevision[];
  save(revision: BoardRevision): void;
}

export class MemoryBoardConfigStore implements BoardConfigStore {
  private readonly rows: BoardRevision[] = [];

  current(): BoardRevision | null {
    return this.rows.at(-1) ?? null;
  }

  list(): BoardRevision[] {
    return [...this.rows];
  }

  save(revision: BoardRevision): void {
    const at = this.rows.findIndex((row) => row.revision === revision.revision);
    if (at >= 0) this.rows.splice(at, 1);
    this.rows.push(revision);
    this.rows.sort((a, b) => a.revision - b.revision);
    while (this.rows.length > MAX_BOARD_REVISIONS) this.rows.shift();
  }
}

/** The drivers' stand-in, and what a daemon with no database would hold. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly bySession = new Map<string, TaskAttachment>();
  private readonly history = new Map<string, TaskEvent[]>();
  private readonly feed = new Map<string, TaskComment[]>();
  private readonly stones = new Map<string, TaskTombstone>();
  private seq = 0;

  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  get(id: string): TaskRecord | null {
    return this.tasks.get(id) ?? null;
  }

  byKey(key: string): TaskRecord | null {
    for (const task of this.tasks.values()) if (task.key === key) return task;
    return null;
  }

  /** A second save replaces the row and leaves its age alone, as the upsert does. */
  save(task: TaskRecord): void {
    this.tasks.set(task.id, { ...task, createdAt: this.tasks.get(task.id)?.createdAt ?? task.createdAt });
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.history.delete(id);
    this.feed.delete(id);
    for (const [sessionId, attachment] of this.bySession) {
      if (attachment.taskId === id) this.bySession.delete(sessionId);
    }
  }

  events(taskId: string): TaskEvent[] {
    return [...(this.history.get(taskId) ?? [])];
  }

  addEvent(taskId: string, event: Omit<TaskEvent, "seq">): TaskEvent {
    const stored = { ...event, seq: ++this.seq };
    const list = this.history.get(taskId) ?? [];
    list.push(stored);
    while (list.length > MAX_TASK_EVENTS) list.shift();
    this.history.set(taskId, list);
    return stored;
  }

  comments(taskId: string): TaskComment[] {
    return [...(this.feed.get(taskId) ?? [])];
  }

  saveComment(taskId: string, comment: TaskComment): void {
    const list = (this.feed.get(taskId) ?? []).filter((one) => one.id !== comment.id);
    list.push(comment);
    list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    while (list.length > MAX_TASK_COMMENTS) list.shift();
    this.feed.set(taskId, list);
  }

  tombstones(): TaskTombstone[] {
    return [...this.stones.values()];
  }

  tombstone(stone: TaskTombstone): void {
    this.stones.set(stone.id, stone);
  }

  retire(id: string): void {
    this.tasks.delete(id);
    this.history.delete(id);
    this.feed.delete(id);
  }

  forgetTombstone(id: string): void {
    this.stones.delete(id);
  }

  attachments(): TaskAttachment[] {
    return [...this.bySession.values()].sort((a, b) => a.attachedAt - b.attachedAt);
  }

  attach(taskId: string, sessionId: string, at: number): void {
    this.bySession.set(sessionId, { taskId, sessionId, attachedAt: at });
  }

  detach(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
