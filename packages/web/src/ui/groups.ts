import type { MachineId } from "../ids";
import { relativeTo } from "../paths";
import type { MachineGroup, SessionGroups, SessionRow } from "../store";
import { needsHuman, showsAsEnded } from "../wire";
import { sessionLabel, shortPath } from "./bits";

/**
 * What the sidebar draws, and in what order.
 *
 * The shape changed: machines used to be collapsible *sections* stacked down the
 * rail, and they are a horizontal tab bar now, with the chats of the selected one
 * grouped into **folders** underneath. So this file grew three new questions —
 * which machine is selected, what the folders are, and what the search box has
 * been typed into — and every one of them had to land here rather than in the
 * component, for the reason the two that were already here landed here.
 *
 * **Module state seeded from `localStorage`, not `useState`.** The phone's
 * list → detail → back unmounts the sidebar entirely, so component state silently
 * resets every time somebody reads a session. That is why the collapse set lives
 * here, and it is why the selected machine does too.
 *
 * **Anything that filters the list belongs beside the filter.** `visibleRows` is
 * *the* source of render order and `keyboard.ts` walks it; a needle held in a
 * component would mean `j`/`k` stepping onto rows the rail is not drawing — which
 * is the exact failure that got the previous search box deleted, and which two
 * comments in this file and one in `keyboard.ts` each claimed was structurally
 * impossible.
 */

const COLLAPSED_KEY = "reemoat.collapsedFolders";
const MACHINE_KEY = "reemoat.machineTab";

/**
 * A folder's identity, and it is scoped to a machine on purpose.
 *
 * `\u0000` is the one byte a POSIX path cannot contain, so the join is
 * unambiguous. The scoping is not cosmetic: two machines routinely hold a
 * checkout of the same repository at the same path, and a shared id would mean
 * collapsing `~/api` on the laptop collapses `~/api` on the server.
 */
declare const folderIdBrand: unique symbol;
export type FolderId = string & { readonly [folderIdBrand]: "FolderId" };

/**
 * The two folders that are not directories.
 *
 * `Pinned` and `All` collapse through the same persisted set as every real
 * folder, so the behaviour and the storage are one mechanism rather than two.
 * Both begin with the separator byte and name no machine, which is what keeps
 * them out of `folderId`'s space: a real id is `<machineId>\0<path>` and a
 * machine id is never empty.
 */
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
    // Private mode, a quota, or somebody's hand-edited value. A sidebar
    // preference is not worth failing a render for; everything starts expanded.
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

/** The value `useSyncExternalStore` compares. Changes when anything on this screen moves. */
export function groupsVersion(): number {
  return version;
}

/* ------------------------------------------------------------------ *
 * Which machine, which slice, which needle
 * ------------------------------------------------------------------ */

/**
 * Which slice of the fleet is shown.
 *
 * There is deliberately no `needs` any more. It was a filter whose whole job was
 * to answer "is anything waiting on me", and a filter is a bad place to answer
 * that: it is a mode you have to already be in. The answer travels with the rows
 * instead — a marker on the row, a count on its folder, and `waitingFloor` for
 * everything this view cannot draw at all.
 */
export type Filter = "active" | "ended" | "all";

/**
 * `"active"`, and what had to happen first is that the icon stopped being inert.
 *
 * This was `"all"` for exactly one reason, written down here at the time: the
 * filter is **the only route to an ended session anywhere in this app**, and the
 * control that reaches it was drawn as a placeholder that did nothing. Defaulting
 * to `"active"` behind a dead control would have made every finished conversation
 * permanently unreachable — a worse failure than a longer list, so the list stayed
 * long.
 *
 * The list is now what it was asked to be, and the price of that was wiring the
 * icon rather than accepting the loss: `ChatSearch` connects the existing
 * `Dropdown` to `setFilter`, so Ended is one tap away and nothing is orphaned.
 * That ordering is the point — **the default may only be narrowed while some
 * control can widen it again**, and if the filter is ever reverted to a
 * placeholder this line has to go back to `"all"` in the same commit.
 *
 * Still not persisted, for the reason the tab beside it *is*: a filter is visible
 * on screen the moment you look, so starting each visit on a known default is
 * honest, while a tab is where you were working.
 */
