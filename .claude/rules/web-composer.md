---
paths:
  - packages/web/src/ui/Composer.tsx
  - packages/web/src/ui/CommandMenu.tsx
  - packages/web/src/ui/AgentConfigBar.tsx
  - packages/web/src/ui/commands.ts
  - packages/web/src/ui/composing.ts
  - packages/web/src/ui/agentConfig.ts
  - packages/web/src/keys.ts
  - packages/web/src/attach.ts
  - packages/web/src/choices.ts
  - packages/web/src/wire.ts
---

**The composer.** On a keyboard Enter sends and Shift+Enter is a newline; **on a
coarse pointer Enter is the newline and Send is the button**. The **IME guard in
`keys.ts` is not optional** either way, on both `shouldSend` and `completionKey`;
Q3.413. `composerKey` resolves the collision between those two and takes
`enterSends` as a **required** third argument, so a new call site is a compile
error rather than a silent Enter-sends. It gates only the fall-through: the
command menu still takes Enter while it is open, because typing `/model` on a
phone and pressing Return has to choose the command. There is no `↵` button beside
the box and there must not be one again; Q3.400. The pointer is read with
`matchMedia` **at the keystroke** and discarded in the same tick
(`shouldFocusComposer`'s rule, in that same file), so an iPad gaining or losing a
keyboard needs no state that can go stale; `enterKeyHint` is `"enter"`
unconditionally. The box looks the same focused and not, and the opt-out is
`.no-focus-ring` rather than `outline-none`, which does not work here; Q3.414.

**`Composer` outlives a session switch, so every write that follows an `await` is
split in two.** Neither `SessionView` nor `Composer` carries a `key`, so switching
session re-renders the same instance — while `POST /sessions/:id/prompt` and
`/config` are both on the 90s slow-route budget. The **keyed** halves (`drafts`,
`attach.ts`'s map, `echo.ts`'s map, `store.applySnapshot`) run unconditionally,
because they name the session they belong to; the **shared React** halves (`text`,
`busy`, `stage`, `applying`, `pendingCaret`, `closeMenu`) are gated on
`onScreen()`, which compares the `liveKey` ref. Ungated, a `409 turn_in_flight`
from session A ran `update(body)` on the composer now bound to B — A's message in
B's box, where Enter sends it to B's agent — above B's transcript, behind a `busy`
spinner that swallowed everything typed into B. Nothing but this paragraph
enforces the split. **The optimistic echo used to be in the second list and is now
in the first**, which is the direction to move anything else here: it became a
keyed map, so the write needs no guard, the `[key]` reset no longer clears it, and
leaving a conversation mid-send and coming back shows the message still in it. It
is drawn by the transcript rather than by this component — see `web-transcript.md`.
**`onScreen` is only ever asked after an await, and `send`'s required `late`
argument is what makes that a property rather than a hope** — `send` is reachable
from `submit` straight off the keystroke *and* from `applyValue`'s callback a
config round trip later, and `liveKey` is written from an effect, so asking on the
synchronous door would have made the ordinary Send skip the box, the echo and the
spinner in the window between a session-switch render and its flush: the one
rendering that reads as "it did not send" and invites a duplicate.

- **Typing `/` opens a menu with two sources.** Published commands arrive as
  `{name, description, hint}` and nothing more — ACP's whole argument surface is a
  hint *string* — so the hint is a placeholder and never inserted. `/model`,
  `/effort` and `/mode` are **synthesized** from `agentConfig` by `category`, apply
  through `POST /sessions/:id/config`, and **send no text**.
- **A synthesized control shadows an identically-named published command**, and
  each *mode* is a top-level command of its own where a published command wins the
  collision. `typedConfigCommand` splits on `value`: a mode is a *change* (anything
  after it is the message to send under it), while `/mode`/`/model`/`/effort` are a
  *question*. Dispatch first; the message goes only if the daemon agreed.
- **A completion replaces the whole token, never the text before the caret**, which
  is allowed to sit inside the name.
- **The highlight is reset by the query, never by the array** — those identities
  move on the 4s poll, so keying on the array makes Enter act on the wrong row.
- Built-ins sort above installed skills (the order the agent sends is
  *installation* order), scope is read off the end of the description because ACP
  has nowhere else to put it, and an unrecognised shape sorts with the built-ins.
- `/clear` is restored per agent and **appended** rather than prepended, so the one
  irreversible entry does not outrank `/compact` for the query `c`.
- **A control with nothing to choose between is not offered.**
- **Ctrl+V and drag-and-drop.** `onPaste` calls `preventDefault` **only when there
  really are files**. A pasted file can arrive nameless and an empty `?name=` is a
  `400`, so `pastedName` synthesizes one and `uploadFile` takes the name as an
  argument — the chip on screen and the name on disk are one string.
- Attachment chips live in a module `Map` in `attach.ts`: not `useState` (back
  unmounts the composer and a lost chip is bytes nothing can reference), not the
  store (a progress event at 60fps would wake the session list).
- **`restoreAttachments` merges; it does not assign.** Paste, drop and the
  paperclip all stay live during a 90s prompt, so a file attached mid-flight was
  deleted from the map by the restore that runs when the send is refused: the chip
  vanished silently, its upload ran to completion against the per-session 100
  files / 100 MiB, and its `cancel` closure went with the entry so nothing could
  abort or retry it — then the retried send went without the screenshot. Restored
  items lead, live ones follow, deduplicated on `localId`. The merged list may
  exceed `MAX_PROMPT_ATTACHMENTS`: `admitFiles` bounds *adding*, and silently
  truncating here would be the bug this fixes, so the daemon refuses it with its
  own message and the chips stay on screen to be removed.
- **The composer takes the caret on a desktop only**, declines to something
  already focused via `focusWorthKeeping`, and declines when `j`/`k` did the
  navigating.
- Download buttons draw **nothing** for a location outside the workspace — not a
  disabled button, not one that toasts.

**Agent controls are drawn from ACP's `category`, never an id**, and the values
are never hardcoded. `labelFor` reconciles the agents' words for one *control* —
claude `Effort` against kimi `Thinking`, and opencode `Session Mode` against `Mode`
on the other three; `choiceOverride` reconciles them for one *choice* and gets the
**opposite** answer — a label *and* a description for effort, only a description
for mode. Q3.411, Q3.516. **`choiceLabel` is the one place a choice is named**, and
beside the rename it holds the only thing this client may do to a name without
renaming it: capitalise the first letter of a `mode`, because opencode publishes
`build` and `plan` where the other three publish `Plan Mode` and `YOLO`. Only the
first letter, only `mode`, and never the value. Q3.517. `model_config` is hidden; an unknown
category is only demoted behind `…`. The one exception to "never hardcoded" is
`ultracode`, and it is the daemon's: `registry.ts` adds that row to the effort
control on its way to the snapshot, so `packages/web` renders an ordinary choice.

**A chip says its own name only where the value does not.** `showsCaption` is
`false` for exactly `model` and `thought_level`, which a category icon and a
proper-noun value ("Opus 5", "Adaptive") identify twice over without it; an
**unknown** category keeps its own because `CATEGORY_ICON` has no entry for it.
Whether a control *has* a name to draw is still a question about the category and
never about a breakpoint; Q3.401.

**What is now answered by a breakpoint is whether that name is drawn, and only
where a glyph can stand in for it.** `mode` used to keep its caption at every
width and on a 390px strip it spent that width on saying which control it was
while truncating what it was *set to* — reported from a phone. So a caption whose
category has an icon is `hidden sm:inline`, the same mechanism and the same
argument as `chipReserve`'s sizers one line down. A category with **no** icon keeps
its caption at every width, because a chip with neither is a value with nothing
saying what it sets.

**The context readout leaves the strip below `sm` entirely.** It is the one control
in that row that reports rather than sets, and the reader who wants it is at a desk
with a long conversation rather than answering a question one-handed. Hidden and
**not** moved into `…`: the overflow popover is built from `slots`, a partition over
the agent's own controls with an assertion counting every member, and the context
ring is not one of them.

**Every chip on the strip holds its width open, and the width depends on the
*category* and on nothing else.** The right-hand cluster is right-aligned, so a
chip that grows drags everything left of it. `chipReserve` renders strings
invisibly in one grid cell, so the column is sized by the real font rather than by
a `length` guess, and they are **one list per category** rather than the agent's
own labels. Q3.402. Each is the longest *ordinary* value, so a rarer one truncates
with the full text in the menu and the `title`; `null` for an unknown category,
drawn in the overflow popover where nothing sits beside a chip to move. **The
sizers are `hidden sm:block`**: below `sm` they leave the layout and chips size to
their content and truncate under pressure. Q3.403.

**A control never leaves the strip, and the model gate is what breaks that.** All
**four** agents build the effort list from the **currently selected model's** own
levels; the first three publish the control and drop it when there are none, and
opencode never publishes one — see the paragraph below. `holdConfig` merges by
option id rather than replacing; `drawnControls` returns the live set **plus** the
slots of anything missing from it, named in `unavailable`; and `Absent` draws that
slot from **`chipParts` and `chipInner`, the same two calls the live chip makes**,
never its own markup. Q3.404. The menu holds one row saying there is nothing to
choose and why (`unavailableHint`, keyed on category — the effort case gets its own
sentence for `contextHint`'s reason). It is deliberately **not** disabled: a dimmed
inert chip answers "why is this greyed out" with silence on a phone. `unavailable`
is empty whenever there is no agent at all — that sentence is `stale` instead.

**And the same fact arrives in a second shape, which drew nothing.** claude and
kimi *withdraw* the effort control; opencode never publishes one for a model with
no levels, so there was no slot to keep and the right-hand cluster had three chips
on one session and two on the next. `drawnControls` synthesizes `NO_LEVELS` — an
empty `thought_level` select, id-namespaced `reemoat:` so it cannot collide with
something an agent said — and puts it in `unavailable`, so the whole of the
paragraph above draws it with no second code path. **`thought_level` only**: a
synthesized `mode` would be found by `splitOptions` as the `NESTED_HOST` and
`Absent` draws no nested sections, so `collaboration_mode` would nest into a
placeholder and cease to exist. **The memory gets the slot too** — `held` can only
hold what a daemon published, so a slot invented on the live branch alone vanished
for the length of every restart, which is the paragraph above's own bug with a
different trigger. Not synthesized only where nothing is drawn at all: a live agent
that published no controls. `unavailable` now also carries **a select the agent
published with nothing in it**, which is the same absence with a chip in front of
it. Q3.518.

**The strip never empties while the agent is away.** The daemon drops
`agentConfig` with the agent, so `holdConfig` in `store.ts` keeps the last set a
**running** agent published, `drawnControls` chooses between the live answer and
that memory, and `stale` makes the memory readable but not tappable. The live agent
always wins **including when it publishes nothing**: `hasLiveAgent` tells an agent
with no controls from a session with no agent, and without it a dead set of chips
is pinned to a running session for ever. `stopping` is deliberately outside
`hasLiveAgent` — `doStop` fans a snapshot out both before and after it empties the
config, so that frame is emptied-but-not-an-answer. The context ring is **not**
held. Q3.405.

**`wire.ts` is a hand-mirrored copy, and it is only worth having while it *is*
the copy.** `webcheck` reads `src/events.ts` off disk and compares both halves, the
`ExitReason` union and `DAEMON_EXIT_REASONS`; a member the client lacks drops a
session out of `waitingForDaemon` into `showsAsEnded`, which takes the **whole
composer** off the screen for a conversation that is coming back. Q3.406.

**The loud blink is spent once, on work actually happening.** `animate-blink`
stays with `running`; `starting` takes the hollow pulse, which is what `waiting`
already is. `webcheck` asserts the rule over the whole `TONE_DOT` table rather than
the entry, by reading `bits.tsx` off disk. Q3.407.

**The value somebody chose is the value they see, at once — and it is recorded by
the dispatcher, not by whoever tapped.** `withChoice` overrides the drawn value,
`choices.ts` holds what is outstanding, and `applyConfigChange` is the one place
that records and releases it, because **there are two doors into that function** —
the strip's chip and the composer's `/effort` menu. `webcheck` pins it as a
**call-site** property: recorded and released exactly once, both inside the
dispatcher, with `Composer.tsx` writing neither while still being a second caller.
Q3.408.

The map is keyed by session **and** option id: by session because both components
outlive a session switch, by option because two controls can genuinely be in flight
at once. Releasing is identity-checked on a sequence number — two taps on one
control leave two requests outstanding, and the first answer must not take the
second's override with it — and cleared in `applyConfigChange`'s `finally` on both
outcomes, so success moves nothing and a refusal snaps the chip back to the truth
beside a toast. **There is no spinner on this strip, and that is the whole of
"optimistic"**: the value somebody chose is already on the chip, and optimism here
is bounded by that retraction. It is **not** the optimism `Composer`'s Stop control
refuses, since nothing is being claimed about what the *agent* is doing. Q3.409.

**A control that is merely waiting is not drawn as damage.** One tap excludes the
rest of the row — setting a model rebuilds the mode list, so two changes at once
really do race — and that exclusion is `locked`: inert and undimmed. `disabled`
stays the semantic one — no agent to ask, or a prompt in flight — and is the only
one that fades. `opacity` is deliberately absent from `.tap`'s transition list, so
anything that dims snaps rather than fades. Q3.412.

**The strip must be the same shape on every agent, and that outranks demotion.**
An unknown category goes to `…` — but a `…` that appears for one agent and not
another moves every button beside it the moment you switch session, which is the
one thing this row must not do. So a category that has been *looked at* gets a
slot, and codex's `collaboration_mode` (Default / Plan) gets `nested`: a second
menu inside the mode control, which every agent has. `NESTED_HOST` names the one
host, and `splitOptions` demotes a nested control to `…` whenever the nesting
cannot happen. **A boolean is refused on both sides of it, for one reason read
twice: what nests is a menu of choices and a boolean has none** — as the host,
`mode` is a toggle with no menu to nest into; as the nested control it carries an
empty `choices` array, so `ChoiceSection` draws a heading with no rows and
`toEntries` skips booleans too. The partition assertion counts `nested`, because a
slot missing from that sum is a control that can vanish with the check still
green.

**A prefix every row repeats is no part of a name — and no heading either.**
opencode publishes **one** model control holding two providers — 356
`OpenRouter/<model>` rows and six `OpenCode Zen/<model>` — with `group: null` on
all 362, so the menu ran two accounts together and the chip spent its whole width
on `OpenRouter…`. `drawnChoices` takes that repeated word out of every name, and
all four readers go through it: `chipValue`, `ChoiceSection`, `configChoices`, and
`CommandMenu`'s `role="group"` runs (a `listbox` may hold only options and groups,
which is why this menu's own heading is outside it). ⚠ **It lifted the prefix into
`group` for one release, and that is out**: with the daemon narrowing a session's
model list to the system it routes through, the derived heading stood over every
row in the menu and distinguished none of them. Only a `group` the **agent**
published is drawn — none of the four sends one. ⚠ **The key is not "cut at the
first `/`", which Q3.507 rejected by name**: only a list the agent *routes* on is
touched at all, every `value` having to carry a namespace, and then only where
**every row of the control** agrees on the prefix — which is what makes removing it
lossless with nothing to put it back into. A vendor-shaped list inside one provider
disagrees at its second row, so Q3.503 cannot come back; two providers in one
control leave every name exactly as the agent wrote it. Q3.519, Q3.525.

**A model chip shows the model's own name unless the agent refuses to give one.**
`chipValue` mines a description only where a separator says the head *is* the model
(`Opus 5 · Best for…`), because the whole reason it exists is claude's `Default
(recommended)`; without one the description is a sentence however short, and a
length guard does not tell the two apart. Q3.410.

## Invariants

- **Enter sends, and the IME guard is the load-bearing half.** `shouldSend` is pure
  so `webcheck` can assert it with no DOM.
- **The command menu takes Enter first, and Enter is the only key it takes.**
  `composerKey` resolves it — moved out of two `onKeyDown` blocks whose *order* was
  the thing that mattered and which nothing asserted. `completionKey` carries its
  **own** IME guard rather than relying on running before one. Escape additionally
  calls `stopPropagation`, because `useKeyboard` binds Escape on `window` and
  dismissing a menu must not also dismiss the soft keyboard.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/attach.ts` | Files attached to a message not yet sent: a module `Map` with its own subscribers, `admitFiles`, `sendableAttachments`. At `src/` because `store.ts` imports it |
| `packages/web/src/choices.ts` | Config changes asked for and not yet answered, keyed by session and option. The same module-`Map`-with-subscribers shape as `attach.ts`, at `src/` for the same reason — and the reason it exists at all is that two components dispatch the same change |
| `packages/web/src/echo.ts` | The message sent and not yet back. The third of that shape, and the one whose move *out* of React fixed a bug rather than avoiding one |
| `packages/web/src/keys.ts` | Enter-to-send, the command menu's keys, the bare-letter guards. Enter is claimed by two, and `composerKey` resolves it here rather than in a JSX prop — with `enterSends`, required, which is how a soft keyboard gets its newline back |
| `packages/web/src/ui/commands.ts` | What a `/` in the composer means, as pure functions: where the token starts and ends, which entries exist, how a query ranks them |
| `packages/web/src/ui/composing.ts` | What the empty composer says and who gets the caret, including `focusWorthKeeping` |
| `packages/web/src/ui/agentConfig.ts` | The config bar's rules as pure functions — slotting, `labelFor`, `choiceOverride`, the context readout, the prose the snapshot strips |
| `packages/web/src/ui/Composer.tsx` | Where a prompt is written: Enter to send, auto-grow, per-session draft, the `/` menu, and Stop in the send slot while the agent works. It **writes** the optimistic echo and does not draw it |
| `packages/web/src/ui/CommandMenu.tsx` | The menu: the agent's commands and the controls it does *not* publish, in one list, two stages. Never takes focus |
| `packages/web/src/ui/AgentConfigBar.tsx` | The composer's control strip: mode left, model/effort/context right, a nested control inside its host's menu, the rest behind `…`. Drawn from `category`, never an id |
