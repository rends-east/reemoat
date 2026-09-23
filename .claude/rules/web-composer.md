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

⚠ **`Composer.tsx` no longer early-returns on `showsAsEnded`, or on anything.
Nothing takes the message box off the screen.** Sending into an ended session
revives it — `autoResumable` answers `true` on the prompt trigger for every reason
that has a conversation to return to. What is gated is Send, never the box.
Q7.103.

**The composer.** On a keyboard Enter sends and Shift+Enter is a newline; **on a
coarse pointer Enter is the newline and Send is the button**. The **IME guard in
`keys.ts` is not optional** either way, on both `shouldSend` and `completionKey`;
Q3.413. Both are pure, so `webcheck` asserts them with no DOM, and
`completionKey` carries its **own** guard rather than relying on running before
one. `composerKey` resolves the collision — out of two `onKeyDown` blocks whose
*order* was what mattered and which nothing asserted — and takes `enterSends` as a
**required** third argument, so a new call site is a compile error rather than a
silent Enter-sends. Escape additionally calls `stopPropagation`, `useKeyboard`
binding it on `window` and dismissing a menu having to not dismiss the keyboard. It gates only the fall-through: the command menu
still takes Enter while open, because typing `/model` on a phone and pressing
Return has to choose the command. There is no `↵` button beside the box and there
must not be one again; Q3.400. The pointer is read with `matchMedia` **at the
keystroke** and discarded in the same tick, so an iPad gaining or losing a keyboard
needs no state that can go stale; `enterKeyHint` is `"enter"` unconditionally. The box looks the same focused and not, and the opt-out is `.no-focus-ring`
rather than `outline-none`, which does not work here; Q3.414.

**The composer is one box, and `Composer` owns everything in it.** A bordered
`rounded-xl` container holds the attachment chips, the textarea and one control
row; the textarea has no border, no radius and no fill of its own, the box being
its boundary, and it goes `bg-raised` under a dragged file. It was seven outlines
in two rows on a 390px screen. Three rules keep it one box. ⚠ **The box is the
`<form>`, so every hand-rolled `<button>` under it must name its `type`** — the
default inside a form is `submit`, and `Select`, `Absent`, `Toggle` and the choice
rows are all hand-rolled, so a typeless one sends the draft when a chip is tapped.
`webcheck` scans every `<button` in both files, comment-stripped, and **that is the
only guard**. **It may never take `overflow-hidden`** — `CommandMenu`, all three
chip menus, `Absent`'s panel and the `…` popover are `bottom-full` children of it.
And it takes **no** `focus-within` treatment: Q3.414 is about this box now, and the
caret is the indicator.

**The rule above the composer is gone and so is the blur.** The box's
`edge-strong` is 4.40:1 where that `border-edge` was 1.31:1 — one stronger line
rather than two hairlines eight pixels apart. The blur went as a measurement:
`SessionView` makes the composer a **sibling** of the conversation region and
`AppShell`'s pane does not scroll, so nothing has ever passed under it and the
filter re-blurred a static backdrop every frame. `sticky bottom-0` stays for the
day `<main>`'s backstop fires.

**The paperclip is the composer's, not the strip's — and that retired
`configBarShows`.** Its third clause stopped one failure: no bar, so no paperclip,
so no way to attach a file on a session with no live agent. With the paperclip in
the row `Composer` lays out that is structurally impossible rather than asserted,
and what was left was `optionCount > 0`. `AgentConfigBar` takes no `leading` node
and knows no agent id at all, which is "drawn from `category`, never an id" with
nothing left to bend it. The row's gap is arithmetic: `TAP_GROW_Y` grows a chip's
target 4px upward against a 6px gap, so tightening it puts that target on the
textarea's last row.

**A chip inside that box carries no border, and its chevron is what says it is a
control.** This reverses the app-wide rule for this row and the amended sentence
is in `web-shell.md`: a control on a plane of its own is bounded at `edge-strong`,
one inside a container already bounded is not. What a chip then owes 3:1 is its
own **action glyph** — the `ChevronDown` at `text-faint`, 6.23:1, a stronger claim
than the 4.40:1 border it replaces, saying a list opens rather than that something
is here. **So the chevron is drawn at every width and may
never take a breakpoint.** Text does not qualify and neither does a fill: `raised`
on `surface` is 1.22:1. `border` stays in `CHIP` and only the *colour* moves to the
call sites, so `Toggle` — the one chip that keeps a real border, and only while
**on**, since 1.22:1 cannot carry a boolean — does not change width to take it.
Every borderless chip gets `active:bg-raised`: hover is not a state a phone has.

