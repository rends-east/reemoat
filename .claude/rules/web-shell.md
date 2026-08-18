---
paths:
  - packages/web/src/ui/AppShell.tsx
  - packages/web/src/ui/SessionBrowser.tsx
  - packages/web/src/ui/SessionView.tsx
  - packages/web/src/ui/SessionMenu.tsx
  - packages/web/src/ui/Header.tsx
  - packages/web/src/ui/Sheet.tsx
  - packages/web/src/ui/ErrorBoundary.tsx
  - packages/web/src/ui/ProfileMenu.tsx
  - packages/web/src/ui/Toast.tsx
  - packages/web/src/ui/NewSession.tsx
  - packages/web/src/ui/groups.ts
  - packages/web/src/ui/keyboard.ts
  - packages/web/src/ui/rail.ts
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
---

**Client-side it is four pure predicates in `wire.ts`, asserted as a partition:**
`waitingForDaemon`, `resumeStalled`, `showsAsEnded` (exactly one holds for any
terminal session, none for a live one) plus `countsAsLive`, separate on purpose —
a stalled row belongs in Active because a human must act, but must not inflate a
count drawn beside a green dot. Every one keys on `exit.reason`, never `status`
alone. Consequences: `Composer.tsx` early-returns on `showsAsEnded`, so only a
session *you* ended loses its composer; `StatusDot` goes through `statusTone`;
and `POST /sessions/:id/prompt` joins `slowRoute`'s 90s budget unconditionally,
because `request` sees only a method and a path.

**A cancel is two more pure predicates in `wire.ts`.** `canCancelTurn` is
`turn !== null && !isTerminal && status !== "stopping"` — deliberately **wider
than `showsWorking` by exactly the blocked case**, because a session parked on a
question is where somebody most wants out and the daemon takes the cancel there.
The `stopping` clause is the daemon's *second* refusal (`terminal ||
stopRequested`) and `isTerminal` does not cover it: a session stopped mid-turn
carries `{status: "stopping", turn: 5}` for seconds. `cancelInFlight`
additionally reads `cancelRequestedAt`, so the button does not re-arm the instant
the request returns; the field is optional on the wire, so `?? null` is the whole
migration. In `Composer.tsx` the Stop control takes the **send slot**, and nothing
is drawn optimistically — claiming an agent had been called off while it is still
working is the one lie this control must not tell. Q3.222.

**A late-write gate is half a rule and the reset is the other half.** `stopping`
is shared React state on a component the two-pane layout never remounts, so it
belongs in the `[key]` effect beside `busy` and `applying`. `webcheck` asserts the
**pair** on that effect's own region, for every shared flag. Q3.221.

## The web UI

`packages/web` is a plain React + Vite + Tailwind SPA, built by `pnpm web:build`
and served by the control plane at `/`. No Electron, no service worker, no push.
It is **adaptive**: below `lg` one screen at a time, list → detail; at `lg` and
above the list becomes a permanent left rail. `AppShell` is the only place that
knows, and it knows **in CSS** — no breakpoint state in JavaScript, so a resized
window cannot render a rail that is not there.

It is shaped around one question asked from a phone: **does anything anywhere need
me** — and the answer travels *with the rows* rather than living in a mode you
have to enter. These are the rules a change here must not break:

- **An approval cannot be hidden.** A waiting session says so on the status dot
  every row already carries — a filled dot with a permanent ring — plus a
  **semibold row title** and a count on its folder's header, so a *collapsed*
  folder still says how many rows under it are waiting and blocked rows sort first
  inside it. Three signals rather than one, because with the palette monochrome
  there is no amber left to spend. Only one machine's chats are on screen at a
  time, so `waitingFloor` in `groups.ts` carries the rest, computed by
  **subtraction** — everything blocked, minus everything this view can draw — so a
  new section, filter or needle cannot open a gap by accident. It ignores the
  filter and the needle deliberately, and `webcheck` asserts it as a **superset
  property** over every filter × every tab × a set of queries. Q3.200.
  **`Sheet` no longer draws a waiting count**, which reverses Q3.201: settings
  stopped *replacing* the rail and became a pop-up over it, so on a desktop the
  count was a second copy of numbers already on screen behind the scrim. The cost
  is on a phone, where the sheet does cover the list. Q3.434.
- **`machineSubline` keeps `blocked` above `offline`**, and an unreachable machine
  is announced **nowhere in the rail**: `MachineTabs` draws `name` and
  `blockedCount` only, and `machineSubline`/`MachineTab.reach` have no caller
  outside `webcheck`. Settings → Machines and the New session picker are the only
  places reachability is shown. An open question rather than a settled trade.
  Q3.202.
- **Nothing in a row mounts sideways into another control.** Three remedies and
  the choice between them matters: *delete it* when redundant; *reserve its slot*
  when it is the only copy (the pin, the two spinners); *move it off the row* when
  it is neither (the context percentage went into a popover). A mount only
  displaces what lies between it and the nearest `flex-1` sibling.
- **Reserve the gutter**, `scrollbar-gutter: stable` as `.scroll-stable`, on the
  **one** box other things are measured against — the transcript — and not on `*`,
  which would pad every popover and `<pre>`. `scrollbar-width: thin` takes layout
  width, so crossing the fit threshold moves everything *centred* by half of it
  while nothing left-aligned moves at all. The rail and `AppShell`'s content pane
  are both exceptions and neither may take it back. Q3.203.
- **The content pane paints `bg-surface` and the rail paints `bg-ink`**, both
  explicitly. Neither may fall through to `body`. Q3.204.
- **The paper is grey with a memory of warmth, and `raised` is spent at two
  strengths.** Chroma across all three surfaces is 0.003–0.006 in OKLCH; `surface`
  is plain `#ffffff`. **In the transcript, machinery has no fill at all** — a tool
  call is a bare row, like the folded run beside it. What stays filled is
  **`bg-raised`** for the message you wrote at 1.22:1, and **`bg-raised/50`** at
  1.10:1 for a plan, the panel a wizard sits in, and a well *inside* an expanded
  row. `ink` is the rail and, at 1.06:1 from the pane, is **not** a tonal step
  anything in the conversation may be built on. Q3.205, Q3.206.
