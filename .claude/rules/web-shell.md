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

**Session state is pure predicates in `wire.ts`.** `waitingForDaemon`, `resumeStalled`,
`showsAsEnded` partition terminal sessions (exactly one holds; none for a live one);
`countsAsLive` is separate, so a stalled row is Active but uncounted. All key on
`exit.reason`, never `status` alone. `StatusDot` goes through `statusTone`;
`POST /sessions/:id/prompt` is always a `slowRoute`.

**Cancel.** `canCancelTurn` is a turn, unprompted work or a parked request
`&& !isTerminal && status !== "stopping"`, wider than `showsWorking` by the blocked case
(Q2.232); `isTerminal` does not cover `stopping`. `cancelInFlight` reads
`cancelRequestedAt` (`?? null`) so the button does not re-arm on return. Stop holds the send
slot while the box is empty, Send with a sendable draft (`mid-turn-messages.md`); never
optimistic. Q3.222. Shared flags (`stopping`, `busy`, `applying`) reset in the `[key]`
effect, gate and reset asserted as a pair. Q3.221.

## The web UI

React + Vite + Tailwind SPA (`pnpm web:build`), compiled into the native binary and served
over HTTP by nothing (Q4.118); no service worker, no push; `packages/native` wraps `dist` with no branch at a call
site (`native-shell.md`, Q3.605). Below `lg` list → detail; at `lg` a permanent rail,
`MachineColumn` (80px) then the list, in one `<aside>` on one `--rail-w` (`RailHandle`'s
anchor). Only `AppShell` knows, in CSS (no breakpoint state in JavaScript); the rail never
scrolls, each column owning its scroller.

Shaped around **does anything anywhere need me**, answered on the rows:

- **A waiting session says so in place and never moves**: ringed filled dot, semibold
  title, a count on its machine tab; subline stays (Q3.691), folder counts nothing (Q3.695),
  nothing lifts it (Q3.569), swept over filter × tab × query. `Sheet` draws no
  waiting count. Q3.674, Q3.200, Q3.434, Q3.201.
- `machineSubline` ranks `blocked` above `offline`; only `ConnectionPill` and an empty body
  say unreachable (`reach.md`); `MachineTab.reach` has no caller outside `webcheck`. Q3.202.
- **Nothing in a row mounts sideways into another control**: delete it, reserve its slot
  (the pin, the two spinners), or move it off the row.
- `.scroll-stable` on the transcript only, never `*`, rail or pane (Q3.203). Pane
  `bg-surface`, rail `bg-ink`, explicitly (Q3.204). Rail `border-r`: the rule is the ratio
  (Q3.210).
- `bg-bubble` is your own message (Q3.706); `bg-raised/50` a plan, wizard panel or expanded-row well;
  transcript machinery has no fill; `ink` is the rail only. Q3.205, Q3.206.
- **A control on its own plane takes its ground's colour, identified only by `edge-strong`
  (≥3:1).** Inside a container bounded at `edge-strong` it has no border, owes 3:1 on its
  action glyph and dims to `text-faint`, never `opacity` (`menuRow` in `MENU_PANEL`,
  `ICON_BUTTON_TONE.ghost`, the composer's box). The one-time secret and device code take a
  fill. `nav` sizes a head row's leading control, 32px reaching 44 (Q3.634).
- Nesting is `border-l-2 border-edge`, the transcript's only idiom; a failure keeps
  neither border nor weight.
- **`bg-brand` is the affirmative action in a decision** (Send, reversible approval), else a
  glyph-sized mark: bell dot, blocked count and dot, selected machine's 28px chip, switch
  knob (Q3.694). `raised` is state; a popover's chosen row gets a trailing check (Q3.684).
  Q3.209, Q3.624.
- **One search control, the live one** (menu, field, filter, bell). Fleet-wide search will
  be its scope under `All`. Reverses Q3.211.
- **The menu is a left drawer, the only non-route**: `MenuDrawer`, portaled,
  `useDismissible("sheet")`, never `"menu"` (`j`/`k` would walk the list behind). Two
  triggers and a pull (Q3.657), state in `App`; `usePathname()` lets Android's Back close
  it. No ✕ (owner's call; VoiceOver on iOS has no exit), pinned. Q3.628.
- **`visibleRows` in `groups.ts` is the single render order**, shared with `keyboard.ts`,
  deduplicated by key; `orderSessions` applies in `rowsOf`, `underFilter`, `allRows`. The
  JSX must call `pinnedFor` and `orphansFor` (asserted off `SessionBrowser.tsx`, mounted
  twice: `lg` aside and `lg:hidden` screen); a new group owes the same. Q3.101.
- **Pinning moves**: `place` in `store.ts` pushes to `pinned`, returns `null`;
  `blockedCount` skips it; a pinned orphan is in `pinned` only. Q3.11. List filters are
  `groups.ts` module state, never component `useState`. Q3.15.
- **Machines by name, `local` first, until dragged (`machine-gestures.md`); never by
  reachability or activity.** Rows are their reader's: `sessions.rank` (defaults to
  `createdAt`, descending) written through `/meta`, with `pinned` when crossing Pinned; a
  daemon with no `rank` freezes that gesture alone. Q3.569. A finger drag starts on
  `touchstart`, never `pointerdown`; a mouse captures at `arm`, never the press. Only
  `target.index === origin.index` is a no-op. ⋮ on every row. Q3.574, Q3.576, Q3.577. An
  empty machine still gets a tab and create button; Pinned is cut to the selected machine,
  all under All. Q3.550.
- **Paths**: `displayCwd` cuts the longest of the daemon's `REEMOAT_ROOTS` (`~/thing`,
  fetched once into `rootsByMachine`), else `shortPath`, never an invented prefix. A row
  shows its machine, no path (Q3.681). Q3.441.
