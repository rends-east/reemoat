import type { SessionKey } from "./ids";

// Finished background rows a reader dismissed: hides them in this tab only, and in memory because a restart, a clear or eviction invalidates the ids.

/** One shared empty set, so an untouched session's snapshot is reference-stable. */
const NONE: ReadonlySet<string> = new Set();
const hidden = new Map<SessionKey, ReadonlySet<string>>();
const listeners = new Set<() => void>();

let version = 0;

function announce(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function hiddenFinished(key: SessionKey): ReadonlySet<string> {
  return hidden.get(key) ?? NONE;
}

export function hiddenFinishedVersion(): number {
  return version;
}

export function subscribeHiddenFinished(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Replaces rather than unions: the set stays what is finished now, so a reused id is never born hidden. */
export function hideFinished(key: SessionKey, ids: readonly string[]): void {
  if (ids.length === 0) return;
  hidden.set(key, new Set(ids));
  announce();
}

export function forgetHiddenFinished(key: SessionKey): void {
  if (!hidden.delete(key)) return;
  announce();
}
