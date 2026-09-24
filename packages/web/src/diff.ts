/** One diff for the approval card and the transcript. Input is a fragment from claude but whole files from codex, hence a bounded LCS behind the trim. */

import type { FileChangeEvent } from "./wire";

const DIFF_CONTEXT = 2;

const DIFF_MAX_LINES = 60;

/** Cell budget for the O(n·m) LCS; past it the change is drawn as one replacement block. */
const MAX_LCS_CELLS = 250_000;

/** The longest pair of lines compared character by character. */
const MAX_MARK_CHARS = 400;

/** A mark covering more of the line than this says nothing the row tint does not. */
const MAX_MARK_SHARE = 0.6;

/** Mirrors the clip note appended in src/events.ts: clipped sides lose their common suffix, so no diff is drawn over them. */
const TRUNCATION_MARKER = /…\[truncated \d+ bytes\]$/;

export type Mark = readonly [start: number, end: number];

export interface DiffLine {
  kind: "same" | "add" | "del";
  /** 1-based, or `null` on a line that exists only on the other side. */
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** null when unpaired: an inserted line is not a modified one. */
  marks: readonly Mark[] | null;
}

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
  omitted: number;
  /** Test this rather than the counts, or "cannot say" renders as "nothing changed". */
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

/** startLine applies to both sides, which is exact for one contiguous fragment. */
export function diffLines(oldText: string | null, newText: string, startLine = 1): FileDiff {
  if (TRUNCATION_MARKER.test(newText) || (oldText !== null && TRUNCATION_MARKER.test(oldText))) {
    return { ...EMPTY, unavailable: "truncated" };
  }

  const before = oldText === null ? [] : splitLines(oldText);
  const after = splitLines(newText);
  const base = Math.max(1, Math.floor(startLine));

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
  // Tested on the result rather than on whether the LCS ran.
  const nothingAligned = aligned === null || !aligned.some((op) => op.kind === "same");
  return assemble(lines, added, removed, head === 0 && tail === 0 && nothingAligned);
}

/** Memoised per event because the transcript reads it on every streamed token. null means truncated, not zero. */
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

/** A trailing newline ends the last line rather than adding one, and an empty string is no lines (codex sends a delete as empty newText). */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function line(kind: DiffLine["kind"], oldNo: number | null, newNo: number | null, text: string): DiffLine {
  return { kind, oldNo, newNo, text, marks: null };
}

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
      // Counted, not drawn: the totals stay true.
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

/** Pairs removals with additions by position, only within one contiguous run. */
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
  if (head === 0 && tail === 0) return null;
  const share = (line: string): number => (line.length - head - tail) / Math.max(1, line.length);
  if (share(removed) > MAX_MARK_SHARE || share(added) > MAX_MARK_SHARE) return null;
  return { oldFrom: head, newFrom: head, tail };
}
