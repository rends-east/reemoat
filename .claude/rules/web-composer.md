---
paths:
  - packages/web/src/ui/Composer.tsx
  - packages/web/src/ui/SendSlot.tsx
  - packages/web/src/ui/slotSwap.ts
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

**Nothing takes the message box off the screen.** `Composer.tsx` early-returns on nothing,
`showsAsEnded` included; sending into an ended session revives it (`autoResumable` is `true`
on the prompt trigger for every reason with a conversation to return to). Send is gated,
never the box. Q7.103.

**Keys.** Keyboard: Enter sends, Shift+Enter is a newline. Coarse pointer: Enter is a
newline and Send is the button; the pointer is read with `matchMedia` at the keystroke, and
`enterKeyHint` is `"enter"` always. The IME guard in `keys.ts` sits on both `shouldSend` and
`completionKey`, each with its own guard; `composerKey` takes `enterSends` as a required
argument. Escape calls `stopPropagation` (`useKeyboard` binds it on `window`) and gates only
the fall-through: an open command menu still takes Enter. No `↵` button beside the box.
Focus opt-out is `.no-focus-ring`, never `outline-none`. Q3.400, Q3.413, Q3.414.

**One box, owned by `Composer`**: a bordered `rounded-xl` container holding the attachment
chips, the textarea (no border, radius or fill; `bg-raised` under a dragged file; grows via
`autosize.ts`) and one control row. The box is the `<form>`, so every hand-rolled `<button>`
under it (`Select`, `Absent`, `Toggle`, the choice rows) must name its `type`; `webcheck`
scans every `<button` in all three files, comment-stripped, the only guard. Never
`overflow-hidden`: `CommandMenu`, `MentionMenu`, the three chip menus, `Absent`'s panel and
the `…` popover are its `bottom-full` children. No `focus-within` treatment (Q3.414); the
caret is the indicator. No rule above it, no blur (`SessionView` makes it a sibling of the
conversation, so nothing passes under); `sticky bottom-0` stays for `<main>`'s backstop.

**The paperclip is the composer's, not the strip's** (`configBarShows` is gone), so
attaching never needs a live agent. `AgentConfigBar` takes no `leading` node and knows no
agent id.

**Chips.** Inside the box a chip has no border; its `ChevronDown` (`text-faint`, 6.23:1)
says it is a control, at every width, never behind a breakpoint (`web-shell.md`); text and
fill do not qualify. `border` stays in `CHIP`, colour at call sites, so `Toggle` (a real
border only while on) keeps its width. Borderless chips get `active:bg-raised`. Live:
`text-muted`, glyph and chevron `text-faint`, `text-fg` under a pointer; Send is the one
loud thing. Refused: dimmed by token, never `opacity`, uniformly faint, no hover or press
fill. `.tap` transitions `color`, not `opacity`. `disabled` dims, `locked` does not; `stale`
is a session nothing revives.

**Send** is a circle holding an arrow, one of two exceptions to the radius rule:
`IconButton`'s `shape` prop in `bits.tsx`, a prop and not a `className` (Tailwind emission
order). `size="chip"`: 32px of ink, 44px of target. No paper plane; a filled square is
Stop's. All four slot occupants take the circle. Q3.560. On the control row its `ml-auto` matters when a
live agent publishes no controls; at 390px chip values truncate. Q3.563.

**`SendSlot`**: Stop while the box is empty, Send once it is not (`mid-turn-messages.md`).
The four occupants stack in one 32px cell; a swap fades the old one out, shrinking, under
the new, on `rise`'s clock (`SWAP_MS`). The arriving layer only fades (its glyph scales, its
box never), so a first-frame tap lands; a leaving layer is `inert`, `aria-hidden`, and its
Send is not a submit. `slotSwap.ts` is the pure state: one live occupant, none drawn twice,
every four-swap sequence walked. Reduced motion and a session switch jump. A focused control
taken away hands focus to the box on desktop, never to the arriving one. Q3.654.

**A config picker draws twice; a class chooses**: an anchored panel above `sm`, a bottom
sheet portalled over a scrim below, `display` deciding. No head but the grab bar;
`ChoiceSection` names sections with the chip's glyph via `label`; a 14px check on the row's
line box. Not `Sheet` (its mount-time `inert`, focus and registration cannot be gated by
`display`): no `inert`, and Back does not close it; Escape (one shared
`useDismissible("menu")`), the scrim and choosing a row do. A `useLeaving` caller: the panel
draws on `open`, the sheet on `shown`. The scrim is the panel's sibling, never its parent.
Q3.566, Q3.567, Q3.650.