- **A folder is a working directory**: `git.repoRoot ?? requestedCwd` (main repo root,
  never the worktree), per machine (joined by `\u0000`). Subdirectories collapse in;
  `rowSubpath` shows the rest. Names widen to the shortest unique suffix only on collision.
- Collapse state and the machine tab are `localStorage`-seeded module state; the tab
  persists, the filter and search needle do not.
- **Filter default `"active"`**, narrowed only while a control can widen it: the only route
  to an ended session is the live `Dropdown` on `setFilter`. Making it a placeholder reverts
  `groups.ts`'s initialiser and `webcheck` to `"all"` together. Q3.212.
- **No back button**: leading controls go to a fixed URL destination, `useUnder` for ✕,
  `upFrom` for ◀ (pure, `null` at root, also for `LegalScreen`; Q3.443, Q1.649). Never
  `history.back()`.
- **The session header's kebab is at every width**: `Background tasks` is on no rail row and
  the transcript-foot door closes when nothing is outstanding. Q3.631.
- The machine name is on the subline (`WorkspaceLine`), never a `Badge`. Pop-ups are routes;
  inside an overlay shallower is `replace`, deeper `push`. Q3.17, Q3.213.
- **Nothing in `router.ts`'s module body may throw**: a bare `decodeURIComponent` on a lone
  `%` throws `URIError`; `decodeSegment` returns the segment as written, falling to home.
  `sessionPath`/`newPath` always `encodeURIComponent`.
- **Session data never routes through the control plane.** One bearer credential (session
  token, or a stored API key) goes only to the control-plane origin, which mints the
  per-machine token a daemon or relay sees. Never a cookie: `src/cors.ts` answers `*`
  without `Access-Control-Allow-Credentials`.
- **Below `lg` navigation animates**: `announce` in `router.ts` wraps
  `document.startViewTransition` and writes `data-nav` for `index.css`'s
  `nav-enter`/`nav-under`; direction is `nav.ts`'s pure `navMove` (none for session →
  session; a pop-up moves the sheet). Not when nothing moves, without
  `startViewTransition`, or under `prefers-reduced-motion`. Only the navigation that wrote
  `data-nav` clears it. `@media` adds no specificity: key snapshot rules on
  `:root[data-nav…]`. Q3.445.
- **Sheets**: `section-push`/`pop` slide the body; `sheet-swap` cross-dissolves pop-ups,
  tested before depths; `sheet-close` drops the panel. Opening is CSS
  (`animate-sheet sm:animate-rise`). `view-transition-name` does not nest: the sliding pane
  paints `bg-surface`, a closing sheet gives the name back. Q3.442, Q3.444.
- **Waking runs one `resume()`** (`store.ts`): tokens, routes, sessions, sockets, per
  machine independently; replay exactly-once off `lastAppliedSeq`. `runResume` promotes
  `loading` → `ready` when the listing succeeds (rows or not), only upwards, and fires
  `refreshMe()`. Q3.97, Q3.703.

**Machine rows.** The id shows only on ambiguous names (`ambiguousNames`;
`PUT /v1/machines/:id/grants` collides, `resolveMachineRef` picks the owned one). One badge,
ranked state · `this device` · `shared`; `shared` is never a subline. `this device` is
`AppState.localMachineId`, never `route.kind === "local"` (`setLocalOff`). The label is the
host name; "local" is never stored. Q3.543, Q7.139. `enrolledBy` has its own subline, never a
badge or a clause on `standing`; `enrolledByText` is that string or `null`. Q1.637.

**Systems live inside a machine**: `/settings/machines/:machineId/systems` (Sign-ins),
`…/systems/:systemId` (Q3.686), `…/routing-key`, via `parseSettingsRoute`. ◀ walks one level
up; a stale address falls to the index, unredirected. Configuring is outside the ownership
gate: rename and retire are the registry's (owner only), signing in the daemon's under
`session:write`. Q3.415.

**A head spanning a section rail names the pop-up; the pane names the screen**
(`settingsPaneTitle`, withdrawn with `up.withinNav ? "sm:hidden" : ""`). A railless sheet
inverts it (Q3.473). The `<h1>` holds one unconditional text node (`aria-labelledby`). Q3.427.

**Creating a session asks machine, agent, nickname, folder**, never worktree or first
prompt. Q3.86, Q3.87, Q3.677. **Not built:** a machine-sharing UI (`cpctl share`); a changes
screen (`GET /sessions/:id/changes` never called). It polls `GET /sessions` per machine and
holds sockets for the three most recent sessions.

