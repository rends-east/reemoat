---
paths:
  - src/acp/systems.ts
  - src/agentask.ts
  - packages/web/src/agents.ts
  - packages/web/src/ui/AgentBuilder.tsx
  - packages/web/src/ui/AgentIcons.tsx
---

## A harness is not a system

**A *harness* is the CLI that runs the loop; a *system* is who serves the model
and who you sign in to.** They were the same thing while each of the three agents
spoke only to its own vendor, and the old naming recorded the coincidence: a
screen called Agents asked you to sign in to `claude`, when what you were signing
in to was Anthropic. They come apart the moment a harness can be pointed
somewhere else, and ACP's `providers/set` is exactly the method for that.

**The mechanism is a standard ACP method, not an environment variable and not a
config file.** `acp.methods.agent.providers.set`, in the SDK this repo already
vendors, called between `initialize` and `session/new`. Both adapters that
implement it say the configuration is process-scoped and applies to sessions
created *after* the call — which is precisely the lifetime this daemon has, since
it spawns one adapter per session. Scope and process line up, so nothing has to
be undone. Writing `~/.codex/config.toml` was the alternative and is refused for
the reason `acp/agents.ts` already gives about settings files under somebody's
home.

## Measured, 2026-08-25, against the pinned adapters

| Adapter | `agentCapabilities.providers` | `providerId` | `supported` |
|---|---|---|---|
| `claude-agent-acp` 0.63.0 | `{}` | **`main`** | `anthropic`, `bedrock`, `vertex` |
| `codex-acp` 1.1.9 | `{}` | **`custom-gateway`** | `openai` |
| `kimi` 0.29.x (`kimi acp`) | absent | — | `-32601` |
| `opencode` 1.18.23 (`opencode acp`) | absent | — | `-32601` |

opencode is the native side of **two** rows, publishes them in one list, and has
no sign-in at all; `agent-catalogue.md` owns both consequences.

**And what each publishes is a second, independent question.** Re-measured
2026-08-26 through this daemon's own `AgentAskRuns.capabilities`, **ids and names
both** — reading the ids alone is what got this wrong twice:

| id | name |
|---|---|
| `kimi-code/kimi-for-coding` | **K2.7 Coding** |
| `kimi-code/kimi-for-coding-highspeed` | K2.7 Coding Highspeed |
| `kimi-code/k3` | K3 |
| `kimi-code/k3-256k` | K3-256k |

…while answering `null` to `providers/list`. Two comments in this repository had
disagreed about the first column for a release, one saying kimi published none
(Q3.480). And the second column is why **`source` is about names and never about
models**: the two routes into Moonshot overlap in models and not in spellings, so
Kimi Code runs a K2 perfectly well — "K2.7 Coding" is in that list — and any
sentence built from `source` that reads as "that harness has no K2" is wrong. What
such a sentence *may* say is that a **name** is absent from a list, which is the
whole of what these two columns support and is what `pairFailure` answers.
Q3.486.

**And the same column decides the key, until a harness is chosen**: with none, a
**table** spelling runs only routed and routed signs with the pasted key — always; a
**published** one proves its native harness keyed — never (Q3.499). ⚠ **With one,
the pairing decides.** That rule rested on "every other harness is refused a
published id for the **name**", true until `nativeModelPrefix` related a system's two
spellings and dropped both name arms — so a row opencode published runs routed too,
needing the system key after all. Measured: key saved for opencode, none for the
system, Claude Code offered, start refused. Q3.514.

**And the refusal is the CLI's own, driven rather than inferred.** Against a live
`kimi acp` session, `session/set_config_option` with `kimi-k2-thinking` and with
`kimi-k2-0905-preview` both answer `RequestError: Internal error`. A greyed row
there is a fact about kimi rather than a bound invented here — worth having under
a picker whose whole job is to say what will and will not run. Q3.487.

**⚠ The two lists are two *products*, not two spellings, and `~/.kimi-code/config.toml`
says so outright.** This has now cost three rounds of "surely that K2 is the same
K2", so the evidence lives here:

```toml
[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model    = "kimi-for-coding"      # display_name = "K2.7 Coding"
```

