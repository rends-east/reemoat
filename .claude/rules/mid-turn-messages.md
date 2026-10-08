---
paths:
  - src/registry.ts
  - src/session.ts
  - src/acp/client.ts
  - src/server.ts
  - packages/web/src/ui/Composer.tsx
  - packages/web/src/ui/composing.ts
  - packages/web/src/ui/EventList.tsx
  - packages/web/src/ui/SessionView.tsx
  - packages/web/src/attach.ts
  - packages/web/src/echo.ts
  - packages/web/src/wire.ts
  - scripts/daemoncheck.mid-turn-messages.ts
---

# A message sent while the agent is working

`daemon-sessions.md` holds what a turn is; this file, what happens to a message that
arrives inside one — half the daemon's, half the composer's. Q2.226, Q2.227, Q3.600,
Q3.601, Q6.107.

## Which door the message goes through

**The agent decides, on `initialize`.** Where `_meta.steering.supported` is `true` the
daemon sends the ACP extension `_session/steering` into the running turn; otherwise
`ManagedSession` holds the message and hands it over the instant the turn ends. Both
answer `202` with the same `seq`, distinguished by `steered`/`queued`.

- **`_meta` is the top-level one, a sibling of `agentCapabilities`**, never inside it:
  claude also sends `agentCapabilities._meta.claudeCode.promptQueueing` one key away,
  and the wrong bag is silent. `AcpClient.supportsSteering` tests `=== true`, for
  `acceptsImages`' reason.
- **Who serves it** (installed binaries): claude-agent-acp 0.73.0 and codex-acp 1.8.0
  yes; kimi 0.29.2 (no `_meta`, no `_session/*` method) and cursor 2026.09.28 no;
  opencode unmeasured. The agent serves it, so a new adopter lights up with no code
  change. Q6.107.
- **An injection is not a second turn.** The original `session/prompt` resolves once,
  `end_turn`: no second response, no second `turn_end`, so `pump` is unchanged. claude
  pre-empts its answer for the injected message; codex finishes first, then takes it.
- **A steer with no turn running starts one** with no `session/prompt` to resolve, so
  `Session.steer` always sends `idleBehavior: "promptRequired"` (the race answers
  `prompt_required` instead) and `sendMidTurn` steers only while it holds a turn.
  `started_new_turn` survives as an arm, reported through `onWarning`; `startIdleDrain`
  still reads its events.
- **A second `session/prompt` is never the mechanism**: claude queues it FIFO
  (`turnQueue`), codex supersedes the first (`activePrompt`), abandoning a live turn.

## The daemon

**`prompt` splits `busy`.** A `/clear` or a restart (agent unaddressable) stays `busy`,
`409 turn_in_flight`. A turn (agent working) is its own `turn_in_flight` arm: it appends
nothing and the route goes to `sendMidTurn`, async because a steer is an RPC. `prompt`
stays synchronous by contract, its guard an assignment before any await.

**A `prompt` event is written when the daemon accepts a message, never again on
delivery** — the seq the client settles its echo against. Whether it is still waiting
rides the snapshot (`queuedPrompts`), as `cancelRequestedAt` does.

**Delivery is the last statement in `pump`'s `finally`**, after `onAgentUnusable`, so a
restart armed there takes the queue rather than a turn being armed on the agent being
replaced. `whenRestarted` and `clearContext` call `deliverQueued` too, or a message
queued before either window waits for a turn nobody starts. A queued message survives a
`/clear` into the fresh conversation.

**The queue is in memory.** A daemon restart drops it (as Q2.12); the transcript shows
the message unanswered. A stop is reported: `doStop` writes one `error` event counting
what never arrived (Q2.218). An agent restart (`restartAgent` → `stop("config_changed")`)
is not a stop: the queue is kept for the three reasons `autoResumable` calls the
daemon's own doing.

**After `sendMidTurn`'s awaits (`blocksFor`, `steer`) exactly these are re-taken**: the
terminal/stopping pair, the bound (concurrent sends could each pass it at zero), and for
another agent's message the switch (`peerDrop`, bumped by `dropQueuedPeer`; Q2.244).
`clearing`, `restarting` and a vanished session are not; `clearContext` and
`whenRestarted` calling `deliverQueued` on their way out is what rescues the push there,
and is load-bearing. So the `prompt_required` arm sits below the re-check and names
`clearing`/`restarting` itself, or a `/clear` begun in that window arms a turn on the
ACP session `clearContext` just abandoned. A stop there needs no arm: `doStop` disposes
the session, rejecting the held steer.

