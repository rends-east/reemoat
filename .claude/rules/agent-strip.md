---
paths:
  # `offersStripTile` and `startableHere` are the membership rule this file is
  # about, and they live here rather than in either screen. Without this glob the
  # file that decides what the strip draws summoned `agent-catalogue.md`, which is
  # about model names.
  - packages/web/src/agents.ts
  - packages/web/src/agentStrip.ts
  - packages/web/src/agentPick.ts
  - packages/web/src/ui/NewSession.tsx
  - packages/web/src/ui/settings/MachineAgentsSection.tsx
  - src/store/schema.sql
---

## What the strip is

**The row of tiles on New session is a listing merged with a preference.** The listing
is `GET /agents` filtered by `shownHere`, plus `GET /custom-agents`. The preference is
`agent_strip`, a **partial** record: a `(kind, ref, rank, hidden)` row for what somebody
moved or hid, nothing for anything else. `orderStrip` in
`packages/web/src/agentStrip.ts` is the only place they meet, a pure function
`webcheck` drives.

1. **Stored entries first, in rank order**, keeping only what the listing holds. A `ref`
   that resolves to nothing is dropped *at draw time* and keeps its database row.
2. **Then everything the store has never heard of**, in natural order, at the end —
   never a position invented inside the stored order.
3. **Unknown means visible.**

**`natural` decides membership; `stored` decides only order and hiding** — never a
tile for something the machine cannot start, which `offeredHere` exists to prevent.

## The default row

**A new session opens on the first row, and the Agents screen badges that row
`default`, by the same call**: `defaultRow` in `agentStrip.ts`, over the same
`orderStrip` merge and the same predicate. "First" skips **hidden** rows (which keep
their place) and **unstartable** ones (a signed-out harness, a preset whose harness was
uninstalled), never a flag test like `.find((row) => !row.hidden)`.

**The membership rule lives outside both screens.** `startableHere` in `agents.ts` is
`offeredHere` minus the hidden test: New session asks the one with it, the Agents
screen (which draws hidden rows on purpose) the other — one body. `shownHere` is an
alias of `agents.ts`'s `offersStripTile`, never a private ladder in a second `.tsx`.

**Decided one level up and handed down, never `index === 0`** — a `webcheck` ratchet.
Nothing startable: `defaultRow` answers `null`, marking nothing.

**The badge may not cost height**: a drag measures **one** row at `pointerdown` and
applies it to every neighbour. `Badge` is `text-2xs leading-tight` with `py-0.5`, under
the name's line box; `tone="strong"`, since exactly one row can be it.

## What is never validated

**`ref` is weighed against nothing, on either side of the wire** — not the `PUT` route,
not `SqliteAgentStripStore.list`, and there is no `readCustomAgent` equivalent. The
opposite of `custom_agents.harness`, which drops a row outside the union; here the row
*is* the memory, so a harness signed out for a week or a preset a rollback cannot
resolve keeps its position and the merge drops it at draw time.

**Bounded instead**: `MAX_STRIP_REF_CHARS` (96) and `MAX_STRIP_ENTRIES` (200) on the
route. 96 because a plugin harness is `<pluginId>:<localId>` with each half bounded at
32, so the longest legal id is 65 (64 was one short and would leave the screen unable to
save); it is not derived from the manifest's bound. The one thing checked is `kind`,
this system's own vocabulary.

**`stripKey` is `${kind}:${id}` and cannot collide**: `kind` is a fixed two-member set
and the key is only joined and compared, never split.

## The route is a replace, the store a transaction

- **`PUT /agent-strip` carries the whole list.** `SqliteAgentStripStore.replace`
  empties then refills **inside a transaction for atomicity** (unlike `prune()`'s,
  which buys one WAL commit) and re-raises, so a refused write reaches the screen.
- **The whole body is validated before the store is touched.** `daemoncheck` asserts
  the stored list is byte-identical after every refusal.