Kimi Code talks to **`api.kimi.com/coding/v1`** — the coding *subscription*, with
plan-scoped names — while `SYSTEMS.moonshot` routes at **`api.moonshot.ai/anthropic`**,
the pay-as-you-go API, with public model ids. Different host, different API,
different billing, different names. **Nothing anywhere asserts that any pair of
them is the same model**, so the two lists may not be merged: a merged row needs a
hand-written equivalence no wire and no config carries, and a wrong one silently
runs a model the row does not name — the failure with no symptom that
`ROUTED_MODEL_ENV` is folded into `hostable` to prevent. Q3.488.

**And it is why a refusal names the name that is missing and never the one to use
instead.** `<harness> has no model called <model>.` stops exactly where the evidence
stops; *"Kimi Code calls this K2.7 Coding"* would be this file writing the merge it
has just refused, into a sentence somebody acts on.

**`providerId` is read off the agent's answer, never written down** — the table
above is why, and `acp-agents.md`'s "by `category`, never by `id`" is the same
rule one layer up.

**The capability marker and the call are read separately, and both are needed.**
`agentCapabilities.providers` is an empty-object marker — `sessionCapabilities.
resume`'s shape, compared `!= null` and never `=== true` — and it says only that
the methods exist. Which protocols an agent accepts is on `providers/list` and
nowhere else. `AcpClient.routing()` answers `null` on **every** failure including
a capability that said yes and a call that said no: a declaration is not a gate,
which is the rule this daemon already applies in the other direction to its own
`fs` capability.

## How a routed model is named, and the three doors that do not work

**`ANTHROPIC_MODEL` at spawn, plus `ANTHROPIC_CUSTOM_MODEL_OPTION`.** Measured
against `claude-agent-acp` 0.63.0, because reading the adapter's source gives the
wrong answer three times over — `applyAvailableModelsAllowlist` visibly
synthesizes an entry for an id it cannot match, and driving it shows it does not:

- `CLAUDE_MODEL_CONFIG={"availableModels":["kimi-k2-thinking"]}` collapses the
  published list to `["default"]`. The allowlist is plainly read — the built-in
  aliases disappear — and the unknown id does not survive it.
- `_meta.claudeCode.options.settings.availableModels` does exactly the same. (It
  would also have collided with `ultracode`, which owns that key.)
- `ANTHROPIC_CUSTOM_MODEL_OPTION` alone appends the row, keeping the built-ins —
  the documented "add a custom model option" — and leaves `currentValue` on the
  CLI's own default.
- `ANTHROPIC_MODEL` alone appends the row **and** makes it current.

Both of the last two are set, and setting them together was measured to compose.
Relying on the undocumented half alone is how a CLI update takes the feature out
silently.

**A native pairing takes the other door entirely**: `session/set_config_option`
under `category: "model"`, after `session/new` — **and after `session/resume`,
which publishes the same `configOptions`** — validated against what *this* agent
just published rather than against a cache. Which door applies is the table's
decision, never a call site's; that it applies on *every* launch rather than only
the first is the invariant below, and it cost a release.

## Invariants

- **`SYSTEMS` is fixed, and the fixity is the security property `AGENT_LOGIN`
  claims.** No route, body field or header anywhere names a base URL, a header
  name or an environment variable. A request names a `SystemId`; the table is what
  it resolves against. This daemon is reachable from the internet through the
  relay, and a caller able to name an endpoint could point somebody's key at a
  host of its own.
- **The credential travels in `providers/set`'s headers, never in the environment
  *this daemon* spawns — which buys one hop, not secrecy.** ⚠ **The adapter puts it
  back**: `claude-agent-acp` folds those headers into `ANTHROPIC_CUSTOM_HEADERS` on
  the CLI it spawns, and `ROUTED_MODEL_ENV` permits only `claude`, so on every
  routed session the key is as exposed to the agent as a pasted one. Measured, with
  line numbers and what would close it, in `acp/systems.ts`. `daemoncheck` asserts
  this daemon's boundary, which is why it passed while the property did not hold.
