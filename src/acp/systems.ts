import { AGENT_IDS, type AgentId, type CatalogueState, type ContributedHarness, type HarnessCatalogue } from "./agents.js";
import { doorOf, type HarnessDoor } from "./doors.js";
import type { SignInTokens } from "../gateway/signin/types.js";

// A system is who serves a model, not the harness running it; a request names only a SystemId, never a URL, header or variable.
// This order is the reading order the client groups models by; nothing branches on a position.
export const SYSTEM_IDS = [
  "anthropic",
  "openai",
  "chatgpt",
  "openrouter",
  "cursor",
  "xai",
  "moonshot",
  "zhipu",
  "minimax",
  "zen",
] as const;

/** One of the nine this repository ships. */
export type BuiltinSystemId = (typeof SYSTEM_IDS)[number];

export type SystemId = string;

export function isBuiltinSystemId(value: string): value is BuiltinSystemId {
  return (SYSTEM_IDS as readonly string[]).includes(value);
}

/** ACP's providers vocabulary. Coarser than a wire protocol: "openai" does not say Chat Completions or Responses. */
export type SystemApiType = "anthropic" | "openai";

/** What a harness and an endpoint say to each other. */
export type WireProtocol = "anthropic-messages" | "openai-responses" | "openai-chat";

/** What providers/set is told an endpoint speaks, and what providers/list's `supported` is read as. */
const ACP_API_TYPE: Record<WireProtocol, SystemApiType> = {
  "anthropic-messages": "anthropic",
  "openai-responses": "openai",
  "openai-chat": "openai",
};

const WIRE_PROTOCOLS = Object.keys(ACP_API_TYPE) as WireProtocol[];

/** What the gateway carries one protocol into another for, harness side first. Only a route through the gateway may use one. */
export const TRANSLATIONS: readonly (readonly [WireProtocol, WireProtocol])[] = [["anthropic-messages", "openai-responses"]];

export interface SystemAuthHeader {
  name: string;
  prefix: string;
}

export interface SystemModel {
  id: string;
  name: string;
}

export interface SystemConfig {
  displayName: string;
  /** Sent to the app as is; nothing here routes on it. */
  apiType: SystemApiType;
  /** Where this system answers, by protocol, most preferred first; empty when only its own CLI reaches it. Every model it lists must answer on every one. */
  endpoints: Readonly<Partial<Record<WireProtocol, string>>>;
  authHeader: SystemAuthHeader | null;
  nativeHarness: AgentId | null;
  loginVia: AgentId | null;
  /** A starting set for routed use and never validated against (any typed id is accepted); empty when the native CLI publishes its own. */
  models: readonly SystemModel[];
  /** Prefix the native harness puts on model ids; stored and sent ids are unprefixed, and pinNativeModel restores it (Q3.488). */
  nativeModelPrefix: string | null;
  /** Which variable holds this system's key when its CLI reads one per system (opencode serves two); otherwise null. */
  keyEnv: string | null;
  /** The flow a person signs in to this system with, where its credential is a sign-in and never a pasted key; otherwise null. */
  signIn: string | null;

  contributedBy?: { pluginId: string; pluginName: string };
}

