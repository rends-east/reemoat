import { AGENT_IDS, type AgentId, type CatalogueState, type ContributedHarness, type HarnessCatalogue } from "./agents.js";

/**
 * Which *system* a model comes from, as opposed to which harness runs the loop.
 *
 * The two were the same thing while there were three agents and each spoke only
 * to its own vendor, and that coincidence is what the old naming recorded: a
 * screen called "Agents" asked you to sign in to `claude`, when what you were
 * signing in to was Anthropic. They come apart the moment a harness can be
 * pointed somewhere else, which ACP's `providers/set` is exactly the method for.
 *
 * ⚠ **Fixed, and the fixity is the same security property {@link AGENT_LOGIN}
 * claims.** There is no route, body field or header anywhere that names a base
 * URL, a header name or an environment variable — a request names a
 * {@link SystemId} and this table is what it resolves against. Accepting a URL
 * from the wire would be handing somebody's key to a host of the caller's
 * choosing, over a daemon that is reachable from the internet through the relay.
 */
/*
 * ⚠ **The order of this array is a *reading order*, and it is the only place it is
 * decided.** `GET /systems` maps over it, `groupModels` in the client groups by
 * first appearance rather than by sorting, and the builder's model picker draws
 * one heading per group — so this list is, transitively, the order somebody scrolls
 * through when they pick a model. Nothing branches on a position; a system's
 * meaning is entirely in `SYSTEMS[id]`.
 *
 * ⚠ **And it is the *default* reading order rather than the whole of one**, which
 * it was until the picker learned to float. `readyFirst` in the client lifts every
 * provider this machine can actually run above every provider it cannot, and this
 * array is what orders each of those two halves. So a position here decides what
 * somebody scrolls past **only** among providers that are equally usable — which
 * is the half of the question a daemon can answer, since which keys a machine
 * holds is not a property of the table.
 *
 * The shape is **the two vendors a harness reaches natively, then the widest
 * router, then the single-vendor endpoints**. Anthropic and OpenAI serve claude
 * and codex and are what most people are actually choosing between. OpenRouter is
 * next: it is the widest catalogue and the commonest reason to scroll at all, and
 * it sat below Moonshot for a revision — never a released one — which put one
 * vendor's three table rows, or seven with kimi signed in, above the list most
 * searches end in. Moonshot follows — native to kimi, but a
 * single-vendor endpoint like the two under it. Z.ai and MiniMax are ones far
 * fewer people hold a key for. OpenCode Zen is last: it is the free tier one
 * harness falls back to when nothing is configured, which makes it the least
 * likely thing anybody came here to choose — and it is last *by default only*,
 * since a machine holding a Zen key floats it like any other.
 */
export const SYSTEM_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "moonshot",
  "zhipu",
  "minimax",
  "zen",
] as const;

/** One of the seven this repository ships. */
export type BuiltinSystemId = (typeof SYSTEM_IDS)[number];

/**
 * A system id, which is a string.
 *
 * Widened for `AgentId`'s reason and with the same two predicates standing in for
 * the compiler — membership where nothing has been created yet, shape where the
 * row is the memory. See {@link SystemCatalogue}.
 */
export type SystemId = string;

/** Whether this is one of the seven this repository ships. */
export function isBuiltinSystemId(value: string): value is BuiltinSystemId {
  return (SYSTEM_IDS as readonly string[]).includes(value);
}

/**
 * The wire shape a system speaks, matched against what an adapter answered.
 *
 * ACP's own `LlmProtocol` is `"anthropic" | "openai" | "azure" | "vertex" |
 * "bedrock" | string` — open, because an agent may support one we have never
 * heard of. This is the closed subset this daemon knows how to *configure*, and
 * it is compared against the agent's `supported` list rather than assumed: see
 * {@link hostable}.
 */
export type SystemApiType = "anthropic" | "openai";

/** How a system's credential is presented on the wire. */
export interface SystemAuthHeader {
  name: string;
  /** Prepended to the secret. `"Bearer "` or `""`. */
  prefix: string;
}

export interface SystemModel {
  id: string;
  name: string;
}

