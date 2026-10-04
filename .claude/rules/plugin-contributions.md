---
paths:
  - src/plugins/contributions.ts
  - src/plugins/manifest.ts
  - src/acp/systems.ts
  - src/acp/agents.ts
  - src/runtime/local.ts
  - packages/web/src/ui/agentCard.ts
  - packages/web/src/ui/AgentIcons.tsx
---

**What a plugin adds to `AGENT_IDS` and `SYSTEMS` for one machine, and what that machine
then offers.** `plugins.md` is the rest of the subsystem. A harness and a provider are
unlike the other four points: nothing about them runs. They are validated once at
install and read by the daemon — no `server.js` export, no view, no block. This is the
case Q7.31 and Q7.125 named as the only one justifying a registry, through a door a
person chooses rather than `REEMOAT_AGENTS`: installed under `machine:admin`, disclosed before anything is sent,
switched off with one control.

## The rung

`api: 5`, and the block is refused below it, not ignored: `readContributions` ignores
keys it does not know, so a manifest declaring `4` would install everywhere and
contribute nothing. The gate fires on a **non-empty** block, which keeps `parseManifest`
idempotent over its own output: it normalises an absent `contributes` to one carrying
`harnesses: []`, and `SqlitePluginRecordStore.toRecord` re-validates `manifest_json` on
every read, so a presence test would refuse every installed plugin at the next start.
`daemoncheck` drives the round trip.

## Invariants

**The registry and the ids**

- **`Contributions` is built from installed manifests and must exist before
  `restore()`.** Pure data (`PluginRecordStore.list()` re-validates), so no child need
  run. `ManagedSession.assembled` reads `custom_agents` through a validator that drops
  what it cannot resolve, so without it a preset on a plugin's harness would be demoted
  with `autoResume` firing. `daemon.ts` builds it right after `openStores`; `PluginHost`
  keeps it current under its single-writer gate. `REEMOAT_PLUGINS=0` builds one with
  every plugin switched off, never an empty one, so a refusal names a switch.
- **Resolvers, never a widened `Record`.** Under `noUncheckedIndexedAccess`,
  `machine.system(id)` makes each miss a visible `null` arm rather than a castable
  `| undefined`. `pinNativeModel` matters most: `openResumed` must never refuse.
- **Membership where nothing exists yet; shape where the row is the memory.**
  `POST /sessions` and `POST /custom-agents` ask the live catalogue. `fromRow` and
  `readCustomAgent` ask `isContributedId`: they run at boot before the host opens, and a
  membership test there would delete every session, preset and saved key of a plugin
  somebody switched off. (`custom_agents.harness` is validated, `agent_strip.ref` never.)
- **Three answers**: `harnessState`/`systemState` are `enabled | disabled | unknown`.
  Switched off is a `503` naming a switch; never existed is a `400`.
- **Ids are `<pluginId>:<localId>`, applied by the daemon, never written by an author.**
  A built-in has no colon and `plugins.id` is a primary key, so nothing collides, and the
  shape is recognisable without a registry. `MAX_STRIP_REF_CHARS` is 96: two 32-character
  halves and a colon is 65, and `PUT /agent-strip` stores it.
- **A provider may only name a harness the same plugin contributes**, or a manifest could
  head a card "Sign in to Claude Code" and, through `nativeModelPrefix`, assert two
  vendors' model lists are the same models (Q3.488).
- **Eight contributed harnesses per machine, refused at install, never trimmed.** Each is
  a process on `GET /agents/capabilities`, which fans out two at a time holding both ask
  slots, so every `model.complete` answers `model_busy` meanwhile. A silent drop is
  `ClampedView.substituted`'s failure, and a partial read would need a third wire state:
  an empty `{models: [], routing: null, error: null}` is what `hostable` reads as a real
  refusal.
- **`parseManifest` depends on the built-in tables**, and stored manifests are
  re-validated on every read: a release whose new built-in reads a variable a plugin
  claimed makes that plugin drop out of `records.list()` at the next start. Nothing is
  deleted (row, tree and data stay; the credential sweep is by prefix). Adding a built-in
  owes a look at what the fleet has installed.

**Sign-in and credentials**

- **No sign-in flow, by refusal.** A contributed harness is opencode's shape: `no_flow`,
  no wizard, no status probe, a paste box. Every `AGENT_LOGIN` field is a measurement
  about a CLI, and a manifest status pattern would be an archive's regex on the event
  loop. `executableEnv` is refused, since `resolveLoginBinary` reads it for every agent.