export const SYSTEMS: Record<BuiltinSystemId, SystemConfig> = {
  anthropic: {
    displayName: "Anthropic",
    apiType: "anthropic",
    // An API key's endpoint. The sign-in claude holds is never a key for it (Q7.156).
    endpoints: { "anthropic-messages": "https://api.anthropic.com" },
    authHeader: { name: "x-api-key", prefix: "" },
    nativeHarness: "claude",
    loginVia: "claude",
    models: [],
    nativeModelPrefix: null,
    keyEnv: null,
    signIn: null,
  },
  openai: {
    displayName: "OpenAI",
    apiType: "openai",
    // An API key's endpoint, and another product than the sign-in codex holds.
    endpoints: { "openai-responses": "https://api.openai.com/v1" },
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: "codex",
    loginVia: "codex",
    models: [],
    nativeModelPrefix: null,
    keyEnv: null,
    signIn: null,
  },
  chatgpt: {
    displayName: "ChatGPT",
    apiType: "openai",
    // The same address as OpenAI's API and another product: a plan a person signs in to, with its own models and limits (Q7.160).
    endpoints: { "openai-responses": "https://api.openai.com/v1" },
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: null,
    loginVia: null,
    // The one model the programme's documentation names; an account lists its own, which nothing here has read.
    models: [{ id: "gpt-6.1-sol", name: "gpt-6.1-sol" }],
    nativeModelPrefix: null,
    keyEnv: null,
    signIn: "openai-siwc",
  },
  xai: {
    displayName: "xAI",
    apiType: "anthropic",
    // None until a real key proves xAI serves an Anthropic body at /v1/messages; it documents no such endpoint.
    endpoints: {},
    authHeader: null,
    nativeHarness: "grok",
    loginVia: "grok",
    models: [],
    nativeModelPrefix: null,
    keyEnv: "XAI_API_KEY",
    signIn: null,
  },
  cursor: {
    displayName: "Cursor",
    // Cursor documents no endpoint another harness could be pointed at.
    apiType: "openai",
    endpoints: {},
    authHeader: null,
    nativeHarness: "cursor",
    loginVia: "cursor",
    models: [],
    // Bare ids under the parameterized picker (claude-opus-4-8, gpt-5), the only ones this client asks for (Q6.115).
    nativeModelPrefix: null,
    keyEnv: "CURSOR_API_KEY",
    signIn: null,
  },
  moonshot: {
    displayName: "Moonshot",
    apiType: "anthropic",
    endpoints: { "anthropic-messages": "https://api.moonshot.ai/anthropic" },
    // Bearer, not x-api-key: Moonshot's Claude Code setup uses the auth-token variable, and the two are not interchangeable there.
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: "kimi",
    loginVia: "kimi",
    models: [
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
      { id: "kimi-k2.6", name: "Kimi K2.6" },
    ],
    // Kimi's list and Moonshot's are different products, so no prefix relates them (Q3.488).
    nativeModelPrefix: null,
    keyEnv: null,
    signIn: null,
  },
  zhipu: {
    displayName: "Z.ai (GLM)",
    apiType: "anthropic",
    endpoints: { "anthropic-messages": "https://api.z.ai/api/anthropic" },
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: null,
    loginVia: null,
    models: [
      { id: "glm-5.3", name: "GLM-5.3" },
      { id: "glm-4.7", name: "GLM-4.7" },
      { id: "glm-4.6", name: "GLM-4.6" },
      { id: "glm-4.5-air", name: "GLM-4.5 Air" },
    ],
    nativeModelPrefix: null,
    keyEnv: null,
    signIn: null,
  },
  minimax: {
    displayName: "MiniMax",
    apiType: "anthropic",
    endpoints: { "anthropic-messages": "https://api.minimax.io/anthropic" },
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: null,
    loginVia: null,
    models: [
      { id: "MiniMax-M3", name: "MiniMax M3" },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
      { id: "MiniMax-M2", name: "MiniMax M2" },
    ],
    nativeModelPrefix: null,
    keyEnv: null,
    signIn: null,
  },
  openrouter: {
    displayName: "OpenRouter",
    apiType: "anthropic",
    // The base ends at /api: the SDK appends /v1/messages.
    endpoints: { "anthropic-messages": "https://openrouter.ai/api" },
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: "opencode",
    loginVia: "opencode",
    models: [],
    nativeModelPrefix: "openrouter/",
    keyEnv: "OPENROUTER_API_KEY",
    signIn: null,
  },
  zen: {
    displayName: "OpenCode Zen",
    apiType: "openai",
    // None: nothing here has driven Zen's own endpoint, and a row is a measurement. opencode reaches it as its own.
    endpoints: {},
    authHeader: null,
    nativeHarness: "opencode",
    // Names opencode though it has no sign-in: the key is an opencode credential, and a system key box here would never be spent.
    loginVia: "opencode",
    models: [],
    nativeModelPrefix: "opencode/",
    keyEnv: "OPENCODE_API_KEY",
    signIn: null,
  },
};

export interface SystemCatalogue {
  system(id: string): SystemConfig | null;
  systemIds(): readonly string[];
  systemState(id: string): CatalogueState;
}

export type MachineCatalogue = HarnessCatalogue & SystemCatalogue;

export const BUILTIN_CATALOGUE: MachineCatalogue = {
  harness: () => null,
  harnessIds: () => AGENT_IDS,
  harnessState: (id) => (AGENT_IDS as readonly string[]).includes(id) ? "enabled" : "unknown",
  system: (id) => (isBuiltinSystemId(id) ? SYSTEMS[id] : null),
  systemIds: () => SYSTEM_IDS,
  systemState: (id) => (isBuiltinSystemId(id) ? "enabled" : "unknown"),
};

/** providerId is read off the agent, never hardcoded: adapters name their provider differently. */
export interface AgentRouting {
  providerId: string;
  supported: readonly string[];
}

// How a routed model is named per harness; a harness absent here cannot host a routed system. availableModels drops unknown ids (applyAvailableModelsAllowlist).
// The adapter passes the routed key to the CLI on its command line, and a header named authorization never reaches the endpoint (Q6.123).
export const ROUTED_MODEL_ENV: Partial<Record<AgentId, (model: string) => NodeJS.ProcessEnv>> = {
  claude: (model) => ({
    ANTHROPIC_MODEL: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION: model,
  }),
};

