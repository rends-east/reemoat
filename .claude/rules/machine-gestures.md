---
paths:
  - packages/web/src/machineOrder.ts
  - packages/web/src/ui/machineDrag.ts
  - packages/web/src/ui/machineSwipe.ts
  - packages/web/src/ui/MachineColumn.tsx
  - packages/web/src/ui/SessionBrowser.tsx
  - packages/web/src/ui/backSwipe.ts
---

# The machines: their order, and the two gestures that move between them

`web-shell.md` owns the rail. This is the narrower subject it points at: what
order the machine folders are in, who decides, what this computer's own is called,
and the two touch gestures that share one screen with each other and with the chat
rows' own drag.

## Ordered by name, this computer first, until a reader drags one

**A stored order is allowed where a derived one is not, and the distinction is the
old rule's own stated reason.** `reach` and activity flicker on the four-second
poll, so a list ordered by either reshuffles under a travelling thumb. An order
somebody set cannot: it moves when they move it and at no other moment. So
ordering by reachability or activity stays banned outright, and
`reemoat.machineOrder` is merged over the name sort. **Which computer this client
runs on** is the one derived input admitted, for the same reason: it is seeded at
launch from the machine this app created for the server (`NativeBoot.claimed`,
which needs no daemon), replaced by a later read — at launch, on a wake, or the
machine just created — only when it names a *different* machine of the account's, and never cleared by a read that finds
nothing (`localMachineAfter`) — so a restarting daemon or a missed `/health` moves
nothing, and nothing reads it off the poll.

**Per device, in `localStorage`** — the `reemoat.railWidth` / `reemoat.machineTab`
idiom, and the owner's call: the control plane has nowhere to put a per-user order
and a schema migration is not worth one. The cost is stated rather than smoothed
over: the order you set on a desktop is not the order on your phone.

**`machineOrder.ts` holds the merge and no DOM**, so `webcheck` can import it, and
it sits beside `store.ts` rather than under `ui/` because `store.ts` reads it and
may not import from `ui/`. Four clauses, two of them `orderStrip`'s:

1. **`first` — `AppState.localMachineId` — leads, unless `stored` names it.** Ahead
   of the stored ids rather than among the strangers, or it would lead only on a
   fleet nobody ever dragged. A stored position always wins, so this fills the
   default and never overrides a drag. `null`, or an id the fleet does not hold
   (another fleet's daemon), changes nothing.
2. **Stored ids next, in stored order**, keeping only what the fleet still holds.
3. **Then everything unknown, in natural order, at the end** — and `natural`
   arrives already sorted by name, so that clause *is* the name sort rather than a
   replacement for it.
4. **No `hidden` clause, ever.** `natural` decides membership outright, or *"a
   machine with no sessions still gets a tab"* is reversed through the other door —
   and that tab is the only route to starting a session on a machine just added.

⚠ **`natural` decides membership; `stored` and `first` decide only order.** Plus
a duplicate guard, because this list comes out of storage a person can hand-edit
and one id drawn twice is two tabs that select each other.

⚠ **A drag is what stores `first`.** `setMachineOrder` writes the whole drawn
list, so the first drag of *any* machine pins this one where it was drawn, and
clause 2 holds it from then on. A reader who had dragged before clause 1 existed
has it stored already, wherever it was drawn then — it stays there until they move
it. Q7.139.

⚠ **`nextOrder` keeps a slot for a machine the fleet has lost**, and this is the
one place it diverges from the agent strip, which drops such an entry on the next
reorder. `selectedMachineIn` already promises revoke-and-restore for the selected
*tab*; an order that forgot while the tab remembered would be two halves of one
preference disagreeing.

**Why this and not `sessions.rank`.** That is a position *clock*, and it is right
there for the reason `agentStrip.ts` argues one list over: **which list gains
members on the commonest act in the product.** Starting a session is what this app
is for, so a new row needs an honest position with nothing stored. Machines are
added by hand, a handful per account, over months — so a whole-list rewrite per
reorder costs nothing and removes every way the arithmetic can be wrong. There is
also no server to hold a rank, and this list is bounded where sessions are not.

## This computer is called `local`, on this computer only

**`machineDisplayName`, in `machineOrder.ts`, is the one rule**: `local`
(`LOCAL_DISPLAY_NAME`) for `localMachineId`, the stored label for everything else.
Drawn, never stored — the control-plane label is the host name, because a phone and
every grantee read that row and to them `local` is somewhere else (Q7.139).
`sessionGroups` fills `MachineGroup.name` from it, so the strip, the rail (label,
`title`, the monogram's letter) and the drag's announcement inherit it with no call
of their own; New session reads `machinesAsDrawn` for the rail's order, names and
default; the two `machine · path` lines (a row under All, `WorkspaceLine`) call it
directly.

⚠ **`local` means this computer and nothing else, on this client.** A machine
whose own label is `local` — Q7.139 migrated nothing, so a Mac can carry its
old one beside the one it runs now, and `nameVisibleTo` lets any other be renamed
to it — is drawn `local-<hex>`, `qualifiedName`'s shape and, for a machine never
renamed, exactly its `machines.name`. Case-folded, and whether or not this
computer is known yet, so that tile's name never waits on the identification.

⚠ **Two places keep the real label, deliberately.** **Settings → Machines** is
where a label is managed — renamed, compared, told apart from a collision — so it
shows the host name and badges the row `this device`; `webcheck` pins **every
file under `ui/settings/`** free of the function, since the rename field is in
`MachineSection.tsx`, one file along from the list. **A sentence** — a resume failure, a reachability line — keeps it
too: "on local" reads as a word missing, and a sentence is what gets pasted to
somebody at another client. `webcheck` also sweeps `ui/` and `store.ts` for the
literal, so no screen spells the word itself.

## The merge is applied in the store, and the memo is the load-bearing half

`sessionGroups` wraps its name sort in `orderMachines`, so **both axes inherit one
answer** and `machineTabs` still adds no sort of its own — which is what keeps
`groups.ts`'s own docblock true and the assertion under it green.

⚠ **`sessionGroups` is memoised on the identity of `sessions` and `machines`, and
a reorder replaces neither.** Without `machineOrderVersion()` in that guard a drop
repaints nothing until the poll happens to hand over a new `machines` array — a
drag that does nothing for four seconds and then jumps. **Every assertion written
off the source text stays green with the guard reverted**, so that pair is driven
against the real function instead. It is the third input.

⚠ **`localMachineId` is the fourth, for the same reason**: it is patched on its own
and replaces neither array, so without it the rail kept the host name, in name
order, until a poll. It is driven the same way, on ids no other section has
stored — `setMachineOrder([])` is not a reset (`nextOrder` keeps every slot), so
borrowed ids would test the leftover. **`bootstrap` seeds it from the claim**,
then reads it live inside the listing's own `Promise.all`, both before
`phase: "ready"`: the app stops its own daemon at quit, so on a cold launch the
live read finds nothing, and read only in `runResume` the tile was renamed and
moved once on every launch. ⚠ **Each live answer is weighed again once a listing
lands** (`weighLocalMachine`): *a machine of ours* is a question about the list,
and both reads are made before it is current — so the daemon of a machine just
created would otherwise lose to a claim for one since switched off.

`groups.ts` carries one line, `subscribeMachineOrder(bump)`: both readers already
subscribe to `groupsVersion`, and a second `useSyncExternalStore` in each would be
two subscriptions to keep in step for one counter.

## The reorder is a hook, and deliberately not a component

`MachineColumn`'s docblock argues — and `web-shell.md` restates — that the two axes
are **two components** and that a `variant` prop *"which could disagree with the
CSS no longer exists"*. A shared `<MachineList axis=…>` would undo exactly that.
`useMachineDrag` inverts it: **one gesture, two presentations.**

**Arming, because neither axis has a handle and both are scrollers.** The entry
*is* the surface a finger scrolls with, so the class spelling of `touch-action:
none` is out — `webcheck` pins that string absent from `SessionBrowser.tsx`,
prose included, and `machineDrag` sets the property imperatively for the length of
a gesture instead. What separates the verbs is time: **a finger holds 400 ms**
(`PRESS_MS`, abandoned past `PRESS_SLOP`), **a mouse travels 4 px** (`MOUSE_SLOP`).
All three constants are **imported from `rowDrag.ts`**, never re-typed.

⚠ **A finger never touches the pointer stream**, and the listeners go on in the
**ref callback** rather than an effect — they must exist before the first
`touchstart` the node can receive, and must survive the node being replaced.

⚠ **The pointer is captured at `arm`, never at the press.** The entry is a
`<button>` whose `onClick` selects the machine, and capture retargets the
synthesised `click`. Q3.576, one control over.

**Three things a reorder must not do**, each with its mechanism: **select the tab
it dropped** (`onClickCapture` eats the trailing `click` — the likeliest defect in
the whole change); **scroll the list** (default `touch-action` until `arm`,
`preventDefault` only while armed); **move `All`** (it carries a `data-machine` of
its own, so every index is taken over `tabs` rather than over the scroller's
children, and a node whose id is not in that list refuses to arm).

**`dropSlot` rather than `dropIndex`.** That one divides travel by **one** measured
row — exact on a 72px column, drifting on a strip where `mac` sits beside
`server-fra-01`. A function right on one axis and quietly wrong on the other is
worse than two, so `dropIndex` keeps its single caller. The rule is the pointer
passing a neighbour's midpoint, which is what `dropIndex` approximates by rounding.

⚠ **Q3.574's two coordinate systems coincide here.** There `origin.index` counts a
zone's rows *including* the dragged one while `target.index` is a slot *among the
others*, because a drop can cross groups. This is a single list, so the two are
one number — said out loud so nobody hunts for the off-by-one.

**Keyboard parity is owed, not offered** (`agent-strip.md`): `Alt`+arrows and
`Alt+Home`/`End` on the same `<button>`, which leaves `keyboard.ts`'s bare-key
rules untouched. It is **announced**, from one sentence the hook owns, into an
`sr-only` live region both axes draw — a key press moves an entry that may be
scrolled out of view, and neither surface had a live region before.

**There is no write to fail.** `setMachineOrder` is `localStorage` and a version
bump, so this file has no `UNREACHABLE` sentence, no sequence guard and no
restore-what-the-daemon-confirmed. That is a real difference from both lists it is
modelled on, and it is stated so nobody looks for the missing half.

## Swiping between machines, on the list and not on the strip

`useMachineSwipe` lives on the **list's pager window**, around its scroller (Q3.667).
The strip's own horizontal gesture is its scroll, and taking that would be a third
gesture on one 44px band.

⚠ **The tab drag needs no coordination with the swipe, and that is structural
rather than lucky.** `machineDrag`'s listeners are on the *strip's* scroller and
the swipe's are on the *list's* window; the two are siblings, so a touch that begins on a
tab never reaches the swipe and one that begins on the list never reaches the drag.
Holding a tab to reorder it and flicking the list to change tab are two gestures on
one axis on one screen, and what keeps them apart is **which box the finger landed
in** — not a predicate either has to remember to ask.

What the swipe *does* share is `rowDrag`, on the scroller inside that window. Two
things separate them:

- **`SWIPE_SLOP` is `PRESS_SLOP`, imported.** `rowDrag` abandons an unarmed hold
  past 8 px *in any direction*, and that number is below the ~10 px at which
  engines commit a pan. So at the one distance where the swipe decides it is
  horizontal, the hold is already dead **and** the scroller has not taken the
  touch. Two copies drifting is a hold and a swipe both live on one finger.
- **`armed()` refuses outright** — a ref, not React state, because the frame in
  which a hold arms is the frame in which React has not been told.

**Horizontal intent is decided once and never reconsidered**: `|dx| > |dy| * 1.5`
past the slop — `DOMINANCE`, in `sheetMotion.ts` since the sheets' drag shares it.
A diagonal is a scroll. `event.cancelable === false` means the engine already
claimed the pan, and arguing with it is how a swipe becomes a
stutter — so that is a vertical too. `preventDefault` only after the axis resolves
to `"x"`, never on `touchstart`, which would kill the tap that opens a session.

⚠ **A second guard that does not share that cause**: `[touch-action:pan-y_pinch-zoom]`
on the scroller. **One arbitrary value, not two utilities** — two setting one
property are resolved by Tailwind's emission order rather than by the class string.
`pinch-zoom` is kept deliberately: `pan-y` alone takes zoom off the whole rail for
one gesture's convenience.

⚠ **The platform's own Back keeps a 24 px band at each viewport edge.**
`html { overscroll-behavior: none }` stops the rubber-band and says nothing about
the edge swipe, which is the browser's and must stay the browser's.

**`[All, …machines]`, clamped, never wrapping.** A wrap would scroll the strip a
screen's width under a page's gesture. **Toward a side with no neighbour the list
does not move at all** (`pageOffset`) — Telegram's pager does not rubber-band its
ends, and a give that turns nothing is a promise the release breaks. The commit is
`selectMachine` and nothing else — **no route, no history entry, no view
transition**: `announce`/`data-nav` is for a screen *replacing* another one, and
`navMove` has no value for a tab change.

**The layout gate is a per-gesture read of the DOM's own answer**, and it is not a
breakpoint in JavaScript. `SessionBrowser` is mounted twice and `AppShell` forbids
a second source of truth for the width, so the swipe runs only where the
`lg:hidden` strip **is laid out** — `offsetParent !== null`, asked at `touchstart`
and never cached. Three things make that honest: it is **not state** (nothing
stored, subscribed or re-rendered, so it cannot disagree with CSS or go stale); it
is **exclusive both ways** (each mount's ancestor is `display: none` at the other
width, so exactly one can ever swipe and neither knows which it is); and it is
**semantic rather than dimensional** — this gesture moves the *tab strip's*
selection, so it runs where the tab strip is the control on screen.

⚠ **`prefers-reduced-motion` is read here rather than left to `index.css`.** That
file's blanket block zeroes `transition-duration` on `*`, which makes the settle
free — and cannot reach a transform written per frame from JavaScript. It is the
same hole that file records having had three times. Under reduced motion no
transform is written and **the swipe still commits**.

### A page turn, as Telegram's folders turn (Q3.655)

It was a 96px nudge and a swap, and the owner reported the swap: the list sprang back
and the next machine's appeared where it had been. **Now the neighbouring machine's
list slides in beside this one, both move with the finger, and a release carries the
pair on to the neighbour or home** — `pageTurn`, which is `sheetRelease` on its side
(a fling, or `DISMISS_PX`), on the sheets' clock and curve, since a page is no further
than a sheet.

- **The page that moves is the scroller itself**, inside a window that clips it; a
  translated child would overflow the scroller sideways and make it scroll. What
  moves is written once a frame, snapped to device pixels, `will-change` only for the
  gesture, and `transition` held at `none` rather than cleared — `docked-panels.md`
  has why each.
- ⚠ **The turn commits in one task, once the strip rests**: `flushSync` selects the
  machine and unmounts the neighbours, the scroller goes to the top and back to 0,
  and only then does anything paint. Settling to 0 first, or letting React commit in a later task, is
  exactly the reported jump.
- ⚠ **The neighbours are a store, not state**: `BesidePanes` alone reads it. As state in
  `SessionBrowser`, mounting it re-rendered the whole current list, and the engage
  grew with it — 28.8ms at 40 rows, 50.6ms at 300, development React. It mounts once
  per direction, synchronously, before the frame that first shows it.
- **It is cut to a screen** — `takeRows`, a budget measured once per gesture at
  `ROW_FLOOR_PX` — and it is a picture: `inert`, `aria-hidden`, no pointer events.
  Whole, a 300-row neighbour laid out in 6.3ms per engage against 1.0ms for the 19
  rows one screen shows (production build).
- **The strip's pill travels with the page** (`TabPill`, below) on the pager's own
  progress and settle, toward All too, and hands over after the commit.
### A flick that follows a flick (Q3.667)

The pages are one strip, and a turn commits only when the strip rests. Measured
before: a second flick inside a settle was lost every time — the finger landed where
the page had moved from, on a neighbour that takes no touch, or the touch landed the
turn, committing it under the finger, and the rest of the touch went to a node React
had just removed.

- ⚠ **The finger is heard on the window, which never moves** (`windowRef`); the
  scroller is only drawn.
- **A touch catches a settling turn where it is drawn** (`hold`): the list's own
  page's computed transform is read back into the strip (`offsetFrom`), and every
  page and the pill (`TabPill.hold`) stop there — no commit, no jump. Sideways it
  is a page drag from the page the turn was heading for (`listGesture`'s `turning`:
  never the drawer, never a pull); a tap or a vertical move lets the turn carry on.
- **Neighbours are the strip's pages**, one pane each, keyed by place
  (`data-beside`). While a turn settles, its page and both neighbours are mounted
  (`pagesFor`) after the frame that starts the settle, so the page beyond is there
  for the next flick and nothing mounts under a finger.
- **The pill's legs follow the strip** (`nextPage`, `legProgress`): from where it is
  drawn to the next page the strip is heading for.

### Three gestures on one list, decided once (Q3.657, Q3.658)

`listGesture` is the one arbiter, pure and asserted: the first move past the slop is
a **page** (sideways), the **drawer** (rightward on the first page, where there is
no page to reveal — Telegram's first folder), a **pull** (downward, from the top,
never over a gap already open — `claimDrag` with `DOMINANCE`), or nobody's. An engine
already panning is never argued with, and the 24px edge bands stay the platform's
Back: a rightward pull from the left edge is exactly the system gesture.

- **The drawer is mounted for the gesture and is not yet a layer.** `drawerPull`
  flips a store `MenuDrawer` reads, the drawer mounts closed under the finger (the
  one commit), and each frame writes its transform and the scrim's opacity. Nothing
  goes inert under a finger that may still give it back. Released open —
  `sheetRelease`, sideways — it opens through `onMenu`, the button's own path, so the
  layer, inert, Escape and Back are the button's; given back, it unmounts closed.
- **A pull moves the list itself down**, `pullOffset` giving less and less, and past
  `PULL_HOLD_PX` on release the gap holds, with `WorkingMark` in it, for exactly as
  long as `store.resume("pull")` takes — the wake path: the registry, every machine
  re-dialled and re-listed, streams reattached, an unreachable machine's probes
  bounded. Then it closes whatever answered; nothing new is drawn for a failure.
  While the gap is open no other gesture starts. `html`'s `overscroll-behavior: none`
  keeps the engine's own refresh and glow out, and a claimed move is refused to it.
- **Reduced motion**: nothing follows; the drawer opens, and the gap opens and
  closes, with no transition at all.

### And one on the conversation: back to the list (Q3.663)

Below `lg` a conversation dragged rightward follows the finger off to the right, and
the list is revealed under it the way the chevron's own pop draws it
(`BACK_UNDER_SHIFT`, `BACK_UNDER_OPACITY`, read off `nav-under`). `backClaim` decides
once: rightward by `DOMINANCE`, never against an engine already panning, and never
while a horizontal scroller under the finger can still scroll back — a code block
keeps the drag until it is at its start. Never from a field, over a selection, past a
long press, from the edge bands, while anything but the ask card is a layer, or on
the press that closed a menu (read at `pointerdown`, before the menu's own listener).
The gate is the back chevron being laid out.

- ⚠ **The list under it is the list's own element.** `PhoneList` is keyed the same
  on both routes, so landing — `navigateDrawn`, the chevron's history entry with no
  view transition to replay the move — keeps the element and its scroller, and the
  route change and the list letting go of its styles are one task. Drawn for the
  gesture it is inert, unread and cut to one screen of rows; the rest mount on
  landing, below the fold.
- ⚠ **`main` is clipped while the list is drawn under it.** The conversation
  translated past its edge grew `main`'s scroll width, and `main`, the document and
  the transcript repainted every frame.
- A settle overtaken by another route gives back rather than leaving it. Reduced
  motion: nothing follows, and a release that goes back goes by the chevron's path.

## Which machine is selected, and why it is not a band

**The selected machine is a filled 28px mark; the tile behind it paints nothing.**
It was `bg-raised` across the whole tile, on the argument that a folder rail marks
the selected folder as a band and that `raised` is what this palette spends on
state. Both halves are true in isolation. What they missed is the column *beside*
it: the session list marks its own selected row with the same token, full-bleed and
square, abutting across one pixel of `border-edge`.

⚠ **They can never line up, and that is arithmetic rather than a bug to fix.** Both
heads agree at 56px and the rhythms then diverge — a machine tile is `py-2` + a 28px
mark + `gap-1` + an 18px label = 66px, a session row is 64px with a subline and 42px
without, and the list's first child is a folder header. Two identical grey
rectangles at unrelated offsets, which is what was reported as the column looking
crooked. Pinning the offsets would leave the next change to either rhythm to reopen
it; removing the band removes the edge there is nothing to line up.

⚠ **`bg-fg` on a mark narrows Q3.209 rather than repealing it.** This app already
keeps a shorter list than that sentence: the bell is a
dot with `ring-2 ring-ink`, and the blocked count is `bg-fg text-ink` at 16px in
three places. The measurement is **area** — the chip is 784px², smaller than the
32px circle `Composer` already draws and a quarter of the pill that rule was written
about. Barred as a pill-sized fill, licensed as a mark. Q3.624.

⚠ **The fill carries `transition-colors` and it is not decoration.** `.tap` is on
the `<button>`, `transition` is not inherited, and the chip is a child `<span>` — so
the band cross-faded only because it was painted on the `.tap` element. Without it
the selection *snaps*. It must never be `transition-transform`: `webcheck` bans that
string in this file outright, for the `slides` reason above.

**And the badge gained `ring-2 ring-ink`.** The count and the selected mark are both
`bg-fg` and overlap by two pixels at the mark's corner, so on the one machine that
most needs reading — selected, with work blocked on it — they grew as one shape.

## The tabs' own numbers

**Three class strings share one inset** — `All`, a machine tab, and the `+` — and
they move together or the strip reads as two controls that wandered in beside a
row of tabs. `min-w-22` is 88 px, two 44 px tap floors, on the **non-`lone`** arm
only, so the one-machine case keeps `flex-1` and its paragraph stays true.

⚠ **A label's inset is two numbers now, the tab's `px-1` and its pill's `px-3`**,
and together they are the `+`'s `px-4`; `webcheck` reads all three and requires the
sum. The pill is the label's own box rather than the tab's, so a short name gets a
pill that hugs it, as Telegram's does, while the tab keeps its 88px target.

**The edge fade is a fraction of something again.** Its comment said `w-8` *"is no
longer a fraction of anything and would have to be re-measured rather than
re-derived"*; at this inset it is exactly twice it, asserted as the relation.

⚠ **The 72 px desktop column deliberately did not follow.** Moving
`MACHINE_COLUMN_PX` moves all three rail bounds with it to keep `webcheck`'s
subtraction true, and `clampRailWidth` preserves a stored *total* — so every
existing reader would silently lose the delta off their list. The column's own
bound is a different one: 68 px of the 72 is the name, and two hosts eliding to
`server-…` is the failure it is shaped against. Two axes, two constraints, and no
shared number.

## The pill that marks the selected machine (Q3.656)

The owner, of Telegram's folders: *"the element that marks the selected folder
moves together with the page … so the selection never teleports."* It was a 2px
underline, switched at the turn, and never toward All.

**At rest the pill is the selected tab's own**: `TabLabel`'s span, `bg-raised`
behind the label — `raised` being what Q3.209 spends on *a tab you are on*, with
the count still `bg-fg` on top of it. So a scroll, a reorder (it rides the lifted
tab), a resize, a font load, a machine arriving or leaving and a first render all
move it with no code, and none can animate it from nowhere.

**Every change of tab is a trip.** `useTabPill` measures both tabs, the strip and
the scroller once, sets `data-pill-travel` (an unlayered rule stands every tab's
own pill down) and draws a traveller from one to the other, handing back to the
new tab's own pill at the identical rect. The swipe drives it by the page's
progress and settle; a tap, a key or a fallback drives it from `MachineTabs`'
layout effect, before the new pill can paint, and never while a turn already
carries it.

- ⚠ **It lives in the strip's coordinates, because All does not scroll** (Q3.610's
  reason stands) and the machine tabs do. Each end is placed at the strip's scroll
  of the moment and clipped to the scroller's visible box (`clipSpan`), so it can
  cross into All and never draws outside the strip.
- **Three pieces, transforms only**: two caps that move and a middle that moves and
  stretches (`pillPieces`), so the ends stay round at any width with no layout per
  frame. Snapped, promoted only for the trip, `transition` held at `none`.
- **The strip follows**: `scrollToShow` picks the scroll that shows the whole
  target tab. The drag writes it by progress, and the settle runs it in frames on
  `easeAt` — the sheets' curve, since CSS cannot transition a scroll offset — and
  lands it before the hand-off. The selection's own `scrollIntoView` then finds
  nothing to do, and it stands down while a trip runs.
- ⚠ **Selection no longer changes a label's weight**, or the tab measured before a
  tap would be narrower than the one the pill lands on.
- **Reduced motion**: no trip; the tab's own pill simply changes.
- **The desktop column is unchanged**: the owner's words are about paging on the
  phone, and the column's 28px mark is Q3.624's answer to a different problem.
