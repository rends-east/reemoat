---
paths:
  - src/plugins/*
  - plugins/*
  - packages/web/src/wire.ts
---

**The daemon's half.** What a plugin may do, what bounds it, how it is installed,
and who is told about what. `plugin-ui.md` is the browser's half — what it draws,
what it refuses to draw, and where a plugin is installed *from* — and it arrives
on those files instead. They were one file until it hit its own size ceiling twice
in a day, which is the signal that budget exists to give.

`wire.ts` is here rather than there because it is the **mirror** of
`src/plugins/protocol.ts`: what it holds is this side's vocabulary, copied by hand,
and the rule about keeping the two in step is a rule about the original.

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
changing the subsystem. `REEMOAT_CP_PLUGIN_CATALOGUE_URL` on the **control plane**
gives the fleet a market — env only, needing a restart, because the CSP is built
from it once at startup and a database-owned value could name a catalogue the
document's own `connect-src` refuses to reach. `REEMOAT_PLUGINS=0` switches it off on a machine, and
`REEMOAT_PLUGIN_ROOT` moves where it lives.

**The api range is `PLUGIN_API_MIN_VERSION`…`PLUGIN_API_VERSION`, the floor has never
moved, and the ceiling is at 4.** A plugin declaring `1` still installs untouched;
one that *needs* what a later rung added declares that rung and is refused by an
older daemon with a sentence rather than failing in a way that blames it — the
accept-both step `compatibility.md` prescribes, performed rather than described.
**Each rung moved for a different reason, and the difference is what says whether a
bump is owed at all** — `protocol.ts` carries the argument in full:

- **v2, new *fields*** (`open`, `refreshMs`, `tone`): an older daemon ignores an
  unknown field, so a plugin that can live without them stays at `1`.
- **v3, a new *scope*** (`model`): `parseManifest` refuses an unknown scope, so
  without the bump an un-updated daemon says `unknown scope "model"` — i.e. *the
  plugin is wrong*. ⚠ Only works because `api` is negotiated **before** `scopes`
  are read; reversing those in `manifest.ts` buys the bump nothing.
- **v4, a new *method*** (`model.list`): `SCOPE_OF` decides at call time, so the
  failure would be an `unknown_method` when somebody presses something. Passing a
  model needs no bump — the field is optional.

**Adding a field is not the same act as adding a scope or a method**, and the rung a
change owes follows from which of the three it is.

**Daemons first, then the control plane.** `compatibility.md`'s rule — whoever has
to answer ships first — and here that is the daemon, because the web client is what
calls `GET /plugins` and `POST /plugins/source`. A control plane in front hands every
user a market whose every install answers 404 until they update, for no gain, and the
client knows an old daemon by the **shape of its refusal** rather than by a version.
Nothing forces the other order: the relay protocol did not move,
`CP_SCHEMA_VERSION` did not move, and **the control plane's image never reaches
`src/plugins`**. Q4.105.

**And the catalogue ships last, behind the fleet.** It holds a
`PLUGIN_API_VERSION` ceiling of its own and refuses to publish above it, so the two
are one decision and **must land together**. The skews are not symmetric: a
catalogue *ahead* publishes plugins no daemon will install — a failure on somebody
else's machine, about somebody else's plugin — while a catalogue *behind* refuses
to publish a plugin every daemon would run, which fails on the author's own
terminal and breaks nothing already installed. Neither repository can check the
other, so what stands in for a check is the service mirroring this constant and
comparing, with a loud skip where this side is absent. Q4.105.

## Invariants

**A plugin is one artifact, installed on a machine**

- **The two halves ship together, which is what makes the skew irrelevant.** The web
  client rides the control plane's image and is replaced weekly; a daemon changes
  when its owner runs `deploy.sh`. A plugin whose halves arrived separately would
  have to reason about that; one archive cannot, so the UI is a *description* the
  server half returns rather than code the browser loads. Q4.103.
- **No plugin code runs in the browser, and that is the only hard boundary this
  subsystem has.** The origin holding `reemoat.credential` executes nothing a plugin
  author wrote — no CSP to widen, no sandboxed frame, no bridge protocol to version.
  Everything else here is hygiene by comparison. The cost is stated rather than
  hidden: a plugin screen is a list, a form, columns and text, never a canvas.
  Q1.613.
- **Four contribution points, and the set is closed**: a screen, a settings pane,
  an action on a session's menu, and server-side hooks. The client is shaped around
  *does anything anywhere need me*, and the signals answering it are computed by
  subtraction (`waitingFloor`) — so a contribution able to insert rows into the
  session list would open a hole nothing else can see. A transcript card and a slash
  command are non-goals with their seams named (`renderEvent`, `buildCommands`).
  Q3.446.
- **The control plane hosts nothing.** No sessions, no files, and its image is
  rebuilt by a release — "installing" there would be a deploy. Q4.104.

**Authorization has two axes and neither implies the other**

- **A route's scope is the caller's; `manifest.scopes` is the plugin's.** A
  read-only grant may look at a plugin's screen and press nothing on it; installing
  needs `machine:admin`. The manifest is the *only* authority inside a hook, where
  nobody called anything. `daemoncheck` drives both. Q1.614.
- **The scope table is hygiene, not a fence, and the comment saying so must not be
  removed.** The plugin is a child process running as this uid and can
  `import("node:fs")`. What it buys: the blast radius is named, shown at install,
  and refused when exceeded — which catches the mistake, not the attacker. Exactly
  `agentEnv()`'s standing. Q1.612.
- **Every method needs an entry in `SCOPE_OF`, and one added without it is
  reachable by everybody.** `daemoncheck` sweeps every method against a manifest
  declaring nothing rather than asserting them one at a time, so a new one fails
  there rather than in the fleet. Q1.614.
- **A refused scope is reported as well as refused**, through `onWarning`: a plugin
  exceeding what it declared is invisible from its own screens. Same for an
  undeclared host.

**`src/` now holds three `fetch` calls, and all three are named**

- `enroll.ts`; `net.fetch` on a plugin's behalf; and `fetchArchive` in
  `src/plugins/source.ts`, reached only by `POST /plugins/source`. The property that
  mattered is unchanged — the daemon still asks the control plane nothing, and none
  of the three is on a start or session path. But the *number* is three and all
  three are written down, because a count nobody restates becomes four. Q1.615,
  Q1.620.
- **The third is not a registry, and that distinction is the whole argument.**
  Q7.104 refused something to **poll** — somebody else's outage stopping an install
  on your own machine, and a channel by which code arrives on a host nobody named
  it on. This daemon does not know a catalogue exists: it is handed a repository
  and a commit by somebody who read the permissions, and fetches once. Nothing
  discovers, and **nothing updates a plugin by itself** — Q7.42, unchanged.
- **It exists because the browser cannot carry the bytes**: `codeload.github.com`
  answers CORS only for GitHub's own render host, so the fetch is refused before it
  leaves the page. Q7.106 assumed otherwise; that is what fell.
- **What bounds it**: https, `redirect: "error"`, 30s, **one hardcoded host**, and a
  `repo`/`commit` this daemon validates itself — no part of the address comes from
  the caller, which makes the host a real fence rather than the spelling check
  `net`'s allowlist honestly calls itself. **Full 40-hex commit only**: a tag moves
  under `git tag -f`, and what is pinned runs as the owner with no sandbox.
  ⚠ **codeload sends no `content-length`**, so the size bound is `unpackArchive`
  charging each chunk — a header check would bound nothing here.

**Consenting**

- **Nothing is sent until somebody has read what the plugin asks for, so the
  manifest is read by the *installer* rather than by the machine.** `SECURITY.md`
  says the blast radius is named *before* somebody consents and `protocol.ts` said
  the scope list is "shown at install"; neither was true. The old flow POSTed
  straight from the picker — unpacked, validated, row written, plugin **started** —
  then drew the scopes on the row of something already running, under copy telling
  the reader to check them first. A disclosure after the fact is not consent.
- **Which is why the archive is opened twice, in two languages, and the two are not
  shared.** `pluginArchive.ts` walks tar.gz and zip in the browser; `pnpm client
  plugin install` unpacks to a temp directory with the daemon's own hardened path,
  prints the same list and waits on a TTY (`--yes`, and a non-interactive stdin
  proceeds, or every script that installs one breaks). `packages/web` may not import
  from `src/` — `wire.ts`'s reason — so a shared reader is unavailable at any price.
- **Neither reader is a validator, and neither may guess.** They read leniently and
  the daemon refuses authoritatively on arrival. What they may not do is invent: an
  archive that cannot be read *says so*, and the way past is a separate, named
  press. Refusing outright would make the browser a stricter second gate turning
  away plugins the machine would take.
- **`contributes.hooks` is disclosed beside the scopes, not under the
  contributions.** A plugin declaring only hooks asks for no scopes and is still
  sent every session's title, agent and workspace, and every permission an agent
  raises — so listing it with the screens puts the most surprising thing on the page
  in the least surprising place.
- **A scope this client has not heard of falls through to its raw identifier.**
  `PLUGIN_SCOPE_TEXT` is exhaustive over `PluginScope` so adding one is a compile
  error, read through `Record<string, string>` where a manifest's own strings arrive
  — an undisclosed capability is the thing this screen exists to prevent, so the
  fail-open here fails *toward* saying more.

**Installing**

- **One unpacker, two bound sets.** `unpackArchive` is the middle of
  `importArchive`, extracted rather than copied: `..` refused rather than
  normalised, `.git` refused case-folded, backslashes never translated, the ceiling
  charged against what the decompressor produced. A second implementation is how one
  of those goes missing — `paths.ts` wrote that argument for `containedIn`. Nothing
  in `safeMemberPath` is parameterised: what a member path may *be* does not depend
  on who is unpacking. Q5.102.
- **Install and update are one verb**, because the manifest is what says which.
  `replaced` on the answer is how a client learns what happened; guessing from a
  list fetched before sending is wrong for a concurrent tab.
- **Two doors, one implementation.** `POST /plugins` takes the archive in the
  request; `POST /plugins/source` takes `{repo, commit}` and fetches it. The second
  is a thin front on `PluginHost.install` and must stay one — a second copy of the
  staging / `rename` / rollback sequence is how one loses the step that puts the old
  tree back, which this file already records happening once.
- **The consent check is on the *source* path only and it refuses rather than
  reports.** `consentGap` runs **after `parseManifest`, before `ensureStarted`**, so
  the plugin has not run. The upload path keeps `consentBroken` after the fact,
  which is enough there because the browser read the bytes that were sent. Q5.111.
  ⚠ **Three fields — `scopes`, `net`, `contributes.hooks` — never the manifest.**
  `parseManifest` normalises (trimmed titles, absent `description` → `null`, absent
  `contributes` → the empty block) and the catalogue publishes what it produced, so
  a field-by-field check would fire on every plugin that wrote no `contributes` —
  and an alarm that cries wolf costs more than none. One direction: what was
  *gained*.
- **A failed start puts everything back, and the tree that was there is moved aside
  rather than removed to make that true.** New directory removed, the old one
  renamed back from `.replaced-…`, row untouched, old version started again,
  refusal carrying what the child said. **The move is the whole of it**: clearing
  the destination first is correct only while the incoming version differs, and
  reinstalling the *same* version is the documented way to iterate — so the
  destination was the running plugin's own directory, a broken build destroyed it,
  and the rollback restarted `existing` against a path that was gone. `daemoncheck`
  drives 0.3.0-over-0.2.0 *and* 0.2.0-over-0.2.0; only the first passed before. The
  survivor's restart budget is **returned** first — being stopped for somebody
  else's update is not one of its own three failures. Q5.103.
- **A build is proven whatever the switch says.** `enabled` used to gate the whole
  start-and-roll-back block, so an update to a plugin somebody had switched off was
  committed with the new code never having run — and re-enabling it was the first
  anybody heard it was broken. It is started, then stopped again before the row is
  written if it is meant to stay off. **An install never switches one on and an
  update inherits the position** — a client that does not say so gets "I updated it
  and it does not work".
- **The catch restores what the try moved.** A throw *after* `records.put` used to
  delete the published tree and leave the new `LivePlugin` running out of it, in
  `live`, with the row naming whichever version won. Same restore block as the
  start-failure path.
- **Serialised for the whole daemon** (`409 plugin_busy`), by Q7.97's argument: no
  accounting outlives the request, and the relay allows 256 streams. A client
  fanning out across machines retries this **once** and retries nothing else — a
  `POST` is not replayable.
- **`POST /plugins` is the third streaming route**, so it owes what the other two
  owe: its own counter, and a body cancelled on **every** refusal. The relay
  grants a stream's window on consumption, so a reader that stops parks the sender
  and the valve after that closes the whole tunnel for the machine. This gives
  Q7.62/Q7.96 a third address; it does not change what they are asking.
- **`plugin_data` is keyed on the plugin's id, never its version** — the whole of
  what makes an update an update. Dropped on uninstall, never on update. Q5.104.

**Running**

- **The plugin root is realpath'd once at open.** `containedIn` compares as written
  when `realpath` throws — which it does for every path about to be created — so an
  unresolved root and a not-yet-existing child sit in two namespaces and the guard
  refuses its own directory. Measured on macOS, where `/var` is a symlink: every
  reinstall of the same version failed `ENOTEMPTY`. `createWorkspace` does the same.
  Q5.105.
- **Three remover trees, and no two may nest** — uploads, worktrees, plugins.
  Q5.74's rule is unchanged; its *arity* changed, so `daemon.ts` tests them pairwise
  over a named list rather than with an `if`.
- **`PluginRuntime` is an interface with one implementation, kept as one.** The seam
  a sandbox would be written at, and what lets `daemoncheck` drive a start that never
  completes, an invocation never answered and a crash after `ready` — none reachable
  by spawning a real process and hoping. No `kind`, for `SessionRuntime`'s reason.
  Q1.616.
- **`PluginScheduler` is the second seam, because the first could not reach the
  backoff.** `now` claimed to be how "a driver ages a backoff without sleeping"
  while `scheduleRestart` used a bare `setTimeout` and `Math.random()` — a seam
  nothing can use is worse than none. Both halves go through it; the defaults are
  the real ones. ⚠ **A scheduler may run its callback synchronously**, which is what
  a driver substitutes, so `scheduleRestart` assigns the canceller only if the
  callback has not already fired — otherwise it stores one for a callback that has
  run and wedges the guard for the life of the plugin.
- **Every launch has a generation, and every callback is gated on its own.**
  `onExit`, `onMessage`, `ready` and the API answer path all fire arbitrarily late,
  and `this.process` means "whichever child is current *now*". Three defects came
  from that gap: a stale `onExit` nulled the reference to a **live** successor; call
  ids restart at 1 each launch, so child A's slow `net.fetch` resolved child B's
  `sessions.get` with an HTTP body; and timers from a crashed child stopped its
  replacement. An answer goes to the **captured** child, never to `this.process`
  re-read after an await.
- **`stop()` is memoised per launch, not by `??=`, and it cancels a scheduled
  restart on every call.** A plain `??=` hands back the promise of a stop that
  finished two children ago. The cancellation may not live in `doStop`, the half
  memoisation skips: the timeout escalation stops a plugin and *then* arms a
  restart, so `remove` cancelled nothing, dropped the row, and let the timer fork a
  child held by nothing and unreachable from `shutdown`. A superseding stop
  **chains** the one it replaces, or `shutdown` resolves mid-kill.
- **A plugin child is not `detached`, and there is no reaper.** `runner.ts` exits
  when its IPC channel closes, so a daemon that dies takes its plugins with it —
  the opposite of an agent, which needs a pid column, an `os.uptime()` fence and a
  reaper. Q2.212.
- **`this.stop()` and never `child.stop()` on a failed start.** `stop()` sets
  `stopping`, the only thing telling `onExit` a kill we asked for from a crash.
  Killing the child directly scheduled a **restart for a plugin being rolled
  back**. Q5.103.
- **A plugin is not told about its own write.** `turn.ended` calling
  `ctx.sessions.prompt` was an unmetered loop of real model turns.
  `src/plugins/origin.ts` holds the *turn* claims — taken **before** `prompt` and
  put back if refused, since `pump` appends a `turn_end` synchronously — while a
  session's origin is an argument to `registry.create`, that fan running *inside*
  the call. Matched on the **id**, so an update inherits the claim. ⚠ **`session.ended`
  is unattributed, and `sessions.create` is what that leaves open**: a create whose
  `start()` throws is an exit, and `liveSessionCount` skips terminal sessions so
  `MAX_LIVE_SESSIONS` does not bound the loop — only `SESSION_CREATE_BURST`, at a
  worktree a lap. Closing it needs a per-plugin create budget.
- **Nothing on the hook path awaits into the emit path.** `SessionLog.append` is
  synchronous by contract and runs inside the agent's own RPC handler; a hook that
  blocked would put a plugin between an agent and its transcript. Hooks are queued,
  drop-oldest, drops reported — a plugin quietly missing half its events looks
  exactly like one with a bug in it. Q5.106.
- **A throwing session observer is reported and kept**, the opposite of what
  `SessionLog.append` does to a listener. There a listener is one WebSocket; here it
  is a whole subsystem, and evicting it would stop every hook on the machine with
  nothing saying so. Q5.107.
- **A view is a read by contract and nothing enforces it.** `GET`, so a retry may
  repeat it; a view that writes is a bug a retry will find.
- **A plugin's state is derived on every read** — `ManagedSession`'s rule.

**Drawing**

- **A plugin names meaning, the host picks the ink.** `PluginRowTone` is
  `ok|warn|danger` and `PluginRowAction.tone` is `plain|destructive`; neither is a
  colour. The standing answer to "why can a plugin not send CSS", and the argument
  is not that CSS is dangerous — the CSP already blocks the exfiltration it is
  famous for. It is that a plugin able to style *this* page can move pixels around
  the control that approves shell commands, that the class names would become a
  public API nothing may refactor, and that every measured decision about contrast
  would stop binding. Widening the **vocabulary** is the supported answer. Q1.617.
- **A destination is one this app has, never a URL.** `PluginOpen` is a session on
  this machine or the plugin's own screen; `{url: …}` lands as a row that goes
  nowhere — narrowed twice, on the daemon and again in `plugins.ts`, since trusting
  the daemon's narrowing is trusting a copy. A plugin-chosen link is a phishing
  surface on the page that approves commands. Q3.450.
- **`refreshMs` is declared by the plugin, clamped by the host, and spent only
  while somebody is looking.** Floored at `PLUGIN_REFRESH_MIN_MS`, stopped on
  `document.hidden` and when the sheet closes, so a small number cannot buy
  background work on a phone. **A refresh never blanks the view and never replaces
  it with an error**: the old one stays, and a failed tick is silent — a machine
  dropping off LTE for one tick is not news. A settings pane is **not** refreshed
  whatever it asks: it is a form somebody is typing into. Q3.451.

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
| `packages/web/src/ui/settings/PluginsPanel.tsx` | What this machine has and the file import. Each row is a **link to the plugin's page**; the acts left on it are behind **one kebab**. No settings pane and no scope prose — both moved, and `webcheck` reads the file to keep them gone |
| `packages/web/src/ui/plugins/PluginSettings.tsx` | One plugin's settings, as its own screen behind the gear at `/plugins/p/:id/settings`. Asks which machine only where it is on more than one, and narrows what it draws to the settings vocabulary — including an action's answer, which the daemon cannot classify |
| `src/plugins/source.ts` | Installing from a commit: the `{repo, commit}` validator, the address this daemon builds itself, `consentGap`, and the third `fetch`. All but the fetch is pure, so `daemoncheck` reaches every refusal with no network |
| `packages/web/src/catalogue.ts` | What the catalogue says, read: the hand mirror, the fail-*closed* posture, `compareVersions` (numeric — `0.10.0` beats `0.9.0`), the sentence each failed read draws |
| `packages/web/src/market.ts` | Which plugins screen a URL names. Pure, its own module for `settings.ts`'s reason |
| `packages/web/src/install.ts` | Which machines an act reaches: `planTargets` as a partition, `skipReasonFor` ordered by *remedy*, `outcomeText`, and the summary |
| `packages/web/src/ui/plugins/` | The pop-up: two tabs, the market, one entry in full, the machine multi-select, and the per-machine results. The fan-out is `act` in `MachineInstalls.tsx`, inline rather than a hook — concurrent across machines, serial within one, `plugin_busy` retried once and nothing else retried |
| `packages/web/src/ui/PluginConsent.tsx` | The disclosure, in **one** copy, drawn by both ways in |

## Bounds

| | |
|---|---|
| Archive | **2 MiB** on the wire, 8 MiB unpacked, 500 entries (`PLUGIN_LIMITS`). One install at a time for the whole daemon |
| Fetching one | 30 s, https, no redirects, one host. The size bound is `unpackArchive`'s, per chunk — **codeload sends no `content-length`** |
| Catalogue | 15 s, no credential, and **the browser's own cache only** — `ETag` is unreadable from script (no `access-control-expose-headers`) and `If-None-Match` would preflight, so hand-rolled revalidation fails *silently* as a plain 200. No `stale-while-revalidate`, so a withdrawal lands within the minute |
| Store | 1 MiB per plugin, 64 KiB per value, 1000 keys, 200 chars per key. Counted in **bytes** (`Buffer.byteLength` against `LENGTH(CAST(value AS BLOB))`) — `.length` and SQLite's `LENGTH` are UTF-16 units and characters, and neither is what lands on disk |
| `store.entries` | A **page**, bounded by bytes rather than rows, with `more` and an `after` cursor. The lot does not fit: a plugin may keep four times what one IPC message carries |
| A view | 24 blocks, 200 rows, 8 columns, 40 fields, 40 options, 4 actions/row, 4000 chars of text, 200 of anything short. **Clamped and reported**, never refused |
| Refresh | 2 s floor, 5 min cap. Clamped **silently**, unlike a cut list — an interval nobody can see moved is not a wrong number on screen |
| IPC | 256 KiB per message (**enforced**; a refused message settles its waiter rather than timing out, `413` not `502` since nothing downstream answered), 8 invocations in flight (`plugin_overloaded`), **16 host calls the other way** (`MAX_INFLIGHT_HOST_CALLS` — the direction that had no ceiling, and where a method forks git), 20 lines of child output kept |
| A view | `PLUGIN_VIEW_LIMITS`, applied by `fitView` **in the child, before the message is sent** — it ran in the host, one hop after the message had already been refused, so the published bound could never fire and the byte bound was the only real one. Rows are the lever because they are the only dimension a plugin's data grows without limit |
| Deadlines | 10 s to start, 10 s per call, 2 s of grace before SIGKILL. Both overridable **only** by a driver — there is no environment variable |
| Restarts | 3 per daemon life, full jitter 2s→60s. Three consecutive timeouts stops it. Switching it off and on returns the budget |
| `net.fetch` | https only, no redirects, 10 s, **64 KiB** — a quarter of one IPC message — 30 requests a minute per plugin. It said 1 MiB and no such answer was ever deliverable: the body is re-escaped as JSON beside the headers object, so even half a channel overruns. The assembled answer is measured again before it is sent |
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
- **A model is chosen *between* the handshake and the prompt, or not at all.**
  This daemon names no model anywhere: selection is ACP's
  `session/set_config_option` under `category: "model"`, published by the agent
  *after* `session/new` — so a one-shot ask, which makes a session every time, had
  no way to name one. `ask(agent, prompt, model?)` sets it in that window.
  **Absence has three spellings** — left out, `null`, `""` — and all mean the
  agent's default; picking one as canonical makes the other two a production
  surprise, which is the store contract's lesson applied before the fact.
  `model.list` **starts the agent** to find out what it offers (no prompt, so no
  quota), cached `MODELS_TTL_MS`, behind the `model` scope rather than
  `sessions.read` because it spawns. Reading a live session's config instead was
  refused: `dedupeAliasChoices` rewrites the snapshot (Q2.45), and a list that
  depends on whether a chat is open changes for reasons nobody can see. **Validated
  against the agent at use, never against the cache.** Q3.464.
- **The `net` allowlist is a spelling check, not an SSRF defence.** A name somebody
  controls can resolve anywhere, and re-resolving after the check is the classic
  rebinding race. The honest answer is the one `SECURITY.md` gives: the plugin can
  open its own socket.
- **A settings route has no `plugin` field, and the fixtures that had one were the
  cost of removing it.** A plugin's settings left the sheet for the plugin's own
  page; `…/plugins/:pluginId` now parses to the machine. Every hand-written route
  literal in `webcheck` kept its `plugin:` key and kept *passing* — `as never`
  swallows an extra property — while `depthOf` and `upFrom` had quietly started
  answering about the machine. The fixtures are driven through `parseSettingsRoute`
  now rather than written out, because a literal is what keeps agreeing with a
  shape that no longer exists. Q3.459.
- **A settings pane draws less than a screen: `text`/`notice`/`form`, and a field
  is `text`, `toggle` or `select`.** The surface was already on the wire as the
  view id and neither side read it. `clampView`/`noteClamp`/`fitView` take it,
  defaulted to `screen` — the *wider* set, so a call site nobody told draws too
  much rather than silently deleting somebody's controls. An **action** is always
  `screen` here: its id says which action and never which pane pressed it, so the
  browser is what narrows an action's answer. `password` → `text` is reported as a
  substitution rather than done quietly, because a mask that stops masking is the
  one substitution that looks like it worked. Q3.460.