**Every settings-row confirmation is `TwoStep`** (Q3.552): `grep -c '<TwoStep'` over
`ui/settings/*.tsx` and `AgentBuilder.tsx` is sixteen, two each in `MachineLimitPanel` and
`AgentsPanel`, per file in `webcheck`. Revoking your own API key (`KeysSection`) is one
tap, its one consequence the `this browser` row's (`thisBrowsersKey`), never under a
session credential (Q3.219, Q3.545, Q3.546). Registration (`ServerSection`) is a
`SwitchRow` in a `TwoStep`: only widening authority is confirmed (Q3.220, Q3.686). Removing
an assembled agent wears no `danger` (`agent-strip.md`). Every confirmation names its
subject. The first tap swaps the row's buttons for the question and two answers, Cancel last
in the same pixels (`setConfirming(true)` synchronous, `.tap` no double-tap delay): a
stray second tap undoes. State is per row. Q3.218. `TwoStep` owns Cancel (`plain`, never
`primary`) and the wait (`twoStepAct`: closes on the 200, stands on failure); the site
passes `armed`/`onArm`, `question`, `rest`.

**Everything else on a settings row is behind one kebab**; a confirmation leaves the menu
for the row. No "API keys" entry (Q1.631 supersedes Q3.217, `adminRevokeKey`):
`DELETE /v1/me/keys/:keyId` writes `revoked_at`, admins never see others' keys. Q3.216.

**`ui/overlay.ts` is the modal arbiter**: a LIFO layer stack, one capture-phase listener
installed lazily in `push()`, the `inert` refcount on `#root`, and `LAYER` (z-order as full
class strings). `AskCard`, `Dropdown`, `SessionMenu`, `Sheet` participate; `keyboard.ts`
binds Escape on `window` and acts only where unclaimed. Typing beats every layer
(`isTypingInto`); otherwise the newest layer owns Escape and stops propagation,
`stop === (dismiss !== null)` asserted over generated stacks. Q3.214. Bare letters:
`shortcutsEnabled` blocks only a `sheet`; `decisionShortcutsEnabled` blocks every layer but
the card's own `ask` (`layers.length === 0` is wrong: the card registers itself). Q3.215.

**A widget role is a behaviour promise**: `listNavKey`/`nextOptionIndex` in `keys.ts`
(pure), `useListKeys` the DOM half. Listener on the panel, never `window`; `listNavKey`
returns `null` for Escape; focus to the `aria-selected` row, then back to the trigger
(`triggerIn`, Q3.684). Not `AgentConfigBar`'s hand-rolled panels.

## Layout (under `packages/web/src/`)

| File | Holds |
|---|---|
| `settings.ts` | Not the guard (`requireAdmin` is). `SECTION_SPECS` is draw order; `navRows` heads a group once, on its first visible row |
| `ui/Sheet.tsx` | One element (`OverlaySheet`) serves all, so two cross-dissolve (Q3.484); `sheetTitle`/`sheetUpLabel` decide the head, ◀ only when railless (Q3.432, Q3.473). Several screens draw bars in `SHEET_BODY` via `SHEET_SCREEN` (Q3.472). `SHEET_PANEL` is a definite height, never `max-h`; `SHEET_BODY` a flex column; both pinned. Q3.223 |
| `ui/MenuDrawer.tsx` | The foot draws the build; `<Mark` pinned absent |
| `ui/settings/` | Account, Devices, API keys, Machines, Logs, then "Admin": Server, Email, Users (`adminOnly`); Logs only where the shell runs a daemon (Q3.543, Q3.687). At `sm`+ pane and rail use `DEFAULT_SECTION` (never `adminOnly`), never fed to `settingsUp`. `EmailSection` keeps no delivery log (Q3.225). `LogsSection` alone lists program output: this app's daemon, a sentence for a `foreign` one (Q7.140). Server and Email call `store.refreshConfig()` beside `setAnswer`. A loading list draws one `SkeletonRow` (Q3.548, Q3.544). Forms and secrets are leaves (`SettingsLeaf`, Q3.549); keys a `KeyTable` |

`webcheck`'s own `tsconfig.check.json` is the only place `@types/node` and the DOM lib
coexist; the NodeNext root cannot type-check this package. Every pure function it imports
must stay assertable.

**Bounds.** 3 live sockets (LRU); 16 MiB per session (`MAX_TRANSCRIPT_BYTES`); history pages
of 5000, a failed page retried over 37.5s, then `attachWanted` re-drives. 60 sessions per
machine per poll (why `listRank` puts pinned above live). 4s list poll, re-probes
paced by `reach.md`, 1.5s reachability probe; token refresh at `exp − 90s`, socket
rotation at `exp − 60s`. 15s per request; process-spawning routes get daemon chain + 30s, at
least 90s, `/prompt` always, never keyed on session state. `POST /sessions/:id/cancel` is
not one, pinned absent. Change `docs/DECISIONS.md`'s Bounds table first. Q3.226
