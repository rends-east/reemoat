---
paths:
  - packages/web/src/ui/paneWidth.ts
  - packages/web/src/ui/rail.ts
  - packages/web/src/ui/taskWidth.ts
  - packages/web/src/ui/PaneHandle.tsx
  - packages/web/src/ui/leaving.ts
  - packages/web/src/ui/TaskPanel.tsx
  - packages/web/src/ui/MenuDrawer.tsx
  - packages/web/src/ui/AppShell.tsx
  - packages/web/src/ui/sheetDrag.ts
  - packages/web/src/ui/sheetMotion.ts
  - packages/web/src/ui/Sheet.tsx
  - packages/web/src/ui/AgentConfigBar.tsx
---

# A second surface beside the conversation: how wide it is, how it leaves, and how it is dragged away

Two subjects, and they are one file because they landed on one element. `TaskPanel`
is the background panel — a bottom sheet on a phone, a card docked to the right of
the conversation from `md` — and in one change it became draggable like the rail and
learned to collapse instead of vanishing. The rail and the menu drawer are the
surfaces each half was measured on; both are here because both now share the code.

`web-shell.md` owns the rail as a layout. This is the narrower subject it points at.

## How wide a draggable pane is

**`paneWidth.ts` is the mechanism, `rail.ts` and `taskWidth.ts` are two
instantiations of it**, and the second one is what made the extraction worth doing
rather than tidy. Every paragraph in `paneWidth.ts` is a defect measured on the rail
first; a hand-written second copy would have inherited none of them.

⚠ **`rail.ts` keeps its filename and all four of its exported names** —
`clampRailWidth`, `railWidth`, `setRailWidth`, `subscribeRail`. `webcheck` drives
them by name *and* behaviourally, so keeping them made the extraction four lines
instead of a rewrite of nine assertions that are about the rail rather than about
where its code lives.

**Module state seeded from `localStorage`, never `useState`** — the rule `groups.ts`
states about the collapse set and the selected tab. The panel is what makes it
load-bearing rather than tidy: it unmounts every time it is closed, so a width in
its own state would last exactly one visit.

**Holds no DOM.** `webcheck` stubs `window.location` and `window.localStorage` and
nothing else, so a `documentElement` touch in a module body — or in anything a check
calls — throws before a single case runs. The impure shells are `AppShell`, which
writes both properties, and `PaneHandle`, which writes one per `pointermove`.

**The width travels as a CSS custom property and may never become a React prop.**
The store publishes on a four-second poll and on every streamed event, so a width
React owns is reset to where the drag *started* every time one lands — a bug that
appears only on a session that is talking. It also costs no render per
`pointermove`.

### `null` is a state, and only one of the two panes has it

The rail has one width at every size, so unset and default are the same rail and
`railWidth()` answers a number. **The panel has two declared widths**, because the
conversation's width is not monotonic in the window's: at `lg` the rail arrives and
takes `RAIL_DEFAULT`, so the 20rem panel leaves 308px at 1024 — narrower than the
436px the same panel leaves at 768 with no rail at all. So `index.css` declares 20rem and steps to
26rem at `xl`, `null` means *the stylesheet decides*, and a chosen width goes onto
`documentElement`, which beats both media blocks. A double-click resets.

⚠ **The reset removes the key rather than writing the default into it.** A stored
default is still a *chosen* width and would go on beating both blocks, so the panel
would stay 20rem at `xl` for ever — the breakpoint present, declared, correct and
unreachable. Driven rather than read off the source, because every source pin stays
green with `reset()` reduced to `committed = min`.

⚠ **Both declarations are unlayered `:root` and `@media` adds no specificity.** The
wide one wins because it comes **later** and for no other reason — this is
`index.css`'s own post-mortem, where every phone animation once shipped onto the
desktop for exactly this reason. `webcheck` asserts the order, not just the values.