- **A control is drawn in the colour of what it sits on, so `edge-strong` is its
  only identification.** Every field and every unfilled button matches its ground
  (`bg-ink` in the rail, `bg-surface` on a sheet or in the composer) and is bounded
  by `--color-edge-strong`, which is why that token has a ≥3:1 floor and `edge` is
  never an alternative to it. The exceptions are the two values you must read once
  — the one-time secret and the device code — and they take a real fill.
- **Machinery is `text-fg/85`, one value for every machinery row, failures
  included**; the `X` at full `fg` and `N failed` carry a failure instead of
  weight. A permission row is padded and reserves the kind-glyph slot **empty**,
  because it folds into a run. Q3.207.
- **A title is clipped in code, and only when the clip pays for a line** —
  `truncate` throws away "was anything cut", which decides whether a card can be
  opened at all. `TITLE_CHARS` 80 with `TITLE_OVERFLOW_MIN` 20; the body opens to
  the title in full. `headlineWorthDrawing` is the same judgement one field over: a
  value whose opening 24 characters already appear in the title is an echo and is
  not drawn, which keeps `Bash` beside `npm test`. Q3.208.
- **What belongs to the row above it hangs off `border-l-2 border-edge`, and that
  is the transcript's only nesting idiom** — a subagent's steps, a folded run's
  children, an expanded tool call's own detail. A failure keeps neither a border
  nor any weight.
- **`bg-fg` is the affirmative action inside a decision, and nothing else** —
  Send, and the reversible approval on the ask card. Anything else wearing it
  becomes the loudest object on screen. `raised` means **state**: a tab you are on,
  a toggle that is on, a menu row that is chosen. Q3.209.
- **The magnifier in the rail header is not the chat search and is deliberately
  inert.** The box below filters *this machine's* chats by title; that icon is the
  fleet-wide search, which is not built. It is drawn `disabled` rather than doing
  nothing silently. Q3.211.
- **`border-r` on the rail has now been argued both ways, so the rule is the
  ratio.** Below roughly 1.15:1 a line does the dividing and the tone only supports
  it; at 1.06:1 two panes with no line between them read as one pane. Q3.210.
- **`visibleRows` in `groups.ts` is the single source of render order**, shared
  with `keyboard.ts` so `j` cannot land on a row nobody can see. It **deduplicates
  by key**, because pinning *copies* rather than moves. `pinnedFor` and
  `orphansFor` are the two exported slices the JSX is **obliged** to call —
  `visibleRows` calls them too, and `webcheck` reads `SessionBrowser.tsx` off disk
  to assert it does. Any group added beside them owes the same pair. Q3.101.
- **Anything that filters the list belongs beside the filter**, in `groups.ts`
  module state. A component `useState` makes `j`/`k` step onto rows the rail is not
  drawing — the failure `groups.ts` and `keyboard.ts` each claim is structurally
  impossible. Q3.15.
