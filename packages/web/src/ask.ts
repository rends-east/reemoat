/**
 * What the ask card is holding that nothing else needs to know about.
 *
 * A module `Map` with its own subscribers, exactly as `attach.ts` holds files
 * staged for a message, and for the same two reasons stated there.
 *
 * **Not `useState`**: the phone's list → detail → back unmounts `SessionView`,
 * and a four-question form lost that way has nothing to retype from — the
 * questions are the agent's, not yours, so you cannot reconstruct what you were
 * halfway through answering. A card you deliberately collapsed springing open
 * again every time you come back is the same loss of place, one control over.
 *
 * **Not the store**: a keystroke must not wake the session list. `store.emit()`
 * notifies every subscriber including `SessionBrowser`, which is the cost
 * `Composer` already refuses to pay for its own draft text.
 *
 * At `src/` rather than `src/ui/` because `store.ts` imports it — `forgetSession`
 * is where per-session state dies, and an edge from `store.ts` into `ui/` would
 * be a new and wrong direction.
 *
 * **Keyed by `(session, ask)` and not by session alone.** Two requests can be
 * parked at once and the card draws whichever has waited longest, so a
 * session-keyed draft would be typed into one form and read back out of the
 * other — silently, and only when an agent asked twice.
 *
 * **This file used to be `elicitationDraft.ts` and the rename is the point.**
 * `collapsed` is keyed by an *ask* id, of either kind: `perm-N-salt` and
 * `elic-N-salt` come from one counter on the daemon, and from here a permission
 * and a question are one fact — the agent is waiting on you. A second collapse
 * map beside this one would be a second decision about what "put this away"
 * means, which is exactly the nine-call-sites problem `humanRequests` already
 * solved one layer up. What stays elicitation-shaped is the draft and the step,
 * because only a form has either.
 */

import type { SessionKey } from "./ids";
import type { DraftValue, ElicitationDraft } from "./elicitation";

const drafts = new Map<string, Record<string, DraftValue>>();
const listeners = new Set<() => void>();
let version = 0;

const EMPTY: ElicitationDraft = Object.freeze({});

function keyFor(session: SessionKey, askId: string): string {
  return `${session}/${askId}`;
}

function changed(): void {
  version += 1;
  // Guarded and evicting, the same way `SessionLog.append` fans out: one broken
  // subscriber must not stop the rest from hearing about a keystroke.
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      listeners.delete(listener);
    }
  }
}

export function draftFor(session: SessionKey, elicitationId: string): ElicitationDraft {
  return drafts.get(keyFor(session, elicitationId)) ?? EMPTY;
}

export function setDraftField(
  session: SessionKey,
  elicitationId: string,
  field: string,
  value: DraftValue,
): void {
  const key = keyFor(session, elicitationId);
  const current = drafts.get(key) ?? {};
  drafts.set(key, { ...current, [field]: value });
  changed();
}

/**
 * Everything held for one request, once it has been answered one way or another.
 *
 * **Three statements and not one `||` chain**, which is what this was and which
 * did not do what its own first line says. `a.delete(k) || b.delete(k)` stops at
 * the first `true`, so any elicitation that had a draft dropped the draft and
 * leaked its step index and its collapsed flag — visible when a poll already in
 * flight re-applies a snapshot that still lists the request, and the card comes
 * back folded shut on question three. Permissions escaped it only by accident,
 * having neither a draft nor a step.
 */
export function dropAsk(session: SessionKey, askId: string): void {
  const key = keyFor(session, askId);
  const hadDraft = drafts.delete(key);
  const hadStep = steps.delete(key);
  const hadCollapse = collapsed.delete(key);
  if (hadDraft || hadStep || hadCollapse) changed();
}

/**
 * Everything for a session that is going away.
 *
 * Called from `store.forgetSession`, beside `forgetAttachments`. A draft for a
 * question the *agent* withdrew is the one residue left behind — a small object
 * that dies with the session, stated here rather than swept.
 */
export function forgetAsks(session: SessionKey): void {
  let removed = false;
  const mine = (key: string): boolean => key.startsWith(`${session}/`);
  for (const key of [...drafts.keys()]) {
    if (mine(key)) {
      drafts.delete(key);
      removed = true;
    }
  }
  for (const key of [...steps.keys()]) if (mine(key)) steps.delete(key);
  for (const key of [...collapsed]) if (mine(key)) collapsed.delete(key);
  if (removed) changed();
}

/**
 * Which question is on screen, and whether the card is showing at all.
 *
 * Beside the draft rather than in the card, for the identical reason: the phone's
 * list → detail → back unmounts `SessionView`, and stepping back to question one
 * — or having a card you deliberately put away come back by itself — is the same
 * loss of place the draft exists to prevent.
 */
const steps = new Map<string, number>();
const collapsed = new Set<string>();

export function stepFor(session: SessionKey, elicitationId: string): number {
  return steps.get(keyFor(session, elicitationId)) ?? 0;
}

export function setStep(session: SessionKey, elicitationId: string, index: number): void {
  steps.set(keyFor(session, elicitationId), Math.max(0, index));
  changed();
}

/** Whether this particular request is collapsed to its one-line bar. */
export function isCollapsed(session: SessionKey, askId: string): boolean {
  return collapsed.has(keyFor(session, askId));
}

/**
 * Fold the card away, or bring it back.
 *
 * Collapsing answers nothing — the session stays blocked and the agent stays
 * parked, which is the honest thing for a control that only moves a card. What it
 * buys is reading the conversation the request is *about*, which is exactly what
 * you need before answering it, and which the card would otherwise be sitting on
 * top of.
 *
 * Keyed per request rather than per session, so the next thing the agent asks
 * arrives open. "I have read this one" is not a preference about being asked.
 */
export function setCollapsed(session: SessionKey, askId: string, next: boolean): void {
  const key = keyFor(session, askId);
  if (next) collapsed.add(key);
  else collapsed.delete(key);
  changed();
}

export function subscribeAsks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function asksVersion(): number {
  return version;
}
