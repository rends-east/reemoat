---
paths:
  - packages/web/src/machineOrder.ts
  - packages/web/src/ui/machineDrag.ts
  - packages/web/src/ui/machineSwipe.ts
  - packages/web/src/ui/MachineColumn.tsx
  - packages/web/src/ui/SessionBrowser.tsx
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

`useMachineSwipe` lives on the **list scroller**. The strip's own horizontal
gesture is its scroll, and taking that would be a third gesture on one 44px band.

⚠ **The tab drag needs no coordination with the swipe, and that is structural
rather than lucky.** `machineDrag`'s listeners are on the *strip's* scroller and
the swipe's are on the *list's*; the two are siblings, so a touch that begins on a
tab never reaches the swipe and one that begins on the list never reaches the drag.
Holding a tab to reorder it and flicking the list to change tab are two gestures on
one axis on one screen, and what keeps them apart is **which box the finger landed
in** — not a predicate either has to remember to ask.

What the swipe *does* share is `rowDrag`, on that same scroller. Two things
separate them:

- **`SWIPE_SLOP` is `PRESS_SLOP`, imported.** `rowDrag` abandons an unarmed hold
  past 8 px *in any direction*, and that number is below the ~10 px at which
  engines commit a pan. So at the one distance where the swipe decides it is
  horizontal, the hold is already dead **and** the scroller has not taken the
  touch. Two copies drifting is a hold and a swipe both live on one finger.
- **`armed()` refuses outright** — a ref, not React state, because the frame in
  which a hold arms is the frame in which React has not been told.

**Horizontal intent is decided once and never reconsidered**: `|dx| > |dy| * 1.5`
past the slop. A diagonal is a scroll. `event.cancelable === false` means the
engine already claimed the pan, and arguing with it is how a swipe becomes a
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
screen's width under an eighty-pixel gesture, and replace the end rubber-band with
a lie about there being more. The commit is `selectMachine` and nothing else — **no
route, no history entry, no view transition**: `announce`/`data-nav` is for a
screen *replacing* another one, and `navMove` has no value for a tab change.

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

The follow is a transform on **one bare wrapper** inside the scroller, carrying no
layout of its own: everything inside measures in the *scroller's* content
coordinates, and a wrapper that established a containing block or changed height
would move every drop midpoint. The "release to unpin" pill stays a child of the
scroller and outside it, or it travels with the swipe.

This is deliberately **not** Telegram's two-page turn, which needs both machines'
lists mounted at once on a rail whose whole design is one machine at a time. What
ships is a nudge and a swap.

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
keeps a shorter list than that sentence: `TabUnderline` is 2px of it, the bell is a
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

⚠ **The underline's `inset-x-*` and the tab's `px-*` were two numbers agreeing by
hand with nothing checking.** `webcheck` reads both out of the file and requires
them equal. Wrapping the label in a `relative` span to make the mark the word's
width by construction was rejected: `-bottom-px` would then resolve against the
line box, floating the mark under the text instead of on the hairline.

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
