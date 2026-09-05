# Changelog

All notable changes to Reemoat are recorded here.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Under 0.x the minor is the breaking one.** Before 1.0.0 a minor bump may change
the daemon's HTTP surface, the relay's tunnel protocol version, or the control
plane's schema. Pin a tag. There are deliberately no rolling `0.1` or `0` image
tags, because on a 0.x project those names would mean "may break without warning"
while reading like stability.

**The shape of this file is a contract, not a convention.** `pnpm pincheck`
asserts that the newest released heading is the version in `package.json`, and
`deploy/ci-release.sh` extracts a release's notes by reading from its heading to
the next one. So a released heading is exactly `## [x.y.z] - YYYY-MM-DD`,
`## [Unreleased]` carries no date, and a section ends where the next `##` begins.

One rule that is easy to miss: **no `Q<n>.<m>` citations here.** Everywhere else
in this repository a decision can be cited by number and `pnpm docscheck` proves
it resolves. This file is deliberately outside that corpus — adding it would let a
stale symbol in `docs/DECISIONS.md` "resolve" against prose that merely mentions
it — so a citation here would be the one kind nothing checks.

## [Unreleased]

### Changed

- `PUT /v1/me/email` asks an API-key caller with a password for `currentPassword`
  — `400 bad_request` without it, `401 invalid_password` with a wrong one, and
  nothing is written or mailed until it verifies. A session still changes the
  address alone, and an account with no password row is still let through on
  its key. The address is the reset channel; a key can leak from a disk with no
  person anywhere in the chain and no admin reset behind it, where a session is
  a person signed in, listed under Devices and one tap to end.
- `cpctl key` no longer prompts for a password the route never read. `cpctl
  email` still does when the shell holds an API key, and asks nothing when
  `REEMOAT_CP_KEY` came from `cpctl login`, since the route ignores a password
  from a session. `cpctl keys` prints when each key was last used.
- Every two-step confirmation on a settings row is one control, `TwoStep`. The
  first tap still replaces the row's buttons with the question, the act and
  Cancel — Cancel last, on the same pixels, the question standing until the
  server has answered — held in one place and pinned once rather than
  re-derived on each of fourteen sites. The two centred confirmations keep
  their shape; the question reads in the text colour everywhere, with its
  consequence muted under it. Signing an agent out on a machine that has left
  the list is refused, greyed, rather than answered with a toast.
- Settings say less, again: the New session strip's lede, the two limit
  consequences, the not-enrolled line, the agent card's unknown-sign-in line,
  codex's two caveats and the plugin consent's `http` caveat are cut to the caps
  the plan set, with the same facts in fewer words.

### Fixed

- A valid API-key request no longer answers a plain-text 500 when the
  `last_used_at` bookkeeping write meets a busy database: the write is guarded
  the way the session one already was, so a request that could not record its
  own use still succeeds.
- Reset on an Email field survives the next Save. Save sends every SMTP field
  from the draft, and a Reset re-synced the draft only while the form had no
  other edits — so edit Host, Reset From, Save wrote the old From straight back
  under a "Saved." toast.
- Public URL is filled in with the page's own origin on a fresh server, since
  mail cannot be sent without it and the field drew the origin only as a
  placeholder. Save is live at once; the provenance line says "not set" until
  it lands. A value already stored or set in the environment is left alone.
- New key waits for the key list to load rather than opening the leaf during
  the skeleton only to be told the ceiling. A list that failed to load still
  lets you mint.
- Every Revoke on the keys screen and under a user's keys names its key to a
  screen reader.
- Three controls no longer stay live during the write they belong to: a
  field's Reset while a Save is in flight, the strip's Remove while its delete
  is out, and the device-code box, which empties after the code is written so a
  failed send leaves it in the box beside the toast rather than gone.
- The machines list no longer jumps on load: the loading row is the height of
  the machine row it stands in for. And a retired machine leaves the list at
  once rather than a round trip later.
- Revoking the key this browser holds still signs the tab out when browser
  storage is blocked. The one-shot notice for the sign-in screen was written
  unguarded, and a browser with storage disabled threw there before the
  credential was cleared — so the tab kept a dead key and the next request said
  "Your session expired" about an act the person had just chosen.

## [0.6.0] - 2026-09-04

### Added

- `users.password_changed_at` and `api_keys.last_used_at` on the control plane,
  both additive: `GET /v1/me` answers `passwordChangedAt` and both keys routes
  answer `lastUsedAt`, touched on an accepted bearer lookup at most once a minute
  and never on a revoked key. An older client ignores the fields and an older
  control plane answers without them.

- `deploy/ci-freshness.sh`, run weekly by `.github/workflows/freshness.yml`,
  compares each ACP adapter pin in `package.json` with what the npm registry
  serves and writes the answer into the job summary. Being behind is a report
  and never a failure (`FRESHNESS_MAX_BEHIND` is the margin that makes it one);
  a pinned version the registry no longer lists fails the job, since it would
  fail `pnpm install --frozen-lockfile` on the next machine the one-line
  installer sets up; and a registry that could not be asked exits with its own
  code rather than a verdict about the tree. `pnpm deploycheck` drives every
  outcome offline through the `NPM_VIEW` seam.
- `renovate.json`: pull requests proposing dependency bumps, the two ACP
  adapters one each and the rest of the workspace grouped weekly, with exact
  pins and no automerge — a person merges, and each machine still takes the
  change through `deploy/deploy.sh`.
- The daemon keeps the coding-agent CLIs current by itself. `deploy/agents.sh`
  installs what is missing — three with each vendor's own installer into the
  vendors' own directories (`~/.local/bin`, `~/.local/share/claude`, `~/.codex`,
  `~/.opencode`), kimi from the npm registry into `~/.reemoat/toolchain` — and
  refreshes what is there; the one-line installer runs it once, and the daemon
  runs it five minutes after start and then daily. On by default —
  `REEMOAT_AGENT_UPDATES=off` switches it off, and `deploy/agents.sh --check` says
  what a run would do without doing it. `--uninstall` removes the toolchain, and
  the npm-installed CLIs with it, and leaves the vendors' directories in place
  because they hold sign-ins of your own.
- `GET /agents/capabilities` rows carry `cli`: which build of the harness's own
  CLI published the model list, and whether it was an operator's override
  (`override`) or the copy found on PATH (`path`). The model picker draws it under
  the provider heading. Absent from older daemons; `null` where nothing was
  spawned.