- **`hostable` is the only place the matrix exists, on each side.** It is computed
  from two facts the agent answers plus one table row. Writing the matrix out
  would be a copy that goes stale on the first CLI update, silently, because a
  table agreeing with itself passes every check. Driven as a **sweep over the
  whole matrix** rather than at the cells that matter today.
- **Routable and un-pinnable must refuse.** `hostable` folds `ROUTED_MODEL_ENV`
  in for exactly this: a pairing this daemon can route but cannot point at a model
  would start, look right, and quietly run the endpoint's default model. That is
  the failure with no symptom, and it is why the two questions are one answer.
  ⚠ **The refusal only fires on a launch that actually carries the routing
  options.** `applySystem` returns at its first line when `options.system` is
  absent — before `client.routing()` and before `hostable` — and `spawnEnvOf`
  returns `{}` on the same condition, because that is what every session started
  before assembled agents existed looks like. So a launch site that *drops* the
  system produces no route rather than a wrong one, and every guard on this path
  passes it straight through: `SystemRoutingError` cannot fire on a bag that asked
  for nothing. This is not hypothetical — one of the three launch sites did exactly
  that for every unprompted session (Q2.215) — and it is why the bag lives in one
  place, `ManagedSession.launchOptions`, rather than being written out per site.
  ⚠ **And on a native pairing the refusal is not `hostable`'s at all — it is
  `pinNativeModel`'s, and it fires on the paths that reach that call.** There are
  two, `Session.start` and `Session.openResumed`, and for a release only the first
  of them called it: `spawnEnvOf` answers `{}` for a native pairing and
  `applySystem` returns at its first line for one, so `session/set_config_option`
  is the entire mechanism and a resume that skipped it ran the CLI's own default
  with every other guard passing it straight through — a guard bypassed by a door
  it does not sit on, the paragraph above one launch site along (Q2.217). Both
  call it now, and **they weigh the same sentence differently on purpose**:
  `pinNativeModel` *answers* the refusal rather than throwing it, `start` wraps it
  in `SystemRoutingError` (502, nothing to strand — the session does not exist
  yet), and `openResumed` resumes anyway and pushes one `error` event with
  `data.code` of `model_not_pinned`, naming the model asked for and the one the
  session came back on. Refusing there would strand a conversation for ever the
  first time a CLI retires a model, which is the permanent refusal Q2.216 chose a
  demotion over; demoting silently is the bug being fixed. So a resumed session may
  honestly come back un-pinned, and it says so in the transcript. **A pairing that
  `POST /sessions` refuses is therefore resumable**, and that asymmetry is the
  decision rather than an oversight — a driver asserting only one arm records
  nothing about it.
- **`methodNotFound` on `providers/set` fails the start.** There is no fallback
  arm. Running on the agent's own default is a session billed to the wrong
  account, on a model nobody chose, with the chip on screen naming the one they
  did. `502 system_not_routable`. ⚠ **It does not fire before the workspace
  exists** — `registry.create` writes the row and resolves the workspace before
  `start()` — which is exactly where `agent_auth_required` already fails, and is
  why `AgentAvailability` exists to catch the commoner case earlier.
- **A model is never validated against a table.** For a native pairing the list
  belongs to a CLI that updates on its own schedule; for a routed one it belongs
  to somebody else's API. What refuses a stale model is the agent, or the
  provider, at the moment it is used, by name. The only bound is a length.
- **`sessions.agent` still holds the harness.** A custom agent is a *reference* in
  `sessions.custom_agent`, resolved at every launch through a thunk — so editing a
  preset changes what its sessions come back as, and `resolveAgent`, resume,
  `signOutSessions` and the whole restore path never learn this column exists. A
  preset deleted under a sleeping session resumes on the bare harness rather than
  becoming unrecoverable — and so does one *re-pointed at a different harness*,
  because a conversation cannot change vendor underneath itself. The resolver
  answers `{harness, system, model}` and `ManagedSession.assembled` **compares**
  the harness rather than using it: an edit that re-points a preset leaves existing
  sessions on the harness they were started with, rather than launching a triple
  `hostable` refuses (`502 system_not_routable`, for ever) or one it permits and
  nobody chose — the claude harness pointed at Moonshot. Q2.216.
