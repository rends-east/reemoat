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

## Every bound the daemon holds, and what moves each

Split from `daemon-sessions.md` by subject when it reached `docscheck`'s `MAX_RULE_CHARS`
(whose docblock says split, never raise again); same globs, so both arrive together.

| | |
|---|---|
| Event log | **Unbounded per session**; 128 KiB per event, truncated visibly at the store. The database is bounded by whole sessions: `prune()` at startup, every id reported (Q2.222). That bounds rows; bytes by `reclaim()`, which `VACUUM`s once a quarter of the file is free |
| Sessions on disk | Only inactive rows are pruned — ended by a person or the agent, never started, or given up on; never a live, daemon-ended or `parked` row (Q2.224). Idle 7 days / 200 of them; never under 50. `GET /sessions` is unbounded by default, takes `?limit=`, orders blocked-first so a cut drops only rows nobody waits on |
| Sessions running | **64 live, and 16 creations then one per 2 min** (the burst bounds create-and-stop). **Releases rather than refuses**: a wake or create takes the least recently used idle slot, by need; with none, a wake goes one over and a create answers `429` before the cwd is resolved. Counts agents resident. In memory; `REEMOAT_MAX_LIVE_SESSIONS`. Q2.100, Q2.224 |
| Idle agents | **Released after 30 min of quiet**, on by default; never while claude reports live background work (Q2.228). Swept each minute. `REEMOAT_IDLE_PARK_MINUTES`, `0` off (sweep and eviction); a value saved via `PATCH /settings` overrides it without a restart, being the user's. Q2.224, Q2.225 |
| WS outbound queue | 8000 events / 16 MiB. `ATTACH_REPLAY_MAX` 2000 is under the event half only, so the byte ceiling still collapses an attach, reported as `lagged{backlog}`, not `slow_consumer`. The socket is bounded, the transcript is not |
| `Session.EventQueue` | 2000, evicting only `agent_log`/`other`, never drop-oldest. Unread only from `adopt` to `onStarted`, and in a bare `Session` (`harness`, Session-level drivers). Q2.104 |
| Timeouts | start 45s, shutdown budget 20s, cancel-send 1s, session/close 2s, cancel grace 5s on a dispose (then SIGKILL) and 1.5s on a stopped turn (then nothing), exit grace 3s, WS ping 20s, enrollment 15s |
| Agent stderr | 64 KiB per line without a newline, then flushed as its own line; every downstream bound is on the event, which needs a line. Q2.101 |
| Session title | 120 chars from a rename, 60 for the derived one |
| Session nickname | 2–32 chars, one per machine over every row held and every create in flight; `NICKNAMES` first, then the first free `-2`, `-3`. Q2.245 |
| Open `ask_question` | **One per session**, refused in words past it; kept on the row (`open_question_json`) until answered, dismissed or the person's Stop (Q2.250). Held open **50 s** (`ASK_WAIT_MS`), under cursor's 60 s MCP limit; past it the answer goes as a message. Q2.251 |
| Sent files | **100 MiB** each, **100 files / 1 GiB** per session, oldest out first, on a budget and rate window of their own. One `send_file` copy at a time per session, given up after **45 s** or with its call. Q2.252 |
| Mentions | 8 distinct `@names` per message resolved into the note; the rest stay text. Q2.246 |
| Auto-resume | 3 attempts per session per daemon life (in memory). 2 agents at once. Backoff 2s→60s, full jitter. Failure on the snapshot capped at 64 chars of code, 512 of message |
| A cancel nobody honours | **15 s** after a turn's first cancel (`WEDGED_CANCEL_MS`), then the turn ends `cancelled` and the agent is replaced, keeping the conversation and the queue; never over live background work. Drivers set it via `setSessionLimits`; no env. Under claude's own 30 s floor. Q2.255. The same bound ends cancelled work no turn holds, replacing nobody. Q2.256 |
| A silent turn | **Given up after 3 h with nothing from the agent**, on by default; `REEMOAT_TURN_SILENCE_MINUTES`, `0` off, env only. The agent's clock (`lastAgentActivityAt`), never the session's. Same minute as the park, park first. Only while `status` is `running`: never on an unanswered question or while claude reports live background work. Q2.231. The same clock and bound end work nobody prompted (`unpromptedGoneQuiet`), writing nothing and settling no request. Q2.233 |
| Background tasks | **32 rows** per session (`MAX_TRACKED_ASYNC_TASKS`), live and earlier finished together; the live agent wins an id, oldest-finished go first. On disk only finished rows, in `agent_state_json` under their own **32 KiB** (`MAX_KEPT_TASKS_CHARS`), rows kept whole, so the controls keep their 64 KiB. Q2.228, Q2.234 |
| Shutdown | 20s graceful, then a bounded 3s parallel SIGKILL sweep, inside `daemon.ts`'s 25s hard exit |
