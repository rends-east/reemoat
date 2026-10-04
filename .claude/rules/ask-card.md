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

One shape for every question and approval, whether it arrived as
`session/request_permission` or as an elicitation. `ui/AskCard.tsx` owns the frame; its two
bodies, `PermissionCard` and `ElicitationCard` (generic, so an MCP schema renders as well as
`AskUserQuestion`), know nothing of each other. `permission.ts` is what is being approved;
`elicitation.ts` the form, reading no field name ever; `ask.ts` the card's state, keyed by
the request, not the session.

**The frame**: position, the collapse, the ✕, the numbered answer rows, the digit
shortcuts. It is `absolute` in a region ending where the composer begins; `inset-0`, not
`bottom-0`, bounds it so it cannot grow over the header. Frame `pointer-events-none`, card
`pointer-events-auto`. Every option is visible at once; never hide a reject behind a
disclosure. The spinner overlays the label. De-emphasis in fill and border, never text —
except that rows fade (`typing`) while somebody types their own answer under a finger, still
drawn and live. Q3.695. `essentialContext` and `detailContext` are a partition, the
disclosure between them. No scrim. Q3.39.

**Nothing a person taps to answer an agent is under 44px**: a mis-tap here approves,
refuses or submits. `webcheck` scans the class strings of `AskCard`, `PermissionCard` and
`ElicitationCard` for a 44px signal. Not app-wide: a link in a sentence, a `<summary>` and
the two disclosure folds rightly stay smaller (Q3.632). A control routed through
`IconButton` is not scanned; the primitive adds `tap` and has its own entry.

**It moves nothing behind it**: the card reports `offsetHeight` via `onHeight`, and
`EventList` spends it as its column's foot,
`max(TRANSCRIPT_FOOT_PX, askHeight + ASK_CLEARANCE)`; with no card the working line's kept room comes out of that 48px (Q3.653).
Padding grows `scrollHeight`, not `clientHeight`, so nothing moves and the tail scrolls
clear. One number, never two that add up (no second `paddingBottom` on the scroll box). It
reports from layout effects, on mount and every commit; `askHeight` is a transcript commit,
which `useFollow` pins. Q3.583, Q3.587, Q3.649.

