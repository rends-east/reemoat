import type { SessionKey } from "./ids";
import type { PromptAttachmentRef, StoredEvent } from "./wire";

/** A sent message the log has not returned yet, drawn at the transcript's foot; module state keyed by session, as in attach.ts. */
export interface PendingEcho {
  text: string;
  // MAX_SAFE_INTEGER until the daemon answers, so no unrelated event settles an in-flight echo by seq; its own prompt event claims it.
  seq: number;
  /** The newest seq this tab held when it sent, from `sendFloor`: only a prompt event past it can be this message. */
  after: number;
  attachments: readonly PromptAttachmentRef[];
}

const echoes = new Map<SessionKey, PendingEcho>();
/** A send whose request died on the wire and went back to the box; kept so the prompt event that proves it arrived finds that copy (Q3.713). */
const doubted = new Map<SessionKey, PendingEcho>();
/** A doubted send the log has since shown, until the composer takes its copy back. */
const arrived = new Map<SessionKey, PendingEcho>();
/** Echoes their own prompt event took: a request that fails after that has lost only its answer. */
const claimed = new WeakSet<PendingEcho>();
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
  // A new send spends whatever copy the last one was given back.
  doubted.delete(key);
  changed();
}

/** With `sent`, only while that send's echo is still the one held; without, the session is gone and so is every record of it. */
export function clearEcho(key: SessionKey, sent?: PendingEcho): void {
  if (sent !== undefined && echoes.get(key) !== sent) return;
  if (sent === undefined) {
    doubted.delete(key);
    arrived.delete(key);
  }
  if (!echoes.delete(key)) return;
  changed();
}

/** The request failed in transit, so whether the daemon took the message is not known; only its log can say. */
export function doubtSend(key: SessionKey, sent: PendingEcho): void {
  doubted.set(key, sent);
}

/** Whether this send's own prompt event has been seen, which no later failure of its request can undo. */
export function echoClaimed(sent: PendingEcho): boolean {
  return claimed.has(sent);
}

export function arrivedFor(key: SessionKey): PendingEcho | null {
  return arrived.get(key) ?? null;
}

export function takeArrived(key: SessionKey, sent: PendingEcho): void {
  if (arrived.get(key) !== sent) return;
  arrived.delete(key);
  changed();
}

/** Lands only on the placeholder `sent` wrote: an earlier send's late answer must not stamp the echo that replaced it. */
export function landEcho(key: SessionKey, sent: PendingEcho, seq: number): void {
  const held = echoes.get(key);
  if (held !== sent || held.seq !== Number.MAX_SAFE_INTEGER) return;
  echoes.set(key, { ...held, seq });
  changed();
}

/** Past an earlier send's own event too, when that send has landed and its event is still on the socket. */
export function sendFloor(key: SessionKey, newestHeld: number, rowLast = 0): number {
  // The row's log too: a conversation opened cold holds nothing yet, and a page of history may carry the same words from before (Q3.711).
  const floor = Math.max(newestHeld, rowLast);
  const held = echoes.get(key);
  return held === undefined || held.seq === Number.MAX_SAFE_INTEGER ? floor : Math.max(floor, held.seq);
}

/** This send's own prompt event: after the send, not past a seq the daemon named, the same text and the same files in order. */
export function isEchoOf(echo: PendingEcho, stored: StoredEvent): boolean {
  const event = stored.event;
  if (event.type !== "prompt" || stored.seq <= echo.after || stored.seq > echo.seq) return false;
  if (event.text !== echo.text) return false;
  const files = event.attachments ?? [];
  return files.length === echo.attachments.length && files.every((file, i) => file.uploadId === echo.attachments[i]?.uploadId);
}

/** In the commit its prompt event lands in: the socket routinely beats the POST, and waiting for the seq drew the message twice (Q3.653). */
export function claimEcho(key: SessionKey, events: readonly StoredEvent[]): void {
  const held = echoes.get(key);
  const doubt = doubted.get(key);
  let moved = false;
  if (held !== undefined && events.some((stored) => isEchoOf(held, stored))) {
    echoes.delete(key);
    claimed.add(held);
    moved = true;
  }
  // It did arrive: the copy in the box is this message, and sending it would be a second one.
  if (doubt !== undefined && events.some((stored) => isEchoOf(doubt, stored))) {
    doubted.delete(key);
    arrived.set(key, doubt);
    moved = true;
  }
  if (moved) changed();
}

export function settleEcho(key: SessionKey, newestSeq: number): void {
  const held = echoes.get(key);
  if (held === undefined || newestSeq < held.seq) return;
  echoes.delete(key);
  changed();
}
