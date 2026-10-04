---
paths:
  - src/acp/systems.ts
  - src/agentask.ts
  - packages/web/src/agents.ts
  - packages/web/src/ui/AgentBuilder.tsx
  - packages/web/src/ui/AgentIcons.tsx
---

## A harness is not a system

A *harness* is the CLI that runs the loop; a *system* is who serves the model and who
you sign in to. A harness is pointed elsewhere with ACP's `providers/set`
(`acp.methods.agent.providers.set`) between `initialize` and `session/new`; its
configuration is process-scoped and applies to later sessions, which matches one
adapter per session. Never an environment variable, never `~/.codex/config.toml`
(`acp/agents.ts`'s reason). Q7.114.

| Adapter | `agentCapabilities.providers` | `providerId` | `supported` |
|---|---|---|---|
| `claude-agent-acp` 0.73.0 | `{}` | `main` | `anthropic`, `bedrock`, `vertex` |
| `codex-acp` 1.8.0 (1.1.9: `custom-gateway`) | `{}` | `openai` | `openai` |
| `kimi`, `opencode`, `grok`, `cursor-agent` | absent | — | `-32601` (grok: no method) |

- **`providerId` is read off the agent's answer, never written down** (`acp-agents.md`'s
  "by `category`, never by `id`").
- **Marker and call are read separately, and both are needed.**
  `agentCapabilities.providers` is an empty-object marker compared `!= null`, never
  `=== true`; it says only that the methods exist. Accepted protocols are on
  `providers/list` alone. `AcpClient.routing()` answers `null` on every failure,
  including a marker that said yes and a call that said no.
- opencode is the native side of two systems with no sign-in: `agent-catalogue.md`.
- grok has no marker signed out or keyed, so `SYSTEMS.xai` names it a `nativeHarness`
  with `baseUrl` null. Signed in by `grok login`, an `authenticate` is harmful.
  `ACP_AUTH_METHOD` is which id spends a pasted key, `SessionRuntime.authMethod`
  whether there is one; `agent-login.md`, `acp-agents.md`. Q6.110.

## A published list is names, not models

Read through `AgentAskRuns.capabilities`, **ids and names both**: kimi publishes
`kimi-code/kimi-for-coding` (**K2.7 Coding**), `kimi-code/k3` and others while
answering `null` to `providers/list`. Q3.480.

- **`source` is about names, never models.** The two routes into Moonshot overlap in
  models, not spellings — Kimi Code runs a K2 — so a sentence from `source` may say only
  that a **name** is absent, which is what `pairFailure` answers. Q3.486.
- **The two lists are two products** (`~/.kimi-code/config.toml`): Kimi Code talks to
  `api.kimi.com/coding/v1` (subscription, plan-scoped names); `SYSTEMS.moonshot` routes
  at `api.moonshot.ai/anthropic` (pay-as-you-go, public ids). Nothing asserts any pair
  is the same model, so they are never merged; a wrong equivalence silently runs a
  model the row does not name. Q3.488.
- **A refusal names the missing name, never the one to use instead**:
  `<harness> has no model called <model>.`
- **The CLI's refusal is driven**: `kimi acp` answers `session/set_config_option` with
  an unpublished id with `RequestError: Internal error`, so a greyed row is kimi's
  fact. Q3.487.
- **The key.** No harness chosen: a **table** spelling runs only routed and needs the
  pasted key — always; a **published** one proves its native harness keyed — never
  (Q3.499). Harness chosen: the pairing decides, and since `nativeModelPrefix` relates
  a system's two spellings, a row opencode published can run routed and then needs the
  system key. Q3.514.

## How a model is named

- **Routed:** `ANTHROPIC_MODEL` at spawn plus `ANTHROPIC_CUSTOM_MODEL_OPTION`. The
  doors tried and the two set are at `ROUTED_MODEL_ENV` in `src/acp/systems.ts`; the
  undocumented one alone lets a CLI update remove the feature silently. Measured, not
  read off source (`applyAvailableModelsAllowlist` misleads). A plugin harness names
  its own variables — `plugin-contributions.md`.
- **Native:** `session/set_config_option` under `category: "model"`, after
  `session/new` **and after `session/resume`** (both publish `configOptions`), validated against what this agent just
  published, never a cache. The table picks the door, never a call site, on every
  launch.

## Invariants

- **No request names a base URL, a header name or an environment variable** (the
  property `AGENT_LOGIN` claims): it names a `SystemId` and a table resolves it, or a
  caller could point somebody's key at its own host through the relay. A plugin's
  `plugin.json` may add a row (fetched from one hardcoded host at a 40-hex commit after
  a consent screen, fixed for that install), so reachable hosts are not a constant of
  this repository. `plugin-contributions.md`.
