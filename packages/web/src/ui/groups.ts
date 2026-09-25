import { subscribeMachineOrder } from "../machineOrder";
import type { MachineId } from "../ids";
import { relativeTo } from "../paths";
import type { MachineGroup, SessionGroups, SessionRow } from "../store";
import { needsHuman, showsAsEnded } from "../wire";
import { orderSessions } from "../sessionOrder";
import { sessionLabel, shortPath } from "./bits";

// Module state rather than component state: the phone's list/detail navigation unmounts the sidebar.

const COLLAPSED_KEY = "reemoat.collapsedFolders";
const MACHINE_KEY = "reemoat.machineTab";

declare const folderIdBrand: unique symbol;
export type FolderId = string & { readonly [folderIdBrand]: "FolderId" };

// Both start with the separator byte and name no machine, so they never collide with a real folder id.
export const PINNED_FOLDER = "\u0000pinned" as FolderId;
export const ALL_FOLDER = "\u0000all" as FolderId;

export function folderId(machine: MachineId, path: string): FolderId {
  return `${machine}\u0000${path}` as FolderId;
}

const collapsed = new Set<FolderId>(readStored<FolderId>(COLLAPSED_KEY));
const listeners = new Set<() => void>();
/** `useSyncExternalStore` compares by identity, so the snapshot has to be stable. */
let version = 0;

function readStored<T extends string>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((id) => typeof id === "string") as T[]) : [];
  } catch {
    // Private mode or a hand-edited value: everything starts expanded.
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Same reasoning: the in-memory value still works for this session.
  }
}

function bump(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

subscribeMachineOrder(bump);

export function isFolderCollapsed(id: FolderId): boolean {
  return collapsed.has(id);
}

export function toggleFolder(id: FolderId): void {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  write(COLLAPSED_KEY, [...collapsed]);
  bump();
}

export function subscribeGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function groupsVersion(): number {
  return version;
}

export type Filter = "active" | "ended" | "all";

// The default may be narrowed only while a control can widen it again; not persisted, unlike the tab.
let filter: Filter = "active";

export function currentFilter(): Filter {
  return filter;
}

export function setFilter(next: Filter): void {
  if (filter === next) return;
  filter = next;
  bump();
}

// Not null, which already means an empty fleet; never a valid MachineId.
export const ALL_MACHINES = "all";
export type MachineTabId = MachineId | typeof ALL_MACHINES;

let selected: MachineTabId | null = (readStored<MachineTabId>(MACHINE_KEY)[0] ?? null) as MachineTabId | null;

export function selectMachine(id: MachineTabId): void {
  if (selected === id) return;
  selected = id;
  write(MACHINE_KEY, [id]);
  bump();
}

let query = "";

export function currentQuery(): string {
  return query;
}

export function setQuery(next: string): void {
  if (query === next) return;
  query = next;
  bump();
}

/** The main repository root (never the per-session worktree), else the requested cwd; subdirectories share a folder. */
export function folderPathOf(row: SessionRow): string {
  const git = row.snapshot.workspace.git;
  if (git !== null && git.repoRoot.length > 0) return git.repoRoot;
  return row.snapshot.workspace.requestedCwd.trim();
}

export function folderNames(paths: readonly string[]): string[] {
  const parts = paths.map((path) => path.split("/").filter((segment) => segment.length > 0));
  const names = paths.map((path, index) => {
    const own = parts[index] ?? [];
    if (own.length === 0) return path.length > 0 ? "/" : "";
    return own[own.length - 1] ?? "";
  });

  for (let width = 2; ; width += 1) {
    const clashes = new Set(
      names.filter((name, index) => names.some((other, at) => at !== index && other === name)),
    );
    if (clashes.size === 0) break;
    let widened = false;
    for (let index = 0; index < names.length; index += 1) {
      const own = parts[index] ?? [];
      const name = names[index] ?? "";
      if (!clashes.has(name) || own.length < width) continue;
      names[index] = own.slice(-width).join("/");
      widened = true;
    }
    if (!widened) break;
  }
  return names;
}

export function rowSubpath(row: SessionRow, folderPath: string): string | null {
  const cwd = row.snapshot.workspace.requestedCwd;
  if (cwd.length === 0 || cwd === folderPath) return null;
  const inside = relativeTo(folderPath, cwd);
  if (inside !== null) return inside;
  return shortPath(cwd);
}

/** Matches the title, cwd, repo root and agent; not the machine name or the raw session id. */
export function matchesQuery(row: SessionRow, needle: string): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length === 0) return true;
  const git = row.snapshot.workspace.git;
  const haystack = [
    sessionLabel(row),
    row.snapshot.workspace.requestedCwd,
    git?.repoRoot ?? "",
    row.snapshot.agent,
  ];
  return haystack.some((field) => field.toLowerCase().includes(wanted));
}

