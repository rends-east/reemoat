/**
 * What a file change actually was, as lines somebody can read.
 *
 * One implementation, two callers: the approval card draws this *before* an edit
 * happens, and the transcript draws it after. There used to be a `lineDiff` in
 * `permission.ts` serving only the first, and it was replaced rather than joined
 * — two functions answering "what changed" is a second place for the next rule to
 * be forgotten, which is the mistake this file's own docblocks keep naming.
 *
 * Nothing here imports React or touches the DOM, so `webcheck` asserts all of it.
 *
 * **What the input actually is depends on the agent**, and every decision below
 * follows from that:
 *
 *   claude `Edit`   `oldText`/`newText` are the model's `old_string`/`new_string`
 *                   — a **fragment**, with no context lines and no line numbers.
 *   claude `Write`  `oldText` is **`null` even when overwriting**, so it reads as
 *                   a creation. Not repairable from here; the daemon never saw
 *                   the previous file.
 *   codex           whole files on both sides, for add, update *and* delete
 *                   (a delete arrives as `newText: ""`).
 *   kimi            a fragment through the diff channel, and the whole file again
 *                   through `fs/write_text_file`. See `tail.ts`, which drops the
 *                   second copy.
 *
 * The consequence for the algorithm is the one that decided it: on a fragment the
 * common prefix/suffix trim is exact, and on a whole file it is not — a two-hunk
 * edit shares its beginning and end with the original, so trimming alone reports
 * "the whole middle was replaced". That is why there is an LCS pass behind the
 * trim, bounded, rather than a trim on its own.
 */

import type { FileChangeEvent } from "./wire";

/** Lines of unchanged text kept either side of a change. */
const DIFF_CONTEXT = 2;

/**
 * The most lines one file's diff will draw.
 *
 * 60, unchanged from the single-hunk version this replaced — a diff is read to
 * see *what* changed, and past a screenful the answer is "open the file". The
 * count above the body still reports the true totals, so a clip never
 * understates the change; `omitted` says how much is not on screen.
 */
const DIFF_MAX_LINES = 60;

/**
 * Where the quadratic pass stops.
 *
 * The LCS below is an O(n·m) table over what survives the prefix/suffix trim, and
 * this is the cell budget: 250 000, i.e. about 500×500 lines of genuinely
 * unaligned text. Past it the answer degrades to one replacement block — which is
 * exactly what the trim-only version answered for *every* multi-hunk file — and
 * `wholeFile` says so out loud.
 *
 * It is a budget rather than a line count because the cost is the product: 2000
 * lines against 4 is cheap and 500 against 500 is the real ceiling.
 */
const MAX_LCS_CELLS = 250_000;

/** The longest pair of lines compared character by character. */
const MAX_MARK_CHARS = 400;

/**
 * How much of a line a mark may cover before it stops being worth drawing.
 *
 * Measured by rendering the real log: a heading rewritten from "Assumptions
 * (correct them if wrong)" to "Default settings" — translated here from the
 * original pair, which shared only its `"## "`, so the mark covered **92% and
 * 88%** of its two lines — a
 * second, darker tint over a line whose row tint had already said it changed.
 * Twice the ink for none of the information.
 *
 * So a mark is kept only where it is a *minority* of the line, which is the case it
 * exists for: a value, a word or an argument replaced inside a line that is
 * otherwise the same. Past this, the two lines are not one line edited — they are
 * different lines, and the row tint is the whole of what there is to say.
 */
const MAX_MARK_SHARE = 0.6;

/**
 * The daemon's own truncation note, mirrored.
 *
 * `clip` in `src/events.ts` appends this when an event exceeds the 128 KiB
 * per-event cap, and for a `file_change` it clips `oldText` and `newText` to half
 * that **each**. Both sides are then cut at the same offset, which destroys the
 * common suffix — so a diff computed over them would show the tail of the file as
 * rewritten when nothing there was touched. Hence `unavailable`: there is a
 * difference between "nothing changed" and "we cannot say".
 *
 * A mirrored literal for `wire.ts`'s reason — `packages/web` cannot import from
 * `src/` — so this is the one string here that has a copy elsewhere and must
 * follow it.
 */
