// What somebody wants done on this machine, and the sessions doing it (Q2.258). Implemented in store/sqlite.ts.

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

export interface TaskRecord {
  id: string;
  title: string;
  brief: string;
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
}

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
}

/** The drivers' stand-in, and what a daemon with no database would hold. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly bySession = new Map<string, TaskAttachment>();

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
    for (const [sessionId, attachment] of this.bySession) {
      if (attachment.taskId === id) this.bySession.delete(sessionId);
    }
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
