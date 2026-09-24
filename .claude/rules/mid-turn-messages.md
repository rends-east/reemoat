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

**Split out of `daemon-sessions.md`, which was nine characters from its ceiling.**
That is the honest reason and it is also the right one: half of this subject is the
composer's and half is the daemon's, and neither file could hold the other's half.
What stays there is what a turn *is*; what is here is what happens to a message
that arrives inside one.

⚠ **Until 0.8.0 this was one refusal.** `ManagedSession.prompt` answered `busy` on
`this.turn !== null`, the route made that `409 turn_in_flight`, and the composer
refused Send — so the only way to correct an agent mid-run was Stop, which ends the
turn and throws away what it had half-done. Q2.226, Q2.227, Q3.600, Q3.601, Q6.107.

## Which door the message goes through

**The agent decides, and it says so on `initialize`.** Where
`_meta.steering.supported` is `true` the daemon sends the ACP extension
`_session/steering` and the message goes **into the turn already running**; where it
is not, `ManagedSession` holds the message and hands it over the instant the turn
ends. Both answer `202` with the same `seq`, distinguished by `steered`/`queued`.

⚠ **`_meta` is a *sibling* of `agentCapabilities`, not a member of it**, and
reading the wrong bag is silent: claude also sends
`agentCapabilities._meta.claudeCode.promptQueueing`, one key away.
`AcpClient.supportsSteering` reads the top-level one, `=== true` rather than
`!= null` for `acceptsImages`' reason.

**Measured 2026-09-11 on the installed binaries** — claude-agent-acp 0.73.0 and
codex-acp 1.8.0 advertise it; kimi 0.29.2 sends no `_meta` at all and declares no
`_session/*` method; opencode is unmeasured and has no adapter package to read.
So the split is real fleet behaviour rather than a formality, and nothing here can
change it: `_session/steering` is served by the **agent**. If Moonshot adds it, the
probe lights up with no code change.

**An injection is not a second turn, and the whole feature rests on it.** Measured
on both adapters, prompting for a long essay and injecting into it: the original
`session/prompt` stays open and resolves **once**, `end_turn`. No second response,
no second `turn_end`, so `pump`'s accounting needed no change. claude pre-empts
(drops the essay, answers the injected message); codex finishes first and takes it
after. Both are honest; the difference is the agent's.

⚠ **A steer with no turn running is the dangerous case.** It *starts* one — with no
`session/prompt` to resolve, so nothing would ever hand this daemon a `turn_end` for
it. `Session.steer` therefore always sends `idleBehavior: "promptRequired"`, the
adapters' opt-in that makes the same race answer `prompt_required` instead, and
`sendMidTurn` only steers while it holds a turn. `started_new_turn` survives as an
arm anyway, reported through `onWarning`, for an adapter that ignores the opt-in;
the events are not lost with it, because `startIdleDrain` is already reading.

**A second `session/prompt` is never the mechanism**, whatever an adapter would do
with it: claude queues one FIFO (`turnQueue`) and codex *supersedes* the first
(`activePrompt`), silently abandoning a live turn. One call, two meanings, and one
of them destructive.

## The daemon

**`prompt` splits its old `busy` along the line it used to blur.** A `/clear` or a
restart is the agent being *unaddressable* — still `busy`, still `409
turn_in_flight`, every assertion kept. A turn is the agent *working*: its own
`turn_in_flight` arm, appending nothing and sending the route to `sendMidTurn`.
That one is async because a steer is an RPC, and **`prompt` stays synchronous by
contract** — its guard is an assignment made before any await. The route waiting
where the session refuses is `whenRestarted`'s precedent one state over.

**One rule for the log: a `prompt` event is written when the daemon *accepts* a
message**, which is what that event has always meant, and **never a second time on
delivery**. That gives the client a seq to settle its echo against and puts the
bubble where the message was written. Whether a taken message is still *waiting*
rides the **snapshot** (`queuedPrompts`), which is `cancelRequestedAt`'s
arrangement for the identical reason: an event for waiting would put a second row
on screen for one act.