⚠ **px on both sides.** `19.5rem` and `312` were asserted independently for a
release, agreed only at a 16px root, and cost every reader on Chrome's Large setting
a 78px snap on load. Both declared widths are derived from `taskWidth.ts`'s
constants in the driver rather than typed twice.

**A JavaScript clamp against the available width is refused**, and not on taste:
`webcheck` bans `matchMedia`, `innerWidth` and `clientWidth` in `TaskPanel.tsx` by
literal, and it would be a second source of truth for a width CSS already knows.

⚠ **So the clamp is in CSS, and it is not optional.** The two panes' bounds are
independent and their sum is bounded nowhere — `TASK_MAX` 512 against `RAIL_MAX`
552, both one ordinary gesture away at any width. Measured in a real browser at a
1024px window with both dragged to their maxima: the conversation column's content
box floored at **0px**, its header title measured 0px wide, and the docked card lay
52px **over** the session rail. `--task-fit` is
`min(var(--task-w), calc(var(--task-room) - 15.75rem))` — a 240px floor for the
conversation plus the 12px gap — with `--task-room` being the window, less the rail
where the rail exists. `--task-w` stays the *stored* number that `PaneHandle` writes,
reads back and announces; `--task-fit` is what the panel and the gutter spend.

⚠ **`var()` substitutes lazily, which is why `--task-fit` can be declared above the
things it depends on.** Redefining `--task-room` in the `lg` block and `--task-w` in
the `xl` block re-resolves it at use time. That is the one place in this pair where
source order does *not* decide, beside the one where it does.

### The separator

**One `PaneHandle`, two panes, and `sign` is the whole of the difference** — the
rail is to the left of its handle and the panel to the right. Reversed, a drag makes
the panel narrower as it is pulled wider and nothing else would notice, so it is
read out of both call sites.

- **`setPointerCapture`, never `window` listeners.** The fast pointer leaves the 8px
  strip on the first frame — but the case that *strands* the drag is releasing
  outside the browser window, where no `pointerup` reaches the document at all: the
  strip stays armed and the next click anywhere resizes the pane. Capture also makes
  teardown structural, which the panel's separator relies on, unmounting on every
  close including mid-drag.
- **`pointercancel` reverts to the committed width.** A cancelled gesture is not a
  smaller one.
- ⚠ **A press that never moved commits nothing.** `pointerup` fires for a zero-pixel
  press, and committing there writes `declared()` — the stylesheet's own answer —
  into storage as a reader's choice. Invisible on the rail; on the panel one click
  turns *the stylesheet decides* into a number that beats both declared widths for
  the rest of the session. Measured: a click at 1400px stored 416, after which a
  900px window drew 416 where the stylesheet says 320.
- ⚠ **Unmounting mid-drag is not a `pointercancel`.** Measured on Chrome 151:
  removing the element holding the capture delivers no `pointerup`, no
  `pointercancel` and not even `lostpointercapture` to it — the release is
  hit-tested onto `<html>`. So a cleanup effect does the restore half of `finish`.
  The panel's separator unmounts on every close, Escape closes it mid-drag, and
  `"menu"` does not stand down `j`/`k`, so a session switch does it too.
- ⚠ **`aria-valuenow` is required on a focusable separator** — WAI-ARIA 1.2, and
  unlike `slider` it names no repair, so engines synthesise a value that is not
  inside the advertised range. It falls back to `declared()`, which is already what
  the drag and the keyboard treat as "where this pane is".
- ⚠ **Neither separator is reachable by a finger.** `md` is 768 and `lg` is 1024,
  which every tablet clears, so each was a tabbable capture-taking
  `touch-action: none` strip across the edge of the conversation with no visible
  appearance at all. `[@media(pointer:fine)]` is **nested inside** the width variant
  rather than written as a competing `[@media(pointer:coarse)]:hidden`: two
  `display` utilities in one string are resolved by Tailwind's emission order.
  `PaneHandle`'s docblock had claimed "only where the pointer is a mouse" since
  before either was true.
