import type { AgentStripEntry } from "./wire";

// Pure and agent-agnostic: callers flatten their listings into natural; whether a harness gets a tile is offersStripTile's rule, not this file's.

export type StripKind = AgentStripEntry["kind"];

export interface StripRow {
  kind: StripKind;
  id: string;
  hidden: boolean;
}

/** Joined and compared, never split back, so a colon inside a plugin harness id cannot cause a collision. */
export function stripKey(kind: StripKind, id: string): string {
  return `${kind}:${id}`;
}

/** Stored order first, then unseen natural rows appended and visible; natural decides membership, stored only order and hiding. */
export function orderStrip(
  natural: readonly { kind: StripKind; id: string }[],
  stored: readonly AgentStripEntry[],
): StripRow[] {
  const live = new Map(natural.map((one) => [stripKey(one.kind, one.id), one]));
  const rows: StripRow[] = [];
  const placed = new Set<string>();
  for (const entry of stored) {
    const key = stripKey(entry.kind, entry.ref);
    // Deduplicated defensively: one id drawn twice is two tiles that select each other.
    if (placed.has(key)) continue;
    const one = live.get(key);
    if (one === undefined) continue;
    placed.add(key);
    rows.push({ kind: one.kind, id: one.id, hidden: entry.hidden });
  }
  for (const one of natural) {
    const key = stripKey(one.kind, one.id);
    if (placed.has(key)) continue;
    placed.add(key);
    rows.push({ kind: one.kind, id: one.id, hidden: false });
  }
  return rows;
}

/** Writes every row, appended ones included, so a later arrival cannot be inserted ahead of a row already seen. */
export function stripEntries(rows: readonly StripRow[]): AgentStripEntry[] {
  return rows.map((row) => ({ kind: row.kind, ref: row.id, hidden: row.hidden }));
}

/** Splice semantics, not swap; out-of-range indices return a copy. Shared by the agent strip and the machine folders. */
export function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  const next = [...rows];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(to, 0), next.length - 1);
  if (target === from) return next;
  const cut = next.splice(from, 1);
  // A length test rather than a value check, since T may itself include undefined.
  if (cut.length === 0) return next;
  next.splice(target, 0, ...cut);
  return next;
}

/** Rounds, so the row moves once the dragged row is more than half over its neighbour. */
export function dropIndex(from: number, offset: number, rowHeight: number, count: number): number {
  if (rowHeight <= 0 || count <= 0) return from;
  const moved = Math.round(offset / rowHeight);
  return Math.min(Math.max(from + moved, 0), count - 1);
}

/** The first row neither hidden nor unstartable, else null; startable is required so no caller can forget it. */
export function defaultRow(
  rows: readonly StripRow[],
  startable: (row: StripRow) => boolean,
): StripRow | null {
  return rows.find((row) => !row.hidden && startable(row)) ?? null;
}
