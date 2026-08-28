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

`agent-systems.md` answers *which harness can be pointed at which system*. This
one answers the question underneath it: **whose spelling is on the row, and who
fetched it.** Three sources now, and they are not interchangeable.

| Source | Read by | Reaches the picker as | Key |
|---|---|---|---|
| The harness's own `configOptions`, `category: "model"` | the daemon, `GET /agents/capabilities` | `source: "published"` | never — the agent's own login covers it |
| `SYSTEMS[id].models`, written down | the daemon, `GET /systems` | `source: "table"` | always — a table id is the *routed* spelling |
| `openrouter.ai/api/v1/models` | **the browser** | substituted into `SystemInfo.models`, so `"table"` | always, same rule |

The third is the new one and it is the plugin market's shape rather than a new
idea: *a catalogue on its own host, read by the browser*. Two measurements make
it legal — the endpoint needs **no credential** and answers
`access-control-allow-origin: *` — and one rule makes it necessary:
`compatibility.md` states the count of `fetch` calls in `src/` as the property,
so the daemon must not grow a fourth to proxy somebody's weekly catalogue.

**It is substituted into the *listing*, before `allModels` sees it.** Not carried
beside the choices, and emphatically not given a third `source`. A fetched row is
a table spelling in every sense that matters — it is what the endpoint answers to
when a harness is routed at it — so the key biconditional stays true of it word
for word and `agents.ts` learns nothing about where the names came from.

⚠ **The document's `connect-src` has to name `https://openrouter.ai`, and
unconditionally.** Every instance compiles in the same `SYSTEMS`, so every
instance's picker makes that request. Omit it and the browser refuses its own
request before a byte leaves, as a bare `TypeError` with no status — the symptom
is a provider whose section never fills, with the reason only in a console nobody
has open on a phone. `relaycheck` asserts it in **both** instance shapes, market
or no, because the market widens the same directive by string concatenation.

**The fetch is gated on the daemon having listed the system.** That is the whole
reason `SystemInfo.id` is `string`: an older daemon means five providers on
screen and *no request to a third party at all*.

## One harness, two systems

⚠ **opencode is the native side of both OpenRouter and OpenCode Zen, and
publishes a single list holding both** — `openrouter/qwen/qwen3-coder` beside
`opencode/big-pickle`. `nativeModelPrefix` is what divides it: a system with one
takes only the published ids that carry it, and strips it.

Without that division each system takes the whole list — 362 rows under OpenRouter
including six that are not its models, and 362 under Zen including 356 that are
not, every one unrunnable and none of them saying so. A system with **no** prefix
still takes everything, which is every other row in the table and is exactly what
they did before the division existed: those harnesses serve one system each.

`SYSTEMS.zen` is `baseUrl: null` for the reason `anthropic` and `openai` are —
its endpoint exists, and naming it would offer claude a routed arm that dies on
the pinning test, since `ROUTED_MODEL_ENV` has no OpenAI-shaped door.

⚠ **And it names a `loginVia` even though its CLI has no sign-in**, which is what
made that field say what it always meant: *whose CLI owns this system's
credentials*, never *where a wizard is*. The two readings coincide on the first
three rows, whose CLIs all have logins; opencode is where they came apart. What
the field decides is which control the system's screen draws — that harness's own
card, or a bare **system** key box.

**A row that is not routable must name one.** A system credential is only ever
spent in `providers/set` headers, so on a row with no `baseUrl` the key box would
accept a secret, store it, and never send it anywhere: a control that is worse
than no control. `zen` was exactly that for one revision. `daemoncheck` now sweeps
the whole table for it rather than pinning the row that was wrong, because the
next row added is the one that will get it wrong.

## Two spellings for one model

⚠ **One system relates its two lists and every other one does not.** Moonshot's
are different products on different endpoints with different billing (Q3.488), so
a name really is absent and the refusal is right. OpenRouter's are one catalogue
behind one account: opencode publishes `openrouter/qwen/qwen3-coder` for exactly
what the endpoint claude is routed at calls `qwen/qwen3-coder`.