- **Keyboard and double-click are not decoration.** A separator only a pointer can
  move is one nobody on a keyboard can, with `aria-valuenow` announcing a number
  with no way to change it.
- ⚠ **One DOM read, once per gesture: `getComputedStyle(documentElement)` for the
  pane's own property.** That is CSS *answering* rather than JavaScript deciding —
  the licence `machineSwipe`'s `offsetParent` read is granted. Without it the first
  drag of the panel at `xl` begins from the `md` default and jumps 96px under the
  pointer.
- ⚠ **`col-resize`, and it is one of the app's two cursors** (the other is the
  text caret on the header's session name, Q3.665). It went out with every other
  one when the ban landed and came back by the owner's call: the ban is about a
  *pointer* shape claiming ordinary text is pressable, and an arrow pair over the
  division between two panes is the opposite — it is the only thing saying an 8px
  transparent strip can be dragged. `webcheck`'s allow-list holds this one path, and
  one entry covers both separators because it is one component.
  `web-typography.md` carries the ban and the exception.
- ⚠ **`RailHandle` survives as a two-line wrapper in `AppShell`** so that
  `<RailHandle />`, `left: "var(--rail-w)"` and `${LAYER.header}` stay literals in
  that file. Its position **after `<main>`** is the thing nothing else expresses:
  equal z-index, later sibling. Move it back between the panes and the top and
  bottom of a full-height divider go dead while the app looks entirely normal.
- ⚠ **The panel's handle is a *sibling* of the `<aside>`.** That element is
  `overflow-hidden`, so a strip on its edge is clipped away; and it is the element
  both exit keyframes are on, so a handle inside it rides the card off the screen on
  every close. `md:top-6 md:bottom-6` rather than the card's own `*-3`, because a
  16px `rounded-2xl` corner otherwise leaves the strip's ends over the conversation.

### The gutter is `calc` of the same property

`TASK_PANEL_WIDTH` is `md:w-[var(--task-fit)]` and `TASK_PANEL_GUTTER` is
`md:pr-[calc(var(--task-fit)+0.75rem)]` — the panel's width plus the 12px it stands
off the right edge, since that moves its *left* edge in by the same amount and a
gutter equal to the width alone is the card lying over the last 12px of every line.

⚠ **This retires a whole class of defect rather than fixing an instance.** It was
two Tailwind literals in two files four hundred lines apart, with a driver walking
both lists and asserting the subtraction at every breakpoint. There is no second
copy left to drift. What is still written twice is the 12px — three `*-3` utilities
and a `+ 0.75rem`, one distance in Tailwind's two spellings with nothing in CSS
relating them — so *that* is asserted as an equality.

⚠ **Spending `--task-w` here instead of `--task-fit` is the revert, and it looks
like a simplification** — one property rather than two — so the pair is asserted.

⚠ **`md:w-[20rem]` and its siblings are pinned absent.** Restoring one beside the
property is a smaller diff than any of this and leaves the panel at a fixed width
with the separator dragging a variable nothing reads.

## How a layer leaves

**Opening is a CSS animation on mount and needs no state. Leaving cannot be** —
an unmounted element does not animate — so a close keeps the element on screen with
the outgoing animation on it and drops it when the movement is over. `leaving.ts` is
that, extracted from `MenuDrawer` when `TaskPanel` needed it on a phone.

What the caller owes, each with the defect behind it:

1. **`shown` goes to the mount guard *and* `useDismissible`'s third argument, never
   `open`.** Passed `open`, the layer pops at the *start* of the exit: `#root` loses
   `inert` and the bare-letter shortcuts come back while an opaque panel still
   covers the app, so `j`/`k` walk the list behind it and Tab reaches controls
   nobody can see. The scrim still catches taps, so nothing pointing at the screen
   reproduces it — keyboard-only, which is why it survived being looked at.
2. **The transition is derived during render and may never move to an effect.** As
   an effect it painted a frame with *no panel at all*: the render where `open`
   turns false still saw `leaving === false`, took the early return and unmounted.
   Reported as the menu vanishing and then calmly closing a moment later.