let filter: Filter = "active";

export function currentFilter(): Filter {
  return filter;
}

export function setFilter(next: Filter): void {
  if (filter === next) return;
  filter = next;
  bump();
}

/**
 * The machine whose chats are on screen, remembered across visits.
 *
 * **Persisted, unlike the filter**, and the distinction is the one this file
 * already drew: a filter is visible on screen the moment you look, so starting
 * each visit on a known default is honest. A tab is *where you were working*, it
 * is visible as selected immediately, and coming back to a different machine's
 * list every morning is a small tax paid daily.
 */
/**
 * The one tab that is not a machine.
 *
 * A string rather than `null`, because `null` already means something here — "no
 * machine is selected", which is the empty fleet — and a sentinel that collides
 * with an existing state is how the empty fleet ends up rendering the All list.
 * It is never a valid `MachineId`: those are `m_…`.
 */
export const ALL_MACHINES = "all";
export type MachineTabId = MachineId | typeof ALL_MACHINES;

let selected: MachineTabId | null = (readStored<MachineTabId>(MACHINE_KEY)[0] ?? null) as MachineTabId | null;

export function selectMachine(id: MachineTabId): void {
  if (selected === id) return;
  selected = id;
  write(MACHINE_KEY, [id]);
  bump();
}

/**
 * The typed needle, and it is **not** persisted.
 *
 * A search you did not type is a list that looks broken — you come back to three
 * chats and no explanation. Same argument the filter's own non-persistence made,
 * one degree stronger, because a needle leaves nothing on screen naming itself
 * except the box it is in.
 */
let query = "";

export function currentQuery(): string {
  return query;
}

export function setQuery(next: string): void {
  if (query === next) return;
  query = next;
  bump();
}

/* ------------------------------------------------------------------ *
 * Folders
 * ------------------------------------------------------------------ */

/**
 * Which folder a session belongs in — the one rule, and everything else here
 * derives from it.
 *
 * `git.repoRoot` first, and the daemon has already settled the ambiguity that
 * makes this look risky: `worktree.ts` sets `repoRoot` to the **main** repository
 * root, never the per-session worktree. So a session running in
 * `~/.reemoat/worktrees/s_abc` files under the repository a human recognises,
 * which is the whole point.
 *
 * `requestedCwd` is the fallback, and it is exactly right for the case that
 * reaches it: a `plain` session, where the daemon found no git at all. It is also
 * never the ephemeral worktree path — that only ever lives in `workspace.root`,
 * which this function deliberately does not read.
 *
 * **Sessions in subdirectories of one repository collapse into one folder**, and
 * that is wanted rather than tolerated. The path has left the row — the agent's
 * name is there now — so if the folder were not the project, the list would lose
 * the one string people actually navigate by. What the subdirectory case loses is
 * given back per row by {@link rowSubpath}.
 */
export function folderPathOf(row: SessionRow): string {
  const git = row.snapshot.workspace.git;
  if (git !== null && git.repoRoot.length > 0) return git.repoRoot;
  return row.snapshot.workspace.requestedCwd.trim();
}

/**
 * The shortest suffix of each path that tells it apart from the others.
 *
 * A basename alone until it collides — `~/a/api` and `~/b/api` both drawing "api"
 * is two identical rows in one list, which is the same failure `nameVisibleTo`
 * exists to prevent one service over. Widened a segment at a time, and only for
 * the paths that actually clash, so the common case stays one word.
 *
 * The cost, stated: a folder's label changes when an ambiguous sibling appears.
 * That is a rename rather than a reorder, it happens at most once per collision,
 * and both alternatives are worse — always two segments is a wall of
 * `Users/rends`, and never disambiguating is the failure above.
 */
export function folderNames(paths: readonly string[]): string[] {
  const parts = paths.map((path) => path.split("/").filter((segment) => segment.length > 0));
  const names = paths.map((path, index) => {
    const own = parts[index] ?? [];
    // A path with no segments at all is the filesystem root, and "/" is its name.
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
      // Only widen what is still ambiguous, and only while there is more path to
      // spend — `/api` against `/Users/rends/api` resolves when one side runs out.
      if (!clashes.has(name) || own.length < width) continue;
      names[index] = own.slice(-width).join("/");
      widened = true;
    }
    if (!widened) break;
  }
  return names;
}

