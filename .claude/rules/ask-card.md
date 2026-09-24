---
paths:
  - packages/web/src/ui/AskCard.tsx
  - packages/web/src/ui/PermissionCard.tsx
  - packages/web/src/ui/ElicitationCard.tsx
  - packages/web/src/permission.ts
  - packages/web/src/ask.ts
  - packages/web/src/elicitation.ts
  - packages/web/scripts/webcheck.permission-card.ts
  - packages/web/scripts/webcheck.elicitation-and-links.ts
---

# The card the agent waits on

**Split out of `web-transcript.md`, which was at its ceiling and had been for
several changes running.** That is the honest reason and it is also the right one:
this is a *card*, not the conversation it floats over, and the two had grown to
about equal size under one heading. What stays there is what the transcript draws;
what is here is the one shape every agent's question and every approval get, whether
it arrived as `session/request_permission` or as an elicitation.

Its geometry came with it, because every one of those rules turned out to be about
the card rather than about the region: where it sits, that it reserves its own room
in the scroller, how wide it is, what it does to the transcript's foot. What stayed
is the transcript — `EventList`, `tail.ts`, the diff, the `/clear` cut.

**The ask card.** `ui/AskCard.tsx` owns the frame: where it sits, that it moves
nothing behind it, the collapse, the ✕, the numbered answer rows, the digit
shortcuts. It is `absolute` in a region ending where the composer begins, so
`bottom-0` is the top of the composer, and `inset-0` rather than `bottom-0` is
what *bounds* it — a card anchored to the bottom grows upwards and would paint
over the session header. The frame is `pointer-events-none` and the card
`pointer-events-auto`. **Every option is visible at once** — hiding a reject
behind a disclosure is a safety regression. 44px rows. The spinner is overlaid
rather than replacing the label. De-emphasis in fill and border, never in text.
`essentialContext` and `detailContext` are a **partition**, so nothing is drawn
twice and the disclosure sits *between* them. There is **no scrim** — Q3.39.

**It moves nothing behind it, and the transcript is what makes that survivable.**
Out of flow means the transcript's `ResizeObserver` never sees it, so the last rows
sat under it with no way out — folded too. The card reports `offsetHeight` through
`onHeight` and `EventList` spends it as the foot of its column:
`max(TRANSCRIPT_FOOT_PX, askHeight + ASK_CLEARANCE)`; with no card the working
line's kept room comes out of that 48px (Q3.653). Padding grows `scrollHeight`
and leaves `clientHeight` alone, so nothing drawn moves and the tail scrolls clear.
⚠ **One number, never two that add up** — a second `paddingBottom` on the scroll
box, over a column already ending in 48px, left a 56px hole. It reports from layout
effects, on mount and on every commit, so the room is there in the frame the card
paints; `askHeight` is then a commit of the transcript, which `useFollow` pins.
Q3.583, Q3.587, Q3.649.

**The card is the width of the conversation, and one gutter makes it so.** `COLUMN`
moves to the frame with `px-4`, the transcript's own; the panel is `w-full` in it,
`mx-auto` centring it under `inset-0`. ⚠ **`px-4` is the column's one gutter across
three files** — the card had `px-3` outside its `COLUMN` and so did the composer, so
the card overhung the rows by 32px and the box you type in overhung the card by 8.
`webcheck` compares all three off disk; a comment claimed they agreed. And both panels carry
**`outline-none`**: this `tabIndex={-1}` dialog takes the caret when a request
parks, so the *browser's* ring drew around every question, and `.no-focus-ring` is
not the instrument — `index.css`'s rule never matched it. Q3.587, Q3.589.

**A box you type in draws no ring, and it takes both opt-outs to say so.** A
text control is the opposite case: it *does* match that rule, unlayered, so its
`outline-none` lost and a dark rectangle drew 3px past the row's rounded edge on
every click. ⚠ `.no-focus-ring` alone hands the box to WebKit's own blue ring —
`NO_RING` is the pair, on every typed box, and the caret is the indicator; no
`focus-within` on the row. The mark's target is flush with that edge, so its ring is
drawn on the glyph (`MARK_RING`). Q3.645.

