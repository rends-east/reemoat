import { agentLabel, agentStance, boundedName, offersTile, startsBare } from "./ui/agentCard";
import {
  AGENT_IDS,
  type AgentAuthInfo,
  type AgentCapabilities,
  type AgentId,
  type AgentAvailability,
  type CustomAgent,
  type SystemInfo,
} from "./wire";

export type HostRefusal = string | null;

/** Mirrors hostable in src/acp/systems.ts; routing null means the harness is never re-pointed. */
export function hostable(
  harness: AgentId,
  system: SystemInfo,
  routing: AgentCapabilities["routing"],
  nameOf: (id: string) => string = agentLabel,
): HostRefusal {
  if (system.nativeHarness === harness) return null;
  // Absent (an older daemon) counts as not routable.
  if (system.routable !== true) {
    return system.nativeHarness === null
      ? `${system.displayName} cannot be reached from this machine.`
      : `Only ${nameOf(system.nativeHarness)} can run ${system.displayName} models.`;
  }
  if (routing === null) {
    return `${nameOf(harness)} only runs its own models.`;
  }
  if (!routing.supported.includes(system.apiType)) {
    return cannotRunSystem(harness, system, nameOf);
  }
  // Absent pinsModel means yes: an older daemon only routes harnesses that pin.
  if (routing.pinsModel === false) {
    return cannotRunSystem(harness, system, nameOf);
  }
  return null;
}

function cannotRunSystem(harness: AgentId, system: SystemInfo, nameOf: (id: string) => string): string {
  return `${nameOf(harness)} cannot run ${system.displayName} models.`;
}

export interface ModelChoice {
  system: SystemInfo;
  modelId: string;
  modelName: string;
  /** published: the native harness's spelling; table: the endpoint's. Ids are not portable across harnesses. */
  source: "published" | "table";
}

/** Whether this pairing needs the system key: always for a non-native harness, otherwise only for a table id. */
export function keyMissing(choice: ModelChoice, harness: AgentId | null): HostRefusal {
  const absent = `No ${choice.system.displayName} key on this machine.`;
  if (harness !== null && choice.system.nativeHarness !== harness) {
    return choice.system.keySet ? null : absent;
  }
  if (choice.source === "published") return null;
  return choice.system.keySet ? null : absent;
}

/** Strips the heading's own displayName + "/" (case-folded, never a RegExp); fails open and never empties the name (Q3.488). */
function withoutProviderLabel(displayName: string, name: string): string {
  if (displayName.length === 0) return name;
  const marker = `${displayName}/`;
  if (name.slice(0, marker.length).toLowerCase() !== marker.toLowerCase()) return name;
  const rest = name.slice(marker.length).trim();
  return rest.length === 0 ? name : rest;
}

/** Adds typed ids as table rows of routable systems only (Q3.501); trimmed, empty or already-listed ids are ignored. */
export function adoptModels(
  systems: readonly SystemInfo[],
  typed: readonly { system: string; model: string }[],
): SystemInfo[] {
  return systems.map((system) => {
    if (system.routable !== true) return system;
    const added: { id: string; name: string }[] = [];
    for (const one of typed) {
      const id = one.model.trim();
      if (one.system !== system.id || id.length === 0) continue;
      if (system.models.some((row) => row.id === id) || added.some((row) => row.id === id)) continue;
      added.push({ id, name: id });
    }
    return added.length === 0 ? system : { ...system, models: [...system.models, ...added] };
  });
}

/** Providers with no rows because their native harness could not be asked (capabilities.error); null otherwise. */
export function unreadSystemsNotice(
  systems: readonly SystemInfo[],
  capabilities: Readonly<Record<string, AgentCapabilities>> | null,
  exclude: readonly string[] = [],
): string | null {
  if (capabilities === null) return null;
  const silent: string[] = [];
  for (const system of systems) {
    const harness = system.nativeHarness;
    if (harness === null || system.models.length > 0) continue;
    if (exclude.includes(system.id)) continue;
    if ((capabilities[harness]?.error ?? null) === null) continue;
    silent.push(`${system.displayName} (${agentLabel(harness)})`);
  }
  if (silent.length === 0) return null;
  const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(silent);
  return `This machine couldn't check what it can run, so ${names} lists nothing here.`;
}