- The daemon announces which build of each agent CLI it would launch on the
  tunnel handshake (`x-reemoat-agent-clis`, `claude=2.1.259;codex=0.153.1;kimi=-`),
  beside its own version and under the same rule: recorded against the machine,
  never acted on. `GET /v1/admin/fleet` answers it as `agents` per machine and
  `cpctl admin fleet` prints it, offline machines included — so "which machines
  are running a July claude" is answered without touching one. As fresh as the
  machine's last dial; a daemon older than the header is listed with `null`, and
  a value the relay cannot read is refused to `null` rather than costing the
  tunnel.
- `CLAUDE_CODE_EXECUTABLE` and `CODEX_PATH` are documented in `.env.example`; a
  harness named there runs as named, and the daily refresh leaves it alone.
- `REEMOAT_AGENT_SOURCE=npm`, and the one-line installer's `--agent-source npm`:
  all four CLIs from the npm registry rather than the vendors' own hosts, for a
  machine that cannot reach them. Your mirror is named the way npm is pointed
  anywhere (`~/.npmrc`, `npm_config_registry`); everything lands under
  `~/.reemoat/toolchain`. A choice rather than a fallback — a vendor outage never
  switches a machine to a differently built binary on its own. It decides only
  how a missing CLI is installed: one already on the machine keeps being refreshed
  the way it was installed, and under `npm` a vendor-installed copy is reported on
  every run until it is removed.
- A model id can be **typed** under a routed provider in the agent builder — a
  field at the foot of Moonshot's, Z.ai's, MiniMax's and OpenRouter's rows — for
  an id the written-down list does not hold. It becomes a row like any other, with
  the same key and pairing rules, and picking it names the agent after it. The
  written-down lists are a starting set and were refreshed against each vendor's
  documentation: Moonshot's three had all been retired (`kimi-k3`,
  `kimi-k2.7-code`, `kimi-k2.6` now), Z.ai gains `glm-5.3` and `glm-4.7`, MiniMax
  gains `MiniMax-M3` and `MiniMax-M2.7`. The same mechanism lets an assembled
  agent whose model has since left every list be renamed and saved rather than
  drawing an empty Model field.

### Changed

- Settings is six sections — Account · API keys · Machines, then under an
  "Admin" heading Server · Email · Users. API keys are a table on a screen of
  their own, with when each was made and last used and which one this browser
  holds; New key is one tap, and the key is shown once on `/settings/keys/new`.
  Email (SMTP, the test send, delivery trouble) is split out of Server;
  registration is a badge and a verb button, reminting the provisioning key is
  two-step. Password and email changes are their own screens rather than forms
  opening inside a row — nothing on a settings screen expands in place. Every
  confirmation names its subject with Cancel last; help prose is cut to the caps
  the plan set, and the machine row marks a machine that is not yours with a
  `shared` badge. Revoking the key this browser holds signs the tab out on
  purpose, and the sign-in screen says so.
- `POST /v1/me/keys` and `PUT /v1/me/email` take the session alone: neither asks
  for the current password any more, and a `currentPassword` in the body is
  ignored rather than verified. `POST /v1/me/password` still asks. The cost of
  the email half is written at the route.
- `@agentclientprotocol/claude-agent-acp` 0.63.0 → 0.73.0 and
  `@agentclientprotocol/codex-acp` 1.1.9 → 1.8.0. Re-measured against `claude`
  2.1.259 and `codex` 0.153.1: the model chip reads the model claude's `Default
  (recommended)` stands for rather than the placeholder (the bullet below is the
  rule that makes it so); codex answers `openai` as its provider id where 1.1.9
  answered `custom-gateway`, and nothing had that written down; codex publishes a
  collaboration-mode control and an `ultra` effort level, and claude an `Agent`
  persona control wherever `.claude/agents/` has a file — each drawn as a plain
  labelled control. `node_modules` is 230 MB on darwin-arm64 after the bump.
- The model picker also collapses claude's `Default (recommended)` row onto the
  model it stands for when the placeholder's description is that row's *name*,
  which is what claude-agent-acp 0.73.0 publishes; 0.63.0 copies the row's blurb
  instead, and that case still collapses. Without the second rule the placeholder
  came back after the adapter bump and the chip read "Default (recommended)".
- A session whose harness has no CLI on the machine yet is left waiting rather
  than given up on: the boot pass spends no attempt on it, runs the agent
  installer at once instead of in five minutes, and tries again when it
  completes. The daemon's log shows every completed agent update, with the
  script's own notes under it. Only a missing CLI is treated that way — a missing
  adapter package or a plugin harness that is gone spends its attempts and settles
  as before, since the installer cannot put either back — and only the first run
  is pulled forward; after it the daily run is the retry. The session row says
  "<agent> is not installed on <machine> — waiting for it to be installed" for
  the wait, rather than the plain restart line.
- An empty fleet is set up from the content pane on a wide screen: the one-line
  installer and one line about it draw beside the rail rather than inside it, at
  a width the command can be read at. The command box wraps instead of scrolling
  sideways, on every screen that draws one.
- A machine is added by running the one-line installer on it, and only that way.
  The by-name form on Settings → Machines, which handed back a setup code to
  carry to the host, is gone, and so is the "Add a machine" button that led to
  it; `cpctl enroll` still mints a code for an operator who needs one. Since
  nothing in the tab adds a machine any more, an empty fleet is re-listed on
  every poll, so the machine the script enrols appears by itself.
- Settings say less. Sentences that restated the control beside them, explained
  a mechanism nobody acts on, or printed a URL already on screen were cut
  across Account, Server, Users, Machines, Systems, Agents and Plugins; every
  consequence a person cannot see stays.
- The one-line installer unsets `REEMOAT_API_KEY` as soon as it has read it, so
  the account key no longer reaches `pnpm install`'s lifecycle scripts or the
  vendor installers `deploy/agents.sh` downloads and runs.
- The coding-agent CLIs are no longer installed by `pnpm install`. The two ACP
  adapters stay pinned; the CLI platform packages they used to bring with them are
  excluded through `pnpm-workspace.yaml` overrides, and `node_modules` went from
  907 MB to 217 MB on darwin-arm64 (230 MB after the adapter bump above).
  `deploy/agents.sh` installs the only copies
  there are, and the daemon runs an operator's override, else the first copy on
  PATH, then in the directories that script installs into — re-decided every ten
  minutes, so a refresh under a running daemon is picked up. A harness with no CLI
  on the machine is refused with a sentence naming the script rather than started.
- `deploy/deploy.sh` installs or refreshes the agent CLIs before it restarts the
  daemon, so a machine upgraded from a release that vendored them comes back with
  its harnesses rather than waiting on the daemon's first daily run.
- `--source` and `REEMOAT_AGENT_SOURCE` decide only how a missing CLI is
  installed; one already present is refreshed the way it was installed — a
  vendor-installed copy by the vendor's own updater, an npm-installed one from the
  registry — and the one thing a switch to `npm` cannot refresh, a vendor-installed
  copy, is named on every run until it is removed.
- The one-line installer refuses `--agent-source` on a machine that is already
  set up, naming `REEMOAT_AGENT_SOURCE` in the env file rather than accepting a
  flag that would change nothing.
- The one-line installer's questions are arrow-key menus, and a password or API
  key no longer reaches `curl`'s command line.
- `controlPlaneUrl` on `POST /v1/machines`, `POST /v1/machines/:id/enrollments`,
  `POST /v1/provision` and the admin mint honours `x-forwarded-proto` behind
  `REEMOAT_CP_TRUSTED_PROXY_HOPS`, so a daemon enrolled through a TLS proxy dials
  `https://` rather than the plaintext origin.
