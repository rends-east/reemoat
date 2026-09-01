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

**What a plugin adds to the two tables this repository ships, and what a machine
then offers.** `plugins.md` is the plugin subsystem's own half — what a plugin may
*do*, what bounds it, who is told about what — and it sent this subject here when it
hit its size ceiling, which is the signal that budget exists to give.

Two contribution points, and they are unlike the other four: **nothing about them
runs.** A harness and a provider are validated once at install and then read by the
*daemon*, so there is no `server.js` export, no view and no block. What they do
instead is widen `AGENT_IDS` and `SYSTEMS` — the two tables this product ships — for
one machine.

**Q7.31 and Q7.125 declined a registry twice and named what would justify one**:
*"an agent this repository does not vendor and cannot measure — `REEMOAT_AGENTS`, an
operator's own ACP binary."* This is that, through a better door: a plugin is chosen
by a person, installed under `machine:admin`, disclosed before anything is sent, and
switched off with one control — none of which an environment variable does.

## The rung

`api: 5`, and the block is **refused** below it rather than ignored. That looks like
v2 — new fields on an existing object — and behaves like v3, which is the whole
distinction: `readContributions` reads the keys it knows and ignores the rest, so a
manifest declaring `4` installs cleanly *everywhere* and contributes nothing. Unlike
a lost `refreshMs` there is no degraded half still running, because the harness **is**
the plugin.

⚠ **The gate fires on a *non-empty* block, and that is what keeps `parseManifest`
idempotent over its own output.** It normalises an absent `contributes` into one
carrying `harnesses: []`, and `SqlitePluginRecordStore.toRecord` re-validates
`manifest_json` through it on **every read** — so a presence test refused, on the
second read, every plugin it had itself accepted on the first, and every installed
plugin vanished from `GET /plugins` at the next daemon start. `daemoncheck` drives the
round trip.

## Invariants

**A harness and a provider**

- **The registry is `Contributions`, built from installed *manifests*, and it must
  exist before `restore()`.** Pure data — `PluginRecordStore.list()` already
  re-validates each manifest — so no child process has to be running, which is what
  makes it available at boot. ⚠ The reason is stronger than
  `setCustomAgents`-before-`restore()`: `restore()` rebuilds every session and
  `ManagedSession.assembled` reads `custom_agents` through a validator that **drops**
  what it cannot resolve, so a preset on a plugin's harness would be dropped and its
  sessions demoted to a bare harness, with `autoResume` firing inside the window.
  `daemon.ts` builds it immediately after `openStores`; `PluginHost` keeps it current
  under its own single-writer gate. **`REEMOAT_PLUGINS=0` builds one in which every
  plugin is switched off, never an empty one** — the rows stay, so a refusal names
  a switch instead of blaming the caller — and a
  contributed harness *is* a program this daemon spawns.
- **Resolvers, never a widened `Record`.** `noUncheckedIndexedAccess` makes a
  `Record` over a literal union index totally today and an index signature the moment
  the union widens, so every `SYSTEMS[id]` would have become a `| undefined` a cast
  could swallow. Going through `machine.system(id)` makes each a visible `null` arm —
  the difference between a `TypeError` on the **resume** path and a sentence naming
  the plugin. `pinNativeModel` is the one that would have thrown: `openResumed` is
  designed never to refuse.
- **Membership where nothing exists yet; *shape* where the row is the memory.**
  `POST /sessions` and `POST /custom-agents` ask the live catalogue, so a refusal is
  free. `fromRow` and `readCustomAgent` ask `isContributedId` — they run at boot,
  before the plugin host has opened, and a membership test there would delete every
  session, preset and saved key belonging to a plugin somebody switched off an hour
  ago. That is `custom_agents.harness` (validated) against `agent_strip.ref` (never
  validated), applied to the case between them.
- **Three answers, not two.** `harnessState`/`systemState` are
  `enabled | disabled | unknown`, because "switched off" is a `503` naming a switch
  and "never existed" is a `400` saying *fix your request* — and telling somebody
  their own address is wrong about a request that worked yesterday sends them looking
  for a bug in their own code.