- **A harness no provider speaks for has its own row under Sign-ins** (`unspokenFor`,
  pure); that row is where `AgentDetail` draws its `envNames` (saved over
  `PUT /agent-auth/:agent`) when no system's card does
  (a system card mounts it only for `system.loginVia !== null`). The test is "no provider
  speaks for it", not "contributed": every built-in is some system's `loginVia`, so a
  machine with no plugins draws what it drew before, with no claude-beside-Anthropic
  double row (`MachineSystemsSection`). `envNames: []` gets no row. The badge says **key
  saved**, never *signed in*; `loggedIn` is `null` for all of them. Q3.540.
- **An uninstall sweeps both credential tables by id prefix; an update sweeps neither.**
  `prune()` names neither table. Prefix, not the manifest's ids: `records.get(id)` is
  `null` for a row this build cannot re-validate while `installed()` asks `records.has`,
  so `doRemove` proceeds for it; a prefix also catches slots an earlier version declared.
  Only `doRemove`. An update that drops a contribution is reported through `onWarning`,
  never refused (`consentGap` compares one direction).
- **`DELETE /agent-auth/:agent` removes before it validates and answers `200` with what
  the lookup saw** — both halves, as `DELETE /systems/:system`. A switched-off plugin's
  harness leaves `GET /agent-auth` in the same tick, and this must still reach its saved
  key; a remove answering `400` skips both invalidation steps.
- **`RESERVED_COMMANDS` covers the whole argv, word by word, not `argv[0]`**: `env claude`
  and `sh -c "exec claude"` would spawn the operator's signed-in CLI; `--profile=codex`
  is untouched. It cannot be complete, so the argv is on the consent card in full and in
  `consentGap`.
- **`AgentAvailability.lastStartRefusal` is an observation, not a declaration**: what the
  daemon saw opening a session. Never a manifest field and never `loggedIn` (permanently
  `null` here; its `false` is read by `admit`, the gate in front of the only spawn that
  clears the record). `syncContributions` drops every refusal on install, update, remove,
  enable and disable. Q2.221; the lifecycle is `agent-login.md`'s.
- **Declined: `requiresKey` in the manifest.** A harness signed in by running its own
  program has no stored key here and starts fine. Seam: `HarnessContribution`. Q7.127.
- **The machine probes a contributed harness itself at install, update and enable**:
  `probeContributed` fires the existing capability read (a real handshake and
  `session/new`) so the answer is on `GET /agents` before anybody taps. Detached, so
  `POST /plugins` does not wait under `exclusive()`. Not on remove, disable or boot (boot
  would spawn ahead of `autoResume`). Q1.624.

**Where a base URL may point**

- **`baseUrl` is https anywhere, or http to this machine or network** — loopback,
  RFC1918, ULA, `.local`/`.internal`/`.home.arpa` — and never a metadata address under
  either scheme (`169.254.169.254`). The opposite of `net`'s allowlist in the same file, and its comment says
  so: that list is a plugin's own outbound; this is where the operator's key goes.
- **A metadata service is refused by name as well as by address**:
  `metadata.google.internal` (which `isPrivateHost` accepts as `.internal`), and
  `[::ffff:a9fe:a9fe]`, the spelling the dotted-quad arm never sees.
- **`consentGap` compares a fourth field, `adds`**: the string the screen draws, so
  nothing renders twice, carrying the whole normalised base URL (an origin comparison
  passes `https://api.groq.com/../evil`). An older client sends no `adds` and is refused
  with `plugin_consent_broken`, which it already renders.

## The client's half

- **`AgentId` is a string; `AGENT_IDS` is still the six built-ins.** `AGENT_LABEL` (read
  by `webcheck` as source text), `AgentGlyph`'s `never` arm and `startsBare`'s built-in
  arm depend on that list staying closed.
- **`AgentGlyph` narrows with `isBuiltinAgentId` before it switches**, or the `never` arm
  checks nothing. A contributed harness draws a monogram off the local half of its id,
  derived from `agent` alone so the element keeps two props (`webcheck`'s two pinned JSX
  call sites).
- **A label is never the daemon's `displayName`**, a log line naming the program.
  `harnessName`: this product's table, then the manifest's `label` bounded, then the id.
- **A failed listing leaves `null`, never `[]`**: `harnessRows` is `agents ?? AGENT_IDS`,
  and `null` also keeps the address's seed recoverable.
