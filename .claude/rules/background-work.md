---
paths:
  - packages/web/src/ui/TaskPanel.tsx
  - packages/web/src/tasks.ts
  - packages/web/src/finishedTasks.ts
  - packages/web/src/ui/tail.ts
  - packages/web/src/ui/EventList.tsx
---

# Background work

What `TaskPanel` shows and how somebody reaches it; its width, exit and drag are
`docked-panels.md`'s.

- **One surface, three doors.** `WaitingFoot` counts both sources and opens `TaskPanel` only
  while something is outstanding: `outstanding > 0` decides alone, never `retained`
  (Q3.698). The other door is the session header's kebab, at every width (`web-shell.md`,
  Q3.631). A third is the transcript's `N tasks stopped` row, always open (Q2.257). The
  foot holds no list and claims no region (`aria-haspopup="dialog"`, never
  `aria-expanded`). The panel's decisions (section order and labels, the chip table over
  five states, duration and token formatters, the four-cell meter) are pure in `tasks.ts`
  for `webcheck`. Strings and rules are Claude Code's `background-tasks-dialog`; each
  departure is a field the wire lacks, named at the code. Q3.603.
- **Two placements, one element, the breakpoint only in CSS**: a bottom sheet below `md`,
  docked right from `md` with `SessionView` taking `TASK_PANEL_GUTTER`. It portals (`fixed`
  breaks under an ancestor `transform` or `backdrop-filter`) and is `menu` in `overlay.ts`,
  never `sheet`, whose `inert` on `#root` would disable the conversation it docks beside.
- **The finished band folds and stands at zero.** `FinishedSection` is the panel's;
  `taskSections` does not emit it, so it exists with nothing finished (the owner's rule).
  `sections` counts live kinds; one `bands` count gates the headings. The band is gated on
  `reports` (a `Completed (0)` is an answer); nothing to show is a heading, never a fold. It
  is seeded closed in the section, not `TaskPanel` (rendered unconditionally), since the
  section unmounts while `!shown`. The clear hides and destroys nothing (the daemon's only
  task route is stop): `finishedTasks.ts` is an in-memory module `Map`, never
  `localStorage`, replacing rather than unioning so it stays a subset of the wire; the hidden
  set never reaches `tasks.ts`. The count is the finished rows the daemon still holds —
  capped with live rows at `MAX_TRACKED_ASYNC_TASKS`, oldest-finished first, kept across an
  agent swap and a clean restart, lost on a crash — not Claude Code's lifetime list. Q2.234.
- **A workflow's agents are not on the wire** (the adapter marks every `local_agent` task
  `ignored`): `Phases` is one phase titled `Agents`, no fraction, no rows.
- **The empty state is a three-valued partition.** `No tasks currently running` is true only
  for claude, so it is gated; `reportsBackgroundTasks: false` is two facts (`doStop` sets
  it), so `backgroundReporting` in `tasks.ts` splits it on
  `hasLiveAgent` (`stopping` excluded); a missing row lands in the arm whose sentence names
  no agent. The sentences are a `Record` over the union, swept. The finished band is barred
  there with `silent`. Q3.633. A swap passes through `unasked`; `showFinished` reading the
  rows keeps the band and its fold. Q2.234.
- **Elapsed time is `startedAt`/`endedAt`, never `usage.durationMs`** (stale or absent). The
  app's only clock-scheduled render, allowed because scoped to an opened surface.

## A subagent is background work (Q3.699)

claude backgrounds its subagents. `agentTasks` in `tail.ts` reads every delegation in the
window as a task — running, else completed, failed or stopped (`TASK_CHIPS`' words) — drawn
as an `AgentCard`: `TaskCard`'s bands, a name, its kind from `subagent_type`, its steps as
tool calls, its newest step while running. No Stop (nothing reaches a subagent). Running
ones are in `Agents`; finished ones join finished tasks in the band, newest first, under an
id no adapter mints (`agentRowId`) so one clear hides both. The foot counts `N agents`.

**What ends a detached subagent**, in `detachedEnd`'s order:

1. Its own closing step — claude's `SubagentHandback`, marked `endsDelegation` (Q6.119).
2. A step of its own still running, or detached while the daemon reports its task live
   (`liveCalls`), keeps it running past rules 3 and 4, above the floor only.
3. A turn end or agent start after its newest step: `completed` for `end_turn`, `stopped`
   otherwise.
4. Otherwise it runs while the session is `engaged` (a turn, unprompted work, a parked
   request).

Rule 2 above rule 3 is measured. `detached` is the daemon's `backgrounded`, or a step that
began after the call reported its end (an older daemon's; wrong for the second before a
first step). A finished one is timed to its last step's end, never the turn's. The
conversation's card reads the same answer through `TasksContext` (*Running in the
background*); `callStates` merges the log's answer under the daemon's, a live daemon row
outranking it.

Known wrong (Q3.699): outside auto mode there is no closing step, so a finished subagent
reads as running until its turn ends; one thinking long with the session idle reads as done
until its next step.