const TRUNCATION_MARKER = /…\[truncated \d+ bytes\]$/;

/** A run of characters inside a line that differs from the line it is paired with. */
export type Mark = readonly [start: number, end: number];

export interface DiffLine {
  kind: "same" | "add" | "del";
  /** 1-based, or `null` on a line that exists only on the other side. */
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /**
   * Which parts of `text` are the change, when this line is paired with one on
   * the other side. `null` whenever there is nothing to pair with — an inserted
   * line is not a modified one, and marking all of it would say the opposite.
   */
  marks: readonly Mark[] | null;
}

/** One contiguous region of the file, with its context. */
export interface DiffHunk {
  lines: readonly DiffLine[];
}

export interface FileDiff {
  hunks: readonly DiffHunk[];
  /** True totals, counted before any clip. */
  added: number;
  removed: number;
  /** Nothing lined up: both sides are shown whole. */
  wholeFile: boolean;
  /** Lines the clip left out. `0` draws no note. */
  omitted: number;
  /**
   * There is no honest diff to draw, and why.
   *
   * `hunks` is empty and the counts are 0 — which is why a caller must test this
   * rather than the counts, or "we cannot say" renders as "nothing changed".
   */
  unavailable: "truncated" | null;
}

const EMPTY: FileDiff = {
  hunks: [],
  added: 0,
  removed: 0,
  wholeFile: false,
  omitted: 0,
  unavailable: null,
};

/**
 * A file change as hunks, counted and bounded.
 *
 * `startLine` is where the *fragment* sits in the file, and it is applied to both
 * sides. That is exact for one contiguous replacement — which is what a fragment
 * is — and it is the only case where it is claimed: a whole-file diff starts at 1
 * anyway, and a creation has no old side to be wrong about. The number comes from
 * the tool call's own `locations[0].line`, measured to be the hunk's new start.
 */
export function diffLines(oldText: string | null, newText: string, startLine = 1): FileDiff {
  if (TRUNCATION_MARKER.test(newText) || (oldText !== null && TRUNCATION_MARKER.test(oldText))) {
    return { ...EMPTY, unavailable: "truncated" };
  }

  const before = oldText === null ? [] : splitLines(oldText);
  const after = splitLines(newText);
  const base = Math.max(1, Math.floor(startLine));

  // A creation, and the majority case in the log: no old side, so no alignment to
  // look for and no LCS to run.
  if (before.length === 0) {
    return assemble(
      after.map((text, i) => line("add", null, base + i, text)),
      after.length,
      0,
      false,
    );
  }

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);

  const aligned =
    midBefore.length > 0 &&
    midAfter.length > 0 &&
    midBefore.length * midAfter.length <= MAX_LCS_CELLS
      ? alignLines(midBefore, midAfter)
      : null;

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  for (let i = 0; i < head; i += 1) {
    lines.push(line("same", base + i, base + i, before[i] ?? ""));
  }

  if (aligned === null) {
    // One replacement block. Either nothing aligned at all, or aligning it would
    // cost more than the budget allows — and a caller cannot tell those apart from
    // the hunks, which is what `wholeFile` is for.
    for (let i = 0; i < midBefore.length; i += 1) {
      lines.push(line("del", base + head + i, null, midBefore[i] ?? ""));
    }
    for (let i = 0; i < midAfter.length; i += 1) {
      lines.push(line("add", null, base + head + i, midAfter[i] ?? ""));
    }
    removed += midBefore.length;
    added += midAfter.length;
  } else {
    let oldNo = base + head;
    let newNo = base + head;
    for (const op of aligned) {
      if (op.kind === "same") {
        lines.push(line("same", oldNo, newNo, op.text));
        oldNo += 1;
        newNo += 1;
        continue;
      }
      if (op.kind === "del") {
        lines.push(line("del", oldNo, null, op.text));
        oldNo += 1;
        removed += 1;
        continue;
      }
      lines.push(line("add", null, newNo, op.text));
      newNo += 1;
      added += 1;
    }
  }

  const tailStartOld = before.length - tail;
  const tailStartNew = after.length - tail;
  for (let i = 0; i < tail; i += 1) {
    lines.push(
      line("same", base + tailStartOld + i, base + tailStartNew + i, before[tailStartOld + i] ?? ""),
    );
  }

  markPairs(lines);
  /*
   * "Nothing lined up", and the test is the *result* rather than whether the LCS
   * ran. Keyed on `aligned === null` it answered `false` for two lines replaced by
   * two others — small enough to be inside the budget, so the pass ran, found no
   * common line, and produced exactly the all-removed-then-all-added block that
   * this flag exists to describe.
   */
  const nothingAligned = aligned === null || !aligned.some((op) => op.kind === "same");
  return assemble(lines, added, removed, head === 0 && tail === 0 && nothingAligned);
}