**Delivery is the last statement in `pump`'s `finally`, and the position is the
rule.** It follows `onAgentUnusable`, so a restart armed there takes the queue
rather than a turn being armed on the agent it is replacing. ⚠ The reason it once
gave — an unfenced `sweepPending` beside it — is gone: a turn's end settles no
request any more (Q2.232). `whenRestarted` and `clearContext` call `deliverQueued` too, being two of
the three states it declines in — without them a message queued just before either
window waits for a turn nobody will start. A queued message survives a `/clear` and
lands in the fresh conversation, which is both acts in the order they were asked
for.

**In memory.** A **daemon** restart drops the queue, the same standing the
interrupted turn has (Q2.12), and what survives is the transcript showing the
message with no answer under it. A **stop** is the case that can be reported and
is: `doStop` writes one `error` event counting what never arrived — each queued
message is already a `prompt` with nothing after it, which is exactly Q2.218's "a
message that reached no model".

⚠ **An *agent* restart is not a stop, and `doStop` had to be taught the
difference.** `restartAgent` reaches its process boundary through
`stop("config_changed")`, so an unconditional drop there threw the message away
*and* wrote "the session stopped" into a transcript of a session that had not —
reached from `onAgentUnusable`, i.e. an agent dying or failing to authenticate
**mid-turn**, which is the likeliest turn for somebody to have typed a correction
into. The queue is kept for the three reasons `autoResumable` calls the daemon's
own doing, which is also what makes `restartAgent`'s `deliverQueued` live code
rather than dead.

⚠ **The terminal/stopping pair and the bound are re-taken after `sendMidTurn`'s
awaits — and only those two, which is worth saying rather than rounding up to
"every guard".** `blocksFor` and `steer` are two real suspension points, and a stop
landing inside them used to answer `202 {queued: true}` for a session that was
already terminal — with `doStop`'s own drop having run while the queue was still
empty, so nothing was said, and the entry then riding `queuedPrompts` on every
snapshot of a dead session for ever. The bound is re-read on the same axis, because
on the steer path the push is two awaits after the check and concurrent sends could
each pass it at zero.

`clearing`, `restarting` and a session that went away are **not** re-taken by that
block, and what rescues the queue push in those states is a property of *other*
call sites: `clearContext` and `whenRestarted` each call `deliverQueued` on their
way out. That is load-bearing rather than incidental, so it belongs next to the
guard list and not only at those two call sites.

⚠ **Which is why the `prompt_required` arm sits *below* the re-check and names
`clearing`/`restarting` itself.** It used to answer from inside the steer block,
having re-taken only `terminal`/`stopRequested` — so a `/clear` beginning in that
window (legal: a clear is refused only while a turn is in flight, and the turn had
just ended) armed a turn anyway, and its `session/prompt` went to the ACP session
`clearContext` had **just abandoned**. Reproduced: `202 {accepted: true}` with the
message addressed to the replaced conversation while the daemon held the new one —
verbatim what the `clearing` field exists to prevent. A stop in the same window
needs no arm: `doStop` disposes the session, which rejects the held steer.

⚠ **And a restart that cannot come back pays the drop itself.** `doStop` keeps the
queue for `config_changed`, so `restartAgent`'s `deliverQueued` is the queue's only
way home — and a `resume()` that throws leaves that call landing on a null session
with no other caller able to run. Reproduced: entries riding `queuedPrompts` on
every snapshot of a terminal session for ever, drawing *Waiting for the agent to
finish* under a message in a conversation that had ended, with no event saying
otherwise — and `wakeForPrompt` could revive it, delivering the stale message
**after** whatever was typed next. `dropQueuedUndelivered` is the shared debt both
`doStop` and that `finally` pay, and `stoppedBeforeDelivery` is the one sentence
they both write.

**A cancel ends the turn, and the queue then delivers.** That is the decision
rather than a side effect: it makes *type the correction, press Stop* one gesture
that steers a queueing agent, which is the same act `revising` performs for a plan
card from the other direction. The cost is stated — there is **no way to take a
queued message back**, by decision — so Stop cannot also mean "and forget what I
said", and dropping it there would make "typed it, then pressed Stop" lose the text
in silence.

