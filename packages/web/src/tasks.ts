import { hasLiveAgent, taskFinished, type AsyncTaskState, type BackgroundTask, type SessionSnapshot } from "./wire";

/**
 * Everything the background-tasks panel decides, with no React in it.
 *
 * The panel itself is `ui/TaskPanel.tsx`; this is the half `webcheck` can drive.
 * The split is `permission.ts`'s and `elicitation.ts`'s, for their reason: a
 * table over five states and a formatter with carry arithmetic are exactly the
 * things a driver can sweep exhaustively, and neither needs a DOM to be wrong.
 *
 * ⚠ **Every string, label, order and rule here is Anthropic's, read out of the
 * installed `claude` binary (2.1.269) rather than invented**, because a person
 * reading this panel has almost certainly read the other one. Where this app
 * departs it is because the *wire* has no such field, and each departure is named
 * at the code rather than left to be discovered. The one word changed on purpose
 * is `terminal` → `app` in the footer sentence, which is what this is.
 */

/**
 * What one kind of background work is called, singular and plural.
 *
 * `taskType` arrives from the adapter already humanised — `local_bash` becomes
 * `shell`, `local_workflow` becomes `workflow`, `local_monitor` and `mcp` become
 * `monitor` — so this is a table over three known words and **not** a translation
 * layer: a fourth word the adapter adds later falls through to the canonical
 * fallback rather than being drawn as a raw id.
 */
export const TASK_NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  shell: ["shell", "shells"],
  monitor: ["monitor", "monitors"],
  workflow: ["background dynamic workflow", "background dynamic workflows"],
};

/**
 * What a card calls the kind of work it is — the line under the title.
 *
 * Claude Code's `defaultDescription`: the friendly type with its first letter
 * capitalised, which is why `taskType` is not an enum here either. An unknown
 * word is drawn as it arrived rather than replaced, because the adapter adding a
 * fifth kind must not make it invisible.
 */
export function taskKindLabel(taskType: string): string {
  if (taskType.length === 0) return "Task";
  return taskType.slice(0, 1).toUpperCase() + taskType.slice(1);
}

/**
 * A task's title, by kind, and the fallbacks are Claude Code's own.
 *
 * A workflow is named by `name`, which the adapter sets from the workflow
 * script's `meta.name` and only for a workflow — everything else gets `name` set
 * to its own description, so the fallback chain collapses to one answer for them.
 * A shell's description **is** its command line, recovered by the adapter from
 * the Bash tool result, which is why it leads for every other kind.
 */
export function taskTitle(task: BackgroundTask): string {
  const first = task.taskType === "workflow" ? task.name : task.description;
  const second = task.taskType === "workflow" ? task.description : task.name;
  if (first.length > 0) return first;
  if (second.length > 0) return second;
  return task.id;
}

/**
 * How long a task has been going, or how long it went.
 *
 * ⚠ **This daemon's two stamps, never `usage.durationMs`.** The adapter carries a
 * duration only inside `usage`, only on a progress frame, and drops both the
 * SDK's final `usage` and its `end_time` — so on a completed task the agent's own
 * number is stale by the whole final leg, and on a quiet one (a `sleep`, a long
 * build with no tool calls) there is no progress frame at all and therefore no
 * number. `startedAt`/`endedAt` are stamped by the daemon at the edges it sees,
 * which is the only pair that answers for both.
 *
 * A running task measures against `now`, which the panel ticks once a second —
 * the only clock-driven render in the transcript surface, `MachineInstalls` having
 * its own for install progress — and it is affordable because the panel is a
 * surface somebody opened rather than the transcript.
 */
export function taskElapsedMs(task: BackgroundTask, now: number): number {
  const end = task.endedAt ?? now;
  return Math.max(0, end - task.startedAt);
}

/**
 * A duration, in Claude Code's spaced form: `8s`, `1m 27s`, `2h 5m 3s`, `1d 4h 30m`.
 *
 * Its `Lt`, including the carry normalisation — seconds are **rounded** above a
 * minute, so 59.6s inside a 1m 59.6s total must not print `1m 60s`. Days never
 * show seconds and hours never show days, which is the rule that keeps the line
 * two facts wide at every scale.
 *
 * Deliberately not `shortDuration` from `bits.tsx`: that one is coarse on purpose
 * because it is drawn in a transcript that re-renders on every token, and `<1m`
 * for a build that has been going fifty seconds is the wrong answer on a surface
 * whose entire subject is how long something has been running.
 */
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