**The chips are the quiet half of the box and Send is the loud one.** A live chip
rests at `text-muted` (7.75:1) with glyph and chevron at `text-faint` and takes
`text-fg` only under a pointer; the one dark thing below the field is Send.
Three near-black values read as three demands where the reference clients draw
one, and none is the action. **A refused chip dims by token
and never by `opacity`** — `text-faint`, 6.23:1, where `opacity-40` is 2.51:1 for
`fg` and **1.65:1 for `edge-strong` itself**, so the bordered chip was never the
safe baseline it looked like. What carries the refusal at these tones is
*flatness*: a live chip is two-tone, a refused one uniformly faint with no hover
and no press fill. It also fades — `.tap` transitions `color` and not `opacity` —
and restores the `disabled` dims / `locked` does not distinction. `stale` is the
resting appearance of a session nothing revives.

**Send is a circle holding an arrow, and it is one of two exceptions to the radius
rule.** `IconButton`'s `shape` prop, declared in `bits.tsx` beside the rule it
bends, and a **prop rather than a `className`** because Tailwind emits every
utility at one specificity and a passed `rounded-full` would beat or lose to
`rounded-md` by emission order. `size="chip"` — 32px of ink, 44px of target, the
same box as the chips — because 44px of filled black was the loudest object in the
composer; `lg`'s "and nothing smaller" is amended rather than ignored. A paper
plane is a *mail* metaphor for something that is not mail, and a filled square is
the shape **Stop** has, in the one slot where Stop appears a second later. All four
occupants take the circle, so it never changes shape under a thumb. Q3.560.

**Send is on the control row.** The paperclip, the agent's cluster and Send on one
line, with `ml-auto` — load-bearing in exactly one state, a live agent publishing
no controls, where without it Send would sit beside the paperclip mid-row. Q3.563 carries the
arithmetic: at 390px the chip values truncate, the documented below-`sm`
behaviour and not a new one.

**A config picker draws twice and a class chooses**, `AppShell`'s rule one control
in: above `sm` the anchored panel, below it a bottom sheet portalled over a scrim,
both in the document at once with `display` deciding — so a window dragged across
the breakpoint cannot draw a picker that is not there. No head but the grab bar,
`ChoiceSection` naming each section with the chip's own glyph through `label` — one lookup
for the strip and both menus — and a 14px check on the row's line box. ⚠ **It is not `Sheet` and could not be**: that sets `inert` on `#root`, takes
focus and registers itself on mount, side effects a `display` class cannot gate, so
one here would lock the app behind an invisible panel whenever a popover opened. **So there is no `inert` and
Back does not close it**: Escape does, through the one `useDismissible("menu")`
both share, and so do the scrim and choosing a row. **It leaves the way it
arrived**: no route means no view transition to hang `sheet-close` off, so
`dismiss` sets `leaving` and a timer unmounts it — one duration in two files,
`webcheck` pinning them equal. Only the sheet lingers; the popover goes at once.
⚠ **The exit needs keyframes of its own.** `sheet … reverse` never played: an
element keeps its running animation while `animation-name` is unchanged, so the
swapped class edited an animation finished 260ms earlier instead of starting one,
and `both` held the reversed last frame. It vanished in one frame, on a phone, with
every check green. `sheet-out`/`scrim-out` mirror the arrival's curve; `webcheck`
pins that neither exit names its arrival. Q3.566, Q3.567.

**The sheet has two detents, a pinned head, and it follows a finger.** Its geometry
is `.config-sheet`'s four custom properties, whose **defaults are the resting
sheet**, so rest is the absence of every write.
Opening sets `--sheet-min` as well as `--sheet-max`. ⚠ **The `min-` half is what
lets a short picker open at all**: a cap does nothing to a panel already under it,
so effort — four rows on every agent — was immovable while model took the same
drag. At rest the rows do not scroll and the gesture that would have scrolled them
opens the sheet, the only state where they do. The grab bar is a `<button>` and a
flex sibling of the scroller, not its first child, which is why it stays; 32px of
head reaching 44px through `TAP_GROW_Y`, `min-h-11` having put twenty pixels of
nothing above a 4px bar.

