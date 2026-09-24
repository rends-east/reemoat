import type { CatalogueEntry } from "./catalogue";
import { machineId, type MachineId } from "./ids";

export type MarketTab = "market" | "installed";

export interface MarketRoute {
  tab: MarketTab;
  entry: string | null;
  /** Empty means the entry page, never all machines. */
  settings: readonly MachineId[];
}

/** Anything unrecognised falls up to the nearest real screen rather than a 404. */
export function parseMarketRoute(
  segments: readonly (string | undefined)[],
  decode: (part: string) => string = (part) => part,
): MarketRoute {
  if (segments[0] === "installed") return { tab: "installed", entry: null, settings: [] };
  if (segments[0] === "p") {
    const wanted = segments[1];
    if (wanted === undefined) return { tab: "market", entry: null, settings: [] };
    if (segments[2] !== "settings") return { tab: "market", entry: decode(wanted), settings: [] };
    // Deduplicated so no daemon gets the form twice; neither sorted, so a path round-trips, nor bounded, so no selected machine is skipped.
    const named = segments
      .slice(3)
      .filter((one): one is string => one !== undefined && one.length > 0)
      .map((one) => machineId(decode(one)));
    return { tab: "market", entry: decode(wanted), settings: [...new Set(named)] };
  }
  return { tab: "market", entry: null, settings: [] };
}

export function marketPath(tab: MarketTab = "market"): string {
  return tab === "installed" ? "/plugins/installed" : "/plugins";
}

export function marketEntryPath(entry: string): string {
  return `/plugins/p/${encodeURIComponent(entry)}`;
}

/** One segment per id, since encodeURIComponent leaves commas alone. */
export function marketSettingsPath(entry: string, machines: readonly MachineId[]): string {
  const base = `${marketEntryPath(entry)}/settings`;
  return machines.length === 0 ? base : `${base}/${machines.map((one) => encodeURIComponent(one)).join("/")}`;
}

export function marketUp(route: MarketRoute): string | null {
  if (route.entry === null) return null;
  return route.settings.length > 0 ? marketEntryPath(route.entry) : marketPath("market");
}

/** Only an entry page honours the origin; a tab or a settings screen keeps marketUp's answer. */
export function marketUpFrom(route: MarketRoute, origin: string | null): string | null {
  if (route.entry !== null && route.settings.length === 0 && origin !== null) return origin;
  return marketUp(route);
}

/** True only where the up target is a rail row; kept separate from marketUpFrom so its string answers stay pinned (Q3.432). */
export function marketUpWithinNav(route: MarketRoute, origin: string | null): boolean {
  if (marketUpFrom(route, origin) !== marketUp(route)) return false;
  return route.entry !== null && route.settings.length === 0;
}

export function marketUpLabel(route: MarketRoute, origin: string | null): string {
  if (route.settings.length > 0) return "Back to the plugin";
  return marketUpWithinNav(route, origin) ? "Back to Market" : "Back";
}

export function marketPaneTitle(route: MarketRoute): string | null {
  return route.entry;
}

export const MARKET_TABS: readonly { id: MarketTab; title: string }[] = [
  { id: "market", title: "Market" },
  { id: "installed", title: "Installed" },
];

export interface CatalogueGroup {
  name: string;
  entries: CatalogueEntry[];
}

export const UNGROUPED = "Other";

export function matchesQuery(entry: CatalogueEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle);
}

export function groupCatalogue(entries: readonly CatalogueEntry[], query: string): CatalogueGroup[] {
  const byName = new Map<string, CatalogueEntry[]>();
  for (const entry of entries) {
    if (!matchesQuery(entry, query)) continue;
    const name = entry.categories[0] ?? UNGROUPED;
    const held = byName.get(name);
    if (held === undefined) byName.set(name, [entry]);
    else held.push(entry);
  }
  const compare = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase());
  return [...byName.entries()]
    .sort((a, b) => {
      if (a[0] === UNGROUPED) return 1;
      if (b[0] === UNGROUPED) return -1;
      return compare(a[0], b[0]);
    })
    .map(([name, found]) => ({ name, entries: [...found].sort((a, b) => compare(a.name, b.name)) }));
}
