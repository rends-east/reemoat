---
paths:
  - src/registry.ts
  - src/session.ts
  - src/events.ts
  - src/store/*
  - scripts/daemon.ts
  - src/agentupdate.ts
  - src/idlepark.ts
  - scripts/daemoncheck.ts
  - scripts/daemoncheck.*.ts
  - scripts/harness.ts
---

## Surviving a restart

- **The message box never leaves the screen.** `Composer.tsx` has no early return; Send
  is gated, never the box; sending into an ended session revives it per the table. Q7.103.
- **An agent that cannot authenticate is replaced.** `onAuthFailure` records it and calls
  `restartAgent`, which stops with `config_changed` (a new `ExitReason` reads as
  `showsAsEnded` on older clients). Armed once per prompt. Only the
  `POST /agent-auth/:agent/logout` sweep writes `agent_signed_out`. What goes stale is
  the process, not the credential. Q7.99, Q7.103.
- **Stopped only when somebody stopped it.** Anything else the daemon ended comes back at
  the next boot over ACP `session/resume` (restores context, replays nothing); cursor has
  only `session/load`. Q2.1, Q2.106, Q2.248.

**Idle parking.** Quiet for `REEMOAT_IDLE_PARK_MINUTES`, a session is stopped `parked`:
process released, all else kept. Not compiler-enforced:

- precondition: `status === "idle"` and no `/clear`, queued message or live background
  work (Q2.228);
- `parked` is not a `DAEMON_EXIT_REASON` (the boot pass leaves it) and has its own
  `SessionStatus`, or `status`'s `default:` says `exited`;
- the prune reads the wider `keepsItsConversation`;
- only a message brings it back — an exclusion, as `canResume` passes on both clauses;
- it draws as plain `idle`; Stop stays offered via an override (`stop()` memoises);
- controls and `/` stay live: a tap is recorded for `doResume` (a wake only for cursor's
  model, Q2.249); `revivableByPrompt` gates keeping it, `agent_state_json` and finished
  background rows, for every such stop. Q2.224, Q2.229,
  Q2.234.

**`autoResumable` is a `switch` over `ExitReason` with no `default` arm**:

| reason | at boot | on a prompt |
|---|---|---|
| `daemon_shutdown`, `daemon_restarted`, `config_changed` | yes | yes |
| `agent_exited`, `stopped`, `agent_signed_out`, `parked` | no | yes |
| `start_failed`, `start_timeout`, `agent_kill_failed` | no | no |

A prompt is the person asking now; a boot pass is nobody asking and has no recency
fence, so it revives neither a long-crashed agent nor one that cannot authenticate.
`parked`'s boot `no` is load-bearing. Unrevivable: no conversation yet (the
`agentSessionId` guard answers anyway), or `agentConfirmedDead: false`. Q2.2, Q7.103.

- `status` derives through `endedWithDaemon`: `interrupted` means exactly "the daemon
  ended this and it is coming back". `doStop` keeps the caller's reason. Q2.3.
- **The boot pass is `SessionRegistry.autoResume`, never in `restore()`** (synchronous),
  started with `void` after the listener and outside its callback (`wait_healthy` polls
  `/health` for 30s). Most-recently-active first; numbers in `daemon-bounds.md`.
  `supportsSessionResume` is known only after a start: one wasted spawn per binary, and
  a refusing agent is not asked again that pass. Q2.4. No CLI (`agent_missing`) costs no
  attempt; the installer is nudged, the pass repeats; passes queue. Q4.114.
- **A launch identifies itself**: `launch()` hands its promise to
  `onStarted(starting, session)`/`onStartFailed(starting, error)`, which return when
  `this.startPromise !== launch`; `onStarted` disposes a declined session before
  assigning `this.session`. Only `launch` and `armForStart` write `startPromise`. Q2.40.
- **Workspace probe before spawn**: `false` (gone) settles, costs no attempt, never
  retried; `null` (mount silent) is neither spent nor treated as present. Q2.5.
- **Retry state is in memory; every restart resets it**, except `resourceNotFound`
  (-32002) on resume: `SessionForgottenError`, persisted in `sessions.resume_gave_up`,
  free, gating both automatic paths. It covers old forked ids and a transport hiccup
  `claude-agent-acp` maps there too: one manual `resume` until the prune (Q2.222). Q2.6.
- **Q2.7 is stale**: `clearContext` performs `/clear` and stores `session/new`'s id.
- **`clearing` makes a clear exclusive** (`session/new` + `session/close`, ~600ms–15s, no
  turn held). All five agent-facing methods test it: `prompt`, `clearContext` →
  `409 turn_in_flight`; `setConfigOption`, `setMode`, `cancelTurn` → `409 session_busy`,
  `cancelTurn` testing it before `turn`. `status` stays `idle` beside the 409
  (`daemoncheck` pins it). Q2.39.
- **A cleared conversation never written down is opened, not resumed.**
  `conversationKnownEmpty`: `turnCounter === 0`, or the log tail holds a
  `context_cleared` with no `prompt` after (last decides); neither arm subsumes the
  other. Q2.9.
- **kimi will not resume a session left in `plan` with `clientCapabilities.fs`
  declared** (`-32603`): `Session.resume` retries once without file IO
  (`LaunchOptions.fileIo`), only then. Q2.8.
- **Sending resumes first**, in `POST /sessions/:id/prompt`, not `ManagedSession.prompt`
  (synchronous). `resume()` is memoised like `stopping`: two prompts join one launch,
  not `409 session_not_ready`; failure → `409 session_terminal`. Q2.11.
- **The interrupted turn is not re-run**; a pending approval is gone (its `resolve`
  closure cannot be serialized). Q2.12.
- `REEMOAT_AUTO_RESUME=0` turns off both paths.

## Stopping a turn

- **Two verbs.** `DELETE /sessions/:id` kills, writes `exitRecord`, terminal.
  `POST /sessions/:id/cancel` sends one ACP notification, nothing else. Say **cancel**,
  never interrupt. Q2.42.
- **It asks.** `Session.cancelTurn` returns `void`; `awaitTurnEnd` reports `settled`
  within `CANCEL_SETTLE_MS`; `false` never means "refused". `stop` forces.
- **Send, sweep, watch**: ACP makes a cancelling client answer pending
  `session/request_permission` with `cancelled`, and a parked agent sees nothing till
  then; `daemoncheck` drives that shape. Q2.42.
- **`sweepPending("turn_cancelled")`**, its own reason (not `session_stopped`), runs in a
  `finally`, fenced on the turn the call was about. The pump sweeps nothing (Q2.232).
- **Nothing new is logged**: the agent's `turn_end{stopReason: "cancelled"}` plus
  `permission_resolved`. `cancelRequestedAt` rides the snapshot, cleared where `turn` is
  (`pump`'s `finally`, same identity test), memory only.
- **`no_turn` is a 200 with `cancelled: false`.** Unprompted work or a parked request
  without a turn gets send/sweep/watch and `turn: null` (`mid-turn-messages.md`; Q2.232,
  Q2.233). `terminal`, `not_ready` stay 409; beside a `/clear`, `409 session_busy`.
- **A cancel before the prompt wins**: `turn` is set synchronously, `Session.turnActive`
  at `pump`'s first pull (after an image `readFile`), so `pump` re-tests and writes its
  own `turn_end{cancelled}`. Q2.103.

## After the turn ends

- **A system-pinned session is offered its system's models only**: `narrowToSystem`
  filters snapshot choices to `modelNamespace`, from `assembled`, never the current
  selection. The selected choice is never removed (else a raw-id chip and
  `pinNativeModel` refusing resume). Q2.219.
- **An error ends the turn**: `pump` writes `turn_end{stopReason: "agent_error"}`
  (`TurnStopReason` widens ACP's five) — not on `CLOSED`, our own dispose
  (`isSessionClosed`, by identity). `Tail.taskFloor`, the `turn.ended` hook and the
  origin claim need it. Q2.218, Q2.103.
- **A turn nobody answers ends anyway** (`running` is `turn !== null`). `wedged`
  decides, `abandonWedgedTurns` runs on `idlepark.ts`'s clock, `Session.abandonTurn`
  writes `turn_end{abandoned}` locally; the agent is not stopped or told. Traps: clear `turnActive` by hand (else *"already in
  flight"*); fence the request's callbacks on `promptEpoch`; never
  `withAbandonableDeadline` (an adapter honours `session/prompt`'s `ctx.signal`, so it
  aborts the work). Q2.231.
- **After `turn_end`** events go to an unconsumed `EventQueue` (lost past
  `MAX_BUFFERED_EVENTS`); `ManagedSession.startIdleDrain` reads them. `Session` does
  not, so bare `Session`/`harness` stays a regression test. Q2.44.
- **Queue claims are monotonic**: a new claim wakes the old holder with `null`, `next()`
  answers `null` to a stale one, `claimForIdle` refuses under a turn, `claimForTurn`
  never displaces, `release` is identity-checked. Claimed before the RPC fires, no await
  between. Q2.102.
- **Out of turn, `agent_log`/`other` leave the log** (last 20 stderr lines on
  `Session.recentLogs()`) but still move `lastEventAt`. Q2.44, Q2.228.
- **Not done**: no `SessionStatus` clock; the turn is never held open (`canCancelTurn`
  would stay true, `409 busy` for ever). `unpromptedSince`: `mid-turn-messages.md`.
- **`outstandingTasks`** (transcript foot, from the tail) counts `pending` (a spawn
  skips `in_progress`); `mayStillReport` excludes terminal and `stopping`. Shell,
  workflow and monitor work: three `async_task_*` variants behind `_meta.jetbrains.air`,
  on the snapshot, refused by `parkable`, lifted off the byte stream below the SDK by
  `splitAsyncTaskUpdates`. A backgrounded subagent stays invisible (`ignored`,
  `completed` at launch). Q7.113, Q2.228.
- **A task list belongs to the conversation**: `doStop` keeps rows as `earlierTasks` on
  the `revivableByPrompt` gate, live ones marked `stopped`; `applyBackgroundTasks`
  merges the live list over them. A `/clear` or unrevivable stop drops them. Finished
  rows only, written only at such a stop; a crash loses them. Q2.234.

## Invariants

**The log**

- **Never truncated**: `DEFAULT_MAX_EVENTS`/`DEFAULT_MAX_BYTES` are `Infinity`.
  `REEMOAT_LOG_EVENTS`/`REEMOAT_LOG_BYTES` bound it for an operator; `daemoncheck`
  drives eviction at `maxEventsPerSession: 8`. `truncateEvent` shortens one event
  visibly; `prune` removes a session whole. Q5.46.
- **The attach is bounded**: `ATTACH_REPLAY_MAX` replays the newest 2000 and sends
  `lagged{reason: "backlog"}`, never a loss nor drawn as a hole. Bytes bite first, so
  `emit`/`enqueue` take `replaying` and `collapse` takes the reason: overflow in the
  attach's drain reports `backlog`, not counted toward the `4003` close (`gapPlan` would
  file `slow_consumer` as a hole). Q5.48.
- **The emit path never awaits.** `SessionLog.append` and `EventStore`, `read` included,
  stay synchronous; an async store goes behind a write-behind buffer.
- **Fan-out guards every listener** (`try/catch`, evict the thrower), and fans out only
  what `store.append` returned; degradation goes via the placeholder and `onDegraded`.
- **A failed insert is a placeholder at the same seq**, returned by `append`
  (`WHERE seq > ?` hides a middle gap).
- **`lastSeq`/`dropped` are floors on the session row, raised at load.**
- **`gap` derives from `oldestAvailable()`**: `count > 0 ? firstSeq : lastSeq + 1`, in
  both `attach` and `GET /sessions/:id/events`; `firstSeq` is 0 when empty.
- **Size accounting is null-safe on `FileChangeEvent.oldText`** (`null` on create).

**Permissions and the registry**

- **A request is settled by an answer, a cancel, the agent withdrawing it or the agent
  going — never a turn boundary or a timer.** `no_turn`/`turn_ended` stay in
  `AnswerResolvedBy` for old logs. An `ask_question` outlives its agent. Q2.232, Q2.250.
- **`settle()` resolves the agent before logging**: `pending.delete` (the CAS) →
  `resolved` → resolve the agent's promise → append → fan out; else a throw hangs the
  agent and switches off `status: "blocked"`. Q5.54.
- **The permission promise executor holds one statement**, the resolve capture (a throw
  leaves the entry `blocked`).
- **The registry appends permission events**: a `permission_request` through the queue
  lets a client's answer beat its request into the log. Q2.105.
- **Status is derived**: `ManagedSession.status` per read; `snapshot()` is frozen, arrays
  copied.
- **`create` refuses a harness that just would not start, before `createWorkspace`**
  (the `available` fence; `auth_required` lands after worktree, branch and row). Always
  bare or native; routed only if the refusal was measured routed (`applySystem` runs
  first). A plain `Error`, on the `agent_auth_required` arm. Q2.221.
- **`doStop` uses `exitRecord ??=`** (a restored session keeps `daemon_restarted`).
- **Orphan reaping is fenced by `os.uptime()`** (pids wrap, reboots reset).
- **Liveness is `"alive" | "dead" | "unknown"`**, never a boolean `isAlive`:
  `process.kill(pid, 0)` throws `EPERM` and `ESRCH`. Not `"dead"` is still signalled.
- **A path probe is `true | false | null`** (`probeExists`); `removeWorkspace` never runs
  the one `rmSync` on `null`. `409 workspace_missing` / `503 workspace_unresponsive`.
- **Agents spawn `detached`, die by process group** (`claude-agent-acp` cleans up only on
  `process.on("exit")`); a crashed daemon strands them for the reaper. The login pty too.
- **Every RPC writing agent stdin is bounded**: in `doDispose` they precede
  `client.close()`, the only SIGTERM/SIGKILL.
- **An agent handle is a union, second arm read-only legacy**; `toHandle` can answer no
  handle (not pid 0). A container handle is never signalled.
- **`session/resume` where it exists, else `session/load`**, safe only because the replay
  precedes the answer and `adopt` registers after. Q5.85, Q2.248.

## Layout

`src/events.ts`: `SessionEvent`, `SessionWorkspace`, `StoredEvent`, `EventStore`,
`SessionStore`, `MemoryEventStore`, `SessionLog`, size accounting. `src/store/schema.sql`
(handle in four columns, `agent_credentials` rekeyed, `owner_subject` dead;
`peer_messages_off` only in `migrate()`). `src/store/sqlite.ts`: `openStores`,
`SqliteEventStore`, `SqliteSessionStore`, `SqliteAgentCredentialStore`. `src/agentupdate.ts` runs
`deploy/agents.sh` five minutes after start, daily, and when a resume finds no CLI
(`REEMOAT_AGENT_UPDATES=off`). `src/idlepark.ts` is the clock only (which:
`ManagedSession.parkable`; order: `parkIdleSessions`; `REEMOAT_IDLE_PARK_MINUTES=0` arms
nothing). `scripts/daemoncheck.ts` is the runner; assertions in
`daemoncheck.<subject>.ts`.

## Known gotchas

- `pkill -f "tsx scripts/daemon.ts"` matches nothing; the command line is
  `…/tsx/dist/cli.mjs scripts/daemon.ts`. Kill by pid, or the lock refuses the next.
- `DEFAULT_PORT` and the `REEMOAT_URL` fallback are 7887.
- The slow-consumer collapse is untested daemon-side; `webcheck` pins that a 4003 backs
  off without marking the machine unreachable.
- `@hono/node-ws` peers on `@hono/node-server` ^1.x.
- `ADD COLUMN ... NOT NULL` needs a `DEFAULT`; `owner_subject` has no honest one, so is
  nullable.
- A new `sessions` column needs `migrate()` (`PRAGMA table_info`), not `schema.sql`.
- `node:sqlite` needs `--experimental-sqlite` on Node 22, hence `engines` `>=24`.
- Two daemons on one database: refused by the single-row `daemon` table before restore.
  One per `REEMOAT_HOME` is fine. Q7.148, Q7.149.
- A taken port crashes with a raw `EADDRINUSE` stack. Not fixed.