**The drag writes those properties onto the node, never through React** —
`AppShell`'s `--rail-w` rule one control in, over 362 opencode rows that would
re-render sixty times a second. So the panel carries **no `style` prop**: one
writer, or two settle by emission order. The height is read once at `pointerdown`
and `from.height - travelled` is where the top edge wants to be, capped at full;
below rest the height stops and the panel slides instead, shortening past the rows
being what eats them from the bottom while the box stays. The transition is switched off **inline** while the finger
is down, or every frame starts a 300ms animation chasing it — never a `var()` in
`.config-sheet`'s shorthand, which makes every longhand pending-substitution. A release takes the nearer detent, or dismisses past
`SHEET_DISMISS_PX`, keeping the offset so the exit keyframe's implicit `from` is
where the hand let go. ⚠ **The settle's *last* write may not animate**:
handing the height back to the defaults moves `min-height` and `max-height`, both
animated, so a long list settling to rest sprang to full and shrank back, and a short
picker opening did the mirror. `paintNow` is that write, off for a frame. ⚠ **The panel captures the pointer, and
only once the drag engages**: uncaptured, a finger lifted outside the window ends
nothing; captured at `pointerdown`, it eats every row's `click`.
⚠ **The click a drag leaves behind is swallowed** by one
capture-phase guard on the panel: a touch ending with nothing scrolled still fires
`click` on the row under it, so dragging the sheet shut would also switch the
model. Q3.568.

**Below `sm` the model chip leaves the row and folds into the mode picker.**
`hidden sm:contents` on the chip — `contents` and not `flex`, or above `sm` it is a
flex item inside a flex item and loses the row's gap — and `foldedBelowSm` hands the
option to the mode control as `narrow`, beside `nested`. ⚠ **`narrow` is not a slot
and does not enter the partition**: `splitOptions` puts `model` in `right` at every
width; what changes is which *rendering* is drawn. It needs no breakpoint class,
only the sheet drawing it and the sheet being `sm:hidden`. ⚠ **The
fold happens only where a live mode control exists to fold into** — `splitOptions`
makes the same test before anything enters `nested`, and without it a hidden chip
puts its choices nowhere. Two copies of one list cost ids: `ChoiceSection` takes
`where` and namespaces every id it makes, or an `aria-describedby` resolves to
whichever copy the browser reaches first — on a phone, the hidden one. And the
outside-press listener tests **both** boxes, the sheet being outside `boxRef` by
construction: without that a tap on a row was an outside press and the picker did
nothing. Q3.565.

**The row's gaps are a grouping rather than three numbers.** Wider where the
*kind* of control changes — the paperclip acts on the message, the chips describe
the turn, Send is the action — and narrower inside a group. `gap-2 sm:gap-3` on the
row, `gap-1.5 sm:gap-2` inside the cluster: the breakpoint is a **space** question,
the one thing a breakpoint is honestly for, and it exists because Send joined this
line. Every value clears the 6px `TAP_GROW_Y` was measured against, so none tightens
a target, and all stay far under the 20px a symmetric grow would need — which is why
that growth is still vertical-only. Q3.561, Q3.563.

**The empty box teaches `/`, and only where `/` opens something.**
`composerPlaceholder`'s idle line is `Type / for commands` and nothing else — the one
affordance nothing else advertises, and no "message" in front of it because an empty
box already reads as somewhere to write. It falls back to `Message…` where
`buildCommands` returns nothing — now only a session nothing revives — and a hint
for a key that does nothing is worse than none. **All six are sentence-cased**, asserted over every
state; a register split was argued and withdrawn. Q3.562, Q3.593.