- **Ids are `<pluginId>:<localId>`, applied by the daemon and never written by an
  author.** A built-in id has no colon, so a collision is impossible by construction;
  two plugins cannot collide because `plugins.id` is a primary key; and the shape is
  recognisable *without a registry*, which is what the previous bullet rests on.
  `MAX_STRIP_REF_CHARS` had to move from 64 to 96 — two 32-character halves and a
  colon is 65, and `PUT /agent-strip` is the one write that screen makes.
- **A provider may only ever name a harness the same plugin contributes.** Otherwise
  a manifest could put *"Sign in to Claude Code"* under a heading its author chose,
  and — through `nativeModelPrefix` — assert that a vendor's two model lists are the
  same models, which is the equivalence Q3.488 refuses without evidence.
- **No sign-in flow, and it is a refusal rather than a gap.** A contributed harness
  is opencode's shape: `no_flow`, no wizard, no status probe — a paste box and
  nothing else. ⚠ **That box had nowhere to be drawn, and the fix was the list
  rather than the manifest.** `AgentDetail` is the one component that draws a
  harness's `envNames`, and the only screen that mounted it for a wizardless
  harness was a **system's** card, gated on `system.loginVia !== null`. opencode
  reaches its own because OpenRouter and OpenCode Zen both carry
  `loginVia: "opencode"`; a plugin declaring only routed providers — `baseUrl` set,
  `loginVia` null, the example plugin's own shape — left `envNames` a slot the
  daemon accepts over `PUT /agent-auth/:agent` and no screen ever offered.
  Reported: `GEMINI_API_KEY` could be typed nowhere at all. Q3.540. Every
  field an `AGENT_LOGIN` row carries is a *measurement about a CLI* this repository
  cannot take on somebody's behalf, and a manifest-supplied status pattern would be
  a regex from an archive on the event loop — the hazard `pattern` was dropped from
  elicitations for. `executableEnv` is **refused**, not merely absent:
  `resolveLoginBinary` reads it for every agent.
- **An uninstall sweeps both credential tables by *prefix*, and an update sweeps
  neither.** `prune()` names neither table, and once the row is gone neither id is
  listed anywhere — so what skipping it leaves behind is not litter, it is a third
  party's API key in a plaintext column nothing lists and nothing collects. ⚠ **The
  prefix is what makes it work; the manifest's own list of ids does not.** Those ids
  came from `records.get(id)`, which answers `null` for a row this build cannot
  re-validate — while `installed()` deliberately asks `records.has`, so `doRemove`
  proceeds for exactly that row and swept nothing. A prefix needs no manifest, and it
  also catches a slot an *earlier* version of the plugin declared. Only `doRemove`,
  which is what keeps "an update keeps what the plugin kept" true of a saved key as
  well as of a board. An update that **drops** a contribution is reported through
  `onWarning` and never refused: retiring a harness is legitimate, and `consentGap`
  cannot see it — that compares one direction on purpose.
- ⚠ **`DELETE /agent-auth/:agent` removes before it validates *and answers `200`
  with what the lookup saw*.** Both halves, or neither: a route that removes and then
  answers `400` has the row gone, the caller told its request was wrong, and both
  invalidation steps skipped — a cached `loggedIn: true` over a harness whose only
  credential has just been deleted, and a running session still holding the secret.
  This is `DELETE /systems/:system`'s shape, and it is needed here for the same
  reason: a plugin's harness stops being *offered* the moment somebody switches that
  plugin off, and `GET /agent-auth` stops listing it in the same tick, so the one
  control that can reach its saved key must not disappear with it.
- ⚠ **`RESERVED_COMMANDS` covers the whole argv, not `argv[0]`.** `env claude` and
  `sh -c "exec claude"` both walk past a check on the program name and spawn the
  operator's *signed-in* CLI, with its credentials, under a row the consent screen
  labels with the plugin's name. Word by word rather than by substring, so
  `--profile=codex` is untouched. It cannot be complete, which is why the argv is on
  the consent card in full and in `consentGap`; what it closes is the shape a reader
  of that card would not think to look for.
- ⚠ **A metadata service is refused by *name* as well as by address, under either
  scheme.** `metadata.google.internal` resolves to `169.254.169.254`, and
  `isPrivateHost` returns `true` for anything ending `.internal` — so without the
  name list the `http` allowance and the metadata refusal failed on the same string.
  `[::ffff:a9fe:a9fe]` is the other spelling `URL` produces and the dotted-quad arm
  never sees.