/**
 * How many lines a change added and removed, cached for the life of the tab.
 *
 * `buildTail` re-derives every node on **every streamed token**, and it reads this
 * to build a run's `+N −M`. Computing a diff there would put an O(n·m) pass on the
 * transcript's hot path, so the answer is memoised against the event itself: a
 * `StoredEvent` is never mutated, so its identity is a sound key, and a `WeakMap`
 * keeps that from being a leak. One diff per event, ever.
 *
 * `null` means the event arrived truncated — the counts are unknown, not zero, and
 * a caller that reads `?? 0` would report a large edit as an empty one. That is
 * the `?? 0` mistake this repository has already made once, on the worktree
 * counts.
 */
const COUNTS = new WeakMap<FileChangeEvent, { added: number; removed: number } | null>();

export function changeCounts(event: FileChangeEvent): { added: number; removed: number } | null {
  const cached = COUNTS.get(event);
  if (cached !== undefined) return cached;
  const diff = diffLines(event.oldText, event.newText);
  const counts =
    diff.unavailable !== null ? null : { added: diff.added, removed: diff.removed };
  COUNTS.set(event, counts);
  return counts;
}

/** Both counts of a whole run, with `null` for any change that could not be read. */
export function totalCounts(
  events: readonly FileChangeEvent[],
): { added: number; removed: number; unknown: number } {
  let added = 0;
  let removed = 0;
  let unknown = 0;
  for (const event of events) {
    const counts = changeCounts(event);
    if (counts === null) {
      unknown += 1;
      continue;
    }
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed, unknown };
}

/**
 * `"a\nb"` is two lines and `"a\n"` is one.
 *
 * A trailing newline is a line *terminator*, not an empty final line, so
 * splitting on it naively gives every file an extra blank line at the end — which
 * then shows up in a diff as an added or removed line that nobody wrote. A file
 * that genuinely ends in a blank line ends `"\n\n"` and keeps it.
 *
 * `""` is **no lines**, not one empty one, and that arm is load-bearing: codex
 * reports a deleted file as `newText: ""`, so without it a delete reads as "N
 * lines replaced by one blank line" — `+1 −N` for an act that added nothing.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function line(kind: DiffLine["kind"], oldNo: number | null, newNo: number | null, text: string): DiffLine {
  return { kind, oldNo, newNo, text, marks: null };
}

/**
 * Keep the changed lines and the context around them, and split where the
 * unchanged stretch between two changes is longer than the context they each
 * bring.
 */
