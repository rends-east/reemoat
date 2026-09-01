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

**The row of tiles on New session is a *listing merged with a preference*, and
neither half is the answer on its own.**

The daemon reports what it can start — `GET /agents`, filtered by `shownHere`, plus
`GET /custom-agents`. Separately it stores `agent_strip`, a **partial** record: a
`(kind, ref, rank, hidden)` row for what somebody has actually moved or hidden, and
nothing for anything else. `orderStrip` in `packages/web/src/agentStrip.ts` is the
only place the two meet, and it is a pure function `webcheck` drives directly.

Three clauses, and each closes a state that is only reachable when the fleet changes
under a stored order:

1. **Stored entries first, in rank order** — keeping only what the listing still
   holds. A `ref` that resolves to nothing is dropped *at draw time* and keeps its
   row in the database, so it comes back where it was if the thing does.
2. **Then everything the store has never heard of**, in natural order, at the end.
   The stored list is a total order over what existed when it was written;
   inventing a position inside it for something that arrived later would be this
   function having an opinion nobody expressed.
3. **Unknown means visible.** An agent arriving already switched off is
   indistinguishable from the daemon having lost it.

**`natural` decides membership; `stored` decides only order and hiding.** Reading
those as symmetric is the mistake: a strip built from the stored list plus leftovers
would draw a tile for something the machine cannot start, which is exactly the state
`offeredHere` exists to make unreachable.

## Position 1 is the default, and "first" is not the top row

**A new session opens on the first row of this order, and the Agents screen draws a
`default` badge on that row — by the same call.** `defaultRow` in `agentStrip.ts`,
over the same `orderStrip` merge, handed the same predicate. A badge naming a
different row from the one that actually gets selected is worse than no badge: it is
a confident claim about another screen that the reader cannot check from where they
are standing.

⭐ **"First" is two narrowings past index 0, and both are states this screen exists
to show.** A **hidden** row keeps its place, so the list's first entry is routinely
one that is not drawn at all. An **unstartable** row is the same failure through the
other door: this list is deliberately wider than the strip, so a signed-out harness
is routinely first — and so is an assembled agent whose harness was uninstalled,
which draws a *disabled* tile and was, until this entry, the thing `defaulted` selected.
`offeredHere` refused it one line down and the screen drew nothing as chosen with
`Start` dead. The old spelling was `.find((row) => !row.hidden)`, and it did not
generalise because it named a *flag* rather than *the row this screen will land on*.

**So the membership rule lives outside both screens.** `startableHere` in `agents.ts`
is `offeredHere` minus the hidden test, and the split falls exactly there because
hiding is the half that is not about startability at all — the daemon would run a
hidden agent perfectly, it simply has no tile. New session asks the one with the
hidden test; the Agents screen, which draws hidden rows on purpose, asks the other.
One body, so they cannot disagree about anything else. `shownHere` went out with it
as `offersStripTile`, for the reason `webcheck` already had an assertion about: a
private four-state ladder in a second `.tsx` is how kimi came to be told two
different things two taps apart.

**The badge may not cost height, and on this list that is correctness.** A drag
measures **one** row at `pointerdown` and applies that number to every neighbour's
shift, so a taller row makes every step of a drag past it wrong. `Badge` is
`text-2xs leading-tight` with `py-0.5` — 19px against the name's 22px line box — so
the flex line is the name's either way. `tone="strong"` is that component's word for
"this one is not like the others", which exactly one row can be.

**Decided one level up and handed down, never `index === 0`.** That is the answer a
row can reach on its own and it is wrong in both states above, so it is a `webcheck`
ratchet rather than a comment. A machine with nothing startable is marked nowhere:
`defaultRow` answers `null` rather than pointing at row 0 anyway.

## What is never validated, and why that is the design

**`ref` is not weighed against anything, on either side of the wire.** Not by the
`PUT` route, not by `SqliteAgentStripStore.list`, not by `readCustomAgent`'s
equivalent — there is none.

This is the **opposite** call from `custom_agents.harness` one table up, and both
are right. There, a row naming something outside the union is dropped, because
restoring it produces a well-typed lie that fails later in `resolveAgent` with a
worktree already made. Here the row *is* the memory: a harness signed out for a
week and a preset a rollback cannot resolve both keep their positions, and the merge
drops them at the moment it draws. Validating would forget an order every time an
agent was briefly unavailable — the daemon rearranging somebody's screen by itself,
which is the one behaviour they would certainly notice.

It is **bounded instead**: `MAX_STRIP_REF_CHARS` (96) and `MAX_STRIP_ENTRIES` (200)
on the route, so an unknown id cannot be an essay and a body cannot be a migration.
The one thing that *is* checked is `kind`, because that is this system's own
vocabulary and reaches a branch in the client.