⚠ **`parkable` reads the queue**, and it is the eighth caller of the "one process
boundary at a time" rule: between the turn ending and the drain, `status` is an
honest `idle` over a session that owes somebody an answer. Neither threshold
defends it — the sweep's half hour and the ceiling's two-minute floor are both
about *age*, and a queue that cannot drain gets older while it waits — so this is
a clause rather than a bet on timing.

## The composer

**The send slot follows the draft, not the turn.** `slotSends` is
`sendable(text, attachments, sendRefused)` and `stoppable` is
`canCancelTurn(session) && !revising && !slotSends`: Stop while the box holds
nothing that would send, Send the moment it holds something that would. Whitespace
is not worth sending — `canSend` trims — so a stray space or tab leaves Stop where
it was.

⚠ **One predicate decides the slot, and it is `sendable` rather than a separate
"is there anything in the box".** A `draftPresent` was written first and taken back
out in review, because the arm it falls through to is itself gated on `sendable`:
every state where the two disagree drew a **disabled Send over a live turn**, which
removes the only turn-cancel this client has. Three of those are ordinary — an
attachment still uploading, one that failed, and a daemon not yet updated, which
`compatibility.md` says *is* the normal fleet between a release and the last owner
running `deploy.sh`. The worst instance is a parked question on such a daemon,
precisely the state `canCancelTurn` is deliberately wider than `showsWorking` to
reach. So: **Send is drawn when it would work, and Stop holds the slot the rest of
the time.** `slotOccupant` is that decision; how one occupant gives way to the next
is `web-composer.md`'s, Q3.654.

⚠ **With one exception, which is a refusal about the *draft* rather than about the
session.** `draftAnswerable` is `!sessionRefused && !slotSends` over a box that is
not empty, and it hands the slot to a **disabled Send** carrying its own sentence:
an attachment still going up, one that failed, and `/clear` typed mid-turn. In all
three the daemon would take a message — this one just is not one it can take yet —
so the remedy is in the box, and Stop appearing there put a destructive control
under a thumb aimed at Send and then swapped itself back when the upload landed.
`!sessionRefused` is what stops this undoing the rule above: against a daemon too
old to take a mid-turn message the person can do nothing about the draft, and the
only turn-cancel this client has must stay.

⚠ **`/clear` is the one text the daemon still refuses mid-turn, and refusing it
here is not optional.** The route carries `/clear` out itself rather than
forwarding it, and `clearContext` refuses while a turn is in flight — deliberately,
because clearing under a running agent means deciding what happens to that turn's
output. The same holds with no turn at all while the agent works unprompted or
waits on a request, so `clearRefused` reads `canCancelTurn` rather than `turn`
(Q2.232). So it still answers `409 turn_in_flight`, and `/clear` is in this client's
own restored command list for **claude**, a steerable agent. Lifting the gate made
"type `/clear` while it works, press Send, red toast" reachable for the first time,
which is verbatim the defect `attach.ts` records this composer shipping once
already. `clearRefused` is a clause of its own so the sentence has a control to sit
on.

**What it costs, said out loud: Stop is unreachable while the draft is sendable.**
Acceptable only because the box is yours and clearing it is one deliberate gesture;
the escalation for a turn that will not stop is unchanged and elsewhere, in the
session menu. Where the draft is *not* sendable — an upload in flight, a failed
chip, a refused session — Stop simply stays, which is what it did before this
feature existed.

**`sendRefused` is what is left of the old gate.** `session.status === "stopping"
|| (!acceptsMidTurn(session) && (blocked || working))` — the old refusal survives
only against a daemon that has not been updated, where it is still exactly what
would happen, and `stopping` stands on every daemon because `stopRequested` answers
`409 session_terminal`. `webcheck` pins all four clauses **as source text**: the
failure mode is silent, and a gate left reading `blocked || working` refuses the one
send this feature exists for.

