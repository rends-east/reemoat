import { meansRouteAbsent } from "./http";
import { keyOf, type SessionId, type SessionKey, type SessionRef } from "./ids";
import { isNickname, MAX_NICKNAME_CHARS } from "./nickname";
import type { MentionListing, PeerRow } from "./wire";

// What `@` offers in the composer: pure functions over the draft, and one listing per session held outside React. Q3.678.

export interface MentionQuery {
  /** Where the `@` is. */
  start: number;
  query: string;
}

/** The daemon's token: `@` at the start or after whitespace, then what a nickname may hold; never in a slash draft, which gets no note. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  if (text.startsWith("/")) return null;
  if (caret < 1 || caret > text.length) return null;
  const match = /(?:^|\s)@([A-Za-z0-9-]*)$/.exec(text.slice(0, caret));
  if (match === null) return null;
  const query = match[1] ?? "";
  if (query.length > MAX_NICKNAME_CHARS) return null;
  return { start: caret - query.length - 1, query };
}

/** Prefix-first and never fuzzy, as the `/` menu ranks; the title and the folder match only from two characters. */
function mentionRank(row: PeerRow, needle: string): number {
  const name = row.name.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.split("-").some((segment) => segment.startsWith(needle))) return 2;
  if (name.includes(needle)) return 3;
  if (needle.length < 2) return -1;
  if ((row.title ?? "").toLowerCase().includes(needle)) return 4;
  if (row.folder.toLowerCase().includes(needle)) return 5;
  return -1;
}

/** Only a nickname-shaped name is offered: an older daemon's slug could not be typed back as one. */
export function filterMentions(rows: readonly PeerRow[], query: string): PeerRow[] {
  const offered = rows.filter((row) => !row.self && isNickname(row.name));
  if (query.length === 0) return offered;
  const needle = query.toLowerCase();
  const ranked: { row: PeerRow; rank: number; index: number }[] = [];
  offered.forEach((row, index) => {
    const rank = mentionRank(row, needle);
    if (rank >= 0) ranked.push({ row, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((one) => one.row);
}

export interface MentionCompletion {
  text: string;
  caret: number;
}

/** Keeps everything before the `@`, unlike a slash completion, and replaces the whole token even where the caret sits inside it. */
export function mentionCompletion(text: string, query: MentionQuery, name: string): MentionCompletion {
  const before = text.slice(0, query.start);
  const rest = text
    .slice(query.start + 1)
    .replace(/^[A-Za-z0-9-]*/, "")
    .replace(/^[\t ]+/, "");
  const head = `@${name} `;
  return { text: before + head + rest, caret: before.length + head.length };
}

export const MENTIONS_TTL_MS = 15_000;

type Held =
  | { kind: "listed"; listing: MentionListing; at: number }
  | { kind: "failed"; at: number }
  /** A bare 404, remembered against the daemon that answered it: an update is a restart, and a new instance is asked again. */
  | { kind: "absent"; daemon: string | null; at: number };

// Keyed by session, so a late answer lands where it belongs and nothing here needs Composer's `onScreen`.
const held = new Map<SessionKey, Held>();
const inFlight = new Set<SessionKey>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeMentions(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function mentionsVersion(): number {
  return version;
}

/** The last listing this session's daemon gave, or null while none has landed, after a failure, or from a daemon without the route. */
export function mentionListingFor(key: SessionKey): MentionListing | null {
  const entry = held.get(key);
  return entry?.kind === "listed" ? entry.listing : null;
}

/** What the menu may say when it has no rows: nothing asked yet, a listing, a failure, or a daemon without the route. */
export function mentionStateFor(key: SessionKey): Held["kind"] | null {
  return held.get(key)?.kind ?? null;
}

export interface MentionSource {
  mentions(id: SessionId): Promise<MentionListing>;
}

/**
 * At most one request per session per TTL and never two at once; a stale listing stays drawn while the next is asked.
 * `daemon` is the machine's instance id: a 404 is never asked again of the same one, and always of the next (compatibility.md).
 */
export function ensureMentions(
  ref: SessionRef,
  source: MentionSource | undefined,
  daemon: string | null,
  now: number = Date.now(),
): void {
  if (source === undefined) return;
  const key = keyOf(ref);
  if (inFlight.has(key)) return;
  const entry = held.get(key);
  if (entry?.kind === "absent") {
    // With no instance id to compare, the lifetime stands in for one.
    if (daemon !== null ? entry.daemon === daemon : now - entry.at < MENTIONS_TTL_MS) return;
  } else if (entry !== undefined && now - entry.at < MENTIONS_TTL_MS) return;
  inFlight.add(key);
  void source
    .mentions(ref.sessionId)
    .then(
      (listing) => {
        held.set(key, {
          kind: "listed",
          listing: {
            agents: Array.isArray(listing.agents) ? listing.agents : [],
            unreachable: Array.isArray(listing.unreachable) ? listing.unreachable : [],
          },
          at: now,
        });
      },
      (cause: unknown) => {
        held.set(key, meansRouteAbsent(cause) ? { kind: "absent", daemon, at: now } : { kind: "failed", at: now });
      },
    )
    .finally(() => {
      inFlight.delete(key);
      emit();
    });
}