- `--uninstall` exits non-zero and leaves the private node in place when the
  service could not be stopped, rather than deleting the node a still-installed
  unit runs. `--purge` always confirms and names the database and checkout it is
  about to delete, not only the worktrees; `--yes` still answers.

## [0.5.0] - 2026-09-01

### Added

- **One command puts a machine in the app.** `curl -fsSL <release asset> | sh`
  installs the daemon, asks which control plane to join and who you are on it —
  sign in, sign up, or paste a key — creates the machine and starts the service.
  No `sudo`, nothing written to a shell profile, and nothing outside `~/.reemoat`
  and the checkout, which is what makes `--uninstall` complete rather than
  approximate. It hands the last third to `deploy/install.sh daemon
  --non-interactive` rather than reimplementing unit rendering, PATH computation
  and the health probe.

  **Where the software comes from and which fleet it joins are two questions,
  and the command keeps them apart.** The README downloads from a release asset
  on this repository; a control plane serves the same file at `GET /install.sh`
  with its own origin substituted in, which is what Settings → Machines prints
  and why there is nothing to type there; `--url` or `REEMOAT_CONTROL_PLANE`
  says it outright. Fetched from anywhere neutral it **asks**, with no default —
  letting a download URL also decide which fleet a machine joins is how somebody
  who wanted their own control plane arrives in one they do not run.

  Three things about it are load-bearing rather than tidy. Everything runs from
  one `main "$@"` on the last line, because `curl … | sh` executes bytes as they
  arrive and a truncated download otherwise runs a *prefix* of the file with
  `set -e` silent. Every question is asked on `/dev/tty`, because stdin is the
  download. And the origin substituted into the served copy is shell-quoted: a
  `Host` of ``a`id`b`` reaches `URL.origin` intact, and `imagecheck` sends one
  through a real container to prove the quoting is on the path a request takes.

- **A host can pull the control-plane image instead of building it.**
  `REEMOAT_CP_IMAGE` decides — a registry-qualified ref pulls, a bare one builds
  — and `deploy.sh` prints which on every run. `REEMOAT_CP_SOURCE` overrides the
  derivation, and an unrecognised value is refused rather than defaulted.

  In pull mode `CP_IMAGE_INPUTS` does not apply: a git diff is a guess at what a
  build would produce, and a registry ref names exact bytes. Everything
  downstream is untouched — `cp_image_fingerprint` inspects the local image
  either way, so `CP_IMAGE_MOVED` and the `RELAY_INPUTS` rule that decides
  whether the fleet's tunnels drop behave exactly as they do after a build.

### Fixed

- **The documented way to run the published image had never worked.**
  `deploy/README.md` said to put `REEMOAT_CP_IMAGE=ghcr.io/…` in the control
  plane's env file. It could not win: compose gives the shell environment
  precedence over `--env-file` for `${…}` interpolation, and `compose.sh`
  exported its own default before compose ever ran — measured, `compose.sh
  config` with a registry ref in that file still printed
  `image: reemoat/control-plane:current`.

  The half with no symptom is worse. `deploy.sh` calls `cp_image_fingerprint`
  from a process where that variable may be unset while compose's child had it
  from the file, so the fingerprint would inspect a *different name*, answer
  empty on both sides, conclude the image had not moved, and recreate nothing —
  a deploy that printed success while the old bytes kept serving. There is one
  resolver now (`cp_image_ref`), every script reads it, and `deploycheck`
  asserts no script holds a second copy of the default.

- **`GET /install.sh` answers with the scheme a browser actually used.**
  `publicUrl` takes it from `socket.encrypted`, and the service runs plain HTTP
  behind a proxy that terminates TLS — so it answered `http://`, and the plain
  form of a deployed origin is a `301` the installer deliberately does not
  follow. `x-forwarded-proto` is read, gated on `trustedProxyHops` exactly as
  `callerAddressOf` is. ⚠ The same defect on `controlPlaneUrl` (four
  code-minting routes) is known and **not** fixed here: changing `publicUrl`
  itself changes what every enrollment paste has said since the first release.

## [0.4.0] - 2026-09-01

### Fixed

- **A pasted key no longer expires on its own, and a machine left alone over a
  holiday comes back signed in.** There was a sweep in `prune()` that deleted a
  saved agent credential once it was older than the session horizon *and* no
  sessions were left. Both halves had to be true, which read like a narrow rule and
  was not: `updated_at` moves only when a key is **pasted** — nothing touches it on
  read — so the age half was permanently true of every key in real use, and what
  was actually left binding was "no sessions left", which unpinned sessions reach
  after seven days. Eight idle days and a restart, and the paste was gone, with
  nothing on any screen connecting the two. It is removed: a key in
  `agent_credentials` or `system_credentials` now goes when you clear it, when a
  paste replaces it, or when you uninstall the plugin that added the harness or
  provider it belongs to — and at no other time.

  ⚠ **A daemon that ran an earlier build may already have deleted keys this way,
  and there is nothing to restore** — the sweep was a plain `DELETE`. If a machine
  that has been quiet for over a week now reports an agent as signed out, that is
  this bug rather than anything at the vendor: paste the key again under Settings →
  Machines → this machine, and it will stay. Deleting a local copy never revoked
  anything at the vendor, which is the largest reason the sweep was not worth its
  cost. `docs/DECISIONS.md` Q7.124 carries the whole argument.

- **A harness that will not start stops being offered, and stops costing a
  worktree.** Reported with a screenshot: New session drew a tile for an agent a
  plugin had added, Start answered *"rejected session/new: authentication
  required"*, and the tile was still there for the next press — and the one after
  that. The daemon remembers a refused start now, so the tile goes, the model
  picker greys the row, and a second press is refused before a worktree, a branch
  and a session row are made for it. It is remembered for ten minutes rather than
  written down: an agent's refusal is an observation, and this project has once
  already turned one into a standing verdict and stranded conversations under it.
  A successful start forgets it, so does pasting a key, so does finishing a sign-in
  in the app, so does switching the plugin off and on — and where none of those
  happened there is **Check again**, on the machine's agent list and on the agent's
  own card, for after you have signed in on the machine itself.
  `pnpm client agents recheck <agent>` is the same thing from a terminal.

