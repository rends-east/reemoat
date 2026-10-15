---
paths:
  - packages/board/**
  - src/board/**
  - src/tasks/**
  - scripts/daemoncheck.board.ts
  - scripts/daemoncheck.board-fleet.ts
  - plugins/**
---

# The configurable board: its YAML, its engine, and tasks between machines

A board is one YAML document per account; the daemons run it, whether or not an app is
open. Q2.264 to Q2.269 are the argument, Q7.163 what is not built. `task-board.md` keeps
the tools, the old routes and the client; this file is the engine.

## One package, two runtimes

**`@reemoat/board` (`packages/board`) is pure and both sides import it**: `parseBoard`,
`step`, `place`, `phase`, `legacyStatus`, `applyStep`, `simulate`, `judgePrompt`,
`parseVerdict`. No I/O, no clock of its own: the daemon hands in a `World`. A rule that
moves a task lives here or nowhere; `boardcheck` drives it by table, with no daemon.

- **Consumed as source, like `@reemoat/protocol`**: the native payload copies it
  (`build-daemon.mjs`, held by `nativecheck`), its `yaml` and `@noble/hashes` are the root
  manifest's at the same exact versions (`pincheck`), and the gate image carries it
  (`.dockerignore` and the Dockerfile both name it).
- **The daemon applies what `step` returns** (`BoardEngine.apply`); `board_simulate` is
  `simulate`, which applies the same steps on paper. A second model of the rules anywhere
  is a defect.

## The YAML (Q2.266)

- **Strict**: `yaml` 2.9.1, YAML 1.2 core, so `yes` is a word. Refused, each with its
  line, column and path: a repeated key, any anchor or alias, any tag (the core schema
  turns `!!binary` into bytes by itself), an unknown field at any level, 64 KiB.
  `parseBoard` answers every refusal at once, sorted; `formatBoardError` is the one way
  one is written (`7:13 columns[2].next.fix.to: …`).
- **A shorthand `next: <column>` is one exit named `next`**, labelled with its target's
  title. `stay` is no exit's name. `human` is always last; anything after it is refused.
- **Revision and hash are over the text, byte for byte**: comments count. The same text
  again is no new revision. Of two copies the higher revision wins, then the smaller hash
  (`newerBoard`, `BoardEngine.adopt`). No stored board is the default at revision 0.
- **A board this build cannot parse keeps the daemon on the default** and warns; it never
  stops a daemon (`compatibility.md` rule 2). 20 revisions kept (`MAX_BOARD_REVISIONS`).

## A task's flow (Q2.264)

- **One `flow_json` per task** (`TaskFlow`), beside `board_column` and `epoch`; added by
  `migrate()`, no `SCHEMA_VERSION`. `status` is still written, as the default board's
  nearest (`storedStatusOf`), so a rolled-back build reads something true.
- **A row from before the board stands in its status's column with no run**
  (`flowOf`, `LEGACY_COLUMNS`). A column that became a work column under a task gives it
  no run either: only an entry makes one.
- **Every move is an entry**: `entry` grows, a work column gets a pending run of that
  number, verdicts and asks are of an entry. A report, a turn end or a verdict naming an
  older one moves nothing.
- **What a reader is shown is read, never stored**: `phase` (sessions first, then the
  run, then the column) and the old `status` by the phase table (`legacyStatus`), except
  that a final column is `done` whatever its sessions do. The holder is the run's
  executor, and while queued the agent its run is for (`runRole`), with no machine.
- **A run on a task nobody was named on makes its agent the assignee**, so the intake
  never draws a task that has been worked as nobody's again.

## A run

- **Placed by `place`**: the conversation it continues, else the first machine a pinned
  role names (code goes to work), else the code's holder (work goes to code), else this
  machine, the least busy, by name. Every choice is written to the history with its
  reason.
- **Its message**: `/<skill> <args>`, else the column's prompt, else **the brief where it
  opens a conversation and the return hint where it continues one** — the spec says brief
  on the task's first run; a new conversation knows nothing, so it gets the brief and the
  hint rides in its note (`runMessage`, `runNote`).
- **It ends on `turnsEnded` past the turns it began after, over a settled session**
  (`parkable` without its age, or parked, or a turn a restart cut): with a report
  (`done_when: report`) or the turn alone (`turn`). Without one it stops, once per turn
  (`stoppedAt`), and the agent's last message goes to the feed. A person stopping its
  conversation, or one that cannot come back, fails it (sticky until a person moves it).
- **One worktree per task per machine**: the first run makes it on `reemoat/t-<id>`,
  later runs work in it with `worktree: "never"`, code that came from elsewhere is
  checked out with `from` (no `-b`). A run's end makes the control commit
  `board: <column> #<n> <executor>` and counts its diff for the rules.
- **A start from a route waits for its launch** (`TaskDesk.startNow`) and answers the
  launch's own refusal (`launchRefused`, shared with `POST /sessions`); one the board makes
  by itself turns a refusal into `run_failed`, or a wait for a session slot.

## Judges (Q2.267)

The ladder is `decide`, in order: `self` (the run's `task_update` outcome), `{rules}`
(first match), a role (one bare ask through `AgentAskRuns`, or a plugin classifier), then
`human`. `stay` or the end of the ladder is the person's: `needs_you` in a work column,
the buttons in a waiting one. A role abstains on an answer it cannot read strictly, an
exit the column lacks, no answer in 120 s (10 s for a classifier), or a confidence under
its floor; an answer that names no confidence is not checked against one. Each verdict
is history with its role, exit, confidence, entry and revision.

- **A classifier only decides**: named in `run` it is no executor (`judge_only`).
- **Automatic moves spend the budget; anything a person does gives it back**
  (`humanActed`): a move, a comment, an edit, an answer.

## The feed (Q2.265)

A question is a window on a request in a session (`request` names it); its state is read
off the session every time (`TaskDesk.feed`), so the chat and the feed answer one request.
A stop holds the agent's last message; a reply is a comment, which goes into a working
run's conversation as its person's message, else into the next run's note. On a task in a
column that waits on its person (not the intake, not a closing one) it also sends the task
back to its last run's column (`sentBackTo`), so the agent has it at once. 200 kept.

## Between machines (Q2.269)

- **A run goes where `place` puts it; the task goes with it.** The owner sends
  `POST /peer/tasks/:id/handoff` at `epoch + 1`, tries again 30 s to 10 min apart, and
  gives up to its person after a day (`handoff_failed`). While one is out, a person's edit
  is `409 task_moving`.
- **The receiver takes it only where nothing here is newer, its board is at least the
  sender's (it pulls `GET /peer/board` first), and the run's role allows this machine by
  the name the sender placed it as** (`role_not_here`). Taken, the sender `retire`s it:
  row, history and feed go, its sessions stay attached, and a tombstone keeps the epoch,
  the target and this machine's checkout of the code.
- **The code is a branch, never a folder.** The receiver asks the holder
  `GET /peer/tasks/:id/code?have=` and takes a bundle in 512 KiB pieces
  (`CODE_PIECE_BYTES`), 64 MiB at most; a worktree moves forward only and only when clean,
  else `code_diverged`. A project that is no repository does not move
  (`code_not_portable`). The holder answers from its tombstone too.
- **Machines are matched by the project's identity** (its origin, `projectIdentity`), read
  from folders the daemon's own sessions and tasks used (`checkoutFor`).
- **Gates**: the link must carry `task:handoff` (`HANDOFF_SCOPE`, minted only where both
  ends' `tasksMove` switch is on) and this machine's policy must let tasks move
  (`PeerHub.movesTasks`); links themselves still need messaging on. `GET /peer/board` and
  `/peer/projects` answer on `session:message`; the move, the code and `POST /peer/judge`
  on `task:handoff`. Every board answer carries `boardRevision` and `boardHash`.

## Bounds

| | |
|---|---|
| A board | 64 KiB of YAML; 32 roles, 32 columns, 8 exits, 6 judges, 16 rules, 16 machines a role names; a column title 40, a prompt 16 000, skill args 2 000 characters; budget 1–50 (8), a column's limit 1–64 |
| A run's engine | 16 steps per event; waiting runs looked at every 30 s; no executor for a day asks its person |
| A judge | 8 KiB of question (last message 4 KiB, diff 6 KiB, cut from the end of `sees`); 120 s a harness, 10 s a classifier |
| The feed and history | 200 entries each per task; a comment 8 000 characters, 2 000 of each when it moves |
| A move | 30 s per try, retried 30 s → 10 min, given up after 24 h; code 64 MiB in 512 KiB pieces, a bundle kept 10 min; tombstones 30 days |