export function matching(rows: readonly SessionRow[], needle: string): SessionRow[] {
  if (needle.trim().length === 0) return rows as SessionRow[];
  return rows.filter((row) => matchesQuery(row, needle));
}

/** Takes what is left of a page's row budget, a section's heading costing one: the swipe's neighbour draws a screen, not a machine. */
export function takeRows<T>(list: readonly T[], left: { rows: number }, heading = 0): T[] {
  left.rows -= heading;
  const taken = list.slice(0, Math.max(0, left.rows));
  left.rows -= taken.length;
  return taken;
}

export interface ListView {
  filter: Filter;
  machine: MachineId | null;
  all: boolean;
  query: string;
}

export function currentView(groups: SessionGroups): ListView {
  const all = selected === ALL_MACHINES;
  return { filter, machine: all ? null : selectedMachineIn(groups), all, query };
}

/** The remembered id is never overwritten by the fallback, which is the first tab in the reader's order. */
export function selectedMachineIn(groups: SessionGroups): MachineId | null {
  const match = groups.groups.find((group) => group.id === selected);
  if (match !== undefined) return match.id;
  return groups.groups[0]?.id ?? null;
}

export interface MachineTab {
  id: MachineTabId;
  name: string;
  reach: MachineGroup["reach"];
  blockedCount: number;
  liveCount: number;
  selected: boolean;
}

export function machineTabs(groups: SessionGroups, view: ListView): MachineTab[] {
  return groups.groups.map((group) => ({
    id: group.id,
    name: group.name,
    reach: group.reach,
    blockedCount: group.blockedCount,
    liveCount: group.liveCount,
    selected: !view.all && group.id === view.machine,
  }));
}

export function allTab(groups: SessionGroups, view: ListView): MachineTab {
  return {
    id: ALL_MACHINES,
    name: "All",
    reach: "online",
    blockedCount: groups.groups.reduce((sum, group) => sum + group.blockedCount, 0),
    liveCount: groups.groups.reduce((sum, group) => sum + group.liveCount, 0),
    selected: view.all,
  };
}

export interface Folder {
  id: FolderId;
  machineId: MachineId;
  /** `""` is the one bucket with no directory at all. */
  path: string;
  name: string;
  rows: SessionRow[];
  /** What a *collapsed* header still has to say. */
  blockedCount: number;
  collapsed: boolean;
}

/** Ordered by name, never by activity; a folder whose rows all fail the needle disappears. */
export function foldersOf(groups: SessionGroups, view: ListView): Folder[] {
  if (view.all) return [];
  const group = groups.groups.find((candidate) => candidate.id === view.machine);
  if (group === undefined) return [];

  const byPath = new Map<string, SessionRow[]>();
  for (const row of matching(rowsOf(group, view.filter), view.query)) {
    const path = folderPathOf(row);
    const bucket = byPath.get(path);
    if (bucket === undefined) byPath.set(path, [row]);
    else bucket.push(row);
  }

  const paths = [...byPath.keys()];
  const names = folderNames(paths);
  const searching = view.query.trim().length > 0;

  const folders = paths.map((path, index) => {
    const rows = byPath.get(path) ?? [];
    const id = folderId(group.id, path);
    return {
      id,
      machineId: group.id,
      path,
      name: path.length === 0 ? "No folder" : (names[index] ?? path),
      rows,
      blockedCount: rows.filter((row) => needsHuman(row.snapshot)).length,
      // A query overrides collapse, so a match is never hidden in a collapsed folder.
      collapsed: !searching && isFolderCollapsed(id),
    };
  });

  return folders.sort((a, b) => {
    if (a.path.length === 0) return 1;
    if (b.path.length === 0) return -1;
    return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  });
}