- **A settings card called an agent a plugin added by its identifier.** Every
  sentence on that card named the harness with this product's own table, which
  answers the bare id for anything it does not ship — so the card read *"byo:gemini
  needs no sign-in"*. It uses the manifest's name now, bounded, exactly as the
  tiles and the refusal sentences already did.

- **A resumed session no longer reports a demotion that did not happen.** An agent
  that comes back on the model it was started with, and has since stopped *listing*
  that model, drew an error row contradicting itself in one sentence — *"has no
  model called X … resumed anyway, running X"* — because the pin asked whether the
  model was **offered** rather than whether the session was **on** it. Worse, the
  same refusal made `POST /sessions` answer a permanent `502` for a preset whose
  model the agent was running. Both gone: the pin answers "already there" before it
  reads the list.

### Changed

- **Settings → Machines → *Systems* is now *Sign-ins*, and it holds both halves.**
  Signing in on a machine was never only about inference: a harness can read a key
  of its own, and until now the only place that key could be typed was a
  *provider's* card — reached when that provider named the harness. Every harness
  this product ships is named that way, so all four had one; a harness a plugin
  added had one only if that plugin also contributed a provider naming it, and
  nothing required that. A key box could be declared in a manifest and drawn on no
  screen at all. Such a harness has a row of its own now, after the providers,
  saying whether a key is saved. Nothing changes on a machine with no plugins —
  adding every harness would have put Claude Code beside Anthropic, which is two
  rows for one account.

### Added

- **A plugin can add a harness, or a provider.** Two declarative blocks in
  `plugin.json` — `contributes.harnesses` and `contributes.systems` — put an ACP
  program and an inference endpoint on a machine, and both then behave as though
  this product had shipped them: the harness is in the agent builder's harness row
  and in Settings → Machines with a paste box, and the provider is a heading in the
  model picker and a key box beside the built-in ones. The two are assembled into a
  named agent exactly as Claude Code on OpenRouter is, and **that** is what gets a
  tile on New session — a plugin adds a harness, never an agent, because whether a
  harness is a whole answer on its own is a claim about the *model* that nothing on
  the machine can check. No plugin code runs for either and nothing is fetched at
  runtime; the daemon reads the manifest and answers its own routes with it.

  A machine that has just been told about a harness asks it whether it starts,
  rather than leaving that to whoever presses Start first: installing, updating or
  switching a plugin on runs the same capability read the agent builder does, so
  the answer is on screen before anybody taps anything.

  Both need plugin API 5, and a daemon that speaks less refuses the block rather
  than ignoring it — a plugin whose whole reason to exist is a harness has no useful
  degraded form, so its owner is told to update the machine instead of installing
  something inert. Two new scopes say what is at stake, and the consent screen also
  draws the **command line** and the **whole base URL**, because a line in a list is
  where somebody learns a capability exists and not where they can judge one. What
  is drawn is exactly what the daemon compares, so a commit asking for more than was
  shown is refused before the plugin runs — including from a browser too old to have
  drawn the rows at all.

  A provider's endpoint may be `https` anywhere, or `http` to this machine or this
  network, which is what makes Ollama, vLLM and LM Studio reachable; where it is
  `http` the consent screen says the key travels in the clear.
  `rends-east/reemoat-plugin-byo` is a working example — Gemini CLI as the agent,
  DeepSeek as the provider, both measured — and it holds no scope that gates a
  method, so its consent card shows the two things it adds and nothing else. A
  contributed harness
  has no sign-in wizard and will not get one — everything a wizard needs is a
  measurement about somebody else's CLI — so it is opencode's shape: a paste box and
  nothing else. Uninstalling a plugin now takes its saved keys with it, out of both
  credential tables; switching one off keeps every session, preset and position it
  had, and putting it back brings them all back.

- **The agent row on New session is yours to arrange.** The gear at the end of it
  opens a per-machine **Agents** screen — reachable from the machine's own settings
  too — where every agent that row can offer is a full-width row you can drag,
  hide, edit and remove, with the `+` that used to sit in the strip now at the foot
  of the list it adds to.

  The order and the hidden set live **on the daemon, per machine**, so they are the
  same from a phone and a laptop and survive the reload a phone performs on its
  own. What is stored is a *partial* record — a position for what somebody actually
  moved — merged over whatever the machine currently reports: an agent it has never
  heard of appends at the end and is visible, and an agent that is signed out or
  gone keeps its place for when it comes back rather than losing it.

  Every row is draggable **and** movable from the keyboard, with `↑`/`↓`/`Home`/`End`
  on the handle — a 44px target that keeps the sheet from scrolling under a thumb.
  Everything a row can do is behind one menu, on every row, and **every** row can be
  edited and removed: a built-in agent and one you assembled are the same thing from
  the picker's side — the built-in one is just the one that is there by default.
  Editing it opens the builder already pointed at that harness. Removing signs nothing out. A built-in row stays where it is,
  dimmed, offering to add it back; an assembled one is deleted and rebuilt from *Add
  an agent*, and sessions started on it keep resuming on the bare harness. There is
  no confirmation, because neither is a thing you cannot redo.

  Opened from the gear, the screen's ◀ goes back to the New session sheet you left —
  folder walked and agent chosen — rather than further into settings.

  A machine whose agents are *all* hidden says so, and points at the gear.

  **The first agent in that order is the one a new session opens on, and its row
  says `default`.** Drag another to the top and it becomes the default. "First"
  skips a row that cannot be started — a hidden one, a harness that is signed out,
  an agent assembled on a harness that has since been uninstalled — because those
  have rows here on purpose and none of them is what a new session can open on. It
  also fixes the picker: the last of those three used to be selected on arrival and
  then refused, leaving New session with no agent chosen and **Start** dead until
  you tapped one.

- **A built-in agent's tile says which system it runs on.** Claude Code ·
  Anthropic, Codex · OpenAI, Kimi Code · Moonshot — on the New session tiles and on
  the rows of the Agents screen. It used to say `signed in`, which is true of every
  agent you can actually start and therefore says nothing; a status only appears
  now when there is one worth reporting, and it displaces the vendor.

- **The agent row says when it is cut off.** A gradient at its right edge, on
  exactly while there is more to the right of it — the same fade the transcript
  draws under a session's name. The scrollbar under the row reports where you are;
  this is the part that says there is somewhere to go before you have touched
  anything.