`SystemConfig.nativeModelPrefix` is where that is written down, and it is the
only place a stored id is ever respelled.

- **Everything stored, sent and shown is the endpoint's own spelling.** So
  `custom_agents.model` says one thing whichever harness ends up running it, and
  an edit that swaps the harness does not have to rewrite the model.
- **`pinNativeModel` puts the prefix back**, at the last moment before the agent
  is asked, and is idempotent — an id that already carries it is left alone, so a
  row that reached the store the long way round pins instead of doubling.
- **`allModels` strips it** off a published id, which is what makes the two lists
  dedupe to one row. Without that, OpenRouter draws every model twice, once per
  spelling, each greyed for the harness that did not supply it.
- **`pairFailure` reports no name failure at all** where a prefix relates them.
  Both arms are suppressed, not one.

⚠ **Published wins the dedupe, and that is the right way round.** Its presence
*proves* the native harness is keyed — measured, a signed-out opencode publishes
six models and a keyed one 362 — so `keyMissing` reads `published` and asks for
nothing. The same model arriving only from the table means nothing here can run
it without a key, which is exactly what the row then says.

⚠ **…and the *name* goes the other way, which is not a contradiction.** `source`
answers "which harnesses may use this id"; a name is a label. opencode publishes
`OpenRouter/Claude Opus 5` for what the catalogue calls `Claude Opus 5`, so under
a heading already reading `OpenRouter · anthropic` the published form says the
provider twice and carries a `/` into every refusal built from it. Where both
exist the table's name wins.

⚠ **And where only the harness's exists, the provider's own label comes off the
front of it** — `withoutProviderLabel`, Q3.507. That is a *third* rule and not an
exception to either: the dedupe branch has a better name in hand and cuts nothing,
this branch has none, and they never both fire. Zen is the case no other rule
reaches — its table list is empty, so there is nothing to prefer, and all 93 rows a
keyed opencode publishes read `OpenCode Zen/<name>` under a heading already saying
`OpenCode Zen`. It catches OpenRouter's 68 published-only rows too.

**It is not the surgery `openrouter.ts` refuses, and the difference is the key
rather than the act.** That file refuses a *pattern* — `"<Vendor>: "` over a vendor
half that is unknown, absent on 19 names and spelled two ways by four vendors —
because it infers structure out of somebody else's prose. This removes **one known
constant**: the system's own `displayName`, which is the exact string the heading
over the row already says. So it fails open on every rename — `opencode Zen/`,
`Zen/`, nothing at all — leaving the row as it was rather than producing a wrong
name, which is what a strip cutting at the first `/` could not promise.

**Case is folded and nothing else is**: no fuzzy match, no normalised punctuation,
no separator but `/`. Never a `RegExp` — `Z.ai (GLM)` is a live `displayName`.
`nativeModelPrefix` is the wrong key and looks like the right one: it is the
provider key in the *id* namespace (`opencode/`), while a name carries the provider
*label* (`OpenCode Zen/`), and they do not coincide for the one system this exists
for.

**The remainder is a stored value, not only a label.** `defaultAgentName` seeds a
new preset's name and the save button does not weigh it, so it is trimmed and an
empty remainder keeps the original. Presets already saved are not migrated.

⚠ **The tools filter is ours and it applies to *both* lists — this sentence used
to end "the catalogue only" and that is what shipped the defect.** The reasoning
was that an agent's published list is the agent's answer about what it can run, and
that this daemon has no model list of its own. Both halves are still true and
neither was the question: opencode publishes all 362 of OpenRouter's models
unfiltered, image models included, so a model the catalogue had **already refused
for having no tools** came back through the published door and was offered. An
agent assembled on `nousresearch/hermes-3-llama-3.1-405b` failed on its first turn
with OpenRouter's own accurate sentence. `readOpenRouterModels` reports what it
refused as `toolless` and `allModels` drops a published row named in it — a list of
the *refused* rather than the allowed, so a catalogue that could not be read
refuses nothing. `:batch` and malformed rows are deliberately **not** in it: those
are refusals about something other than tool support. Q3.520 — whose known
limitation is that the in-session model menu still offers them, because neither the
browser at that point nor the daemon ever holds the catalogue.