3. **`animationend` is the clock; the constant is a backstop that may not be
   deleted.** A bare timer stands in for a duration that is not constant — under
   `prefers-reduced-motion` `index.css` collapses every animation to `0.01ms`, so
   the panel is gone in a frame while the timer holds the layer for the rest of its
   260ms. And an `animationend` that never arrives leaves `leaving` set for ever,
   which is worse than either window.
4. ⚠ **`event.target !== event.currentTarget`, never a name match on
   `animationName`.** It bubbles: a row, a spinner, the panel's own pulsing meter
   cell would end its parent's life from the inside. Comparing targets is a fact
   about *this* element; matching a keyframe would be one more copy of a string
   already living in three places.
5. **A distinct outgoing keyframe, never the arrival with `reverse`.** An element
   keeps its running animation while the `animation-name` list is unchanged, so
   swapping direction edits an animation that finished long ago rather than starting
   one — the panel vanishes in a single frame with every check green.
6. ⚠ **Every variant that can be on screen owes an exit.** `TaskPanel` carried
   `md:animate-none`, correct while a close was an unmount: it cancels
   `animate-sheet`, whose `translateY(100%)` would slide the docked card up from the
   bottom of the screen. With `animationend` as the clock it is exactly wrong — an
   element with `animation: none` fires none, so at `md` the exit falls to the
   backstop and leaves a **fully visible** card over the conversation for its whole
   duration. It is `md:animate-rise` arriving and `md:animate-rise-out` leaving now,
   and the cancellation moved onto the *other arm*: written beside a standing
   `md:animate-none` it would be two utilities setting one property in one variant,
   resolved by Tailwind's emission order rather than by the class string.

**The backstop is the longer of a surface's exits**, not the one it plays most —
260ms for the sheet against 140 for the card.

**One clock and one curve, since the durations are now the same.** Every sheet,
drawer and scrim arrives and leaves on `--sheet-ms` and `--sheet-ease`, which
`sheetMotion.ts` spells as `SHEET_MS` and `SHEET_EASE` for the backstops and the
settle; `webcheck` asserts the pair. The three per-surface constants went with the
three durations they stood for (Q3.650).

**`AgentConfigBar`'s picker is a caller now.** It kept a timer and an `open` flipped
from inside it; the anchored panel draws on `open` and the sheet on `shown`.

⚠ **`pb-safe` is spelled as its own value on the panel, and that is a cascade fix
rather than a divergence.** `.pb-safe` is unlayered while Tailwind emits every
utility inside `@layer utilities`, so the `md:pb-0` at the end of that class string
was a silent no-op: measured at 1280, `padding-bottom` computed 12px against a
`md:pb-0` asking for 0, leaving the body 28px above the card's bottom border and
16px below its top. Written as `pb-[max(0.75rem,env(safe-area-inset-bottom))]` it is
the same value in the same layer and the variant can win. `Composer.tsx` records the
identical fact and names `SHEET_PANEL`'s `sm:pb-0` as still losing it.

**The scrim leaves too, and stops taking taps the instant it starts.**
`--animate-scrim-out` ends at `opacity: 0` while the element lives on, so without
`pointer-events-none` the tail of every close is an invisible viewport-sized
click-eater. `TaskPanel`'s scrim had no animation in **either** direction, which was
half of what "it disappears" was about.

## How a panel is dragged away

**One gesture, `useSheetGesture` in `sheetDrag.ts`, and each surface supplies only
geometry.** The config picker, `TaskPanel` below `md`, the routed `Sheet` below
`sm` and the drawer all drag through it; `useSlideSheet` is the geometry of the three
that simply slide. The decisions are pure in `sheetMotion.ts`, which imports nothing
so `webcheck` drives them. Q3.650, Q3.651.