- **`registry.setCustomAgents` is a setter and must be called before
  `restore()`.** `elicitationAllowed`'s argument exactly: `restore()` rebuilds
  every persisted session, and one that came back before the resolver was set
  would resume on a bare harness — same conversation, different vendor, nothing on
  screen saying so. ⚠ **The thunk's answer carries the harness**, read straight
  off `stores.customAgents.get(id)` — the one field with no downstream *use*, so
  nothing but the comparison above would notice it going missing.
- **The client's `hostable` is a courtesy, not the gate.** The daemon refuses on
  the way in, because a saved preset that cannot start is a row whose only button
  answers 502 for ever. Both sides are asserted, separately, on the same measured
  fixtures.

## The builder is a pop-up, and the folder is why it can be

**`/agent/:machineId/:cwd`, one depth below New session, plus one more for each
choice being made** — and `/agent/:machineId/edit/:presetId[/…]` for an edit, which
is the same screen at the same depth with a stored row loaded into it. The marker
is the literal word `edit` rather than a recognisable id, because the client may
not hold a copy of the daemon's id generator; an address it cannot read degrades to
the new-agent screen, which is the arm holding none of somebody else's work. The obvious hazard is the one that put the *sign-in* flow
inline: navigating away from New session discards the folder somebody walked
several levels into. Three things make it safe, and all three are needed:

- **The address follows the picker.** `NewSession` replace-navigates to
  `newPath(machine, cwd)` on every folder change, so the folder is in the URL
  before anything can leave. `depthOf` answers the same depth either way, so
  nothing animates, and `replace` keeps a directory walk out of the history.
- **`upFrom` rebuilds the picker from the builder's own segments** — not from
  `under`, which carries forward what the *first* pop-up was drawn over and would
  close the whole stack. Same trap `marketUpFrom` needed `origin` for; here the
  address already holds both halves, so nothing goes in `history.state`.
  `newSessionPath` and `agentBuilderPath` both live in `nav.ts` and `router.ts`
  re-exports them, because `nav.ts` may not import `router.ts` and both need the
  one encoding.
- **The new agent comes back through `agentPick.ts`**, a module `Map` in
  `echo.ts`'s shape — the builder is a *route* away, so there is no parent to
  report to. **Taken rather than read**, or the next open re-selects it. Two
  channels, not one: `rememberPick`/`takePick` for an agent that was assembled and
  `rememberRemoval`/`takeRemoval` for one that was deleted, because a machine can
  honestly hold both at once and they are answered by different things — a pick
  replaces the listing, a removal only withdraws a selection.
- **What was chosen is held per machine, in `StartSheet`, and it is a claim rather
  than a value.** The map is state so it survives the builder's unmount, and a
  `picksRef` of the same map is written *before* `setPicks` so the `GET /agents`
  handler reads the tap as of the tap: its effect closes over the render that
  created it and `store.daemonFor` is stable per machine, so no dependency could
  ever have refreshed a prop there. The listing's own default is held apart, in
  `NewSession`, because writing it into the map would record a choice nobody made
  and restore it on the next visit. And what is *drawn* is weighed against the
  listing every render by `offeredHere` — a harness must be present **and**
  `available`, a preset must still be in `GET /custom-agents` — so a preset deleted
  in the builder, or on another device, ends as nothing chosen and a disabled
  `Start` rather than as a quiet substitution.

⚠ **One `Sheet` for the whole pop-up, and `App.tsx` mounts it once for both
routes.** Two sibling mounts meant a *remount* on a navigation that is supposed to
slide one pane sideways — `animate-sheet` played again underneath the
`section-push`, and the lazy chunk gave the transition a frame with no sheet in the
tree at all. `StartSheet` owns the panel and dispatches the body; the `Suspense`
boundary is inside it. Q3.472.

⚠ **A screen's action bar is inside `SHEET_BODY`, never `Sheet`'s `footer`.**
`SHEET_PANEL` has a definite height so the panel holds still, but the *body* is
what is left after the head **and the footer** — and that box is the one carrying
`view-transition-name: sheet-body`. With a footer on one screen and not the next,
its group morphs 57px mid-slide, measured at 390px, which reads as the screen you
were on folding away downwards. `SHEET_SCREEN` + `SHEET_SCROLL` are the two class
strings that put the bar inside. Q3.472.