- **Tabs and folders are ordered by name, never by reachability or activity.**
  Both flicker on the four-second poll, and a list that reorders while a thumb is
  travelling is the one thing this cannot do. A machine with no sessions still gets
  a tab, which gives it a create button. A folder holding a waiting session does
  **not** hoist; that fact rides its header as a count. Q3.224.
- **A folder is a working directory**, keyed `git.repoRoot ?? requestedCwd` and
  scoped to a machine (` `, the one byte a POSIX path cannot hold — otherwise
  collapsing `~/api` on the laptop collapses it on the server). `repoRoot` is the
  **main** repo root and never the per-session worktree, which `worktree.ts`
  guarantees. Sessions in subdirectories collapse into one folder deliberately, and
  `rowSubpath` gives back only the part the folder does not already say. Names are
  basenames widened to the shortest unique suffix, and only where they collide.
- Collapse state is module state seeded from `localStorage`, not `useState`: the
  phone's list → detail → back unmounts the list. So is the selected machine tab —
  **persisted, unlike the filter**, because a tab is where you were working while a
  filter is visible on screen the moment you look. The search needle is **not**
  persisted: a search you did not type is a list that looks broken.
- **The filter default is `"active"`, and it may only be narrowed while some
  control can widen it again.** This filter is the **only** route to an ended
  session anywhere in this app, and the icon beside the search box is a live
  `Dropdown` on `setFilter`. If it is ever reverted to a placeholder, `groups.ts`'s
  initialiser and `webcheck`'s assertion go back to `"all"` in the same commit.
  Q3.212.
- **There is no back button, and a pop-up does not add one.** A screen's leading
  control is a close to a fixed destination; a sheet's ✕ goes to the path
  `history.state` recorded when it opened (`useUnder`) and its ◀ to
  `settingsUp(route)` — both derived from the URL rather than from a history.
  **`Header`'s leading control is drawn as `ChevronLeft` and is still not a back
  button**: a ✕ on a full-screen phone view reads as "discard this" where the act
  is "go up to the list", so the glyph changed and `navigate("/")` did not. It must
  never become `history.back()`, which is what it was and which sent people to a
  session they had already left or out of the app on a fresh load.
- **The session header carries a kebab below `lg` and nothing above it.** The menu
  was removed once on the grounds that Rename, Pin, Resume and Stop are all on the
  session's row in the list — true while the list is *on screen*, which below `lg`
  it is not, because there this app is one screen at a time and "it is on the row"
  means leave, find, act, return. `lg:hidden` in CSS rather than a prop, for
  `AppShell`'s reason. Rename stays on the title as well: the title is the
  discoverable path, the menu is the one a thumb finds without knowing it is one.
- **The machine's name is on the subline, not a `Badge` in the title.**
  `WorkspaceLine` is the "where is this session" answer and the host is the first
  half of it, ahead of the path it is a path *on*. At every width rather than below
  `sm`: at `lg` the rail already shows which machine's tab is selected, so the badge
  was the more redundant of the two there.
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
- **Waking a phone runs one `resume()`** in `store.ts`: refresh tokens, re-probe
  routes, re-list sessions, reconnect sockets — per machine and independently, so
  one machine that is off never blanks the list. Replay is exactly-once off a
  single `lastAppliedSeq` per session. **It also leaves the loading screen**:
  `runResume` promotes `loading` → `ready` on the machine listing having
  **succeeded**, never on it having returned rows, only ever upwards, and fires
  `refreshMe()` at that moment so an admin does not silently lose the Users
  section. Q3.97.

**A machine row carries its id, because the name is not unique.** `nameVisibleTo`
refuses a duplicate on the five routes that *name* a machine, but `PUT
/v1/admin/grants` reaches the same state without naming anything and is knowingly
open; `resolveMachineRef` then silently picks the owned one, so the id is drawn on
the row and on the agents screen. The subline says **"not yours to rename or
retire"** rather than "not registered to you" — the reader needs the consequence,
and `owned: false` covers both a machine somebody granted you and one an admin
created before ownership existed.