**`Composer` outlives a session switch, so every write that follows an `await` is
split in two.** Neither `SessionView` nor `Composer` carries a `key`, so switching
session re-renders the same instance — while `POST /sessions/:id/prompt` and
`/config` are both on the 90s slow-route budget. The **keyed** halves (`drafts`,
`attach.ts`'s map, `echo.ts`'s map, `store.applySnapshot`) run unconditionally,
naming the session they belong to; the **shared React** halves (`text`, `busy`,
`stage`, `applying`, `pendingCaret`, `closeMenu`) are gated on `onScreen()`, which
compares the `liveKey` ref. Ungated, a `409 turn_in_flight` from session A ran
`update(body)` on the composer now bound to B — A's message in B's box, where Enter
sends it to B's agent, behind a `busy` spinner that swallowed everything typed into
B. Nothing but this paragraph enforces the split. **Second list to first is the
direction to move anything here**: a keyed map needs no guard, and leaving
mid-send and coming back still shows the message — which is what the optimistic
echo bought by moving (it is drawn by the transcript, `web-transcript.md`).
**`onScreen` is only ever asked after an
await, and `send`'s required `late` argument is what makes that a property rather
than a hope** — `send` is reachable from `submit` straight off the keystroke *and*
from `applyValue`'s callback a round trip later, and `liveKey` is written from an
effect, so asking on the synchronous door made the ordinary Send skip the box, the
echo and the spinner between a session-switch render and its flush: the rendering
that reads as "it did not send" and invites a duplicate.

- **Typing `/` opens a menu with two sources.** Published commands arrive as
  `{name, description, hint}` and nothing more — ACP's whole argument surface is a
  hint *string* — so the hint is a placeholder, never inserted. `/model`, `/effort`
  and `/mode` are **synthesized** from `agentConfig` by `category`, apply through
  `POST /sessions/:id/config`, and **send no text**.
- **A synthesized control shadows an identically-named published command**, and
  each *mode* is a top-level command where a published command wins the collision.
  `typedConfigCommand` splits on `value`: a mode is a *change* (what follows is the
  message to send under it), `/mode`/`/model`/`/effort` a *question*. Dispatch
  first; the message goes only if the daemon agreed.
- **A completion replaces the whole token, never the text before the caret**, which
  may sit inside the name.
- **The highlight is reset by the query, never by the array** — those identities
  move on the 4s poll, so keying on the array puts Enter on the wrong row.
- Built-ins sort above installed skills (the agent's order is *installation*
  order); scope is read off the end of the description, ACP having nowhere else for
  it; an unrecognised shape sorts with the built-ins.
- `/clear` is restored per agent and **appended** rather than prepended, so the
  irreversible entry does not outrank `/compact` for `c`.
- **A control with nothing to choose between is not offered.**
- **Ctrl+V and drag-and-drop.** `onPaste` calls `preventDefault` **only when there
  really are files**. A pasted file can arrive nameless and an empty `?name=` is a
  `400`, so `pastedName` synthesizes one and `uploadFile` takes it as an argument:
  the chip on screen and the name on disk are one string.
- Attachment chips live in a module `Map` in `attach.ts`: not `useState` (back
  unmounts the composer and a lost chip is bytes nothing can reference), not the
  store (60fps progress would wake it).
- **`restoreAttachments` merges; it does not assign.** Paste, drop and the
  paperclip stay live during a 90s prompt, so a file attached mid-flight was deleted
  by the restore that runs when a send is refused: the chip vanished, its upload ran
  on against the per-session 100 files / 100 MiB, its `cancel` went with the entry,
  and the retried send went without the screenshot. Restored items lead, live ones
  follow, deduplicated on `localId`. The merged list may exceed
  `MAX_PROMPT_ATTACHMENTS`: `admitFiles` bounds *adding* and truncating here is the
  bug this fixes, so the daemon refuses it and the chips stay.
- **The composer takes the caret on a desktop only**, defers to something already
  focused via `focusWorthKeeping`, and declines when `j`/`k` did the navigating.

**Agent controls are drawn from ACP's `category`, never an id**, and the values
are never hardcoded. `labelFor` reconciles the agents' words for one *control* — claude
`Effort` against kimi `Thinking`, opencode `Session Mode` against `Mode` elsewhere; `choiceOverride` reconciles them for one *choice* and gets the
**opposite** answer — a label *and* a description for effort, only a description
for mode. Q3.411, Q3.516. **`choiceLabel` is the one place a choice is named**, and
beside the rename it holds the only liberty this client takes with a name:
capitalising the first letter of a `mode`, because opencode publishes `build` and
`plan` where the other three publish `Plan Mode` and `YOLO`. Only the first letter,
only `mode`, never the value. Q3.517. `model_config` is hidden; an unknown category
is only demoted behind `…`. The one exception to "never hardcoded" is
`ultracode`, and it is the daemon's: `registry.ts` adds that row to the effort
control on its way to the snapshot, so `packages/web` renders an ordinary choice.

