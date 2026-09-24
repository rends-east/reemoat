// Rows move only when the reader moves them; the key is a position clock defaulting to `createdAt`, descending.

import type { SessionRow } from "./store";

/** One millisecond, so a row dropped at the top still sits below sessions created later. */
export const RANK_STEP = 1;

export function effectiveRank(snapshot: { rank?: number | null; createdAt: number }): number {
  return snapshot.rank ?? snapshot.createdAt;
}

/** `undefined` is a daemon that predates the field and takes the gesture away; `null` only means never moved. */
export function canReorder(snapshot: { rank?: number | null }): boolean {
  return snapshot.rank !== undefined;
}

/** Newest first, then by age, then by key — total, so a poll cannot reshuffle it. */
export function compareRows(a: SessionRow, b: SessionRow): number {
  return (
    effectiveRank(b.snapshot) - effectiveRank(a.snapshot) ||
    b.snapshot.createdAt - a.snapshot.createdAt ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

export function orderSessions(rows: readonly SessionRow[]): SessionRow[] {
  return [...rows].sort(compareRows);
}

/** `null` when the gap has no distinct double left; the caller re-spaces rather than writing a tie. */
export function rankBetween(above: number | null, below: number | null): number | null {
  if (above === null && below === null) return null;
  if (above === null) return (below as number) + RANK_STEP;
  if (below === null) return above - RANK_STEP;
  if (!(above > below)) return null;
  const mid = above + (below - above) / 2;
  return mid >= above || mid <= below ? null : mid;
}

export function rankForMove(rows: readonly SessionRow[], from: number, to: number): number | null {
  if (from < 0 || from >= rows.length) return null;
  const rest = rows.filter((_, index) => index !== from);
  const slot = Math.min(Math.max(to, 0), rest.length);
  const above = rest[slot - 1];
  const below = rest[slot];
  return rankBetween(
    above === undefined ? null : effectiveRank(above.snapshot),
    below === undefined ? null : effectiveRank(below.snapshot),
  );
}

export interface Placement {
  readonly row: SessionRow;
  readonly rank: number;
}

/** `neighbours` excludes the dragged row; a used-up gap re-spaces the group instead of refusing. */
export function resolveDrop(
  neighbours: readonly SessionRow[],
  index: number,
  dragged: SessionRow,
): { readonly rank: number; readonly also: readonly Placement[] } {
  const slot = Math.min(Math.max(index, 0), neighbours.length);
  const above = neighbours[slot - 1];
  const below = neighbours[slot];
  const mid = rankBetween(
    above === undefined ? null : effectiveRank(above.snapshot),
    below === undefined ? null : effectiveRank(below.snapshot),
  );
  if (mid !== null) return { rank: mid, also: [] };

  const order = [...neighbours.slice(0, slot), dragged, ...neighbours.slice(slot)];
  const top = neighbours.reduce(
    (best, row) => Math.max(best, effectiveRank(row.snapshot)),
    effectiveRank(dragged.snapshot),
  );
  const placed = order.map((row, at) => ({ row, rank: top + order.length - at }));
  const mine = placed.find((entry) => entry.row.key === dragged.key);
  return {
    rank: mine?.rank ?? top + order.length,
    also: placed.filter((entry) => entry.row.key !== dragged.key),
  };
}

/** Overlay so a drop does not spring back on the poll. */
export function mergeOptimistic<T extends { pinned?: boolean; rank?: number | null }>(
  snapshot: T,
  patch: { pinned?: boolean; rank?: number | null } | undefined,
): T {
  if (patch === undefined) return snapshot;
  return {
    ...snapshot,
    ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
    ...(patch.rank === undefined ? {} : { rank: patch.rank }),
  };
}