- **The credential travels in `providers/set`'s headers, never in the environment this
  daemon spawns — one hop, not secrecy.** `claude-agent-acp` folds the headers into
  `ANTHROPIC_CUSTOM_HEADERS` and `ROUTED_MODEL_ENV` permits only `claude`, so a routed
  key is as exposed as a pasted one (`acp/systems.ts`). `daemoncheck` asserts only this
  daemon's boundary.
- **`hostable` is the only place the matrix exists, on each side**: two agent answers
  plus a table row, never written out, driven as a sweep over the whole matrix.
- **Routable and un-pinnable must refuse**: `hostable` folds in `ROUTED_MODEL_ENV`, or a
  pairing quietly runs the endpoint's default. It fires only on a launch carrying the
  routing options: with `options.system` absent `applySystem` returns at its first line
  and `spawnEnvOf` returns `{}`, so a site that drops the system passes every guard and
  `SystemRoutingError` cannot fire. The bag lives in `ManagedSession.launchOptions`
  alone. Q2.215.
- **On a native pairing the refusal is `pinNativeModel`'s**, called from both
  `Session.start` and `Session.openResumed` (Q2.217). It answers rather than throws;
  `start` wraps it in `SystemRoutingError` (502); `openResumed` resumes anyway and
  pushes one `error` event with `data.code` `model_not_pinned`, naming the model asked
  for and the one it came back on, since refusing would strand the conversation
  (Q2.216). "No longer offered" is not "not on it": `pinNativeModel` answers `null` for
  the second (Q2.220). So a pairing `POST /sessions` refuses is resumable, by decision;
  assert both arms.
- **`methodNotFound` on `providers/set` fails the start**, `502 system_not_routable`, no
  fallback arm. It fires after `registry.create` has made the workspace, like
  `agent_auth_required`; `AgentAvailability` catches the commoner case earlier.
- **A model is never validated against a table**; the agent or provider refuses it at
  use, by name. The only bound is a length.
- **`sessions.agent` still holds the harness.** A custom agent is a reference in
  `sessions.custom_agent`, resolved at every launch through a thunk, so editing a
  preset changes its sessions and `resolveAgent`, resume, `signOutSessions` and restore
  never see the column. A preset deleted or re-pointed under a sleeping session resumes
  it on the bare harness: the resolver answers `{harness, system, model}` and
  `ManagedSession.assembled` **compares** the harness rather than using it. Q2.216.
