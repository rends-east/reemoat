---
paths:
  - packages/web/src/machineOrder.ts
  - packages/web/src/ui/machineDrag.ts
  - packages/web/src/ui/machineSwipe.ts
  - packages/web/src/ui/MachineColumn.tsx
  - packages/web/src/ui/SessionBrowser.tsx
  - packages/web/src/ui/backSwipe.ts
---

# The machines: their order, and the gestures that move between them

`web-shell.md` owns the rail. This file: the machine folders' order, this computer's name,
and the touch gestures sharing one screen with each other and with the chat rows' drag.

## Ordered by name, this computer first, until a reader drags one

Ordering by `reach` or activity is banned (both flicker on the four-second poll). A stored
order moves only when somebody moves it, so `reemoat.machineOrder` is merged over the name
sort, per device in `localStorage` (the `reemoat.railWidth` / `reemoat.machineTab` idiom,
the owner's call; a desktop's order is not a phone's). The one derived input is **which
computer this client runs on**: seeded at launch from `NativeBoot.claimed` (no daemon
needed), replaced by a later read (launch, wake, a machine just created) only when it names
a *different* machine of the account's, never cleared by a read that finds nothing (a
restarting daemon, a missed `/health`: `localMachineAfter`), never read off the poll.
Q3.619, Q7.139.

`machineOrder.ts` holds the merge and no DOM, so `webcheck` imports it; it sits beside
`store.ts`, which reads it and may not import from `ui/`. Four clauses, two `orderStrip`'s:

1. `first` (`AppState.localMachineId`) leads, ahead of the stored ids (or it would lead only
   on a fleet nobody dragged), unless `stored` names it; a stored position always wins.
   `null` or an id the fleet lacks changes nothing.
2. Stored ids next, in stored order, keeping only what the fleet still holds.
3. Everything unknown, in `natural` order (already sorted by name), at the end.
4. No `hidden` clause, ever: a machine with no sessions keeps its tab, the only route to
   starting a session on a machine just added.

`natural` decides membership; `stored` and `first` decide only order. A duplicate guard
holds (storage is hand-editable; one id twice is two tabs selecting each other). A drag
stores `first`: `setMachineOrder` writes the whole drawn list (Q7.139). `nextOrder` keeps a
slot for a machine the fleet has lost, unlike the agent strip, because `selectedMachineIn`
promises revoke-and-restore for the tab. A whole-list rewrite per reorder, never a
`sessions.rank` position clock. Q3.619.

## This computer is called `local`, on this computer only

`machineDisplayName` (`machineOrder.ts`) is the one rule: `local` (`LOCAL_DISPLAY_NAME`) for
`localMachineId`, the stored label otherwise. Drawn, never stored; the control-plane label
stays the host name for phones and grantees. `sessionGroups` fills `MachineGroup.name` from
it, so the strip, the rail (label, `title`, monogram) and the drag's announcement inherit it;
New session reads `machinesAsDrawn`; `MachineLabel` (Q3.681) and `WorkspaceLine`'s
`machine · path` call it directly. Q7.139.

A machine whose own label is `local` (Q7.139 migrated nothing; `nameVisibleTo` allows it)
is drawn `local-<hex>`, `qualifiedName`'s shape (for one never renamed, its
`machines.name`): case-folded, and whether or not this computer is known yet.

The real label stays in **Settings → Machines**, which shows the host name and badges the row
`this device` (`webcheck` pins every file under `ui/settings/` free of the function; the
rename field is in `MachineSection.tsx`), and in **a sentence** (a resume failure, a
reachability line). `webcheck` sweeps `ui/` and `store.ts` for the literal.

## The merge is applied in the store, and the memo is load-bearing

