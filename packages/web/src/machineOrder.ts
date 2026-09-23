/**
 * What order the machines are in, who decides — and what the list calls the one
 * this app is running beside.
 *
 * **Their reader decides, and only by saying so.** The list is ordered by name
 * until somebody drags one, and by name for every machine nobody has dragged —
 * except the computer this client is running on, which leads until somebody drags
 * it somewhere else ({@link orderMachines}' first clause).
 * That is a narrowing of the rule in `web-shell.md`, not a reversal of it, and the
 * distinction is the rule's own stated reason: *reachability* and *activity*
 * flicker on the four-second poll, so a list ordered by either reshuffles under a
 * travelling thumb. A **stored** order cannot — it moves when somebody moves it
 * and at no other moment — which is exactly why one is allowed here where a
 * derived one is still banned outright. **Which computer this is** does not flicker
 * either: it is seeded at launch from the machine this app created for the
 * server, replaced only when the announce file names a different machine of the
 * account's, and never cleared by a read that finds nothing — so it moves when
 * this computer's daemon becomes another machine, never when a daemon restarts
 * or a network does (`store.ts`'s `localMachineAfter`).
 *
 * **And the one name this module decides**, {@link machineDisplayName}, sits here
 * because it is the same fact as that first clause asked a second question: the
 * machine this client runs beside leads the list, and is called `local` in it.
 *
 * **Module state seeded from `localStorage`**, the idiom `rail.ts` argues and
 * `groups.ts` uses: this is a preference about the app rather than about a screen,
 * and the phone's list → detail → back unmounts both things that draw it. Per
 * device, deliberately — the control plane has nowhere to put a per-user order and
 * the owner's call was that a schema migration is not worth one.
 *
 * ⚠ **No DOM in this module's body.** `webcheck` imports it with a stubbed
 * `window.localStorage` and nothing else, which is `rail.ts`'s own ⚠ and the
 * reason this file sits beside `store.ts` rather than under `ui/` — `store.ts`
 * reads it, and `store.ts` may not import from `ui/`.
 *
 * ## Why this is `orderStrip`'s shape and not `sessionOrder.ts`'s
 *
 * Sessions carry a `rank`: a position *clock*, one number per row, defaulting to
 * `createdAt`. That is right there and wrong here, and `agentStrip.ts` already
 * argues the difference one list over — **which list gains members on the
 * commonest act in the product.** Starting a session is what this app is *for*, so
 * that list grows constantly and a new row has to have an honest position with
 * nothing stored; hence a clock, `rankBetween`, and a re-space when two instants
 * collide. Machines are added by hand, a handful per account, over months. A
 * whole-list rewrite per reorder costs nothing there and removes every way the
 * arithmetic can be wrong: no equal ranks, no bisection running out of room, no
 * partial application to report.
 *
 * Two more, either of which would be enough on its own. There is no server to hold
 * a rank — a per-machine rank in `localStorage` is the same information as an
 * ordered list of ids with strictly more ways to disagree with itself. And this
 * list is **bounded** ({@link MAX_MACHINE_ORDER}) where sessions are not.
 */

import type { MachineId } from "./ids";

const STORAGE_KEY = "reemoat.machineOrder";

/**
 * How many positions are kept.
 *
 * `MAX_STRIP_ENTRIES` read one subject over: this is hand-editable storage and a
 * bound is cheaper than a validation. Two hundred is past any fleet this product
 * is shaped for — the machine limit itself defaults to fifty — so nobody reaches
 * it by *having* that many machines, and somebody who has pasted a megabyte into
 * the key gets a working list rather than a slow one.
 *
 * ⚠ **It is reachable by attrition rather than by fleet size, which is what makes
 * {@link nextOrder}'s choice of what to drop load-bearing.** A slot is kept for a
 * machine the fleet has lost and nothing ever evicts one, so this list grows with
 * every revoke-and-enroll over the life of an install while the fleet stays at a
 * handful. Two hundred retired grants is a long time and not an impossibility —
 * so which end the bound is spent on decides whether the feature still works when
 * it is hit.
 */
export const MAX_MACHINE_ORDER = 200;