**The card is the conversation's width**: `COLUMN` moves to the frame with `px-4`; the panel
is `w-full`, `mx-auto` under `inset-0`. `px-4` is the column's one gutter across the
transcript, the card and the composer; `webcheck` compares the three off disk. Both panels
carry `outline-none`: the `tabIndex={-1}` dialog takes the caret when a request parks, and
`.no-focus-ring` does not match it. Q3.587, Q3.589. A box you type in needs both opt-outs,
`NO_RING` (`.no-focus-ring` alone leaves WebKit's blue ring); the caret is the indicator,
no `focus-within` on the row; the mark's ring is drawn on the glyph (`MARK_RING`). Q3.645.

**Cancelling is a ✕ at the top right**, in its own group behind a hairline
(`border-l border-edge/60 pl-1 ml-1`), open card only. The footer is answers only, so not
unconditional: a request with no options is answered by the ✕, which `PermissionCard`'s
sentence points at. Q3.584.

**A row says how many answers you may pick**: `AskOption.mark` is `"one"` or `"many"`,
drawn by `ChoiceMark` as a circle or a `rounded-none` box (never `rounded-sm`, which reads
as a circle) in a reserved slot, out of a `ring` so nothing reflows (`CHOSEN`'s rule);
filled, a dot or a tick. Absent draws nothing, as on every permission. `many` claims
`role="checkbox"`; `one` takes `aria-pressed`, never `role="radio"` (no arrow-key roving).
`ElicitationCard` sets it on the leader's rows, a two-select step's rows, and the free-text
box under a question, which is a row: same `askRowTone`, headingless, marked when counted,
not when it holds text. Its mark never waits on the wire: `questionOf` reads
`alternativeTo` where declared, the step otherwise. **Nothing typed is ever erased**: your
own answer clears the selection, picking clears nothing, and `elicitationAnswer` stops
sending an alternative while its question holds a value. The mark is a `<button>`, so the
row is no `<label>`; off is `ask.ts`'s `excluded`. Q3.586, Q3.591, Q3.592.

**Your own answer**: a string with no `format` is a growing `<textarea>` (`TypedAnswer` via
`fitToContent`, starting at `rows`: three past 240 characters, else one); a format or a
number stays an `<input>`. `answerKey`: keyboard Enter is Next/Submit with the button's gate
(`advanceBlocked`), Shift+Enter a newline; coarse pointer Enter is a newline; an IME commit
never advances. The box is borderless inside a bordered one (`fitToContent` writes
`scrollHeight`, which excludes a border); the row is `items-start`. What is sent keeps its
lines and a multi-line answer's first-line indentation (`sentText`, amending Q3.646); a
single line is trimmed. Q3.652.

**Submit needs something to submit, `Next` owes an answer, Skip says nothing.**
claude-agent-acp marks no `AskUserQuestion` field `required`. `canSubmit` is no problems
and a non-empty body; `stepAnswered` is per step over the whole step. Neither invents
`required`; both exempt a form with no fields. Q3.588, Q3.590. **One answer of one goes on
tap** (`pickOne`): to the next question, or to the agent on the last, read fresh from the
store, only where the step holds nothing else to fill. Several answers and typed words wait
for Next or Submit. Answer rows and buttons carry no `press` scale. Q3.696.

**A plan is the one payload rendered**: `context.plan`, from a `plan` field in the tool's
arguments, drawn through `Markdown` on `bg-raised/50`; everything else keeps the verbatim
`<pre>` (a text block may be the command, so it is never parsed). A plan survives only when
the request authorizes nothing (no command, body, diff or location: `askedQuestion`'s test;
`computeInput`'s early returns). ACP's `switch_mode` kind is not part of that gate (it rides
the `tool_call`) but is required one level up. `size="tall"` is keyed on `context.plan`,
never the title. The plan's source goes behind `details`: `essentialContext` drops the text
blocks, `detailContext` puts the source there, `withheldDetail` covers a plan with no
`planFilePath`. The echo test is trimmed, as `pick` trims. Q3.452.

**`planControls` recognises claude's plan-mode options by `optionId`**, a named exception
to the by-length rule below, since every approval is `allow_always` bar one: structure
first (a plan and `switch_mode`), exact set equality within one shape, `null` meaning the
agent's own buttons. Q3.453. `PLAN_SHAPES` is a list because a shape goes stale with an
adapter rename: four entries, 0.73.0's three variants and 0.63.0's five. Q3.585. **Every
shape draws exactly two buttons, neither a refusal**: the elevated grant the adapter picked,
then that grant with the context cleared as the filled primary. What is dropped is named and
asserted, `reject` and `exit-plan-default`, so a third cannot go unnoticed. `shape` is the whole request, matched exactly; `order` is what is drawn, the only
place anything is dropped. Reverses Q3.470's "nothing is deleted" for this card. Q3.594.
**Between turns it draws one**: with no turn held (`outOfTurn` on the snapshot) the
`clearing` grant goes and the elevation is filled; no field from an older daemon means
today's card. Q2.232.

**Declining keeps two routes**: the ✕ settles the request `cancelled` (an aborted tool call
to the model), and the message box declines with a reason (`reject` would reach claude as a
deny, *"User chose to keep planning"*). Per-edit approval is a session mode republished as
an `agent_config` control, so the composer's strip sets it back. `leading` is still computed
from the kind, never `false`, so a refusal could never land beside the primary.

**"What to change" is written in the message box; the card has no control for it** (ACP has
no text on a permission response). While a plan is on screen `revising` reaches the composer
from `SessionView`, the only place the pending permission and the transcript are both in
scope: the placeholder says *say what to change…*, `sendRefused` lifts, `stoppable` yields
Stop's slot to Send, and `parked` stands down so the blur rule does not take the caret.
Sending cancels the turn, then prompts (a prompt inside a turn is `409 turn_in_flight`);
with no turn it is the same call, since the daemon's cancel dismisses a plan parked between
turns (Q2.232). All four flags are pinned as source text; a gate reading
`blocked || working` refuses the one send this exists for. `awaitingPlan` holds a `useMemo`
and is computed above `SessionView`'s `if (row === undefined)` return and must stay there
(React #310); `webcheck` reads the file, as nothing else checks hook order. Q3.454. It reads
`transcript?.events ?? []`, as the card does: `openSession` creates no transcript when the
machine has no connection. Then `planControls` answers `null` (the kind rides the
`tool_call`), so the fallback draws every option, refusal included, as rows; the plan comes
off the snapshot. Q3.595.

**The number beside an answer is a keyboard shortcut**, hidden on touch with
`pointer-coarse:hidden` — keyed on the pointer, never a breakpoint. The handler stays.

**Buttons carry meaning by position**: the refusal alone on the left, the reversible
approval filled on the right, as nested groups, never one row with a `flex-1` spacer. An
option that cannot be a button gets a different layout, never a deletion. `permissionLayout`
decides by length, never by id or wording: past `BUTTON_LABEL_MAX` on any approval's
rendered label the card draws `rows`; a refusal never decides it. `permissionButtons` still
orders refusals first and names one `primaryId`, drawn filled by `OptionRow`. This replaced
`drawableOptions`, which deleted options. Q3.92, Q3.470.

**`optionLabel` substitutes our word only when the kind identifies the option**: codex's
two `allow_always` entries must never both read "Always allow"; `webcheck` pins it. A plan's
options keep their names (`optionLabel`'s `plan`), or grok's would read *Allow once*/*Deny*
over *Approve plan*/*Abandon plan*. `planControls` curates claude's alone; grok's card is
its own two buttons, and `revising` reaches it through `context.plan`. Q2.235.
