---
paths:
  - packages/web/src/openrouter.ts
  - packages/web/src/agents.ts
  - packages/web/src/ui/AgentBuilder.tsx
  - packages/web/src/ui/agentCard.ts
  - src/acp/systems.ts
  - packages/control-plane/src/app.ts
---

## Where a model's name comes from

`agent-systems.md` answers which harness can be pointed at which system; this file
answers **whose spelling is on the row, and who fetched it.**

| Source | Read by | Reaches the picker as | Key |
|---|---|---|---|
| The harness's own `configOptions`, `category: "model"` | the daemon, `GET /agents/capabilities` | `source: "published"` | never — the agent's own login covers it |
| `SYSTEMS[id].models`, written down | the daemon, `GET /systems` | `source: "table"` | always — a table id is the *routed* spelling |
| `openrouter.ai/api/v1/models` | **the browser** | substituted into `SystemInfo.models`, so `"table"` | always |
| A plugin's `contributes.systems[].models` | the daemon, off the manifest | `"table"`, indistinguishably | always |

**The third and fourth are deliberately not new `source`s.** Each is what the endpoint
answers to when a harness is routed at it, so the key biconditional holds word for word
and `agents.ts` learns nothing about where names came from. The OpenRouter list is
substituted into the *listing* before `allModels` sees it. A contributed provider whose
own harness publishes needs no list; those rows arrive as `"published"`.

