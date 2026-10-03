---
paths:
  - packages/web/src/ui/TaskPanel.tsx
  - packages/web/src/tasks.ts
  - packages/web/src/finishedTasks.ts
  - packages/web/src/ui/tail.ts
  - packages/web/src/ui/EventList.tsx
---

# Background work: what runs behind a turn, and the one surface that shows it

**Moved out of `web-transcript.md`, which had no characters left, and widened by
subagents in the same change.** The panel's width, its exit and its drag are
`docked-panels.md`'s; this file is what it *shows* and how somebody gets to it.

- **Background work is drawn on one surface, and there are two ways in.**
  `WaitingFoot` counts both sources and opens `TaskPanel` — but it is a door only
  while something is **outstanding**, so the moment the last task ended the record
  the panel keeps became unreachable. The session header's kebab is the other door
  and is why that kebab now exists at every width: `Background tasks` is on no rail
  row, unlike every other row in it. Q3.631. ⚠ **The working line is not a button
  over rows that have finished**: `retained`, the count of every row the panel holds,
  made `working…` pressable for ever after one backgrounded build, opening a panel
  with nothing running in it. `outstanding > 0` decides it alone. Q3.698.
  It holds no list of its own and claims no region under it
  (`aria-haspopup="dialog"`, never `aria-expanded`). The panel's own decisions —
  the section order and labels, the chip table over the five states, the duration
  and token formatters, the four-cell meter — are `tasks.ts`, so `webcheck` drives
  them with no DOM. Every string and rule there is Claude Code's
  `background-tasks-dialog`, read out of the installed binary; **where this app
  departs it is because the wire has no such field**, and each departure is named
  at the code. Q3.603.
  - **Two placements, one element, and the breakpoint is answered only in CSS.**
    A bottom sheet below `md`, docked right from `md` with `SessionView` taking
    `TASK_PANEL_GUTTER` — `calc` of the same custom property the panel's own width
    is, so the two cannot drift and neither is a literal a reader can drag away
    from. **It is resizable there, on the rail's own separator**; the widths, the
    exit animation and every measurement behind both are `docked-panels.md`. It
    **portals** — `fixed` only means the viewport where no ancestor carries a
    `transform` or `backdrop-filter`, and the header and composer here are one hop
    from one — and it is **`menu`** in `overlay.ts`, never `sheet`: `sheet` puts
    `inert` on `#root`, which from `md` would switch off the conversation it is
    docked *beside*, and making that conditional is breakpoint state in
    JavaScript.
  - **The finished band folds, and it stands at zero.** `taskSections` moved a
    completed row to `Completed` all along — but a section is named only when
    something else is populated, so one workflow finishing alone kept its card in
    place at the same size with only its chip changed, and nothing said the word.
    `FinishedSection` is that band, and **`taskSections` no longer emits it** —
    the owner's rule is that Finished is reachable even when nothing exists, and a
    function returning a section per thing that exists cannot return one for a
    thing that does not. So `sections` means *how many live kinds* and the band is
    the panel's, which is what that function's docblock always claimed. One `bands`
    count replaced the two `sections.length` proxies the headings were gated on, or
    a lone live kind would have lost its label in silence. ⚠ **The band is gated on
    `reports`**: `Completed (0)` is a count, and a count of finished work is an
    *answer* — on the three agents that report no lifecycle it would assert exactly
    what the sentence beside it disclaims. And nothing to show is a **heading, not
    a fold**: a disclosure over an empty body is a control that lies, which was
    already reachable by clearing the list. It is seeded closed **in the section
    rather than in `TaskPanel`**, because the panel renders nothing while `!shown` and everything
    below it unmounts on every close — which is the whole of "collapsed by default"
    with no state to store — while `TaskPanel` itself is rendered unconditionally
    and would keep it. The clear **hides, and destroys nothing**: the daemon has one
    background-task route and it is *stop*; it keeps terminal rows on purpose so
    this panel can answer *did that build finish*. So `finishedTasks.ts` is a module
    `Map` in memory, never `localStorage` — it is a claim about rows on a remote
    machine, and a crash, the agent's `/clear` and eviction at the cap each
    destroy those with nothing to tell the browser. It **replaces** rather than
    unions, which is the prune that keeps it a subset of the wire. And the hidden
    set never reaches `tasks.ts`: pushed in there the band would vanish when
    emptied, which is the owner's rule reversed by a change that reads as a
    simplification. ⚠ **The count is not Claude Code's.** Theirs is a lifetime list;
    ours is how many finished rows the daemon still holds — capped with live rows at
    `MAX_TRACKED_ASYNC_TASKS`, lossy oldest-finished-first, kept across an agent
    swap and a clean restart, and gone on a crash. Q2.234.
  - **⚠ A workflow's agents are not on this wire and the panel says nothing about
    them.** The adapter marks every `local_agent` task `ignored` before publishing,
    and no payload carries a phase, a fraction, a model or a count. So `Phases` is
    one phase titled `Agents` — Claude Code's own fallback — with no fraction
    (their rule for a zero total) and **no rows**. An empty table under a heading
    would be a claim about ten agents that are running.
  - **⚠ The empty state is a three-valued partition, and it was a boolean.**
    `No tasks currently running` is true for claude and false for the other three,
    so it is gated — but `reportsBackgroundTasks: false` is **two** facts. The
    daemon's own docblock calls it *"nobody asked"*, and `doStop` sets it, which a
    restart reaches for every session. So with no agent attached the panel asserted
    *"This agent doesn't report background work"* about claude. `backgroundReporting`
    in `tasks.ts` splits it on `hasLiveAgent` — the predicate that already existed
    for *"the statuses in which an agent process exists and can be asked
    something"*, `stopping` excluded on a measured argument — and a missing row
    lands in the same arm, whose sentence is worded to be true of both and to name
    no agent at all. The sentences are a `Record` over the union, so a fourth state
    is a compile error and the partition is swept rather than the shape of an
    expression. The finished band is barred there with `silent`, for one reason:
    the daemon's rows are gone after a crash or on an older daemon, so a zero would
    say *nothing finished* about a session that may have finished ten things.
    Q3.633. ⚠ A swap passes through `unasked`; `showFinished` reading the rows is
    what keeps the band and its fold. Q2.234.
  - **⚠ Elapsed time comes from `startedAt`/`endedAt`, never `usage.durationMs`.**
    The agent's duration rides a *progress* frame and the adapter drops both the
    final `usage` and `end_time`, so a finished task's own number is stale and a
    quiet one has none. This is also the one place in this app that schedules a
    render for a clock, and it is affordable only because it is scoped to a
    surface somebody opened.

