---
paths:
  - src/registry.ts
  - src/session.ts
  - src/events.ts
  - src/store/*
  - scripts/daemon.ts
  - scripts/daemoncheck.ts
  - scripts/harness.ts
---

## Surviving a restart

**Nothing takes the message box off the screen, and a conversation you cannot
type into does not exist in this app.** `Composer.tsx` has no early return;
sending into an ended one revives it per the table below. What is gated is Send,
never the box. Q7.103.

**An agent that cannot authenticate is replaced, not buried.** `onAuthFailure`
records the failure — `record` has already appended it, so it is in the transcript
— and calls `restartAgent`, which stops with `config_changed` because it *is* "the
daemon took the agent away and is bringing it straight back" and because a new
`ExitReason` reads as `showsAsEnded` on every older client. **Armed once per
prompt**: a credential that really has gone fails the fresh agent too, the second
failure sits beside the first, and the person's next message drives the next
attempt. `agent_signed_out` is now written by **one** call site, the explicit
`POST /agent-auth/:agent/logout` sweep. Q7.99 measured why: what goes stale is the
process, not the credential — a session idle 5h36m failed while its token had 1.4h
left, and a fresh agent worked four minutes later. Q7.103.

**A session reads as stopped only when somebody stopped it.** Everything else the
daemon ended it brings back by itself, on the same conversation, at the next boot,
over ACP's `session/resume` — which restores the agent's own context without
replaying anything, and which all three agents implement. Q2.1, Q2.106.

**The rule is `autoResumable`, a `switch` over `ExitReason` with no `default`
arm**, so adding a reason is a compile error rather than a silent `false`:

| reason | at boot | on a prompt |
|---|---|---|
| `daemon_shutdown`, `daemon_restarted`, `config_changed` | yes | yes |
| `agent_exited`, **`stopped`**, **`agent_signed_out`** | no | **yes** |
| `start_failed`, `start_timeout`, `agent_kill_failed` | no | no |

**Everything splits on the same rule: a prompt is a person asking for this
conversation *now*, and a boot pass is nobody asking.** The boot pass has no
recency fence — an agent that crashed on Tuesday would otherwise be handed a fresh
process by Friday's deploy — and starting an agent that cannot authenticate at 4am
is how a fleet spends a morning on it. Q2.2, Q7.103.

⚠ **`stopped` and `agent_signed_out` were `no`/`no` and the middle row is a
reversal.** Refusing a prompt was how the daemon avoided overruling a person — and
a prompt is not the daemon deciding anything, it is that same person typing into
the conversation again. What forced it is that the composer is unconditional now: a
box whose only possible answer is `409 session_terminal` is worse than no box. The
last row is what is genuinely unrevivable — the first two never had a conversation
to return to (the `agentSessionId` guard answers them anyway), and
`agent_kill_failed` carries `agentConfirmedDead: false`, so the old agent may still
hold the conversation file.

`status` derives through `endedWithDaemon`, so **`interrupted` means exactly "the
daemon ended this and it is coming back"** and a client can render it without
learning exit reasons. `doStop` keeps the caller's reason; `agentConfirmedDead:
false` carries a failed SIGKILL *beside* the reason rather than instead of it.
Q2.3.

**The boot pass is `SessionRegistry.autoResume`, deliberately not part of
`restore()`** — that must stay synchronous, so this is the async half, started with
`void` after the listener is up and *outside* its callback, because `wait_healthy`
polls `/health` for 30s and a boot behind two ACP handshakes reports a healthy
daemon as a failed update. Most-recently-active first. Two at a time. Three
attempts, full jitter 2s→60s. `supportsSessionResume` can only be asked *after* an
agent has started, so one wasted spawn per agent binary is unavoidable and an agent
that refuses once is not asked again in that pass. Q2.4.

**A launch identifies itself to its own callbacks.** `launch()` passes the launch
promise to `onStarted(starting, session)` / `onStartFailed(starting, error)` and
both return early when `this.startPromise !== launch`; `onStarted` **disposes** the
session it declines, before assigning `this.session`. `startPromise` is written in
exactly two places (`launch`, `armForStart`), which is what makes the identity the
launch — code that reassigns it without meaning to supersede has its agent disposed
rather than adopted. Q2.40.

**The workspace is probed before the spawn, with three answers.** `false` means the
worktree is gone: settled, costs no attempt, never retried. `null` means a mount did
not answer, which is neither — spending the budget on it abandons work over a
sleeping NAS, and treating it as present parks an agent in an uninterruptible
kernel wait. Q2.5.

**Retry state is in memory and resets on every restart, with one exception.** A
restart is *new information*, and refusing to try would make the deploy that fixes
the bug fix nothing. The exception is **`resourceNotFound` (-32002) on a resume** —
`SessionForgottenError`, persisted in `sessions.resume_gave_up`: a fact about the
*agent's* disk, costing no retry budget and gating both automatic paths. The caveat
is written at the constant — `claude-agent-acp` maps *two* SDK failures onto this
code and one is a transport hiccup, so a recoverable session can be stranded and the
way back is one manual `resume`. Q2.6.

**`/clear` breaks resume for that session, and it is not fixed.** Our ACP session id
does not change and claude forks *underneath* the protocol, so the stored id keeps
naming the conversation the fork left behind — a codeword somebody asked the agent
to forget comes back word for word. `session/list` is the untried lead; if the fork
cannot be identified, the honest answer is to stop auto-resuming a cleared session
rather than resume the wrong conversation. Q2.7.

**A clear is exclusive, and `clearing` is the marker that says so.** A `/clear` is a
`session/new` followed by a `session/close` — ~600ms to 15s in which the session
holds **no turn**, so every guard written as `this.turn !== null` waves everything
through. Five methods talk to the agent and all five test the marker: `prompt` and
`clearContext` answer `busy` → `409 turn_in_flight`, and `setConfigOption`,
`setMode` and `cancelTurn` answer `busy` too → `409 session_busy`. `cancelTurn`
tests the marker **before** it tests `turn`, because a clear holds no turn and the
other order answers `no_turn` — "nothing is running, you have what you asked for" —
about a session mid-ACP-round-trip. The marker is deliberately **not** a turn, so
`status` still reads `idle` beside the 409; `daemoncheck` pins that pair because it
looks like a bug. Q2.39.

**A cleared conversation the agent never wrote down is opened, not resumed.** claude
writes its transcript lazily with the first turn, so a restart landing between a
clear and the next message finds an id naming nothing on disk. Gated on
`conversationKnownEmpty`, which has **two arms that do not subsume each other**:
`turnCounter === 0`, or the tail of the log holding a `context_cleared` with no
`prompt` after it — because `clearContext` moves the id and leaves the counter
alone. The log arm walks the window and lets whichever came **last** decide. Q2.9.

**kimi will not resume a session left in plan mode while `fs` is declared.**
`session/resume` answers `-32603` when `clientCapabilities.fs` is declared and the
session was left in `plan`. `Session.resume` retries **once** without file IO, via
`LaunchOptions.fileIo`. Narrow twice over: only `-32603`, and only on resume. Q2.8.

**Sending a message resumes first**, in `POST /sessions/:id/prompt` and not in
`ManagedSession.prompt`, which is synchronous by contract. `resume()` is memoised
like `stopping`, so two prompts join one launch instead of the second losing with
`409 session_not_ready`; a failure falls through to `409 session_terminal`. Q2.11.

**The interrupted turn is not re-run.** The agent comes back *idle*, holding
everything that was said: it may have half-applied its edits and cannot tell how far
it got. A pending approval is gone — it holds a live `resolve` closure that cannot
be serialized. Q2.12.

`REEMOAT_AUTO_RESUME=0` turns off both paths.

## Stopping a turn

**Stopping the agent and stopping the session are two verbs, and the whole feature
is that they are different.** `DELETE /sessions/:id` kills the process, writes an
`exitRecord` and makes the session terminal; `POST /sessions/:id/cancel` sends one
ACP notification and changes nothing else — the agent stays up, the conversation
stays loaded, and the next message is an ordinary prompt rather than a resume. The
word is **cancel** rather than interrupt throughout, because `interrupted` is
already a session status meaning "the daemon ended this and it is coming back".
Q2.42.

**It asks, and nothing here can make an agent stop.** ACP defines cancellation as a
notification, so `Session.cancelTurn` returns `void` — that is the promise being
made — and whether the turn ended is a *separate* observation, `awaitTurnEnd`,
reported as `settled` and bounded by `CANCEL_SETTLE_MS`. `settled: false` means "the
agent had not finished by the time anybody stopped watching", never "it refused":
the turn ends into the transcript whenever the agent gets there, with nobody
attached. What forces is `stop`.

**The order is send, then sweep, then watch, and the middle step is ACP's
requirement rather than this daemon's tidiness.** A client that has cancelled MUST
answer any pending `session/request_permission` with `cancelled` — and until it
does, an agent parked on one is not executing anything that could notice the
notification: the message sits in its pipe behind a reverse-RPC it is still waiting
on. `daemoncheck` drives an agent that answers only once the client settles the
permission, which is the shape that fails under either other order. Q2.42.

**The sweep is `sweepPending("turn_cancelled")`, and the reason is its own member.**
`session_stopped` says the session is over while this one is idle and still holding
its conversation; `turn_ended` is what the *pump* writes once the agent has
answered, which is after this and may never come. It runs in a `finally`, so a send
that throws on a pipe nobody is reading cannot leave the agent holding a promise
this daemon will never settle, and it is fenced on the turn the call was about:
`cancelTurn` can be in flight while that turn ends and a *new* prompt starts, whose
parked permission this sweep would otherwise cancel.

**Nothing new is written to the log.** The record is the agent's own
`turn_end{stopReason: "cancelled"}` plus a `permission_resolved` for anything
parked; a dedicated event would put a second row on screen for one act.
`cancelRequestedAt` rides the **snapshot** instead and covers the one case the log
cannot — an agent that has not answered yet. It is cleared where `turn` is, in
`pump`'s `finally` and inside the same identity test, so the pair cannot disagree,
and it is in memory rather than SQLite because after a restart there is no turn to
have cancelled.

**`no_turn` is a 200 carrying `cancelled: false`, not a 409.** Nothing was stopped
and nothing is wrong, and the state is reachable by losing an ordinary race, where a
red error makes the control look broken at the moment it got what it wanted.
`terminal` and `not_ready` stay 409s, because those say something the caller does
not know: there is no agent at all. A cancel beside an in-flight `/clear` is `409
session_busy`.

**A cancel that arrives before the prompt does is honoured rather than overtaken.**
`prompt()` sets `turn` synchronously, but `Session.turnActive` is not set until
`pump` first pulls the generator — and reading an inlined image's bytes is a real
`readFile` between the two. So `pump` tests the marker after the read and writes its
own `turn_end{cancelled}`, because the agent never gets to send one and a prompt
with no turn end at all is a message that reached no model. Q2.103.

## After the turn ends

**The turn ending is not the agent stopping.** `session/prompt` resolves while claude
drives work it has spawned and `Session.prompt`'s generator returns on `turn_end`, so
everything the agent emits afterwards goes into an `EventQueue` with no consumer —
neither delivered nor, past `MAX_BUFFERED_EVENTS`, kept.
`ManagedSession.startIdleDrain` is what reads it between turns; `Session` does not
wire this up, which is what keeps a bare `Session` — and therefore `harness` — a
regression test for the untouched default paths. Q2.44.

**Ownership of the queue is checked rather than assumed.** A claim is a monotonic
number: taking one wakes the previous holder with `null`, and `next()` answers `null`
for a claim that is no longer current, so a reader already resumed cannot take one
more event on its way out. A turn outranks a drain (`claimForIdle` refuses while a
turn holds it) and nothing displaces a turn (`claimForTurn` refuses rather than
displacing). `release` is identity-checked. Q2.102.

**The claim is taken before the RPC is fired**, with no await between, which is what
makes "a turn's own `turn_end` can never reach the drain" a property of the ordering
rather than a hope.

**`agent_log` and `other` are dropped out of turn, and that is today's behaviour
preserved rather than a new loss** — they are exactly what the queue evicted first.
Recording them would put an unbounded stderr stream into a per-session log that is
deliberately `Infinity`/`Infinity`, make `REEMOAT_LOG_EVENTS` actively harmful, charge
against the tab's 16 MiB ceiling and bury a reattaching phone behind
`ATTACH_REPLAY_MAX`. Neither is drawn anywhere, and the last 20 stderr lines are
already on `Session.recentLogs()`. Q2.44.

**What is deliberately not done.** `status` is untouched and no new `SessionStatus`
member exists: a clock in `status` would break *"Status is derived, never stored"*,
and a new member falls silently through `statusTone`'s `default` with no mirror
assertion anywhere. The turn is **not** held open — that would make `canCancelTurn`
true for a turn that has ended and answer `409 busy` for ever. And `showsWorking` is
**not** widened, because it is what refuses Send: widening it would take the control
away in exactly the state whose only exit is using it.

**What says so on screen is `outstandingTasks`**, drawn at the transcript's foot from
the tail rather than the snapshot, since `showsWorking` reads `turn` and the
delegations outlive it. `pending` counts, because a Task spawn sits there for 13–14s
and reaches `completed` without ever being `in_progress`; `mayStillReport` excludes
terminal and `stopping`, the two states where a spawn can never complete.
⚠ **It reads 0 for work behind a call that already reported `completed`** — no ACP
message describes background shell work, so the drain is the fix and this is the only
honest client-side signal there is. Q2.44.

## Invariants

**The log**

- **A session's log is never truncated.** `DEFAULT_MAX_EVENTS` and
  `DEFAULT_MAX_BYTES` are `Infinity`. **There is no number that makes prefix
  eviction acceptable** — the part that says what the work *is* is at the top, and
  the top is what a prefix takes first. `REEMOAT_LOG_EVENTS`/`REEMOAT_LOG_BYTES`
  still bound it for an operator who wants that, and `daemoncheck` drives eviction
  with `maxEventsPerSession: 8` so the path stays exercised. Two bounds survive and
  neither is this one: `truncateEvent` shortens a single oversized event *visibly*,
  and `prune` removes a session **entire** — kept whole or not at all, never
  trimmed to a suffix. Q5.46.
- **The *attach* is bounded where the history is not.** `ATTACH_REPLAY_MAX` replays
  the newest 2000 and sends `lagged{reason: "backlog"}`, the one lagged reason that
  is **not** a loss — a client must never draw it as a hole. **2000 is under the
  *event* bound only** and the byte bound bites first, so `emit`/`enqueue` take a
  `replaying` flag and `collapse` takes the reason as an argument: an overflow during
  the attach's own synchronous drain reports `backlog` too, and is not recorded in
  the window that closes the socket `4003`. `slow_consumer` there is a lie about a
  client whose first `send` callback has not run, and `gapPlan` files it as a
  permanent hole. Q5.48.
- **The emit path never awaits.** `SessionLog.append` and `EventStore` are
  synchronous; that path runs inside the agent's RPC handler, and a connection's
  listener is a synchronous array push. **`EventStore` stays synchronous, `read`
  included** — Node's SQLite bindings are synchronous, so async buys nothing and
  costs the correctness argument above. An async store goes behind a write-behind
  buffer.
- **Fan-out guards every listener.** `append` wraps each call in `try/catch` and
  evicts the thrower; unguarded, one broken connection makes every *later* listener
  silently miss that seq.
- **The store cannot append to itself.** `SessionLog.append` fans out only what its
  own `store.append` returned. Degradation is reported through the placeholder and
  `onDegraded`, never by logging an extra event.
- **A failed insert becomes a placeholder at the same seq, never a hole.** `read` is
  `WHERE seq > ?` and `lagged` derives from `firstSeq`/`lastSeq`, so a gap in the
  *middle* is invisible on the wire. The placeholder is also what `append` returns —
  a live client holding the real text at seq 412 while a reconnecting one gets a
  placeholder makes the two disagree about what 412 *is*, undetectably.
- **`lastSeq`/`dropped` are floors on the session row, raised at load.** Otherwise a
  session whose events were pruned restarts at seq 1 and a resuming client receives
  *different events under numbers it has already seen*.
- **`gap` is derived from `oldestAvailable()`, never `firstSeq` alone.** `firstSeq`
  is 0 when the table holds no row, so `since < firstSeq - 1` is false for every
  cursor on the one path where *everything* was lost.
  `count > 0 ? firstSeq : lastSeq + 1` is the only honest form, and both `attach` and
  `GET /sessions/:id/events` must use it or they disagree.
- **Size accounting is null-safe on `FileChangeEvent.oldText`.** It is `null` for
  every file the agent *creates* — the common case.

**Permissions and the registry**

- **`settle()` resolves the agent before it logs.** Order: `pending.delete` (the
  compare-and-swap) → record in `resolved` → **resolve the agent's promise** →
  append → fan out. Appending first means a throw leaves the permission recorded as
  answered while the reverse-RPC is never answered — a permanent hang that also
  switches off `status: "blocked"`, the one signal that would reveal it. Q5.54.
- **The permission promise executor holds exactly one statement**, the resolve
  capture. A throw inside an executor rejects the promise, answering the agent with
  an error while leaving the entry in `pending` — `blocked` for ever on something
  already refused.
- **The registry appends permission events, not `session.ts`.** `settle()` appends
  **synchronously**, in the statement after the agent's own promise is resolved, so
  routing a `permission_request` through the queue would put a microtask between the
  two and a client answering inside it could beat its own request into the log.
  Q2.105.
- **Status is derived, never stored.** `ManagedSession.status` is computed on every
  read, so it cannot drift from the pending map. `snapshot()` returns a frozen plain
  object with copied arrays — a frame built now and serialized later must describe
  now.
- **`doStop` uses `exitRecord ??=`.** Stopping a restored session must not rewrite
  `daemon_restarted` as `stopped`.
- **Orphan reaping is fenced by `os.uptime()`.** Pids wrap and a reboot resets them,
  so an older row names a number that now belongs to somebody else.
- **A liveness probe has three answers, not two.** `"alive" | "dead" | "unknown"` —
  `process.kill(pid, 0)` throws `EPERM` as readily as `ESRCH`, and they mean opposite
  things. Anything not `"dead"` is still worth signalling; a boolean `isAlive` makes
  the third answer unreachable *below* the type, which the reaper reaches whenever a
  recorded pid has been recycled.
- **A path probe has three answers**, and the third is not a placeholder.
  `probeExists` returns `true | false | null`; `removeWorkspace` **refuses to `rm` on
  `null`**, because the one `rmSync` here must never run against a path we could not
  even stat. `409 workspace_missing` vs `503 workspace_unresponsive`.
- **Agents spawn `detached` and are killed by process group.** `claude-agent-acp`
  runs the CLI as its own child and cleans up only via `process.on("exit")`, which
  does not run under SIGKILL. This applies to the **login pty** as well.
- **Every RPC that writes to agent stdin is bounded.** The SDK puts no timeout on
  those writes, and in `doDispose` they sit upstream of `client.close()`, the only
  code that ever sends SIGTERM/SIGKILL.
- **An agent handle is a union whose second arm is read-only legacy.** Kept as a
  union rather than flattened to `number` because `toHandle` must answer **no handle
  at all**, which is different from "pid 0". The reaper reports a container handle as
  one it will not signal.
- **Resume is `session/resume`, never `session/load`.** Load replays the whole
  message history back as notifications and we already hold that transcript. The ACP
  *reference* implementation offers only `loadSession`, i.e. only the verb this rule
  forbids, so "any ACP agent" is much narrower than Zed's registry suggests. Q5.85.

## Layout

| File | Holds |
|---|---|
| `src/events.ts` | The `SessionEvent` union (the wire vocabulary), `SessionWorkspace`, `StoredEvent`, `EventStore`, `SessionStore`, `MemoryEventStore`, `SessionLog`, size accounting |
| `src/store/schema.sql` | Tables for sessions, events, agent credentials, the single-row daemon lock. v4: the agent handle is four columns. v5: `title`/`pinned`. v6: `forge_accounts` dropped, `agent_credentials` rekeyed, `owner_subject` left dead |
| `src/store/sqlite.ts` | `openStores`, `SqliteEventStore`, `SqliteSessionStore`, `SqliteAgentCredentialStore` — durability behind the same synchronous interfaces |
| `src/session.ts` | One ACP session: spawn, prompt, cancel a turn, normalized events, clean shutdown |
| `src/registry.ts` | Session lifecycle, derived status, the permission state machine, the turn pump and how a turn is stopped |
| `scripts/daemon.ts` | Entry point: env, signals, logging |
| `scripts/harness.ts` | Pre-daemon CLI that drives `Session` directly. Keep it working: the regression test for the untouched default paths |
| `scripts/daemoncheck.ts` | Offline driver for the daemon's HTTP surface and durable state |

## Bounds

| | |
|---|---|
| Event log | **Unbounded per session.** 128 KiB per event (truncated visibly at the store boundary). `REEMOAT_LOG_EVENTS`/`REEMOAT_LOG_BYTES` still bound it. What bounds the database is whole sessions: 7 days / 200, pruned at startup — which bounds **rows**. Bytes are bounded by `reclaim()`, which `VACUUM`s after a prune once a quarter of the file is free: `auto_vacuum` defaults to NONE and cannot be enabled on an existing database, so without it every deleted transcript kept its pages for ever |
| Sessions on disk | 7 days / 200. `GET /sessions` unbounded by default, takes `?limit=`, reorders blocked-first so a cut drops only rows nobody waits on |
| Sessions running | **64 live, and 16 creations then one per 2 min.** Both are needed: the ceiling bounds what is running, the burst bounds create-and-stop, which walks past a ceiling while still writing the rows the prune deletes. `429` before the cwd is resolved, so a refusal costs no filesystem probe. **Resume is deliberately outside it** — putting an agent back in front of an existing conversation is not manufacturing a session. In memory; `REEMOAT_MAX_LIVE_SESSIONS` and friends move them. Q2.100 |
| WS outbound queue | 8000 events / 16 MiB, with **`ATTACH_REPLAY_MAX` 2000** under the *event* half only — at 128 KiB an event a full replay is 250 MiB, so the byte ceiling still collapses an attach and reports the same `lagged{backlog}` rather than `slow_consumer`. The socket is bounded, the transcript is not |
| `Session.EventQueue` | 2000, evicting only `agent_log`/`other`. Never drop-oldest: dropping `text` or `file_change` yields a contiguous log missing content. **What it bounds is narrow**: a `ManagedSession` attaches a reader between turns, so the unread window is the gap between `adopt` and `onStarted`, plus any bare `Session` (`harness`, the Session-level drivers) where nothing drains between turns at all. Q2.104 |
| Timeouts | start 45s, shutdown budget 20s, cancel-send 1s, session/close 2s, cancel grace 5s **on a dispose** and 1.5s on a turn somebody stopped (what follows the first is SIGKILL, and what follows the second is nothing), exit grace 3s, WS ping 20s, enrollment 15s |
| Agent stderr | 64 KiB per line without a newline, flushed as its own line past that. Every bound downstream is on the *event*, which does not exist until a line does. Q2.101 |
| Session title | 120 chars from a rename, 60 for the derived one. Same reason |
| Auto-resume | 3 attempts per session per **daemon life** (in memory, so a restart tries again — a restart is new information). 2 agents at once. Backoff 2s→60s, **full** jitter. Failure on the snapshot capped at 64 chars of code and 512 of message |
| Shutdown | 20s graceful, then a **bounded** 3s parallel SIGKILL sweep, inside `daemon.ts`'s 25s hard exit |

## Known gotchas

- **A crashed daemon *does* strand its agents.** A `detached` child survives its
  parent, which is what the reap path and the `os.uptime()` fence are for.
- **`pkill -f "tsx scripts/daemon.ts"` matches nothing.** The real command line is
  `…/tsx/dist/cli.mjs scripts/daemon.ts`, so that pattern kills no daemon and the next
  one refuses to start on the database lock. Kill by pid.
- **Port 7777 is taken** by a Plane container stack with `restart=always`. Both
  `DEFAULT_PORT` and the client's `REEMOAT_URL` fallback are 7887 for that reason.
- **The slow-consumer collapse path is untested on the daemon side** — producing it
  needs real TCP backpressure. The eviction path is verified, and `webcheck` covers the
  client's half: a 4003 close backs off and does **not** mark the machine unreachable.
- **`@hono/node-ws` peers on `@hono/node-server` ^1.x**, not 2.x.
- **`ADD COLUMN ... NOT NULL` needs a `DEFAULT`, and `owner_subject` deliberately has
  none.** `pinned` has `DEFAULT 0`, which is also the honest value; for an owner there
  is no honest default, so that column is nullable.
- **Adding a column to `sessions` needs `migrate()`, not `schema.sql`** — that file is
  re-applied on every open and is all `CREATE ... IF NOT EXISTS`, idempotent for whole
  tables and useless for a new column. `migrate()` decides from `PRAGMA table_info`.
  New *tables* need nothing.
- **`node:sqlite` needs `--experimental-sqlite` on Node 22**, which is why `engines` is
  `>=24`.
- **Two daemons on one database file** is refused by the single-row `daemon` table,
  checked before restore — otherwise each would reap the other's agents.
- **The daemon crashes with a raw `EADDRINUSE` stack** if the port is taken. Not fixed.