export type HostRefusal = string | null;

/** The routed key: the system's own, else its native harness's, only where keyEnv is set. The single answer to whether a system has a key. */
export function systemSecretFor(
  system: SystemId,
  stored: string | null,
  agentEnv: (agent: AgentId) => Record<string, string>,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): string | null {
  if (stored !== null) return stored;
  const spec = machine.system(system);
  if (spec === null) return null;
  if (spec.keyEnv === null || spec.nativeHarness === null) return null;
  return agentEnv(spec.nativeHarness)[spec.keyEnv] ?? null;
}

/** Env naming a routed model for this harness, or null when it cannot be told, so hostable refuses rather than running the default model. */
export function routedModelNaming(
  harness: AgentId,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): ((model: string) => NodeJS.ProcessEnv) | null {
  const contributed: ContributedHarness | null = machine.harness(harness);
  if (contributed === null) return ROUTED_MODEL_ENV[harness] ?? null;
  if (contributed.routedModelEnv.length === 0) return null;
  return (model) => Object.fromEntries(contributed.routedModelEnv.map((name) => [name, model]));
}

/** Whether another harness can be pointed at this system at all. */
export function isRoutable(spec: SystemConfig): boolean {
  return Object.keys(spec.endpoints).length > 0;
}

/** A manifest names one address and ACP's coarse type. Which OpenAI dialect its "openai" speaks is not stated; it is filed under Chat Completions, what a third-party OpenAI-compatible endpoint serves. */
export function declaredEndpoints(apiType: SystemApiType, baseUrl: string | null): SystemConfig["endpoints"] {
  if (baseUrl === null) return {};
  return apiType === "anthropic" ? { "anthropic-messages": baseUrl } : { "openai-chat": baseUrl };
}

/** Whether this pairing is routed rather than native, answerable before the spawn; silent about whether routing would succeed. */
export function routedPairing(
  harness: AgentId,
  system: SystemId | null,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): boolean {
  if (system === null) return false;
  const spec = machine.system(system);
  if (spec === null) return false;
  return spec.nativeHarness !== harness && isRoutable(spec);
}

export type Route =
  | { kind: "native" }
  | {
      kind: "routed";
      /** What the harness speaks. */
      protocol: WireProtocol;
      /** Where the request goes and what is spoken there: the same protocol, or one the gateway translates into. */
      outbound: { protocol: WireProtocol; baseUrl: string };
      apiType: SystemApiType;
      /** gateway: the harness is handed this daemon's address and the vendor never sees it. direct: it is handed the vendor's own. */
      via: "gateway" | "direct";
    }
  | { kind: "refused"; why: string };

/** The one answer to whether and how a harness reaches a system: hostable reports its refusal, applySystem sends its route. */
export function routeFor(
  harness: AgentId,
  system: SystemId,
  routing: AgentRouting | null,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): Route {
  const refused = (why: string): Route => ({ kind: "refused", why });
  const spec = machine.system(system);
  if (spec === null) {
    return refused(
      machine.systemState(system) === "disabled"
        ? `This provider comes from a plugin that is switched off on this machine.`
        : `This provider is no longer on this machine.`,
    );
  }
  if (spec.nativeHarness === harness) return { kind: "native" };
  const offered = (Object.keys(spec.endpoints) as WireProtocol[]).flatMap((protocol) => {
    const baseUrl = spec.endpoints[protocol];
    return baseUrl === undefined ? [] : [{ protocol, baseUrl }];
  });
  if (offered.length === 0) {
    return refused(`${spec.displayName} can only be reached by the CLI it ships with.`);
  }
  const door = doorOf(harness);
  // A door set at the spawn names the address, the credential and the model together, and asks the agent nothing.
  if (door?.via === "spawn") {
    const reached = reach(offered, door.speaks, true);
    if (reached === null) {
      return refused(`This agent cannot run ${spec.displayName} models.`);
    }
    return { kind: "routed", ...reached, apiType: ACP_API_TYPE[reached.protocol], via: "gateway" };
  }
  if (routing === null) {
    return refused(`This agent only runs its own models.`);
  }
  const reached = reach(offered, spokenThroughAcp(routing, door), door !== null);
  if (reached === null) {
    return refused(`This agent cannot run ${spec.displayName} models.`);
  }
  // Routable but un-pinnable must not reach a session, or it runs the endpoint's default model. Do not guess a codex arm.
  if (routedModelNaming(harness, machine) === null) {
    return refused(`This agent cannot be told which model to use on another system.`);
  }
  // A sign-in is spent by the gateway alone: a harness with no door would have to be handed its token.
  if (door === null && spec.signIn !== null) {
    return refused(`This agent cannot run ${spec.displayName} models.`);
  }
  return {
    kind: "routed",
    ...reached,
    apiType: ACP_API_TYPE[reached.protocol],
    via: door === null ? "direct" : "gateway",
  };
}