/** Pinned rows are excluded: with no folders, their second copy would be a duplicate in one flat list. */
export function allRows(groups: SessionGroups, view: ListView): SessionRow[] {
  if (!view.all) return [];
  const pinned = new Set(pinnedFor(groups, view).map((row) => row.key));
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  for (const group of groups.groups) {
    for (const row of matching(rowsOf(group, view.filter), view.query)) {
      if (pinned.has(row.key) || seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push(row);
    }
  }
  return orderSessions(rows);
}

/** The single source of render order, shared with keyboard.ts; each session once even when pinned. */
export function visibleRows(groups: SessionGroups, view: ListView): SessionRow[] {
  const searching = view.query.trim().length > 0;
  // Nothing is lifted out of its place for needing somebody: a waiting row stays where it is and says so on its dot (Q3.674).
  const out: SessionRow[] = [];
  if (searching || !isFolderCollapsed(PINNED_FOLDER)) {
    out.push(...matching(pinnedFor(groups, view), view.query));
  }
  if (searching || !isFolderCollapsed(ALL_FOLDER)) {
    out.push(...allRows(groups, view));
  }
  for (const folder of foldersOf(groups, view)) {
    if (folder.collapsed) continue;
    out.push(...folder.rows);
  }
  // The needle is applied outside orphansFor so SessionBrowser.tsx keeps the call shape webcheck reads.
  out.push(...matching(orphansFor(groups, view.filter), view.query));

  const seen = new Set<string>();
  return out.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

/** Pins are cut to the selected machine's tab; a pin whose machine is gone shows on every tab. */
export function pinnedFor(groups: SessionGroups, view: ListView): SessionRow[] {
  return pinnedHere(underFilter(groups.pinned, view.filter), groups, view);
}

function pinnedHere(rows: readonly SessionRow[], groups: SessionGroups, view: ListView): SessionRow[] {
  if (view.all || view.machine === null) return [...rows];
  const known = new Set(groups.groups.map((group) => group.id));
  return rows.filter((row) => row.ref.machineId === view.machine || !known.has(row.ref.machineId));
}

export function orphansFor(groups: SessionGroups, filter: Filter): SessionRow[] {
  return underFilter(groups.orphans, filter);
}

/** Rows in the same group in draw order, ignoring filter and search; pins cut to the selected machine. */
export function siblingsOf(row: SessionRow, groups: SessionGroups): SessionRow[] {
  if (row.snapshot.pinned === true) return orderSessions(pinnedHere(groups.pinned, groups, currentView(groups)));
  const group = groups.groups.find((candidate) => candidate.id === row.ref.machineId);
  if (group === undefined) return orderSessions(groups.orphans);
  const path = folderPathOf(row);
  return orderSessions([...group.active, ...group.ended].filter((other) => folderPathOf(other) === path));
}

function underFilter(rows: readonly SessionRow[], filter: Filter): SessionRow[] {
  if (filter === "all") return orderSessions(rows);
  // An interrupted session is not ended, so the Ended filter must not collect it.
  const ended = (row: SessionRow): boolean => showsAsEnded(row.snapshot);
  return orderSessions(rows.filter((row) => (filter === "ended" ? ended(row) : !ended(row))));
}

/** Precedence is blocked, offline, degraded, then idle/live, so an approval is never hidden. */
export type MachineSubline =
  | { kind: "blocked"; count: number }
  | { kind: "offline" }
  | { kind: "degraded" }
  | { kind: "idle" }
  | { kind: "live"; count: number };

export function machineSubline(group: {
  blockedCount: number;
  reach: MachineGroup["reach"];
  tokenDegraded: boolean;
  liveCount: number;
}): MachineSubline {
  if (group.blockedCount > 0) return { kind: "blocked", count: group.blockedCount };
  if (group.reach !== "online") return { kind: "offline" };
  if (group.tokenDegraded) return { kind: "degraded" };
  if (group.liveCount === 0) return { kind: "idle" };
  return { kind: "live", count: group.liveCount };
}

export function sublineWarns(subline: MachineSubline): boolean {
  return subline.kind === "blocked" || subline.kind === "degraded";
}

export function rowsOf(group: MachineGroup, filter: Filter): SessionRow[] {
  // Under all the union must be sorted: two sorted lists end to end are not one sorted list.
  if (filter === "ended") return orderSessions(group.ended);
  return orderSessions(filter === "all" ? [...group.active, ...group.ended] : group.active);
}
