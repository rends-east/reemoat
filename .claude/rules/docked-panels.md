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

# A second surface: how wide it is, how it leaves, how it is dragged away

`TaskPanel` (a bottom sheet on a phone, docked right from `md`) shares its width mechanism
with the rail and its exit with the menu drawer. `web-shell.md` owns the rail as a layout.

## How wide a draggable pane is

**`paneWidth.ts` is the mechanism; `rail.ts` and `taskWidth.ts` instantiate it.** `rail.ts`
keeps its filename and its four exports, `clampRailWidth`, `railWidth`, `setRailWidth`,
`subscribeRail`, which `webcheck` drives by name and behaviour. The state is module state
seeded from `localStorage`, never `useState` (the panel unmounts on every close). It holds
no DOM: `webcheck` stubs only `window.location` and `window.localStorage`. The impure shells
are `AppShell`, which writes both properties, and `PaneHandle`, one write per `pointermove`.
**The width is a CSS custom property, never a React prop**: the store publishes on the 4s
poll and every streamed event, which would reset a React-owned width mid-drag.

**`null` is a state only the panel has.** The rail has one width at every size, so
`railWidth()` answers a number. The panel has two declared widths in `index.css`, 20rem
stepping to 26rem at `xl` (at `lg` the rail takes `RAIL_DEFAULT`), so `null` means the
stylesheet decides and a chosen width goes on `documentElement`, beating both. A
double-click resets. **The reset removes the key, never writes the default**, which would
beat both blocks forever; driven in `webcheck`, not read off the source. Both declarations
are unlayered `:root` and `@media` adds no specificity, so the wide one wins by coming
later; `webcheck` asserts the order. px on both sides: the driver derives both declared
widths from `taskWidth.ts`'s constants.

**No JavaScript clamp against the available width**: `webcheck` bans `matchMedia`,
`innerWidth` and `clientWidth` in `TaskPanel.tsx` by literal. **The clamp is CSS, and
mandatory**, since the two panes' sum is bounded nowhere (`TASK_MAX` 512, `RAIL_MAX` 552):
`--task-fit` is `min(var(--task-w), calc(var(--task-room) - 15.75rem))` — a 240px floor
for the conversation plus the 12px gap — with `--task-room` the window less the rail where
the rail exists. `--task-w` is the stored number `PaneHandle` writes, reads back and
announces; `--task-fit` is what the panel and the gutter spend. `var()` substitutes lazily,
so redefining `--task-room` at `lg` and `--task-w` at `xl` re-resolves `--task-fit` at use;
there source order does not decide.

**The gutter is `calc` of the same property**: `TASK_PANEL_WIDTH` is
`md:w-[var(--task-fit)]`, `TASK_PANEL_GUTTER` is `md:pr-[calc(var(--task-fit)+0.75rem)]`,
width plus the 12px standoff, with no second copy to drift. The 12px is still written twice
(three `*-3` utilities and `+ 0.75rem`), asserted as an equality. Spending `--task-w`
instead of `--task-fit` is the revert that looks like a simplification; the pair is
asserted. `md:w-[20rem]` and its siblings are pinned absent.

## The separator

**One `PaneHandle`, two panes; `sign` is the whole difference** (the rail is left of its
handle, the panel right), read out of both call sites.

- `setPointerCapture`, never `window` listeners: a release outside the browser window
  delivers no `pointerup`. Capture also makes teardown structural.
- `pointercancel` reverts to the committed width. A press that never moved commits nothing
  (it would store `declared()` as a chosen width).
- Unmounting mid-drag delivers no `pointerup`, `pointercancel` or `lostpointercapture`, so a
  cleanup effect does `finish`'s restore half. The panel's separator unmounts on every
  close; Escape closes it mid-drag, and `"menu"` does not stand down `j`/`k`, so a session
  switch does too.
- `aria-valuenow` is required on a focusable separator (WAI-ARIA 1.2); it falls back to
  `declared()`. Keyboard and double-click on the handle are required, not decoration.
- Neither separator is reachable by a finger: `[@media(pointer:fine)]` nested inside the
  width variant, never a competing `[@media(pointer:coarse)]:hidden` (two `display`
  utilities resolve by emission order).
- One DOM read per gesture: `getComputedStyle(documentElement)` for the pane's own property
  (CSS answering, the licence `machineSwipe`'s `offsetParent` read has); without it the
  panel's first drag at `xl` jumps 96px.
- `col-resize` is one of the app's two cursors (the other is the text caret on the header's
  session name, Q3.665), by the owner's call; `webcheck`'s allow-list holds this one path
  for both separators. `web-typography.md` carries the ban.
- `RailHandle` is a two-line wrapper in `AppShell` so `<RailHandle />`,
  `left: "var(--rail-w)"` and `${LAYER.header}` stay literals there. It sits after `<main>`
  (equal z-index, later sibling) or a full-height divider goes dead at both ends.
- The panel's handle is a sibling of the `<aside>`, which is `overflow-hidden` and carries
  both exit keyframes. `md:top-6 md:bottom-6`, not the card's `*-3`, so the 16px
  `rounded-2xl` corner leaves no strip end over the conversation.