**A restart that cannot come back pays the drop itself.** If `resume()` throws,
`restartAgent`'s `deliverQueued` lands on a null session, and the entries would ride
`queuedPrompts` on a terminal session for ever. `dropQueuedUndelivered` is the debt both
`doStop` and that `finally` pay; `stoppedBeforeDelivery` the one sentence both write.

**A cancel ends the turn, then the queue delivers**, so *type the correction, press
Stop* is one gesture that steers a queueing agent (what `revising` does for a plan
card). No control takes a queued message back, by decision (the owner's, matching
Claude Code): the turn ending ends the wait; stopping the session discards it, and says
so in the transcript.

**A cancel the agent never honours replaces it.** `WEDGED_CANCEL_MS` (15 s) after a turn's
first cancel, if the turn is open, `replaceWedgedAgent` ends it as `cancelled`
(`abandonTurn`) and runs `restartAgent`, so the queue goes to the resumed process, never the
wedged one. A turn ending sooner disarms it. Not while live background work is reported (the
restart kills the process group), and a person's stop landing during the replacement's own
stop is the exit that stands (`stopDuringRestart`), never resumed. Q2.255.

**`parkable` reads the queue** — the eighth caller of "one process boundary at a time":
between a turn's end and the drain `status` is `idle` over a session owing an answer, and
neither age threshold defends it.

## The composer

**The send slot follows the draft, not the turn.** `slotSends` is
`sendable(text, attachments, sendRefused)`; `stoppable` is
`(canCancelTurn(session) || echo !== null) && !revising && !slotSends && !draftAnswerable`.
`canSend` trims, so whitespace leaves Stop where it was. One predicate, `sendable` —
never a separate "draft present" check, which drew a disabled Send over a live turn and
removed the only turn-cancel. Send is drawn when it would work; Stop holds the slot
otherwise. `slotOccupant` is that decision; the swap is `web-composer.md`'s. Q3.654.

- **A message on its way is work from the moment it leaves the box**: the echo counts.
  A Stop pressed before the daemon answered waits for it (`sendsInFlight`) — until then
  there is no turn and the daemon says `not_ready`. Q3.700.
- **One exception, a refusal about the draft**: `draftAnswerable`
  (`!sessionRefused && !slotSends`, box not empty) hands the slot to a disabled Send with
  its own sentence — an attachment uploading, one that failed, `/clear` typed mid-turn.
  `!sessionRefused` keeps Stop against a daemon too old to take a mid-turn message.
- **`/clear` is refused mid-turn by the daemon, so here too**: the route performs it and
  `clearContext` refuses while a turn is in flight, the agent works unprompted, or a
  request waits — so `clearRefused` reads `canCancelTurn`, not `turn` (Q2.232). Its own
  clause, so the sentence has a control to sit on.
- **Stop is unreachable while the draft is sendable.** The escalation for a turn that
  will not stop is the session menu. Where the draft is not sendable, Stop stays.
- **`sendRefused` is what is left of the old gate**:
  `session.status === "stopping" || (!acceptsMidTurn(session) && (blocked || working))`;
  `stopping` stands on every daemon (`stopRequested` answers `409 session_terminal`).
  `webcheck` pins all four clauses as source text.
- **`composerPlaceholder`'s `blocked` line is ungated**: a parked request keeps the
  agent waiting, steered or not. `blocked` implies `!working` (`showsWorking` carries
  `!needsHuman`), so no fixture may set both. The six placeholders are pinned by value.
  Q3.602.

**The transcript says which happened.** A `prompt` row whose seq is in `queuedPrompts`
draws `Waiting for the agent to finish`; a steered one draws nothing. Not the `pending`
marker `Bubble.tsx` forbids: it is the daemon's fact about the agent, and the bubble is
untouched. Q3.601.

**A message sent after Stop goes after the stop**: `send` waits on `stopsInFlight` (the
mirror of `sendsInFlight`), then for `cancelInFlight` to clear, at most `STOP_HOLD_MS`; the
echo draws meanwhile. So it is a new turn logged after `cancelled`, never queued into the
turn being torn down. Q3.701.

**A pinned conversation moves one way only while sending into talk** (Q3.653):

- `claimEcho` takes the echo in the commit its own event lands in: the first `prompt`
  past `sendFloor` with the same text and files in order — text is safe only with that
  floor.
- `deliversQueued` counts a waiting message as work for the transcript only (the pump
  fans a turnless snapshot before `deliverQueued`); `Composer` still reads
  `showsWorking`.
- `keepsFootSlot` keeps the working line's `h-5` inside the column's 48px foot while
  silent, except under a card (pads its own foot) and a cancel, whose row takes the
  place (Q3.437).