- **`registry.setCustomAgents` is a setter and must be called before `restore()`**
  (`elicitationAllowed`'s argument), or a session resumes on a bare harness silently.
  The thunk's answer carries the harness, off `stores.customAgents.get(id)`.
- **The client's `hostable` is a courtesy, not the gate.** The daemon refuses on the way
  in; both sides are asserted separately on the same fixtures.

## The builder pop-up

`/agent/:machineId/:cwd`, one depth below New session, and
`/agent/:machineId/:step/:cwd` with `step` of `llm` or `harness` per choice; both
optional, no placeholder, since a `cwd` is an absolute POSIX path (Q3.475). An edit is
`/agent/:machineId/edit/:presetId[/…]` at the same depth; the marker is the literal
`edit` (the client holds no copy of the daemon's id generator), and an unreadable
address degrades to the new-agent screen.

Leaving New session may not discard the walked-to folder:

- **The address follows the picker**: `NewSession` replace-navigates to
  `newPath(machine, cwd)` on every folder change; `depthOf` answers the same depth.
- **`upFrom` rebuilds the picker from the builder's own segments**, never `under`
  (`marketUpFrom`'s `origin` trap); nothing in `history.state`. `newSessionPath` and
  `agentBuilderPath` live in `nav.ts`, re-exported by `router.ts`.
- **The new agent comes back through `agentPick.ts`**, a module `Map` in `echo.ts`'s
  shape, **taken rather than read**: `rememberPick`/`takePick` (replaces the listing)
  and `rememberRemoval`/`takeRemoval` (withdraws a selection); a machine can hold both.
- **The choice is held per machine in `StartSheet`, not `NewSession`** (which unmounts
  for `/agent`). A `picksRef` is written before `setPicks` so the `GET /agents` handler
  reads the tap as of the tap (`store.daemonFor` is stable per machine). The listing's
  default stays in `NewSession`, never in the map. `offeredHere` weighs what is drawn
  every render — a harness present **and** `available`, a preset still in
  `GET /custom-agents` — so a deleted preset ends as nothing chosen and a disabled
  `Start`, never a substitution. Q3.482.
- One `Sheet` for the pop-up, mounted once by `App.tsx` for both routes; `StartSheet`
  owns the panel, `Suspense` inside it. The action bar is inside `SHEET_BODY` via
  `SHEET_SCREEN` + `SHEET_SCROLL`, never `Sheet`'s `footer`, or the
  `view-transition-name: sheet-body` box morphs mid-slide. Q3.472.
- The head names the act ("Configure agent"), with ◀ as an unlabelled glyph at
  `size="sm"`, its label from `upFrom`, unpainted. Q3.473, Q3.476.

## The three screens

- **No picker holds the answer**: `AgentBuilder` owns harness, model and name; a picker
  reports through `onPick`. Both reads happen once, in the flow
  (`GET /agents/capabilities` starts an agent per harness).
- Both lists carry a search box, only the model list a filter. The harness opens
  unchosen. Q3.478.
- **Nothing is filtered out for being unusable**: `searchModels` takes the query; the
  refusal is the row's subline.
- **The model screen refuses a pairing on the provider heading, never per row**; each
  field can be emptied on the screen above. A row says only what is about the row: a
  spelling of the other route in, or a system with no key. Q3.479, Q3.497, Q3.499,
  Q3.512.
- **Could not be asked is not refuses.** `routing: null` means either;
  `capabilities[id].error` is set only when the ask failed, and is read first. Q3.482.
- **A key belongs to the pairing; the build screen has no authorization.** `keyMissing`
  asks the pairing and both screens grey from that call. Its sentence names the system,
  states no route (a `ChoiceRow` subline is one `truncate`d line), and is drawn
  untruncated beside the button; the key is pasted under Settings → Machines → *system*.
  `AgentBuilder` mounts no credential control and no word from one; on the harness
  screen it guards the row and the write. Q3.485, Q3.497, Q3.499.

**Every refusal is a sentence, uses no word from the wire, and both its nouns are on
its screen.** Pairing sentences name harness and model, dropping the harness on a row
titled with it; the no-key one names the system. `webcheck` pins the strings, a
`noJargon` predicate, and the absence of the wrong words. Q3.474, Q3.483.

| `pairFailure` | Drawn as | On a row titled with the harness |
|---|---|---|
| `"host"` — cannot be *pointed at* the system | `<harness> cannot run <model>.` | `Cannot run <model>.` |
| `"name"` — can, but the spelling is the other route's | `<harness> has no model called <model>.` | `No model called <model>.` |
| neither, routed pairing with no key — weighed **last** | `No <system> key on this machine.` | unchanged |

`harnessRowRefusal` and `choiceRefusal` order identically, settled failure first, with
`hostable` checked first; rows in the same situation read identically. Q3.497. **"has no model *called*" is load-bearing**: without
"called" it claims the harness lacks the model; naming the harness's spelling asserts
the equivalence. One sentence covers both directions; `hostable`'s "Only <X> can run
<Y> models." differs because its remedy does. Q3.486, Q3.488.

`hostable` asks "can this harness be pointed at this system" and its sentence is the
daemon's `502 system_not_routable`; `choiceRefusal` asks "can it run this model", calls
`hostable` for the answer and drops its words. Never forward one as the other.

**The name is a value, not a field**: a heading with a pencil, the input borderless and
transparent in place, never `FIELD`'s box. Emptying it hands the name back to the
model; a commit that changed nothing reports nothing. Q3.476.

Provider headings and per-row harness glyphs: `agent-catalogue.md`.

## Where the cost is

Per-cell cost is empirical, not structural (Q7.31). Routed rows come from vendors'
published Anthropic-compatible endpoints and are **not driven end to end**: a wrong
header shows as a 401 from somebody else's API. A row cannot be detected keyless (the
endpoints disagree on conventions; OpenRouter excepted). Per-row evidence is in
`SYSTEMS`.

## Layout

| File | Holds |
|---|---|
| `src/acp/systems.ts` | The table, the compatibility rule, both halves of a routed launch, the store ports, `MachineCatalogue` (what a machine offers against what ships) |
| `src/agentask.ts` | One spawn, two answers; `AgentCapabilityReader` is `server.ts`'s port, drivable with no agent |
| `packages/web/src/agents.ts` | The client's refusals, catalogue and default name, DOM-free for `webcheck` |
| `packages/web/src/ui/AgentBuilder.tsx` | The flow. A stored preset is a third read outside the `Promise.all`, so a daemon without `GET /custom-agents` keeps the new-agent flow |
| `packages/web/src/ui/AgentIcons.tsx` | Our glyph per harness, not vendor marks; exhaustive over shipped ones, a monogram for a plugin's |
| `packages/web/src/ui/settings/SystemsPanel.tsx` | A system's configuration and `KeyOnly`, mounted twice, routed and not; the builder mounts none. Q3.497 |

## Bounds

| | |
|---|---|
| A system key | 8 KiB, the pasted agent credential's constant |
| An assembled agent | 80 chars of name, 256 of model id |
| `GET /agents/capabilities` | One process per harness, no prompt, cached `MODELS_TTL_MS` (10 min) or until the build changes, under `MAX_CONCURRENT_ASKS` (2) |