- **opencode is a fourth agent, and it needs no signing in.** `opencode acp`,
  vendored and pinned like the other adapters, and it needs no new machinery
  either: it publishes a model control under `category: "model"` and answers
  `session/set_config_option`, which is exactly the call an assembled agent was
  already pinned with.

  Measured: with nothing configured at all it runs on **OpenCode Zen's free
  models**. So there is no sign-in wizard, no sign-out button, and no status under
  it either — an agent with nothing to report shows nothing, rather than a
  `cannot check` that reads as a fault. The settings card still carries one
  sentence saying nothing is missing and what a key buys.

  It has **no tile of its own** on the new-session screen, and that is the same
  fact from the other side: the other three harnesses *are* the model they run,
  and this one is a router. Started bare it picks `opencode/big-pickle` off that
  free tier — a model nobody chose, under a tile that names none — and a saved
  OpenRouter key widens its catalogue to 362 without moving that default one row.
  It is a harness everywhere else: build an agent with it, pick a model, and it
  behaves like any other.

- **Assembling an agent refuses a pairing before you can make one.** Choosing a
  harness first now collapses every provider it cannot be pointed at to a single
  greyed line in the model list — so `opencode` no longer offers Claude's models
  and then refuses to save. Each of the two fields has a `Clear` beside it, and
  the reason a pair is refused is drawn on the row it is about rather than only at
  the foot of the sheet.

- **OpenCode Zen is a provider in its own right**, beside OpenRouter — both
  reached by opencode, which publishes them in one list that the picker now
  divides by provider. Its free models are the six you get with no key; an
  `OPENCODE_API_KEY` opens the rest, 93 in all. Rows are named as the provider
  names them — the `OpenCode Zen/` the CLI puts on the front is dropped, since the
  heading over the row already says it.

- **OpenRouter is a sixth provider, with its whole catalogue in the picker.**
  Reached two ways at once, like Moonshot: opencode runs it natively, and Claude
  Code can be pointed at it. The catalogue is read **by the browser** from
  OpenRouter's own host rather than written down here or proxied by the daemon —
  289 models under one heading. Two things are left out and for one reason —
  each would only fail confusingly at somebody else's endpoint: a model that
  cannot call tools, and the `:batch` rows, which are the pricing tier of an
  asynchronous API with a 24-hour completion window that nothing here can submit
  to or poll. A model both opencode and the catalogue name is one row, runnable by
  either harness.

  ⚠ **If you serve the UI yourself, `connect-src` now has to name
  `https://openrouter.ai`.** Without it the picker's OpenRouter section never
  fills. See `packages/control-plane/.env.example`.

### Changed

- **The model picker puts the providers you can actually use first.** Any provider
  this machine can start a model on floats above every provider it cannot — so the
  ones whose rows would read *"No … key on this machine."* sink to the bottom
  instead of sitting between you and the one you use. "Can use" is the same test
  that greys the rows, so the order and the greying always agree: a provider whose
  models are published by a signed-in harness counts, even with no key of its own
  pasted anywhere.

  Under that, the default order changed too: Anthropic, OpenAI, **OpenRouter**,
  Moonshot, Z.ai, MiniMax, OpenCode Zen. OpenRouter is the widest catalogue and the
  commonest reason to scroll at all, and it used to sit below one vendor's four
  models. Zen is last by default and floats like anything else on a machine that
  holds its key.

- **The `+` at the end of the agent row is a gear, and the `Edit <agent>` line
  under the row is gone.** Both acts moved onto the Agents screen the gear opens,
  where an agent is a row with room for its own controls rather than a 112px tile
  in a strip you drag sideways. Nothing below the picker appears and disappears as
  you tap along the row any more.

### Fixed

- **`touch-action: none` did nothing, on every button in the app.** `index.css`
  declared the `touch-action` default for `button` outside any cascade layer, and an
  unlayered rule beats every Tailwind utility regardless of specificity — so the
  `touch-none` class was dead wherever it was used. The visible cost was that the
  agent list could not be dragged on a phone at all: the browser took the gesture
  for the scroller before the first `pointermove`. A mouse is not gated by
  `touch-action`, which is why it only showed up on a touchscreen.

- **A fourth harness would have drawn a blank tile.** `AgentGlyph`'s comment had
  claimed for four releases that a missing arm was a compile error; it was not —
  the function answers `ReactNode` and `undefined` inhabits it, so a `switch`
  falling off the end returned exactly that. It ends in a `never` arm now, and a
  missing glyph really is a compile error.
- **The composer strip said three different things about a fourth agent.** The
  mode control read `Session Mode` where the other three read `Mode`; its modes
  read `build` and `plan` where the others read `Plan Mode` and `YOLO`; and the
  effort control was simply not there. `labelFor` reconciles the first, a new
  `choiceLabel` — the one place a choice is named, capitalising a mode's first
  letter and nothing else — reconciles the second, and `drawnControls` now keeps
  the effort slot even for an agent that never published one, so it opens and says
  the model offers no levels rather than being absent.
- **A control the agent published with nothing to choose from** drew as a working
  chip that opened onto an empty panel. It is drawn as unavailable now, like one
  that was withdrawn.
- **A turn that ended in an error never said it had ended.** Four prompts, three
  `turn_end`s, in a log anybody could read: a rejected `session/prompt` became an
  `error` event and the turn was simply over. The daemon writes the end now, with
  a stop reason of its own (`agent_error`) because none of ACP's five means
  "failed". Nothing was stuck — what was broken is quieter: a turn that failed
  mid-delegation left "waiting for 1 task" under the transcript for the rest of
  the session, the `turn.ended` plugin hook never fired, and the turn's origin
  claim was never spent, so a plugin that started it had the *next* turn's hook
  suppressed instead. Nothing new is drawn: the agent's own error is already the
  row above it.
- **The assemble-an-agent screen was a spinner for five seconds.** It waited for
  `GET /agents/capabilities`, which starts an agent per harness — measured at
  5286 ms cold — although only the model list needs the answer. The screen now
  draws as soon as the cheap table read lands and one row says what it is waiting
  for; nothing on it can claim a pairing is possible, or refused, before the
  answer arrives.

  The read itself went from **5286 ms to 2159 ms**, in two steps. It asks every
  harness at once rather than one at a time — the daemon's concurrency bound is
  untouched, because the cap now queues instead of refusing, and a plugin's own
  model request is still refused rather than parked. And it no longer holds the
  answer while it tears the agent down: codex's model list is ready at 383 ms and
  its teardown took 2011 ms more, because it does not answer `session/close` and
  the close waits its full budget. The daemon still cleans up, and still counts the
  process against its own limit while it does — the caller just stopped waiting
  for it.