**The browser reads OpenRouter** (a catalogue on its own host, the market's shape): the
endpoint needs no credential and answers `access-control-allow-origin: *`, and the
daemon may not grow a fourth `fetch` (`compatibility.md` states the count in `src/` as
the property).

- **`connect-src` names `https://openrouter.ai` unconditionally** — every instance
  compiles the same `SYSTEMS`. Omitted, the browser refuses before a byte leaves, as a
  bare `TypeError`. `relaycheck` asserts it in both instance shapes, market or no.
- **The fetch is gated on the daemon having listed the system**, which is why
  `SystemInfo.id` is `string`: an older daemon means no third-party request at all.

**A typed id is the same substitution at the same site.** The daemon checks a routed
model against `MAX_MODEL_CHARS` only, and the table goes stale with no refresh mechanism
— a refresh is a hand edit against vendors' documentation, since the routed vendors'
list endpoints answer 401 unauthenticated (failing Q3.501's browser door) and the daemon
door is the fourth `fetch`; a plugin contributing the provider is the legal shape. The
builder draws a field at the foot of every **`routable`** provider's group; `adoptModels`
puts the id into that system's `models` as `{id, name: id}` before `allModels`, and the
row then dedupes, greys, refuses and groups with no new arm, and seeds the agent's name.
The gate is `routable === true`: a native pairing is validated at start against what
its CLI published, so a typed id there only produces refusals. **It also keeps a stored
preset editable**: `current` is a catalogue lookup and Save is gated on it, so a pick
the listed catalogue lacks is adopted — only then, since adopting a *published* pick
would hand the dedupe a table row whose name wins.

## One harness, two systems

- **opencode is the native side of OpenRouter and OpenCode Zen and publishes one list
  holding both** (`openrouter/qwen/qwen3-coder`, `opencode/big-pickle`).
  `nativeModelPrefix` divides it: a system with one takes only the published ids
  carrying it, stripped; a system with none takes everything (its harness serves one
  system).
- `SYSTEMS.zen` is `baseUrl: null` like `anthropic` and `openai`: naming its endpoint
  would offer claude a routed arm that dies on the pinning test (`ROUTED_MODEL_ENV` has
  no OpenAI-shaped door).
- **A plugin's provider may only name a harness that plugin added**: `nativeHarness`,
  `loginVia`, `keyEnv` and `nativeModelPrefix` take a local id from the same manifest.
  Naming a built-in would let a manifest assert a vendor's two lists are the same models
  and put a sign-in card for somebody else's CLI under its heading.
- **`loginVia` means whose CLI owns this system's credentials**, never where a wizard is
  (opencode has no sign-in and is named). It decides whether the system's screen draws
  that harness's card or a bare **system** key box.
- **A row that is not routable must name a `loginVia`**: a system credential is only
  spent in `providers/set` headers, so a key box on a row with no `baseUrl` would store a
  secret and never send it. `daemoncheck` sweeps the whole table for it.

## Two spellings for one model

**Only OpenRouter relates its two lists**: one catalogue behind one account, so
opencode's `openrouter/qwen/qwen3-coder` is the endpoint's `qwen/qwen3-coder`.
Moonshot's are two products (Q3.488). `SystemConfig.nativeModelPrefix` records the
relation and is the only place a stored id is respelled.

- **Everything stored, sent and shown is the endpoint's spelling**, so
  `custom_agents.model` survives a harness swap.
- **`pinNativeModel` puts the prefix back** at the last moment, idempotently.
- **`allModels` strips it** off a published id, so the lists dedupe to one row.
- **`pairFailure` reports no name failure** where a prefix relates them; both arms are
  suppressed.

**Published wins the dedupe**: its presence proves the native harness is keyed (opencode
publishes six signed out, 362 keyed), so `keyMissing` reads `published`. **The name goes
the other way**: where both exist the table's wins, since opencode publishes
`OpenRouter/Claude Opus 5`.

**Where only the harness's name exists, `withoutProviderLabel` cuts the provider's
label off the front** (Q3.507) — a third rule; it never fires with the dedupe branch.
It removes one known constant, the system's `displayName` (the heading's own string),
plus `/`: case is folded and nothing else, never a `RegExp` (`Z.ai (GLM)` is a live
`displayName`), and it fails open on a rename. Not `nativeModelPrefix`, which is the id
namespace (`opencode/`), while a name carries the label (`OpenCode Zen/`). Not the
`"<Vendor>: "` surgery `openrouter.ts` refuses, which would infer a pattern from
somebody else's prose. The remainder is a stored value — `defaultAgentName` seeds a
preset's name — so it is trimmed and an empty remainder keeps the original; saved
presets are not migrated.

**The tools filter is ours and applies to both lists.** opencode publishes OpenRouter's
models unfiltered, so `readOpenRouterModels` reports what it refused as `toolless` and
`allModels` drops a published row named in it — a list of the refused, so an unread
catalogue refuses nothing. `:batch` and malformed rows are not in it. Known limitation:
the in-session model menu still offers them. Q3.520.

## Tiles and the harness row

- **A router has no tile.** `startsBare` is false for opencode (and any plugin
  harness): a bare opencode session pins nothing and starts on `opencode/big-pickle`, a
  model nobody chose, whatever keys are saved; the others are the model they run, or
  run their person's last choice (cursor, Q3.688). It closes the tile row, the
  auto-default and a restored pick through `offeredHere`, and nothing else: `GET
  /agents`, `POST /sessions`, the CLI, the settings card and the builder's harness row
  are untouched. Not the "unavailable stays, disabled" rule — this harness runs. Q3.522.
- **A harness nobody is signed in to has no tile.** `offersTile`: `not_installed` and
  `signed_out` out; `signed_in`, `unchecked` and `no_login` in (`start_refused`:
  `agent-strip.md`). Tiles carry no status line; the settings card draws every state.
  **`unchecked` stays** — kimi's permanent answer (`AGENT_LOGIN.kimi.status` is null) and
  claude's timed-out probe. `shownHere` binds the row, the auto-default, `offeredHere`
  and the empty state. A preset is exempt: it starts on the system's key. What New
  session offers instead is `agent-strip.md`'s. Q3.526, Q3.640.
- **The harness row is above the model row, and `webcheck` pins the order** (two sibling
  JSX blocks). Only the model row waits on `GET /agents/capabilities`; `HarnessPicker` is
  never behind the `reading` gate `step === "llm"` has. The harness list comes from the
  cheap `GET /agents` (plugins may add harnesses), and `harnessRows` falls back to the
  shipped five while it is in flight rather than gating — pinned separately, because
  Q3.528's own assertion is a string-index comparison. With a harness chosen,
  `ModelPicker` collapses every provider it cannot be pointed at. Q3.528.

## Which provider is at the top

- **`SYSTEM_IDS` is the default order of the built-in rows**: Anthropic, OpenAI,
  OpenRouter, Cursor, xAI, Moonshot, Z.ai, MiniMax, OpenCode Zen. Plugin providers are
  appended after every built-in, sorted by plugin id, never inserted mid-list.
  `plugin-contributions.md`.
- **`readyFirst` in `agents.ts` lifts every provider this machine can run** above the
  rest; `SYSTEM_IDS` orders each half and is the only place the default is written.
  Q3.535.
- **"Ready" is `keyMissing`'s own answer**, the function that greys the rows, so order
  and greying cannot disagree. Never `system.keySet`: a published id proves the native
  harness holds its own credential.
- **`some`, not `every`**: one runnable model floats the provider.
- **Applied inside `allModels`, never `groupModels`**: the picker draws a provider filter
  menu off the flat catalogue too, in first-appearance order.
- **Stable**: the rank is one number, `(ready ? 0 : N) + position`.
- OpenCode Zen is not exempt. The Systems settings screen does not float.

## What the picker does with a provider this size

**One heading per provider, and nothing else is ever in it.** `groupModels` groups on
the system alone; `supportingHarnesses` puts the glyphs of the harnesses that can run
*that* model on its row, with `Supports <name>` on hover. Q3.480.

**Two things have been tried in that heading and taken back out**: the route
(`Moonshot · Kimi Code only`), since a heading answers whose model this is (Q3.486); and
a vendor sub-heading (`OpenRouter · qwen`) — 38 lists to scroll past, a model's
variants split apart, and the search box already makes that group on demand (Q3.503).
Recorded because it will be proposed again.

**A subline identical across a group of more than three is drawn once, under the
heading.** `choiceRefusal(null, …)` there can only be the no-key refusal; the group must
be unanimous.

## What the reader may and may not do

It **fails open**, the opposite of `catalogue.ts` on purpose: that is a permission list,
this is names.

- **Two filters, one rule** — drop a row whose only outcome is a confusing failure at
  somebody else's endpoint: no `tools` in `supported_parameters`; an id ending
  `:batch`, the Batch API's pricing tier, which nothing here can submit or poll. A
  deny-list by `endsWith`, so `deepseek/batch` survives. Dropped, not greyed: greying is
  for a pairing refusal, where another harness works and a remedy exists. Q3.506.
- **Unknown fields are ignored.**
- **The name is carried verbatim, never rebuilt from the id** — a `"<Vendor>: "` strip
  has holes.
- **No credential, ever. No `localStorage`** — `stale-if-error=3600` already serves a
  stale copy.
- **An unread list and an empty one are different facts**, with separate notice arms;
  neither names a remedy or carries the browser's own failure words.
- **The same is owed to providers whose list comes from a harness.** A group with no
  rows is not drawn, and six of the nine systems carry an empty `models` table on
  purpose. `unreadSystemsNotice` in `agents.ts` reads `AgentCapabilities.error` (set
  only when the ask failed), so a harness that published nothing says nothing, and
  `AgentBuilder`'s harness rows draw `COULD_NOT_ASK` off the same field. **`notice` is a
  list**: OpenRouter's fetch and the daemon's spawn are two causes, never joined or
  chosen between.
- **`noJargon` may never be handed a live model name.** It forbids `anthropic`, `openai`
  and `/`, which live and published names carry; it is a predicate over this app's
  templates only.

## Bounds

| What | Value |
|---|---|
| Catalogue | ~417 models, ~290 kept after both filters, ~19 KiB as `{id,name}`; no count here is a constant |
| Longest id | 50 chars, against `MAX_MODEL_CHARS` 256 — the typed field's `maxLength`, pinned against `server.ts` by `webcheck` |
| Read reused for | `OPENROUTER_TTL_MS`, ten minutes, `MODELS_TTL_MS`'s clock |
| Request deadline | `CATALOGUE_TIMEOUT_MS`, imported rather than respelled |