**A chip says its own name exactly where no glyph does, and there is no
breakpoint in it.** `showsCaption` is `false` for every category `CATEGORY_ICON`
has an entry for and true for every category it does not — so a caption belongs
only to a chip with nothing else identifying it, and it is then drawn at every
width. `mode` was the last exception on the other side: the glyph and the
`aria-label` already said "Mode", so the word was a third copy spending width on
the narrowest strip in the app next to a value it pushed into a truncation. With it
went the caption's `hidden sm:inline`, what is left having no glyph to hide behind
at any width. Q3.401 and Q3.417 are what this
reverses; Q3.559 is the reversal. ⚠ `CAPTION_SILENT` **is** `CATEGORY_ICON`'s key
list written twice — the icon table holds React components and cannot be imported
into the pure module — so `webcheck` reads that table off disk and asserts nothing
in it draws a caption, and `model_config` is in the set for that reason alone.

**There is no context readout in this client, and the daemon still sends one.**
It reported how full the agent's window was, and on kimi it reported nothing for
the life of every session (`acp-agents.md`, Q7.26) — nor on any session waiting for
its agent. A control blank on most agents is not worth the width, so `ContextPie`
and its rules are deleted. `contextUsage`
stays on the wire and on the daemon, where `pnpm client` prints `ctx N%`:
`webcheck.plugin-protocol.ts` pins that field on the client's snapshot mirror, and
with nothing in `packages/web` reading it, that is all that holds it there.

**A chip is as wide as what it says, bounded above by `CHIP_MAX` and by nothing
below.** ⚠ **There was a fixed reserve and it is gone** — invisible per-category
sizer strings that held every chip at the widest value it could show. Withdrawn on
the owner's word; the cost is Q3.402 and Q3.417, measured, and Q3.564 carries it.
What holds: `chipParts`' caption still does not depend on availability; the value
truncates with the full text in the menu and the `title`; and `webcheck` asserts
the sizers are **absent** as well as the cap present, a revert bringing the empty
box back with them.

**A control never leaves the strip, and the model gate is what breaks that.** All
**five** agents build the effort list from the **currently selected model's** own
levels; four publish the control and drop it when there are none, opencode never
publishes one — see below. `holdConfig` merges by option id rather
than replacing; `drawnControls` returns the live set **plus** the slots of anything
missing, named in `unavailable`; and `Absent` draws that slot from **`chipParts`
and `chipInner`, the same two calls the live chip makes**. Q3.404. The menu holds one row saying there is nothing to
choose and why (`unavailableHint`, keyed on category — the effort case gets its own
sentence, "why is this empty" having a measured answer there and a vague one
elsewhere). It is deliberately **not** disabled: a dimmed inert chip answers "why
is this greyed out" with silence on a phone.

**And the same fact arrives in a second shape, which drew nothing.** claude and
kimi *withdraw* the effort control; opencode never publishes one for a model with
no levels, so there was no slot to keep and the right cluster had three chips on one
session and two on the next. `placeholderFor` builds an empty select,
id-namespaced `reemoat:` so it cannot collide with something an agent said, and
`withUnusable` appends one for **every standard slot nothing already occupies** —
`ALWAYS_DRAWN`, derived from `CATEGORY_SLOT` rather than listed, so it is exactly
the two visible slots and cannot drift. So the paragraph above draws them with no
second code path. **The memory gets the slot too** — `held` holds only what a
daemon published, so a slot invented on the live branch alone vanished for every
restart. **And there is no state that draws none**: the two branches that returned
an empty set — a live agent publishing nothing, and an absent one with nothing
remembered — go through the synthesis as well, which is what makes the row the
same shape on every session rather than only on every agent. `heldConfig` is
per-tab and the daemon restores none, so that second branch was **every reload of
a session whose agent is away**, permanently for an ended one. Reversed on the
owner's report of a composer with a paperclip, a Send button and nothing else;
`webcheck` sweeps all nine statuses against every config shape and asserts none of
the 81 empties it. ⚠ **A synthesized `mode` is only safe because `splitOptions`
takes `unavailable` now**: it looked for `NESTED_HOST` by category alone, `Absent`
draws no nested sections, and nothing else reads `slots.nested` — so codex's
`collaboration_mode` ceased to exist whenever `mode` was unavailable, which was
already true of a *withdrawn* one and asserted nowhere. An unavailable host demotes
`nested` to `overflow`, the answer a missing host already had. `unavailable` also carries **a select published with
nothing in it**, the same absence with a chip in front. Q3.518.