**Agent settings live inside a machine, and there is no top-level Agents
section.** `/settings/machines/:machineId/agents[/:agentId]`: the machine rides
the URL for `/new/:machineId`'s two reasons (a component-state picker forgets
itself on back-and-forward, and a fixed close control needs somewhere real to
close *to*), and the **◀** walks one level up rather than to the index — this said
*the ✕*, which is `useUnder` and leaves settings altogether. Every rule
about those segments is in `settings.ts`'s `parseSettingsRoute`, not `router.ts`,
so `webcheck` can assert them — that file cannot be imported at all. A stale
`/settings/agents` falls to the index, deliberately not redirected: a redirect
would have to guess which machine. **`Configure agent` sits outside the ownership
gate** on a machine row, because rename and retire are acts on the registry (404
for anybody but the owner) while configuring an agent is an act on the daemon,
reached with the `session:write` grant a shared machine carries. Q3.415.

**A sheet's head names the pop-up; its pane names the screen.** `SHEET_HEAD` is a
child of `SHEET_PANEL`, so at `sm` and above it spans the 224px section rail as
well as the pane, and the only honest string in it is "Settings". The screen's own
name is `settingsPaneTitle`, drawn by the pane and withdrawn with
`up.withinNav ? "sm:hidden" : ""` — the same predicate as the chevron, because it
was always one argument about a screen's identity. The head's `<h1>` holds one
unconditional text node: it is what `aria-labelledby` resolves to, and a name
computed from a `display:none` subtree is no name at all, which `webcheck` now
pins by reading `Sheet.tsx` — a file no driver read until then. Q3.427.

**Creating a session asks three things** — machine, agent, folder — and
deliberately not whether to use a worktree, and not the first prompt. Q3.86,
Q3.87.

**What it deliberately does not do: no admin UI for grants** — sharing one machine
between two people is still `cpctl admin grant`. Users and machines both have one:
an admin creates, bans and deletes people under Settings → Users, and anybody adds
their own machine under Settings → Machines. Also **no workspace changes screen**
— the working copy against its base, `GET /sessions/:id/changes` and
`/changes/diff`, are routes this client has never called. It polls `GET /sessions`
per machine and holds a socket only for the three most recently viewed sessions.

**The two-step confirmation is the only modal-shaped control on a settings *row*,
and there are four of them** — deleting a person (`UserRow`), retiring a machine
(`MachinesSection`), signing an agent out on a host (`SignOutButton`, which takes
`danger` on the *first* tap, because retiring a machine is undone by enrolling it
again from the same screen while a signed-out CLI needs a device-code flow in
another tab), and revoking an API key — but **only somebody else's**. `KeyRow` in `UsersSection` is two-step; `AccountSection`'s list of *your
own* keys is a bare `Revoke` on one tap, with the consequence put **before** the
button as prose. Q3.219. The one confirming control not on a row is Registration
in `ServerSection`, asymmetric on purpose: **only the act that widens authority is
confirmed**. Q3.220.