- **The agent builder asked the slow question first.** Its two rows are Harness
  and Model, and only the model list waits on the machine — the read that starts an
  agent per harness to find out what each can run. It was on top, so the first
  thing on the screen was a row saying *Reading models…* that could not be opened,
  above a row that was ready immediately. They are swapped: choose the harness,
  which costs nothing, and the catalogue lands while you do. It is also the order
  the model list is built for — with a harness chosen, every provider it cannot be
  pointed at collapses to one greyed line, so a refusal now arrives before the
  choice it is about rather than after it. Neither field is required first and
  either can still be cleared.
- **A model that cannot call a tool was offered as an agent.** The catalogue
  filter that drops those had only ever been applied to the list this browser
  fetches — and opencode publishes its own copy of OpenRouter's, unfiltered, image
  models and all, which got merged straight past it. Assembling one produced a
  session that failed on its first turn with OpenRouter's own accurate sentence.
  A refusal the catalogue has already made now outranks whatever the harness
  lists, and a catalogue that could not be read refuses nothing.
- **The agent strip is a row you can actually move, and the `+` is in it.** The
  layout always scrolled; a mouse simply has no gesture for a horizontal box, and
  this strip hid the one bar that says so. A wheel scrolls it now, handing the
  gesture back to the page at either end. The `+` is the row's last item — an
  ordinary one you scroll to, not a button pinned to the right edge in front of the
  last tile.

  The bar under it is the app's own, not the browser's: it appears with the first
  notch and fades a second after you stop, the way an overlay bar does. It had to
  be drawn by hand, because a real scrollbar in this app cannot be animated at all
  — Chrome ignores every `::-webkit-scrollbar` rule on an element that sets
  `scrollbar-width`, which this app sets on everything, and what is left switches
  between two frames.
- **The new-session picker offers the agents you can start, and nothing else.**
  A harness that is not installed, or is installed and signed out, had a tile of
  its own explaining why — so a machine with one working agent showed three tiles,
  two of which were labels. Those are gone, and with them the `signed in` line
  under the ones that remain: it was a fact true of every tile in the row. An agent
  that cannot say whether it is signed in still has a tile, because that is kimi's
  permanent answer and a probe that timed out is not a sign-out. Signing in is
  still on this screen — on a machine with nothing to start, it is what the screen
  offers instead of an empty row — and the settings card is unchanged.
- **A session pinned to one provider was offered another one's models.** opencode
  publishes one model control holding both its catalogues, so an OpenRouter
  session's own picker carried six OpenCode Zen rows — and choosing one left the
  session running a model its preset does not name, with nothing on screen saying
  so. The snapshot's model list is now the session's own system's; the transcript
  still records everything the agent published, and the model the session is
  actually on is never filtered out of its own picker.
- **opencode's model names were mostly the provider's.** It publishes one model
  control holding 356 `OpenRouter/…` rows and six `OpenCode Zen/…`, so the chip —
  which has room for about eleven characters — spent all of them saying
  `OpenRouter…` instead of which model. A word every row repeats is taken out of
  every row, in the chip, in its menu and in the `/model` list, and the values sent
  to the agent are untouched. No heading replaces it: with a session's list now
  narrowed to the provider it actually routes through, a heading would sit over
  every row and tell you nothing. Where a control really does hold two providers
  nothing is shortened at all, so no two rows can be read for each other. The
  tooltip over a truncated chip said "Model"; it says the model.

## [0.3.0] - 2026-08-22

### Added

- **Sign in with your username or your confirmed email address.** One field, one
  answer to every refusal, and the address is accepted only once it has been
  confirmed — an unconfirmed claim can be written by anyone from the anonymous
  sign-up route, so it reserves nothing and opens nothing. The name is resolved
  first, which settles the one ambiguous case (a legacy name holding an `@`) without
  a new error code an unauthenticated caller could read as an existence oracle. One
  account named two ways spends two guessing counters, deliberately: folding them
  would key the counter on the account, which is the lockout weapon the throttle was
  built to remove.

- **Plugins.** A machine can be given a plugin: a `.tar.gz` holding a manifest and
  a file of JavaScript, installed by whoever owns that machine. A plugin can draw
  a screen, draw its own settings pane, put an action on a session's menu, and run
  code when a session starts, a turn ends, a session ends or an agent asks a
  question. It reads sessions, transcripts, diffs and workspace files, creates and
  prompts and stops sessions, keeps its own data, and reaches host names it
  declared — each behind a scope it names in its manifest and that is shown to
  whoever installs it. `docs/PLUGINS.md` is the author's guide and
  `plugins/board/` is a working one.
- **`pnpm client plugins`, and `plugin install | remove | enable | disable | view`.**
  Installing an id that is already there updates it, and what the plugin stored
  survives that — if the new version will not start, the old one keeps running and
  nothing on disk changes. That holds for a reinstall of the version already
  installed, and for a plugin that is switched off: the build is started long
  enough to prove it runs and stopped again before the row is written, so an
  update nobody could have noticed was broken is refused rather than committed. Seven new daemon routes under `/plugins`.
- **Plugins on the machine's settings screen**, beside its agents, with each
  plugin's scopes written out as sentences on its row. A plugin that draws a
  screen gets a launcher in the rail's footer and a route of its own at
  `/p/:machineId/:pluginId`.
- **A plugin's row can go somewhere, and a screen can keep up.** A row names a
  session on the machine or the plugin's own screen — a destination this app has,
  never a URL — and tapping it opens that. A view can ask to be re-read on an
  interval, floored at two seconds and spent only while somebody is looking; the
  old view stays until the new one arrives, and a failed tick says nothing.
- **A row can say what it means** — `ok`, `warn`, `danger` — and the app picks the
  ink. This is the answer to "let a plugin send CSS", which it may not: naming
  meaning survives a refactor and cannot put a value below the contrast floor.
- **`permission.resolved`, `sessions.answerElicitation` and `agents.list`**, each
  closing an asymmetry: a plugin could learn a question was asked and not how it
  ended, could answer a permission but not a form, and could start a session
  without being able to ask which agents this machine has.
- **A plugin market**, read by the browser and never by the daemon. The catalogue
  is its own service on its own host, named by `REEMOAT_CP_PLUGIN_CATALOGUE_URL`
  and reported to the client as `plugins.catalogue` on `GET /v1/instance`; an
  instance that sets none has no market and says so. Installing from it is
  `POST /plugins/source`, which hands the daemon a repository and a **commit**
  rather than an archive, so what arrives is what the catalogue pinned. The daemon
  still discovers nothing and polls nothing.