**The sheet** has two detents and a pinned head. Geometry is `.config-sheet`'s three custom
properties, whose defaults are rest; the class animates none. The full detent sets
`--sheet-min` as well as `--sheet-max`. At rest rows are `overflow-hidden` and every vertical
drag is the panel's; full, they scroll until at their top. The grab bar is a `<button>`, a
flex sibling of the scroller, 32px reaching 44 (`TAP_GROW_Y`). The gesture is
`useSheetGesture` (`docked-panels.md`). No resize while a finger is down: `stretch` lays out
the full detent once, at engage, each move a `fullHeight() - shows` translate (Q3.651); no
`style` prop. A release below rest is `sheetRelease`, above it `detentAfter`. Every way to a
detent is `settleTo`: the transform only, then one unanimated
write to the detent's defaults. Q3.568, Q3.650.

**Below `sm` the model chip folds into the mode picker**: `hidden sm:contents` (not `flex`,
or above `sm` it loses the row's gap) and `foldedBelowSm` hands it to the mode control as
`narrow`. `narrow` is not a slot and not in the partition: `splitOptions` keeps `model` in
`right`; only the rendering changes. It folds only where a live mode control exists.
`ChoiceSection` takes `where` and namespaces every id. The outside-press listener tests the
sheet too (Q3.565); the scrim closes on its own click, not the press (Q3.660).

**Gaps group by kind** (paperclip | chips | Send): `gap-2 sm:gap-3` on the row,
`gap-1.5 sm:gap-2` in the cluster. `TAP_GROW_Y` grows a chip's target 4px upward, measured
against 6px: no gap may be tighter (the target lands on the textarea), and all stay under
the 20px a symmetric grow needs, so growth stays vertical. Q3.561, Q3.563.
`composerPlaceholder` idles at `Type / for commands`, or `Message…` where `buildCommands`
returns nothing; all six sentence-cased, asserted over every state. Q3.562, Q3.593.

**`Composer` outlives a session switch** (no `key` on it or `SessionView`) while `/prompt`
and `/config` run up to 150s and 90s, so writes after an `await` split. Keyed halves
(`drafts`, the `attach.ts` and `echo.ts` maps, `store.applySnapshot`; `echo.ts` also names
the send) run unconditionally. Shared React state (`text`, `busy`, `stage`, `applying`,
`pendingCaret`, `closeMenu`) is gated on `onScreen()`, comparing the `liveKey` ref. Nothing
else enforces this; prefer the keyed side. `onScreen` is asked only after an await, enforced
by `send`'s required `late` argument.

**The `/` menu.**
- Published commands are `{name, description, hint}`; the hint is a placeholder, never
  inserted. `/model`, `/effort`, `/mode` are synthesized from `agentConfig` by `category`,
  apply via `POST /sessions/:id/config` and send no text.
- A synthesized control shadows a same-named published command; each mode is a top-level
  command, where a published one wins. `typedConfigCommand` splits on `value`: a mode is a
  change (what follows is sent under it), `/mode`/`/model`/`/effort` a question. Dispatch
  first; the message goes only if the daemon agreed.
- A completion replaces the whole token, never the text before the caret.
- The highlight resets on the query, never the array (identities move on the 4s poll).
- Built-ins above installed skills; scope is read off the description's end; an unknown
  shape sorts with the built-ins. `/clear` is restored per agent and appended, never
  outranking `/compact` for `c`. A control with nothing to choose between is not offered.

**Attachments.** The box never rewrites a keystroke (`VERBATIM_FIELD`,
`web-transcript.md`). `onPaste` calls `preventDefault` only when there are files; a nameless
file gets `pastedName` (an empty `?name=` is a `400`), passed to `uploadFile`, so chip and
disk agree. Chips are a module `Map` in `attach.ts`, never `useState` (back unmounts the
composer) or the store (60fps progress). `restoreAttachments` merges, never assigns:
restored lead, live follow, deduplicated on `localId`; never truncate to
`MAX_PROMPT_ATTACHMENTS` (`admitFiles` bounds adding; the daemon refuses, chips stay). The
caret goes to the composer on desktop only, deferring via `focusWorthKeeping`, never after
`j`/`k`.

**Agent controls are drawn from ACP's `category`, never an id**; values are never
hardcoded. `labelFor` reconciles names for a control (claude `Effort`/kimi `Thinking`,
opencode `Session Mode`/`Mode`); `choiceOverride` for a choice, oppositely: label and
description for effort, description only for mode. Q3.411, Q3.516. `choiceLabel` alone names
a choice; its one liberty is capitalising a `mode` choice's first letter (opencode's
`build`, `plan`), never the value. Q3.517. `model_config` is hidden; an unknown category is
demoted behind `…`. `ultracode` is the daemon's exception: `registry.ts` adds it to effort.

**A caption shows exactly where no glyph does, at every width**: `showsCaption` is false for
each category in `CATEGORY_ICON`. Q3.559 (reverses Q3.401, Q3.417). `CAPTION_SILENT` is
`CATEGORY_ICON`'s keys written twice (the icon table holds React components), so `webcheck`
reads that table off disk; `model_config` is in it for that reason.

**No context readout** (`ContextPie` is deleted; blank on kimi, Q7.26, `acp-agents.md`).
`contextUsage` stays on the wire and daemon (`pnpm client` prints `ctx N%`), held on the
client mirror only by `webcheck.plugin-protocol.ts`.