⚠ **The slot stays; the sentence under it must survive an agent that will never
fill it** — grok publishes no `mode`, ever. `DrawnControls.never`. Q6.111.

**The strip never empties while the agent is away, and now not across a reload
either.** `holdConfig`'s memory lives in `rows`, in this tab; `configMemory.ts`
writes it through to `localStorage` and `rememberHeld` in `store.ts` is the one
place both directions happen — read only where `holdConfig` answers `undefined`,
which is exactly what a reload leaves. ⚠ **Only the *selected* choice is kept**:
`chipValue` names a value through its choice, so dropping it draws
`openai/gpt-5` instead of `GPT-5`, and keeping the rest is 362 models a session.
Nothing read back is ever sent — a memory is `stale`, so `Select` is `disabled`
over it — which is what makes storing a possibly-stale value safe here. ⚠ **It is
no longer unsafe on the daemon either, and this memory is the fallback rather than
the ordinary case**: `doStop` keeps the controls and commands for every stop a
message would undo and `agent_state_json` carries them across a restart, so such a
session arrives with real options and `drawnControls` takes its **first** branch —
live, tappable, and never reading `status`. Cleared on sign-out; the *reading* only.

The daemon drops
`agentConfig` with an agent nothing revives, so `holdConfig` in `store.ts` keeps the last set a
**running** agent published, `drawnControls` chooses between the live answer and
that memory, and `stale` makes the memory readable but not tappable. The live agent
always wins **including when it publishes nothing**: `hasLiveAgent` tells an agent
with no controls from a session with no agent, and without it a dead set of chips
is pinned to a running session for ever. `stopping` is deliberately outside
`hasLiveAgent` — `doStop` fans a snapshot out both before and after it empties the
config, so that frame is emptied-but-not-an-answer. Q3.405.

**`wire.ts` is a hand-mirrored copy, worth having only while it *is* the copy.**
`webcheck` reads `src/events.ts` off disk and compares the `ExitReason` union and
`DAEMON_EXIT_REASONS`; a member the client lacks drops a session out of
`waitingForDaemon` into `showsAsEnded`, taking the **whole composer** off the
screen for a conversation that is coming back. Q3.406.

**The loud blink is spent once, on work actually happening.** `animate-blink`
stays with `running`; `starting` takes the hollow pulse, which is what `waiting`
already is. `webcheck` asserts it over the whole `TONE_DOT` table, off disk. Q3.407.

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
control leave two requests outstanding and the first answer must not take the
second's override — and cleared in `applyConfigChange`'s `finally` on both
outcomes, so success moves nothing and a refusal snaps the chip back beside a
toast. **There is no spinner on this strip, and that is the whole of
"optimistic"**: the chosen value is already on the chip, bounded by that
retraction. It is **not** the optimism `Composer`'s Stop control refuses, nothing
being claimed about what the *agent* is doing. Q3.409.

**A model change that changes the effort list drops the old level and sets the
new model's default** — `effortFollowUp`, pure, `default` where the list has one
and the first choice otherwise, sent by `applyConfigChange` through itself so the
daemon is still asked in one place. Q3.551.

**A control that is merely waiting is not drawn as damage.** One tap excludes the
rest of the row — setting a model rebuilds the mode list, so two changes at once
really do race — and that exclusion is `locked`: inert and undimmed. `disabled`
stays the semantic one — no agent to ask, or a prompt in flight — and is the only
one that fades. `opacity` is deliberately absent from `.tap`'s transition list, so
anything that dims snaps rather than fades. Q3.412.