## How a layer leaves

Opening is a CSS animation on mount. Leaving keeps the element with the outgoing animation
and drops it when done: `leaving.ts`, used by `MenuDrawer`, `TaskPanel` and
`AgentConfigBar`'s picker (`web-composer.md`). The caller owes:

1. `shown` to the mount guard and `useDismissible`'s third argument, never `open`, or
   `#root` loses `inert` during the exit and `j`/`k` and Tab reach the hidden app.
2. The transition derived during render, never in an effect (which paints a frame with no
   panel).
3. `animationend` as the clock, and the constant as a backstop that may not be deleted
   (reduced motion collapses animations to `0.01ms`; a lost `animationend` would leave
   `leaving` set forever). The backstop is the longer of a surface's exits: 260ms for the
   sheet, 140 for the card.
4. `event.target !== event.currentTarget`, never a match on `animationName` (it bubbles).
5. A distinct outgoing keyframe, never the arrival with `reverse` (an unchanged
   `animation-name` list restarts nothing).
6. An exit on every variant that can be on screen: `TaskPanel` is `md:animate-rise`
   arriving and `md:animate-rise-out` leaving; `md:animate-none` fires no `animationend`, so
   it lives on the other arm, never beside a standing variant.

Every sheet, drawer and scrim arrives and leaves on `--sheet-ms` and `--sheet-ease`,
`SHEET_MS` and `SHEET_EASE` in `sheetMotion.ts`; `webcheck` asserts the pair (Q3.650). The
panel spells `pb-safe` as `pb-[max(0.75rem,env(safe-area-inset-bottom))]`: `.pb-safe` is
unlayered and utilities are in `@layer utilities`, so `md:pb-0` lost to it. `Composer.tsx`
records the same and names `SHEET_PANEL`'s `sm:pb-0` as still losing. The scrim leaves
too, with `pointer-events-none` from the instant it starts.

## How a panel is dragged away

**One gesture, `useSheetGesture` in `sheetDrag.ts`; each surface supplies geometry.** The
config picker, `TaskPanel` below `md`, the routed `Sheet` below `sm` and the drawer drag
through it; `useSlideSheet` is the geometry of the three that slide. The decisions are pure
in `sheetMotion.ts`, which imports nothing. Q3.650, Q3.651.

- **A finger is on the touch stream, never the pointer stream** (the engine sends
  `pointercancel` wherever `touch-action` allows a pan). `useTouchGesture` puts non-passive
  listeners on the panel; the first move past `PRESS_SLOP` gets `preventDefault` only when
  `claimDrag` says it is the panel's. A mouse keeps the pointer path, captured at engage,
  never at the press.
- `claimDrag` decides once, at the first move past the slop: by axis with `DOMINANCE`
  (shared with `machineSwipe`); never on `cancelable === false` or a move an inner gesture
  refused; never after `PRESS_MS` held; inside a scroller only when it cannot move that
  way. The scroller is found by computed `overflow-y`, never marked by hand.
- `sheetRelease`: a fling (`FLING` px/ms toward the exit) or a distance (`dismissAt`:
  `DISMISS_PX`, or a third of a short panel), never while flung back.
- A dismissal keeps the offset: the exit keyframes have no `from`; `webcheck` pins both. A
  panel reopened mid-exit is put back by `useSlideSheet`. The exit curve is the arrival's.
- A move is one transform per frame and nothing else: `will-change: transform` from engage
  to the end of the settle, offsets in whole device pixels. A panel stops at open rather
  than growing past it; the picker lays out at full once, at engage (`web-composer.md`).
- `transition` is held at `none`, never cleared (reduced motion gives every property a
  0.01ms transition).
- A drag begins where the panel is drawn: `hold` reads the computed transform, finishes the
  arrival and cancels a settle.
- The layout gate is a grabber CSS hides (`md:hidden` in `TaskPanel`, `sm:hidden` in
  `Sheet`), read through `offsetParent` per gesture. The docked card and the dialog never
  drag.
- `Sheet` drags from anywhere on it: its scrollers hand over at their top, a tap is not a
  drag, a mouse on a field is editing. Its close is a navigation, so `sheet-close` leaves
  from where the drag let go.
- The scrim is a grip too, and a tap still closes (Q3.660). A sibling scrim fades with how
  much of the panel is out; the routed `Sheet`'s is its parent and does not (Q3.650).
  Sibling scrims are `touch-none`.
- The drawer is also pulled open from the list's first page (Q3.657, `drawerPull`): drawn
  without being a layer, opened through the menu button's state (`machine-gestures.md`). A
  drag inside that open's settle takes the drawer where it is drawn (`yieldPull`).
- The click a drag leaves is swallowed for `CLICK_AFTER_DRAG_MS`, reset by the next press,
  so a keyboard's Enter is never eaten.
- Reduced motion: the settle and exit are CSS, zeroed by `index.css`; per move only the
  finger's position is written.