- ⚠ **A finger is on the touch stream, never the pointer stream.** Pointer events
  were the defect: wherever `touch-action` allowed a pan — the picker's full list —
  the engine took the gesture and sent `pointercancel` on the first move, so the
  panel never moved. `useTouchGesture` puts non-passive listeners on the panel, and
  the first move past `PRESS_SLOP` is refused to the scroller with `preventDefault`
  only when `claimDrag` says it is the panel's. A mouse keeps the pointer path,
  captured at engage and never at the press.
- **`claimDrag` decides once**, at the first move past the slop. Along the axis by
  `DOMINANCE`, shared with `machineSwipe`; never against `cancelable === false` or
  a move an inner gesture already refused; never after `PRESS_MS` held, which is a
  text selection or a row's own drag arming; and inside a scroller only when it
  cannot move that way — so a list at its top hands a downward drag to the panel and
  keeps every other. ⚠ **The scroller is found by its computed `overflow-y`**, never
  marked by hand: a mark was one more thing the next screen could forget.
- **`sheetRelease`: a fling or a distance.** `FLING` px/ms toward the exit, or
  `dismissAt` — `DISMISS_PX`, or a third of a short panel — and never while flung
  back. Distance alone was the old rule, and a 60px flick snapped back.
- ⚠ **A dismissal keeps the offset.** The exit keyframes have no `from`, so the
  element's inline transform is where they leave from; `webcheck` pins both. So a
  panel reopened mid-exit is put back by `useSlideSheet`, or it arrived to where the
  drag had let go.
- ⚠ **The exit curve is the arrival's.** The mirrored ease-in moved a sheet 8% of
  its way in the first 60% of its time, so a flung panel stopped dead under the
  finger before it fell.
- ⚠ **A move is one transform, written once per frame, and nothing else.** From
  engage to the end of the settle the panel is `will-change: transform` — its own
  layer, so a move is a compositor update — and its offset is whole device pixels.
  Measured without: every move repainted the whole viewport, the grab bar re-rasterised
  at a new sub-pixel phase each frame (the flicker reported on Android), and New
  session was painted per move. So **a panel stops at open** rather than growing past
  it — a height per move laid New session out 25 times in 30 moves — and **the
  picker is laid out at full once, at engage**, with both detents a translate.
- ⚠ **`transition` is held at `none`, never cleared.** `index.css`'s reduced-motion
  block gives every property a 0.01ms transition, whose first frame is the old value.
- **A drag begins where the panel is drawn**: `hold` reads the computed transform,
  finishes the arrival and cancels a settle, so a grab mid-flight does not jump.
- **The layout gate is a grabber CSS hides** — `md:hidden` in `TaskPanel`,
  `sm:hidden` in `Sheet` — read through `offsetParent` per gesture, the
  `machineSwipe` licence. The docked card and the dialog never drag.
- **`Sheet` drags from anywhere on it, as the pickers do** (it was the head only):
  its screens' scrollers hand a drag over at their top, a tap is not a drag, and a
  mouse on a field is editing. Its close is a navigation, so the `sheet-close` view
  transition captures the dragged panel and leaves from there.
- **The scrim is a grip too** (Q3.660): a drag begun on its bare surface moves the
  panel as one begun on the panel does, through the same hook, and a tap still
  closes. A scrim beside its panel fades with how much of the panel is out; the
  routed `Sheet`'s is the panel's parent and does not (Q3.650). The sibling scrims
  are `touch-none`, having nothing to pan or zoom.
- **The drawer is also pulled open**, from the list's first page (Q3.657,
  `drawerPull`): drawn for the gesture without being a layer, and opened, if it is,
  through the menu button's own state. `machine-gestures.md` has the arbiter. A
  drag begun inside that open's settle takes the drawer where it is drawn
  (`yieldPull`), or the pull's timer flashed it fully open under the finger.
- **The click a drag leaves behind is swallowed** for `CLICK_AFTER_DRAG_MS` and
  reset by the next press, so a keyboard's Enter is never eaten.
- **Reduced motion**: the settle and the exit are CSS, which `index.css`'s blanket
  block zeroes; what is written per move is only the finger's own position.