- Plugin API **4**, in three rungs that all land here. The floor stays at 1, so a
  plugin written for 1 runs untouched; one that needs more declares the rung it
  needs and is refused by an older daemon with a sentence rather than losing its
  navigation quietly. **v2** added `open`, `refreshMs` and `tone`; **v3** added the
  `model` scope; **v4** added `model.list` and the optional `model` on
  `model.complete`. Declaring `2` and using the `model` scope is refused, so the
  rung to declare is the highest one whose features a plugin actually uses.

### Fixed

- **Nothing an agent asks you is shortened any more.** The daemon clipped a
  question's prose at 512, 100 and 300 characters and a permission's title and
  option names at 200; the browser deleted an answer whose label would not fit a
  button, and clipped the collapsed question bar with CSS. All of it is gone. What
  bounds a form now is one 32 KiB refusal over the whole thing, and what bounds a
  permission is one 8 KiB refusal over its title and options together — a card that
  large is declined *to the agent*, which is a sentence it can act on, rather than
  delivered silently shortened. Measured on a real log, one option description was
  318 characters against a 300 cap, and five of fifteen option labels were over the
  button ceiling.
- **An answer the agent offered is never removed to make the buttons fit.** Past the
  label ceiling the card lays its options out as full-width rows instead — the same
  arrangement it already uses for a question — keeping the refusal first and the
  reversible approval filled. This mattered most where it was least visible: when a
  question arrives down the permission channel and cannot be classified, the options
  are the model's own written answers, and two of four were being deleted with
  nothing said.
- **A question you have already answered still says what was asked.** The transcript
  showed the adapter's preamble — "Please answer the following questions." — over the
  values you picked, because the questions themselves live in the tool call's
  arguments and nothing was reading them. Each question is now drawn over its own
  answer, matched by the words you tapped rather than by any adapter's field naming.
- **Menu rows line their text up with their icons.** Seven rows across the account
  menu, the chat filter, the settings kebab and the plugin menu asked to be centred
  and none of them was: Tailwind emits its utilities alphabetically, so the shared
  row's `items-start` outranked every `items-center` a call site appended, whichever
  order they were written in. The shared string states no alignment now — the caller
  does — and a check sweeps every call site for the same class of silent override.

- **A plugin's lifecycle now knows which child it is talking about.** Every launch
  carries a generation and every late callback is gated on its own, which closes
  three separate defects that shared one cause: a dead child's exit could null the
  reference to its live replacement and leave an unreachable process behind; a
  child's call ids restart at 1 each launch, so a slow `net.fetch` from a crashed
  plugin could resolve a *different* call in its replacement with the wrong data;
  and timers left over from a crash could stop the healthy child that replaced it.
- **`plugin install` and `plugin remove` no longer leave a child nobody holds.**
  A stop cancels a scheduled restart on every call rather than only when it does
  real work, and a stop that supersedes one still in flight waits for both — so
  `shutdown` no longer returns while a process is still being killed.
- **A refusal from the auth or scope check on a streaming route releases the
  request body.** The three routes that stream their own bodies cancel them on
  every refusal *they* make, but the middlewares above them answered without
  releasing anything, and an unread body parks the sender against the relay's
  window. The obligation now hangs off the same guard that grants the exemption,
  so a fourth streaming route gets both halves by adding one string.
- **The plugin data quota counts bytes.** It counted UTF-16 units on one side and
  SQLite characters on the other, so ten emoji were charged 12 or 22 against the
  42 they actually occupy — roughly three times the ceiling was reachable.
- **An oversized message no longer looks like a hang.** Anything past the 256 KiB
  IPC bound was dropped in silence and charged to the plugin as a timeout, so three
  large form submissions from a `session:write` caller would stop a plugin that had
  done nothing wrong. It now fails at once and says what happened.
- `ctx.agents.list()` and `ctx.sessions.answerElicitation()` are reachable from a
  plugin, and `ctx.files.list` — which never had a host method — is gone.
- **`ctx.store.entries(prefix)`**, a paged batched read, because the reference
  plugin's own screen was a thousand round trips per redraw with no other option.

### Security

- **Nothing is sent until you have read what the plugin asks for.** Choosing a file
  no longer uploads it: the manifest is read where you are — in the browser, and by
  `pnpm client plugin install` at a terminal — and its scopes, the hosts it named and
  the events it asks to be told about are drawn before anything crosses the network.
  This is what `SECURITY.md` meant by "named before somebody consents to it", which
  until now was not true: the archive was unpacked, the row written and the plugin
  started, and the scopes appeared afterwards on the row of something already
  running. Neither reader validates — the machine still refuses authoritatively —
  and an archive that cannot be read says so rather than guessing, with a separate
  named press as the way past.
- **A plugin runs as you, and the browser runs none of it.** A plugin is a child
  process of the daemon with your uid and your files — the same trade an agent
  already makes on the same machine. Its declared scopes are hygiene rather than a
  fence, and `SECURITY.md` says so in those words. What is a real boundary: a
  plugin returns a *description* of a screen and the app draws it, so the origin
  holding your credential executes nothing a plugin author wrote. There is no
  registry, nothing downloads a plugin, and nothing updates one by itself.

## [0.2.0] - 2026-08-21

### Added

- **Signing out is a state of the machine.** A credential is read once, at spawn,
  so an agent started while signed in kept answering for an account somebody had
  just revoked. Signing out now ends every conversation on that agent
  (`agent_signed_out`), a prompt is refused before it can reach a signed-out agent
  — a sign-out done in a terminal, or an OAuth session that simply expired, is
  reported by the agent itself (`errorKind: authentication_failed`) and ends the
  conversation the same way — and signing back in resumes **exactly** the sessions the sign-out
  ended, leaving hand-stopped ones alone. Refused only on a CLI's explicit
  "signed out". There is deliberately no probe on the prompt path: one there cost
  a spawn per message and made the offline drivers depend on whether the person
  running them was signed in. Q7.100.
- **A signed-out agent says so in the conversation, with a Sign in button** that
  goes to that machine's own agent screen — instead of a toast, which carried the
  one refusal on this screen with a real remedy in the place that has no room for
  one. The session is ended rather than merely refused, so "signed out" is a
  single state; the draft is still restored, and signing in brings the
  conversation back with it waiting. Q7.102.

### Fixed

- **Settings stopped flickering on every tab switch.** A wake deliberately forgets
  each machine's route, and the re-probe published `probing` for a machine already
  known to be online — so machine dots blinked and the agents panel *unmounted and
  remounted*, restarting its fetch and discarding anything half-typed into a
  credential box. A re-probe now keeps the answer it already has. Q7.101.