⚠ **That bound was 64 and 64 is one short.** A harness a plugin adds is
`<pluginId>:<localId>` with each half bounded at 32, so the longest legal id is 65 —
and this route is the *one* write the whole strip screen makes, so refusing it would
have left that screen permanently unable to save an order, with an error line and no
way out of it. The number is not derived from the manifest's bound, which is somebody
else's subject; it is comfortably past every id shape that exists.

⚠ **And `stripKey` is still `${kind}:${id}` and still cannot collide**, though its
docblock's reason changed: "a harness id is one word" stopped being true. What makes
it safe is structural rather than arithmetic — `kind` is a fixed two-member set and
the key is only ever joined and compared, never split, so the ambiguity a reader would
look for is one no caller can ask.

## The route is a replace, and the store is a transaction

**`PUT /agent-strip` carries the whole list.** A reorder is a statement about every
position at once, so a per-row verb would need a rule for the rows the body did not
mention and no caller has one. `SqliteAgentStripStore.replace` therefore empties
before it refills, **inside a transaction for atomicity** — unlike `prune()`'s
transaction, which takes one only to spend a single WAL commit — and re-raises
rather than swallowing, so a refused write reaches the screen as an error rather
than as a silently emptied table.

**The whole body is validated before the store is touched.** A validator inside the
write loop would answer `400` on the eighth row of a fourteen-row body with the
first seven stored and the rest gone. `daemoncheck` asserts the second half of every
refusal: that the stored list is byte-identical afterwards.

**Duplicates are refused by the route rather than left to the primary key**, or the
constraint reaches a caller as a `500 internal_error` over a body the route could
see. `orderStrip` also drops a repeat, because the list comes back from the `PUT`
echo as well and one agent drawn twice is two tiles that select each other.

**No `SCHEMA_VERSION` bump.** It is a whole new table, so `schema.sql`'s
`CREATE TABLE IF NOT EXISTS` is the entire migration and `migrate()` needs nothing.
A table an older daemon never selects is invisible to it, and bumping would make
`refuseNewerSchema` refuse a rollback to buy that nothing.

## A harness that would not start has no tile either

**`offersTile` keeps three states of six out of the row now, and the third is the
only one that is a *measurement*.** `start_refused` means the daemon opened a
session and the agent declined — not that anything here read a credential, which
for these harnesses it cannot: `loggedIn` is permanently `null` for anything with
no status probe, so the two existing arms could never take the tile away and a
harness a plugin added kept one after refusing. Q2.221; the badge, the ladder's
sixth member and the three sentences a *reorder* would have falsified are
`agent-login.md`'s.

⚠ **`offersStripTile` weighs the refusal unconditionally and `startableHere`'s
preset arm does not, and the asymmetry is the whole of what keeps one refusal from
condemning a pairing it never tested.** A tile *is* a bare start, so any refusal
takes it. A preset routed onto somebody else's system runs on that system's saved
key, and `applySystem` lands before `session/new` — so only a refusal measured
**while routed** is evidence about it. Refused bare, a preset still starts, which is
the signed-out Claude Code on OpenRouter the paragraph below already protects. That
is the *refusal* axis reaching the preset arm; the **credential** axis still does
not, and `webcheck` asserts the pair together so neither can be collapsed into the
other by somebody tidying.

⚠ **The door this one owes is not the sign-in block.** `signInOffered` answers
`false` for every harness with no wizard — which is exactly the population this
state hides — so New session's *"No agent on this machine is ready to start."* was
a sentence with nothing under it on a machine whose only harness came from a
plugin. It names the gear in that case. What is behind the gear is the row, kept in
place with `would not start` where the vendor line goes, a paste box, and **Check
again**: the only control in this app whose subject is off-screen entirely, because
the commonest remedy for such a harness is to run its own program once on the
machine and nothing about that reaches the daemon. Q3.538.

## Hidden is not a refusal

Every other "this agent is not on the row" rule in this app is the app concealing a
**fact about the machine**, and the standing answer is *don't* — an unavailable
harness is drawn and labelled, because filtering answers "where did claude go" with
silence. Hiding is somebody's own act on their own list, undone one tap away.

Three consequences, and the third is the one that is easy to miss:

- **A harness is hidden; an assembled agent is removed.** There is nothing to delete
  about a harness — it is whatever the host has installed — so "remove" on one would
  be a control claiming to reach a disk it cannot.
- **An empty row says which kind of empty.** "Every agent on this machine is hidden"
  is asked **first**, because it is the only one of the three causes that is true of
  a machine with nothing wrong with it, and it names the gear rather than a screen.