**The strip must be the same shape on every agent, and that outranks demotion.**
An unknown category goes to `…` — but a `…` that appears for one agent and not
another moves every button beside it when you switch session, the one thing this
row must not do. So a category that has been *looked at* gets a
slot, and codex's `collaboration_mode` (Default / Plan) gets `nested`: a second
menu inside the mode control, which every agent has. `NESTED_HOST` names the host,
and `splitOptions` demotes a nested control to `…` whenever the nesting cannot
happen. **A boolean is refused on both sides of it, for one reason read
twice: what nests is a menu of choices and a boolean has none** — as the host,
`mode` is a toggle with no menu to nest into; as the nested control it carries an
empty `choices` array, so `ChoiceSection` draws a heading with no rows. The
partition assertion counts `nested`: a slot missing from that sum is a control that
can vanish with the check still green.

**A prefix every row repeats is no part of a name — and no heading either.**
opencode publishes **one** model control holding two providers — 356
`OpenRouter/<model>` rows and six `OpenCode Zen/<model>`, `group: null` on all 362
— so the menu ran two accounts together and the chip spent its width on
`OpenRouter…`. `drawnChoices` takes that repeated word out of every name, and
all four readers go through it: `chipValue`, `ChoiceSection`, `configChoices`, and
`CommandMenu`'s `role="group"` runs (a `listbox` may hold only options and groups,
which is why this menu's own heading is outside it). ⚠ **It lifted the prefix into
`group` for one release, and that is out**: with the daemon narrowing a session's
model list to the system it routes through, the derived heading stood over every
row and distinguished none. Only a `group` the **agent** published is drawn — none
of the four sends one. ⚠ **The key is not "cut at the first `/`", which Q3.507
rejected by name**: only a list the agent *routes* on is touched, every `value`
having to carry a namespace, and then only where **every row of the control**
agrees on the prefix — which is what makes removing it lossless. A vendor-shaped
list inside one provider disagrees at its second row, so Q3.503 cannot come back.
Q3.519, Q3.525.

**A model chip shows the model's name unless the agent refuses to give one.**
`chipValue` mines a description only where a separator says the head *is* the model
(`Opus 5 · Best for…`), and off `default` only where the head's first word is the
row name's (`familyWord`); a notice like `Newer version available · …` names none.
Q3.410, Q3.641.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/attach.ts` | Files attached to a message not yet sent: a module `Map` with subscribers, `admitFiles`, `sendableAttachments`. At `src/` because `store.ts` imports it |
| `packages/web/src/choices.ts` | Config changes asked for and not yet answered, keyed by session and option. The same shape as `attach.ts` and at `src/` for the same reason; it exists because two components dispatch the same change |
| `packages/web/src/echo.ts` | The message sent and not yet back. The third of that shape, and the one whose move *out* of React fixed a bug rather than avoiding one |
| `packages/web/src/keys.ts` | Enter-to-send, the command menu's keys, the bare-letter guards. Enter is claimed by two and `composerKey` resolves it here rather than in a JSX prop, with `enterSends` required — how a soft keyboard gets its newline back |
| `packages/web/src/ui/commands.ts` | What a `/` means, as pure functions: where the token starts and ends, which entries exist, how a query ranks them |
| `packages/web/src/ui/composing.ts` | What the empty box says and who gets the caret, including `focusWorthKeeping` |
| `packages/web/src/ui/agentConfig.ts` | The config bar's rules as pure functions: slotting, `labelFor`, `choiceOverride`, the prose the snapshot strips |
| `packages/web/src/ui/Composer.tsx` | Where a prompt is written, and **the box everything else here is inside**: Enter to send, auto-grow, the draft, the `/` menu, the chips, the paperclip, the control row, and the send slot — Stop while the box is empty, Send the moment it is not (`mid-turn-messages.md`). It **writes** the optimistic echo and does not draw it |
| `packages/web/src/ui/CommandMenu.tsx` | The menu: the agent's commands and the controls it does *not* publish, one list, two stages. Never takes focus |
| `packages/web/src/ui/AgentConfigBar.tsx` | The agent's own controls, as a cluster in the composer's control row: mode left, model/effort right, a nested control inside its host's menu, the rest behind `…`. Drawn from `category`, never an id |

**`installCommand` does not appear in the strip.** `MachineLine`'s empty state
keeps its door to Settings → Machines, where the command lives — a shell line is not
a field label on a 390px phone (`cp-machines.md`). `webcheck.shell-and-enrollment.ts`
asserts the absence by name.