- ⚠ **`parseManifest` now depends on the built-in tables, and every stored manifest
  is re-validated on every read.** The release that adds a fifth built-in reading a
  variable some plugin had claimed makes that plugin unreadable and it drops out of
  `records.list()` at the next start. Nothing is *deleted* by the drop — the row, the
  tree and the data stay, and it returns the moment the manifest is readable — and
  the credential sweep is by prefix, so an uninstall still reaches its keys. What is
  owed on the day a built-in is added is a look at what the fleet has installed.
- **`consentGap` compares a fourth field, and it is what makes an older *client*
  safe.** A browser deployed before this feature draws no row for a contribution and
  goes on working, which guarantees it under-discloses; there is no fix on that side.
  It sends a consent with no `adds`, so the daemon refuses with `plugin_consent_broken`
  — the existing code, deliberately, because the old client already renders it. The
  compared value is **the string the screen draws**, so there is no second rendering
  to drift, and it carries the *whole* normalised base URL: a plugin showing
  `https://api.groq.com` and shipping `https://api.groq.com/../evil` passes an origin
  comparison.
- **`baseUrl` is https anywhere, or http to this machine or this network** — loopback,
  RFC1918, ULA, `.local`/`.internal`/`.home.arpa` — and **never** a metadata address
  under either scheme. ⚠ This is the *opposite* decision from `net`'s allowlist in the
  same file, and the comment there says so: that one refuses a local target in a
  plugin's own outbound list, where it is a mistake; this is where the **operator's**
  pasted key goes to a model they named, and a private address is the one case where
  they plainly mean it.
- **Eight contributed harnesses per machine, refused at install.** Each is a process
  on `GET /agents/capabilities`, which fans over every harness two at a time and holds
  both ask slots for the sweep — so while anybody has the builder open, every plugin
  `model.complete` on the machine answers `model_busy`. Refused rather than trimmed:
  a contribution dropped in silence is `ClampedView.substituted`'s failure again, and
  a partial read would need a third wire state, since an empty
  `{models: [], routing: null, error: null}` is what `hostable` reads as a real refusal.
- ⚠ **A contributed harness can carry a *negative* now, and it is an observation
  rather than a declaration.** `AgentAvailability.lastStartRefusal` is what the
  daemon saw when it tried to open a session — not a manifest field, and never
  `loggedIn`, which for these harnesses is permanently `null` and whose `false` is
  read by `admit`, the gate in front of the only spawn that could ever clear the
  record. `syncContributions` drops every refusal on install, update, remove, enable
  and disable, because a harness whose command and environment may all have changed
  is not the harness that refused. Q2.221; the lifecycle is `agent-login.md`'s.
- **Declined: `requiresKey` in the manifest.** More elegant, needs no memory, and
  fixes no already-installed plugin — and it is wrong for the case it looks right
  for, since a harness signed in by running its own program on the machine has no
  stored key here and starts perfectly. That is what the example plugin's own
  `authHint` tells somebody to do. The seam stays open at `HarnessContribution`.
  Q7.127.
- **A harness no provider speaks for has a row of its own under Sign-ins.**
  `unspokenFor` is the membership rule and it is pure. ⚠ **"No provider speaks for
  it" rather than "it is contributed"**, because every built-in is named by a
  system's `loginVia` and adding them all would put claude beside Anthropic — two
  rows, one credential, two answers to *signed in?*, which is the shape
  `MachineSystemsSection` exists to remove and says so in its own docblock. So a
  machine with no plugins draws exactly what it drew before. `envNames: []` gets no
  row either: a row opening an empty card is a control that is not true in the
  state it is drawn in. The badge says **key saved** rather than *signed in* —
  these are precisely the harnesses with no wizard, and `loggedIn` is `null` for
  all of them.