⚠ **The head names the screen, and the ◀ is in it.** The opposite of the settings
sheet, and the difference is the rail: `SHEET_HEAD` spans the whole panel, so above
`sm` the settings head sits over a 224px section list as well as the pane and the
only honest string in it is "Settings". This pop-up is one column at every width
and its screens are a chain, so the head names the screen and the ◀ sits at its
left as a **glyph with no label** — at `size="sm"`, the one that reaches 44px. The
label still names the destination and still comes from `upFrom`; it is just not
painted. Q3.473.

⚠ **The head names the *act*, not the thing.** "Configure agent", because the
screen's first line is the agent's **name** and an unnamed one is called "New
agent" — so a head saying that too was the same two words twice within 40px, and
editing the name left the head claiming the old one. Q3.476.

⚠ **The chosen tile lives in `StartSheet`, not in `NewSession`.** That component
unmounts for the whole of `/agent`, so a tile chosen and then a trip into the
builder — even one left by the ◀ with nothing assembled — put the strip back on
the first available harness and said nothing. And the choice is recorded
**against the machine it was made on**: the listing effect re-defaults per machine
and must, since a harness installed on one may not be on the next. Q3.482.

## Three screens, and the draft lives above all of them

**Choosing is a route, not a popover.** `/agent/:machineId/:step/:cwd` with `step`
of `llm` or `harness`, so each choice arrives with the same slide, the same ◀ and
the phone's own Back. The step sits **before** the folder and both are optional with
no placeholder, which works because a `cwd` is an absolute POSIX path from the
daemon's listing — it can never decode to `llm` or `harness`. Q3.475.

- **A route change unmounts the screen**, so no picker may hold the answer.
  `AgentBuilder` owns the harness, the model and the name; a picker reports through
  `onPick` and keeps nothing.
- **Both reads happen once, in the flow.** `GET /agents/capabilities` starts an
  agent per harness on the daemon's host. A picker that fetched for itself would
  pay for it every time somebody walked in and out of one.
- **Both lists carry a search box; only the model list carries a filter.** Three
  rows do not need one, and `bits.tsx`'s threshold says so — but two screens of one
  flow differing in their *chrome* is worse than a box that filters three rows.
  There is no filter beside it because a harness has no provider to filter on.
  Q3.478.
- **Nothing is ever filtered out for being unusable.** `searchModels` takes what
  somebody asked for; the refusal is drawn on what is left, as the row's subline.
- **The harness opens unchosen.** A default reads as an answer already given, and
  picking the harness you are already on is not a choice anybody makes. Q3.478.
- ⚠ **The model screen refuses a pairing on the *provider*, never on a row.** It
  refused nothing at all for three releases, because greying both screens against
  each other is a trap: neither half of a bad pair can be changed. Two things
  answer that — each field can now be emptied on the screen above, and the refusal
  lands on a heading. Row by row it greys **461 of 463** with codex chosen; asking
  `hostable` about the provider draws six greyed headings and leaves the two rows
  that work. A row still says only what is about the row: a spelling belonging to
  the other route in, or a system with no key. Q3.479, Q3.497, Q3.499, Q3.512.
- ⚠ **A harness that could not be *asked* is not one that refuses.**
  `routing: null` means both; `capabilities[id].error` is set only in the second
  case and is read first, or "Kimi Code only runs its own models" gets drawn over
  a missing binary. Q3.482.
- ⚠ **A pasted key belongs to the *pairing*, and there is no authorization on the
  build screen at all.** `keyMissing` asks the **pairing** — the rule above — and
  **both screens grey from that one call**, so they cannot disagree about a row.
  Asked about the *system* it answered `null` for Moonshot unconditionally — true of
  Kimi Code, false of Claude Code routed at it — so the flow went green and `POST
  /sessions` refused after a worktree had been made (Q3.485); asked *"does anything
  reach this natively"* it left `Kimi K2` pressable beside a greyed `GLM-4.6`, with
  neither key saved (Q3.499). The sentence is carried verbatim — the
  one refusal here that names the *system*, because the remedy is a different
  screen: a key is pasted under Settings → Machines → *system*, where a machine is
  configured, once per system per machine. It states that fact and no route to it —
  a `ChoiceRow` subline is one `truncate`d line, so an appended instruction is the
  clipped half, and the same string is drawn untruncated beside the button.
  `AgentBuilder` mounts no credential control and contains no word from one. On the
  harness screen the arm is a **guard** rather than a step now: the model row is
  disabled, so only an edit of a stored preset or a stale `GET /systems` reaches it,
  and it guards the write as well as the row. Q3.485, Q3.497, Q3.499.