/**
 * A token count, in Claude Code's compact form: `999`, `8k`, `429.7k`, `1.2m`.
 *
 * Its `Un` — `Intl.NumberFormat` compact notation lowercased, one fraction digit
 * from a thousand up, with a trailing `.0` stripped. Written out rather than
 * called through `Intl` with `notation: "compact"`, because that option's output
 * is locale data: a browser shipping `429,7 tsd.` for a German locale would put a
 * comma into a number this app draws beside an English noun. The unit words here
 * are Anthropic's and the arithmetic is fixed, so the answer is the same
 * everywhere.
 */
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

/**
 * The chip a row ends in, and its colour.
 *
 * Total over the five states of {@link AsyncTaskState}, parenthesised and dim in
 * every arm: Claude Code's `Op` renders `(` + `label ?? status` + `)` and colours
 * success / error / warning for three of them, so **the distinction is a colour,
 * never a size**.
 *
 * ⚠ **The colours are this palette's, and the first version of this table shipped
 * with `text-success` and `text-warning`, which are not tokens here and emit no
 * CSS at all** — Tailwind v4 writes no rule for a utility whose variable does not
 * exist, so `(done)` and `(stopped)` were drawn in the row's ambient colour and
 * were indistinguishable from `(running)`. `add-ink` and `caution` are the two
 * this app actually has for *finished well* and *needs attention*, and `webcheck`
 * now asserts every tone here is a declared token.
 */
export const TASK_CHIPS: Readonly<Record<AsyncTaskState, readonly [string, string]>> = {
  running: ["(running)", "text-faint"],
  paused: ["(paused)", "text-faint"],
  completed: ["(done)", "text-add-ink"],
  failed: ["(error)", "text-danger"],
  stopped: ["(stopped)", "text-caution"],
};

/**
 * The panel's sections, with Claude Code's own labels — in one different order.
 *
 * ⚠ **Workflows are first, and that is the owner's call rather than theirs.**
 * Claude Code puts `Dynamic workflows` last, after shells and monitors. A
 * workflow is the one kind here that *spawns* the others — the run in the
 * screenshot this was built from is one workflow and the ten shells it started —
 * so last put the thing somebody opened the panel to look at under ten rows of
 * its own consequences. The labels, the counts and the suppression rule are still
 * theirs; only the order moved.
 *
 * `Agents` sits above these and `Completed` below them, and neither is a member:
 * `Agents` is the transcript's delegations rather than anything on this wire, and
 * `Completed` is a *state* rather than a kind, so a completed shell must not also
 * appear under `Shells`. Both are drawn by the panel around this list.
 *
 * An unknown `taskType` falls into **Shells** deliberately — it is the section for
 * *a thing the agent ran* — so a word a later adapter adds is drawable rather than
 * invisible.
 */
export const TASK_SECTIONS: readonly (readonly [string, (task: BackgroundTask) => boolean])[] = [
  ["Dynamic workflows", (task) => task.taskType === "workflow"],
  ["Shells", (task) => task.taskType !== "monitor" && task.taskType !== "workflow"],
  ["Monitors", (task) => task.taskType === "monitor"],
];

/** One cell of the four-cell meter under a phase. */
export type DotCell = "full" | "live" | "empty";

/**
 * How many cells of Claude Code's meter are filled — four, always four.
 *
 * Its `Ct`: `round(done/total * 4)` solid cells, capped one short while anything
 * is running so a live meter always carries the moving cell, and the remainder
 * empty. A `total` of zero is not a special case there and is not one here —
 * `Xe > 0 ? … : 0` is in their code — which matters because **it is the only case
 * this app ever draws**: a workflow's agents are `local_agent` tasks, and the
 * adapter marks every one of those `ignored` before publishing, so nothing on
 * this wire ever counts them. A running workflow therefore shows one moving cell
 * and three empty ones, which is exactly what "something is going and nobody is
 * telling us how far" should look like.
 */
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

/**
 * A populated section of the panel, already labelled and already ordered.
 *
 * The ordering is **not** decided here: `Session.backgroundTasks` sorts the whole
 * list running-first then newest-started-first on the daemon, and this only
 * partitions it, because two sorts of one list is how the transcript and the
 * panel come to disagree about which task is first.
 */