- **Duplicates are refused by the route**, not left to the primary key's
  `500 internal_error`. `orderStrip` also drops a repeat, since the `PUT` echo returns the
  list too.
- **No `SCHEMA_VERSION` bump**: a whole new table, so `schema.sql`'s
  `CREATE TABLE IF NOT EXISTS` is the migration and `migrate()` needs nothing; a bump would make
  `refuseNewerSchema` refuse a rollback for nothing.

## A harness that would not start has no tile either

**`offersTile` keeps `not_installed`, `signed_out` and `start_refused` off the row**
(`agent-catalogue.md` has the first two). `start_refused` is a measurement — the daemon
opened a session and the agent declined — because `loggedIn` is permanently `null` for a
harness with no status probe. Q2.221; the badge and the ladder are `agent-login.md`'s.

**`offersStripTile` weighs the refusal unconditionally; `startableHere`'s preset arm
does not.** A tile is a bare start, so any refusal takes it. A preset routed onto
another system runs on that system's key (`applySystem` lands before `session/new`), so
only a refusal measured **while routed** counts against it: refused bare, a preset still
starts (a signed-out Claude Code on OpenRouter). The credential axis does not reach the
preset arm. `webcheck` asserts the pair together.

**What the hidden tile owes back is a way to the card, never a card.** New session
draws no install and no sign-in (Q3.640): with nothing to start it says one
`STRIP_EMPTY` sentence and offers **Agent settings**, the gear's `onConfigure`. There
the row stays with `would not start` in the vendor line, **Set up <harness>** in its
menu opening the card with its paste box, and **Check again** — whose subject is
off-screen, since the usual remedy is running the program once on the machine. Q3.538.

## Hidden is not a refusal

Every other "not on the row" rule hides a fact about the machine, and the answer to
that is *don't*: an unavailable harness is drawn and labelled. Hiding is somebody's own
act on their own list, undone one tap away.

- **A harness is hidden; an assembled agent is removed.** "Remove" on a harness would
  claim to reach a disk it cannot.
- **An empty row says which kind of empty.** `stripEmpty` asks *hidden* first, of a
  hidden row that could **start**, because it is the only cause true of a healthy
  machine. `none_listed` offers Check again, `too_old` nothing, a failed or unsettled
  read `null` (Try again speaks); three of five end in Agent settings. Decided once in
  `NewSession`, so the footer's "no agent to start" agrees.
- **`offeredHere` takes the hidden set**, or `Start` is live with nothing drawn as
  chosen.

**The settings list is wider than the row**: every harness that can *ever* have a tile
is listed, with its badge saying why it has none. `startsBare` is the single exclusion,
and it is not a status.

## The two screens

- **The strip's trailing control is a gear in the `+`'s slot**, an ordinary item you
  scroll to; `webcheck` pins the placement, never the glyph. The `+` is at the foot of
  the screen the gear opens.
- **Leaving `/new` for `/settings/machines/:id/agents` keeps both halves**: the folder
  is in the address, the chosen tile in `agentPick.ts` as a **standing** map,
  `keepPick`/`heldPick`, **read** rather than taken (unlike the two hand-offs beside
  it). The empty state's **Agent settings** is the same handler.
- **`…/agents/:harness` is that harness's card** (New session's old inline card as a
  leaf, Q3.640), parsed into `signin` with `agents` true, bounded by
  `MAX_HARNESS_ID_CHARS` (96) for the 65-character reason.
- **The list's ◀ reads `origin`, at this one screen, for a New session origin only**;
  `originFor` keeps an origin across moves within a pop-up, so reading it at every depth
  would send settings sections to `/new`. `settingsUpLabel` has one name to give. The
  leaf never reads it; two ◀ end on New session, driven as a sequence in `webcheck`.