/**
 * The stored order, merged over what the fleet actually holds.
 *
 * Four clauses — two of them {@link import("./agentStrip").orderStrip}'s, one this
 * list's own, and the last a deliberate absence:
 *
 *   1. **`first` — the machine this client runs beside — leads, unless the stored
 *      order names it.** The owner's words: the local daemon is `local` *and first
 *      in the list*. A position somebody expressed still wins: an id that is in
 *      `stored` stays exactly where it was put, so this clause fills the default
 *      and never overrides a drag. It is placed *before* the stored ids, not
 *      appended with the strangers in clause 3 — appended, it would be first only
 *      on a fleet nobody had ever dragged. `null` (a browser, a shell with no
 *      daemon) and an id `natural` does not hold (another fleet's daemon) both
 *      leave the other three clauses exactly as they were.
 *   2. **Stored ids next, in stored order**, keeping only those `natural` still
 *      holds. An id that resolves to nothing is dropped *at draw time* and keeps
 *      its slot in storage, so a machine comes back where it was if the grant
 *      does.
 *   3. **Then everything the store has never heard of, in natural order, at the
 *      end.** `natural` arrives already sorted by name, so this clause *is* the
 *      name sort rather than a replacement for it. A machine enrolled this morning
 *      has no position anybody expressed, and inventing one inside the stored list
 *      would be this function having an opinion nobody gave it.
 *   4. **There is no `hidden` clause and there must never be one.** `natural`
 *      decides membership outright. `web-shell.md`: *"A machine with no sessions
 *      still gets a tab"* — an order that could drop a granted machine would
 *      reverse that through the other door, and the tab is the only route to
 *      starting a session on a machine you have just added.
 *
 * ⚠ **`natural` decides membership; `stored` and `first` decide only order.**
 * Reading them as symmetric is the mistake `agentStrip.ts` records having to name,
 * and the duplicate guard is the other half of it: this list comes out of storage
 * somebody can hand-edit, and one id drawn twice is two tabs that select each
 * other.
 *
 * ⚠ **A drag is what stores `first`, and nothing else does.** `setMachineOrder`
 * writes the whole drawn list, so the first drag of *any* machine stores this one
 * at the place it was drawn — first, if nobody had moved it — and from then on
 * clause 2 is what holds it there. The consequence is stated rather than smoothed:
 * a reader who had dragged anything before this clause existed already has this
 * machine stored wherever it was drawn then, and it stays there until they move it.
 */
export function orderMachines<T extends { id: MachineId }>(
  natural: readonly T[],
  stored: readonly string[],
  first: MachineId | null = null,
): T[] {
  const live = new Map(natural.map((one) => [one.id as string, one]));
  const rows: T[] = [];
  const placed = new Set<string>();
  const take = (id: string): void => {
    if (placed.has(id)) return;
    const one = live.get(id);
    if (one === undefined) return;
    placed.add(id);
    rows.push(one);
  };
  if (first !== null && !stored.includes(first)) take(first);
  for (const id of stored) take(id);
  for (const one of natural) take(one.id as string);
  return rows;
}

/** The word {@link machineDisplayName} draws for the machine this client runs beside. */
export const LOCAL_DISPLAY_NAME = "local";