⚠ **`composerPlaceholder`'s `blocked` line is *ungated*, and it was briefly gated
on the agent being steerable — which was wrong twice over.** The reasoning for the
gate was that a message sent now is taken, so "Answer the request above first"
argues with a live Send. But the instruction is not about the box, it is about the
**turn**: a parked request keeps the agent waiting whatever else happens, so answering
it is still the only thing that lets the agent get anywhere, steered message or
not. The gate was also **unreachable in the direction it mattered** — `blocked` is
`needsHuman` and `working` is `showsWorking`, which carries `!needsHuman`, so
`blocked` implies `!working` and the documented fall-through to `working` could
never fire. What it actually fell through to was the *idle* line, `Type / for
commands`, drawn over a session with a question parked; `webcheck` was green over
it because the fixture set `working: true` beside `blocked: true`, a state
`Composer` cannot construct. The six placeholders stand unchanged, pinned by value,
and the grid is what catches that class now. See Q3.602.

**The transcript says which happened, and only where there is something to say.**
A `prompt` row whose seq is in `queuedPrompts` draws one line, `Waiting for the
agent to finish`. Nothing is drawn for a steered message: it is already in front of
the model, and a status line for something that has already happened is furniture.
⚠ **This is not the `pending` marker `Bubble.tsx` forbids** — that rule is about a
message *this tab* has sent and not had answered, a claim about the network drawn
as doubt over something delivered. This is the daemon reporting a fact about the
agent, it survives closing the tab, and the bubble itself is untouched.

**Sending while the agent talks moves a pinned conversation one way only**, and
three things used to move it back, each measured in WebKit and Chromium (Q3.653):

- **The echo waited for the POST's seq**, and a steered message's `prompt` event is
  fanned out before `session.steer` is even sent, so the socket wins: the message
  was drawn twice for 4–11 frames and the conversation dropped 74–112px when the
  echo went. `claimEcho` takes it in the commit its own event lands in — the first
  `prompt` past `sendFloor` with the same text and the same files in order. ⚠ Text
  is only safe *with* that floor, which also steps past an earlier send's event
  still on the socket; an identical message from another tab inside the window can
  take it early, which is the log's own row replacing it.
- **The pump fans a turnless snapshot out before `deliverQueued`**, so a queued
  message's two snapshots can straddle a frame and the working line blinked out
  and back. `deliversQueued` counts a waiting message as work, for the transcript
  only: `Composer` still reads `showsWorking`.
- **The working line leaving at a turn's end dropped a pinned reader 20px**, and
  the last settled text then pushed them back up. `keepsFootSlot` keeps its `h-5`
  inside the column's own 48px foot while it is silent — except under a card, which
  pads its own foot, and under a cancel, whose row takes that place as it did
  (Q3.437).

⚠ **`QueuedContext`'s *identity* is part of the contract.** A context for
`DecisionsContext`'s reason — a fresh `Set` as a prop is a new identity on every row
on every token, which defeats `TailRow`'s memo entirely — and the half that does not
come free is that `queuedSeqs` builds a fresh `Set` per call, so `SessionView`
memoises it on the seqs. Empty is the common case and stays one identity for a whole
turn.

**No control takes a queued message back**, on the owner's word and matching Claude
Code. What ends a wait is the turn ending; what discards it is stopping the session,
which says so in the transcript.

## Work nobody prompted

**claude works with no turn of ours when background work it started comes back**,
and that is a state now rather than a gap (Q2.233). `Session` lights
`unpromptedSince` when the agent's own text, thought, tool call, plan or request
arrives with no `session/prompt` in flight — on arrival, in `onUpdate`'s order,
never from the drain, which runs behind the end marker. A subagent's step is a
delegation and lights nothing. What ends it: the `usage_update` claude sends after
every SDK result carrying `_meta["_claude/origin"]` (`marksCycleEnd`, any origin,
one cycle running at a time), the answer to a prompt of ours (the agent takes its
input in order), a `/clear`, the process going, and `daemon-bounds.md`'s silent-turn
clock. ⚠ **It is latched on the first marker the agent sends**, so the four agents
that send none are never tracked — a straggler after their turn cannot light a
working line nothing would ever end.

**It reads as working everywhere a turn does.** `status` is `running`, so `parkable`
refuses it, as do `takesCredentialChange` and `clearContext`; `wedged` reads `turn`
itself now that `running` no longer implies one. The snapshot carries
`unpromptedSince`; `showsWorking`, `canCancelTurn` and `workStartedAt` read it, and
an older daemon, which omits it, reads as today. Widening `showsWorking` refuses no
Send, because `sendRefused`'s `working` clause is behind `!acceptsMidTurn` and a
daemon that sends the field is one that takes a message mid-work — `daemoncheck`
pins the pair. A message sent now is an ordinary `prompt`, which claude queues
behind the cycle.