## A subagent is background work (Q3.699)

**claude backgrounds its subagents now**, so the `Agents` band was dead on the
harness it was built for: the spawn answers `Async agent launched` in a second and
the agent goes on under a call that has completed. `agentTasks` in `tail.ts` reads
every delegation in the window as a task, running or else completed, failed or
stopped (`TASK_CHIPS`' own words), and the panel draws each as an `AgentCard` —
`TaskCard`'s bands, a name rather than a command, its kind from the call's own
`subagent_type`, its steps as tool calls, its newest step while it runs. **No
Stop**: nothing on the wire reaches a subagent. A running one is in `Agents`, a
finished one in the finished band beside finished tasks, newest first, under an id
no adapter mints (`agentRowId`) so one clear hides both kinds. The foot counts them
as `N agents`.

**What ends a detached subagent, since nothing on the wire says so**, in
`detachedEnd`'s order, which is the rule:

1. **Its own closing step** — claude's `SubagentHandback`, marked by the daemon as
   `endsDelegation` (Q6.119) — ends it there.
2. **A step of its own still running**, or one detached while the daemon reports
   its task live (`liveCalls`), keeps it running past everything below, above the
   floor only: a step a cancel stranded never reports its end.
3. **A turn end or an agent start after its newest step** ends it, `completed` for
   `end_turn` and `stopped` otherwise. claude holds the turn that spawned it open
   until it finishes, which makes this usually exact.
4. **Otherwise it runs while the session is `engaged`** — a turn, work nobody
   prompted, a parked request — and is over when none is.

⚠ **Rule 2 above rule 3 is a measurement, not a preference**: claude ended a turn
with its subagent waiting on a shell of its own, then woke it outside any turn.
⚠ **`detached` is the daemon's `backgrounded`, or a step that began after the call
reported its end** — the second half is an older daemon's, and it is wrong for the
second or so before a subagent's first step. A finished one is timed to its last
step's end, never to the turn's.

**The conversation's card reads the same answer** through `TasksContext`, so a
detached subagent's row says *Running in the background* rather than drawing a check
mark beside the second its launch took — `callStates` merges the log's answer under
the daemon's, a live row of the daemon's outranking it.

**What it still gets wrong, said out loud.** Outside auto mode there is no closing
step, so a finished subagent reads as running until its turn ends while the main
agent works on; and one that thinks for a long time with the session idle reads as
done until its next step lands. Both are Q3.699's.
