import {
  AGENT_IDS,
  type CatalogueState,
  type ContributedHarness,
} from "../acp/agents.js";
import {
  declaredEndpoints,
  isBuiltinSystemId,
  SYSTEM_IDS,
  SYSTEMS,
  type MachineCatalogue,
  type SystemConfig,
} from "../acp/systems.js";
import { contributedId } from "./manifest.js";
import type { InstalledPlugin } from "./store.js";

/**
 * Pure data from installed manifests, built before restore so presets on a contributed harness survive it.
 * REEMOAT_PLUGINS=0 marks every plugin switched off rather than forgetting its ids.
 */
export class Contributions implements MachineCatalogue {
  private harnesses = new Map<string, ContributedHarness>();
  private systems = new Map<string, SystemConfig>();
  /** Every declared id, enabled or not, so a refusal can say switched off instead of unknown. */
  private declaredHarnesses = new Set<string>();
  private declaredSystems = new Set<string>();

  /** hidden: built-in systems this machine does not offer, as if this build did not ship them. */
  constructor(
    installed: readonly InstalledPlugin[] = [],
    private readonly hidden: ReadonlySet<string> = new Set(),
  ) {
    this.refresh(installed);
  }

  /** Rebuilt whole after every install, update, remove and enable, under PluginHost's single-writer gate. */
  refresh(installed: readonly InstalledPlugin[]): void {
    const harnesses = new Map<string, ContributedHarness>();
    const systems = new Map<string, SystemConfig>();
    const declaredHarnesses = new Set<string>();
    const declaredSystems = new Set<string>();
    // Sorted by plugin id: this is the picker's reading order, independent of install order.
    for (const plugin of [...installed].sort((a, b) => a.id.localeCompare(b.id))) {
      const by = { pluginId: plugin.id, pluginName: plugin.manifest.name };
      for (const one of plugin.manifest.contributes.harnesses) {
        const id = contributedId(plugin.id, one.id);
        declaredHarnesses.add(id);
        if (!plugin.enabled) continue;
        harnesses.set(id, {
          id,
          pluginId: plugin.id,
          pluginName: plugin.manifest.name,
          name: one.name,
          command: one.command,
          args: one.args,
          envNames: one.envNames,
          routedModelEnv: one.routedModelEnv,
          authHint: one.authHint,
        });
      }
      for (const one of plugin.manifest.contributes.systems) {
        const id = contributedId(plugin.id, one.id);
        declaredSystems.add(id);
        if (!plugin.enabled) continue;
        systems.set(id, {
          displayName: one.name,
          apiType: one.apiType,
          endpoints: declaredEndpoints(one.apiType, one.baseUrl),
          authHeader: one.authHeader,
          // Namespaced here, so a manifest names only its own harness and a renamed plugin cannot point at another's.
          nativeHarness: one.nativeHarness === null ? null : contributedId(plugin.id, one.nativeHarness),
          loginVia: one.loginVia === null ? null : contributedId(plugin.id, one.loginVia),
          models: one.models,
          nativeModelPrefix: one.nativeModelPrefix,
          keyEnv: one.keyEnv,
          signIn: null,
          contributedBy: by,
        });
      }
    }
    this.harnesses = harnesses;
    this.systems = systems;
    this.declaredHarnesses = declaredHarnesses;
    this.declaredSystems = declaredSystems;
  }

  harness(id: string): ContributedHarness | null {
    return this.harnesses.get(id) ?? null;
  }

  harnessIds(): readonly string[] {
    return [...AGENT_IDS, ...this.harnesses.keys()];
  }

  harnessState(id: string): CatalogueState {
    if ((AGENT_IDS as readonly string[]).includes(id)) return "enabled";
    return this.stateOf(id, this.harnesses.has(id), this.declaredHarnesses);
  }

  system(id: string): SystemConfig | null {
    if (this.hidden.has(id)) return null;
    if (isBuiltinSystemId(id)) return SYSTEMS[id];
    return this.systems.get(id) ?? null;
  }

  systemIds(): readonly string[] {
    return [...SYSTEM_IDS.filter((id) => !this.hidden.has(id)), ...this.systems.keys()];
  }

  systemState(id: string): CatalogueState {
    if (this.hidden.has(id)) return "unknown";
    if (isBuiltinSystemId(id)) return "enabled";
    return this.stateOf(id, this.systems.has(id), this.declaredSystems);
  }

  /** Harness and system ids may collide, so each table passes its own declared set. */
  private stateOf(id: string, live: boolean, declared: ReadonlySet<string>): CatalogueState {
    if (live) return "enabled";
    return declared.has(id) ? "disabled" : "unknown";
  }

}