export interface SystemConfig {
  displayName: string;
  apiType: SystemApiType;
  /**
   * Where a *routed* session's traffic goes, or `null` for a system that is only
   * ever reached natively.
   *
   * `null` does not mean "no endpoint" — Anthropic obviously has one. It means
   * this daemon has nothing to configure: the harness that natively belongs to
   * this system already reaches it, and calling `providers/set` would be
   * replacing a working default with a copy of it.
   */
  baseUrl: string | null;
  authHeader: SystemAuthHeader | null;
  /**
   * The harness that reaches this system without being routed at all.
   *
   * The **one** place the "anthropic ↔ claude" correspondence is written down.
   * `null` for a system no CLI ships for, which is every key-only entry below.
   */
  nativeHarness: AgentId | null;
  /**
   * Whose CLI owns this system's credentials, or `null` where no CLI ships for it.
   *
   * A capability that may be absent, living in the table rather than in either
   * reader — the shape `AGENT_LOGIN.logoutArgs` already has for kimi. The client
   * draws that harness's own card from this and a bare **system** key box from its
   * absence, so a system with no CLI never offers a button that answers 503.
   *
   * ⚠ **"Owns the credentials", not "drives a sign-in" — and the two came apart.**
   * They coincide for the first three rows, whose CLIs all have logins. opencode
   * has none: it runs with no credential at all, and what its card offers is a
   * paste box rather than a wizard. Reading this field as "there is a sign-in
   * here" is what the card is now responsible for saying, per `AgentStance`'s
   * `no_login`; reading it as "these credentials live on that agent" is what it
   * has always meant and is what decides which control this screen draws.
   *
   * ⚠ **`null` on a row that is not routable is a dead control.** The absent arm
   * draws a *system* key box, and a system credential is only ever spent in
   * `providers/set` headers — so on a row with no `baseUrl` it would be stored and
   * never read. `zen` is exactly that row, which is why it names its harness.
   */
  loginVia: AgentId | null;
  /**
   * What to offer when this system is **routed** into a foreign harness.
   *
   * Empty for a natively-reached system, and that emptiness is load-bearing
   * rather than a gap: `agentask.ts` says outright that this daemon has no model
   * list of its own and could not have one, because what an agent offers is
   * whatever its CLI decided this week — so a native combination reads its list
   * off the agent. A routed one has nowhere to read it from: claude does not
   * publish `kimi-k2-thinking` and never will, so the names have to be written
   * down. What the two arms share is that neither is validated here — see
   * `Session.applySystem`.
   */
  models: readonly SystemModel[];
  /**
   * What this system's native harness prefixes a model id with, or `null` where
   * it spells them the same way the endpoint does.
   *
   * ⚠ **It exists because one system is reachable *both* ways by two different
   * harnesses that disagree about the name.** claude routed at OpenRouter sends
   * the catalogue's own slug, `qwen/qwen3-coder`; opencode publishes the same
   * model as `openrouter/qwen/qwen3-coder`, because its ids are
   * `provider/model` across every provider it knows. Measured 2026-08-27: 356 of
   * the 362 models a keyed opencode publishes carry that prefix.
   *
   * Everything stored and everything sent on the wire is the **unprefixed**
   * spelling, so `custom_agents.model` says one thing whichever harness ends up
   * running it. `pinNativeModel` puts the prefix back at the one moment it is
   * needed, and the client strips it where a published list is read.
   *
   * ⚠ **Not a general "model names may differ" mechanism.** Moonshot's two lists
   * are genuinely different products on different endpoints with different
   * billing — Q3.488 — and no prefix relates them, which is why that row leaves
   * this `null` and why a refusal is still the right answer there.
   */
  nativeModelPrefix: string | null;
  /**
   * The variable this system's key is stored in, where its CLI reads a *per
   * system* one — otherwise `null`.
   *
   * ⚠ **It exists because one CLI reads two, and nothing said which was which.**
   * opencode is the native side of both OpenRouter and OpenCode Zen and takes a
   * key for each, so the settings screen for a system — which mounts that CLI's
   * card under the system's own name — drew *both* boxes under the heading
   * `OpenRouter`, one of them for somebody else's account entirely. Every other
   * system's harness reads exactly one, which is why `null` is the honest answer
   * there rather than a value: there is nothing to narrow.
   *
   * ⚠ **Naming a variable in a *response* is not what `SYSTEMS` is fixed for.**
   * That rule is about a caller naming one — a request that could point somebody's
   * key at a host of its own. This is the daemon saying which of two boxes it
   * already draws is which, and `GET /agent-auth` has carried `envName` per slot
   * since the first release.
   */
  keyEnv: string | null;

  /**
   * The plugin this row came from, or absent for one this repository ships.
   *
   * ⚠ **Carried on the row rather than kept in a second map**, because every
   * sentence that needs it is built where the row is already in hand: a refusal
   * naming which plugin is switched off, the settings screen saying where a
   * provider came from, and `GET /systems` reporting it so the browser can say the
   * same thing without a second lookup it could get wrong.
   */
  contributedBy?: { pluginId: string; pluginName: string };
}

/**
 * Every system this daemon knows how to reach, and how.
 *
 * ⚠ **Provenance is per entry and it is not uniform.** The three native rows are
 * today's behaviour restated — they are how the fleet already works, and nothing
 * about them is new. The routed rows are derived from each vendor's published
 * Anthropic-compatible endpoint and are **not driven end to end here**; Q7.31's
 * whole finding is that the expensive part of an agent is the measurement rather
 * than the type, and the same is true one layer down. A routed row that has not
 * been run with a real key is a row that can still be wrong about a header name.
 */