export function allModels(
  systems: readonly SystemInfo[],
  capabilities: Readonly<Record<string, AgentCapabilities>>,
  /** Ids the catalogue refused for lacking tool support; fails open. */
  toolless: Iterable<string> = [],
  harness: AgentId | null = null,
): ModelChoice[] {
  const refused = new Set(toolless);
  const out: ModelChoice[] = [];
  for (const system of systems) {
    const native = system.nativeHarness;
    const published = native === null ? [] : (capabilities[native]?.models ?? []);
    const prefix = system.nativeModelPrefix ?? "";
    for (const model of published) {
      if (model.id === "default") continue;
      // One harness can be native to several systems (opencode: OpenRouter and Zen); the prefix picks this system's rows.
      if (prefix !== "" && !model.id.startsWith(prefix)) continue;
      const id = prefix === "" ? model.id : model.id.slice(prefix.length);
      if (refused.has(id)) continue;
      out.push({
        system,
        modelId: id,
        modelName: withoutProviderLabel(system.displayName, model.name),
        source: "published",
      });
    }
    for (const model of system.models) {
      // Dedupe on id: published wins the row, since it proves the native harness is keyed.
      const already = out.find((one) => one.system.id === system.id && one.modelId === model.id);
      if (already !== undefined) {
        already.modelName = model.name;
        continue;
      }
      out.push({ system, modelId: model.id, modelName: model.name, source: "table" });
    }
  }
  return readyFirst(out, harness, harness === null ? null : (capabilities[harness]?.routing ?? null));
}

/** Floats providers keyMissing calls ready and sinks those hostable refuses; stable, so daemon and row order survive. */
export function readyFirst(
  choices: readonly ModelChoice[],
  harness: AgentId | null = null,
  routing: AgentCapabilities["routing"] = null,
): ModelChoice[] {
  const rank = new Map<string, number>();
  const ready = new Set<string>();
  const collapsed = new Set<string>();
  for (const choice of choices) {
    if (!rank.has(choice.system.id)) {
      rank.set(choice.system.id, rank.size);
      if (harness !== null && hostable(harness, choice.system, routing) !== null) {
        collapsed.add(choice.system.id);
      }
    }
    if (keyMissing(choice, null) === null) ready.add(choice.system.id);
  }
  const total = rank.size;
  const place = (choice: ModelChoice): number =>
    (ready.has(choice.system.id) && !collapsed.has(choice.system.id) ? 0 : total) +
    (rank.get(choice.system.id) ?? 0);
  return [...choices].sort((a, b) => place(a) - place(b));
}

export interface ModelGroup {
  system: SystemInfo;
  choices: ModelChoice[];
}

export function listedByBuild(
  group: ModelGroup,
  capabilities: Readonly<Record<string, AgentCapabilities>>,
  nameOf: (id: string) => string,
): string | null {
  const harness = group.system.nativeHarness;
  if (harness === null) return null;
  if (group.choices.length === 0) return null;
  if (!group.choices.every((one) => one.source === "published")) return null;
  const cli = capabilities[harness]?.cli;
  if (cli === undefined || cli === null) return null;
  const name = nameOf(harness);
  const build = cli.version === null ? name : `${name} ${cli.version}`;
  return `Listed by ${build}.`;
}

export function searchModels(
  choices: readonly ModelChoice[],
  query: string,
  system: string | null,
): ModelChoice[] {
  const needle = query.trim().toLowerCase();
  return choices.filter((one) => {
    if (system !== null && one.system.id !== system) return false;
    if (needle.length === 0) return true;
    return (
      one.modelName.toLowerCase().includes(needle) ||
      one.modelId.toLowerCase().includes(needle) ||
      one.system.displayName.toLowerCase().includes(needle)
    );
  });
}

/** One heading per provider, in first-appearance (readyFirst) order (Q3.503). */
export function groupModels(choices: readonly ModelChoice[]): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (const choice of choices) {
    const found = out.find((group) => group.system.id === choice.system.id);
    if (found === undefined) out.push({ system: choice.system, choices: [choice] });
    else found.choices.push(choice);
  }
  return out;
}

/** Pass the machine's listing so contributed harnesses count; the key is deliberately not weighed. */
export function supportingHarnesses(
  choice: ModelChoice,
  capabilities: Readonly<Record<string, AgentCapabilities>>,
  harnesses: readonly AgentId[] = AGENT_IDS,
): AgentId[] {
  return harnesses.filter((id) => pairable(id, choice, capabilities[id]?.routing ?? null));
}

/** The settled pairing failure, else keyMissing's sentence, else null; never equates two names (Q3.488). */
export function choiceRefusal(
  harness: AgentId | null,
  choice: ModelChoice,
  routing: AgentCapabilities["routing"],
  nameOf: (id: string) => string = agentLabel,
): HostRefusal {
  if (harness !== null) {
    const failure = pairFailure(harness, choice, routing);
    if (failure !== null) {
      return failure === "name" ? noModelCalled(harness, choice, nameOf) : cannotRun(harness, choice, nameOf);
    }
  }
  return keyMissing(choice, harness);
}