**`QueuedContext`'s identity is part of the contract**: a fresh `Set` prop defeats
`TailRow`'s memo, and `queuedSeqs` builds one per call, so `SessionView` memoises it on
the seqs; empty stays one identity.

## Work nobody prompted (Q2.233)

**claude works with no turn of ours when its background work comes back.** `Session`
lights `unpromptedSince` when the agent's text, thought, tool call, plan or request
arrives with no `session/prompt` in flight — on arrival in `onUpdate`'s order, never from
the drain. A subagent's step lights nothing, nor does a message chunk a numbering agent
left unnumbered: its adapter's own notice (claude's *Task stopped by user*), with no cycle
behind it to end (Q2.256). That one is logged as `1 task stopped`, since the adapter
names the task by its whole command (Q2.257). It ends on the `usage_update` claude sends
after every SDK result carrying `_meta["_claude/origin"]` (`marksCycleEnd`, any origin,
one cycle at a time), the answer to a prompt of ours, a `/clear`, the process going, and
the silent-turn clock (`daemon-bounds.md`). Latched on the first marker the agent sends,
so agents that send none are never tracked.

**It reads as working everywhere a turn does.** `status` is `running`, so `parkable`,
`takesCredentialChange` and `clearContext` refuse it; `wedged` reads `turn` itself. The
snapshot carries `unpromptedSince`; `showsWorking`, `canCancelTurn` and `workStartedAt`
read it, and an older daemon omits it. Widening `showsWorking` refuses no Send: the
`working` clause of `sendRefused` sits behind `!acceptsMidTurn` (`daemoncheck` pins the
pair). A message sent now is an ordinary `prompt`, which claude queues behind the cycle.

**Stop works without a turn.** `cancelTurn` with unprompted work or a parked request runs
send, sweep (`turn_cancelled`), watch and answers `cancelled: true, turn: null`
(claude-agent-acp 0.73.0's `cancel()` interrupts the query regardless).
`cancelRequestedAt` is set and cleared when the work ends; `armTurn` clears a stale one,
or `pump`'s cancel-before-prompt check ends the next message unsent. A cancel nothing
answers is read as ended `WEDGED_CANCEL_MS` after the first (`watchUnpromptedCancel`):
nothing written, nobody replaced, live background work no hold (Q2.256).

## What deliberately did not change

**A plugin's `sessions.prompt` is still refused mid-turn as `session_busy`.** `api.ts`
builds its error from `result.kind`, and the code is plugin-visible with no version
negotiation. A plugin prompt's origin claim is spent on the next `turn_end`, and a
steered message produces none; letting a plugin steer needs the claim to learn about
messages that are not turns.

## Compatibility

Daemons first, then the control plane carrying the web client (`compatibility.md`).
`midTurnDelivery` is absent on an older daemon, `acceptsMidTurn` answers `false`, and the
composer keeps every old gate. It branches on that capability, never a version.

## Layout

| File | Holds |
|---|---|
| `src/acp/client.ts` | `supportsSteering` |
| `src/session.ts` | `STEER_METHOD`, `STEER_TIMEOUT_MS`, `SteerOutcome`, `Session.steer` — the one place the extension is spoken |
| `src/registry.ts` | `MidTurnResult`, `QueuedPrompt`, `MAX_QUEUED_PROMPTS`, `sendMidTurn`, `armTurn`/`recordPrompt`/`runTurn`, `deliverQueued`; a mention note (Q2.246) rides as the steer's extra blocks, `QueuedEntry.note` |
| `packages/web/src/attach.ts` | `canSend(…, refused)`, `refused` being `Composer`'s `sendRefused` |
| `packages/web/src/wire.ts` | `QueuedPrompt` (named as in `registry.ts` for the hand-mirror sweep), `acceptsMidTurn`, `queuedSeqs`, both failing toward the old behaviour |
| `scripts/daemoncheck.mid-turn-messages.ts` | Stubs that steer, that do not, and that advertise then refuse: never lost, never doubled, one `turn_end` per turn |

## Bounds

| | |
|---|---|
| Queued prompts | **8 per session** (`MAX_QUEUED_PROMPTS`), weighed as `queuedPrompts.length + midTurnAccepted` — a reservation before the first await, so a ninth concurrent steer is refused too. Checked before anything is appended: a refused message leaves no `prompt` event. `429 prompt_queue_full` |
| Steering | One RPC, **10s**; a timeout degrades to the queue. That is the one window where a message can be duplicated, written at the constant rather than solved |
