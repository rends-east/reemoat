import type { SessionKey } from "./ids";
import type { PromptAttachmentRef } from "./wire";

/** A sent message the log has not returned yet, drawn at the transcript's foot; module state keyed by session, as in attach.ts. */
export interface PendingEcho {
  text: string;
  // MAX_SAFE_INTEGER until the daemon answers, so no unrelated event clears an in-flight echo; matched on seq, never on text.
  seq: number;
  attachments: readonly PromptAttachmentRef[];
}

const echoes = new Map<SessionKey, PendingEcho>();
const listeners = new Set<() => void>();
/** `useSyncExternalStore` compares by identity, so the snapshot has to be stable. */
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function echoFor(key: SessionKey): PendingEcho | null {
  return echoes.get(key) ?? null;
}

export function subscribeEchoes(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function echoVersion(): number {
  return version;
}

export function setEcho(key: SessionKey, echo: PendingEcho): void {
  echoes.set(key, echo);
  changed();
}

/** With `sent`, only while that send's echo is still the one held. */
export function clearEcho(key: SessionKey, sent?: PendingEcho): void {
  if (sent !== undefined && echoes.get(key) !== sent) return;
  if (!echoes.delete(key)) return;
  changed();
}

/** Lands only on the placeholder `sent` wrote: an earlier send's late answer must not stamp the echo that replaced it. */
export function landEcho(key: SessionKey, sent: PendingEcho, seq: number): void {
  const held = echoes.get(key);
  if (held !== sent || held.seq !== Number.MAX_SAFE_INTEGER) return;
  echoes.set(key, { ...held, seq });
  changed();
}

export function settleEcho(key: SessionKey, newestSeq: number): void {
  const held = echoes.get(key);
  if (held === undefined || newestSeq < held.seq) return;
  echoes.delete(key);
  changed();
}
