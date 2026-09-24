import { hasLiveAgent, taskFinished, type AsyncTaskState, type BackgroundTask, type SessionSnapshot } from "./wire";

/** Keyed by the adapter's already-humanised `taskType`; an unknown word falls through to the caller's fallback. */
export const TASK_NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  shell: ["shell", "shells"],
  monitor: ["monitor", "monitors"],
  workflow: ["background dynamic workflow", "background dynamic workflows"],
};

export function taskKindLabel(taskType: string): string {
  if (taskType.length === 0) return "Task";
  return taskType.slice(0, 1).toUpperCase() + taskType.slice(1);
}

export function taskTitle(task: BackgroundTask): string {
  const first = task.taskType === "workflow" ? task.name : task.description;
  const second = task.taskType === "workflow" ? task.description : task.name;
  if (first.length > 0) return first;
  if (second.length > 0) return second;
  return task.id;
}

/** The daemon's two stamps, never `usage.durationMs`, which is stale on a finished task and absent on a quiet one. */
export function taskElapsedMs(task: BackgroundTask, now: number): number {
  const end = task.endedAt ?? now;
  return Math.max(0, end - task.startedAt);
}

/** Claude Code's spaced form (`8s`, `1m 27s`, `1d 4h 30m`); seconds round above a minute and carry upward. */
export function taskDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const days = Math.floor(ms / 86_400_000);
  let hours = Math.floor((ms % 86_400_000) / 3_600_000);
  let minutes = Math.floor((ms % 3_600_000) / 60_000);
  let seconds = Math.round((ms % 60_000) / 1000);
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes === 60) {
    minutes = 0;
    hours += 1;
  }
  if (hours === 24) {
    hours = 0;
    return `${days + 1}d 0h 0m`;
  }
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Claude Code's compact form (`8k`, `429.7k`, `1.2m`), written out because `Intl` compact notation is locale data. */
export function taskTokens(total: number): string {
  const round = (value: number): string => {
    const fixed = value.toFixed(1);
    return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
  };
  if (total < 1_000) return `${Math.max(0, Math.round(total))}`;
  if (total < 1_000_000) return `${round(total / 1_000)}k`;
  if (total < 1_000_000_000) return `${round(total / 1_000_000)}m`;
  return `${round(total / 1_000_000_000)}b`;
}

/** Every tone must be a token this palette declares: an undeclared utility emits no CSS (webcheck asserts it). */
export const TASK_CHIPS: Readonly<Record<AsyncTaskState, readonly [string, string]>> = {
  running: ["(running)", "text-faint"],
  paused: ["(paused)", "text-faint"],
  completed: ["(done)", "text-add-ink"],
  failed: ["(error)", "text-danger"],
  stopped: ["(stopped)", "text-caution"],
};

/** Workflows lead by the owner's choice; an unknown `taskType` falls into Shells so it stays visible. */
export const TASK_SECTIONS: readonly (readonly [string, (task: BackgroundTask) => boolean])[] = [
  ["Dynamic workflows", (task) => task.taskType === "workflow"],
  ["Shells", (task) => task.taskType !== "monitor" && task.taskType !== "workflow"],
  ["Monitors", (task) => task.taskType === "monitor"],
];

/** One cell of the four-cell meter under a phase. */
export type DotCell = "full" | "live" | "empty";

export const TASK_DOTS = 4;

export function dotCells(done: number, total: number, running: boolean): readonly DotCell[] {
  const scaled = total > 0 ? Math.round((done / total) * TASK_DOTS) : 0;
  const full = Math.min(running ? TASK_DOTS - 1 : TASK_DOTS, Math.max(0, scaled));
  const live = running ? Math.min(TASK_DOTS - full, 1) : 0;
  const cells: DotCell[] = [];
  for (let index = 0; index < TASK_DOTS; index += 1) {
    cells.push(index < full ? "full" : index < full + live ? "live" : "empty");
  }
  return cells;
}

/** Already ordered by the daemon (`Session.backgroundTasks`); this only partitions, so the panel and transcript agree. */
export interface TaskSection {
  label: string;
  tasks: readonly BackgroundTask[];
}

/** Without a live agent the answer is `unasked`: `reportsBackgroundTasks` is false both when unasked and after a restart. */
export type BackgroundReporting = "reports" | "silent" | "unasked";

export function backgroundReporting(snapshot: SessionSnapshot | null): BackgroundReporting {
  if (snapshot === null || !hasLiveAgent(snapshot.status)) return "unasked";
  return snapshot.reportsBackgroundTasks === true ? "reports" : "silent";
}

export const BACKGROUND_EMPTY: Record<BackgroundReporting, string> = {
  reports: "No tasks currently running",
  silent: "This agent doesn't report background work, so nothing here can say whether any is running.",
  unasked:
    "Nothing has asked this session about background work yet. It is not kept across a restart, and an agent comes back when you send a message.",
};

/** The finished band's label; the panel draws that band itself, so taskSections returns live kinds only. */
export const FINISHED_LABEL = "Completed";

export function taskSections(background: readonly BackgroundTask[]): readonly TaskSection[] {
  const live = background.filter((task) => !taskFinished(task.state));
  const sections: TaskSection[] = [];
  for (const [label, holds] of TASK_SECTIONS) {
    const tasks = live.filter(holds);
    if (tasks.length > 0) sections.push({ label, tasks });
  }
  return sections;
}
