---
paths:
  - packages/web/src/ui/AppShell.tsx
  - packages/web/src/ui/SessionBrowser.tsx
  - packages/web/src/ui/SessionView.tsx
  - packages/web/src/ui/SessionMenu.tsx
  - packages/web/src/ui/Header.tsx
  - packages/web/src/ui/Sheet.tsx
  - packages/web/src/ui/ErrorBoundary.tsx
  - packages/web/src/ui/MenuDrawer.tsx
  - packages/web/src/ui/MachineColumn.tsx
  - packages/web/src/ui/Toast.tsx
  - packages/web/src/ui/NewSession.tsx
  - packages/web/src/ui/groups.ts
  - packages/web/src/ui/keyboard.ts
  - packages/web/src/ui/rail.ts
  - packages/web/src/ui/rowDrag.ts
  - packages/web/src/sessionOrder.ts
  - packages/web/src/ui/overlay.ts
  - packages/web/src/ui/bits.tsx
  - packages/web/src/ui/settings/*
  - packages/web/src/store.ts
  - packages/web/src/router.ts
  - packages/web/src/resume.ts
  - packages/web/src/settings.ts
  - packages/web/src/ids.ts
  - packages/web/src/wire.ts
  - packages/web/src/App.tsx
  - packages/web/src/main.tsx
  - packages/web/scripts/webcheck.ts
  - packages/web/scripts/webcheck.*.ts
---

**Client-side it is four pure predicates in `wire.ts`, asserted as a partition:**
`waitingForDaemon`, `resumeStalled`, `showsAsEnded` (exactly one holds for any
terminal session, none for a live one) plus `countsAsLive`, separate on purpose —
a stalled row belongs in Active because a human must act, but must not inflate a
count drawn beside a green dot. Every one keys on `exit.reason`, never `status`
alone. Consequences: `StatusDot` goes through `statusTone`, and `POST
/sessions/:id/prompt` joins `slowRoute` unconditionally, because
`request` sees only a method and a path.

**A cancel is two more pure predicates in `wire.ts`.** `canCancelTurn` is a turn,
unprompted work or a parked request, `&& !isTerminal && status !== "stopping"` —
**wider than `showsWorking` by exactly the blocked case**, where somebody most
wants out and the daemon takes the cancel, turn or not (Q2.232).
The `stopping` clause is the daemon's *second* refusal (`terminal ||
stopRequested`) and `isTerminal` does not cover it: a session stopped mid-turn
carries `{status: "stopping", turn: 5}` for seconds. `cancelInFlight`
additionally reads `cancelRequestedAt`, so the button does not re-arm the instant
the request returns; the field is optional on the wire, so `?? null` is the whole
migration. In `Composer.tsx` the Stop control takes the **send slot** while the box
is empty — with a *sendable* draft the slot is Send, because the daemon takes a
mid-turn message now (`mid-turn-messages.md`) — and nothing is drawn optimistically — claiming an agent had been called off while it is still
working is the one lie this control must not tell. Q3.222.

**A late-write gate is half a rule and the reset is the other half.** `stopping`
is shared React state on a component the two-pane layout never remounts, so it
belongs in the `[key]` effect beside `busy` and `applying`. `webcheck` asserts the
**pair** on that effect's own region, for every shared flag. Q3.221.

## The web UI

`packages/web` is a plain React + Vite + Tailwind SPA, built by `pnpm web:build`
and served by the control plane at `/`. No service worker and no push — and **one
bundle, two shells**: `packages/native` is a Tauri window around this same
`dist`, so every screen here runs in a browser and in a native app with no second
copy and no branch at a call site. `native-shell.md` is that area, and Q3.605 is
why "no Electron" is narrowed rather than reversed.
It is **adaptive**: below `lg` one screen at a time, list → detail; at `lg` and
above the rail becomes permanent and is **two columns** — `MachineColumn`, 80px of
machines, then the session list. `AppShell` is the only place that knows, and it
knows **in CSS** — no breakpoint state in JavaScript, so a resized window cannot
render a rail that is not there. Both columns are inside one `<aside>` on one
`--rail-w`, which is what keeps `RailHandle` anchored on that property rather than
on a `calc` of two lengths in two units.

It is shaped around one question asked from a phone: **does anything anywhere need
me** — and the answer travels *with the rows* rather than living in a mode you
have to enter. These are the rules a change here must not break:

- **A waiting session says so where it is, and never moves.** The status dot every
  row already carries — a filled dot with a permanent ring — plus a **semibold row
  title**, a count on its folder's header (so a *collapsed* folder still says so)
  and one on its machine's tab. Nothing lifts it: not inside a folder (Q3.569) and
  not across machines, since there is no waiting section any more, and `webcheck`
  sweeps every filter × tab × query to assert a waiting row is drawn exactly where
  the same row not waiting would be. Q3.674, reversing Q3.200.
  **`Sheet` draws no waiting count** (Q3.434, reversing Q3.201).
- **`machineSubline` keeps `blocked` above `offline`**, and no row or banner says a
  machine or the server is unreachable: `ConnectionPill` does, floating at the
  list's bottom-left (`relay.md`, Q3.659). `MachineTab.reach` has no caller outside
  `webcheck`. Q3.202.
- **Nothing in a row mounts sideways into another control.** Three remedies:
  *delete it* when redundant; *reserve its slot* when it is the only copy (the
  pin, the two spinners); *move it off the row* when it is neither (the working
  caption went to the transcript). A mount only displaces what lies between it and
  the nearest `flex-1` sibling.
- **Reserve the gutter**, `.scroll-stable`, on the transcript only — never on `*`,
  never on the rail or the content pane. Q3.203.
- **The content pane paints `bg-surface`, the rail `bg-ink`, explicitly.** Q3.204.
- **`raised` is spent at two strengths, and machinery in the transcript has no
  fill at all** — `bg-raised` for the message you wrote, `bg-raised/50` for a plan,
  a wizard's panel and a well inside an expanded row; `ink` is the rail and not a
  step anything in the conversation may be built on. Q3.205, Q3.206.
- **A control on a plane of its own is drawn in the colour of what it sits on, so
  `edge-strong` is its only identification** — every field and every unfilled
  button in the rail, on a sheet or in a form; that token's ≥3:1 floor is why.
  **Inside a container already bounded at `edge-strong` it carries none**, owing
  3:1 on its own action glyph rather than on text or a fill and dimming to
  `text-faint` rather than by `opacity`: `menuRow` in `MENU_PANEL`,
  `ICON_BUTTON_TONE.ghost`, and the composer's box, whose own rule argues it.
  The exceptions are the two values you must read once — the one-time secret and
  the device code — which take a real fill. **`nav` is the size of a head row's
  own leading control**, alone at its edge and 32px reaching 44 under a finger
  (Q3.634).
- **What belongs to the row above it hangs off `border-l-2 border-edge`, and that
  is the transcript's only nesting idiom** — a subagent's steps, a folded run's
  children, an expanded tool call's own detail. A failure keeps neither a border
  nor any weight.
- **`bg-fg` is the affirmative action inside a decision, and otherwise a *mark*
  under a stated size** — Send and the reversible approval; below that, only things
  the size of a glyph: the bell dot, a blocked count, a selected
  machine's 28px chip. A pill-sized fill is still the loudest object on screen.
  `raised` means **state**: a tab you are on, a toggle on, a chosen menu row.
  Q3.209, Q3.624.
- **One search control, and it is the live one.** The header is a single row —
  menu, field, filter, bell — so the *disabled* fleet-wide magnifier is gone:
  forty pixels from a box you can type in it was the conflation Q3.211 drew it
  apart to prevent, not the distinction. Fleet-wide search, when built, is a
  **scope** of this box under the `All` entry rather than a second control.
  Reverses Q3.211.
- **The menu is a left drawer and the only thing in this app that is not a
  route.** `MenuDrawer`, portaled, `useDismissible("sheet")` — never `"menu"`,
  which would leave `j`/`k` walking the list behind it. Two triggers and a pull
  (Q3.657), one panel, state in `App`; the `usePathname()` effect makes Android's
  Back close it, at the cost of Back doing two things.
  **No ✕, by the owner's call**, so VoiceOver on iOS reaches no exit — `webcheck`
  pins the absence. Q3.628.
- **`border-r` on the rail: the rule is the ratio**, measured in Q3.210.
- **`visibleRows` in `groups.ts` is the single source of render order**, shared
  with `keyboard.ts` so `j` cannot land on a row nobody can see. The order is
  `orderSessions`, applied where rows are *produced* — `rowsOf`, `underFilter`,
  `allRows` — so this needs no edit and cannot disagree with the caret. `pinnedFor` and
  `orphansFor` are the two exported slices the JSX is **obliged** to call —
  `visibleRows` calls them too, and `webcheck` reads `SessionBrowser.tsx` off disk
  to assert it does. Any group added beside them owes the same pair. Q3.101.
  It still **deduplicates by key**: what that defends against is the next group to
  copy rather than the one that used to.
- **Pinning *moves*.** `place` in `store.ts` pushes to `pinned` and returns
  `null`. It copied for a while, so a pinned session would not vanish from its
  folder — but both groups are on **one screen at one time**, so that was the same
  row drawn twice. Three things follow: `blockedCount` does not count it (a
  header's count is about the rows under *that* header), a pinned orphan is in
  `pinned` only, and `showPath` is back on. Nothing is hidden — `waitingFloor`
  subtracts what the view draws, and it draws `pinnedFor`. Q3.11.
- **Anything that filters the list belongs beside the filter**, in `groups.ts`
  module state. A component `useState` makes `j`/`k` step onto rows the rail is not
  drawing. Q3.15.
- **By name, `local` first, until a reader drags (`machine-gestures.md`), and never
  by reachability or activity.** Both flicker on the four-second poll, and
  a list reordering under a travelling thumb is the one thing this cannot do —
  which is why a *stored* order is allowed where a derived one is not. **Rows inside them are their reader's**:
  `sessions.rank`, a position clock defaulting to `createdAt`, descending. A drag
  writes it through `/meta`, with `pinned` beside it when the drop crossed Pinned;
  an absent `rank` is a daemon that cannot store one and freezes that gesture
  alone.
  Q3.569. **A finger's drag begins on `touchstart`, never `pointerdown`** — setup
  there bets the engine has not decided what the touch is for, which is what four
  phone reports were; a mouse captures at `arm`, never at the press, since capture
  retargets the `click` away from the `<button>` that opens the session. Only
  `target.index === origin.index` is a no-op. The ⋮ is on **every** row. Q3.574,
  Q3.576, Q3.577.
  A machine with no sessions still gets a tab, and with it a create button.
  **Pinned is cut to the selected machine**; every pin under All. Q3.550.
- **A path is cut against the daemon's own `REEMOAT_ROOTS`, and drawn once.**
  `displayCwd` cuts the longest matching root (`~/thing`); under none, or with no
  roots yet, it falls back to `shortPath`, never an invented prefix. Fetched once
  per machine into `rootsByMachine`. A row whose title *is* its directory does not
  repeat it underneath. Q3.441.
- **A folder is a working directory**, keyed `git.repoRoot ?? requestedCwd` and
  scoped to a machine (` `, the one byte a POSIX path cannot hold — otherwise
  collapsing `~/api` on the laptop collapses it on the server). `repoRoot` is the
  **main** repo root, never the per-session worktree. Sessions in subdirectories collapse into one folder
  deliberately, and `rowSubpath` gives back only the part the folder does not say. Names are basenames widened to the shortest
  unique suffix, and only where they collide.
- Collapse state is module state seeded from `localStorage`, not `useState`: the
  phone's list → detail → back unmounts the list. So is the selected machine tab —
  **persisted, unlike the filter**, because a tab is where you were working while a
  filter is visible on screen the moment you look. The search needle is **not**
  persisted: a search you did not type is a list that looks broken.
- **The filter default is `"active"`, and it may only be narrowed while some
  control can widen it again.** It is the **only** route to an ended session
  anywhere in this app, and the icon beside the search box is a live `Dropdown` on
  `setFilter`. Revert it to a placeholder and `groups.ts`'s initialiser and
  `webcheck`'s assertion go back to `"all"` in the same commit. Q3.212.
- **`upFrom` answers where up goes, and `null` at the root.** One pure function
  rather than a `switch` per screen — read in `App` for `LegalScreen` and for a
  sheet's ◀, so the two cannot drift. Q3.443, Q1.649.
- **There is no back button.** Every leading control goes to a fixed destination
  from the URL, never a history — `useUnder` for a ✕, `upFrom` for a ◀ — which is
  why one may be *drawn* as `ChevronLeft` without being one. None may become
  `history.back()`, which sent people to a session they had already left, or out
  of the app on a fresh load.
- **The session header's kebab is at every width, and one row is why.** Rename,
  Pin, Resume and Stop are on the session's rail row, so above `lg` the menu was a
  door to a door and was `lg:hidden`. `Background tasks` is on no rail row at any
  width and its other door — the transcript's foot — closes when nothing is
  outstanding. The four stay at `lg` rather than hiding inside it: one control
  holding different things at different widths is worse than a near duplicate.
  Q3.631.
- **The machine's name is on the subline, not a `Badge` in the title.**
  `WorkspaceLine` is the "where is this session" answer and the host is the first
  half of it, ahead of the path it is a path *on*. At every width, not below `sm`
  only — at `lg` the rail already says which machine's tab is selected.
  Android's Back needs no code: the pop-up is a real route, so Back pops the entry
  that opened it. One rule keeps it sane: **inside an overlay, anything that moves
  you shallower uses `replace` and anything deeper uses `push`.** Q3.17, Q3.213.
- **`router.ts` parses the URL in its module body, so nothing there may throw.**
  `parse(window.location.pathname)` runs at import, and a bare `decodeURIComponent`
  on a segment holding a lone `%` throws `URIError` during module evaluation — a
  blank page on a phone with no console, not fixable by reloading. `decodeSegment`
  returns the segment as written on a `URIError`, matching no machine and no
  session, so the route falls through to home. `sessionPath`/`newPath` always
  `encodeURIComponent`.
- **Session data never routes through the control plane's API.** The client holds
  one bearer credential — a session token from signing in, or a long-lived API key,
  still accepted from storage though `SignIn` offers no field to paste one into —
  sends it *only* to the control-plane origin, and mints a short-lived token per
  machine; those tokens are the only thing a daemon or the relay ever sees. It is
  deliberately **not a cookie**: `src/cors.ts` answers `*` and never sends
  `Access-Control-Allow-Credentials`, and that wildcard is only safe while no
  credential is ever ambient.
- **A screen replacing another one is drawn arriving, below `lg`.** `announce` in
  `router.ts` wraps itself in `document.startViewTransition` and writes `data-nav`;
  `index.css` keys `nav-enter`/`nav-under` off it, the back being the forward in
  reverse so the two cannot drift. The direction rule is **`nav.ts`**, pure and
  asserted, and its `null` arms carry it: session → session has no direction, and a
  pop-up moves the sheet rather than the screen behind it. It declines three ways,
  each leaving the old instant swap — nothing moves, no `startViewTransition`,
  `prefers-reduced-motion` — and **which widths animate is CSS**, for `AppShell`'s
  reason. `data-nav` is cleared **only by the navigation that wrote it**, or a
  second tap loses its attribute to the first one's cleanup and strands the old
  frame over the new screen. ⚠ **`@media` adds no specificity**, so every rule that
  animates a snapshot is keyed on `:root[data-nav…]` — asserted over the file
  rather than on the two that were wrong. Q3.445.
- **A sheet moves too, and nothing here teleports.** `section-push`/`pop` slide the
  sheet's **body** with the root pinned; `sheet-swap` cross-dissolves two pop-ups
  over one panel that holds still, and is tested **before** the depths because a
  depth means nothing across two stacks; `sheet-close` takes the whole panel down
  and fades the scrim. Opening stays CSS (`animate-sheet sm:animate-rise`): on
  mount, on every engine, and a transition too would animate one panel twice.
  ⚠ **A `view-transition-name` does not nest** — a named child is lifted out of its
  parent's snapshot into a *sibling* group — and both surfaces were wrong for it.
  The pane that slides paints its own `bg-surface`, or two screens' text is legible
  at once; a closing sheet gives the name back, or the frame leaves without its
  contents. Q3.442, Q3.444.
- **Waking a phone runs one `resume()`** in `store.ts`: refresh tokens, re-probe
  routes, re-list sessions, reconnect sockets — per machine and independently, so
  one machine that is off never blanks the list. Replay is exactly-once off a
  single `lastAppliedSeq` per session. **It also leaves the loading screen**:
  `runResume` promotes `loading` → `ready` on the machine listing having
  **succeeded**, never on it having returned rows, only ever upwards, and fires
  `refreshMe()` at that moment so an admin does not silently lose the Users
  section. Q3.97.

**A machine row carries its id only where the name is ambiguous**
(`ambiguousNames`): `PUT /v1/machines/:id/grants` collides without naming
anything, and `resolveMachineRef` picks the owned one. A machine that is not
yours carries a **`shared` badge**, never a subline; one badge per row, ranked
**state · `this device` · `shared`**. `this device` is the machine the app runs
on, read off the claim and the announce file via `AppState.localMachineId`, never
`route.kind === "local"` — a preference `setLocalOff` can switch off. The *label*
is the host name: "local" is drawn per client, never stored on a row every
client reads. Q3.543, Q7.139. It also carries **`enrolledBy`**
on a subline of its own — never a badge, never a clause on the truncating
`standing` line — since nothing else discloses a substitution no route may
refuse; `enrolledByText` is that one string, `null` where there is nothing to
say. Q1.637.

**Systems live inside a machine, and there is no top-level section for them.**
`/settings/machines/:machineId/systems[/:systemId]`: the machine rides the URL for
`/new/:machineId`'s reasons, the **◀** walks one level up rather than to the index,
and the segments are `parseSettingsRoute`'s so `webcheck` can assert them. A stale
address falls to the index and is not redirected, since a redirect would guess which
machine. **Configuring one sits outside the ownership gate**: rename and retire are
acts on the registry (404 for anybody but the owner) while signing in is an act on
the daemon, reached with the `session:write` grant a shared machine carries. Q3.415.

**A head that spans a section rail names the pop-up; its pane names the screen.**
Above `sm` settings' head spans the rail too, so "Settings" is the only honest
string in it; the screen's name is `settingsPaneTitle`, withdrawn with
`up.withinNav ? "sm:hidden" : ""` — the chevron's own predicate. A railless sheet
inverts it (Q3.473). Either way the `<h1>` holds one **unconditional** text node:
it is what `aria-labelledby` resolves to. Q3.427.

**Creating a session asks three things** — machine, agent, folder — and neither
whether to use a worktree nor the first prompt. Q3.86, Q3.87.

**What it deliberately does not do: no UI for sharing a machine** — that is the
owner's `cpctl share`; the admin route is deleted. Users and machines both have one:
an admin creates, bans and deletes people under Settings → Users, and anybody adds
their own machine under Settings → Machines. Also **no workspace changes screen**
— the working copy against its base, `GET /sessions/:id/changes` and
`/changes/diff`, are routes this client has never called. It polls `GET /sessions`
per machine and holds a socket only for the three most recently viewed sessions.

**The two-step confirmation is the only modal-shaped control on a settings
*row*, and every one of them is `TwoStep`** (Q3.552): `grep -c '<TwoStep'` over
`ui/settings/*.tsx` and `AgentBuilder.tsx` counts **fourteen** (thirteen sites,
two in `MachineLimitPanel`), a table `webcheck` holds by file. Revoking an API
key is a bare `Revoke` on one tap — the only list is your own, `KeysSection`,
its one consequence at rest the `this browser` row's, decided by
`thisBrowsersKey`, never under a session credential (Q3.219, Q3.545, Q3.546).
Registration in `ServerSection` is a `Badge` and a verb rather than a
`role="switch"` — **only the act that widens authority is confirmed**, Q3.220.
Removing an assembled agent wears no `danger` (`agent-strip.md`). **Every
confirmation names its subject**, and a two-step control is a bare button at
rest: its cost is the confirmation's text.

The first tap replaces the row's buttons with the question and its two answers,
so nothing else on the row can be hit by accident. **The confirming row ends
with Cancel, and that ordering is the safety property rather than a
preference:** both groups lay out in one box so the last child occupies the same
pixels, `setConfirming(true)` is synchronous, and `.tap` removes the double-tap
delay — so a second tap aimed at a button that looked inert lands on the undo.
State is **per row**, because these lists re-render on a poll. Q3.218. `TwoStep`
holds all of that, Cancel `plain` never `primary`, and the wait (`twoStepAct`):
closing only on the 200, standing on a failure. Two drifted sites keep
`justify-center` as `align="center"`. The site keeps the arming flag
(`armed`/`onArm`, controlled), the subject (`question`) and the resting control
(`rest`). Q3.552.

**Everything else a settings row can do sits behind one kebab**, the same square
on every row, which takes the reserved trailing slot with it. The confirmation
still leaves the menu and lands on the row: a menu held open to hold a
confirmation would be a second dismissable layer over the sheet, for one tap.
**"API keys" is gone from that menu**, panel and all: Q1.631 supersedes Q3.217,
which kept it as the only caller of `adminRevokeKey`. The holder's own `DELETE
/v1/me/keys/:keyId` writes `revoked_at` now, an admin neither sees nor
touches anybody's keys, and the row's one panel is the machine limit. Q3.216.

**This app has modals, and there is a single arbiter for them.** `ui/overlay.ts`
holds a LIFO stack of dismissible layers and one capture-phase listener;
`AskCard`, `Dropdown`, `SessionMenu` and `Sheet` are registered participants.
`keyboard.ts` still binds Escape on `window` by design — it acts only where the
arbiter has not claimed the key — and `Composer`'s menu is an element handler.
Two pure, asserted rules decide everything: **typing beats every layer**
(`isTypingInto`), and otherwise **the most recently opened layer owns Escape and
stops propagation**, with `stop === (dismiss !== null)` asserted over every
generated stack so nothing stops propagation before deciding whether it will act.
Two things fall out with no code: a menu inside a sheet takes Escape first, and a
sheet opening over a parked question closes itself and leaves the card. Q3.214.

**Deciding is not navigating, and the bare-letter rule is two predicates for that
reason.** `shortcutsEnabled` blocks only a `sheet`, deliberately: `j` under an
open `Dropdown` moves a caret and the worst case is looking at the wrong row.
`decisionShortcutsEnabled` blocks every layer **except the card's own `ask`** —
`layers.length === 0` reads as the stricter rule and is the broken one, since the
card registers itself and an empty stack is precisely the state with no card to
answer. Q3.215.

**A widget role is a promise about behaviour, and both popups drew one without
keeping it** — `role="menu"` and `role="listbox"` with `aria-selected` on every
row, while a grep for `ArrowDown` returned one hit. The decisions are
`listNavKey`/`nextOptionIndex` in `keys.ts`, pure so `webcheck` can reach them;
the DOM half is `useListKeys`. Three rules: **the listener is on the panel, never
on `window`** (focus moves into it on open, and this app has two global keydown
listeners on purpose); **`listNavKey` returns `null` for Escape**, so the key
travels to `overlay.ts`, the only arbiter; and **focus goes to the
`aria-selected` row rather than the first**, then back to whatever opened the
panel. `AgentConfigBar`'s hand-rolled panels are **not** covered.

**Nothing a person taps to answer an agent is under 44px, and that is asserted on
three files rather than on the UI.** A blanket rule would be false: most `tap`/
`press` strings do not reach 44px and are right not to — a link inside a sentence,
a `<summary>`, the two disclosure folds (Q3.632). `AskCard`, `PermissionCard` and
`ElicitationCard` are different because a mis-tap there *answers*: it approves a
command, refuses one, or submits a form into the model's context. The convention
was argued in `AskCard`'s own docblock and then violated on that card's own header
controls, on `ElicitationCard`'s answer rows and on `PermissionCard`'s disclosure —
a docblock is not a mechanism, so `webcheck` scans the three files' class strings
for a 44px signal. A control routed through `IconButton` is not scanned: the
primitive adds `tap` itself and carries its own entry.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/wire.ts` | The daemon's vocabulary, hand-mirrored, and why it could not be imported |
| `packages/web/src/ids.ts` | Branded `MachineId`/`SessionId`/`SessionKey`, and the three rules that make `(machineId, sessionId)` structural |
| `packages/web/src/store.ts` | All client state, and `resume()`, the single wake path. `loadAll` pages a conversation in and does not stop until it reaches the start of it; `loadStop` is where it may stop, the daemon's own floor included; `transcriptNotice` reads the same five fields from the other end and is asserted as a total partition rather than as booleans in JSX; `historyRetry` is what a failed page costs |
| `packages/web/src/resume.ts` | Noticing the phone woke. Four triggers, one debounced call |
| `packages/web/src/settings.ts` | Which settings screen a URL names, who may see it, which heading precedes it. Not the guard — `requireAdmin` is. `SECTION_SPECS` is the **seven** sections in draw order; `navRows` pairs each with the heading it follows, at most once per group and only on that group's first *visible* row, which is the property `webcheck` asserts rather than the two rows |
| `packages/web/src/ui/groups.ts` | Which machine tab is selected, which folders are collapsed, what has been typed into the search box — and every rule that follows: `foldersOf`, `machineTabs` and `visibleRows`, still the **single** source of render order, deduplicated by key |
| `packages/web/src/ui/overlay.ts` | Who owns Escape, and what paints above what. A LIFO stack of dismissible layers, one capture-phase listener installed lazily inside `push()`, the `inert` refcount on `#root`, and `LAYER` — the z-order as full class strings, in one table a driver can assert. Also the **two** bare-key predicates |
| `packages/web/src/ui/rail.ts` | How wide the rail is: `MACHINE_COLUMN_PX` plus the list's own three numbers, and the migration for a width stored before the column existed. The mechanism is `paneWidth.ts`, shared with the background panel; `docked-panels.md` is that area |
| `packages/web/src/ui/Sheet.tsx` | Route-backed pop-up, portaled to `document.body`. A bottom sheet on a phone, a centred card above `sm`. **One element serves every route-backed pop-up**, owned by `OverlaySheet`, so two cross-dissolve rather than one unmounting and the next replaying `animate-sheet` (Q3.484); `sheetTitle`/`sheetUpLabel` decide its head; only a railless pop-up gets a ◀ there (Q3.432, Q3.473). `footer` suits one screen; with several each draws its bar inside `SHEET_BODY` via `SHEET_SCREEN`, or `sheet-body` morphs mid-slide (Q3.472). Its **box** is two strings in `bits.tsx`: `SHEET_PANEL` a **definite** height, never a `max-h` it can shrink under; `SHEET_BODY` a **flex column**, without which both callers' `min-h-0 flex-1` children mean nothing. `webcheck` pins both. Q3.223 |
| `packages/web/src/ui/MenuDrawer.tsx` | Who you are, where you can go, and what build this is. Its foot draws the **build** and not the wordmark — the visible mark left the chrome entirely, and `webcheck` pins `<Mark` absent here — plus the rule for what a row here must be |
| `packages/web/src/ui/MachineColumn.tsx` | The machines as folders at `lg`. Same `machineTabs`/`allTab`, other axis — and what a horizontal strip carries that a column may not |
| `packages/web/src/ui/AppShell.tsx` | The adaptive layout, decided in CSS. The rail is always the sessions — it does not switch to settings, and it does not scroll: its two columns each own their scroller, so the New session button sits at the bottom of one of them |
| `packages/web/src/ui/SessionBrowser.tsx` | The list column: one header row (menu · search · filter · bell, the `<h1>` `sr-only`), the waiting floor, the machine tabs **below `lg` only**, Pinned above the selected machine's folders, orphans, and a footer that is one button. Mounted twice — the `lg` aside and the `lg:hidden` screen — the breakpoint answered only in those two class strings. A pinned row is drawn **once**, in Pinned, with its own path |
| `packages/web/src/nav.ts` | What a navigation moves (`depthOf`, `isSheet`, `navMove` — five values, two stacks never compared) and where "up" goes (`upFrom`, what a ◀ goes to). Its own module because `router.ts` reads `window.location` in its module body |
| `packages/web/src/ui/SessionMenu.tsx` | What you can do to a session — rename, pin, stop, resume — plus `Background tasks` in the header's copy, the panel's second door. `RenameField` |
| `packages/web/src/ui/settings/` | `SettingsNav` is the 224px column beside the section at `sm`, and the whole sheet body below it. One file per section — Account, **API keys**, Machines, **Logs**, then under an "Admin" heading Server, **Email**, Users, in that order; the last three `adminOnly` (Q3.543). **No neutral state at `sm`+**: the pane draws `DEFAULT_SECTION`, the rail highlights the same constant. `/settings` still parses to `section: null` (below `sm` it *is* the list), so the default feeds what is *drawn*, never `settingsUp`, and is never `adminOnly`. `ServerSection` holds registration, the domains, the machine limit and the provisioning key; `EmailSection` the SMTP form, the test send and delivery trouble, and no delivery log (Q3.225). **`LogsSection` is the one screen that lists program output**, and it exists because the setup notice stopped doing so (Q7.140): the ring of the daemon *this app started for this server*, and a sentence everywhere else — a browser, a `foreign` daemon, any other machine. Both change what `GET /v1/instance` reports, so each calls `store.refreshConfig()` beside its `setAnswer`. A list being read draws one `SkeletonRow` (Q3.548, Q3.544). **No row opens a form in place**: password, email and a new key are leaf screens (`SettingsLeaf`, Q3.549); keys are a `KeyTable`. Systems is **not** a section: `MachineSystemsSection` and `SystemsPanel` hang off a machine, two URL depths down |
| `packages/web/scripts/webcheck.ts` | Offline driver for the browser client. Stubs `window`, uses a real loopback socket. **Every pure function it imports is one this repo promises to keep assertable** |

## Bounds

| | |
|---|---|
| Web client | 3 live sockets (LRU), **16 MiB held per session, every event of it drawn** (`MAX_TRANSCRIPT_BYTES`, the **only** ceiling) — no render window; the only cut is the newest `context_cleared`. History pages backwards at **5000** and does not stop until the log's start, that cut, or those bytes; a failed page retries over 37.5s and `attachWanted` re-drives a run that spends it. **60 sessions per machine per poll**, which is why pinned outranks live in the daemon's `listRank`. 4s list poll, 15s re-probe when unreachable, 1.5s reachability probe, token refreshed at `exp − 90s`, socket rotated at `exp − 60s`. 15s per request, except those spawning a process — which get their daemon chain + 30s, 90s at least, `/prompt` unconditionally, because a deadline keyed on session state would be state leaking into the transport. `POST /sessions/:id/cancel` is deliberately *not* one, and `webcheck` pins it absent rather than forgotten. **Every number here is also in `docs/DECISIONS.md`'s Bounds table, which is the copy to change.** Q3.226 |

## Known gotchas

- **`packages/web` cannot be type-checked by the root config.** The root is NodeNext
  (explicit `.js` on relative imports); the web package is bundler-resolved and
  extensionless, and `exclude` does not help because exclusion only trims the initial
  file set. That is why `webcheck` lives in the package with its own
  `tsconfig.check.json` — the only place `@types/node` and the DOM lib coexist.
