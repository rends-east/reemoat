---
paths:
  - src/plugins/*
  - plugins/*
  - packages/web/src/plugins.ts
  - packages/web/src/ui/PluginView.tsx
  - packages/web/src/ui/PluginScreen.tsx
  - packages/web/src/ui/settings/PluginsPanel.tsx
  - packages/web/src/ui/settings/MachinePluginsSection.tsx
  - packages/web/src/ui/SessionBrowser.tsx
  - packages/web/src/ui/SessionMenu.tsx
---

## Commands

```bash
pnpm client plugins                     # what is installed, and what each may reach
pnpm client plugin install <archive>    # install *or* update — one verb; the manifest says which
pnpm client plugin remove <id>          # uninstall, and drop everything it kept
pnpm client plugin enable <id> | disable <id>
pnpm client plugin view <id> [screen|settings]   # what it would draw, as JSON

tar -czf board.tgz -C plugins/board .   # the demo plugin, packaged
```

`docs/PLUGINS.md` is the plugin *author's* document; this file is the rules for
changing the subsystem. `REEMOAT_PLUGINS=0` switches it off on a machine, and
`REEMOAT_PLUGIN_ROOT` moves where it lives.

**The api range is `PLUGIN_API_MIN_VERSION`…`PLUGIN_API_VERSION`, and v2 moved the
ceiling only.** `open`, `refreshMs` and `tone` arrived there; a plugin declaring
`1` still installs and runs untouched, and one that *needs* the new fields declares
`2` and is refused by an older daemon with a sentence rather than losing its
navigation silently. That is the accept-both step `compatibility.md` prescribes,
performed rather than described.

**Daemons first, then the control plane.** `compatibility.md`'s rule — whoever has
to answer ships first — and for this subsystem that is the daemon, because the web
client is what calls `GET /plugins`. A control plane deployed ahead of the daemons
hands every user a Plugins screen saying *"update your machine"* until they do,
for no gain. Nothing forces the other order here: the relay protocol did not move,
`CP_SCHEMA_VERSION` did not move, and **the control plane's image never reaches
`src/plugins`** — its deploy for this release is the web client and nothing else.
Installing plugins before the UI exists is not merely allowed but useful: the
hooks start writing, so the first screen anybody opens is already populated.
Q4.105.

## Invariants

**A plugin is one artifact, installed on a machine**

- **The two halves ship together, and that is what makes the skew irrelevant.**
  The web client rides the control plane's image and is replaced weekly; a daemon
  changes when its owner runs `deploy.sh`. A plugin whose server and screens
  arrived separately would have to reason about that. One archive cannot, so the
  UI is a *description* the server half returns rather than code the browser
  loads. Q4.103.
- **No plugin code runs in the browser, and that is the only hard boundary this
  subsystem has.** The origin holding `reemoat.credential` executes nothing a
  plugin author wrote — no CSP to widen, no sandboxed frame to get right, no
  bridge protocol to version. Everything else here is hygiene by comparison. The
  cost is stated rather than hidden: a plugin screen is a list, a form, columns
  and text, and never a canvas. Q1.613.
- **Four contribution points, and the set is closed**: a screen, a settings pane,
  an action on a session's menu, and server-side hooks. The client is shaped
  around *does anything anywhere need me*, and the signals answering it are
  computed by subtraction (`waitingFloor`) — so a contribution able to insert rows
  into the session list would open a hole nothing else can see. A transcript card
  and a slash command are recorded non-goals with their seams named
  (`renderEvent`, `buildCommands`). Q3.446.
- **The control plane hosts nothing.** It has no sessions and no files, and its
  image is rebuilt by a release — "installing" there would be a deploy. Q4.104.

**Authorization has two axes and neither implies the other**

- **A route's scope is the caller's; `manifest.scopes` is the plugin's.** A
  read-only grant may look at a plugin's screen and press nothing on it;
  installing needs `machine:admin`. The manifest is the *only* authority inside a
  hook, where nobody called anything. `daemoncheck` drives both. Q1.614.
- **The scope table is hygiene, not a fence, and the comment saying so must not be
  removed.** The plugin is a child process running as this uid and can
  `import("node:fs")`. What the table buys: the blast radius is named, shown at
  install, and refused when exceeded — which catches the mistake, not the
  attacker. Exactly the standing `agentEnv()`'s strip has. Q1.612.
- **Every method needs an entry in `SCOPE_OF`, and one added without it is
  reachable by everybody.** `daemoncheck` sweeps every method against a manifest
  declaring nothing rather than asserting them one at a time, so a new method
  with no entry fails there rather than in the fleet. Q1.614.
- **A refused scope is reported as well as refused.** A plugin exceeding what it
  told an operator it needed is invisible from its own screens, so it goes to
  `onWarning`. Same for a host it tried to reach and did not declare.

**`src/` now holds two `fetch` calls, and both are named**

- `enroll.ts`, and `net.fetch` made on a plugin's own behalf. The property that
  mattered is unchanged in substance — the daemon still asks the control plane
  nothing, and this one is never on a start path, never on a session path, and
  only ever to a host somebody wrote into a manifest and approved. But the
  *number* is two and both are written down, because a count nobody restates is a
  count that becomes three. Q1.615.
- **A plugin registry to poll would be the third**, and would make a control-plane
  outage able to stop an install on somebody's own machine. Archives arrive on a
  request a person made. Nothing here downloads a plugin, and nothing updates one
  by itself — that is Q7.42's argument, unchanged.

**Consenting**

- **Nothing is sent until somebody has read what the plugin asks for, and the
  manifest is therefore read by the *installer* rather than by the machine.**
  `SECURITY.md` says the blast radius is named *before* somebody consents to it and
  `protocol.ts` said the scope list is "shown at install"; neither was true. The old
  flow POSTed straight from the picker — unpacked, validated, row written, plugin
  **started** — and then drew the scopes on the row of something already running,
  under copy telling the reader to check them first. A disclosure after the fact is
  not consent.
- **Which is why the archive is opened twice, in two languages, and the two are not
  shared.** `packages/web/src/pluginArchive.ts` walks tar.gz and zip in the browser;
  `pnpm client plugin install` unpacks to a temp directory with `unpackArchive` and
  `parseManifest` — the daemon's own hardened path — prints the same list and waits
  on a TTY (`--yes`, and a non-interactive stdin proceeds, because a CLI that blocked
  would break every script that installs one). `packages/web` may not import from
  `src/`, the same reason `wire.ts` is a hand mirror, so a shared reader is not
  available at any price.
- **Neither reader is a validator, and neither may guess.** They read leniently and
  the daemon refuses authoritatively on arrival — `plugins.ts`'s split for a view,
  on a third schedule. What they may not do is invent: an archive that cannot be
  read *says so*, and the way past it is a separate, named press. Refusing outright
  would make the browser a second and stricter gate that turns away plugins the
  machine would have taken.
- **`contributes.hooks` is disclosed beside the scopes, not under the
  contributions.** A plugin declaring only hooks asks for no scopes at all and is
  still sent every session's title, agent and workspace, and every permission an
  agent raises. Listing it with the screens and menu items would put the most
  surprising thing on the page in the least surprising place.
- **A scope this client has not heard of falls through to its raw identifier.**
  `PLUGIN_SCOPE_TEXT` is exhaustive over `PluginScope` so that adding a scope is a
  compile error, and it is read through `Record<string, string>` at the one place a
  manifest's own strings arrive — an undisclosed capability is the single thing this
  screen exists to prevent, so the fail-open here fails *toward* saying more.

**Installing**

- **One unpacker, two bound sets.** `unpackArchive` is the middle of
  `importArchive`, extracted rather than copied: `..` refused rather than
  normalised, `.git` refused case-folded, backslashes never translated, the
  ceiling charged against what the decompressor produced. A second implementation
  is how one of those comes to be missing from one of them — `paths.ts` already
  wrote that argument for `containedIn`. `IMPORT_LIMITS` and `PLUGIN_LIMITS` are
  the two number sets; nothing in `safeMemberPath` is parameterised, because what
  a member path may *be* does not depend on who is unpacking. Q5.102.
- **Install and update are one verb**, because the manifest is what says which.
  `replaced` on the answer is how a client learns what happened; guessing from a
  list fetched before sending is wrong for a concurrent tab.
- **A failed start puts everything back, and the tree that was there is moved
  aside rather than removed to make that true.** New directory removed, the old
  one renamed back from `.replaced-…`, row untouched, old version started again,
  refusal carrying what the child said. **The move is the whole of it**: clearing
  the destination first is correct only while the incoming version differs from
  the installed one, and reinstalling the *same* version is the documented way to
  iterate — so the destination was the running plugin's own directory, a broken
  build destroyed it, and the rollback restarted `existing` against a path that no
  longer existed. `daemoncheck` drives 0.3.0-over-0.2.0 *and* 0.2.0-over-0.2.0 for
  that reason; only the first passed before.
  The surviving plugin's restart budget is **returned** first — being stopped for
  somebody else's update is not one of its own three failures. Q5.103.
- **A build is proven whatever the switch says.** `enabled` used to gate the whole
  start-and-roll-back block, so an update to a plugin somebody had switched off was
  committed with the new code never having run — row rewritten, previous version's
  directory removed, and re-enabling it was the first anybody heard it was broken.
  It is started, and stopped again before the row is written if it is meant to stay
  off, so nothing observes the switch in the position it was only borrowed in.
- **The catch restores what the try moved.** A throw *after* `records.put` —
  a busy database, a `seed` over a registry being torn down — used to delete the
  published tree and leave the new `LivePlugin` running out of it, in `live`, with
  the row naming whichever version won. Same restore block as the start-failure path.
- **Serialised for the whole daemon** (`409 plugin_busy`), by Q7.97's argument
  verbatim: no accounting outlives the request, and the relay allows 256 streams.
- **`POST /plugins` is the third streaming route**, so it owes what the other two
  owe: its own counter, and a body cancelled on **every** refusal. The relay
  grants a stream's window on consumption, so a reader that stops parks the sender
  and the valve after that closes the whole tunnel for the machine. This gives
  Q7.62/Q7.96 a third address; it does not change what they are asking.
- **`plugin_data` is keyed on the plugin's id and never its version.** That is the
  whole of what makes an update an update. Dropped on uninstall, never on update.
  Q5.104.

**Running**

- **The plugin root is realpath'd once at open.** `containedIn` falls back to
  comparing as written when `realpath` throws — which it does for every path about
  to be created — so an unresolved root and a not-yet-existing child are in two
  namespaces and the guard refuses its own directory. Measured on macOS, where
  `/var` is a symlink: every reinstall of the same version failed `ENOTEMPTY`.
  `createWorkspace` solves it the same way. Q5.105.
- **Three remover trees now, and no two may nest** — uploads, worktrees, plugins.
  Q5.74's rule is unchanged; its *arity* changed, which is why `daemon.ts` tests
  them pairwise over a named list rather than with an `if`.
- **`PluginRuntime` is an interface with one implementation, kept as one.** It is
  the seam a sandbox would be written at, and it is what lets `daemoncheck` drive
  a start that never completes, an invocation never answered and a crash after
  `ready` — none of which is reachable by spawning a real process and hoping. No
  `kind` discriminant, for `SessionRuntime`'s reason. Q1.616.
- **`PluginScheduler` is the second seam, and it exists because the first one
  could not reach the backoff.** `now` was documented as the way "a driver ages a
  backoff without sleeping" and `scheduleRestart` used a bare `setTimeout` with
  `Math.random()`, so nothing could — a seam nothing can use is worse than none.
  Both halves go through it; the defaults are `setTimeout` and `Math.random`, so
  the fleet did not move. ⚠ **A scheduler may run its callback synchronously**,
  which is exactly what a driver substitutes, so `scheduleRestart` assigns the
  canceller only if the callback has not already fired — assigning it afterwards
  stored a canceller for a callback that had run and wedged the guard for the life
  of the plugin.
- **Every launch has a generation, and every callback is gated on its own.**
  `onExit`, `onMessage`, `ready` and the API answer path all fire arbitrarily late,
  and `this.process` means "whichever child is current *now*". Three defects came
  out of that one gap: a stale `onExit` nulled the reference to a **live**
  successor and left an unreachable node process behind; the child's call ids
  restart at 1 each launch, so child A's slow `net.fetch` resolved child B's
  `sessions.get` with an HTTP body; and pending timers from a crashed child stopped
  its healthy replacement. An answer goes to the **captured** child object, never
  to `this.process` re-read after an await.
- **`stop()` is memoised per launch, not by `??=`, and it cancels a scheduled
  restart on every call.** A plain `??=` hands back the promise of a stop that
  finished two children ago. And the cancellation may not live in `doStop`, which
  is the half the memoisation skips: the timeout escalation stops a plugin and
  *then* arms a restart, so `remove` on such a plugin cancelled nothing, dropped
  the row, and let the timer fork a child held by nothing and unreachable from
  `shutdown`. A superseding stop **chains** the one it replaces rather than
  replacing it, or `shutdown` resolves while a process is still being killed.
- **A plugin child is not `detached`, and there is no reaper.** `runner.ts` exits
  when its IPC channel closes, so a daemon that dies takes its plugins with it.
  That is the whole lifecycle story, and it is the opposite of an agent's — an
  agent needs a pid column, an `os.uptime()` fence and a reaper because
  `claude-agent-acp` spawns its own child. Q2.212.
- **`this.stop()` and never `child.stop()` on a failed start.** `stop()` is what
  sets `stopping`, which is the only thing telling `onExit` a kill we asked for
  from a crash. Killing the child directly scheduled a **restart for a plugin the
  caller was rolling back**. Q5.103.
- **Nothing on the hook path awaits into the emit path.** `SessionLog.append` is
  synchronous by contract and runs inside the agent's own RPC handler; a hook that
  blocked there would put a plugin between an agent and its transcript. Hooks are
  queued, drop-oldest past the bound, with the drops reported — a plugin quietly
  missing half its events looks exactly like a plugin with a bug in it. Q5.106.
- **A throwing session observer is reported and kept**, which is the opposite of
  what `SessionLog.append` does to a throwing listener. There a listener is one
  WebSocket; here it is a whole subsystem, and evicting it would stop every hook
  on the machine for the life of the daemon with nothing saying so. Q5.107.
- **A view is a read by contract and nothing enforces it.** `GET`, so
  `isReplayable` lets the transport repeat it. The host tells the child which kind
  of call it is; a view that writes is a bug a retry will find.
- **A plugin's state is derived on every read, never stored** —
  `ManagedSession.status`'s rule, for its reason.

**Drawing**

- **A plugin names meaning, the host picks the ink.** `PluginRowTone` is
  `ok|warn|danger` and `PluginRowAction.tone` is `plain|destructive`; neither is a
  colour. This is the standing answer to "why can a plugin not send CSS", and the
  argument is not that CSS is dangerous — the CSP already blocks the exfiltration
  it is famous for. It is that a plugin able to style *this* page can move pixels
  around the control that approves shell commands, that the app's class names would
  become a public API nothing may refactor, and that every measured decision about
  contrast and palette would stop binding. Widening the **vocabulary** is the
  supported way to answer a plugin that needs more. Q1.617.
- **A destination is one this app has, never a URL.** `PluginOpen` is a session on
  this machine or the plugin's own screen. `{url: …}` is not a shape and lands as a
  row that does not go anywhere — narrowed twice, on the daemon and again in
  `plugins.ts`, because `wire.ts` is a hand mirror and trusting the daemon's
  narrowing would be trusting a copy. A link chosen by a plugin is a phishing
  surface on the page that approves commands, and "a plugin deciding where somebody
  goes" is already refused for a session-menu action. Q3.450.
- **`refreshMs` is declared by the plugin, clamped by the host, and spent only
  while somebody is looking.** Floored at `PLUGIN_REFRESH_MIN_MS`, stopped on
  `document.hidden`, stopped when the sheet closes — so a small number cannot buy
  background work on a phone. **A refresh never blanks the view and never replaces
  it with an error**: the old one stays until the new one arrives, and a failed
  tick is silent, because a machine dropping off LTE for one tick is not news.
  A settings pane is **not** refreshed whatever it asks — it is a form somebody is
  typing into. Q3.451.

- **Every narrowing in `packages/web/src/plugins.ts` fails open.** Rule 2 of
  `compatibility.md` on a third schedule: an unknown block is dropped, an unknown
  field kind becomes a text input and still round-trips, nothing throws. The
  failure this exists to prevent is `endedWithDaemon`, which answered *no* for a
  reason it had never heard of and took the composer off screen for a live
  session. Q3.448.
- **A clamp is said out loud.** An oversized view is cut and a notice is appended,
  never silently shortened — a list cut without saying so is a list showing a
  wrong number.
- **Nothing is drawn before the plugin has answered.** No skeleton board, no
  optimistic row, no locally-applied action. A plugin's view is its assertion
  about its own state and this client holds no second copy to guess from. Q3.449.
- **The launcher is in the rail's footer and never in the list.** The rail is the
  sessions. In the footer it takes part in no ordering, no filter and no count.
- **Plugin rows in the session menu go below everything the app does itself**, and
  each names its plugin: two plugins may both offer "Move on". The rows a person
  reaches for without reading must not move because something was installed.
- **A plugin's settings live inside its machine, beside its agents**, by
  `MachineAgentsSection`'s argument: the code is on one host's disk and the data
  in one daemon's database, so a fleet-wide screen would open with a dropdown
  asking which — a screen asking a question its own copy answers. Its **screen**
  is at `/p/:machineId/:pluginId` instead, because a board is opened several times
  a day and four taps into a settings sheet is not where that goes. Q3.447.
- **`isSheet` and `isOverlayPath` must hold the same set.** They answer one
  question from two directions, and a route in one and not the other is a pop-up
  that either forgets what it was drawn over or records one while being a screen.

## Layout

| File | Holds |
|---|---|
| `src/plugins/protocol.ts` | The vocabulary that crosses to the browser: the manifest, the scopes, the five blocks, the api **range**, and `clampView`. **Imports nothing**, which is what makes `packages/web/src/wire.ts` able to mirror it |
| `src/plugins/manifest.ts` | `plugin.json`, validated by hand, refusal by refusal. Pure and takes **text** rather than a path, which is what makes every refusal reachable from `daemoncheck` with no filesystem |
| `src/plugins/runtime.ts` | Where a plugin's code runs. `PluginRuntime` with one implementation, the IPC vocabulary, and the bounds on it |
| `src/plugins/runner.ts` | What the child runs: imports `server.js`, builds `ctx`, answers exactly once. Decides nothing — every check is on the host side, because a check inside the process being checked is one it can delete |
| `src/plugins/api.ts` | The host API and the scope gate. `SCOPE_OF` is the table; the absence of a method from it is a refusal |
| `src/plugins/host.ts` | Install, update, remove, enable, the running set, the invoke path, the restart budget, and the hook fan-out |
| `src/plugins/store.ts` | `InstalledPlugin`, the two store interfaces, and `checkPluginWrite` — the quota, shared so a memory implementation refuses exactly what SQLite does |
| `plugins/board/` | The reference plugin. Uses all four contribution points, reaches nothing outside the machine, and is what `docs/PLUGINS.md` walks through |
| `packages/web/src/pluginArchive.ts` | The manifest, read out of the archive **before it is sent**. tar.gz and zip, bounded at the daemon's own unpacked ceiling, DOM-free so `webcheck` can drive it. Lenient by contract — the daemon is what refuses |
| `packages/web/src/plugins.ts` | Every decision about a plugin on the client: the fail-open narrowings, `pluginFailure`, `pluginPath`, which plugins offer a screen or a session action. DOM-free, so `webcheck` can import it |
| `packages/web/src/ui/PluginView.tsx` | The five blocks, drawn with `bits.tsx` |
| `packages/web/src/ui/PluginScreen.tsx` | The route-backed sheet at `/p/:machineId/:pluginId` |
| `packages/web/src/ui/settings/PluginsPanel.tsx` | The list, the install control, and one plugin's settings pane |

## Bounds

| | |
|---|---|
| Archive | **2 MiB** on the wire, 8 MiB unpacked, 500 entries (`PLUGIN_LIMITS`). One install at a time for the whole daemon |
| Store | 1 MiB per plugin, 64 KiB per value, 1000 keys, 200 chars per key. Counted in **bytes** (`Buffer.byteLength` against `LENGTH(CAST(value AS BLOB))`) — `.length` and SQLite's `LENGTH` are UTF-16 units and characters, and neither is what lands on disk |
| `store.entries` | A **page**, bounded by bytes rather than rows, with `more` and an `after` cursor. The lot does not fit: a plugin may keep four times what one IPC message carries |
| A view | 24 blocks, 200 rows, 8 columns, 40 fields, 40 options, 4 actions per row, 4000 chars of text, 200 of anything short. **Clamped and reported**, never refused |
| Refresh | 2 s floor, 5 min cap. Clamped **silently**, unlike a cut list — an interval nobody can see moved is not a wrong number on screen |
| IPC | 256 KiB per message (**enforced**, and a refused message settles its waiter rather than letting it time out, with `413` rather than a `502` since nothing downstream answered), 8 invocations in flight (`MAX_INFLIGHT_INVOCATIONS`, refused with `plugin_overloaded`), **16 host calls in flight the other way** (`MAX_INFLIGHT_HOST_CALLS` — the direction that had no ceiling, and the one where a method forks git), 20 lines of the child's own output kept |
| A view | `PLUGIN_VIEW_LIMITS`, applied by `fitView` **in the child, before the message is sent** — it ran in the host, one hop after the message had already been refused, so the published bound could never fire and the byte bound was the only real one. Rows are the lever because they are the only dimension a plugin's data grows without limit |
| Deadlines | 10 s to start, 10 s per call, 2 s of grace before SIGKILL. Both overridable **only** by a driver — there is no environment variable |
| Restarts | 3 per daemon life, full jitter 2s→60s. Three consecutive timeouts stops it. Switching it off and on returns the budget |
| `net.fetch` | https only, no redirects, 10 s, 1 MiB, 30 requests a minute per plugin |
| Files | 64 KiB per `files.read` |
| Hooks | 256 queued per plugin, drop-oldest, drops reported through `onWarning` |
| Manifest | 8 actions, 8 net hosts, 32 chars of id, 64 of name, 40 of an action title |

## Known gotchas

- **`fork` inherits `execArgv`, which is what makes a `.ts` runner work.** Measured
  2026-08-21 on Node 24: a parent started by `tsx` passes its loader flags on and
  the child compiles TypeScript. It also means a plugin's own `server.js` may
  today be TypeScript — that is not the contract and will not be kept.
- **`HOST` in `manifest.ts` accepts `127.0.0.1` on its own.** Four labels of digits
  is a well-formed name by that pattern, which is how an address walked past a
  check whose refusal string already said "and not an address". `ADDRESS` is the
  second half; the test is the *last* label being numeric.
- **The `net` allowlist is a spelling check, not an SSRF defence.** A name somebody
  controls can resolve anywhere, and re-resolving after the check is the classic
  rebinding race. The honest answer is the one `SECURITY.md` gives: the plugin can
  open its own socket.
- **A settings route literal now needs `plugin` as well as `agent`.** They are
  never both set — `parseSettingsRoute` is the one producer and `webcheck` asserts
  it over every shape — but a fixture missing the field reads as `undefined`, and
  `!== null` is true for that. It cost two `depthOf` assertions when the field
  arrived.