**Stop has something to stop without a turn.** `cancelTurn` with no turn but work
unprompted or a request parked runs the turn's order — send, sweep
(`turn_cancelled`), watch — and answers `cancelled: true, turn: null`, measured off
claude-agent-acp 0.73.0, whose `cancel()` interrupts the SDK's query whether or not
a prompt is running. `cancelRequestedAt` is set for it and cleared when the work ends;
`armTurn` clears a stale one, or `pump`'s cancel-before-prompt check would end the
next message unsent — which is exactly `revising`'s cancel-then-prompt when the plan
was raised outside a turn.

## What deliberately did not change

⚠ **A plugin's `sessions.prompt` is still refused mid-turn, under the word it
always used.** `api.ts` builds its error from `result.kind`, so the split would
otherwise have renamed a plugin-visible code from `session_busy` to
`session_turn_in_flight` — on a surface with no version negotiation at all, and
with nothing holding it. It is also right rather than merely compatible: a
plugin's prompt takes an **origin claim**, spent on the next `turn_end`, and a
steered message never produces one — so it would spend the *current* turn's end
and suppress the hook for a turn it had nothing to do with, which is the
misattribution that machinery exists to prevent. Letting a plugin steer needs the
claim to learn about messages that are not turns.

## Compatibility

**Daemons first, then the control plane**, which carries the web client —
`compatibility.md`'s "whoever has to answer ships first", and this is squarely the
new-behaviour-on-the-daemon row. `midTurnDelivery` is **absent** on an older daemon,
`acceptsMidTurn` answers `false`, and the composer keeps every gate it has today:
today's behaviour, degraded rather than broken. Nothing branches on a daemon
*version*; it branches on a capability the daemon states about itself.

## Layout

| File | Holds |
|---|---|
| `src/acp/client.ts` | `supportsSteering`, the fourth capability shape and the fourth way of reading one |
| `src/session.ts` | `STEER_METHOD`, `STEER_TIMEOUT_MS`, `SteerOutcome` and `Session.steer` — the one place the extension is spoken, with the measurements at the constant |
| `src/registry.ts` | `MidTurnResult`, `QueuedPrompt`, `MAX_QUEUED_PROMPTS`, `sendMidTurn`, `armTurn`/`recordPrompt`/`runTurn` and `deliverQueued` |
| `packages/web/src/attach.ts` | `canSend`, whose third argument no longer means "a turn is in flight" — it is now `refused`, and what is left to refuse is named by `Composer`'s `sendRefused` |
| `packages/web/src/wire.ts` | `QueuedPrompt` (named as `registry.ts` names it, or the hand-mirror sweep never compares it), `acceptsMidTurn` (does the daemon take one at all — what un-gates Send) and `queuedSeqs`. Both predicates fail toward today's behaviour on a daemon that cannot say |
| `scripts/daemoncheck.mid-turn-messages.ts` | Two stubs, one advertising steering and one not, plus the one that advertises and then refuses. What is pinned is that the message is never lost and never doubled: no second prompt on the wire, no second `prompt` event on delivery, one `turn_end` per turn |

## Bounds

| | |
|---|---|
| Queued prompts | **8 per session** (`MAX_QUEUED_PROMPTS`), weighed as `queuedPrompts.length + midTurnAccepted` — a reservation taken before the first await — so it also refuses a ninth *concurrent steer* over an empty queue. Usually empty on a steerable agent, but non-empty whenever a steer fails. Checked **before** anything is appended, because on the steer path the queue is reached only once the steer has failed — a refused message must not leave a `prompt` event nobody will deliver. `429 prompt_queue_full` past it |
| Steering | One RPC, bounded at **10s**. Both adapters answered in single-digit milliseconds, so a timeout means the pipe is not being read at all; it degrades to the queue. ⚠ That is the one window where this feature can duplicate a message, and it is written down at the constant rather than solved |