⚠ **A harness that is a router has no tile of its own.** `startsBare` is false for
opencode alone, and the statement is about the **model** rather than about the CLI:
the other three harnesses *are* the model they run, so tapping one is a whole
decision, while a bare opencode session pins nothing and starts on
`opencode/big-pickle` — a model nobody on the screen chose. A saved
`OPENROUTER_API_KEY` widens its catalogue to 362 and moves that default not one
row, which is the measurement that settles it. It closes three doors with one
predicate (the tile row, the auto-default, and a restored pick through
`offeredHere`) and nothing else: `GET /agents`, `POST /sessions`, the CLI, the
settings card and the builder's harness row are all untouched. **Not** the
"unavailable harnesses stay, disabled" rule — that is about an agent that cannot
run; this one runs and has no answer for which model. Q3.522.

⚠ **And a harness nobody is signed in to has no tile either.** `offersTile` is the
other half of the same gate: `not_installed` and `signed_out` are out; `signed_in`,
`unchecked` and `no_login` are in. Reported as *"take `signed in` off the tiles, and
keep an agent out of the picker if it is not signed in"* — two halves of one rule,
since with every visible tile startable the badge could only ever read `signed in`,
which identifies nothing. The tiles carry **no status line at all** now; the
settings card still draws all five states, because that screen is *about* the
states. ⚠ **`unchecked` stays and it is the load-bearing arm** — kimi's permanent
answer (`AGENT_LOGIN.kimi.status` is null) and claude's timed-out probe — so hiding
on it would delete kimi from this screen fleet-wide and make a slow probe look like
an uninstall. ⚠ **It hides a door and `NewSession` owes one back**: the sign-in
wizard was reached by tapping the tile that said why, so it hangs off *no tile at
all* now and names the first agent `signInOffered` is true of — the same predicate
the wizard's own gate asks, because a fallback naming an agent the gate declines to
draw for is an empty row with no door. Both halves are `shownHere`, called by the
row, the auto-default and `offeredHere` alike. A preset is exempt: it starts on the
**system's** key, which is what the daemon checks. Q3.526.

⚠ **The harness row is above the model row, and the order is asserted.** The model
row is the only control on the builder that waits — `GET /agents/capabilities`
starts an agent per harness, 2159 ms — while the harness list is `AGENT_IDS` and
needs no read, and `HarnessPicker` has never been behind the `reading` gate that
`step === "llm"` has (with no model chosen `harnessRowRefusal` answers `null` for
every row). So answering the free question is what the wait runs under. It is also
the order the model list is built for: with a harness chosen, `ModelPicker`
collapses every provider it cannot be pointed at, so a refusal arrives before the
choice it is about. Nothing but the order says which row is first — two sibling JSX
blocks — so `webcheck` pins it. Q3.528.

## What the picker does with a provider this size

**One heading per provider, and nothing else is ever in it.** `groupModels` groups
on the system alone; which harnesses a model is for is the row's own business,
drawn as glyphs on the right of it by `supportingHarnesses`.

⚠ **Two things have been tried in that heading and both are out.** The route was
first (`Moonshot · Kimi Code only`), removed by Q3.486 because a heading answers
*whose model is this* and a route is not that. A **vendor** sub-heading was second
— `OpenRouter · qwen`, 38 of them — and it survives that objection, since a vendor
genuinely is the same question one level finer. It lost on the screen instead, and
the record is Q3.503:

- one list to scroll became 38 lists to scroll past, which is not what "too many
  rows" was asking for;
- a model's own variants read as different products, three screens apart;
- and the search box at the top already produces exactly the group the heading was
  drawing, on demand, at no cost to the reader who did not want it.

It is written up rather than deleted because it is an obvious-looking idea that
will be proposed again.