export const SYSTEMS: Record<BuiltinSystemId, SystemConfig> = {
  anthropic: {
    displayName: "Anthropic",
    apiType: "anthropic",
    // Native only. `claude` already reaches Anthropic with the credentials
    // `claude auth login` wrote; pointing it at api.anthropic.com through
    // `providers/set` would replace its own routing with a worse copy that
    // carries a pasted key instead of the OAuth token.
    baseUrl: null,
    authHeader: null,
    nativeHarness: "claude",
    loginVia: "claude",
    models: [],
    nativeModelPrefix: null,
    keyEnv: null,
  },
  openai: {
    displayName: "OpenAI",
    apiType: "openai",
    baseUrl: null,
    authHeader: null,
    nativeHarness: "codex",
    loginVia: "codex",
    models: [],
    nativeModelPrefix: null,
    keyEnv: null,
  },
  moonshot: {
    displayName: "Moonshot",
    apiType: "anthropic",
    // Both at once, and this row is the reason the two columns are separate.
    // `kimi` reaches Moonshot natively; `claude` reaches it through here,
    // because Moonshot serves an Anthropic-shaped endpoint beside its own.
    baseUrl: "https://api.moonshot.ai/anthropic",
    // Bearer rather than `x-api-key`: Moonshot's own instructions for Claude
    // Code set `ANTHROPIC_AUTH_TOKEN`, which is the variable the CLI sends as an
    // `Authorization` header — `ANTHROPIC_API_KEY` is the one that becomes
    // `x-api-key`, and the two are not interchangeable at this endpoint.
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: "kimi",
    loginVia: "kimi",
    models: [
      { id: "kimi-k2-thinking", name: "Kimi K2 Thinking" },
      { id: "kimi-k2-0905-preview", name: "Kimi K2" },
      { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo" },
    ],
    // Kimi's own list and Moonshot's are different products on different
    // endpoints — Q3.488 — so no prefix relates them and none is claimed.
    nativeModelPrefix: null,
    keyEnv: null,
  },
  zhipu: {
    displayName: "Z.ai (GLM)",
    apiType: "anthropic",
    baseUrl: "https://api.z.ai/api/anthropic",
    authHeader: { name: "authorization", prefix: "Bearer " },
    // No CLI ships for it, so there is nothing to run a wizard against and the
    // key box is the whole of the screen.
    nativeHarness: null,
    loginVia: null,
    models: [
      { id: "glm-4.6", name: "GLM-4.6" },
      { id: "glm-4.5-air", name: "GLM-4.5 Air" },
    ],
    nativeModelPrefix: null,
    keyEnv: null,
  },
  minimax: {
    displayName: "MiniMax",
    apiType: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic",
    /*
     * ⚠ **Suspect, and written down rather than quietly changed.** Probed
     * 2026-08-26 with no key and with a bogus one: this endpoint answers 401 with
     * `"login fail: Please carry the API secret key in the 'X-Api-Key' field of
     * the request header"` — the same canned string for a bogus `authorization:
     * Bearer` and a bogus `x-api-key` alike, so it diagnoses nothing and only the
     * message names a header. That message names `x-api-key` and this row sends
     * `authorization`. Many gateways accept both; this one says one.
     *
     * Not flipped on the strength of an error string, because flipping it would
     * be the same class of guess that produced the row. It is the one row whose
     * suspicion has evidence, and it stays until somebody drives it with a real
     * key — which is what `agent-systems.md` already says about every routed row.
     */
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: null,
    loginVia: null,
    models: [{ id: "MiniMax-M2", name: "MiniMax M2" }],
    nativeModelPrefix: null,
    keyEnv: null,
  },
  openrouter: {
    displayName: "OpenRouter",
    /*
     * ⚠ **Singular, and this endpoint serves both shapes — the narrowing is the
     * decision rather than a shortcut.** Probed 2026-08-27 with no credential:
     * `POST /api/v1/messages` answers 401 in Anthropic's envelope
     * (`{"type":"error","error":{"type":"authentication_error",…}}`) while
     * `POST /api/v1/chat/completions` answers 401 in OpenAI's
     * (`{"error":{"message":…,"code":401}}`). Both are live.
     *
     * `anthropic` is what makes the routed half of this row work; `openai` would
     * make it work for nobody. {@link hostable} weighs `supported` and then
     * {@link ROUTED_MODEL_ENV}, and the only harness in that second table is
     * claude, which accepts `anthropic`. Declaring `openai` would take codex past
     * the protocol arm and land it on the pinning arm — which the client's mirror
     * cannot express at all, so the picker would offer a pairing
     * `POST /custom-agents` refuses after somebody had assembled it.
     */
    apiType: "anthropic",
    /*
     * ⚠ **`/api`, and never `/api/v1`** — the SDK appends `/v1/messages`, so the
     * `/v1` is already coming. Path-pinned 2026-08-27:
     * `openrouter.ai/api/v1/messages` answers a JSON 401, while
     * `openrouter.ai/api/messages` and `openrouter.ai/api/v1/v1/messages` both
     * answer an **HTML 404 page** — which is what a wrong base looks like here,
     * and a shape no error reader in this repository would recognise.
     */
    baseUrl: "https://openrouter.ai/api",
    /*
     * Probed with a bogus key: `x-api-key` and `authorization: Bearer` are *both*
     * answered `401 "User not found."`, against `"No cookie auth credentials
     * found"` with no header at all — so both conventions are read, and unlike
     * the `minimax` row above there is no prose here naming one over the other.
     * `authorization` is what OpenRouter documents and what the other three
     * routed rows already send.
     */
    authHeader: { name: "authorization", prefix: "Bearer " },
    // Both at once, as `moonshot` is: opencode reaches OpenRouter by itself,
    // claude reaches it through the base URL above.
    nativeHarness: "opencode",
    loginVia: "opencode",
    /*
     * ⚠ **Empty for a *third* reason, which neither of the two above covers.**
     * For `anthropic`/`openai` empty means "the native CLI publishes the list";
     * for a routed row it has meant "the names are written down here because
     * there is nowhere to read them". This is the one system that publishes its
     * own: `GET https://openrouter.ai/api/v1/models` needs no credential and
     * answers `access-control-allow-origin: *`, so **the browser reads it** —
     * `packages/web/src/openrouter.ts`. 417 models, 687 KiB. Baking that here
     * would put somebody else's weekly catalogue into this daemon's source and
     * onto `GET /systems`, and nothing in `src/` fetches it, because the count of
     * `fetch` calls in this package is the property `compatibility.md` states.
     */
    models: [],
    // opencode publishes `openrouter/qwen/qwen3-coder` for what the endpoint
    // calls `qwen/qwen3-coder`. See {@link SystemConfig.nativeModelPrefix}.
    nativeModelPrefix: "openrouter/",
    keyEnv: "OPENROUTER_API_KEY",
  },
  zen: {
    displayName: "OpenCode Zen",
    // `@ai-sdk/openai-compatible` in its own registry entry, and inert here for
    // the reason `anthropic` and `openai` are: nothing is ever routed at it.
    apiType: "openai",
    /*
     * ⚠ **`null`, and this is the row where that matters most.** Its endpoint
     * exists — `https://opencode.ai/zen/v1` — and naming it would make
     * {@link hostable} offer the routed arm to claude, which cannot work:
     * `ROUTED_MODEL_ENV` has no OpenAI-shaped door, so the pairing would pass the
     * protocol test and die on the pinning one. `anthropic` and `openai` are the
     * same shape for the same reason. What reaches this system is the CLI it
     * belongs to, and that CLI reaches it by itself.
     */
    baseUrl: null,
    authHeader: null,
    nativeHarness: "opencode",
    /*
     * ⚠ **Named, though this CLI has no sign-in — because the field is about
     * *credentials* and not about a wizard.** `OPENCODE_API_KEY` is an agent
     * credential on opencode, so opencode's card is the control this system has;
     * `null` here would draw a **system** key box instead, and this row is not
     * routable, so that key would be stored and never sent anywhere. The card
     * itself says `no sign-in needed` — measured 2026-08-27, opencode publishes
     * six models here and completes a turn against an empty `XDG_DATA_HOME`. A key
     * buys the rest of the catalogue rather than admission to it.
     */
    loginVia: "opencode",
    // The agent publishes them, and how many depends on whether a key is set.
    models: [],
    // opencode spells them `opencode/big-pickle`; the vendor's own registry calls
    // that model `big-pickle`. Same rule as the row above.
    nativeModelPrefix: "opencode/",
    keyEnv: "OPENCODE_API_KEY",
  },
};

/**
 * Which systems a *machine* offers, as opposed to which this repository ships.
 *
 * The other half of {@link HarnessCatalogue}, and the two travel together as
 * {@link MachineCatalogue} because every question worth asking needs both: whether
 * a harness can be pointed at a system is a fact about a pair.
 *
 * ⚠ **`system()` answers the built-ins too**, unlike `harness()` next door which
 * answers only the contributed. The asymmetry is deliberate and follows what each
 * caller does with the answer: a system's row is *read* — a base URL, a header, a
 * model list — so one resolver that always answers is what keeps nine call sites
 * from each having to remember to check two places. A harness's row is *branched
 * on*, into a `switch` this repository owns and a shape it does not, so the two
 * kinds must stay distinguishable.
 */
export interface SystemCatalogue {
  /** A system this machine offers, built-in or contributed, or `null`. */
  system(id: string): SystemConfig | null;
  /** Every system id, in reading order: the built-ins first, then the contributed. */
  systemIds(): readonly string[];
  systemState(id: string): CatalogueState;
}

/** Both halves. Every function below takes one, defaulted to what this repository ships. */
export type MachineCatalogue = HarnessCatalogue & SystemCatalogue;

/**
 * A machine with no plugins — which is what every function here means by "no
 * catalogue given".
 *
 * ⚠ **A default argument rather than a required one, and that is what kept this
 * change from touching two hundred call sites.** Every existing caller — the
 * drivers' whole `hostable` matrix included — goes on asking exactly what it asked
 * before and gets exactly the same answer, because the built-in table *is* this
 * object. What a caller that knows about plugins passes is a wider one.
 */
export const BUILTIN_CATALOGUE: MachineCatalogue = {
  harness: () => null,
  harnessIds: () => AGENT_IDS,
  harnessState: (id) => (AGENT_IDS as readonly string[]).includes(id) ? "enabled" : "unknown",
  system: (id) => (isBuiltinSystemId(id) ? SYSTEMS[id] : null),
  systemIds: () => SYSTEM_IDS,
  systemState: (id) => (isBuiltinSystemId(id) ? "enabled" : "unknown"),
};

/**
 * What an agent answered about its own provider routing, or `null` where it
 * answered nothing.
 *
 * ⚠ **`providerId` is read off this and never written down.** Measured
 * 2026-08-25 against the pinned adapters: `claude-agent-acp` 0.63.0 calls its
 * provider `main` and `codex-acp` 1.1.9 calls its `custom-gateway`. A daemon
 * that hardcoded either would configure one agent and hand the other an
 * `invalid_params` naming a provider it has never heard of. This is
 * `acp-agents.md`'s "found by `category`, never by `id`" rule in a second place.
 */
export interface AgentRouting {
  providerId: string;
  supported: readonly string[];
}

/**
 * How a *routed* model is named to a harness, per harness.
 *
 * ⚠ **Measured 2026-08-25 against `claude-agent-acp` 0.63.0, and three of the
 * four obvious doors are wrong.** The question is how to make a harness offer —
 * and then run — a model id its own CLI has never heard of, which is the whole
 * of what a routed pairing needs. Read against the adapter's source,
 * `availableModels` looked like the answer, because
 * `applyAvailableModelsAllowlist` visibly synthesizes an entry for an id it
 * cannot match. Driven, it is not:
 *
 *   - `CLAUDE_MODEL_CONFIG={"availableModels":["kimi-k2-thinking"]}` collapses
 *     the published list to `["default"]`. The allowlist is plainly read — the
 *     built-in aliases disappear — and the unknown id does not survive it.
 *   - `_meta.claudeCode.options.settings.availableModels` does exactly the same.
 *     (It would also have collided with `ultracode`, which owns that key.)
 *   - `ANTHROPIC_CUSTOM_MODEL_OPTION` alone **does** append the row, keeping the
 *     built-ins — the documented "add a custom model option" — but leaves
 *     `currentValue` on the CLI's own default.
 *   - `ANTHROPIC_MODEL` alone appends the row **and** makes it current.
 *
 * Both of the last two are set. `ANTHROPIC_MODEL` is the one that was measured
 * to do the whole job; `ANTHROPIC_CUSTOM_MODEL_OPTION` is the *documented* way
 * to put a row in the picker, and setting the two together was measured to
 * compose rather than conflict. Relying on the undocumented half alone is how a
 * CLI update takes the feature out silently.
 *
 * ⚠ **The model id goes in the environment. The credential goes over stdio — and
 * then the adapter puts it in an environment anyway.** Measured against the
 * pinned `claude-agent-acp` 0.63.0: `createEnvForProvider` (dist/acp-agent.js:4569)
 * folds `providers/set`'s headers into
 * `ANTHROPIC_CUSTOM_HEADERS: "authorization: Bearer sk-…"` and spreads that into
 * the env it spawns the `claude` CLI with (:4128). Every Bash tool call is a child
 * of that process and inherits it.
 *
 * So the honest statement is narrower than the one that stood here: **this daemon**
 * does not put a system key in an environment, and `agentEnv`'s strip cannot
 * protect it either, because the daemon is *upstream* of where the adapter adds
 * it. A routed session's key is exposed to the agent exactly as a pasted agent
 * credential is — an `env` in a tool call writes it into the log, over the WS and
 * into the browser. Since `ROUTED_MODEL_ENV` permits only `claude`, that is every
 * routed session rather than an edge.
 *
 * Fixing it is not in this repository: it needs a change in the adapter, or
 * redaction on the transcript path, which this daemon has none of. What stdio buys
 * is one hop, not secrecy — do not write the stronger claim back.
 *
 * ⚠ **A harness missing from this table cannot host a routed system at all**,
 * and {@link hostable} reads it for that. Folding the two questions into one
 * answer is deliberate: a pairing this daemon can route but cannot point at a
 * model would start, look correct, and quietly run the endpoint's default model
 * — the failure with no symptom.
 */
export const ROUTED_MODEL_ENV: Partial<Record<AgentId, (model: string) => NodeJS.ProcessEnv>> = {
  claude: (model) => ({
    ANTHROPIC_MODEL: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION: model,
  }),
  // codex is absent and that is not a gap today: it accepts only `openai`
  // (measured — `custom-gateway`, `supported: ["openai"]`), every routed system
  // below is `anthropic`-shaped, so `hostable` already refuses the pairing one
  // test earlier. It becomes a gap the day an openai-shaped system is added, and
  // `hostable` is what will refuse it rather than let it run the wrong model.
  //
  // kimi is absent because it declares no provider capability at all.
};

/** Why a harness cannot host a system, or `null` when it can. */
export type HostRefusal = string | null;

/**
 * The key that signs a routed request to this system — the system's own, or the
 * one its native harness already holds.
 *
 * ⚠ **One account, two boxes, and only one of them was ever filled.** Both
 * secrets here are *the same string from the same OpenRouter account*, spent at
 * the same host: `system_credentials.openrouter` travels in `providers/set`
 * headers when a harness is routed there, and `agent_credentials(opencode,
 * OPENROUTER_API_KEY)` is merged into opencode's environment when it runs the same
 * catalogue natively. Somebody who has pasted "my OpenRouter key" once has
 * answered the question, and a second empty box under a second name is a trap the
 * daemon can simply not fall into: measured, a key saved for opencode and none for
 * the system refused the start of a Claude-Code-at-OpenRouter session with *"No
 * key is saved for OpenRouter…"*, over a machine that plainly had one.
 *
 * ⚠ **`keyEnv` is the gate and it is not a convenience — it is what makes this
 * true of exactly the rows it is true of.** Moonshot is the counter-example the
 * table already documents at length: `KIMI_API_KEY` is a Kimi Code *subscription*
 * at `api.kimi.com/coding`, while `system_credentials.moonshot` is a
 * pay-as-you-go key at `api.moonshot.ai` — different product, different host,
 * different billing. Borrowing one for the other would send the wrong secret to
 * the wrong endpoint and answer 401 with nothing on screen explaining it. Its
 * `keyEnv` is `null`, so this returns at the second line and that row is untouched.
 *
 * ⚠ **One direction only.** The stored system key wins where there is one, and
 * nothing here ever puts a *system* secret into a spawn environment: that is the
 * boundary `agentEnv` and the "credential travels in headers" rule are about, and
 * it is not what this crosses. What it does is fill one store's gap from another,
 * both of which this daemon already reads on this uid.
 *
 * Pure, and the *only* answer to "is there a key for this system" — `GET /systems`
 * reports `keySet` from it too. Two readers of one question is how the picker came
 * to offer a pairing the start then refused.
 */
export function systemSecretFor(
  system: SystemId,
  stored: string | null,
  agentEnv: (agent: AgentId) => Record<string, string>,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): string | null {
  if (stored !== null) return stored;
  const spec = machine.system(system);
  // A system this machine no longer offers has no key, borrowed or otherwise —
  // and saying so is not the same as saying there is none saved. `GET /systems`
  // does not list the row at all, so nothing draws a box over this answer.
  if (spec === null) return null;
  if (spec.keyEnv === null || spec.nativeHarness === null) return null;
  return agentEnv(spec.nativeHarness)[spec.keyEnv] ?? null;
}

/**
 * Whether this harness can be pointed at this system, and if not, what to say.
 *
 * ⚠ **The matrix is computed and lives nowhere else.** Writing it out would be a
 * second copy of something two adapters already answer, and the copy would go
 * stale on the first CLI update — silently, because a table that agrees with
 * itself passes every check.
 *
 * Pure, so `daemoncheck` and `webcheck` both drive it rather than driving a
 * transcription of it.
 */
/**
 * How a harness is told which model to run on somebody else's system, or `null`
 * where it cannot be told at all.
 *
 * One function for the two kinds, and the shapes really are the same: claude's arm
 * sets two variables to the same string, and a contributed harness sets however
 * many its manifest named to the same string. What differs is only where the names
 * come from — a measurement in this repository, or a manifest — which is why the
 * *values* were never a template on either side.
 *
 * ⚠ **Empty means `null`, not an empty environment.** A harness that named no
 * variable cannot be pointed at a foreign model, and {@link hostable} folds that in
 * as a refusal. Answering `{}` instead would start the session, look correct, and
 * quietly run the endpoint's default model — the failure with no symptom this whole
 * table exists to prevent.
 */
export function routedModelNaming(
  harness: AgentId,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): ((model: string) => NodeJS.ProcessEnv) | null {
  const contributed: ContributedHarness | null = machine.harness(harness);
  if (contributed === null) return ROUTED_MODEL_ENV[harness] ?? null;
  if (contributed.routedModelEnv.length === 0) return null;
  return (model) => Object.fromEntries(contributed.routedModelEnv.map((name) => [name, model]));
}

/**
 * Whether this pairing will be *routed* — pointed at somebody else's endpoint on
 * a key this daemon stores — rather than run on the agent's own credential.
 *
 * ⚠ **One copy of `spec.nativeHarness === harness && spec.baseUrl !== null`,
 * because `applySystem` already says a second one "is the kind of test that comes
 * to disagree with this one".** It answers the same question that function returns
 * after the fact; what this adds is that it can be asked *before* the spawn, which
 * is where `LocalRuntime.launch` needs it — the harness's own credentials go into
 * the environment at spawn time, and `applySystem` runs afterwards.
 *
 * Deliberately silent about whether the routing would *succeed*: a missing key, a
 * protocol the agent cannot speak and a provider whose plugin is switched off all
 * answer `true` here and are refused, with a sentence, by `applySystem`. The
 * question is "is this session aimed somewhere else", and for every one of those it
 * is, so none of them is a reason to hand over a vendor credential.
 */
export function routedPairing(
  harness: AgentId,
  system: SystemId | null,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): boolean {
  if (system === null) return false;
  const spec = machine.system(system);
  if (spec === null) return false;
  return spec.nativeHarness !== harness && spec.baseUrl !== null;
}

export function hostable(
  harness: AgentId,
  system: SystemId,
  routing: AgentRouting | null,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): HostRefusal {
  const spec = machine.system(system);
  /*
   * ⚠ **Reachable only through something stored, which is why it answers a
   * sentence rather than throwing.** `GET /systems` never lists a system this
   * machine does not offer, so nothing on a picker can produce this pair. What can
   * is a saved preset whose plugin was removed, and a preset whose only button
   * throws is worse than one whose row says why.
   */
  if (spec === null) {
    return machine.systemState(system) === "disabled"
      ? `This provider comes from a plugin that is switched off on this machine.`
      : `This provider is no longer on this machine.`;
  }
  // Native needs no routing at all, so it is answered before `routing` is even
  // consulted — kimi supports no provider methods and still reaches Moonshot.
  if (spec.nativeHarness === harness) return null;
  if (spec.baseUrl === null) {
    return `${spec.displayName} can only be reached by the CLI it ships with.`;
  }
  if (routing === null) {
    return `This agent only runs its own models.`;
  }
  if (!routing.supported.includes(spec.apiType)) {
    /*
     * ⚠ **`routing.supported` is not in the sentence, and that is deliberate.**
     * It reads `["anthropic","bedrock","vertex"]` — three protocol names, two of
     * which look like companies — and this string is rendered by `errorText` on a
     * phone. It said "This agent accepts openai systems, and Moonshot is
     * anthropic" for one release, which names nothing anybody has seen anywhere
     * else in the product. The wire vocabulary stays in the code. The client's
     * mirror in `packages/web/src/agents.ts` says the same thing with the
     * harness's own display name in front of it, which is a name this side does
     * not have and will not keep a second copy of.
     */
    return `This agent cannot run ${spec.displayName} models.`;
  }
  // Routable and un-pinnable is the state that must not reach a session: see
  // ROUTED_MODEL_ENV. It would run somebody else's default model under our name.
  //
  // ⚠ **This is the arm that fires for an openai-shaped system paired with codex,
  // and it is the *fourth* rather than the third.** codex answers
  // `supported: ["openai"]`, so it passes the protocol test one line up and dies
  // here. `ROUTED_MODEL_ENV`'s own comment predicted the day an openai-shaped
  // system was added and said this is what would refuse it; a plugin adding one is
  // that day. Do not close it by inventing a codex arm — which variable codex reads
  // for a custom-gateway model is a measurement nobody here has taken, and guessing
  // produces exactly the silent wrong-model failure this line prevents.
  if (routedModelNaming(harness, machine) === null) {
    return `This agent cannot be told which model to use on another system.`;
  }
  return null;
}

/**
 * The environment a routed pairing's agent is spawned with, or `{}` for a
 * native one.
 *
 * Native returns nothing rather than the harness's own default spelled out:
 * naming the model a session was already going to run is a claim that goes stale
 * the day the CLI changes its default, and the model control on screen would
 * then disagree with the chip beside it.
 */
export function routedModelEnv(
  harness: AgentId,
  system: SystemId,
  model: string,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): NodeJS.ProcessEnv {
  const spec = machine.system(system);
  // `{}` for a system that no longer resolves, and this arm runs *before the
  // spawn* on both launch paths. Refusing here would throw where nothing catches
  // it; what refuses the pairing is `hostable`, one call later on `start` and — on
  // `openResumed`, which may not refuse — `pinNativeModel`'s reported sentence.
  if (spec === null || spec.nativeHarness === harness) return {};
  return routedModelNaming(harness, machine)?.(model) ?? {};
}

/**
 * The headers a routed session's traffic carries, or `null` for a native one.
 *
 * Takes the secret rather than reaching for it: this module holds the table and
 * nothing else, and a function here that could read a credential store would be
 * a second place credentials are fetched from.
 */
export function routingHeaders(
  system: SystemId,
  secret: string,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): Record<string, string> {
  const header = machine.system(system)?.authHeader ?? null;
  if (header === null) return {};
  return { [header.name]: `${header.prefix}${secret}` };
}


/**
 * A harness, a system and a model, under a name somebody chose.
 *
 * The vocabulary lives here rather than in the store for `AgentCredentialStore`'s
 * reason one directory over: what a thing *is* belongs beside the rules about it,
 * and the SQLite class satisfies this structurally without either side importing
 * the other.
 */
export interface CustomAgent {
  id: string;
  name: string;
  harness: AgentId;
  system: SystemId;
  model: string;
  createdAt: number;
}

/**
 * Where a system's key is kept.
 *
 * ⚠ **`get` exists and `AgentCredentialStore` deliberately has no equivalent.**
 * That one refuses a getter because the only correct destination for an agent
 * credential is a process environment, and a getter is how it reaches a response
 * body instead. A system key's only correct destination is a *header value* in
 * `providers/set`, so it has to be readable — and what keeps it safe is that the
 * one caller is `LocalRuntime.systemSecret`, with no route anywhere near it.
 */
export interface SystemCredentialPort {
  list(): { system: SystemId; updatedAt: number }[];
  get(system: SystemId): string | null;
  save(system: SystemId, secret: string): void;
  remove(system: SystemId): void;
}

export interface CustomAgentPort {
  list(): CustomAgent[];
  get(id: string): CustomAgent | null;
  save(one: CustomAgent): void;
  remove(id: string): void;
}

/**
 * One remembered position in a machine's agent strip.
 *
 * ⚠ **`ref` names something this daemon may not currently have, and that is the
 * point rather than a gap.** A harness signed out for a week and a preset a
 * rollback cannot resolve both keep their positions; what the New session strip
 * draws is this list *merged* against what the machine offers right now, so a
 * `ref` that resolves to nothing is dropped at draw time and comes back the
 * moment the thing does. Validating it on the way in would forget an order every
 * time an agent was briefly unavailable — the one failure somebody would notice,
 * because it looks like the daemon rearranging their screen by itself.
 *
 * It is therefore **bounded rather than checked**: `MAX_STRIP_REF_CHARS` on the
 * route is what keeps an unknown id from being an essay, and nothing here has an
 * opinion about what the id means.
 */
export interface AgentStripEntry {
  /** A built-in harness, or an agent somebody assembled. */
  kind: "harness" | "custom";
  /** A harness id or an assembled agent's id. Never weighed against what exists. */
  ref: string;
  /** Kept out of the New session strip. */
  hidden: boolean;
}

/**
 * The strip, replaced whole.
 *
 * ⚠ **`replace` and not a per-entry `save`, because the screen that writes this
 * always holds the whole list.** A reorder is a statement about every position at
 * once, so an upsert-per-row would need a second decision — what happens to a row
 * the caller did not mention — that no caller has. `forget` exists for the one
 * write that is *not* the screen: dropping an assembled agent takes its position
 * with it, so the table cannot grow forever behind a feature nobody uses.
 */
export interface AgentStripPort {
  list(): AgentStripEntry[];
  replace(entries: readonly AgentStripEntry[]): void;
  forget(kind: AgentStripEntry["kind"], ref: string): void;
}

/**
 * All three together, because they are one absence.
 *
 * A daemon with no database can hold none of them, and handing them in separately
 * would let part of the feature answer 503 while the rest looked live.
 */
export interface SystemStores {
  credentials: SystemCredentialPort;
  customAgents: CustomAgentPort;
  strip: AgentStripPort;
}
