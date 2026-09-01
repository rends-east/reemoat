import {
  AGENT_IDS,
  type CatalogueState,
  type ContributedHarness,
} from "../acp/agents.js";
import {
  isBuiltinSystemId,
  SYSTEM_IDS,
  SYSTEMS,
  type MachineCatalogue,
  type SystemConfig,
} from "../acp/systems.js";
import { contributedId } from "./manifest.js";
import type { InstalledPlugin } from "./store.js";

/**
 * What the plugins on this machine add to the two tables this repository ships.
 *
 * **Pure data, and that is what makes it available early enough to matter.** It is
 * built from installed *manifests* — `PluginRecordStore.list()` already re-validates
 * each one through `parseManifest` on the way out — so no child process has to be
 * running, no filesystem is touched, and nothing here can fail. That is the whole
 * reason this is not a method on `PluginHost`.
 *
 * ⚠ **It must exist before `restore()`, and the reason is stronger than
 * `setCustomAgents`'s.** `restore()` rebuilds every persisted session, and a
 * `ManagedSession`'s `assembled` getter reads `custom_agents` through
 * `readCustomAgent`, which validates the harness and **drops the row** rather than
 * repairing it. With contributions unknown at that moment every preset on a
 * contributed harness is dropped and every session on it comes back demoted to the
 * bare harness it was started with — the exact failure the
 * `setCustomAgents`-before-`restore()` invariant exists to prevent, reintroduced one
 * table down, with `autoResume` firing inside the window. `daemon.ts` builds this
 * immediately after `openStores`.
 *
 * ⚠ **`REEMOAT_PLUGINS=0` builds one in which every plugin is switched off** —
 * not an empty one. The rows are still in the database; the switch is documented as
 * *"an operator who does not want somebody else's code running as this user should
 * not have to uninstall anything"*, and a contributed harness **is** a program this
 * daemon spawns, so nothing may be offered. But *forgetting* the ids as well would
 * make every refusal about them read `400 invalid_agent` — the answer that blames a
 * caller — where the truth is that somebody set an environment variable.
 * `daemon.ts` maps the list rather than dropping it.
 */
export class Contributions implements MachineCatalogue {
  private harnesses = new Map<string, ContributedHarness>();
  private systems = new Map<string, SystemConfig>();
  /**
   * Everything an installed plugin declares, **enabled or not**.
   *
   * ⚠ **Two maps and this third index, because "switched off" and "never existed"
   * are different answers with opposite remedies.** The maps above hold only what
   * is live, so nothing lists or launches a disabled plugin's harness. This one
   * remembers that the id belongs to somebody, which is what lets a refusal say
   * *the plugin is switched off* — a `503` naming a switch — instead of `400 that
   * is not an agent`, which tells an operator their own address is wrong about a
   * request that was correct yesterday.
   */
  private declaredHarnesses = new Set<string>();
  private declaredSystems = new Set<string>();

  constructor(installed: readonly InstalledPlugin[] = []) {
    this.refresh(installed);
  }

  /**
   * Rebuild from what is installed now.
   *
   * Called by `PluginHost` after every install, update, remove and enable — all of
   * which already run under its own `exclusive()`/`mutating` gate, so there is
   * exactly one writer and no ordering to reason about here.
   *
   * Replaced whole rather than patched, for `AgentStripPort.replace`'s reason one
   * subject over: the caller always holds the entire list, so an upsert-per-plugin
   * would need a second decision — what happens to a plugin the caller did not
   * mention — that no caller has.
   */
  refresh(installed: readonly InstalledPlugin[]): void {
    const harnesses = new Map<string, ContributedHarness>();
    const systems = new Map<string, SystemConfig>();
    const declaredHarnesses = new Set<string>();
    const declaredSystems = new Set<string>();
    /*
     * ⚠ **Sorted by plugin id, and the order is the picker's reading order.**
     * `GET /systems` maps over `systemIds()`, `groupModels` groups by first
     * appearance rather than by sorting, and `readyFirst` orders each of its two
     * halves by position — so this array is transitively what somebody scrolls
     * through. Install order would make that depend on the order somebody happened
     * to install things in, which reorders a picker under a thumb for a reason
     * nobody can see. Contributed rows always come *after* every built-in, which
     * is a group appearing rather than a group moving.
     */
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
          baseUrl: one.baseUrl,
          authHeader: one.authHeader,
          // ⚠ **Namespaced here rather than in the manifest**, so an author writes
          // `"nativeHarness": "gemini"` and never `"acme:gemini"` — and a plugin
          // renamed on the way into a market cannot end up naming a harness that is
          // no longer its own. `readOwnHarness` has already refused anything that
          // is not one of this plugin's own.
          nativeHarness: one.nativeHarness === null ? null : contributedId(plugin.id, one.nativeHarness),
          loginVia: one.loginVia === null ? null : contributedId(plugin.id, one.loginVia),
          models: one.models,
          nativeModelPrefix: one.nativeModelPrefix,
          keyEnv: one.keyEnv,
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
    if (isBuiltinSystemId(id)) return SYSTEMS[id];
    return this.systems.get(id) ?? null;
  }

  systemIds(): readonly string[] {
    return [...SYSTEM_IDS, ...this.systems.keys()];
  }

  systemState(id: string): CatalogueState {
    if (isBuiltinSystemId(id)) return "enabled";
    return this.stateOf(id, this.systems.has(id), this.declaredSystems);
  }

  /**
   * Live, declared-but-switched-off, or nobody's.
   *
   * ⚠ **The declared set is passed in, because there are two and they may not be
   * merged.** One set held both kinds, so `harnessState` answered `"disabled"` for
   * a *provider* id belonging to a plugin that is switched **on** — and
   * `POST /sessions` turns that into `503 harness_unavailable, "this agent comes
   * from a plugin that is switched off on this machine"`, sending somebody to a
   * switch that is already in the position they want. Every reader of the
   * three-valued answer inherited it: `PluginApi.knownAgent`, `unknownHarness`, and
   * the `"disabled"` arms in `hostable`, `applySystem` and `pinNativeModel`.
   *
   * A harness id and a system id are both `<plugin>:<local>` and a plugin may
   * legitimately name both `gemini`, so the two namespaces genuinely overlap and
   * "is this declared" has no answer without knowing which table is being asked.
   */
  private stateOf(id: string, live: boolean, declared: ReadonlySet<string>): CatalogueState {
    if (live) return "enabled";
    return declared.has(id) ? "disabled" : "unknown";
  }

}