⚠ **Every refusal is a sentence, none of them uses a word from the wire, and both
of its nouns are on the screen it is drawn on.** Three versions failed that last
test before it was written down: *"Codex accepts openai systems, and Moonshot is
anthropic"* (protocol identifiers, two of which are company names), then *"Only
Kimi Code can run this model"* and *"Codex cannot run Moonshot models"* — drawn on
the harness screen, where "this model" was chosen on the *previous* screen and
"Moonshot" was never on screen at all. Every pairing sentence below names the
harness and the model and nothing else, and drops the harness on a row already
titled with it; the one refusal that is **not** about a pairing — a system with no
key — names the system instead, because its remedy is a different screen. `webcheck` pins the strings, a `noJargon` predicate, and the absence of the
words that were wrong. Q3.474, Q3.483.

⚠ **A pairing fails two ways, and they may not share a sentence.** `pairFailure`
answers a *kind* where it was a boolean, because one string for both put on screen
the exact sentence the two-products warning above forbids:

| `pairFailure` | Drawn as | On a row already titled with the harness |
|---|---|---|
| `"host"` — the harness cannot be *pointed at* the system | `<harness> cannot run <model>.` | `Cannot run <model>.` |
| `"name"` — it can, but that spelling belongs to the other route in | `<harness> has no model called <model>.` | `No model called <model>.` |
| neither, but the routed pairing has no key — **not** a pairing failure, so it is weighed **last** | `No <system> key on this machine.` | unchanged: it never named the harness, so it has nothing to drop |

A key cannot rescue a pairing refused for a protocol or a spelling, so both screens
draw the settled failure first: `harnessRowRefusal` and `choiceRefusal` order
identically, or one pair gets two different reasons on two screens. Q3.497.

With Kimi K2 Thinking chosen, the Codex row and the Kimi Code row both read
*"Cannot run K2"*: a protocol Codex will never speak, and — about the one CLI that
reaches Kimi's models natively — a name that is simply not in its own list. Same
words, two unrelated facts, and the second of them false. Rows in the **same**
situation still read identically, which was always the rule; these two were never
in the same situation, and `hostable` is checked first so a harness that fails both
says the protocol half.

**"has no model *called*" is load-bearing, in both halves of the line.** Drop
"called" and it claims the harness has no such model, which is the false half.
Replace it with what the harness calls the model instead and it asserts the
equivalence nothing carries. One sentence covers **both** directions of the
collision — a native CLI handed the endpoint's spelling, and a routed harness
handed the CLI's — because they are one fact seen from either end and the remedy is
the same from either end: the harness whose own list holds that spelling is a row on
the same screen, and it is the one that is not greyed. `hostable`'s
"Only <X> can run <Y> models." earns its second string by having a remedy the others
do not; these two do not differ in anything a reader can act on. Q3.486, Q3.488.

⚠ **`hostable` and `choiceRefusal` answer different questions and only one is
prose.** `hostable` is "can this harness be pointed at this system", and its
sentence is the daemon's own for a start it refuses (`502 system_not_routable`).
`choiceRefusal` is "can this harness run this model", which is what a row says — it
calls `hostable` for the *answer* and drops its words. Forwarding one as the other
is how "Codex cannot run Moonshot models" ended up under a model called K3.

⚠ **The name is a value, not a field.** Drawn as a heading with a pencil beside it,
and an input only once the pencil is pressed — **borderless and transparent**, same
size and position, because `FIELD`'s box made the heading jump into a control and
that reads as a different thing opening. Emptying it hands the name back to the
model rather than saving a blank one, and a commit that changed **nothing** reports
nothing: seeding the draft from what is on screen meant opening the pencil and
tapping away pinned the name, so a later model change left the preset called after
the previous one. Q3.476.