- ⚠ **The machine asks the harness itself, at install, update and enable.** "The
  daemon does not know until somebody presses Start" is not an acceptable state for
  a machine that has just been told about a harness — and the refusal record is
  written by `Session.start`, so what was missing was an *occasion* rather than a
  mechanism. `probeContributed` fires the existing capability read, which is a real
  handshake and a real `session/new`; nothing reads the result, because whichever
  way it goes the answer is on `GET /agents` before anybody taps anything.
  Detached, or `POST /plugins` would hold its answer for the length of somebody
  else's binary starting up, under `exclusive()`. **Not on remove, disable or
  boot**: the first two have nothing to ask about, and boot would put a spawn per
  contributed harness in front of `autoResume`, which is already starting an agent
  per interrupted session. Q1.624.
- **The control plane hosts nothing.** No sessions, no files, and its image is
  rebuilt by a release — "installing" there would be a deploy. Q4.104.

## The client's half

- **`AgentId` is a string and `AGENT_IDS` is still the four.** The list of what
  *exists* and the list of what is *built in* are two questions now, and three things
  on the client depend on the second staying closed: `AGENT_LABEL` is a hand-written
  table `webcheck` reads as source text, `AgentGlyph`'s `never` arm is the only
  mechanism in the fleet that makes adding a harness loud, and `startsBare`'s built-in
  arm is a literal. All three become unsatisfiable — not merely weaker — against a
  list that grows at runtime.
- ⚠ **`AgentGlyph` narrows before it switches, or the `never` arm means nothing.** A
  `switch` over a string has no exhaustiveness to check, so writing it without
  `isBuiltinAgentId` would have deleted the guard in silence while its docblock went
  on claiming it — which is the failure that function already shipped for four
  releases. A contributed harness draws a **monogram** off the local half of its id:
  one generic mark for all of them is eight identical tiles on a strip whose titles
  `truncate` at 96px, and deriving the letter from `agent` alone is what keeps the
  element at two props, which is what `webcheck`'s two pinned JSX call sites need.
- ⚠ **A label is never the daemon's `displayName`.** That field is a log line and
  carries the program — `Claude (claude-agent-acp)`, `Kimi Code CLI` — and two of the
  four built-ins would fail this client's own rule against a label naming a package or
  ending in `CLI`. `harnessName` is the pair: this product's table, then the manifest's
  `label` **bounded**, then the id.
- ⚠ **A failed listing leaves `null`, never `[]`.** `harnessRows` is
  `agents ?? AGENT_IDS`, so an empty array defeats the fallback rather than being it:
  the picker drew its "this machine named no agents" arm with no rows and no way out,
  every model row lost its glyph strip, and the catch says nothing on purpose. `null`
  is *still asking*, which is what a failed read leaves this screen in — and it also
  keeps the address's seed recoverable, since the seed effect returns before it burns
  its guard while the listing is `null`.
- ⚠ **Bound the noun; never filter it.** `noJargon` forbids *wire vocabulary in this
  app's templates* and may not become a content filter over the nouns substituted into
  them — a provider legitimately called "Anthropic-Compatible Gateway" is truthful, and
  `CREDENTIAL_LABELS` already draws "Anthropic API key". What has to be bounded is the
  **shape**: `boundedName` trims, collapses whitespace, strips C0/C1 and bidi controls
  and cuts at `MAX_HARNESS_NAME_CHARS`, because these strings land in one-line
  `truncate`d sublines, in an `aria-label` built by joining with commas, and in
  headings on a phone. Cut by **character**, or a name whose 32nd is astral is sliced
  through a surrogate pair and drawn as `U+FFFD`; and the stripped set has to include
  the *zero-width* half — `U+061C`, `U+200B`, `U+2060`, `U+FEFF`, `U+00AD` — which
  `\s` does not match, so a name made only of those survived `trim()` and drew a
  blank, unsearchable row instead of falling back.
- ⚠ **Every sentence that names a harness takes `nameOf`.** `hostable` and
  `choiceRefusal` are DOM-free and hold no listing, so their default is `agentLabel`
  — which answers a raw id for anything it has no row for. The builder passes its own
  `nameOf`; a call site that forgets puts `acme:gemini` into the sentence standing
  between somebody and a Save. `SessionView` is the one screen that *cannot* be given
  one — it holds a snapshot and fetching a listing would be a request on the
  transcript path — so it stops naming the harness rather than naming it wrongly,
  which is the same refusal its neighbour makes about guessing a system from an agent
  id.
