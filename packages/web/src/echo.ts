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

const NONE: readonly PendingEcho[] = [];
/** Every send still held, oldest first: a later send never takes an earlier one's place (Q3.653). An array is replaced, never edited. */
const echoes = new Map<SessionKey, readonly PendingEcho[]>();
/** What a drawn echo is keyed on, so one settling leaves the bubbles under it in place. */
const ids = new WeakMap<PendingEcho, number>();
let sends = 0;
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

export function echoesFor(key: SessionKey): readonly PendingEcho[] {
  return echoes.get(key) ?? NONE;
}

/** The newest send still held. */
export function echoFor(key: SessionKey): PendingEcho | null {
  return echoes.get(key)?.at(-1) ?? null;
}

export function echoId(echo: PendingEcho): number {
  return ids.get(echo) ?? 0;
}

function hold(key: SessionKey, held: readonly PendingEcho[]): void {
  if (held.length === 0) echoes.delete(key);
  else echoes.set(key, held);
}

export function subscribeEchoes(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function echoVersion(): number {
  return version;
}

/** Adds: a send still held stays held. */
export function setEcho(key: SessionKey, echo: PendingEcho): void {
  ids.set(echo, (sends += 1));
  hold(key, [...echoesFor(key), echo]);
  // A new send spends whatever copy the last one was given back.
  doubted.delete(key);
  changed();
}

/** With `sent`, that send's echo alone; without, the session is gone and so is every record of it. */
export function clearEcho(key: SessionKey, sent?: PendingEcho): void {
  const held = echoesFor(key);
  if (sent === undefined) {
    doubted.delete(key);
    arrived.delete(key);
    if (held.length === 0) return;
    echoes.delete(key);
  } else {
    if (!held.includes(sent)) return;
    hold(key, held.filter((echo) => echo !== sent));
  }
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

/** Lands only on the placeholder `sent` wrote, and once: one answer stamps one send, still held. */
export function landEcho(key: SessionKey, sent: PendingEcho, seq: number): void {
  if (sent.seq !== Number.MAX_SAFE_INTEGER || !echoesFor(key).includes(sent)) return;
  // In place: the composer finds this send again by identity.
  sent.seq = seq;
  changed();
}

/** Past an earlier send's own event too, when that send has landed and its event is still on the socket. */
export function sendFloor(key: SessionKey, newestHeld: number, rowLast = 0): number {
  // The row's log too: a conversation opened cold holds nothing yet, and a page of history may carry the same words from before (Q3.711).
  let floor = Math.max(newestHeld, rowLast);
  for (const held of echoesFor(key)) {
    if (held.seq !== Number.MAX_SAFE_INTEGER) floor = Math.max(floor, held.seq);
  }
  return floor;
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
  let held = echoesFor(key);
  const doubt = doubted.get(key);
  let moved = false;
  if (held.length > 0) {
    // One event is one send's, the oldest it could be: the same words sent twice are taken one at a time.
    for (const stored of events) {
      const own = held.find((echo) => isEchoOf(echo, stored));
      if (own === undefined) continue;
      held = held.filter((echo) => echo !== own);
      claimed.add(own);
      moved = true;
    }
    if (moved) hold(key, held);
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
  const held = echoesFor(key);
  if (held.length === 0) return;
  const left = held.filter((echo) => newestSeq < echo.seq);
  if (left.length === held.length) return;
  hold(key, left);
  changed();
}