`sessionGroups` wraps its name sort in `orderMachines`, so both axes inherit one answer and
`machineTabs` adds no sort (as `groups.ts`'s docblock says). It is memoised on the identity
of `sessions` and `machines`, which neither a reorder nor a `localMachineId` patch replaces,
so `machineOrderVersion()` and `localMachineId` are the guard's third and fourth inputs, or a
change waits for a poll. Source-text assertions stay green with the guard reverted, so both
are driven against the real function, on ids no other section stored (`setMachineOrder([])`
is not a reset). Q3.619.

`bootstrap` seeds `localMachineId` from the claim and reads it live inside the listing's
`Promise.all`, both before `phase: "ready"`, never only in `runResume` (on a cold launch the
app's daemon is stopped). Each live answer is weighed again once a listing lands
(`weighLocalMachine`): *a machine of ours* is a question about the list.

`groups.ts` carries `subscribeMachineOrder(bump)`; both readers already subscribe to
`groupsVersion`, so no second `useSyncExternalStore`.

## The reorder is a hook, not a component

The axes are two components (`MachineColumn`'s docblock, `web-shell.md`); a shared
`<MachineList axis=…>` would revive the `variant` prop. `useMachineDrag` is one gesture, two
presentations.

- Neither axis has a handle and both are scrollers, so the class spelling of
  `touch-action: none` is out (`webcheck` pins it absent from `SessionBrowser.tsx`, prose
  included); `machineDrag` sets the property for the gesture. A finger holds 400 ms (`PRESS_MS`,
  abandoned past `PRESS_SLOP`), a mouse travels 4 px (`MOUSE_SLOP`), all imported from
  `rowDrag.ts`.
- A finger never touches the pointer stream. Listeners go on in the **ref callback**: they
  must exist before the first `touchstart` and survive the node being replaced.
- The pointer is captured at `arm`, never at the press, which would retarget the `<button>`'s
  synthesised `click`. Q3.576.
- A reorder never **selects the tab it dropped** (`onClickCapture` eats the `click`),
  **scrolls the list** (default `touch-action` until `arm`, `preventDefault` only while
  armed), or **moves `All`** (it has its own `data-machine`, so indices are over `tabs`; a node not in
  it refuses to arm).
- `dropSlot` (the pointer passing a neighbour's midpoint), not `dropIndex`, which divides by
  one row and drifts on a strip of unequal widths. Q3.574's `origin.index` and `target.index`
  are one number here: one list.
- Keyboard parity is owed (`agent-strip.md`): `Alt`+arrows and `Alt+Home`/`End`, leaving
  `keyboard.ts`'s bare keys alone, announced from one sentence the hook owns into an
  `sr-only` live region both axes draw.
- No write can fail (`setMachineOrder` is `localStorage` and a version bump): no
  `UNREACHABLE` sentence, no sequence guard, no restore.

## Swiping between machines, on the list and not on the strip

`useMachineSwipe` lives on the list's pager window, around its scroller (Q3.667); the strip's
own horizontal gesture is its scroll. It needs no coordination with the tab drag: the strip's
scroller and the list's window are siblings, so the box the finger landed in decides. It does
share `rowDrag`'s scroller: `SWIPE_SLOP` is `PRESS_SLOP`, imported (8 px, below the ~10 px
where engines commit a pan, so the hold is dead before the swipe decides), and the swipe
refuses while `armed()`, a ref and not React state. Q3.620.

Horizontal intent is decided once, `|dx| > |dy| * 1.5` past the slop (`DOMINANCE`,
`sheetMotion.ts`); a diagonal is a scroll and `event.cancelable === false` is a vertical.
`preventDefault` only once the axis is `"x"`, never on `touchstart` (it would kill the tap
that opens a session). The scroller also carries `[touch-action:pan-y_pinch-zoom]`, one
arbitrary value rather than two utilities, `pinch-zoom` kept. The platform's Back keeps a
24 px band at each edge; `html { overscroll-behavior: none }` stops only the rubber-band.

`[All, …machines]`, clamped, never wrapping; toward no neighbour the list does not move
(`pageOffset`). The commit is `selectMachine` only: no route, no history entry, no view
transition (`announce`/`data-nav` and `navMove` are for screens).

The gate is no JavaScript breakpoint (`SessionBrowser` mounts twice; `AppShell` forbids a
second source of truth for the width): the swipe runs where the `lg:hidden` strip is laid
out, `offsetParent !== null`, asked at `touchstart`, never cached. Q3.621.

`prefers-reduced-motion` is read here, since `index.css`'s blanket block cannot reach a
per-frame transform: no transform is written and the swipe still commits.

### A page turn (Q3.655)

The neighbour's list slides in beside this one, both follow the finger, and a release carries
the pair on or home: `pageTurn`, `sheetRelease` on its side (a fling, or `DISMISS_PX`), on the
sheets' clock and curve.

- The page that moves is the scroller, inside a clipping window: snapped, `will-change` only
  for the gesture, `transition` held at `none` (`docked-panels.md`).
- The turn commits in one task once the strip rests: `flushSync` selects the machine and
  unmounts the neighbours, the scroller goes to the top and back to 0, then it paints.
- The neighbours are a store, not state; only `BesidePanes` reads it. It mounts once per
  direction, synchronously, before the frame that shows it.
- Cut to a screen (`takeRows`, measured once per gesture at `ROW_FLOOR_PX`), and a picture:
  `inert`, `aria-hidden`, no pointer events.

### A flick that follows a flick (Q3.667)

A turn commits only when the strip rests. The finger is heard on the window, which never
moves (`windowRef`). A touch catches a settling turn where it is drawn (`hold`: the computed
transform read back by `offsetFrom`; pages and `TabPill.hold` stop there, no commit);
sideways it drags from the page the turn was heading for (`listGesture`'s `turning`: never the
drawer, never a pull), a tap or vertical move lets it carry on. Neighbours are the strip's
pages, keyed by place (`data-beside`); while a turn settles its page and both neighbours are
mounted (`pagesFor`) after the frame that starts the settle. The pill's legs follow the strip
(`nextPage`, `legProgress`).

### Three gestures on one list, decided once (Q3.657, Q3.658)

`listGesture`, pure and asserted, takes the first move past the slop as a **page**
(sideways), the **drawer** (rightward on the first page), a **pull** (downward from the top,
never over an open gap: `claimDrag` with `DOMINANCE`), or nobody's; never against a panning
engine, and the 24px edge bands stay the platform's Back.

- The drawer is mounted for the gesture but is not a layer: `drawerPull` flips a store
  `MenuDrawer` reads, it mounts closed, and each frame writes its transform and the scrim's
  opacity; nothing goes inert. Released open (`sheetRelease`) it opens through `onMenu`, the
  button's path; given back, it unmounts closed.
- A pull moves the list down (`pullOffset`); past `PULL_HOLD_PX` the gap holds, with
  `WorkingMark`, exactly as long as `store.resume("pull")` takes, then closes; nothing is
  drawn for a failure, and no other gesture starts meanwhile. `overscroll-behavior: none`
  keeps the engine's refresh out.
- Reduced motion: nothing follows; drawer and gap open and close with no transition.

### Back to the list from a conversation (Q3.663)

Below `lg` a conversation dragged rightward follows the finger over the list, drawn as the
chevron's pop draws it (`BACK_UNDER_SHIFT`, `BACK_UNDER_OPACITY`, off `nav-under`).
`backClaim` decides once: rightward by `DOMINANCE`; never against a panning engine, while a
horizontal scroller under the finger can scroll back, from a field, over a selection, past a
long press, from the edge bands, while anything but the ask card is a layer, or on the press
that closed a menu (read at `pointerdown`). The gate is the back chevron being laid out.

- The list under it is its own element: `PhoneList` is keyed the same on both routes, so
  landing (`navigateDrawn`, no view transition) keeps it and its scroller, in one task with
  the route change. Drawn for the gesture it is inert, unread, cut to one screen.
- `main` is clipped while the list is drawn under it.
- A settle overtaken by another route gives back. Reduced motion: nothing follows; a release
  that goes back takes the chevron's path.

## The desktop column marks the selected machine, not a band (Q3.624)

A filled 28px mark; the tile paints nothing, since a band could never line up with the
session list's selected row beside it. The `bg-brand` fill (Q3.694) narrows Q3.209: licensed
as a mark, by area. It carries `transition-colors` (the chip is a child of the `.tap` button
and `transition` is not inherited), never `transition-transform`: neighbours slide with
`slides`, and `webcheck` bans the utility in the column and `MachineTabs`. The badge carries
`ring-2 ring-ink`, since it overlaps the mark in the same fill.

## The tabs' own numbers

`All`, a machine tab and the `+` share one inset. `min-w-22` (two 44 px floors) is on the
non-`lone` arm only; the lone case keeps `flex-1`. The tab's `px-1` plus its pill's `px-3`
make the `+`'s `px-4`, and `webcheck` requires the sum; the pill hugs the label, the tab keeps
its target. The edge fade `w-8` is twice the inset, asserted as the relation.

The 72 px column did not follow: `MACHINE_COLUMN_PX` moves all three rail bounds and
`clampRailWidth` keeps a stored total, so readers would lose the delta off their list. Its
own bound is 68 px of name, so two hosts do not elide to `server-…`.

## The pill that marks the selected machine (Q3.656)

At rest the pill is the selected tab's own: `TabLabel`'s span, `bg-raised` (Q3.209), the
count `bg-brand` on top. So scroll, reorder, resize, font load, machines arriving or leaving
and first render move it with no code.

Every change of tab is a trip. `useTabPill` measures both tabs, the strip and the scroller
once, sets `data-pill-travel` (an unlayered rule stands each tab's pill down) and draws a
traveller that hands back at the identical rect. The swipe drives it by progress and settle;
a tap, key or fallback drives it from `MachineTabs`' layout effect, before the new pill
paints, never while a turn carries it.

- Strip coordinates, because All does not scroll (Q3.610); each end clipped to the
  scroller's visible box (`clipSpan`), so it reaches All and never leaves the strip.
- Three pieces, transforms only (`pillPieces`): two caps and a stretching middle; snapped,
  promoted only for the trip, `transition` at `none`.
- The strip follows: `scrollToShow` shows the whole target, by progress in the drag and in
  frames on `easeAt` in the settle, landing before the hand-off; `scrollIntoView` stands down
  during a trip.
- Selection never changes a label's weight, or the measured tab would not be the landed one.
- Reduced motion: no trip. The desktop column keeps its mark (Q3.624).