⚠ **A subline identical across a group of more than three is drawn once, under the
heading.** `choiceRefusal(null, …)` on this screen can only be the no-key refusal,
which is a fact about the *provider*: on 348 rows it was one sentence repeated 348
times. The hoist is the same call and the group must be unanimous, which is what
stops it becoming a hole in "every row is greyed by that same refusal,
unconditioned".

## What the reader may and may not do

It **fails open**, and that is the opposite of `catalogue.ts` on purpose. A
half-read entry there is a half-read *permission* list — somebody granting a
plugin access to their sessions — and that one may not guess. This is a list of
names: a bad entry costs one row nobody can see is missing, and refusing the
other 289 over it is the failure this app avoids everywhere else.

- **Two filters, and they are one rule stated twice**: each drops a row whose only
  possible outcome is a confusing failure at somebody else's endpoint.
  - **`tools` in `supported_parameters`** — one that cannot call tools fails on the
    first turn of any coding session.
  - **An id ending `:batch`** — not a routing variant (there are seven of those and
    this is not one of them) but the catalogue row for the **Batch API**'s pricing
    tier: `POST /api/beta/batches`, 24-hour completion window, `202 Accepted` with
    `status: "validating"`, and it takes a bare slug rather than the suffix. Both
    doors this app has are synchronous, so nothing here can submit or poll one. At
    half price it is the most attractive-looking row in the picker and the one that
    cannot complete a turn. `endsWith` rather than an allow-list: an id carries at
    most one colon and `batch`/`free` are the only suffixes in existence, so
    `deepseek/batch` survives, and a deny-list goes dark only on the next
    *asynchronous* variant rather than on the next synchronous one. Q3.506.
- **Unknown fields are ignored.** The live object carries eighteen keys and this
  app has a screen for two of them.
- **The name is carried verbatim, never rebuilt from the id.** Stripping a
  `"<Vendor>: "` prefix is a rule with a hole: 19 of the kept names carry no prefix
  at all, and four vendors disagree with themselves — `anthropic/claude-opus-5` is
  `Claude Opus 5` while `anthropic/claude-sonnet-5` is `Anthropic: Claude Sonnet 5`.
- **No credential, ever.** The endpoint wants none and this app has none to offer
  a third party.
- **No `localStorage`.** `stale-if-error=3600` already serves a stale copy for an
  hour after a failure; a second cache is one this client would have to
  invalidate correctly.

⚠ **An unread list and an empty one are different facts**, so the notice has
separate arms. Neither names a remedy — nobody in this product configures that
address — and neither carries the browser's own words for the failure, because a
refused `connect-src` arrives as a bare `TypeError` a person cannot act on.

⚠ **`noJargon` may never be handed a live model name.** It forbids `anthropic`
and `openai` as words, and 74 of the kept names contain one — `Anthropic: Claude
Sonnet 5`, `OpenAI: GPT-5.6 Luna`. It also forbids `/`, and while no *catalogue*
name carries one, every name opencode *publishes* does: it renders each model as
`OpenRouter/<name>` or `OpenCode Zen/<name>`. The label comes off before the row is
drawn, so the `/` no longer reaches a sentence — but that is a repair and not a
licence: `noJargon` is a predicate over *this app's templates*, the values
substituted into them are somebody else's prose, and always were.

## Bounds

| What | Value |
|---|---|
| Catalogue | 417 models, 672 KiB raw; 348 with tools, 59 of those `:batch`, **289 kept**, 18.7 KiB as `{id,name}`. Re-read an hour later: 418 / 349 / 59 / 290 — no count here is a constant |
| Longest id | 50 chars, against `MAX_MODEL_CHARS` 256 |
| Read reused for | `OPENROUTER_TTL_MS`, ten minutes — the same clock as `MODELS_TTL_MS`, so the picker's two halves do not go stale on different ones |
| Request deadline | `CATALOGUE_TIMEOUT_MS`, imported rather than respelled |
| Picker rows for OpenRouter | 289 with no key; 358 with one, of which 68 are opencode's own spellings and 2 the table's alone |
| Picker rows for Zen | 6 with no key, 93 with one |