export interface TaskSection {
  label: string;
  tasks: readonly BackgroundTask[];
}

/**
 * The panel's body, partitioned — `Completed` last, as Claude Code has it.
 *
 * A section with nothing in it is absent rather than empty, which is their rule
 * (`items.length > 0` gates the whole group, header included).
 */
/**
 * Whether anybody has been able to ask this session about background work.
 *
 * ⭐ **Three values, because `reportsBackgroundTasks: false` is two different
 * facts and the panel was drawing the wrong one of them.** The daemon's own
 * docblock says that field means *"nobody asked"* — and it is set to `false` at
 * `doStop`, which a daemon restart reaches for every session. So after a restart,
 * with no agent yet attached, the panel said *"This agent doesn't report background
 * work"* about claude, which does. An absent answer drawn as a negative one.
 *
 * ⚠ **`hasLiveAgent` is the predicate that separates them, and it already existed
 * for exactly this question** — its own docblock: *"the statuses in which an agent
 * process exists and can be asked something … which is the question every answer
 * about the agent's controls turns on."* `stopping` is excluded there on a measured
 * argument, and inheriting that is the whole reason to reuse it rather than test
 * `isTerminal` here.
 *
 * ⚠ **A missing snapshot lands in the same arm, and the arm's sentence is worded
 * to be true of both.** `Transcript` looks its row up independently of the screen's
 * own guard, so `null` is reachable; and *we have not asked* covers a session whose
 * row has not arrived exactly as well as one with no agent. What it must never
 * become is a fourth arm saying something about an agent nothing has heard from.
 */
export type BackgroundReporting = "reports" | "silent" | "unasked";

export function backgroundReporting(snapshot: SessionSnapshot | null): BackgroundReporting {
  if (snapshot === null || !hasLiveAgent(snapshot.status)) return "unasked";
  return snapshot.reportsBackgroundTasks === true ? "reports" : "silent";
}

/**
 * What the panel says when it has nothing to list — one sentence per arm, and
 * every one of them is a different *claim*.
 *
 * `reports` is Claude Code's own string, verbatim, and it is the only one that
 * asserts a fact about the work: it is sayable only because the agent said it
 * would tell us. `silent` is sayable only about an agent that has been asked.
 * `unasked` asserts nothing about any agent, which is what makes it the honest
 * arm for both a restarted daemon and a row that has not arrived — and it answers
 * the question somebody in that state is actually holding, which is *where did my
 * finished list go*: `asyncTasks` is a `Map` in the daemon's memory with nothing
 * in SQLite, and `doStop` empties it.
 *
 * A table rather than a ternary, so `webcheck` can sweep it as a total partition
 * rather than matching the shape of an expression.
 */
export const BACKGROUND_EMPTY: Record<BackgroundReporting, string> = {
  reports: "No tasks currently running",
  silent: "This agent doesn't report background work, so nothing here can say whether any is running.",
  unasked:
    "Nothing has asked this session about background work yet. It is not kept across a restart, and an agent comes back when you send a message.",
};

/**
 * The finished band's label. The panel draws that band itself, so this is the one
 * string both sides spend rather than a second copy.
 *
 * ⚠ **`taskSections` used to push a `Completed` section and does not any more**,
 * which finally makes its own docblock's claim true: *"`Agents` sits above these
 * and `Completed` below them, and neither is a member … Both are drawn by the
 * panel around this list."* The band has to outlive the partition, because the
 * owner's rule is that it is reachable **even when there is nothing** — and a
 * function that returns sections for what exists cannot return one for what does
 * not. So `sections` means *how many live kinds*, which is all it was ever read
 * for, and the band is the panel's.
 *
 * ⚠ **What the count can and cannot mean.** Claude Code's own dialog shows
 * `Finished 130`, which is the CLI's lifetime list for a run. This is how many
 * finished rows the *daemon* is still holding for this session — capped at
 * `MAX_TRACKED_ASYNC_TASKS` with live rows, lossy oldest-finished-first
 * (`evictFinishedTask` gives one up rather than refusing a new live task), emptied
 * by the agent's own `/clear`, and gone entirely on a daemon restart, `asyncTasks`
 * being a `Map` with nothing in SQLite. So it says *this many finished runs are
 * still on record*, and a reader arriving from Claude Code will read it as *this
 * many finished*. Raising the cap is a wire decision rather than a client one: 32
 * tasks is already around 93 KB per snapshot.
 */
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