- ⚠ **The `http` notice is a fact about a `system ` line.** Tested over every
  contributed line it fired on a harness argv — `args: ["--base",
  "http://127.0.0.1:8080"]` is an ordinary thing for a CLI to be handed — and drew
  "one provider is reached over http" on a card with no provider on it.
- ⚠ **A plugin adds a harness and a provider. It does not add an *agent*.**
  `standalone` let a manifest claim its harness was a whole answer by itself and is
  **removed** — from `HarnessContribution`, from `AgentAvailability`, from `wire.ts`
  and from `startsBare`, which answers a flat `false` for every contributed id.
  Spelling the default as "no tile" made the wrong answer rarer without making it
  unsayable, and the claim is the one thing in that block nothing on either side can
  check: `startsBare`'s subject is the **model**, and a harness this repository has
  never run cannot be known to be its own. Getting it wrong the permissive way is
  Q3.522's failure with somebody else's binary — a session billed to the operator on
  a model nobody chose, under a tile that names none, and unlike opencode a client
  cannot even find out afterwards what it ran. It is not a demotion: the harness is
  offered everywhere a harness is named, and an agent built on it is something a
  person assembled and named, which is the only way an agent has ever been made
  here. A manifest still carrying the key installs unchanged and the key is not
  read — `daemoncheck`'s fixture declares it for exactly that reason. Q3.539.
- ⚠ **`AgentRouting.pinsModel` absent means `true`, the opposite fallback from
  `SystemInfo.routable`, and it is airtight rather than optimistic.** A daemon too old
  to send it has no plugin catalogue, so it has no harness the arm could be false for;
  answering `false` would grey Claude Code out on every un-updated machine in the
  fleet. It is what finally lets the client express `hostable`'s fourth arm, which it
  had a paragraph admitting it could not.
- ⚠ **`supportingHarnesses` takes the listing.** Reading `AGENT_IDS` there was the
  clearest way a contributed harness could have been a second-class row: no glyph on
  any model row, and **no glyphs at all** on a model only it can run — on the row whose
  whole job is to say what will run it.
- ⚠ **`harnessSubline` falls back to the plugin's name.** Empty was right while every
  harness with a row had a vendor; a contributed harness native to no provider is the
  common case, and a tile with a title and nothing under it beside tiles that have one
  is what a second-class row looks like.
- **The builder does not trust the address until the machine confirms it.**
  `/agent/:m/from/:harness` used to be weighed against a closed union at mount. Which
  harnesses exist is a fact about the machine now, and a *shape* test — the only thing
  this side could answer alone — would seed the screen with a harness that is not
  there. ⚠ **The row it fills still does not wait**: `harnessRows` falls back to the
  four this product ships while `GET /agents` is in flight, which is what keeps
  Q3.528's *argument* true rather than only its assertion.
- ⚠ **A contributed harness must reach stance `no_login`, never `unchecked`.** The
  daemon sends `login: {blocked: "no_flow", …}` for it; with no `login` object
  `agentStance(true, null, undefined)` answers `unchecked`, whose badge reads *cannot
  check* — a sentence about a probe that failed, drawn permanently over an agent that
  runs perfectly.
- ⚠ **`stripKey` is still safe and the reason changed.** Its docblock said "a harness
  id is one word, so nothing today can collide"; a contributed id carries a colon,
  inside a key built by joining on one. It cannot collide because `kind` is a fixed
  two-member set and the key is only ever joined and compared, never split — the
  ambiguity a reader would look for is one no caller can ask.

## The example, and why it is not in this tree

`rends-east/reemoat-plugin-byo` — Gemini CLI as a harness, DeepSeek as a provider,
and **no scope that gates a method**. It is a repository of its own rather than a
second directory under `plugins/`, and the reason is what the market is for: a
plugin arrives on a machine as a `{repo, commit}` somebody read the permissions of,
so an example that ships *inside the daemon* is an example of the one path nobody
uses. `plugins/board/` stays here because `docs/PLUGINS.md` walks through it line by
line; this one is meant to be **installed**, and installing it exercises
`POST /plugins/source`, the consent card and the catalogue in one go.