- **`offeredHere` takes the hidden set.** Hiding is not an availability failure, so
  nothing downstream refuses it; a pick that survived that call would be `Start` live
  over a row with nothing drawn as chosen — the fourth member of the family that
  function already exists for.

**The settings list is deliberately wider than the row it configures.** The strip
filters by `shownHere`, so a signed-out harness has no tile; a settings screen
filtering the same way would answer "show Codex" with a row that changes nothing
visible. Every harness that can *ever* have a tile is listed, with its badge saying
why it has not got one. `startsBare` is the single exclusion and it is not a status.

## The two screens, and the walk between them

**The strip's trailing control is a gear in the `+`'s slot.** Where it sits was
settled twice by report — pinned outside it overlapped the last tile, `sticky
right-0` inside it painted at the scrollport's edge and still read as pinned — so it
is an ordinary item you scroll to and `webcheck` pins the *placement*, never the
glyph. Adding an agent is one of four things somebody does to this list; the `+` is
at the foot of the screen the gear opens.

**Leaving `/new` for `/settings/machines/:id/agents` is affordable because both
halves of the screen survive it.** That navigation is what put the sign-in wizard
inline — a pop-up replacing a pop-up, discarding a walked-to folder. The folder is
in the address now, and the chosen tile is in `agentPick.ts` as a **standing** map:
`keepPick`/`heldPick`, **read** rather than taken, which is the opposite discipline
from the two hand-offs beside it. Those carry an event that happened once; this
carries a choice that stays true until somebody taps another.

**`…/agents` names a screen again.** It meant one agent's sign-in until a harness
and the account it signs in to came apart; `…/agents/claude` now lands on the list
with the tail dropped, which is this parser's standing "fall up to the nearest real
screen".

**And its ◀ reads `origin`, at this one screen and for a New session origin only.**
The gear is a crossing, so the parent in the URL is not where anybody came from.
It cannot be general: `originFor` keeps an origin across a move *within* a pop-up,
so applying it at every depth would make a settings sheet opened from New session
answer `/new` for its sections too. Narrowed to the New session pop-up so
`settingsUpLabel` has exactly one name to give.

**Two controls on a row — a handle and a menu — and what varies is *inside* the
menu.** A row that loses a control moves every control beside it, and on a list you
drag that is the one thing that must not happen; a menu's panel is drawn on demand
and displaces nothing. So the kebab is live on **every** row, and `frozen` — a
daemon that cannot store an order — is the only thing that switches it off. The
error line above the list is reserved for the same layout reason.

**One removal per row, called the same thing on both kinds.** From the picker's
side "hide this harness" and "delete this assembled agent" are one act — *this stops
being offered* — and a harness is only an agent whose vendor picked the model. It
went the long way round to get here: an eye button beside the kebab (three controls
at the right-hand end of a row you also drag), then "Hide from New session" *beside*
"Remove agent" on assembled rows, which is two removals on one row and a harness
that could only be hidden while everything next to it could be removed.

⭐ **The row's *kind* may decide a lookup or a destination and never a
presentation.** This is the property that kept breaking one control at a time: the
kebab was `disabled` on a harness, then Edit was absent from it, then Remove was
`danger` on everything else. Each was defensible on its own and each was the app
showing the reader an internal difference — one is a row in SQLite, the other a
binary on the host — that the reader has no use for. `webcheck` sweeps for a
`harness` branch inside a `danger=` or a `className=` rather than pinning the one
place it last went wrong.

**What still differs is what a removal *does* afterwards, and that is unavoidable
rather than a signal.** A built-in is the hidden flag, so its row stays — dimmed,
offering **Add back**, because a flag is all there is to undo. An assembled agent is
`DELETE /custom-agents/:id`, so there is no row left to dim and getting it back
means assembling it again. **No two-tap confirmation and no `danger`**, which
reverses the settings-row rule on purpose: that rule is for acts nothing brings back
— retiring a machine, deleting a person, uninstalling a plugin with its data — and
this one is rebuildable from the bar at the foot of the same screen.

**Both verbs are on both kinds. A built-in agent is an agent.** `Edit` was absent
from a harness row on the argument that a harness has nothing stored to edit — true,
and the wrong conclusion: this list holds *agents*, and the built-in one is the one
that exists by **default**, not a different kind of thing. A row with fewer verbs
than its neighbours is what made it look special.

So editing a harness means what it can mean: **start from it.** There is no row to
`PATCH`, so it opens the builder already pointed at that harness —
`/agent/:machineId/from/:harness` — and saving assembles an agent. The default row
stays; somebody who wanted theirs *instead* has Remove one item below it. The two
markers, `edit` and `from`, are read at one position, so a route carrying both is
unexpressible rather than merely unused, and a harness this build cannot resolve
opens the ordinary new-agent screen (`compatibility.md`'s rule 2, the direction
`edit` already fails in).

