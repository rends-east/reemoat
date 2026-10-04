---
paths:
  - src/plugins/*
  - plugins/*
  - packages/web/src/wire.ts
---

**The daemon's half**: what a plugin may do, what bounds it, how it is installed.
`plugin-ui.md` is the browser's half; `plugin-contributions.md` is the harness and
provider points. `wire.ts` is here because it hand-mirrors `src/plugins/protocol.ts`.

## Commands

```bash
pnpm client plugins                     # what is installed, and what each may reach
pnpm client plugin install <archive>    # install *or* update — one verb; the manifest says which
pnpm client plugin remove <id>          # uninstall, and drop everything it kept
pnpm client plugin enable <id> | disable <id>
pnpm client plugin view <id> [screen|settings]   # what it would draw, as JSON

tar -czf board.tgz -C plugins/board .   # the demo plugin, packaged
```

`docs/PLUGINS.md` is the author's document. `REEMOAT_CP_PLUGIN_CATALOGUE_URL` on the
control plane gives the fleet a market: env only, restart needed, because the CSP's
`connect-src` is built from it once at startup. `REEMOAT_PLUGINS=0` switches plugins off
on a machine; `REEMOAT_PLUGIN_ROOT` moves where they live.

## The api range and the ship order

`PLUGIN_API_MIN_VERSION`…`PLUGIN_API_VERSION`; the floor has never moved. A plugin
declaring `1` installs untouched; one needing a later rung declares it, and an older
daemon refuses with a sentence that does not blame the plugin (`compatibility.md`'s
accept-both step). The rung a change owes depends on which of four acts it is
(`protocol.ts` has the argument):

- **A field** (v2: `open`, `refreshMs`, `tone`): an older daemon ignores it, so a plugin
  that can live without it stays at `1`.
- **A scope** (v3: `model`): `parseManifest` refuses an unknown scope, so without the
  bump the error blames the plugin. Works only because `manifest.ts` negotiates `api`
  before reading `scopes`.
- **A method** (v4: `model.list`): `SCOPE_OF` decides at call time, so the failure would
  be `unknown_method` on a press. A new optional field (passing a model) needs no bump.
- **A contribution point** (v5): refused below the rung, not ignored.
  `plugin-contributions.md`.

**Daemons, then the control plane, then the catalogue, the last two out together.**
The daemon answers `GET /plugins` and `POST /plugins/source`; the client knows an old
daemon by the shape of its refusal, never a version. The relay protocol and
`CP_SCHEMA_VERSION` did not move, and the control plane's image never reaches
`src/plugins`. The catalogue holds its own `PLUGIN_API_VERSION` ceiling, refuses to
publish above it, and compares it against this one, with a loud skip where this side is
absent. Q4.105.

## Invariants

**What a plugin may add**

- **One archive carries both halves**, so skew is irrelevant: the UI is a description
  the server half returns. **No plugin code runs in the browser**, the one hard
  boundary here: the origin holding `reemoat.credential` executes nothing a plugin
  author wrote, so a screen is a list, a form, columns and text, never a canvas. Q4.103,
  Q1.613.
- **Six contribution points, closed**: a screen, a settings pane, a session-menu action,
  server-side hooks, a harness and a provider (the last two are
  `plugin-contributions.md`). Nothing may insert rows into the session list: where a row
  sits is its reader's alone (Q3.674). A transcript card and a slash command are
  non-goals with named seams. Q3.446.
- **The control plane hosts no plugin**: no sessions, no files, and its image is rebuilt
  by a release. Q4.104.

**Authorization has two axes, and neither implies the other**

- A route's scope is the caller's; `manifest.scopes` is the plugin's. A read-only grant
  may view a screen and press nothing; installing needs `machine:admin`. Inside a hook
  the manifest is the only authority. `daemoncheck` drives both. Q1.614.
- The scope table is hygiene, not a fence, and the comment saying so stays: the child
  runs as this uid and can `import("node:fs")`. It names the blast radius and catches the
  mistake, not the attacker — `agentEnv()`'s standing. Q1.612.
- Every method needs a `SCOPE_OF` entry; one without is reachable by everybody.
  `daemoncheck` sweeps every method against a manifest declaring nothing. Q1.614.
- A refused scope or undeclared host is reported through `onWarning`, not only refused.

**`src/` holds three `fetch` calls, all named**

- `enroll.ts`; `net.fetch` on a plugin's behalf; and `fetchArchive` in
  `src/plugins/source.ts`, reached only by `POST /plugins/source`. The daemon still asks
  the control plane nothing, and none is on a start or session path. Q1.615, Q1.620.
- The third is not a registry: the daemon knows no catalogue, polls nothing, and
  fetches once the repository and commit somebody who read the permissions hands it.
  Nothing updates a plugin by itself. It exists because `codeload.github.com` answers no
  CORS for the browser. Q7.104, Q7.42, Q7.106.
- Bounds: https, `redirect: "error"`, 30 s, one hardcoded host, a `repo`/`commit` the
  daemon validates; no part of the address comes from the caller, so the host is a real
  fence. Full 40-hex commit only (a tag moves). codeload sends no `content-length`, so
  the size bound is `unpackArchive` charging each chunk.

**Installing**

- The manifest is read by the *installer* before anything is sent; the disclosure is
  `plugin-ui.md`'s.
- **One unpacker.** `unpackArchive` is the middle of `importArchive`, extracted, not
  copied: `..` refused not normalised, `.git` refused case-folded, backslashes never
  translated, the ceiling charged against decompressor output. Nothing in
  `safeMemberPath` is parameterised. Q5.102.
- **Install and update are one verb**; `replaced` on the answer says which, never a
  list fetched before sending.
- **Two doors, one implementation**: `POST /plugins` (archive in the body) and
  `POST /plugins/source` (`{repo, commit}`), a thin front on `PluginHost.install`. Never
  a second copy of the staging / `rename` / rollback sequence.
- **`consentGap` is on the source path only, and refuses**, after `parseManifest` and
  before `ensureStarted`. The upload path keeps `consentBroken` after the fact, since
  the browser read the bytes sent. It compares `scopes`, `net` and `contributes.hooks`
  (plus `adds`, `plugin-contributions.md`), never the whole manifest, which
  `parseManifest` normalises; one direction, what was gained. Q5.111.
- **A failed start puts everything back**: new directory removed, old tree renamed back
  from `.replaced-…` (moved aside, never removed — reinstalling the same version is how
  authors iterate), row untouched, old version restarted with its restart budget
  returned first, refusal carrying the child's words. `daemoncheck` drives a different
  and the same version. Q5.103.
- **A build is proven whatever the switch says**: started, then stopped before the row
  is written if it stays off. An install never switches one on; an update inherits the
  switch.
- **The catch restores what the try moved**: a throw after `records.put` runs the same
  restore block as a failed start.
- **Serialised daemon-wide** (`409 plugin_busy`, Q7.97). A fanning-out client retries
  that once and nothing else; a `POST` is not replayable.
- **`POST /plugins` is the third streaming route**: its own counter, and the body
  cancelled on every refusal, or the parked sender closes the machine's tunnel. Q7.62,
  Q7.96.
- **`plugin_data` is keyed on the plugin's id, never its version**: dropped on uninstall,
  never on update. Q5.104.

**Running**

- The plugin root is realpath'd once at open, or `containedIn` (which compares as
  written when `realpath` throws) refuses its own children. `createWorkspace` does the
  same. Q5.105.
- Three remover trees — uploads, worktrees, plugins — and no two may nest; `daemon.ts`
  tests them pairwise over a named list. Q5.74.
- `PluginRuntime` is an interface with one implementation and stays one: the sandbox
  seam, and how `daemoncheck` drives a start that never completes, an unanswered
  invocation and a crash after `ready`. No `kind`, for `SessionRuntime`'s reason. Q1.616.
- `PluginScheduler` is the second seam: `scheduleRestart`'s timer and jitter both go
  through it, the defaults real. A scheduler may run its callback synchronously, so
  `scheduleRestart` assigns the canceller only if the callback has not already fired.
- Every launch has a generation, and every late callback (`onExit`, `onMessage`, `ready`,
  the API answer path) is gated on its own. An answer goes to the captured child, never
  to `this.process` re-read after an await (call ids restart at 1 each launch).
- `stop()` is memoised per launch, not by `??=`, and cancels a scheduled restart on every
  call, never only in `doStop` (memoisation skips it). A superseding stop chains the one
  it replaces, or `shutdown` resolves mid-kill.
- A plugin child is not `detached` and has no reaper: `runner.ts` exits when its IPC
  channel closes. Q2.212.
- On a failed start, `this.stop()`, never `child.stop()`: `stopping` is the only thing
  telling `onExit` a requested kill from a crash. Q5.103.
- **A plugin is not told about its own write.** `src/plugins/origin.ts` holds the turn
  claims, taken before `prompt` and put back if refused (`pump` appends a `turn_end`
  synchronously); a session's origin is an argument to `registry.create`. Matched on the
  id, so an update inherits the claim. Open: `session.ended` is unattributed, so a
  `sessions.create` loop over a failing `start()` is bounded only by
  `SESSION_CREATE_BURST` (`liveSessionCount` skips terminal sessions, so not
  `MAX_LIVE_SESSIONS`); closing it needs a per-plugin create budget.
- Nothing on the hook path awaits into the emit path (`SessionLog.append` is synchronous,
  inside the agent's RPC handler). Hooks are queued drop-oldest, drops reported. Q5.106.
- A throwing session observer is reported and kept, the opposite of what
  `SessionLog.append` does to a listener. Q5.107.
- A view is a read by contract (`GET`; a retry may repeat it), and nothing enforces it.
  A plugin's state is derived on every read, `ManagedSession`'s rule.

**The view vocabulary**

- **A plugin names meaning, the host picks the ink.** `PluginRowTone` is
  `ok|warn|danger` and `PluginRowAction.tone` is `plain|destructive`; neither is a
  colour. No plugin CSS (it could move pixels around the control that approves
  commands); widen the vocabulary instead. Q1.617.
- **A destination is one this app has, never a URL.** `PluginOpen` is a session on this
  machine or the plugin's own screen; `{url: …}` lands as a row that goes nowhere.
  Narrowed on the daemon and again in `plugins.ts`. Q3.450.
- `refreshMs` is declared by the plugin and clamped by the host (`PLUGIN_REFRESH_MIN_MS`);
  how the browser spends it is `plugin-ui.md`'s. Q3.451.
- **A settings pane draws less than a screen**: `text`/`notice`/`form`; a field is
  `text`, `toggle` or `select`. `clampView`/`noteClamp`/`fitView` take the surface,
  defaulting to `screen`, the wider set. An action is always `screen` here, so the
  browser narrows its answer (`plugin-ui.md`). `password` → `text` is reported as a
  substitution. Q3.460.

## Layout

Daemon side; the web files are in `plugin-ui.md`.

| File | Holds |
|---|---|
| `src/plugins/protocol.ts` | What crosses to the browser: manifest, scopes, the five blocks, the api range, `clampView`. Imports nothing, so `wire.ts` can mirror it |
| `src/plugins/manifest.ts` | `plugin.json`, validated by hand; pure, takes text, so `daemoncheck` reaches every refusal |
| `src/plugins/runtime.ts` | `PluginRuntime`, the IPC vocabulary and its bounds |
| `src/plugins/runner.ts` | The child: imports `server.js`, builds `ctx`, answers once. Decides nothing; every check is host-side |
| `src/plugins/api.ts` | The host API and the scope gate; absence from `SCOPE_OF` is a refusal |
| `src/plugins/host.ts` | Install, update, remove, enable, invoke, restarts, the hook fan-out |
| `src/plugins/store.ts` | `InstalledPlugin`, the store interfaces, `checkPluginWrite` (shared so memory refuses what SQLite does) |
| `src/plugins/source.ts` | The `{repo, commit}` validator, the address built here, `consentGap`, the third `fetch`; all but the fetch pure |
| `plugins/board/` | The reference for the four drawn points; reaches nothing off the machine; `docs/PLUGINS.md` walks it |

## Bounds

| | |
|---|---|
| Archive | 2 MiB on the wire, 8 MiB unpacked, 500 entries (`PLUGIN_LIMITS`). One install at a time daemon-wide |
| Fetching one | 30 s, https, no redirects, one host; the size bound is `unpackArchive`'s, per chunk |
| Store | 1 MiB per plugin, 64 KiB per value, 1000 keys, 200 chars per key, counted in bytes (`Buffer.byteLength` against `LENGTH(CAST(value AS BLOB))`), never `.length` or `LENGTH` |
| `store.entries` | A page bounded by bytes, with `more` and an `after` cursor |
| A view | `PLUGIN_VIEW_LIMITS`: 24 blocks, 200 rows, 8 columns, 40 fields, 40 options, 4 actions/row, 4000 chars of text, 200 of anything short. Clamped and reported, never refused, by `fitView` in the child before the message is sent |
| Refresh | 2 s floor, 5 min cap, clamped silently |
| IPC | 256 KiB per message (a refused one settles its waiter: `413`, not `502`); 8 invocations in flight (`plugin_overloaded`); 16 host calls the other way (`MAX_INFLIGHT_HOST_CALLS`); 20 lines of child output kept |
| Deadlines | 10 s to start, 10 s per call, 2 s grace before SIGKILL; only a driver overrides them, no env var |
| Restarts | 3 per daemon life, full jitter 2 s→60 s. Three consecutive timeouts stop it. Off and on returns the budget |
| `net.fetch` | https only, no redirects, 10 s, 64 KiB, 30 requests a minute per plugin. The assembled answer is measured again before it is sent |
| Files | 64 KiB per `files.read` |
| Hooks | 256 queued per plugin, drop-oldest, drops through `onWarning` |
| Manifest | 8 actions, 8 net hosts, 32 chars of id, 64 of name, 40 of an action title |

## Known gotchas

- `fork` inherits `execArgv`, which is what makes a `.ts` runner work under `tsx`; a
  plugin's `server.js` may be TypeScript today, which is not the contract.
- `HOST` in `manifest.ts` accepts `127.0.0.1` on its own; `ADDRESS` is the second half,
  testing whether the last label is numeric.
- **A model is chosen between the handshake and the prompt**: `ask(agent, prompt,
  model?)` sets ACP's `session/set_config_option` (`category: "model"`) after
  `session/new`. Omitted, `null` and `""` all mean the agent's default. `model.list`
  starts the agent (no prompt), is cached `MODELS_TTL_MS`, and needs the `model` scope,
  not `sessions.read`, because it spawns; never read off a live session's config
  (`dedupeAliasChoices`, Q2.45). Validated against the agent at use, never the cache.
  Q3.464.
- The `net` allowlist is a spelling check, not an SSRF defence; the plugin can open its
  own socket (`SECURITY.md`).
