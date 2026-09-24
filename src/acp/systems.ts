import { AGENT_IDS, type AgentId, type CatalogueState, type ContributedHarness, type HarnessCatalogue } from "./agents.js";

// A system is who serves a model, not the harness running it; a request names only a SystemId, never a URL, header or variable.
// This order is the reading order the client groups models by; nothing branches on a position.
export const SYSTEM_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "xai",
  "moonshot",
  "zhipu",
  "minimax",
  "zen",
] as const;

/** One of the eight this repository ships. */
export type BuiltinSystemId = (typeof SYSTEM_IDS)[number];

export type SystemId = string;

export function isBuiltinSystemId(value: string): value is BuiltinSystemId {
  return (SYSTEM_IDS as readonly string[]).includes(value);
}

export type SystemApiType = "anthropic" | "openai";

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
  apiType: SystemApiType;
  baseUrl: string | null;
  authHeader: SystemAuthHeader | null;
  nativeHarness: AgentId | null;
  loginVia: AgentId | null;
  /** A starting set for routed use and never validated against (any typed id is accepted); empty when the native CLI publishes its own. */
  models: readonly SystemModel[];
  /** Prefix the native harness puts on model ids; stored and sent ids are unprefixed, and pinNativeModel restores it (Q3.488). */
  nativeModelPrefix: string | null;
  /** Which variable holds this system's key when its CLI reads one per system (opencode serves two); otherwise null. */
  keyEnv: string | null;

  contributedBy?: { pluginId: string; pluginName: string };
}

export const SYSTEMS: Record<BuiltinSystemId, SystemConfig> = {
  anthropic: {
    displayName: "Anthropic",
    apiType: "anthropic",
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
  xai: {
    displayName: "xAI",
    apiType: "anthropic",
    // null until a real key proves xAI serves an Anthropic body at /v1/messages; it documents no such endpoint.
    baseUrl: null,
    authHeader: null,
    nativeHarness: "grok",
    loginVia: "grok",
    models: [],
    nativeModelPrefix: null,
    keyEnv: "XAI_API_KEY",
  },
  moonshot: {
    displayName: "Moonshot",
    apiType: "anthropic",
    baseUrl: "https://api.moonshot.ai/anthropic",
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
  },
  zhipu: {
    displayName: "Z.ai (GLM)",
    apiType: "anthropic",
    baseUrl: "https://api.z.ai/api/anthropic",
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
  },
  minimax: {
    displayName: "MiniMax",
    apiType: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic",
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
  },
  openrouter: {
    displayName: "OpenRouter",
    apiType: "anthropic",
    // The base ends at /api: the SDK appends /v1/messages.
    baseUrl: "https://openrouter.ai/api",
    authHeader: { name: "authorization", prefix: "Bearer " },
    nativeHarness: "opencode",
    loginVia: "opencode",
    models: [],
    nativeModelPrefix: "openrouter/",
    keyEnv: "OPENROUTER_API_KEY",
  },
  zen: {
    displayName: "OpenCode Zen",
    apiType: "openai",
    // null: naming Zen's endpoint would offer claude a routed pairing it cannot pin a model for.
    baseUrl: null,
    authHeader: null,
    nativeHarness: "opencode",
    // Names opencode though it has no sign-in: the key is an opencode credential, and a system key box here would never be spent.
    loginVia: "opencode",
    models: [],
    nativeModelPrefix: "opencode/",
    keyEnv: "OPENCODE_API_KEY",
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
// The adapter still puts the routed key into the agent's environment: stdio buys one hop, not secrecy.
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

/** Whether this pairing is routed rather than native, answerable before the spawn; silent about whether routing would succeed. */
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
  if (spec === null) {
    return machine.systemState(system) === "disabled"
      ? `This provider comes from a plugin that is switched off on this machine.`
      : `This provider is no longer on this machine.`;
  }
  if (spec.nativeHarness === harness) return null;
  if (spec.baseUrl === null) {
    return `${spec.displayName} can only be reached by the CLI it ships with.`;
  }
  if (routing === null) {
    return `This agent only runs its own models.`;
  }
  if (!routing.supported.includes(spec.apiType)) {
    return `This agent cannot run ${spec.displayName} models.`;
  }
  // Routable but un-pinnable must not reach a session, or it runs the endpoint's default model. Do not guess a codex arm.
  if (routedModelNaming(harness, machine) === null) {
    return `This agent cannot be told which model to use on another system.`;
  }
  return null;
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

/** Readable, unlike agent credentials: a system key's only destination is a providers/set header. */
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
  customAgents: CustomAgentPort;
  strip: AgentStripPort;
}
