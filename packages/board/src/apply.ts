// What a step, a report and a verdict do to the task's record: the daemon and the simulator apply the same functions.
import { columnById, type Board } from "./config.js";
import type { Actor, BoardTask, Executor, Step, TaskRun, Verdict } from "./engine.js";

/** As much of a comment as a wake keeps for its judges. */
export const MAX_WAKE_TEXT_CHARS = 8_000;

export interface Started {
  session: string;
  /** Turns the session had ended before the run's message. */
  startSeq: number;
  logFrom: number;
  startHead: string | null;
}

export function pendingRun(n: number, column: string): TaskRun {
  return {
    n,
    column,
    state: "pending",
    executor: null,
    session: null,
    startedAt: null,
    startSeq: 0,
    logFrom: 0,
    startHead: null,
    reported: false,
    outcome: null,
    report: null,
    stoppedAt: null,
    endedAt: null,
    diff: null,
  };
}

/** Whether a move by this actor spends the budget: everything but a person and the board itself does. */
export function spends(by: Actor): boolean {
  return by.kind !== "human" && by.kind !== "config";
}

/** Into a column: a new entry, and a pending run where the column works. A person's move gives the budget back. */
export function moveTask(task: BoardTask, board: Board, to: string, exit: string | null, by: Actor, now: number): BoardTask {
  const target = columnById(board, to);
  const entry = task.entry + 1;
  return {
    ...task,
    column: to,
    entry,
    enteredAt: now,
    visits: { ...task.visits, [to]: (task.visits[to] ?? 0) + 1 },
    from: { column: task.column, exit },
    run: target !== null && target.kind === "work" ? pendingRun(entry, to) : null,
    verdicts: [],
    ask: null,
    wait: null,
    judging: null,
    moving: null,
    woken: null,
    budget: by.kind === "human" ? board.budget : spends(by) ? Math.max(0, task.budget - 1) : task.budget,
  };
}

export function applyStep(task: BoardTask, board: Board, step: Step, now: number, started: Started | null = null): BoardTask {
  switch (step.kind) {
    case "nothing":
      return task;
    case "wait": {
      const same = task.wait !== null && task.wait.reason === step.reason && task.wait.entry === task.entry;
      // A run that waits is past what was asked before it, an agent named at last; a sticky ask never reaches here.
      return { ...task, wait: { reason: step.reason, entry: task.entry, since: same ? task.wait!.since : now, detail: step.detail }, ask: null, moving: null };
    }
    case "handoff":
      return { ...task, moving: { kind: "handoff", since: now } };
    case "sync":
      return { ...task, moving: { kind: "sync", since: now } };
    case "start": {
      if (task.run === null || started === null) return task;
      const executor: Executor = step.executor;
      const link = { id: started.session, column: task.run.column, executor, attachedAt: now };
      return {
        ...task,
        run: {
          ...task.run,
          state: "working",
          executor,
          session: started.session,
          startedAt: now,
          startSeq: started.startSeq,
          logFrom: started.logFrom,
          startHead: started.startHead,
        },
        runs: task.runs + 1,
        sessions: task.sessions.some((one) => one.id === started.session)
          ? task.sessions.map((one) => (one.id === started.session ? link : one))
          : [...task.sessions, link],
        wait: null,
        ask: null,
        moving: null,
        notes: [],
      };
    }
    case "end": {
      if (task.run === null) return task;
      const run: TaskRun = { ...task.run, state: "ended", endedAt: now };
      return {
        ...task,
        run,
        ask: null,
        last: {
          column: run.column,
          outcome: run.outcome,
          report: run.report,
          diff: run.diff,
          agent: run.executor?.agent ?? null,
          message: null,
          range: run.startHead !== null && task.code?.head != null ? { from: run.startHead, to: task.code.head } : null,
        },
      };
    }
    case "judge":
      return { ...task, judging: { judge: step.judge, entry: task.entry, since: now, ...(step.wake === undefined ? {} : { wake: step.wake }) } };
    case "move":
      return moveTask(task, board, step.to, step.exit, step.by, now);
    case "stay":
      return { ...task, woken: null };
    case "ask": {
      let run = task.run;
      // A code_dirty run never started; failed, it is what the task's page offers Retry on, which moves it in again.
      if (run !== null && (step.reason === "run_failed" || step.reason === "code_dirty")) run = { ...run, state: "failed", endedAt: now };
      if (run !== null && step.reason === "no_report" && step.turn !== undefined) run = { ...run, stoppedAt: step.turn };
      return { ...task, run, ask: { reason: step.reason, entry: task.entry, at: now, detail: step.detail }, wait: null, moving: null };
    }
  }
}

/** A task_update from the run's own agent; one from an earlier run's session is late and changes nothing. */
export function withReport(
  task: BoardTask,
  report: { session: string; summary: string | null; outcome: string | null; review: boolean },
): BoardTask {
  const run = task.run;
  if (run === null || run.state !== "working" || run.session !== report.session) return task;
  return {
    ...task,
    run: {
      ...run,
      reported: run.reported || report.outcome !== null || report.review,
      outcome: report.outcome ?? run.outcome,
      report: report.summary ?? run.report,
    },
  };
}

/** A role's answer, kept for its entry and its comment; one for an entry the task has left, or a comment already settled, is late. */
export function withVerdict(task: BoardTask, verdict: Verdict): BoardTask {
  if (verdict.entry !== task.entry) return task;
  if (verdict.wake !== undefined && verdict.wake !== task.woken?.comment) return task;
  const same = (one: { judge: string; wake?: string }): boolean => one.judge === verdict.judge && one.wake === verdict.wake;
  return {
    ...task,
    verdicts: [...task.verdicts.filter((one) => !same(one)), verdict],
    judging: task.judging !== null && same(task.judging) ? null : task.judging,
  };
}

/** A person's comment, for the column's wake to send the task by (Q2.279). */
export function withWake(task: BoardTask, comment: { id: string; text: string }, now: number): BoardTask {
  return { ...task, woken: { comment: comment.id, text: comment.text.slice(0, MAX_WAKE_TEXT_CHARS), entry: task.entry, at: now } };
}

/** A person acted on the task: the budget is whole again, and a stop for want of them is theirs to have answered. */
export function humanActed(task: BoardTask, board: Board): BoardTask {
  const ask = task.ask !== null && (task.ask.reason === "budget" || task.ask.reason === "no_report") ? null : task.ask;
  return { ...task, budget: board.budget, ask };
}
