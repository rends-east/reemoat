import type { AgentStripEntry } from "./wire";

/**
 * Which agents the New session strip offers, and in what order.
 *
 * **DOM-free on purpose**, like `agents.ts` and `agentPick.ts` beside it: every
 * rule here is a pure function `webcheck` drives directly, because the thing
 * being decided — where a tile goes and whether it is drawn at all — is exactly
 * the kind of rule that is untestable once it is written inside a component.
 *
 * The subject is a **merge**, and the merge is the whole design. The daemon
 * stores a partial record — a position and a switch for what somebody actually
 * moved or hid — and the machine separately reports what it can start right now.
 * Neither is the answer. What the row draws is the stored order applied over the
 * live listing, and the three rules in {@link orderStrip} are what make that
 * survive a fleet changing underneath it.
 *
 * ⚠ **Nothing here knows what an agent is.** No `AgentId`, no `CustomAgent`, no
 * status. The caller flattens its two listings into `natural` and reads the
 * answer back the same way. That is not purity for its own sake: the rule "a
 * harness with no tile is not in the strip" belongs to `offersStripTile` in
 * `agents.ts` — `shownHere` on the screen is a binding of it — and a copy of it in
 * here would be a second place to fix it.
 */

/** A built-in harness, or an agent somebody assembled. */
export type StripKind = AgentStripEntry["kind"];

/** One place in the strip, resolved against what the machine offers. */
export interface StripRow {
  kind: StripKind;
  id: string;
  hidden: boolean;
}

/**
 * The key two lists are joined on.
 *
 * `${kind}:${id}`, which is the same string `AgentStrip` already builds to decide
 * which tile to scroll into view — so a harness and an assembled agent that
 * happen to share an id are two rows, and a colon in an id cannot make them one.
 * A `ca_` id is hex and a harness id is one word, so nothing today can collide;
 * this is what keeps that from being a thing to remember.
 */
export function stripKey(kind: StripKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * The strip, as the daemon remembers it and the machine currently is.
 *
 * Three rules, and the third is the one that earns the design:
 *
 *   1. **Stored entries first, in the order they were stored** — keeping only
 *      those `natural` still holds. A `ref` that resolves to nothing is dropped
 *      rather than drawn: an assembled agent somebody deleted on another device,
 *      a harness that has been signed out. It keeps its row in the database, so
 *      it comes back where it was if the thing does.
 *   2. **Then everything `natural` holds that the store has never heard of**, in
 *      natural order, at the end. This is the only place new agents can go: the
 *      stored list is a total order over what existed when it was written, and
 *      inventing a position inside it for something that arrived later would be
 *      this function having an opinion nobody expressed.
 *   3. **Unknown means visible.** `hidden` comes from the store and defaults to
 *      `false`. A new agent arriving already switched off is indistinguishable
 *      from the daemon having lost it, and it is the one default here that would
 *      generate a bug report.
 *
 * ⚠ **`natural` decides membership; `stored` decides only order and hiding.**
 * The two are not symmetric and reading them as symmetric is the mistake this
 * note exists to prevent — a strip built from the stored list plus leftovers
 * would draw a tile for an agent the machine cannot start, which is the state
 * `offeredHere` exists to make unreachable.
 */
export function orderStrip(
  natural: readonly { kind: StripKind; id: string }[],
  stored: readonly AgentStripEntry[],
): StripRow[] {
  const live = new Map(natural.map((one) => [stripKey(one.kind, one.id), one]));
  const rows: StripRow[] = [];
  const placed = new Set<string>();
  for (const entry of stored) {
    const key = stripKey(entry.kind, entry.ref);
    // A duplicate cannot arrive from this daemon — the route refuses one — but
    // this list also comes back from `saveAgentStrip`'s echo and from whatever a
    // future build stores, and one id drawn twice is two tiles that select each
    // other.
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

/**
 * What the strip writes back.
 *
 * Every row, including the ones `orderStrip` appended and nobody has touched.
 * That is what makes the next read stable: an agent that has been *seen* by this
 * screen has a position, so the one after it cannot be inserted in front of it by
 * arriving with an earlier `created_at`.
 */
export function stripEntries(rows: readonly StripRow[]): AgentStripEntry[] {
  return rows.map((row) => ({ kind: row.kind, ref: row.id, hidden: row.hidden }));
}

/**
 * Move one row, for both the drag and the keyboard.
 *
 * ⚠ **Splice semantics, not swap.** Dragging row 0 to position 3 must leave 1, 2
 * and 3 shifted up by one — a swap would leave the list in an order nobody asked
 * for the moment a drag crosses more than one row, and the two gestures would
 * disagree about what "move down" means. Out-of-range indices answer a copy
 * rather than throwing: the drag reports a position measured from a pointer, and
 * a pointer that left the list is not an error.
 */
export function moveRow(rows: readonly StripRow[], from: number, to: number): StripRow[] {
  const next = [...rows];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(to, 0), next.length - 1);
  if (target === from) return next;
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(target, 0, moved);
  return next;
}

/**
 * Where a drag has got to, in rows.
 *
 * `offset` is how far the pointer has travelled from where it went down, in the
 * same pixels `rowHeight` is measured in. Rounding rather than truncating is what
 * makes the row swap at the point the dragged row is more than half over its
 * neighbour, which is where the eye expects it — truncation swaps a full row
 * late and reads as the list resisting.
 */
export function dropIndex(from: number, offset: number, rowHeight: number, count: number): number {
  if (rowHeight <= 0 || count <= 0) return from;
  const moved = Math.round(offset / rowHeight);
  return Math.min(Math.max(from + moved, 0), count - 1);
}

/**
 * The row a new session opens on when nobody has chosen anything.
 *
 * ⚠ **"First" is stricter than index 0, and both narrowings are load-bearing.**
 *
 * A **hidden** row is one somebody took off the New session screen. It keeps its
 * place here — that is the only way back — so the list's first entry is routinely
 * one that is not drawn at all, and defaulting to it selects nothing: the strip
 * draws no chosen tile and `Start` stays dead until somebody taps.
 *
 * An **unstartable** row is the same failure arriving by the other door, and it
 * is the one that outlived the fix for the first — the hidden case was closed by
 * naming the *flag*, so the next row that cannot be started walked straight in.
 * The settings list is deliberately wider
 * than the strip — a harness nobody is signed in to has a row so its badge can say
 * why it has no tile, and an assembled agent whose harness was uninstalled draws a
 * disabled tile saying the same — so `rows` holds entries that resolve to nothing
 * pressable. `startable` is the caller's word for that, and it is **required**
 * rather than defaulted: defaulted, a caller that forgot it would compile, and the
 * state that produces is one nobody can tell from a screen still loading. The
 * contrast is `offeredHere`'s own `hidden`, which genuinely is defaulted — and can
 * be, because forgetting that one costs a pick weighed again on the next render.
 *
 * ⚠ **The predicate is injected because this module may not know what an agent
 * is** — see the file's own note. What "ready to start" means is two listings and
 * five stances away, and a copy of that here would be the second place to fix it.
 *
 * `null` is a real answer: a machine whose every agent is hidden, signed out or
 * uninstalled has no default, and pointing at the first row anyway would be this
 * function inventing the one thing it exists to report honestly.
 */
export function defaultRow(
  rows: readonly StripRow[],
  startable: (row: StripRow) => boolean,
): StripRow | null {
  return rows.find((row) => !row.hidden && startable(row)) ?? null;
}