/**
 * What is left of a row's own directory once its folder has said the rest.
 *
 * The folder is the repository; a session may have been started three levels
 * inside it. `relativeTo` already answers both questions this needs — `null` when
 * the two are the same, and `null` again for anything not underneath — so there
 * is no second containment rule here.
 *
 * The third case is real and is why the fallback is a path rather than nothing: a
 * git worktree somebody made themselves sits *outside* the main repo root while
 * still reporting it as `repoRoot`, so `relativeTo` answers `null` and the honest
 * thing to draw is where it actually is.
 */
export function rowSubpath(row: SessionRow, folderPath: string): string | null {
  const cwd = row.snapshot.workspace.requestedCwd;
  if (cwd.length === 0 || cwd === folderPath) return null;
  const inside = relativeTo(folderPath, cwd);
  if (inside !== null) return inside;
  return shortPath(cwd);
}

/* ------------------------------------------------------------------ *
 * The needle
 * ------------------------------------------------------------------ */

/**
 * Whether a row survives the search box.
 *
 * **`sessionLabel` first, and that is the whole reason the last search box was
 * deleted.** It matched the machine, the agent, the cwd and the raw session id,
 * and did not match the title — so the one string a person reads on the row was
 * the one thing they could not find it by.
 *
 * Two deliberate omissions. `machineName` is not matched, because the needle only
 * ever filters the selected machine's list: matching it would return an empty
 * list and read as broken. The raw session id is not matched either — a result
 * that hits on a string invisible on the row looks arbitrary.
 *
 * Substring rather than fuzzy: a fuzzy match on short strings puts unrelated rows
 * above exact ones, and there is no scoring here to sort them by.
 */
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

/* ------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------ */

/**
 * The three module-state answers, resolved together.
 *
 * One place where state becomes a view, and both readers — the sidebar and
 * `keyboard.ts` — call it. That is what makes `visibleRows`' second parameter safe
 * to have no default: three inputs decide the order now instead of one, so a
 * default would be three chances for the two readers to disagree rather than one.
 * The one chance was enough, once: `keyboard.ts` called `visibleRows(groups)`, got
 * `"all"` while the rail drew `"active"`, and `j` walked onto rows nobody could
 * see.
 */
export interface ListView {
  filter: Filter;
  /**
   * Already resolved against the fleet — never a machine that no longer exists.
   *
   * `null` under All as well as on an empty fleet, so every reader that asks
   * "which machine's chats" gets the same honest answer in both: none in
   * particular. What tells the two apart is `all`.
   */
  machine: MachineId | null;
  /**
   * The whole fleet in one list, with no folders.
   *
   * A separate boolean rather than a third value in `machine`, because every
   * existing reader of `machine` is asking a question that has a right answer
   * under All — `foldersOf` builds nothing, `waitingFloor` finds everything
   * already reachable — and widening the type would make each of them handle a
   * case they do not have an opinion about.
   */
  all: boolean;
  query: string;
}

export function currentView(groups: SessionGroups): ListView {
  const all = selected === ALL_MACHINES;
  return { filter, machine: all ? null : selectedMachineIn(groups), all, query };
}

/**
 * Which machine's tab is selected, resolved against what actually exists.
 *
 * The remembered id is **never overwritten by the fallback**, which is the same
 * posture the collapse set takes ("only an explicit collapse is remembered"): a
 * grant revoked and restored puts you back on your tab rather than on whatever
 * happened to be first while it was gone.
 *
 * The fallback is first **by name**, not by activity. Activity flickers on the
 * four-second poll, and a default tab that moves while you are looking at it is
 * the same failure as a list that reorders under a travelling thumb.
 */
export function selectedMachineIn(groups: SessionGroups): MachineId | null {
  // The membership test is what narrows this: `selected` may be `ALL_MACHINES`,
  // which is no machine's id, so it falls through to the first tab — and the one
  // caller that must not do that (`currentView`) asks about All *before* calling.
  const match = groups.groups.find((group) => group.id === selected);
  if (match !== undefined) return match.id;
  return groups.groups[0]?.id ?? null;
}