⚠ **One heading per provider, and which harnesses a model is for is on the row.**
`groupModels` groups on the system alone; `supportingHarnesses` gives each row the
glyphs of the harnesses that can run *that* model, with `Supports <name>` on hover.
It split the heading on the route for a release (`Moonshot · Kimi Code only` beside
`Moonshot · other harnesses`) which was the right problem — seven undifferentiated
rows of "Moonshot" hid that no harness runs more than four — and the wrong place:
a heading is where somebody looks for whose model this is, and a route pushed into
it invents a category nobody asked about while leaving each row silent about
itself. Q3.480, Q3.486.

## Where the cost is

Q7.31's finding applies one layer down and unchanged: **the per-cell cost is
empirical, not structural.** The three native rows are today's behaviour
restated. The routed rows are derived from each vendor's published
Anthropic-compatible endpoint and are **not driven end to end** — a row that has
not been run with a real key can still be wrong about a header name, and the
symptom would be a 401 from somebody else's API.

**And a row cannot be detected, which was asked and measured.** Probed
2026-08-26, keyless, against all three routed endpoints plus one OpenAI-shaped
one — four endpoints, four conventions, no classifier possible:

| Probe | Answer |
|---|---|
| `GET api.moonshot.ai/anthropic/v1/models` | **404** — it serves `/v1/messages` and nothing else, so the model list cannot be enumerated at all |
| `GET api.z.ai/api/anthropic/v1/models` | **200** carrying a *failure* body (`code:1001, success:false`) — status says nothing |
| `GET api.minimax.io/anthropic/v1/models` | 401, Anthropic-shaped error, names `X-Api-Key` in prose |
| `GET api.moonshot.ai/v1/models` | 401, OpenAI-shaped error — Moonshot serves both shapes |

A bogus key changes none of it: MiniMax returns the **same** canned string for
`authorization: Bearer` and for `x-api-key`, so even "which header" is not
answerable without a real one. OpenRouter is the exception: a keyless probe
answered, and both header conventions are read.

## Layout

| File | Holds |
|---|---|
| `src/acp/systems.ts` | The table, the compatibility rule, the two halves of a routed launch, and the store ports. Imports one type and nothing else |
| `src/agentask.ts` | One spawn, two answers: what an agent offers and what it accepts. `AgentCapabilityReader` is the port `server.ts` takes, so both routes are drivable with no agent installed |
| `packages/web/src/agents.ts` | The client's half: the same refusals, the whole-fleet catalogue, the default name. DOM-free so `webcheck` drives it |
| `packages/web/src/ui/AgentBuilder.tsx` | The flow: the draft, its reads, and the three screens it dispatches between. Over a stored preset it is the **edit** screen, and the preset is a third read — deliberately not a third leg of the `Promise.all`, since a daemon too old for `GET /custom-agents` would then take down the new-agent flow it runs perfectly well |
| `packages/web/src/agentPick.ts` | The agent a pop-up assembled, held until the strip can draw it. Taken, never read twice |
| `packages/web/src/ui/AgentIcons.tsx` | One glyph per harness. Shapes of ours, not vendor marks — exhaustive over `AgentId` with no `default` arm |
| `packages/web/src/openrouter.ts` | One provider's list, read by the browser. **`agent-catalogue.md` is that subject whole**: where a name comes from, and which spellings relate |
| `packages/web/src/ui/settings/SystemsPanel.tsx` | A system's whole configuration, and `KeyOnly` — exported, and mounted twice **here**, routed and not. The builder mounted it too and no longer does: authorization is a property of the machine, so it lives where a machine is configured. Q3.497 |

## Bounds

| | |
|---|---|
| A system key | 8 KiB, the same constant a pasted agent credential gets — one act, one number |
| An assembled agent | 80 characters of name, 256 of model id. The model's *content* is checked by nobody here |
| `GET /agents/capabilities` | One agent process per harness, no prompt so no quota, cached `MODELS_TTL_MS` (10 min) under `MAX_CONCURRENT_ASKS` (2) |