/**
 * What this client calls a machine wherever it names one as a label: `local` for
 * the computer it is running on, the stored label for every other — except a
 * label that is itself `local`.
 *
 * ⚠ **Drawn, never stored, and that is Q7.139 in both of its halves.** The label
 * on the control plane is the ordinary host name, because that row is read by a
 * phone, a second computer and anybody holding a grant, and to every one of them
 * `local` names a computer somewhere else. Which row you are *sitting at* is true
 * of one client only, so it is answered here, per client, from
 * `AppState.localMachineId` — the announce file, never `route.kind`. Nothing that
 * writes a label may call this: a rename seeded from it would store `local` on
 * the row every other client reads, which is the decision Q7.139 reversed.
 *
 * **One function, so the rule is asserted once.** Every surface that names a
 * machine as a label — the strip, the rail, the New session picker, the
 * `machine · path` line on a row and on a session's header — reads it through here
 * or through `MachineGroup.name`, which `sessionGroups` fills from here. Settings →
 * Machines is the deliberate exception: it is where the label is *managed*, so it
 * shows the real one and marks the row `this device` instead.
 *
 * ⚠ **A sentence keeps the stored label.** "could not authenticate on local"
 * reads as a word missing, and a sentence is what gets pasted to somebody at
 * another client — for whom `local` is their own computer.
 *
 * ⚠ **On this client the word means this computer and nothing else, so another
 * machine labelled `local` is drawn as `local-<hex>`.** Such labels exist: Q7.139
 * migrated nothing, so a machine the app set up while `local` was the stored
 * label still carries it — a Mac's old one sits in the list beside the one it
 * runs now — and `nameVisibleTo` lets any other be renamed to it, because the
 * label this computer's own machine carries is its host name. Drawn plainly, two tiles read
 * `local` under the same monogram, and the control plane's uniqueness rule cannot
 * see a name that exists only in this function. The suffix is `qualifiedName`'s
 * shape — label, `-`, the id without `m_` — because for a machine created as
 * `local` and never renamed it is exactly `machines.name`, the one name the
 * control plane holds unique, and what `cpctl admin machines` prints. As a *drawn*
 * string it is not unique by construction: another machine could be labelled
 * `local-2405b5ea…` by hand and draw the same text, which is a person choosing
 * the collision rather than two machines falling into it.
 * Case-folded, as `ambiguousNames` folds: `Local` beside `local` is the same
 * collision to somebody reading a tab. **Whatever `local` is**, including `null` —
 * so this tile's name never depends on whether this computer has been identified
 * yet, and a browser, with no computer to call `local`, never draws the word.
 */
export function machineDisplayName(machine: { id: MachineId; name: string }, local: MachineId | null): string {
  if (local !== null && machine.id === local) return LOCAL_DISPLAY_NAME;
  if (machine.name.toLowerCase() === LOCAL_DISPLAY_NAME) return `${machine.name}-${machine.id.replace(/^m_/, "")}`;
  return machine.name;
}

/**
 * What to write back, given what is drawn now and what was stored before.
 *
 * ⚠ **This is the one place this diverges from the agent strip, and it is on
 * purpose.** `MachineAgentsSection` writes back the *merged* list, so an entry the
 * machine no longer offers is silently dropped from storage by the next reorder —
 * its "it comes back where it was if the thing does" holds until somebody drags.
 * A machine keeps its slot instead, because `groups.ts`'s `selectedMachineIn`
 * already makes exactly that promise about the selected tab — *"a grant revoked
 * and restored puts you back on your tab rather than on whatever happened to be
 * first while it was gone"* — and an order that forgot while a tab remembered
 * would be two halves of one preference disagreeing.
 *
 * So `drawn` is spliced into the positions `stored` already had: walking the
 * stored list, a slot that names something currently drawn takes the next id from
 * `drawn`, and a slot that names something absent keeps what it held.
 *
 * ⚠ **Bounded by dropping the *stale* slots, last first, and by truncating the
 * tail only once there are no stale ones left to drop.**
 * `slice(0, MAX_MACHINE_ORDER)` over the whole result was exactly inverted, and
 * the reason is the order of the two loops below: the stored walk runs first and
 * the queue's remainder is appended *after* it, so **the tail is where the live
 * machines land.** Reproduced while reviewing this file —
 * `nextOrder(<200 retired ids>, ["m_b", "m_a", "m_c"])` answered two hundred
 * entries with **none** of the three live ones among them, and feeding that back
 * through a second drag answered no live id again. The reorder preference is then
 * permanently inoperative and never self-clears.
 *
 * ⚠ **It breaks nothing on screen, which is why it had to be asserted rather than
 * left to a report.** `orderMachines` drops an id the fleet no longer holds at
 * draw time, so the column goes on rendering in pure name order for ever: no
 * crash, no empty list, and no way to tell from the outside that dragging has
 * stopped being a thing this app does. The all-live case — three hundred machines
 * truncated to two hundred — is the shape the bound was written against, and it
 * cannot see this at all.
 *
 * So the bound is spent on the slots kept **out of courtesy** rather than on the
 * ones somebody is looking at: every id in `drawn` survives, and what room is left
 * is filled from the stale entries in stored order. The tail is still cut when
 * `drawn` alone is over the bound, because at that point there is nothing else
 * left to cut.
 */