export interface MachineTab {
  id: MachineTabId;
  name: string;
  reach: MachineGroup["reach"];
  /** What the tab must say even when its chats are not on screen. */
  blockedCount: number;
  liveCount: number;
  selected: boolean;
}

/**
 * The tab bar, in `store.ts`'s order and no other.
 *
 * No sorting happens here, deliberately: `sessionGroups` already orders by name
 * and that is asserted one file over. Sorting again — by activity, by
 * reachability, by anything — would put the ordering in two places and make the
 * bar reshuffle under a thumb.
 *
 * Every granted machine gets a tab, including one with no sessions at all. That is
 * what preserves "start a session here" for a machine you have just added, which
 * the old per-machine section carried and which would otherwise have no home.
 */
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

/**
 * The All tab, which is not in the bar.
 *
 * Returned separately because it is drawn separately: it is pinned to the left of
 * the strip and outside its scroller, so it is reachable with a dozen machines
 * rather than being the first thing to scroll away. Its counts are the fleet's,
 * summed here rather than in the JSX so the tab and the list it opens cannot
 * disagree about what "everything" is.
 */
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

/**
 * The selected machine's chats, in folders.
 *
 * Ordered by name, never by activity. Membership derives from `rowsOf`, which is
 * recency-sorted, so "in order of first appearance" would reshuffle the folder
 * list on every four-second poll — which `store.ts` calls the one thing this app
 * cannot do under a travelling thumb. A folder holding a waiting session does not
 * hoist either: that fact rides the header as a count, exactly as `blockedCount`
 * always has.
 *
 * **A folder whose rows all fail the needle disappears**, and that is why this
 * takes the whole view rather than just the filter. It also resolves the note this
 * file used to end on: `groupIsEmpty(group, filter)` was deleted because its two
 * call sites counted rows *after* the needle and it knew nothing about the needle.
 * This one does.
 */
export function foldersOf(groups: SessionGroups, view: ListView): Folder[] {
  // Under All there are no folders, by decision rather than by omission: a folder
  // is a directory *on a machine*, so the same path on two hosts is two folders
  // and merging them would be a lie about where the work is. All is a flat list.
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
      // A folder literally named "" would sort first and read as a rendering
      // fault. It is the bucket for a session whose daemon reported no directory
      // at all — which the wire type forbids and an older one could still send.
      name: path.length === 0 ? "No folder" : (names[index] ?? path),
      rows,
      blockedCount: rows.filter((row) => needsHuman(row.snapshot)).length,
      // **A query overrides collapse.** Otherwise you search, get three matches,
      // and they are inside a folder you collapsed last month.
      collapsed: !searching && isFolderCollapsed(id),
    };
  });

  return folders.sort((a, b) => {
    if (a.path.length === 0) return 1;
    if (b.path.length === 0) return -1;
    return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  });
}

/**
 * The whole fleet as one list, for the All tab.
 *
 * **Pinned rows are excluded, and that is the one rule this list has.** Every
 * other group in this rail draws a pinned session twice on purpose — once at the
 * top and once under its own folder — because the second copy is where you look
 * for it when you are working in that folder. Under All there are no folders, so
 * the second copy would be the same row twice in one flat list, six rows apart,
 * with nothing between them explaining why.
 *
 * Recency across machines rather than machine-then-recency: the machine is not a
 * grouping here — it is a label on the row — so ordering by it would be a
 * grouping nobody asked for and one that the tab bar already provides properly.
 */
