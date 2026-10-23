---
paths:
  - src/tasks/**
  - src/peers/mcp.ts
  - scripts/daemoncheck.tasks.ts
  - packages/web/src/board.ts
  - packages/web/src/boardStore.ts
  - packages/web/src/dispatch.ts
  - packages/web/src/ui/board/**
  - packages/web/src/ui/settings/DispatchSetting.tsx
  - packages/web/src/ui/groups.ts
  - packages/web/scripts/webcheck.board.ts
---

# Tasks, the board, and the dispatcher

A task is what somebody wants done on one machine, and the sessions doing it. Q2.258 to
Q2.262 are the daemon's half, Q3.719 to Q3.737 the client's, Q7.162 what is not built;
the board and a task's files are `board-engine.md` and Q3.739 to Q3.744.
`web-shell.md` owns the list as a layout and `machine-gestures.md` its pager;
`agent-messaging.md` owns the `reemoat` server these tools are served on.

## The daemon

**A task is a row on its owner's machine, standing in a column of the account's board**
(`board-engine.md`). What a reader is shown is read, never written: `phase`, and the
old `status` by the phase table for a client from before the board. Q2.258, Q2.264.

- **`needs_you` is not storable**: `PATCH` answers `400 status_not_settable`, and
  `task_update` refuses it in words. A status from an older client is a move to the
  column it stands for (`columnForStatus`), refused `409 task_working` while the agent
  works, except to a final column.
- **Starting is `POST /sessions`' own launch**, made by the engine: a start is a person's
  move into the first work column, and `TaskDesk.startNow` waits for its run.
  `launchRefused` answers a refusal as the session route does; a refused create leaves
  no task, so the same request again is the retry.
- **A create carries a key** (`TASK_KEY`): a second one under a key a task holds answers
  that task with `existing: true`. A proposal's id is its key.
- **`PATCH` takes the assignee and the folder** (`agent`, `customAgent`, `cwd`), weighed
  by `launchSpecOf` as a start is: who the next start launches. Sessions on the task keep
  their own agent. Q3.725. **A start that names either writes it to the task** (Q2.260).
- **`assignee` says who holds a backlog task** (Q2.261, Q2.262): `nobody`, `agent` or
  `you`, stored as `TASK_ASSIGNEES`' index in the `assigned` column. A create is the agent's
  unless it names another, and may name a `status` (`CREATED_TASK_STATUSES`, never beside
  `start`); naming an agent in `PATCH` assigns it and moves nothing; a start assigns it.
- **A session works on one task**: `task_sessions` is keyed on the session, so an attach
  moves it. Deleting a task leaves its sessions. `sweep()` runs once after `restore()`.
- **No `SCHEMA_VERSION` bump**: two new tables, `CREATE TABLE IF NOT EXISTS`, and
  `assigned` added by `migrate()` with `DEFAULT 0`, so an older task reads as nobody's.
- Nothing in `registry.ts` knows a task but `proposeTasks`, which appends the card.

## The tools (Q2.259, Q2.268)

`list_projects`, `list_tasks`, `propose_tasks`, `task_update`, and the board's own
(`board_get`, `board_check`, `board_simulate`, `board_propose`, `board_guide`), in `src/tasks/tools.ts`
(pure: definitions, parsing, wording), answered by `callTaskTool`.

- **Served whatever messaging says** (`PeerHub.serveTasks`; `callTool` answers them
  before `callRefusal`). Only what crosses machines answers to a switch: `linksFor` is
  `list_agents`' gates read live, and `GET /peer/tasks`, `GET /peer/projects` refuse as
  `GET /peer/agents` does (`boardRefused`).
- **Those two routes answer paths**, where `list_agents` shows a folder's name: a
  proposal for another machine names the `cwd` its press sends. Stated in Q2.259.
- **No tool creates or starts anything; one applies**, the config agent's `board_apply`
  (`board-engine.md`). `propose_tasks` appends `tasks_proposed`, `board_propose`
  `board_proposed`; the press is the client's. Agents elsewhere: Q7.151.
- **`task_update` reaches the caller's own task and no other** (`taskOf`): `running` or
  `review`, and an `outcome` checked against the column's exits; `done` is its person's,
  refused in words with nothing written (Q2.260). Its answer says the task reads running *while the agent works*: told only the
  shown status, claude reported the write as failed.
- **`list_tasks` prints a backlog task nobody holds as `not assigned`**, its person's as
  `your user`; another machine's row that says nothing of it reads as nobody's.
- **A card is refused whole, never clipped**: `MAX_PROPOSALS_PER_CALL`,
  `MAX_PROPOSAL_CHARS_PER_CALL` (under the 128 KiB event with room), an unknown or
  silent machine, an agent that machine does not offer. `truncateEvent` passes the
  event through; both event switches have its arm.
- **Another machine's rows are re-read one by one** (`remoteTasksOf`,
  `remoteProjectsOf`): a row this build cannot hold is dropped, an unknown status is
  printed as it came. A bare 404 is "too old for tasks", never an error. Cached
  `REMOTE_BOARD_TTL_MS`, as `list_agents` is.
- **claude runs them all without asking** (`CLAUDE_ALLOWED_TOOLS`, pinned by value in
  `daemoncheck`). The other harnesses ask.
- **The dispatcher is a session** nicknamed `DISPATCH_NICKNAME`; the server's
  instructions are per caller, so it alone is sent `DISPATCH_INSTRUCTIONS`. No other
  daemon code path knows it, and the client draws it nowhere now (Q3.735).

## The client

**The board is the pager's first page, where All stood** (Q3.724). `BOARD` is its tab
(`boardTab`, a stored `all` reads as it); on it the scroller and a neighbour's page
(`BesidePanes`) draw `TaskListBody`: every machine's tasks by the board's columns, on the session
list's own row budget, every group once any task is drawn. A machine's page holds its
conversations alone. There is no mode and no switch: `ListMode` and `ModeSwitch` are gone, and so is
All's flat list. Nothing in `machineSwipe.ts` or `tabPill.ts` may learn of the board.

- **The board's tab counts tasks waiting** (`useBoardWaiting`). At lg its column entry
  goes home from any screen, and so does the chevron of a screen opened from the board,
  drawn at lg too (`Header`'s `board`, `boardSelected`; Q3.734). A task's page opened from
  a conversation leads back to it (`originFor`, `Header`'s `back`; Q3.736).
- **A line opens the conversation doing it** (`leadRef`), else the task's page. The
  intake and the closing columns start folded (`foldedFirst`). A working task's mark breathes here and above a conversation, never on the
  board (`still`). Q3.733.
- **`j`/`k` walk nothing on the board's page** (`visibleRows` answers `[]`). One search
  field, which names what it searches; the board pane adds one by title (Q3.748).
- **A waiting task says so in place**: weight and the blocked dot (`TaskMark`), as a
  waiting session does. A row is one button; nothing mounts into it.
- **`ui/board/useBoard.ts`, `Proposals.tsx`, `Pickers.tsx` and `assignees.ts` import no
  router**, statically: `EventList` draws the card and `webcheck` imports the transcript
  with no address bar. The card reaches `./actions` by `import()` on a press.
- **Nothing in a settings file calls `machineDisplayName`**; `DispatchSetting` lists
  machines by their own names.

**The client gathers tasks itself** (`boardStore.ts`; every rule is a pure function in
`board.ts`, which `webcheck` imports).

- One `GET /tasks` per machine drawn `online`: `BOARD_WATCH_MS` while a task is drawn
  (`useBoardWatch`), `BOARD_IDLE_MS` otherwise, never while the page is hidden.
- **An older daemon is skipped silently**: `meansRouteAbsent` files it `absent`, and
  `boardDue` asks again only when its `health.instanceId` changes, or after
  `BOARD_ABSENT_MS` where it names none. `supported` gates **Attach to task** and which
  machines can take one.
- **`unavailable` is the drawn reach alone** (`offline`), never one failed read:
  `reach.md`'s quiet window would otherwise flicker every board.
- **Remembered in `localStorage`** (`rememberBoards`, `recallBoards`): bounded, briefs
  cut, an `absent` or empty board not written, read back as `failed`.
- **A status is as fresh as its sessions** (Q3.726): `liveTaskStatus` settles the
  daemon's by what this client last heard of the task's sessions, and every list, card
  and band draws `useLiveTasks`. Done only the board says. A session of a task changing
  status asks its board again (`sessionsKey`), and so does an open conversation finishing
  a `task_update` (`updatesTask`, `TaskBand`). `shownStatus` maps an unknown one to
  `review`.
- **A proposal's row is settled by the board** (`taskOfProposal`), never by component
  state, so another device agrees.

**Columns are the account's board** (Q3.740): the newest any `board: 1` daemon holds
(`accountBoard`, by `newerBoard`), read with this build's own `parseBoard`; before any is
read, the one this device last drew. A task stands in `columnOn`: its daemon's column,
the intake for a column the board lacks, and for a daemon without `board: 1` the column
its status stands for (`columnForStatus`). Copies merge by `(id, epoch)` and a tombstone
hides its machine's copy (`boardTasks`, `followTombstone`). Conversations stay in the
list: the board draws no view column (`flowColumns`). The pane switches between the board
and *For you* (`MeBody`): one list of the tasks its person has a part in (Q3.739). A
drop is a move with `from`; `409 task_working` offers *Stop and move*.

- **Picking an agent or You names it and moves nothing** (`assignTask`); on an older
  daemon outside the backlog an agent starts, nobody puts it back, You takes it for review.
  Not assigned and You are in every assignee control, Not assigned the default of New task
  and a proposal row. **A start opens the conversation it made** (`openStarted`, Q3.737).
  While an agent works the assignee is locked and Status offers Done alone.
- **A press is drawn at once** (`board.hold`, `liveBoard`'s `asked`: a status, an assignee,
  the machine it moves to) and held until its answer, as new as the press; a refusal
  releases it. A card let go in a working column is queued for its run's agent
  (`pressedInto`).
- **A card names the task's assignee in every column** (`cardHolder`; the run's agent where
  one works or is queued), pressed anywhere but while it works. `taskHolder` is who it
  waits on, For you's and the Holder row's.

**A task opens as its own page** (Q3.725), `TaskScreen` at `/m/:machine/t/:task`, a
tracker's ticket: title and description edited in place, actions above them, history and
activity folded, every comment last (Q3.741), and one `Group` of properties:
Status, Assignee, Project, created, updated; Start once an agent is assigned. No crumb.
`TaskBand` sits above a task's conversation and outside its scroller, and leads to the
page. `/task/new` is a sheet, `/task/new/in/:column` a column's + (`newTaskInPath`), so
`task` is in `isOverlayPath`.

- **The assignee is a machine and an agent in one choice** (`AssigneeDropdown`): every
  machine that can take a task (`takingMachines`), each a group of what New session would
  offer there (`useRosters`: `orderStrip`, `startableHere`, `!hidden`). One control in
  form, page and proposal row.
- **Another machine moves a task nobody started** (`moveTask`): created there under its
  key, then deleted here; the folder by `folderOn`. A task with a conversation offers its
  own machine only.

**The board** (Q3.721) is `HomePane` at lg while the board is the list's page: the
list's own view drawn again, with no state but a press's wait, a pick, a landing and that search.
Imported with the shell, never lazy (Q3.729). Lanes of their own colour, never `bg-chip`, each a fixed
width (`w-76`) with a + making a task in it. A card is one
height: the title on one line with its age beside it, the
holder's round mark (`HolderAvatar`) and name, and under the name the machine, small,
only when somebody holds it; no mark moves (Q3.731, Q3.737). Its assignee is a control of its own over the
card's press, opening `AgentMenu`, portaled out of the lane's scroller; a second press closes it,
another card's moves it. The board's sideways bar is drawn
always, 14 px (`board-scroll`, Q3.745).

**A card is dragged between columns** (`useCardDrag`, Q3.728):

- A mouse arms on movement past `MOUSE_SLOP`, never the press, and is followed on window
  from then: the card it left may unmount. A finger drags nothing. The copy is a portal
  tilted by `LIFTED`, which `animate-lift` repeats in CSS; the cursor is set on the
  document, the one such style here.
- The column under the pointer is found by x within `LANE_REACH`; `dropRefused` lets a
  card an agent is on go to Done alone. The slot opens where `placesAt` says.
- Let go, the copy flies into its slot or back (Escape is overlay.ts's); a stalled
  flight lands late on a timer. Into Running (`useTaskDrop`) the agent the backlog named
  starts; any other card asks who in `AgentMenu`, opened by the card in the area that took
  it, and waits there as nobody's. A cancel releases the hold.
- **A press whose card moved carries nothing** (one closing the agent menu remounts it).
- **The list's lines drag the same way** on the `y` axis, a folded group taking one into
  its heading (Q3.733). A landed ring has room above a lane's first card; a line's is inset.
- **A column orders by `taskRank`** (`rank`, else age); the slot follows the pointer where the
  daemon keeps one (Q2.278). Scrollers keep their place (`keptScroll`); `title` is the whole
  name (Q3.747).
- `FlipBoundary` slides the rest, measuring before the DOM changes and only when `order`
  does; a card from another column fades in, or it slides behind its scroller. Nothing
  moves under reduced motion.

**The dispatcher is parked** (Q3.735, the owner's word): nothing mounts `Dispatch.tsx` or
`DispatchSetting.tsx`, and a session under the nickname is an ordinary conversation,
listed and pinned as any. Their code stays for later; agents still propose tasks.

## What ships first

The daemons, then the app (`compatibility.md`). An app before its daemons draws no
task; a daemon before its app is asked for none. An older app draws nothing for
`tasks_proposed`.

## Bounds

| | |
|---|---|
| Tasks | `MAX_TASKS` 500 per machine; a create past it replaces the task done longest ago, `429 too_many_tasks` where none is done |
| Text | title 120, brief 16 000, summary 2 000 characters; key 64 of `[A-Za-z0-9_-]` |
| A proposals card | 12 rows and 96 000 characters per call |
| Another machine's board | 3 s per machine, 8 at once, cached 15 s; 100 projects listed |
| The client's read | 4 s watched, 30 s idle, 5 min for a daemon with no route and no instance id, at once on a task session's change; 200 tasks and 280 characters of each brief remembered; done tasks drawn for a day; a machine's agents read once a minute (`ROSTER_TTL_MS`) |
| A drag | arms past `MOUSE_SLOP` (4 px); a column reaches 8 px past its edges; flight `SETTLE_MS` (180 ms), slides 220 ms, a stalled one lands 250 ms late; the landed ring 900 ms |