**Cancelling is a ✕ at the top right, in its own group behind a hairline.** It was
there once at `gap-1` — two identical 44px squares, one of which ends the request —
and moved to the footer for that; it is back on the owner's word and the **4px** is
what changed, not the idea (`border-l border-edge/60 pl-1 ml-1`). Open card only.
**The footer is answers only**, so no longer unconditional — a request with no
options is answered by the ✕, which `PermissionCard`'s sentence points at. Q3.584.

**A row says how many answers you may pick, before you have picked one.**
`AskOption.mark` is `"one"` or `"many"`, drawn by `ChoiceMark` as a circle or a
**`rounded-none`** box in a **reserved** slot, out of a `ring` so nothing reflows
(`CHOSEN`'s rule). ⚠ **The radius is spent all the way** — `rounded-sm` is 6px on a
16px box and reads as the circle — and filled they differ too: a tick against a dot.
Absent draws nothing, which is every permission. `many` claims
`role="checkbox"`, which a `<button>` keeps; `one` takes `aria-pressed`, **never**
`role="radio"`, promising arrow-key roving this card does not implement.
`ElicitationCard` sets it on the leader's rows, on a two-select step's hand-rolled
rows, **and on the free-text box under a question** — that box is an answer, so it is
a row in the list: same `askRowTone`, headingless, marked when *counted* rather than
when it holds text. ⚠ **Its mark never waits on the wire**: `questionOf` reads
`alternativeTo` where the agent declares one and the step where it does not, and
gating it on the declaration alone lost the indicator on every daemon not yet
restarted. **One answer is one answer, several are several, nothing typed is ever
erased** — your own answer clears the *selection*, picking clears nothing, and
`elicitationAnswer` stops *sending* an alternative while its question holds a value.
The mark is a `<button>`, so the row is no longer a `<label>` forwarding taps into
the box; off is `ask.ts`'s `excluded`. Q3.586, Q3.591, Q3.592.

**Your own answer takes lines, and Enter follows the composer's rule.** A string with no
`format` is a growing `<textarea>` (`TypedAnswer`, through `fitToContent`, starting
at `rows`: three past 240 characters, else one). A format names one token and stays
an `<input>`, and so does a number. `answerKey`: on a keyboard Enter is Next/Submit, sharing the
button's action and its gate (`advanceBlocked`), and Shift+Enter is the newline; on
a coarse pointer Enter is the newline and the button advances; an IME commit
never advances. ⚠ **The box is borderless inside a bordered one**, because
`fitToContent` writes `scrollHeight`, which leaves a border out. The row is
`items-start`, so the mark stays level with the first line. What is sent keeps its lines, and a
multi-line answer keeps its first line's indentation (`sentText`), which amends Q3.646's
"trim it"; a single line is still trimmed. Q3.652.

**Submit needs something to submit, `Next` owes an answer, Skip says nothing.**
claude-agent-acp marks no `AskUserQuestion` field `required`, on purpose, so an
untouched form raised no problem: Submit sent `{}` and Next walked a three-question
form to its end on blank cards. Two rules, apart because they answer different
questions — `canSubmit` is *no problems* **and** a non-empty body, `stepAnswered` is
per step and reads the **whole** step. Neither invents `required`. The exemption in
both is a form with **no fields**, where accepting *is* the answer. Q3.588, Q3.590.

**A plan is the one payload on that card that is *rendered*, and the gate above it
is what makes that safe.** `context.plan` is read from a `plan` field in the tool's
arguments and drawn through `Markdown` on `bg-raised/50`; everything else keeps the
verbatim `<pre>`, whose rule — *a text block may be the command, so it is never
parsed* — is untouched and still governs every other request. A plan survives only
when the request **authorizes nothing**: no command, no body, no diff, no location,
which is `askedQuestion`'s own test reused, and half of it falls out of
`computeInput`'s early returns. ACP's `switch_mode` kind is deliberately *not* part
of that gate — it rides the `tool_call`, i.e. it is missing exactly when the
transcript has not paged in — and **is** required one level up, where the
consequence is larger. The card takes `size="tall"` for a plan, keyed on
`context.plan` and never on the title. **The plan's own source goes behind
`details`** — `essentialContext` drops the text blocks, `detailContext` puts the
source in their place, and `withheldDetail` gains a clause so a plan with no
`planFilePath` still gets a disclosure. ⚠ The echo test is **trimmed**, because
`pick` trims and a markdown document ends with a newline: 6818 against 6819 drew
the document twice, once readable and once not. Q3.452.

**`planControls` recognises claude's plan-mode options by `optionId`, and that is a
named exception to the rule below rather than a softening of it.** Every approval is
`allow_always` bar one, so ACP's enum separates none of them. Three narrowings make
being wrong free: structure before ids (a plan *and* `switch_mode`), **exact set
equality** within one shape, and `null` meaning today's card. `drawableOptions` is
untouched. Q3.453.

⚠ **`PLAN_SHAPES` is a list because one shape went stale in silence** — measured
under claude-agent-acp 0.63.0, renamed wholesale by 0.73.0, so the curation answered
`null` on every plan request while `webcheck` stayed green over a fixture no pinned
adapter sends, and the fallback's long labels took the card to `rows`. Four entries:
0.73.0's three variants and 0.63.0's five. Q3.585.

⚠ **Every shape draws exactly two buttons, and neither is a refusal.** The elevated
grant the adapter picked, then that grant with the context cleared as the filled
primary — one question with one axis. Four wrapped on a 390px phone into the room
the plan itself needed, which is the same defect `PLAN_SHAPES` was written to fix
arrived at from the other side. **What is dropped is stated rather than implied**:
`reject` and `exit-plan-default`, asserted by name, so that dropping a *third* one
day cannot pass as "still two buttons". `shape` is still the whole request and still
matched exactly; `order` is what is drawn, and the gap between them is the only
place anything is dropped. **This reverses Q3.470's "nothing is deleted" for this
one card** — curation on a measured shape rather than a length rule, with `null`
still meaning the agent's own buttons. Q3.594.
⚠ **Between turns it draws one.** A plan raised with no turn held (`outOfTurn` on
the snapshot) loses the shape's `clearing` grant and the elevation is filled:
0.73.0 cannot restart into a cleared context outside a turn, so that press would
stop claude and continue nothing. No field from an older daemon means today's card.
Q2.232.

**Neither is given up as a capability, and that is the whole argument.** Declining
has two routes on screen: the ✕ settles the request `cancelled`, and the message box
declines *with a reason*, which is the one somebody actually wants — a plan is
refused because of something in it. ⚠ **They are not the same message to the model**:
`reject` reaches claude as a deny reading *"User chose to keep planning"*, a
`cancelled` outcome as an aborted tool call. So the composer is the good decline and
the ✕ is the abrupt one, and `revising` had better work — see below. Per-edit
approval is a session mode the agent republishes as an `agent_config` control, so
the composer's own strip sets it back after a broader grant. `leading` is still
computed from the kind rather than dropped to `false`: no shape carries a refusal
today, and a measured one that does must not land on the right beside the primary.

**"What to change" is written in the message box, and the card has no control for
it.** ACP has no field for text on a permission response, so a correction cannot
ride the answer — and every control that tried built a second message box above
the one this app already has. Instead the **composer takes over** while a plan is
on screen: `revising` reaches it from `SessionView`, which is the only place the
pending permission and the transcript are both in scope. The placeholder says *say
what to change…*, `sendRefused` lifts, `stoppable` yields the Stop slot to Send,
and `parked` stands down so the blur rule does not take the caret from somebody
just invited to type. Sending **cancels the turn, then prompts**, because this path
never presses reject: it sends while the permission is parked and the turn is in
flight, and a prompt inside a turn is `409 turn_in_flight`. ⚠ The anecdote that used
to justify it — *a refused plan does not end the turn* — was measured on 0.63.0 and
is stale: 0.73.0 answers `reject` with `deny(…, interrupt: true)` and its own
comment says that stops the ACP turn. The ordering survives; the reason for it
changed under an adapter bump. ⚠ **With no turn at all it is the same call**:
claude raises plans between turns, and the daemon's cancel dismisses one parked
there rather than answering `no_turn` over it (Q2.232). All four flags are pinned as source text; a gate left reading
`blocked || working` refuses the one send this state exists for. ⚠ **`awaitingPlan`
is computed above `SessionView`'s guard clause and must stay there** — it holds a
`useMemo`, and below the `if (row === undefined)` return it ran on some renders and
not others, which is React #310 the moment a cold-opened session's row lands.
Nothing else in this repository catches that: no eslint, `tsc` does not model hook
order, `webcheck` has no DOM — so `webcheck` reads the file instead. Q3.454.

⚠ **And it reads `transcript?.events ?? []`, exactly as the card beside it does.**
It gated on `events !== undefined`, and `openSession` returns *without* creating a
transcript when the machine has no connection — the cold open `PermissionCard`'s own
comment describes. So on that path the plan was drawn and the composer under it said
*answer the request above first* about the request it is the answer to.

⚠ **And that state is the *worst* card, not a ✕-only dead end — the first version of
this paragraph had it backwards.** `planControls` needs `kind === "switch_mode"` and
the kind rides the `tool_call`, so with no window the curation answers `null`, the
two curated buttons are never drawn, and the fallback puts every option the agent
sent on screen — refusal included — as rows in its own 46-character wording. Which
is the layout the curation exists to avoid, with the box that says *what to change*
switched off over it. The plan comes off the snapshot; an empty window costs the
markdown, never the state. Q3.595.

**The number beside an answer is a keyboard shortcut, so it is not drawn on a
touch device.** `pointer-coarse:hidden`, keyed on the **pointer and never on a
breakpoint** — `sm:` would claim a narrow desktop window has no keyboard. The
handler is untouched: a tablet with a bluetooth keyboard still answers on `2`.

**A row of buttons carries its meaning by position, so an option that cannot be a
button gets a different layout — never a deletion.** With the colour removed, what
says which button is which is *where it is*: the refusal alone on the left, the
reversible approval filled on the right — and the halves are **nested groups rather
than one row with a `flex-1` spacer**, because a spacer only spaces the line it is
on and any wrap at all dissolves the rule silently.

`permissionLayout` is the decision, and it is one rule: *by length, never by id* —
nothing knows the string `accept_execpolicy_amendment`, because recognising an
option by its id or its wording is the guessing this codebase refuses everywhere.
Past `BUTTON_LABEL_MAX` on any **approval's** rendered label the card draws `rows`
instead, which is the arrangement it already uses for a question. A refusal never
decides it: alone in its group it has no sibling to line up against, so a long one
is a wide button and nothing worse. **The positional rule travels with the switch**
— `permissionButtons` still orders refusals first and still names one `primaryId`,
and `OptionRow` draws that one filled.

⚠ **This replaced `drawableOptions`, which deleted the option instead, and the
reversal is Q3.470.** That function was narrowed four separate ways and every
narrowing was a case where deleting lost something: claude's path-scoped
`allow_always` was the only one on its card, an over-long `allow_once` handed the
filled button to the *permanent* grant, and kimi's `AskUserQuestion` arrives down
this channel — so two of four **model-written answers** went with nothing said.
Measured over the live log, five of fifteen real option labels exceed the ceiling.
A layout is this app's problem and an option is the agent's. Q3.92, Q3.470.

**Two options of one `kind` is why the labels there are the agent's own.**
`optionLabel` substitutes our word only when the kind identifies the option;
codex's two `allow_always` entries would both read "Always allow", which is the one
rendering that must never happen — the scope is the whole difference between them.
`webcheck` pins that it does. **A plan's options keep their names too**
(`optionLabel`'s `plan`): a kind's word describes a grant, and grok's two distinct
kinds would read *Allow once* and *Deny* over *Approve plan* and *Abandon plan*.
`planControls` still curates claude's alone; grok's card is its own two buttons,
and `revising` reaches it through `context.plan` like any plan. Q2.235.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/permission.ts` | What is actually being approved, from the request and from the log — not the diff, which is `diff.ts`'s |
| `packages/web/src/elicitation.ts` | A question as controls somebody can fill in: the field union, the draft rules, and `elicitationAnswer` — the request body and the `canSubmit` in one pass. Reads no field name, ever |
| `packages/web/src/ask.ts` | What the ask card holds: a half-filled form, which question is on screen, whether the card is folded — keyed by the *request*, not the session |
| `packages/web/src/ui/AskCard.tsx` | The one card for "the agent is waiting on you", whichever way it asked. Two bodies go inside it and neither knows what the other is |
| `packages/web/src/ui/ElicitationCard.tsx` | The question's body. Renders generically, which is what makes it right for an MCP schema as well as `AskUserQuestion` |