⚠ **Both of its entries were measured, and that is the part worth keeping here
because the plugin is not.** Measured 2026-08-30: `gemini --acp` (Gemini CLI
0.53.0) answers `initialize` with `protocolVersion: 1` — `--experimental-acp` is
the same flag, deprecated — and declares **no** `providers` capability, so it can
never be routed and its manifest names no `routedModelEnv`; claiming one would
claim something the CLI does not do. `POST api.deepseek.com/anthropic/v1/messages`
answers 401 in Anthropic's envelope, and a bogus key in *either* `x-api-key` or
`authorization: Bearer` comes back as "your api key … is invalid", so both
conventions are read. Groq and Cerebras answer **404** at the same path — they
serve no Anthropic shape, which is why neither is the example.

⚠ **`RESERVED_COMMANDS` and `RESERVED_ENV_NAMES` are *derived* here and cannot be
mirrored there, which makes them the one thing in this subsystem that drifts with no
declaration changing on either side.** They are spread out of `AGENT_IDS`,
`AGENT_LOGIN`, `SESSION_SCOPED_ENV` and `SYSTEMS`; the catalogue mirrors
`parseManifest` by hand and has no `src/acp` to spread from, so it can only hold a
literal. The day a fifth built-in reads `GEMINI_API_KEY`, this list grows by itself,
the catalogue's does not, and it publishes a plugin claiming that slot — which every
daemon then refuses at install, about a plugin the market called fine. Deriving is
still right here (a literal would drift against `AGENT_LOGIN` next door, which is the
nearer mistake); what it costs is that **adding a built-in agent is a change in two
repositories**, and the check for it lives in the catalogue's driver, which imports
these two `acp` modules directly and degrades to a printed skip where this repository
is not beside it.

⚠ **A change to the manifest contract is a change in two repositories, and
*removing* a field counts.** `services/plugins` mirrors `parseManifest` by hand, so
the coupling reads as though it were about additions — a rung the mirror has not
learned. It is not: `standalone` was deleted from `HarnessContribution` here and the
mirror went on validating it, which put the skew in the **refusing** direction —
the catalogue rejected `standalone: "yes"` and `standalone: null` while every daemon
accepted them, because an unknown key is ignored. That is Q4.105's asymmetry with
the cheap side and the expensive side swapped: not a screen saying "update your
machine", but a plugin the market calls malformed. Measured by the mirror's own
driver, two failures, one of them the field list and one the verdict comparison.
The rule is the same in both directions and the order is the same: daemons, then
the control plane, then the catalogue, with the last two out together.

⚠ **Publishing it is not a step this repository can take on its own, and the
catalogue is where that bites.** `services/plugins` mirrors `parseManifest`, holds a
`PLUGIN_API_VERSION` of its own, and its `check.ts` compares that constant against
`src/plugins/protocol.ts`. So until the mirror learns rung 5, the `harness` and
`system` scopes and the two contribution blocks, it does not merely decline to
publish — it **refuses the manifest** with `unknown scope "harness"`, which reads as
the plugin being wrong. Daemons, then the control plane, then the catalogue; the
last two are one decision.

## What is deliberately not built

- **A sign-in wizard.** Seam: `AGENT_LOGIN`'s row shape and `AgentLoginRuns`.
- **A model catalogue a contributed provider publishes.** `connect-src` is built once
  at control-plane startup from an environment variable and `relaycheck` asserts it in
  both instance shapes; a per-response policy derived from plugins installed on daemons
  the control plane has never seen is not a thing. `openrouter.ts`'s
  `OPENROUTER_SYSTEM_ID` is the seam and the only browser-fetched catalogue in this
  app. **The browser executes nothing a plugin author wrote, and fetches nothing a
  plugin author named.**
- **An icon.** `img-src` would have to name the plugin's origin; the monogram is the
  answer.
- **A binary inside the archive, or resolved from an npm package.** `PATH` only.
- **`pincheck` covering a contributed harness.** It pins adapter versions this
  repository vendors and asserts the CLI hop resolves; what a manifest names is
  whatever is on PATH under a name somebody chose, and `Session.start`'s timeouts are
  the whole bound. That difference is honest and is written down rather than left as
  an absence.