export function allRows(groups: SessionGroups, view: ListView): SessionRow[] {
  if (!view.all) return [];
  const pinned = new Set(pinnedFor(groups, view.filter).map((row) => row.key));
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  for (const group of groups.groups) {
    for (const row of matching(rowsOf(group, view.filter), view.query)) {
      if (pinned.has(row.key) || seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push(row);
    }
  }
  return rows.sort((a, b) => lastActivity(b) - lastActivity(a));
}

/** The same instant `SessionLine` draws its age from, so the two agree. */
function lastActivity(row: SessionRow): number {
  const snapshot = row.snapshot;
  return snapshot.turnStartedAt ?? snapshot.lastEventAt ?? snapshot.createdAt;
}

/**
 * Every session waiting on a human that this view cannot draw anywhere.
 *
 * **The new hole, and it is closed by subtraction rather than by three rules
 * agreeing.** Only one machine's chats are on screen now, so a blocked session on
 * any other machine has no row at all — and the tab that carries its count can be
 * scrolled off the end of the bar. That is a strictly new way to hide an approval,
 * which `CLAUDE.md` calls the one failure this screen exists to prevent.
 *
 * Computed as "everything blocked, minus everything reachable", so a new section, a
 * new filter or a new needle cannot open a gap in it by accident — a rule written
 * the other way round would have to be remembered by whoever adds the next group.
 *
 * It **ignores the filter and the needle**, deliberately, for the same reason
 * `machineSubline` puts `blocked` above `offline`: a filter is a slice you asked
 * for, and being asked for an approval is not something you can ask to stop. A
 * *collapsed* folder is not lifted, though — its own header carries the count,
 * which is the mechanism this app already uses.
 */
export function waitingFloor(groups: SessionGroups, view: ListView): SessionRow[] {
  /*
   * **The needle is applied here, and leaving it out was a real hole** — found by
   * the superset property in `webcheck` rather than by reading, which is the whole
   * argument for stating this as a property instead of as a list.
   *
   * `visibleRows` draws pinned, folders and orphans through `matching`, so a
   * blocked row that fails the search is not on screen. Computing reachability
   * *without* the needle therefore called it reachable, and the floor did not lift
   * it: typing four letters into the search box hid an approval, silently, on the
   * one screen whose entire job is not to.
   *
   * The filter is a different case and is deliberately left applied: a row the
   * filter excludes is genuinely not drawn, so subtraction lifts it — which is why
   * a blocked session appears in the floor even under the Ended filter.
   */
  const reachable = new Set<string>();
  for (const row of matching(pinnedFor(groups, view.filter), view.query)) reachable.add(row.key);
  for (const row of matching(orphansFor(groups, view.filter), view.query)) reachable.add(row.key);
  // Under All the flat list *is* every machine, so everything is reachable and
  // this comes back empty — which is the correct answer rather than a special
  // case: the floor exists because one machine's chats are on screen at a time.
  for (const row of allRows(groups, view)) reachable.add(row.key);
  const group = groups.groups.find((candidate) => candidate.id === view.machine);
  if (group !== undefined) {
    // Ignoring collapse: a collapsed folder still announces its own count, so a
    // row inside one is reachable in the sense that matters.
    for (const row of matching(rowsOf(group, view.filter), view.query)) reachable.add(row.key);
  }

  const seen = new Set<string>();
  const out: SessionRow[] = [];
  for (const group of groups.groups) {
    for (const row of [...group.active, ...group.ended]) {
      if (!needsHuman(row.snapshot)) continue;
      if (reachable.has(row.key) || seen.has(row.key)) continue;
      seen.add(row.key);
      out.push(row);
    }
  }
  return out;
}

/**
 * Every session currently on screen, in the order it is drawn.
 *
 * **The single source of render order**, and that is the point rather than
 * tidiness. `keyboard.ts` used to re-flatten the lists under a comment saying "the
 * same order the rail renders" — a claim that was true by coincidence. Both call
 * this now, so the rail and the keyboard cannot disagree.
 *
 * *Sessions* rather than rows: the rail draws a pinned session twice on purpose
 * and this returns it once, because `keyboard.ts` locates the caret with
 * `findIndex(row.key === currentKey)`, which answers with the **first** match — so
 * from the machine copy, `j` would resolve to the pinned copy's index and jump
 * across the whole list.
 *
 * The second parameter is a `ListView` and has **no default**. It had one, and the
 * default is what caused the divergence described above; with three inputs
 * deciding the order there would be three of them.
 */
export function visibleRows(groups: SessionGroups, view: ListView): SessionRow[] {
  const searching = view.query.trim().length > 0;
  const out: SessionRow[] = [...waitingFloor(groups, view)];
  // Pinned collapses through the same set as a folder, and a query overrides it
  // for the same reason: you search, get a match, and it is inside something you
  // shut last month.
  if (searching || !isFolderCollapsed(PINNED_FOLDER)) {
    out.push(...matching(pinnedFor(groups, view.filter), view.query));
  }
  if (searching || !isFolderCollapsed(ALL_FOLDER)) {
    out.push(...allRows(groups, view));
  }
  for (const folder of foldersOf(groups, view)) {
    if (folder.collapsed) continue;
    out.push(...folder.rows);
  }
  // Filtered like everything else, and the needle is applied *outside*
  // `orphansFor` so the call in `SessionBrowser.tsx` keeps the exact shape
  // `webcheck` reads off disk.
  out.push(...matching(orphansFor(groups, view.filter), view.query));

  const seen = new Set<string>();
  return out.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

/** The pinned group's rows under a filter. */
export function pinnedFor(groups: SessionGroups, filter: Filter): SessionRow[] {
  return underFilter(groups.pinned, filter);
}

/**
 * The orphan group's rows under a filter, and it is exported for the same reason
 * `pinnedFor` is: so the JSX and this file cannot mean different things by "the
 * rows on screen".
 *
 * `visibleRows` above has filtered orphans since the day an ended one sat in the
 * Active list — but `SessionBrowser` went on mapping `groups.orphans` raw, so the
 * "No longer granted" section drew rows this function excludes. That is the exact
 * divergence the single-source rule exists to make impossible, and it is worse on
 * this list than anywhere else: `keyboard.ts` locates the caret with
 * `findIndex(row.key === currentKey)`, which answers `-1` for a row only the JSX
 * knows about, so `j` from an orphan jumped to the top of the fleet.
 *
 * Orphans are drawn on **every** tab, unconditionally, because their machines have
 * no tab by construction. That is also what lets `waitingFloor` treat them as
 * reachable and stay a subtraction.
 */
export function orphansFor(groups: SessionGroups, filter: Filter): SessionRow[] {
  return underFilter(groups.orphans, filter);
}

/** One list sliced by the filter. The single rule, so no two call sites can disagree. */
function underFilter(rows: readonly SessionRow[], filter: Filter): SessionRow[] {
  if (filter === "all") return rows as SessionRow[];
  // `showsAsEnded`, the same rule `sessionLists` buckets by — a session the
  // daemon interrupted is not one anybody ended, so the Ended filter must not
  // collect it. This also feeds `visibleRows`, so `j`/`k` cannot walk a row the
  // filter says is not there.
  const ended = (row: SessionRow): boolean => showsAsEnded(row.snapshot);
  return rows.filter((row) => (filter === "ended" ? ended(row) : !ended(row)));
}

/**
 * What a machine's tab says beyond its name, as a *kind* rather than a string.
 *
 * One slot, five possible occupants, and the precedence between them is the whole
 * content of this function — which is exactly why it is here and not a ternary in
 * JSX. The thing it decides is whether an approval can be hidden, which
 * `CLAUDE.md` calls the one failure this screen exists to prevent.
 *
 * The order:
 *
 *   `blocked`  — "5 live" is not the sentence to lead with when one of them is
 *                waiting for you. It wins even when the machine is unreachable;
 *                the tab's own `Dot` still carries reachability in that case,
 *                so nothing is lost, and a hidden approval would be.
 *   `offline`  — before `degraded`, because a machine you cannot reach is a
 *                bigger fact than which token was used to try.
 *   `degraded` — folded in here rather than mounting a badge beside the name.
 *                `machine.ts` raises it on any transport failure while minting
 *                and clears it on the next successful mint, so on a phone
 *                dropping to LTE it toggles repeatedly — and as a badge it moved
 *                the machine name's truncation point every time.
 *   `idle`/`live` — the ordinary case.
 */
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

/**
 * Whether that slot is the one thing the header emphasises.
 *
 * The name says "warns" and there is no warning colour any more; it is kept
 * anyway, because renaming it would cost two assertion edits on the one screen
 * where an approval must never be hidden and buy nothing. **"warn" now names a
 * rank, not a hue** — the caller draws it as `text-fg font-semibold` against
 * `text-muted`.
 */
export function sublineWarns(subline: MachineSubline): boolean {
  return subline.kind === "blocked" || subline.kind === "degraded";
}

export function rowsOf(group: MachineGroup, filter: Filter): SessionRow[] {
  if (filter === "ended") return group.ended;
  // `active` is already blocked-first — see `sessionGroups`.
  return filter === "all" ? [...group.active, ...group.ended] : group.active;
}