- **Two controls per row, a handle and a menu; what varies is inside the menu**, so no
  control moves on a list you drag. The kebab is live on every row, on an old daemon
  too: `frozen` disables the drag handle and Add back / Remove, nothing else. **Set up**
  is keyed on a fact the row reports — a `strong` badge, or a preset's harness missing or
  refused while routed — and is the list's only way to the card. The status line sits
  **under** the list, 0-height until needed (Q3.543's sibling decision, 13A).
- **One removal per row, called the same on both kinds.**
- **The row's kind may decide a lookup or a destination, never a presentation.**
  `webcheck` sweeps for a `harness` branch inside a `danger=` or a `className=`.
- **What a removal does differs, unavoidably.** A built-in is the hidden flag: the row
  stays, dimmed, offering **Add back**. An assembled agent is
  `DELETE /custom-agents/:id`, so it confirms in place — "Remove `<name>`? Rebuild it
  from Add an agent." · Remove · Cancel last. **Neither wears `danger`**, which is for
  acts nothing brings back. The confirm is the row's state, never the menu's, and its
  label is not derived from the kind.
- **Both verbs on both kinds.** Editing a harness starts from it:
  `/agent/:machineId/from/:harness` opens the builder pointed at it and saving
  assembles an agent. `edit` and `from` are read at one position, so a route carrying
  both is unexpressible; an unresolvable harness opens the new-agent screen
  (`compatibility.md`'s rule 2).
- **Labels are one word**: `Edit`, `Remove`, `Add back`.
- **A removed harness is dimmed in place**: `bg-raised/60` under `text-faint`, never
  `opacity` (it composites the explaining line).
- **The line under a built-in row is the vendor, never `signed in`**: `harnessSubline`
  reads it off `GET /systems` by `nativeHarness`. A `strong` `agentBadge` displaces it;
  the `plain` ones do not. The strip's tiles carry the same line.

## Reordering, with no library

No drag-and-drop dependency is added. The handle is a `<button>` that takes
`setPointerCapture` (`AppShell`'s `RailHandle` rule) and also answers
`ArrowUp`/`ArrowDown`/`Home`/`End`.

- **Per-frame work goes to the DOM, per-row work to React**: the dragged row's offset is
  written onto its node; the target index is state.
- **`touch-none` works only because `button { touch-action: manipulation }` in
  `index.css` is layered.** An unlayered rule beats every `@layer utilities` class, so a
  bare-element declaration a utility may need to override belongs in `@layer base`.
- **A second guard**: a non-passive `touchmove` listener on the handle, `preventDefault`
  only while a drag is live, via `addEventListener` (React's `onTouchMove` is passive),
  registered for the component's life, since some engines decide at `touchstart`.
- **The handle is 44px square**, the glyph `pointer-events-none`, and no `.press`.
- **The row under the finger is never transitioned**, only its neighbours, only while a
  drag is live; `will-change-transform` is held for the gesture only.
- **`moveRow` splices and never swaps; `dropIndex` rounds.**
- **`moveRow` is generic and shared with the machine folders; `dropIndex` keeps its
  single caller**, since it divides by one measured row and drifts where widths vary —
  `machineOrder.ts`'s `dropSlot` counts midpoints instead. `driftFor` is shared too.
  `moveRow`'s emptiness test may not read a value (the element may be `undefined`). `machine-gestures.md`.
- **A refused write restores what the daemon last confirmed**, under a sequence guard.

## The fade at the cut edge

**A row that is cut has to look cut**, and the scrollbar cannot say it, so the strip
does not use `.no-scrollbar`.

- **Two stops, 70% to nothing**, `pointer-events-none`, a **sibling of the scroller,
  never a `mask-image`** (a mask hits the scrollbar too).
- **Toggled inside the existing `layout()`**, never a second handler.
- **One pixel of slack** for rounding — the opposite of `scrolledDown`.
- **`.edge-fade` lives in `index.css`, after `.fade-thumb.is-scrolling`**: the
  `opacity` may not appear inside `AgentStrip`, and a rule inserted before that selector
  re-anchors `webcheck`'s slices of the stylesheet.