function assemble(lines: readonly DiffLine[], added: number, removed: number, wholeFile: boolean): FileDiff {
  const keep = new Array<boolean>(lines.length).fill(false);
  let changes = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === "same") continue;
    changes += 1;
    for (let j = Math.max(0, i - DIFF_CONTEXT); j <= Math.min(lines.length - 1, i + DIFF_CONTEXT); j += 1) {
      keep[j] = true;
    }
  }
  if (changes === 0) return { ...EMPTY, wholeFile };

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let drawn = 0;
  let omitted = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const row = lines[i];
    if (row === undefined) continue;
    if (!keep[i]) {
      if (current.length > 0) {
        hunks.push({ lines: current });
        current = [];
      }
      continue;
    }
    if (drawn >= DIFF_MAX_LINES) {
      // Counted, not drawn. The clip is about the height of the body; the totals
      // above it stay true.
      if (row.kind !== "same") omitted += 1;
      continue;
    }
    current.push(row);
    drawn += 1;
  }
  if (current.length > 0) hunks.push({ lines: current });

  return { hunks, added, removed, wholeFile, omitted, unavailable: null };
}

interface Op {
  kind: "same" | "add" | "del";
  text: string;
}

/**
 * Longest common subsequence over lines, as a list of operations.
 *
 * A plain O(n·m) table, bounded by the caller. Not a library and not Myers: the
 * input here is already the *interior* of a change, the budget caps it at a few
 * hundred lines a side, and Myers buys its speed on inputs this never sees.
 */
function alignLines(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", text: before[i] ?? "" });
      i += 1;
      j += 1;
      continue;
    }
    // Deletions first on a tie, so a replacement reads as "was, then is".
    if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ kind: "del", text: before[i] ?? "" });
      i += 1;
      continue;
    }
    ops.push({ kind: "add", text: after[j] ?? "" });
    j += 1;
  }
  for (; i < n; i += 1) ops.push({ kind: "del", text: before[i] ?? "" });
  for (; j < m; j += 1) ops.push({ kind: "add", text: after[j] ?? "" });
  return ops;
}

/**
 * Mark what changed *inside* a line, where a removal and an addition line up.
 *
 * Paired by position within a contiguous run of removals followed by additions,
 * which is what a rewritten line looks like in the op list. Only within a run: an
 * addition three lines below an unrelated deletion is not a modification of it,
 * and drawing it as one would invent a relationship.
 *
 * Prefix/suffix rather than a character LCS. It is the same trim as the line
 * level, it is exact for the ordinary case (a value, a word or an argument
 * replaced), and it degrades to "the whole line" — which is the honest answer and
 * also what happens when the pair shares nothing.
 */
function markPairs(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== "del") {
      i += 1;
      continue;
    }
    let dels = i;
    while (lines[dels]?.kind === "del") dels += 1;
    let adds = dels;
    while (lines[adds]?.kind === "add") adds += 1;
    const pairs = Math.min(dels - i, adds - dels);
    for (let k = 0; k < pairs; k += 1) {
      const removed = lines[i + k];
      const added = lines[dels + k];
      if (removed === undefined || added === undefined) continue;
      if (removed.text.length > MAX_MARK_CHARS || added.text.length > MAX_MARK_CHARS) continue;
      const span = innerSpan(removed.text, added.text);
      if (span === null) continue;
      lines[i + k] = { ...removed, marks: [[span.oldFrom, removed.text.length - span.tail]] };
      lines[dels + k] = { ...added, marks: [[span.newFrom, added.text.length - span.tail]] };
    }
    i = adds > i ? adds : i + 1;
  }
}

function innerSpan(
  removed: string,
  added: string,
): { oldFrom: number; newFrom: number; tail: number } | null {
  let head = 0;
  while (head < removed.length && head < added.length && removed[head] === added[head]) head += 1;
  let tail = 0;
  while (
    tail < removed.length - head &&
    tail < added.length - head &&
    removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  ) {
    tail += 1;
  }
  // Nothing in common at either end: the whole line is the change, and a mark
  // covering all of it says less than no mark at all.
  if (head === 0 && tail === 0) return null;
  // And the same judgement by degree rather than absolutely — see `MAX_MARK_SHARE`.
  const share = (line: string): number => (line.length - head - tail) / Math.max(1, line.length);
  if (share(removed) > MAX_MARK_SHARE || share(added) > MAX_MARK_SHARE) return null;
  return { oldFrom: head, newFrom: head, tail };
}