type PairFailure = "host" | "name";

/** "host": hostable refuses the pairing; "name": the id is the other route's spelling. Never weighs a key. */
function pairFailure(
  harness: AgentId,
  choice: ModelChoice,
  routing: AgentCapabilities["routing"],
): PairFailure | null {
  if (hostable(harness, choice.system, routing) !== null) return "host";
  // Where the daemon relates the two spellings (nativeModelPrefix, e.g. OpenRouter), a name never fails a pairing.
  const relates = (choice.system.nativeModelPrefix ?? "") !== "";
  const native = choice.system.nativeHarness === harness;
  if (!relates && native && choice.source === "table") return "name";
  if (!relates && !native && choice.source === "published") return "name";
  return null;
}

function pairable(
  harness: AgentId,
  choice: ModelChoice,
  routing: AgentCapabilities["routing"],
): boolean {
  return pairFailure(harness, choice, routing) === null;
}

function cannotRun(harness: AgentId, choice: ModelChoice, nameOf: (id: string) => string): string {
  return `${nameOf(harness)} cannot run ${choice.modelName}.`;
}

/** "has no model called" claims a missing name, never a missing model or an equivalence (Q3.488). */
function noModelCalled(harness: AgentId, choice: ModelChoice, nameOf: (id: string) => string): string {
  return `${nameOf(harness)} has no model called ${choice.modelName}.`;
}

/** choiceRefusal's refusals in the same order, shortened for a row titled with the harness. */
export function harnessRowRefusal(
  harness: AgentId,
  choice: ModelChoice | null,
  routing: AgentCapabilities["routing"],
): HostRefusal {
  if (choice === null) return null;
  const failure = pairFailure(harness, choice, routing);
  if (failure !== null) {
    return failure === "name"
      ? `No model called ${choice.modelName}.`
      : `Cannot run ${choice.modelName}.`;
  }
  return keyMissing(choice, harness);
}

export function defaultAgentName(modelName: string): string {
  return modelName;
}

export function customAgentSubline(one: CustomAgent, systems: readonly SystemInfo[]): string {
  return systems.find((candidate) => candidate.id === one.system)?.displayName ?? one.system;
}

export function harnessSubline(
  harness: string,
  systems: readonly SystemInfo[],
  from?: { pluginName: string } | undefined,
): string {
  const native = systems.find((candidate) => candidate.nativeHarness === harness)?.displayName;
  if (native !== undefined) return native;
  return from === undefined ? "" : `from ${boundedName(from.pluginName, "a plugin")}`;
}

/** Harnesses with a key slot that no provider's loginVia speaks for; unread listings answer none. */
export function unspokenFor(
  agents: readonly AgentAuthInfo[] | null,
  systems: readonly SystemInfo[] | null,
): AgentAuthInfo[] {
  if (agents === null || systems === null) return [];
  const spoken = new Set(
    systems.map((one) => one.loginVia).filter((one): one is string => one !== null && one !== undefined),
  );
  return agents.filter((one) => one.credentials.length > 0 && !spoken.has(one.id));
}

export function anyKeySet(agent: AgentAuthInfo): boolean {
  return agent.credentials.some((slot) => slot.set);
}

export function offersStripTile(candidate: AgentAvailability): boolean {
  return (
    startsBare(candidate) &&
    offersTile(
      agentStance(
        candidate.available,
        candidate.loggedIn,
        candidate.login?.blocked,
        // Any recorded start refusal removes the tile, routed or bare: a tile is a bare start.
        candidate.lastStartRefusal != null,
      ),
    )
  );
}

/** Whether a session can start on this row; a preset needs its harness installed, not signed in. Unread listings answer false. */
export function startableHere(
  row: { kind: "harness" | "custom"; id: string },
  agents: readonly AgentAvailability[] | null,
  presets: readonly CustomAgent[] | null,
): boolean {
  if (row.kind === "harness") {
    return agents?.some((candidate) => candidate.id === row.id && offersStripTile(candidate)) === true;
  }
  const preset = presets?.find((one) => one.id === row.id) ?? null;
  if (preset === null) return false;
  return (
    agents?.some(
      (candidate) =>
        candidate.id === preset.harness &&
        candidate.available &&
        // Only a refusal measured while routed condemns a preset: a bare one may be a signed-out CLI that routing still runs.
        candidate.lastStartRefusal?.routed !== true,
    ) === true
  );
}