export function nextOrder(stored: readonly string[], drawn: readonly string[]): string[] {
  const live = new Set(drawn);
  const queue = [...drawn];
  const out: string[] = [];
  const placed = new Set<string>();
  const push = (id: string): void => {
    if (placed.has(id)) return;
    placed.add(id);
    out.push(id);
  };
  for (const id of stored) {
    if (live.has(id)) {
      const next = queue.shift();
      if (next !== undefined) push(next);
      continue;
    }
    push(id);
  }
  for (const id of queue) push(id);
  if (out.length <= MAX_MACHINE_ORDER) return out;
  // Over the bound. Give up the stale slots from the back, so what is dropped is
  // the oldest courtesy rather than the newest position — and only then fall back
  // to the tail, which is reached solely when `drawn` is over the bound by itself.
  const spare = out.length - MAX_MACHINE_ORDER;
  const dropped = new Set<number>();
  for (let at = out.length - 1; at >= 0 && dropped.size < spare; at -= 1) {
    const id = out[at];
    if (id === undefined || live.has(id)) continue;
    dropped.add(at);
  }
  return out.filter((_, at) => !dropped.has(at)).slice(0, MAX_MACHINE_ORDER);
}

/**
 * Which slot a pointer is over, counting the entries it has passed.
 *
 * `middles` is every entry's midpoint along the axis, in draw order and including
 * the one being dragged; `from` is that one's index; `at` is the pointer.
 *
 * ⚠ **Not `dropIndex`, and the difference is the axis.** That function divides
 * travel by **one** measured row, which is exact on a 72px column where every
 * entry is the same size and drifts past the first neighbour on a strip where
 * `mac` sits beside `server-fra-01`. A function that is right on one axis and
 * quietly wrong on the other is worse than two functions, so `dropIndex` keeps its
 * one caller and this counts midpoints instead.
 *
 * The rule is **the pointer passing a neighbour's midpoint**, which is what
 * `dropIndex`'s rounding approximates on a uniform list and what this states
 * exactly on a list that is not uniform. Where the grab is near the middle of the
 * entry — the ordinary case, and `rowDrag.ts`'s too — that is the moment the
 * dragged entry is half over its neighbour, which is where the eye expects the
 * swap; a grab near one end offsets it by that much, on both lists equally.
 *
 * ⚠ **The two coordinate systems `rowDrag.ts` keeps apart coincide here, and the
 * note exists so nobody goes looking for the off-by-one.** There `origin.index`
 * counts a zone's rows *including* the dragged one while `target.index` is a slot
 * *among the others*, because a drop can cross groups. This is a single list, so a
 * slot-among-others and an index-in-the-full-list are the same number — which is
 * why the answer feeds {@link import("./agentStrip").moveRow} directly.
 */
export function dropSlot(middles: readonly number[], from: number, at: number): number {
  let slot = 0;
  for (let i = 0; i < middles.length; i += 1) {
    if (i === from) continue;
    if (at > (middles[i] ?? 0)) slot += 1;
  }
  return slot;
}

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_MACHINE_ORDER);
  } catch {
    // Private mode, a quota, or somebody's hand-edited value. ⚠ **The failure mode
    // of storage here is the order a reader who never dragged gets anyway**: an
    // empty list falls through `orderMachines`' clause 1 to this computer's machine
    // and then through clause 3 to pure name order. That is what makes this `catch`
    // honest rather than a swallow.
    return [];
  }
}

let order: string[] = read();
const listeners = new Set<() => void>();
/** Bumped on every committed change. `useSyncExternalStore` compares by `Object.is`. */
let version = 0;

export function machineOrder(): readonly string[] {
  return order;
}

/**
 * The version, and it is in `sessionGroups`' memo guard rather than only here.
 *
 * That memo is keyed on the identity of `state.sessions` and `state.machines`, and
 * a reorder replaces neither — so this number is the third input. It is one of two
 * that move without the poll; the other is `state.localMachineId`, which decides
 * clause 1 of {@link orderMachines} and is in the same guard for the same reason.
 */
export function machineOrderVersion(): number {
  return version;
}

/** Idempotent on the committed value: a drop that moved nothing tells nobody. */
export function setMachineOrder(drawn: readonly string[]): void {
  const next = nextOrder(order, drawn);
  if (next.length === order.length && next.every((id, at) => id === order[at])) return;
  order = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The in-memory order still works for this session, which is the same trade
    // `groups.ts` and `rail.ts` both make about a preference.
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeMachineOrder(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
