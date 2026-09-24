import type { SessionKey } from "./ids";

// Pending config changes, keyed by session and option id: the chip and the slash menu can both be in flight, and a round trip must not wake the store.
const pending = new Map<SessionKey, Map<string, Held>>();

interface Held {
  value: string | boolean;
  /** Which write this is, so a later one is not released by an earlier answer. */
  seq: number;
}

/** A receipt for one recorded choice, and the only thing that can release it. */
export interface ChoiceHandle {
  key: SessionKey;
  id: string;
  seq: number;
}

let seq = 0;
let version = 0;
const listeners = new Set<() => void>();

function announce(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeChoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function choicesVersion(): number {
  return version;
}

export function choicesFor(key: SessionKey): ReadonlyMap<string, string | boolean> | null {
  const held = pending.get(key);
  if (held === undefined || held.size === 0) return null;
  const out = new Map<string, string | boolean>();
  for (const [id, entry] of held) out.set(id, entry.value);
  return out;
}

/** Only applyConfigChange may call this, which webcheck asserts. */
export function beginChoice(key: SessionKey, id: string, value: string | boolean): ChoiceHandle {
  seq += 1;
  const held = pending.get(key) ?? new Map<string, Held>();
  held.set(id, { value, seq });
  pending.set(key, held);
  announce();
  return { key, id, seq };
}

/** Releases only if this handle's write is still the latest, so an earlier answer cannot drop a later override. */
export function endChoice(handle: ChoiceHandle): void {
  const held = pending.get(handle.key);
  if (held?.get(handle.id)?.seq !== handle.seq) return;
  held.delete(handle.id);
  if (held.size === 0) pending.delete(handle.key);
  announce();
}

export function forgetChoices(key: SessionKey): void {
  if (pending.delete(key)) announce();
}