The first tap replaces the row's buttons with the question and its two answers, so
nothing else on the row can be hit by accident. **The confirming row ends with
Cancel, and that ordering is the safety property rather than a preference:** both
groups lay out left-to-right in the same box so the last child occupies the same
pixels, `setConfirming(true)` is synchronous, and `.tap`'s `touch-action:
manipulation` removes the double-tap delay — so a second tap aimed at a button
that looked like it did nothing lands on the undo rather than on the irreversible
half. State is held **per row**, in the row's own component, because these lists
re-render on a poll. Q3.218.

**Everything else a settings row can do sits behind one kebab**, the same square
on every row, which takes the reserved trailing slot with it. The confirmation
still leaves the menu and lands on the row: a menu held open to hold a
confirmation would be a second dismissable layer over the sheet, for one tap.
**"API keys" stays in that menu** — its panel is the only caller of
`adminRevokeKey` anywhere in the product, and `DELETE
/v1/admin/users/:id/keys/:keyId` is reachable from it and nowhere else. Q3.216,
Q3.217.

**This app has modals, and there is a single arbiter for them.** `ui/overlay.ts`
holds a LIFO stack of dismissible layers and one capture-phase listener, and
`AskCard`, `Dropdown`, `SessionMenu` and `Sheet` are all registered participants.
`keyboard.ts` still binds Escape on `window` by design — it acts only where the
arbiter has not claimed the key — and `Composer`'s menu is an element handler on
the textarea; neither is a `window` Escape binding to collapse. Two rules decide
everything and both are pure and asserted: **typing beats every layer**
(`isTypingInto`), and otherwise **the most recently opened layer owns Escape and
stops propagation** — with `stop === (dismiss !== null)` asserted over every
generated stack, so nothing may stop propagation before deciding whether it will
act. Two things then fall out with no code: a menu inside a sheet takes Escape
first and the sheet takes the second, and a sheet opening over a parked question
closes itself and leaves the card as it was. Q3.214.

**Deciding is not navigating, and the bare-letter rule is two predicates for that
reason.** `shortcutsEnabled` blocks only a `sheet`, deliberately: `j` under an
open `Dropdown` moves a caret and the worst case is looking at the wrong row.
`decisionShortcutsEnabled` blocks every layer **except the card's own `ask`** —
`layers.length === 0` reads as the stricter and more obviously-correct rule and is
the broken one, since the card registers itself with `useDismissible("ask", …)`
and an empty stack is precisely the state in which there is no card to answer.
Q3.215.

**A widget role is a promise about behaviour, and both popups drew one for a long
time without keeping it.** `Menu` renders `role="menu"` and `Dropdown` renders
`role="listbox"` with `role="option"` and `aria-selected` on every row — and a grep
for `ArrowDown` over `packages/web` returned one hit, in the composer's own slash
menu. A screen reader announced "listbox, 8 options" and then no arrow key moved
anything. The decisions are `listNavKey`/`nextOptionIndex` in `keys.ts`, pure so
`webcheck` can reach them; the DOM half is `useListKeys` in `bits.tsx`. Three rules
follow. **The listener is on the panel and never on `window`** — focus is moved into
the panel on open, so an element handler suffices, and this app has exactly two
global keydown listeners on purpose. **`listNavKey` returns `null` for Escape**, so
the key travels to `overlay.ts`, which is still the only arbiter. And **focus goes
to the `aria-selected` row rather than the first**, then back to whatever opened the
panel on close, guarded so a row that deliberately moved focus keeps it.
`AgentConfigBar`'s hand-rolled panels build their own markup from `MENU_PANEL` and
are **not** covered.

**Nothing a person taps to answer an agent is under 44px, and that is asserted on
three files rather than on the UI.** A blanket rule would be false: 40 of 57 class
strings carrying `tap`/`press` do not reach 44px and most are right not to — a link
inside a sentence, a `<summary>` in running text, the 32px machine pills in a strip
you drag sideways. `AskCard`, `PermissionCard` and `ElicitationCard` are different
because a mis-tap there *answers*: it approves a command, refuses one, or submits a
form into the model's context. The convention was written and argued in
`AskCard`'s own docblock and then violated on that same card's header controls
(26px, 2px apart), on `ElicitationCard`'s answer rows (40px) and on
`PermissionCard`'s disclosure (18px). A docblock is not a mechanism; `webcheck`
scans the three files' class strings for a 44px signal. A control routed through
`IconButton` is not scanned, because the primitive adds `tap` itself and carries its
own 44px entry.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/wire.ts` | The daemon's vocabulary, hand-mirrored, and why it could not be imported |
| `packages/web/src/ids.ts` | Branded `MachineId`/`SessionId`/`SessionKey`, and the three rules that make `(machineId, sessionId)` structural |
| `packages/web/src/store.ts` | All client state, and `resume()` — the single wake path. `loadAll` pages a conversation in and does not stop until it reaches the start of it; `loadStop` is where it may stop, the daemon's own floor included; `transcriptNotice` reads the same five fields from the other end and is asserted as a total partition rather than as booleans in JSX; `historyRetry` is what a failed page costs and for how long (37.5s); `attachWanted` resumes a run that gave up |
| `packages/web/src/resume.ts` | Noticing the phone woke. Four triggers, one debounced call |
| `packages/web/src/settings.ts` | Which settings screen a URL names, who may see it, and which heading precedes it. Not the guard — `requireAdmin` is. `SECTION_SPECS` is the four sections in draw order; `navRows` pairs each with the heading it follows, at most once per group and only on that group's first *visible* row, which is the property `webcheck` asserts rather than the two rows |
| `packages/web/src/ui/groups.ts` | Which machine tab is selected, which folders are collapsed, what has been typed into the search box — and every rule that follows: `foldersOf`, `machineTabs`, `waitingFloor`, and `visibleRows`, still the **single** source of render order, deduplicated by key |
| `packages/web/src/ui/overlay.ts` | Who owns Escape, and what paints above what. A LIFO stack of dismissible layers, one capture-phase listener installed lazily inside `push()`, the `inert` refcount on `#root`, and `LAYER` — the z-order as full class strings, in one table a driver can assert. Also the **two** bare-key predicates |
| `packages/web/src/ui/rail.ts` | How wide the rail is: the bounds, `clampRailWidth` — the one place a width is bounded, and four ways in — and the module state seeded from `localStorage`. Holds **no DOM**, so `webcheck` can import it. The `--rail-w` custom property is written by `AppShell`, the impure shell; the width travels as that property and must not become a React prop, which would snap back to the start of the drag on every poll |
| `packages/web/src/ui/Sheet.tsx` | The large route-backed pop-up, portaled to `document.body`. A bottom sheet on a phone and a centred card above `sm`. It draws no waiting count (Q3.434) and takes no `up` (Q3.432): the head holds only what leaves the pop-up. Its **box** is two strings in `bits.tsx`: `SHEET_PANEL` is a **definite** height, never a `max-h` it can shrink under, and `SHEET_BODY` is a **flex column**, without which both callers' `min-h-0 flex-1` children mean nothing. `webcheck` pins both. Q3.223 |
| `packages/web/src/ui/ProfileMenu.tsx` | Who you are signed in as, and the two things you can do about it. The sidebar's footer, and the only copy of the name in the chrome |
| `packages/web/src/ui/AppShell.tsx` | The adaptive layout, decided in CSS. The rail is always the sessions — it does not switch to settings, and it does not scroll: the scroll is inside `SessionBrowser` so the account row can sit at the bottom and its popover can open upward without being clipped |
| `packages/web/src/ui/SessionBrowser.tsx` | The whole left column: logo, machine tabs, the waiting floor, the chat search, Pinned above the selected machine's folders, orphans, and the footer. Mounted twice — the `lg` aside and the `lg:hidden` screen — with the breakpoint answered only in those two class strings. A pinned row is drawn twice and walked once |
| `packages/web/src/ui/SessionMenu.tsx` | What you can do to a session — rename, pin, stop, resume — used from the header and every list row, plus `RenameField` |
| `packages/web/src/ui/settings/` | Settings as a list and a detail: `SettingsNav` (the 224px column beside the section at `sm`, the whole sheet body below it, and **no** blocked count — nothing in the pop-up draws one any more, Q3.434; it draws `navRows` rather than `visibleSections` plus a `group` read in JSX, so the **Server** heading cannot float over nothing for a non-admin), and one file per section — Machines, Account, **Server settings**, Users, in that order. The last two are `adminOnly` and are the two under the SERVER heading. `ServerSection` is the whole admin surface — registration, the machine limit, the provisioning key, the SMTP form and a test send — and carries no delivery log (Q3.225). It is the only thing that can change what `GET /v1/instance` reports, which is why it calls `store.refreshConfig()` beside its own `setAnswer`. Agents is **not** a section: `MachineAgentsSection` and `AgentsPanel` hang off a machine, two URL depths down |
| `packages/web/scripts/webcheck.ts` | Offline driver for the browser client. Stubs `window`, uses a real loopback socket. **Every pure function it imports is one this repo promises to keep assertable** |

