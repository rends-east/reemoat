import type { AgentId } from "./agents.js";

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
export const SYSTEM_IDS = ["anthropic", "openai", "moonshot", "zhipu", "minimax"] as const;

export type SystemId = (typeof SYSTEM_IDS)[number];

/** The HTTP boundary's guard, exactly as `isAgentId` is for a harness. */
export function isSystemId(value: string): value is SystemId {
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
   * Whose CLI drives this system's interactive sign-in, or `null` where nothing
   * can.
   *
   * A capability that may be absent, living in the table rather than in either
   * reader — the shape `AGENT_LOGIN.logoutArgs` already has for kimi. The client
   * draws a wizard from this and a bare key box from its absence, so a system
   * with no CLI never offers a button that answers 503.
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
export const SYSTEMS: Record<SystemId, SystemConfig> = {
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
  },
  openai: {
    displayName: "OpenAI",
    apiType: "openai",
    baseUrl: null,
    authHeader: null,
    nativeHarness: "codex",
    loginVia: "codex",
    models: [],
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
  },
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
export function hostable(
  harness: AgentId,
  system: SystemId,
  routing: AgentRouting | null,
): HostRefusal {
  const spec = SYSTEMS[system];
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
  if (ROUTED_MODEL_ENV[harness] === undefined) {
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
): NodeJS.ProcessEnv {
  if (SYSTEMS[system].nativeHarness === harness) return {};
  return ROUTED_MODEL_ENV[harness]?.(model) ?? {};
}

/**
 * The headers a routed session's traffic carries, or `null` for a native one.
 *
 * Takes the secret rather than reaching for it: this module holds the table and
 * nothing else, and a function here that could read a credential store would be
 * a second place credentials are fetched from.
 */
export function routingHeaders(system: SystemId, secret: string): Record<string, string> {
  const header = SYSTEMS[system].authHeader;
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
 * Both halves together, because they are one absence.
 *
 * A daemon with no database can hold neither, and handing them in separately
 * would let half the feature answer 503 while the other half looked live.
 */
export interface SystemStores {
  credentials: SystemCredentialPort;
  customAgents: CustomAgentPort;
}
