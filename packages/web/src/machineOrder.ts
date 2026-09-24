/** A stored per-device order, never one derived from what the poll flickers. No DOM in the module body: webcheck imports it. */

import type { MachineId } from "./ids";

const STORAGE_KEY = "reemoat.machineOrder";

export const MAX_MACHINE_ORDER = 200;

/** natural decides membership; stored and first decide only order. first leads unless stored names it. */
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

export const LOCAL_DISPLAY_NAME = "local";

/** Drawn, never stored (Q7.139): nothing that writes a label may use it. */
export function machineDisplayName(machine: { id: MachineId; name: string }, local: MachineId | null): string {
  if (local !== null && machine.id === local) return LOCAL_DISPLAY_NAME;
  if (machine.name.toLowerCase() === LOCAL_DISPLAY_NAME) return `${machine.name}-${machine.id.replace(/^m_/, "")}`;
  return machine.name;
}

/** Drawn ids fill the slots stored already had, so a vanished machine keeps its slot; over the bound, stale slots go first. */
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
  const spare = out.length - MAX_MACHINE_ORDER;
  const dropped = new Set<number>();
  for (let at = out.length - 1; at >= 0 && dropped.size < spare; at -= 1) {
    const id = out[at];
    if (id === undefined || live.has(id)) continue;
    dropped.add(at);
  }
  return out.filter((_, at) => !dropped.has(at)).slice(0, MAX_MACHINE_ORDER);
}

/** Counts neighbour midpoints passed, so it stays exact when entries differ in width. */
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
    return [];
  }
}

let order: string[] = read();
const listeners = new Set<() => void>();
let version = 0;

export function machineOrder(): readonly string[] {
  return order;
}

/** Part of the sessionGroups memo guard, since a reorder replaces neither sessions nor machines. */
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
    // The in-memory order still works for this session.
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeMachineOrder(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
