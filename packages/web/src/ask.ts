/**
 * Module state, so a half-answered card survives the phone's unmount without waking the store on every keystroke.
 * Keyed by session and ask, since two requests can be parked at once.
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

/** Clears every map for the request, in separate statements: an || chain stops at the first hit. */
export function dropAsk(session: SessionKey, askId: string): void {
  const key = keyFor(session, askId);
  const hadDraft = drafts.delete(key);
  const hadStep = steps.delete(key);
  const hadCollapse = collapsed.delete(key);
  let hadExcluded = false;
  for (const entry of [...excluded]) {
    if (entry.startsWith(`${key}/`)) {
      excluded.delete(entry);
      hadExcluded = true;
    }
  }
  if (hadDraft || hadStep || hadCollapse || hadExcluded) changed();
}

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
  for (const key of [...excluded]) if (mine(key)) excluded.delete(key);
  if (removed) changed();
}

const steps = new Map<string, number>();
const collapsed = new Set<string>();

/** Answers switched off without erasing their text, keyed session/ask/field. */
const excluded = new Set<string>();

export function stepFor(session: SessionKey, elicitationId: string): number {
  return steps.get(keyFor(session, elicitationId)) ?? 0;
}

export function setStep(session: SessionKey, elicitationId: string, index: number): void {
  steps.set(keyFor(session, elicitationId), Math.max(0, index));
  changed();
}

export function isCollapsed(session: SessionKey, askId: string): boolean {
  return collapsed.has(keyFor(session, askId));
}

/** Per request, so the next ask arrives open. Collapsing answers nothing. */
export function setCollapsed(session: SessionKey, askId: string, next: boolean): void {
  const key = keyFor(session, askId);
  if (next) collapsed.add(key);
  else collapsed.delete(key);
  changed();
}

/** An empty result is one frozen instance, so the answer's useMemo holds. */
export function excludedFor(session: SessionKey, askId: string): ReadonlySet<string> {
  const prefix = `${keyFor(session, askId)}/`;
  const out = new Set<string>();
  for (const entry of excluded) if (entry.startsWith(prefix)) out.add(entry.slice(prefix.length));
  return out.size === 0 ? NO_EXCLUSIONS : out;
}

const NO_EXCLUSIONS: ReadonlySet<string> = Object.freeze(new Set<string>());

export function setExcluded(session: SessionKey, askId: string, field: string, off: boolean): void {
  const entry = `${keyFor(session, askId)}/${field}`;
  if (off) excluded.add(entry);
  else excluded.delete(entry);
  changed();
}

export function subscribeAsks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function asksVersion(): number {
  return version;
}
