import type { SessionKey } from "./ids";
import type { PromptAttachmentRef } from "./wire";

/**
 * A message that has been sent and has not come back yet.
 *
 * **It is drawn in the conversation, at the foot, in the same bubble the
 * committed event gets.** It used to be drawn by `Composer` itself, as the first
 * child of a `sticky bottom-0` bar that is a *sibling* of the scroll box — so
 * your own message appeared under the transcript with a spinner beside it, and
 * then, one commit later, disappeared from there and reappeared inside the
 * transcript when the `prompt` event landed. Two boxes, one frame: the message
 * teleported, and the ground moved twice. Nothing about a message that is on its
 * way is worth that; the remedy for a refusal is the text going back in the box,
 * which is what already happens.
 *
 * A module `Map` with its own subscribers, which is the third of this shape here
 * — see `attach.ts` for the argument against `useState` and against the store,
 * and `choices.ts` for it applied a second time. It sits at `src/` rather than
 * `src/ui/` for their reason too: `store.ts` imports it, both to clear an echo
 * the log has caught up with and to drop a vanished session's, and `store.ts` →
 * `ui/` would be a new edge pointing the wrong way.
 *
 * **Keying it by session is the point rather than an implementation detail.** As
 * React state on `Composer` it was *shared* — that component is never remounted
 * across a session switch — so the `[key]` effect had to clear it, and sending a
 * message, stepping into another conversation and stepping back showed nothing at
 * all until the daemon answered. Keyed, the write names the session it belongs
 * to and needs no `onScreen()` gate: it is the same split `Composer` already
 * documents, with this value moving from the fragile half to the safe one.
 */
export interface PendingEcho {
  text: string;
  /**
   * The seq the daemon says this message landed at, and until it answers,
   * `Number.MAX_SAFE_INTEGER`.
   *
   * A sentinel rather than `null` so the comparison in `store.ts` is one `>=`
   * with no special case: nothing in the log can be newer than that, so an echo
   * whose POST is still in flight is never cleared by an unrelated event
   * arriving. Compared on **seq** and never on text — an identical prompt sent
   * twice would otherwise have its second echo cleared against the first event.
   */
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

/**
 * Drop this session's echo, if it has one.
 *
 * Silent when there is none, which is what lets every caller be unconditional:
 * the refusal path, the session-gone path and the log-caught-up path all run
 * without first asking whether anything is outstanding.
 */
export function clearEcho(key: SessionKey): void {
  if (!echoes.delete(key)) return;
  changed();
}

/**
 * The daemon has named the seq this message landed at.
 *
 * Only ever lowers it from the sentinel, and only while one is still held: an
 * echo the log has already caught up with must not be resurrected by the POST
 * that created it answering afterwards. That ordering is ordinary rather than
 * rare — the `prompt` event arrives over the socket, and the socket is not
 * waiting on a 90-second slow-route budget.
 */
export function landEcho(key: SessionKey, seq: number): void {
  const held = echoes.get(key);
  if (held === undefined || held.seq === seq) return;
  echoes.set(key, { ...held, seq });
  changed();
}

/**
 * Clear it if the log has reached it.
 *
 * Lives here rather than in `store.ts` so the comparison and the sentinel that
 * makes it work are in one file. `store.ts` calls it with the newest seq it has
 * just appended.
 */
export function settleEcho(key: SessionKey, newestSeq: number): void {
  const held = echoes.get(key);
  if (held === undefined || newestSeq < held.seq) return;
  echoes.delete(key);
  changed();
}