/** What a harness told through providers/set can be made to speak: what its agent accepts, and of that what its door was measured to carry. */
function spokenThroughAcp(routing: AgentRouting, door: HarnessDoor | null): WireProtocol[] {
  return WIRE_PROTOCOLS.filter(
    (protocol) => routing.supported.includes(ACP_API_TYPE[protocol]) && (door === null || door.speaks.includes(protocol)),
  );
}

/** The system's own preference in a protocol the harness speaks; failing that, one the gateway translates into. */
function reach(
  offered: readonly { protocol: WireProtocol; baseUrl: string }[],
  spoken: readonly WireProtocol[],
  throughGateway: boolean,
): { protocol: WireProtocol; outbound: { protocol: WireProtocol; baseUrl: string } } | null {
  const direct = offered.find((one) => spoken.includes(one.protocol));
  if (direct !== undefined) return { protocol: direct.protocol, outbound: direct };
  if (!throughGateway) return null;
  for (const one of offered) {
    const pair = TRANSLATIONS.find(([inbound, outbound]) => outbound === one.protocol && spoken.includes(inbound));
    if (pair !== undefined) return { protocol: pair[0], outbound: one };
  }
  return null;
}

export function hostable(
  harness: AgentId,
  system: SystemId,
  routing: AgentRouting | null,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): HostRefusal {
  const route = routeFor(harness, system, routing, machine);
  return route.kind === "refused" ? route.why : null;
}

/** The protocols of a system a harness can be pointed at: what the app intersects with a system's own, so it greys what routeFor would refuse. */
export function hostedProtocols(
  harness: AgentId,
  routing: AgentRouting | null,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): WireProtocol[] {
  const door = doorOf(harness);
  let spoken: readonly WireProtocol[];
  if (door?.via === "spawn") spoken = door.speaks;
  else if (routing === null || routedModelNaming(harness, machine) === null) return [];
  else spoken = spokenThroughAcp(routing, door);
  if (door === null) return [...spoken];
  const carried = TRANSLATIONS.filter(([inbound]) => spoken.includes(inbound)).map(([, outbound]) => outbound);
  return WIRE_PROTOCOLS.filter((protocol) => spoken.includes(protocol) || carried.includes(protocol));
}

export function routedModelEnv(
  harness: AgentId,
  system: SystemId,
  model: string,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): NodeJS.ProcessEnv {
  const spec = machine.system(system);
  if (spec === null || spec.nativeHarness === harness) return {};
  return routedModelNaming(harness, machine)?.(model) ?? {};
}

export function routingHeaders(
  system: SystemId,
  secret: string,
  machine: MachineCatalogue = BUILTIN_CATALOGUE,
): Record<string, string> {
  const header = machine.system(system)?.authHeader ?? null;
  if (header === null) return {};
  return { [header.name]: `${header.prefix}${secret}` };
}


export interface CustomAgent {
  id: string;
  name: string;
  harness: AgentId;
  system: SystemId;
  model: string;
  createdAt: number;
}

export interface StoredSignIn extends SignInTokens {
  flow: string;
  /** Who signed in, as the request that finished it named them; null where it was this machine's own listener. */
  signedInBy: string | null;
  updatedAt: number;
}

export interface SystemSignInPort {
  get(system: SystemId): StoredSignIn | null;
  save(system: SystemId, flow: string, tokens: SignInTokens, signedInBy: string | null): void;
  remove(system: SystemId): void;
  /** This machine's own name to a provider, minted at first use. */
  hostId(flow: string): string;
}

/** Readable, unlike agent credentials: a system key's only destination is a request this daemon signs. */
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

/** ref may name something not currently present: merged at draw time and bounded by length, never validated. */
export interface AgentStripEntry {
  kind: "harness" | "custom";
  ref: string;
  hidden: boolean;
}

export interface AgentStripPort {
  list(): AgentStripEntry[];
  replace(entries: readonly AgentStripEntry[]): void;
  forget(kind: AgentStripEntry["kind"], ref: string): void;
}

export interface SystemStores {
  credentials: SystemCredentialPort;
  /** Absent in a driver that stands a Map in for the store. */
  signIns?: SystemSignInPort;
  customAgents: CustomAgentPort;
  strip: AgentStripPort;
}
