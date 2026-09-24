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

**This was the last section of `daemon-sessions.md` and it is a file because that
file hit its ceiling.** `docscheck`'s `MAX_RULE_CHARS` carries the argument: it was
raised once already for this exact file and this exact cause — a feature's
invariants not fitting — and it says what to do the second time, which is that *"a
rule wants splitting by subject, not that this should go up again"*.

**Measured before the split rather than asserted**, because the precedent that
raised the number was itself a measurement and the next person arguing about it
inherits whichever of the two this paragraph leaves behind. Against 34 000:
`daemon-sessions.md` 33 996, `web-shell.md` 33 964, `web-composer.md` 33 912,
`acp-agents.md` 33 884 — four files inside 120 characters, and the one being edited
with **four** of slack. The raise's own criterion was *"five files within 400 chars
of the limit at once"*; four is not five, which is the honest reading, and the
argument does not rest on the count: a file with four characters left cannot record
a new invariant without deleting somebody else's, and that erosion is what the
ceiling exists to prevent rather than to cause.

The subject was already named separately in `CLAUDE.md`'s own table (*"the daemon's
bounds"*), so this is the seam that was already drawn rather than a new one.

The globs are the same on purpose: both arrive together when somebody opens
`registry.ts`. What splitting buys is not *when* they arrive but that each file has
one subject and its own room to grow — a reader asking *what are the limits* reads a
table, and a reader asking *what a restart brings back* reads prose, and neither is
paying for the other's headroom.


| | |
|---|---|
| Event log | **Unbounded per session.** 128 KiB per event (truncated visibly at the store boundary). What bounds the database is whole sessions, `prune()` at startup — the next row, every id reported. Q2.222. That bounds **rows**; bytes, by `reclaim()`, which `VACUUM`s once a quarter of the file is free |
| Sessions on disk | Inactive — ended by a person or the agent, never started, or given up on; never a live, daemon-ended or **parked** row (Q2.224) — idle 7 days / 200 of them; never under 50. `GET /sessions` unbounded by default, takes `?limit=`, reorders blocked-first so a cut drops only rows nobody waits on |
| Sessions running | **64 live, and 16 creations then one per 2 min.** Both are needed: the ceiling bounds what is running, the burst bounds create-and-stop, which walks past a ceiling while still writing the rows the prune deletes. **It releases rather than refuses** — a wake *or* a create takes the least recently used **idle** slot, by need rather than by the sweep's age; with none to take a wake goes one over, a create answers `429` before the cwd is resolved. So it counts **agents resident**. In memory; `REEMOAT_MAX_LIVE_SESSIONS` moves it. Q2.100, Q2.224 |
| Idle agents | **Released after 30 min of quiet**, on by default — never while claude reports live background work (Q2.228). `REEMOAT_IDLE_PARK_MINUTES` moves it, `0` switches off the sweep *and* the eviction. Swept once a minute. Q2.224. A value saved on the machine's settings screen (`PATCH /settings`) **overrides** the variable, without a restart: config is still env only, this is the narrower class the *user* owns. Q2.225 |
| WS outbound queue | 8000 events / 16 MiB, with **`ATTACH_REPLAY_MAX` 2000** under the *event* half only — at 128 KiB an event a full replay is 250 MiB, so the byte ceiling still collapses an attach and reports the same `lagged{backlog}` rather than `slow_consumer`. The socket is bounded, the transcript is not |
| `Session.EventQueue` | 2000, evicting only `agent_log`/`other`. Never drop-oldest: dropping `text` or `file_change` yields a contiguous log missing content. **What it bounds is narrow**: a `ManagedSession` attaches a reader between turns, so the unread window is the gap between `adopt` and `onStarted`, plus any bare `Session` (`harness`, the Session-level drivers) where nothing drains between turns at all. Q2.104 |
| Timeouts | start 45s, shutdown budget 20s, cancel-send 1s, session/close 2s, cancel grace 5s **on a dispose** and 1.5s on a turn somebody stopped (what follows the first is SIGKILL, and what follows the second is nothing), exit grace 3s, WS ping 20s, enrollment 15s |
| Agent stderr | 64 KiB per line without a newline, flushed as its own line past that. Every bound downstream is on the *event*, which does not exist until a line does. Q2.101 |
| Session title | 120 chars from a rename, 60 for the derived one. Same reason |
| Auto-resume | 3 attempts per session per **daemon life** (in memory, so a restart tries again — a restart is new information). 2 agents at once. Backoff 2s→60s, **full** jitter. Failure on the snapshot capped at 64 chars of code and 512 of message |
| A silent turn | **Given up on after 3 h with nothing from the agent**, on by default; `REEMOAT_TURN_SILENCE_MINUTES`, `0` off. Env only — no screen, no stored override. ⚠ The *agent's* clock (`lastAgentActivityAt`), not the session's: a person typing into a stuck session used to reset it. ~3.5× the one measured live silence, 51.7 min, read off the reporting machine's own store. Same minute as the park, park first. Only while `status` is `running`, so never on an unanswered question, and never while claude reports live background work. Q2.231. **The same clock and bound end work nobody prompted** (`unpromptedGoneQuiet`) for an adapter that stops marking a cycle's end — writing nothing, since no turn ends, and settling no request. Q2.233 |
| Background tasks | **32 rows** per session (`MAX_TRACKED_ASYNC_TASKS`), live and earlier agents' finished rows together: the live agent's rows win an id, and the oldest-finished go first. On disk, finished rows only, in `agent_state_json` beside the controls but under **32 KiB of their own** (`MAX_KEPT_TASKS_CHARS`), rows kept whole, so a long list never costs the controls their 64 KiB. Q2.228, Q2.234 |
| Shutdown | 20s graceful, then a **bounded** 3s parallel SIGKILL sweep, inside `daemon.ts`'s 25s hard exit |

