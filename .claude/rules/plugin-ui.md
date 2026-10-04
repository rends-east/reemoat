---
paths:
  - packages/web/src/plugins.ts
  - packages/web/src/catalogue.ts
  - packages/web/src/market.ts
  - packages/web/src/nav.ts
  - packages/web/src/install.ts
  - packages/web/src/pane.ts
  - packages/web/src/pluginArchive.ts
  - packages/web/src/ui/PluginView.tsx
  - packages/web/src/ui/PluginScreen.tsx
  - packages/web/src/ui/PluginConsent.tsx
  - packages/web/src/ui/plugins/*
  - packages/web/src/ui/settings/PluginsPanel.tsx
  - packages/web/src/ui/settings/MachinePluginsSection.tsx
---

**The browser's half**: what it draws, what it refuses to draw, where a plugin is
installed from, what somebody agreed to. `plugins.md` is the daemon's half and owns the
view vocabulary (tones, `PluginOpen`). Under all of it: the browser executes nothing a
plugin author wrote; a plugin sends a description and this app draws it. Q1.613.

## Drawing

- **Every narrowing in `plugins.ts` fails open** (`compatibility.md` rule 2): an unknown
  block is dropped, an unknown field kind becomes a text input that still round-trips,
  nothing throws. Q3.448.
- **A clamp is said out loud, and a substitution is a clamp.** `ClampedView` carries
  `clamped` (too large) and `substituted` (not a shape this daemon knows: an unrecognised
  `kind`, a field with no `key`, a form with no `action`), or fail-open hides the
  author's mistake. An absent `kind` is a default, not a substitution.
- **Nothing is drawn before the plugin has answered**: no skeleton, no optimistic row, no
  locally applied action. Q3.449.
- **`refreshMs` is spent only while somebody is looking**: stopped on `document.hidden`
  and when the sheet closes. A refresh never blanks the view or replaces it with an
  error; a failed tick is silent. A settings pane is never refreshed. Q3.451.
- The launcher is in the account menu, never in the session list.
- **Plugin rows in the session menu sit in their own band above Resume and Stop**, each
  naming its plugin; Stop is last at every install. Title and plugin name are two
  elements so the name gives way first. Q3.461.
- A field's `help` sits outside its `<label>`, or every word of it opens the control.
- **A plugin's `select` is `Dropdown`, never a native `<select>`**: the field variant,
  named by a `Field` label beside it (Q3.684), drawing a value outside the options as
  itself. `webcheck` asserts the element's absence across `src/`, comments stripped.
  Q3.463.
- **A settings pane is narrower than a screen** (`text`/`notice`/`form`; a box, a switch,
  a dropdown), and the browser narrows too: an action's answer arrives under an id that
  never says which pane pressed it, so only the component drawing the pane can.
  `password` becoming a visible box is intended — `plugin_data` is plaintext. `notice` is
  load-bearing (a plugin with no screen has no other channel for a failure), so its tone
  is asserted on both sides. `open` lives on a row, so a settings pane links nowhere and
  its links become prose. Q3.460.
- Market icons are `<img src>`, never markup. `icon: null` is common; the fallback is the
  ordinary case.

## Where each thing lives

- **A plugin's settings live on the plugin's page; the settings sheet links out.** The
  page knows which machines the plugin is on and asks over those, never through a
  machine dropdown. Per machine stays only what cannot be elsewhere — what is installed,
  the switch, a failure, a file handed to this daemon — on the machine's Plugins screen,
  every row a link to the plugin's page, with no scope prose (Q3.687). Installing from a
  file is a leaf screen holding the consent. There is no `…/plugins/:pluginId` leaf; the
  address parses to the machine's Plugins list, and a settings route has no `plugin`
  field — `webcheck` builds its fixtures through `parseSettingsRoute`, since `as never`
  lets a literal keep a dead key and pass. The plugin's screen is
  `/p/:machineId/:pluginId`. Q3.447, Q3.459, Q3.686.
- **Settings are a screen of their own**, one push deep, ◀ back to the plugin; the head
  says *settings* where the entry head puts a version. Q3.462.
- **The way in is the bulk bar's Settings, and the scope rides the URL**:
  `/plugins/p/:id/settings/:m1/:m2…`, one segment per machine, never comma-joined
  (`encodeURIComponent` does not escape a comma). Empty is the entry page, never "all
  machines". The parser dedupes and drops empty segments and does not sort. The pane
  states the scope on a `sticky` line, always. Q7.108.
- **Settings are enabled only where every selected machine can take them**: it is a
  navigation, unlike the Install, Update and Remove fan-outs. `settingsBlockFor` is not
  `skipReasonFor` (installing is `machine:admin`, reading a pane `session:read`).
  `not_installed` ranks below `no_scope` and `unreachable`, because `fetchPlugins`
  swallows every failure into an empty list.
- **One form goes to several machines only where they agree on its shape** (`pane.ts`,
  separate because it refuses rather than failing open). Same shape and values → seed
  it; same shape, different values → blank, with a red line naming the keys that
  differed; different shape → no form, machines grouped, each group a link to its own
  scope. Values are compared after `seedForm` normalisation. The signature is the action
  id plus the sorted `(key, kind)` pairs; labels, order and `options` are excluded (the
  last a named hole). Every machine handed in is a target or is named; identical blocks
  collapse.
- The plugin's name is drawn at every width; `marketUpWithinNav` withdraws only the ◀
  at `sm`+.
- **The market is a third pop-up, `/plugins`, off the profile menu**, at Settings' rank.
  It owns the questions spanning machines — where is this plugin, how is it set up —
  answered with checkboxes, never a machine dropdown. Q3.457, Q3.459.
- **Coming from the settings sheet is a crossing, and `under` cannot answer it.**
  `underFor` carries the drawn-over path forward (so ✕ closes onto a screen). `origin`
  sits beside `under` in `history.state`, per entry so it survives Back, Forward and a
  reload, and `marketUpFrom` consults it at exactly one depth, an entry's. A tab still
  leaves the pop-up; settings walk to their own plugin first, one level at a time. A
  field added to `history.state` must degrade to the previous behaviour when absent
  (`null` is `marketUp`'s answer). `originFor` and `overlayKind` live in `nav.ts`, never
  `router.ts`, which reads `window.location` at module load so nothing offline imports
  it. `overlayKind` compares a segment, never a prefix.
- `isSheet` and `isOverlayPath` hold the same set.

## What somebody agreed to

- **Nothing is sent until somebody has read what the plugin asks for**; a disclosure
  after install is not consent. The archive is read twice, in two languages, unshared
  (`packages/web` may not import `src/`): `pluginArchive.ts` walks tar.gz and zip in the
  browser, bounded at the daemon's unpacked ceiling and DOM-free; `pnpm client plugin
  install` unpacks with the daemon's hardened path, prints the same list and waits on a
  TTY (`--yes`; a non-interactive stdin proceeds).
- **Neither reader validates or guesses.** They read leniently and the daemon refuses on
  arrival. An unreadable archive says so, and the way past is a separate, named press,
  never an outright refusal.
- `contributes.hooks` is disclosed beside the scopes, not with the contributions: a
  hooks-only plugin asks no scope and still receives every session's title, agent,
  workspace and every permission raised.
- An unknown scope falls through to its raw identifier. `PLUGIN_SCOPE_TEXT` is
  exhaustive over `PluginScope` (adding one is a compile error), read through
  `Record<string, string>` for a manifest's strings.
- `PluginConsent.tsx` is the disclosure in one copy, drawn by both ways in.

## The machine table: a draft of a fleet

- **"All machines" is a snapshot, never a standing policy**: ticking it ticks the boxes
  below before anything is sent. Q7.42.
- **The rows are a table, the boxes a selection, and one press acts**: a fixed-height
  scroller, search and filter above it, a bar of four below. Q3.458.
  - Only a removal is confirmed, and only in the bar, ending with Cancel (it takes
    `plugin_data`). A row draws no removal: `drawnActs` narrows `rowActs`, and the bar
    reads the wider answer. Everything a row draws is undone by something else on it.
  - `rowActs` and `bulkEnabled` are pure and swept (`draftAct`'s reason), and the bar's
    counts derive from `rowActs`, so the bar cannot offer what the rows do not. All four
    `skipReasonFor` states, and a row with a request out, offer nothing.
  - A hidden row stays selected, and `selectionLine` says so.
  - Row icons are `size="lg"`, never `sm`: `sm` hit areas overlap and the later,
    destructive one wins.
    - The row is a `<div>` with a `<label htmlFor>`, never wrapped in a `<label>`, which
    may hold no `<button>`.
  - Epochs are per machine, never act-wide.
  - The scroller carries no `overscroll-contain`; its box is a definite height, 3.5 rows
    at every fleet size. Search, select-all and filter sit inside that box above the
    scroller, `shrink-0`.
  - The one line that changes is inside the table, so nothing it holds moves the bar;
    the blocker wins over the count.
  - An install never switches a plugin on and an update inherits the switch;
    `installedSubline` says so on the row.
- The fan-out is `act` in `MachineInstalls.tsx`, inline rather than a hook: concurrent
  across machines, serial within one, `plugin_busy` retried once and nothing else.
- **A fleet install is cancellable, and the signal is the caller's**: `InstallAct` takes
  it as its fourth argument. A two-parameter closure is silently assignable to it, so
  arity is not checked for you. The guard is per request (`controller.signal.aborted`),
  never an act-wide flag; the Cancel is drawn from what the act holds. `webcheck` asserts
  linkage, not presence.
- An import carries its archive's version (`available`), or `isBehind` is false on every
  row and Remove becomes the only route to a newer copy.

## The catalogue: the one client that fails closed

- **`catalogue.ts` fails closed**, alone in this client: a half-read entry is a
  half-read permission list. An unknown schema draws "update the app"; an empty catalogue
  is `ok`. `sha256Seen` is shown, never a gate (GitHub tarballs are not byte-stable; the
  pin is the commit). **Closed means a required field missing or wrong-typed, never an
  unknown one**; `webcheck` pins that tolerance at all three depths. `compareVersions` is
  numeric.
- **Every address in an entry is built from the pin.** `repo` is held to
  `src/plugins/source.ts`'s own expression beside `commit`. `manifestRaw` is derived, and
  a divergent one drops the entry: its bytes are the permission list, and
  `consentGap`/`consentBroken` compare only scopes, `net` and hooks, never `id`, `name`,
  `version`, `description` or the contributions. `browse` and `manifest` are `https` on
  `github.com` or fall back to the derivation; an `icon` off `raw.githubusercontent.com`
  becomes `null`. Parsed with `new URL`, never prefix-matched
  (`https://github.com@evil.example/` is `evil.example`). This drops a present,
  well-typed value shown wrong about the pin, which is not refusing an unknown field.
- **Fetched with the browser's own cache only**: 15 s, no credential. `ETag` is
  unreadable from script and `If-None-Match` would preflight, so hand-rolled
  revalidation fails silently as a 200. No `stale-while-revalidate`, so a withdrawal
  lands within the minute.
- **Anything this page fetches directly owes the shell's two origins**:
  `tauri://localhost` on macOS and Linux, `http://tauri.localhost` on Windows and
  Android. `connect-src` is only half of a cross-origin read; the other is the server's
  CORS. The daemon and relay answer `*` (`native-shell.md`). The catalogue service sends
  `access-control-allow-origin` only for `https://app.<domain>`, which no longer exists,
  so the market fails with `Load failed` (a thrown fetch, so the sentence names no code).
  The remedy is the service's `PLUGINS_ALLOWED_ORIGINS`, set per stack.
- **`catalogue.ts` mirrors `services/plugins/src/catalogue.ts`** in the private
  `rends-east/reemoat-prod`; never import across. The manifest types mirror
  `src/plugins/protocol.ts`, never the service's copy. `webcheck` asserts
  `client ⊆ service` where both are on disk: this side may lag (`readCatalogue`
  tolerates unknown fields) but may not declare a field the service does not send, since
  `readOne` fails closed and the whole market goes dark. Where the other repository is
  absent (every CI run) it prints a skip naming the file. Both halves are driven.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/plugins.ts` | Every client decision about a plugin: the fail-open narrowings, `pluginFailure`, `pluginPath`, which plugins offer a screen or a session action. DOM-free |
| `packages/web/src/market.ts` | Which plugins screen a URL names; pure, its own module for `settings.ts`'s reason |
| `packages/web/src/install.ts` | `planTargets` as a partition, `skipReasonFor` by remedy, `settingsBlockFor` on a different scope, `rowActs`/`bulkEnabled`, every sentence the table draws |
| `packages/web/src/ui/PluginView.tsx` | The five blocks, drawn with `bits.tsx` |
| `packages/web/src/ui/PluginScreen.tsx` | The route-backed sheet at `/p/:machineId/:pluginId` |
| `packages/web/src/ui/settings/PluginsPanel.tsx` | What this machine has, and the file import. Each row links to the plugin's page; its acts sit behind one kebab. No settings pane and no scope prose; `webcheck` reads the file to keep both gone |
| `packages/web/src/ui/plugins/` | The pop-up: two tabs, the market, one entry, the machine table. `PluginSettings.tsx` is one plugin's settings on the machines the URL names |
