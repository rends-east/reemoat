import type { SessionKey } from "./ids";

/**
 * Changes asked for and not yet answered, per session.
 *
 * At `src/` rather than `src/ui/` for `attach.ts`'s reason: `store.ts` imports it
 * to drop a vanished session's entries, and `store.ts` → `ui/` would be a new
 * edge pointing the wrong way.
 *
 * Module state with its own subscribers rather than component state, and rather
 * than the store, for the two reasons `attach.ts` gives about the same shape.
 * Against `useState`: there are **two doors** into a config change — the chip on
 * the control strip and the composer's `/effort` menu — and the one that held the
 * override in its own state could only ever cover itself, so a level chosen from
 * the slash menu drew the daemon's own value for the whole round trip and read
 * "Adaptive" while somebody waited for "Low". Against the store: a config round
 * trip must not wake the session list, which re-renders sixty rows.
 *
 * Keyed by session **and** option id, and both keys are load-bearing. The session
 * because the composer and the strip outlive a session switch — an override that
 * followed you to another agent would be a claim about a control you never
 * touched. The option id because the two doors can be in flight at once: the
 * strip's `locked` fences it only against itself, and the `/` menu does not read
 * it at all.
 */
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

/** For `useSyncExternalStore`. */
export function subscribeChoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function choicesVersion(): number {
  return version;
}

/** What is outstanding for one session, or `null` where nothing is. */
export function choicesFor(key: SessionKey): ReadonlyMap<string, string | boolean> | null {
  const held = pending.get(key);
  if (held === undefined || held.size === 0) return null;
  const out = new Map<string, string | boolean>();
  for (const [id, entry] of held) out.set(id, entry.value);
  return out;
}

/**
 * Records what somebody chose, and hands back the receipt that releases it.
 *
 * Called by `applyConfigChange` and by nothing else — which is what makes "the
 * chosen value is what you see" a property of the dispatcher rather than a
 * convention every call site has to remember. `webcheck` asserts that, by
 * reading the two files off disk.
 */
export function beginChoice(key: SessionKey, id: string, value: string | boolean): ChoiceHandle {
  seq += 1;
  const held = pending.get(key) ?? new Map<string, Held>();
  held.set(id, { value, seq });
  pending.set(key, held);
  announce();
  return { key, id, seq };
}

/**
 * Releases one recorded choice, if it is still the one this handle wrote.
 *
 * The identity test is the same discipline as `startPromise !== launch` in the
 * registry: two taps on one control leave two requests in flight, and the first
 * to answer must not take the second's override down with it — the chip would
 * then flick back to the value the person had just moved away from, and stay
 * there until the second answer landed.
 */
export function endChoice(handle: ChoiceHandle): void {
  const held = pending.get(handle.key);
  if (held?.get(handle.id)?.seq !== handle.seq) return;
  held.delete(handle.id);
  if (held.size === 0) pending.delete(handle.key);
  announce();
}

/** Everything outstanding for a session that is going away. */
export function forgetChoices(key: SessionKey): void {
  if (pending.delete(key)) announce();
}
