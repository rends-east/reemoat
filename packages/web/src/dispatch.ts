/** The dispatcher: a session known by its nickname, on the machine Settings names, drawn on the board and in no list of conversations (Q3.720, Q3.724). No DOM in the module body: webcheck imports it. */

import type { MachineId, SessionRef } from "./ids";

/** One literal with the daemon's own, which is what tells that session what it is for. */
export const DISPATCH_NICKNAME = "dispatch";

const STORAGE_KEY = "reemoat.dispatchMachine";

/** Every session under the nickname is one: its daemon tells it so, whichever machine it is on. */
export function isDispatcher(nickname: string | null | undefined): boolean {
  return nickname === DISPATCH_NICKNAME;
}

const listeners = new Set<() => void>();
let version = 0;

function read(): MachineId | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null || raw.length === 0 ? null : (raw as MachineId);
  } catch {
    // Private mode: the choice lasts as long as the page.
    return null;
  }
}

let chosen: MachineId | null = read();

/** The machine Settings names, on this device; null leaves it to wherever a dispatcher already runs. */
export function dispatchMachine(): MachineId | null {
  return chosen;
}

export function setDispatchMachine(next: MachineId | null): void {
  if (chosen === next) return;
  chosen = next;
  try {
    if (next === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Same reasoning: the in-memory choice still stands.
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeDispatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function dispatchVersion(): number {
  return version;
}

export interface DispatchCandidate {
  ref: SessionRef;
  nickname: string | null | undefined;
  /** Stopped by a person or gone for good: a message would still wake it, so it is the dispatcher of last resort. */
  ended: boolean;
  createdAt: number;
}

/**
 * Which session is the dispatcher: one on the chosen machine before any other, a live one before an ended one, the newest
 * before an older. Found among the sessions this client can see, so a phone and a desktop agree with nothing stored between them.
 */
export function dispatchSession<T extends DispatchCandidate>(rows: Iterable<T>, machine: MachineId | null): T | null {
  let best: T | null = null;
  const rank = (row: T): number => (machine !== null && row.ref.machineId === machine ? 0 : 2) + (row.ended ? 1 : 0);
  for (const row of rows) {
    if (!isDispatcher(row.nickname)) continue;
    if (best === null || rank(row) < rank(best) || (rank(row) === rank(best) && row.createdAt > best.createdAt)) best = row;
  }
  return best;
}

/** Where a dispatcher would be started: the chosen machine, else this computer's, else the first that can start anything. */
export function dispatchHome(
  machine: MachineId | null,
  local: MachineId | null,
  startable: readonly MachineId[],
): MachineId | null {
  if (machine !== null && startable.includes(machine)) return machine;
  if (machine !== null) return null;
  if (local !== null && startable.includes(local)) return local;
  return startable[0] ?? null;
}