**A chip is as wide as what it says**, capped by `CHIP_MAX`, no floor, no sizer reserve
(owner's word; Q3.402, Q3.417, Q3.564). `chipParts`' caption never depends on availability;
the value truncates with full text in the menu and `title`; `webcheck` asserts sizers absent
and the cap present.

**A control never leaves the strip.** All six agents build effort from the selected model's
levels; five drop the control when there are none, opencode never publishes one.
`holdConfig` merges by option id; `drawnControls` adds a slot for anything missing, in
`unavailable`, which `Absent` draws with the live chip's `chipParts` and `chipInner`
(Q3.404), its menu one row saying why (`unavailableHint`); never disabled. `placeholderFor`
(`reemoat:` id) and `withUnusable` fill every standard slot nothing occupies (`ALWAYS_DRAWN`,
from `CATEGORY_SLOT`), in `held` too. No state draws none, including a live agent publishing
nothing and an absent one with nothing remembered (`heldConfig` is per tab); `webcheck`
sweeps nine statuses × every config shape. A synthesized `mode` is safe only because
`splitOptions` takes `unavailable`, demoting `nested` to `overflow` under an unavailable
host. A select published empty is `unavailable` too. Q3.518. grok never fills `mode`:
`DrawnControls.never`. Q6.111.

**Memory.** The daemon drops `agentConfig` for an agent nothing revives, so `holdConfig` in
`store.ts` keeps what a running agent last published, as `stale`: readable, never tappable
or sent. The live agent always wins, even publishing nothing (`hasLiveAgent`; `stopping` is
outside it, since `doStop` snapshots before and after emptying). Q3.405. `configMemory.ts`
persists it to `localStorage` through `rememberHeld`, read only where `holdConfig` answers
`undefined`, selected choice only, cleared on sign-out. Usually unneeded: `doStop` keeps
controls for every stop a message would undo and `agent_state_json` carries them across a
restart, so `drawnControls` takes its live branch, never reading `status`.

**`wire.ts` is hand-mirrored**: `webcheck` compares `src/events.ts`'s `ExitReason` union and
`DAEMON_EXIT_REASONS`; a missing member drops a session from `waitingForDaemon` into
`showsAsEnded`. Q3.406. `animate-blink` is `running`'s alone; `starting` takes the hollow
pulse, like `waiting`; asserted over `TONE_DOT`, off disk. Q3.407.

**A chosen value shows at once, recorded by the dispatcher**: `withChoice` overrides the
drawn value, `choices.ts` holds what is outstanding, and `applyConfigChange` alone records
and releases it (two doors: the chip and the `/effort` menu); `webcheck` pins once each,
inside the dispatcher, `Composer.tsx` writing neither. Q3.408. Keyed by session and option
id; release is identity-checked on a sequence number in `applyConfigChange`'s `finally`, so a
refusal snaps the chip back beside a toast. No spinner. Q3.409. `effortFollowUp`: a model change that changes the effort list drops the old level
for the new model's `default`, else its first choice, via `applyConfigChange`. Q3.551.

**One tap locks the rest of the row** (`locked`: inert, undimmed); `disabled` (no agent, or a
prompt in flight) alone fades. `opacity` is absent from `.tap`'s transitions, so dimming
snaps. Q3.412.

**The strip is the same shape on every agent, which outranks demotion**: a looked-at
category gets a slot; codex's `collaboration_mode` is `nested`, a menu inside the mode
control (`NESTED_HOST`); `splitOptions` demotes a nested control to `…` when nesting cannot
happen. A boolean is refused on both sides (no menu as host; empty `choices` as nested). The
partition assertion counts `nested`.

**A prefix every row repeats is neither name nor heading**: `drawnChoices` removes it for
`chipValue`, `ChoiceSection`, `configChoices` and `CommandMenu`'s `role="group"` runs (a
`listbox` holds only options and groups, so the menu's heading is outside it). Only an
agent-published `group` is drawn. Never "cut at the first `/`" (Q3.507): only a list the
agent routes on, every `value` namespaced, every row agreeing, so it is lossless and Q3.503
cannot return. Q3.519, Q3.525.

**A model chip shows the model's name**: `chipValue` mines a description only where a
separator says the head is the model (`Opus 5 · Best for…`), and off `default` only where
the head's first word is the row name's (`familyWord`). Q3.410, Q3.641.

**Files** (under `packages/web/src/`): `attach.ts`, `choices.ts` and `echo.ts` are module
`Map`s with subscribers, at `src/` because `store.ts` imports them; `keys.ts` also holds
`answerKey`, the ask card's rule (Q3.652); `ui/commands.ts`, `ui/composing.ts` and
`ui/agentConfig.ts` are pure; `Composer.tsx` writes the optimistic echo, never draws it;
`CommandMenu.tsx` never takes focus. `installCommand` is not in the strip: `MachineLine`'s
empty state links to Settings → Machines (`cp-machines.md`);
`webcheck.shell-and-enrollment.ts` asserts the absence.