- **Import my code** — `POST /fs/import` takes a `.zip` or `.tar.gz` and unpacks it
  into one new folder inside the directory the new-session picker is standing in,
  then moves the picker into it. The archive comes from a Claude Code skill the web
  UI hands over as a single paste, run in a session on the machine the code actually
  lives on, so the code and the context around it are collected by an agent rather
  than guessed at by a glob. Format is decided by magic bytes, never by filename.
  `.claude/rules/code-import.md` is the whole argument; Q2.107–Q2.110 are the
  measurements.
  - **Containment is rebuilt from scratch for archive members**, because every
    member path is a string a remote party wrote. `safeMemberPath` is pure and
    refuses first — absolute paths, any `..` segment (refused, never normalised),
    backslashes, control characters, symlinks, hardlinks, devices and `.git` — and
    both readers go through it so the two formats cannot disagree. Every write is
    `O_EXCL`.
  - **Nothing in the target is touched until one `rename`**, so a failed import
    leaves the folder exactly as it was. A destination that already exists is
    refused rather than replaced, `rename` onto an empty directory included.
  - Bounds: 50 MiB on the wire, 500 MiB unpacked (charged against bytes actually
    produced, not declared), 20 000 members, one import at a time per daemon.
- **A read-only grant is now asserted to be read-only on a mutating route.**
  `daemoncheck` grew `tokenWith`, and the scope refusal it exercises had no
  assertion anywhere before.

### Changed

- The 1 MiB request-body bound now exempts routes through one named predicate
  (`isStreamingRoute`) rather than an inline regex, since there are two of them.


## [0.1.0] - 2026-08-18

First public release. The repository was published with fresh history as a single
commit, so there is nothing before this and no diff to link.

### Added

- **A protocol version *range* on the relay tunnel**, so a bump is no longer a flag
  day. `RELAY_PROTOCOL_MIN_VERSION`/`RELAY_PROTOCOL_VERSION` bound what a relay
  speaks and `negotiateProtocolVersion` takes the newest both ends know: a daemon
  ahead of the relay is negotiated **down** rather than refused, one behind keeps
  working until the floor is deliberately raised. The relay answers the agreed
  number on the 101 as `x-reemoat-relay-agreed`, and every stream down that tunnel
  carries it — not the relay's own maximum. `.claude/rules/compatibility.md` is the
  order to make a breaking change in.
- **`x-reemoat-daemon-version` on the tunnel handshake**, and `src/version.ts`'s
  `DAEMON_VERSION` behind it. Advisory: recorded, reported, and branched on by
  nothing. The relay stores it against the machine on dial.
- **`GET /v1/admin/fleet`** and `cpctl admin fleet` — what every machine last
  dialled in as, **offline ones included**, because the machine that decides
  whether the floor can move is the one that has been dark for a month.
- **`version` and `protocol` on the daemon's `GET /health`**, unauthenticated like
  the clock beside them: a client that cannot get a token yet is the one that most
  needs to know whether the daemon it is pointed at is older than it is.
- **A `migrate()` for the control plane's SQLite**, additions only, with
  `CP_SCHEMA_VERSION` deliberately not moving for one — so yesterday's image still
  starts against today's database and a rollback stays a rollback. `deploycheck`
  asserts that shape rather than trusting the comment.
- **A release pipeline**: `.github/workflows/release.yml` on a tag push, with every
  refusal in `deploy/ci-release.sh` and driven by `deploycheck` with no registry,
  no forge and no network. Plus a gitleaks job and a `.gitleaks.toml`
  that names the exact secrets rather than the files holding them.

- **The daemon**, **the control plane** and **the web UI**, as one AGPL-3.0-only
  workspace. The daemon owns coding-agent sessions and exposes them over HTTP and
  WebSocket; the control plane issues identity and relays every request; the web
  UI supervises the fleet from a phone. `README.md` is the overview and
  `deploy/README.md` is the deployment surface in full.
- **`claude`, `kimi` and `codex` over ACP**, normalized into one event stream.
  Sessions, permissions, questions, commands, file changes and uploads are the
  same shapes whichever agent is behind them.
- **A published container image for the control plane and the relay** —
  `ghcr.io/rends-east/reemoat/control-plane`, `linux/amd64`. Two services from one
  image, which is how `deploy/docker/compose.yml` already ran them. Running it is
  optional: `deploy/deploy.sh` still builds on the host by default.
- **`GET /v1/instance` serves the AGPL section 13 source offer** — the source URL
  and this version string — to callers who have not signed in, because they are
  the users that clause is owed to.
- **Ten checking drivers** and no test framework. Eight run offline in one
  process with no fleet, no agent and no deploy; `imagecheck` builds and starts a
  container; `harness` drives a real agent.

### Changed

- **The `reemoat-v` stream header is now enforced by the daemon.** It was written
  by the relay on every stream and read by nobody. A stream whose version
  disagrees with what the tunnel negotiated costs that one request (`501`), never
  the tunnel.
- **`endedWithDaemon` asks "is this a *final* reason?" rather than "is this a
  daemon reason?"** An exit reason a client has never heard of now reads as
  "coming back" and keeps the composer on screen, instead of taking it away from a
  conversation that was going to return.

### Not in this release

These are the three things most likely to be assumed about a self-hosted service
at 0.1.0, and none of them is true yet.

- **No sandbox.** An agent is a child of the daemon, with your uid, your files,
  your `~/.ssh` and your other repositories. Git hooks run as you, deliberately.
  This is the product rather than an oversight — `SECURITY.md` is the whole of
  what it does and does not promise.
- **No upgrade path from anything**, because there is no earlier version. The
  first upgrade this project has to get right is the one after this release.
- **No published daemon artifact.** The daemon is a checkout and a supervisor
  unit — `deploy/install.sh daemon` — and no binary, npm package or image is
  produced for it. Only the control plane ships as an image, because only the
  control plane is a thing that may be confined.

### Known and unmeasured

Written down because a release is where somebody decides whether to run this, and
these are open questions rather than hidden ones. `docs/DECISIONS.md` group Q7
holds them in full, with what would settle each.

- `linux/arm64` is not published. Nothing has built or started this image on
  arm64, and shipping a manifest entry the checks have never exercised is not a
  trade worth taking on the process that holds the fleet's signing key.
- The upload route's body-cancel behaviour under the auth and scope middlewares
  is unmeasured, and `SECURITY.md` says so rather than implying it was checked.
- Three agent-login questions on macOS are written but unmeasured, all settled by
  one real device-code login.

[Unreleased]: https://github.com/rends-east/reemoat/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rends-east/reemoat/releases/tag/v0.2.0
[0.1.0]: https://github.com/rends-east/reemoat/releases/tag/v0.1.0