**The labels are one word each — `Edit`, `Remove`, `Add back`.** A menu row is read
in a glance beside three others; the list it acts on is named by the screen.

**A removed harness is dimmed in place**, keeping its position — that is the thing
somebody came to set, and taking the row out would take away the only way back.
`bg-raised/60` under `text-faint`, a ground *and* an ink; `text-muted` alone was
reported as not looking removed. Never `opacity`, which composites the line
explaining what the row is.

**The line under a built-in row is the vendor, never `signed in`.**
`harnessSubline` reads it off `GET /systems` by `nativeHarness`, so the name is the
daemon's. A `strong`-toned `agentBadge` — not installed, not signed in — displaces
it; the two `plain` ones do not, because a status true of every healthy row is the
noise this replaced. The strip's own tiles carry the same line, for the same
reason.

## Reordering, with no library

There is no drag-and-drop dependency in `packages/web` and none is added. The handle
is a `<button>` that takes `setPointerCapture` — `AppShell`'s `RailHandle` rule, the
gesture belongs to the control it started on — and the **same button** answers
`ArrowUp`/`ArrowDown`/`Home`/`End`. A pointer gesture that is the only way to
reorder is a control a keyboard cannot reach at all.

- **Per-frame work goes to the DOM, per-row work goes to React.** The dragged row's
  offset is written straight onto its node; the target index is state, because every
  other row's shift is a function of it.
- ⭐ **`touch-none` was a dead class, and that is why a phone could not drag at
  all.** `index.css` carried `button { touch-action: manipulation }` **unlayered**,
  and an unlayered rule beats every `@layer utilities` class regardless of
  specificity — measured on the built stylesheet, `.touch-none{touch-action:none}`
  at byte 18486 inside the layer against the button rule at 46097 outside it. So the
  effective value stayed `manipulation`, which still permits panning. A mouse is not
  gated by `touch-action`, which is why it worked on a desktop. The base rule is
  layered now; a bare-element declaration that a utility may need to override
  belongs in `@layer base`, and this file's focus-ring docblock already said so.
- **A second guard that does not share that cause**: a non-passive `touchmove`
  listener on the handle, `preventDefault` only while a drag is live. React attaches
  `onTouchMove` passively — the same fact `AgentStrip`'s wheel handler is written
  out of — so it can only be an `addEventListener`, and it is registered for the
  component's life rather than the gesture's, because some engines decide at
  `touchstart` from whether such a listener *exists*.
- **The handle is 44px square**, where `w-8` was a strip you miss and scroll the
  sheet instead, and the glyph is `pointer-events-none` so the hit target is always
  the element carrying `touch-none`. `.press` is off it too: `scale(0.97)` for the
  length of a drag reads as broken.
- **The row under the finger is never transitioned**, only its neighbours, and only
  while a drag is live. Its transform is rewritten every pointer event, so a
  transition restarts the interpolation each time and the row crawls after the
  finger. The same class going off at the drop is what stops the overshoot when the
  transform clear and the keyed reorder land in one commit. `will-change-transform`
  is held for the gesture and no longer.
- **`moveRow` splices and never swaps**, or the pointer and the keyboard disagree
  about what "move down" means. **`dropIndex` rounds**, so a row swaps when the
  dragged one is more than half over it rather than a full row late.
- **A refused write restores what the daemon last confirmed**, not the list as it
  was one edit ago, under a sequence guard — the keyboard emits one write per key.

## The fade at the cut edge

**A row that is cut has to look cut, and the scrollbar cannot say it.** That bar
reports a *position* and is invisible until the row moves, so a first paint says
nothing — and this strip's last item is a fully drawn control, which reads as the
row's deliberate end. That is exactly why it stopped using `.no-scrollbar`, whose
docblock names the shape that needs no fade: "a strip whose contents already announce
that there is more of them by being cut off at the edge".

- It is the transcript's fade with its measurement intact: **two stops, 70% to
  nothing**, `pointer-events-none`, and a **sibling of the scroller rather than a
  `mask-image`** — a mask on a scroll container applies to its scrollbar too.
- **Toggled inside the existing `layout()`**, which already holds all three numbers
  and already runs on exactly the two events that change the answer. A second
  handler would be the same arithmetic twice, disagreeing for one frame.
- **One pixel of slack**, because these three integers are rounded from fractional
  layout and a fully scrolled strip routinely reports a remainder of 1. This is the
  opposite call from `scrolledDown`, which takes none and says why.
- **`.edge-fade` lives in `index.css`**, after `.fade-thumb.is-scrolling` — the
  `opacity` may not appear inside `AgentStrip`, and a rule inserted before that
  selector re-anchors `webcheck`'s slices of the stylesheet.