- **Bound the noun, never filter it.** `noJargon` polices this app's templates, not the
  nouns put into them (`CREDENTIAL_LABELS` already draws "Anthropic API key").
  `boundedName` trims, collapses whitespace, strips C0/C1, bidi and zero-width controls
  (`U+061C`, `U+200B`, `U+2060`, `U+FEFF`, `U+00AD`, which `\s` misses), and cuts at
  `MAX_HARNESS_NAME_CHARS` by character, never through a surrogate pair.
- **Every sentence naming a harness takes `nameOf`**: `hostable` and `choiceRefusal`
  default to `agentLabel`, which answers a raw id. `SessionView` cannot be given one, so
  it does not name the harness.
- The `http` notice is a fact about a `system ` line, never a harness argv.
- **A plugin adds a harness and a provider, never an agent.** `standalone` is removed from
  `HarnessContribution`, `AgentAvailability`, `wire.ts` and `startsBare`, which answers
  `false` for every contributed id. A manifest still carrying the key installs and the key
  is not read; `daemoncheck`'s fixture declares it. Q3.522, Q3.539.
- **`AgentRouting.pinsModel` absent means `true`**, the opposite of
  `SystemInfo.routable`: a daemon too old to send it has no contributed harness. It lets
  the client express `hostable`'s fourth arm.
- `supportingHarnesses` takes the listing, never `AGENT_IDS`. `harnessSubline` falls back
  to the plugin's name.
- **The builder does not trust `/agent/:m/from/:harness` until the machine confirms it**,
  but the row it fills does not wait: `harnessRows` falls back to the six built-ins while
  `GET /agents` is in flight. Q3.528.
- **A contributed harness reaches stance `no_login`, never `unchecked`**: the daemon sends
  `login: {blocked: "no_flow", …}`; without it `agentStance(true, null, undefined)`
  answers `unchecked`.
- `stripKey` is safe because `kind` is a fixed two-member set and the key is only joined
  and compared, never split.

## The example, and the second repository

- **`rends-east/reemoat-plugin-byo`** (Gemini CLI as a harness, DeepSeek as a provider, no
  scope that gates a method) is a repository of its own so that installing it exercises
  `POST /plugins/source`, the consent card and the catalogue; `plugins/board/` stays here
  because `docs/PLUGINS.md` walks it. What it rests on: `gemini --acp` (Gemini CLI 0.53.0;
  `--experimental-acp` is the deprecated spelling) answers `protocolVersion: 1` and
  declares no `providers`, so its manifest names no `routedModelEnv`.
  `api.deepseek.com/anthropic/v1/messages` speaks Anthropic's envelope and reads both
  `x-api-key` and `authorization: Bearer`; Groq and Cerebras serve no Anthropic shape
  there.
- **`RESERVED_COMMANDS` and `RESERVED_ENV_NAMES` are derived** from `AGENT_IDS`,
  `AGENT_LOGIN`, `SESSION_SCOPED_ENV` and `SYSTEMS`, and the catalogue's hand mirror of
  `parseManifest` can only hold a literal. So adding a built-in agent is a change in two
  repositories; the catalogue's driver imports these `acp` modules and prints a skip
  where this repository is absent.
- **A manifest-contract change is a change in two repositories, removals included.**
  `services/plugins` mirrors `parseManifest` by hand: a field removed here but still
  validated there makes the market reject plugins every daemon accepts, and until the
  mirror learns rung 5, the `harness` and `system` scopes and both blocks, it refuses
  such a manifest (`unknown scope "harness"`). Ship order is `plugins.md`'s. Q4.105.

## What is deliberately not built

- **A sign-in wizard.** Seam: `AGENT_LOGIN`'s row shape and `AgentLoginRuns`.
- **A model catalogue a contributed provider publishes.** `connect-src` is built once at
  control-plane startup from env, and `relaycheck` asserts it in both instance shapes.
  `openrouter.ts`'s `OPENROUTER_SYSTEM_ID` is the seam and the only browser-fetched
  catalogue. The browser fetches nothing a plugin author named.
- **An icon**: `img-src` would have to name the plugin's origin; the monogram is the
  answer.
- **A binary inside the archive, or from an npm package.** `PATH` only.
- **`pincheck` covering a contributed harness.** A manifest names whatever is on PATH
  under a name somebody chose, and `Session.start`'s timeouts are the whole bound. Q4.114.