## Bounds

| | |
|---|---|
| Web client | 3 live sockets (LRU), **16 MiB held per session and every event of it drawn** (`MAX_TRANSCRIPT_BYTES`, the **only** ceiling) — no render window; the only cut is the newest `context_cleared`. History pages backwards at **5000** and does not stop until the log's start, that cut, or those bytes — no per-run budget and no button; `MAX_AUTO_HISTORY` is only where the loop yields. A failed page retries at **500ms, 2s, 5s, 10s and 20s — 37.5s in all** — for a transport failure *or* one of `meansLater`'s three answered refusals, because what it must outlast is the daemon's own 1s→30s redial after a relay is recreated; `attachWanted` re-drives a run that spends it, and `transcriptNotice`'s `loading` arm keeps that latch from being silent. **60 sessions per machine per poll**, 4s list poll, 15s re-probe when unreachable, 1.5s reachability probe, token refreshed at `exp − 90s`, socket rotated at `exp − 60s`. 15s per request, except those spawning a process — `POST /sessions`, `/resume`, `/config`, `GET /agents`, `/agent-auth/*` **and `/prompt`** — which get 90s. `POST /sessions/:id/cancel` is deliberately *not* one of them, and `webcheck` pins that it is absent rather than forgotten. Login transcript polled every 700ms. Q3.226 |

## Known gotchas

- **`packages/web` cannot be type-checked by the root config.** The root is NodeNext
  (explicit `.js` on relative imports); the web package is bundler-resolved and
  extensionless, and `exclude` does not help because exclusion only trims the initial
  file set. That is why `webcheck` lives in the package with its own
  `tsconfig.check.json` — the only place `@types/node` and the DOM lib coexist.
