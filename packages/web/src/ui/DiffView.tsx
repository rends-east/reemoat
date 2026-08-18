import { useMemo, type ReactNode } from "react";
import { diffLines, totalCounts, type DiffLine, type Mark } from "../diff";
import type { FileChangeEvent } from "../wire";
import { Badge, shortPath } from "./bits";

/**
 * A file change, drawn.
 *
 * One component, two callers, and that is the point of the file: it was inside
 * `PermissionCard` serving the approval card alone, so the transcript — which is
 * where a change is *read* rather than authorised — drew a path and nothing else.
 * `AskCard` is the precedent for sharing a component rather than resembling one.
 *
 * The consequence of sharing is that the approval card gained line numbers, hunks
 * and colour in the same change. That is deliberate: the two are the same object
 * before and after the fact, and letting them drift is how the second one ends up
 * worse.
 */
export function DiffView({
  change,
  startLine = 1,
}: {
  change: FileChangeEvent;
  /**
   * Where the fragment sits in the file, joined to this change **by path** — one
   * call can change several files, and taking the first location for all of them
   * numbered file B's diff from file A's line.
   *
   * Measured for claude, where a post-edit update's `locations[].line` is
   * `structuredPatch`'s `newStart`. **Unmeasured for codex**, which sends whole
   * files rather than fragments: if it ever reports a line there, every number in
   * the diff would be shifted by it. The caller falls back to 1 when no location
   * names this file, which is what a whole-file change gets today.
   */
  startLine?: number;
}): ReactNode {
  const diff = useMemo(
    () => diffLines(change.oldText, change.newText, startLine),
    [change, startLine],
  );

  return (
    // `rounded-md`, not a bare `rounded`. `index.css` declares exactly four radius
    // tokens and none of them is Tailwind's own default — that only *happened* to
    // equal `rounded-sm` here, so five boxes on the approval card were naming a
    // value the palette does not contain and matching the ones beside them by luck.
    <div className="overflow-hidden rounded-md border border-edge bg-raised">
      <div className="flex items-center gap-2 border-b border-edge px-2 py-1">
        {/* **The last two segments, not the whole absolute path.** This header has
            the tightest budget of the three places a path is drawn — about 27
            characters — and every session runs under `~/.reemoat/worktrees/…`,
            which is 32 characters of prefix before the session directory even
            starts. `truncate` clips the tail, so the reader got
            `/Users/rends/.reemoat/worktr` and nothing that identifies the file.

            `shortPath` rather than `EventList`'s `rel ?? path`, because this
            component is shared with the approval card and has no `FileAccess` to
            ask — and at this width the last two segments are what fits anyway. */}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted">
          {shortPath(change.path)}
        </span>
        <ChangeCounts events={[change]} />
        {change.oldText === null && <Badge>new</Badge>}
      </div>

      {diff.unavailable !== null ? (
        /*
         * The one thing that must not be drawn as a diff.
         *
         * A `file_change` over the 128 KiB per-event cap has each side clipped to
         * half of it, so both are cut at the same offset and the common suffix is
         * destroyed — a diff over them would report the untouched tail of the file
         * as rewritten. "Cannot say" and "nothing changed" are different sentences.
         */
        <p className="px-2 py-1.5 text-2xs text-faint">
          this change was too large to keep in the log, so there is no diff to show
        </p>
      ) : diff.hunks.length === 0 ? (
        /*
         * A write that changed nothing, which is a real thing an agent does — and
         * without this arm it was a framed, empty `<pre>` under a path, on a card
         * `opensToAnything` had just made openable *because* there was a change. A
         * sentence is the honest content; an empty box reads as a rendering failure.
         */
        <p className="px-2 py-1.5 text-2xs text-faint">
          the file was written with no change to its contents
        </p>
      ) : (
        <>
          {/*
           * `bg-surface` inside a `bg-raised` frame, and measured rather than
           * chosen: the add/del tints are 1.034 and 1.010 against `raised`, i.e.
           * invisible, and 1.184 and 1.211 against `surface`. The frame keeps
           * `raised` so the box still has an edge of its own — the same split the
           * tool card makes for the well its child steps sit in.
           *
           * **No `whitespace-pre-wrap`.** Code that soft-wraps at a phone's width
           * reads as a different file, so a long line scrolls sideways inside this
           * box instead — which is also why the box is the one that scrolls and
           * not the page.
           */}
          {/* `overscroll-x-contain`: a long line dragged past its end must not hand
              the gesture to the page behind it. `contain` rather than `none` so the
              box keeps its own bounce, which is what says the line has ended. */}
          <pre className="max-h-56 overflow-auto overscroll-x-contain bg-surface font-mono text-2xs leading-snug">
            <div className="w-max min-w-full">
              {diff.hunks.map((hunk, index) => (
                <div key={index}>
                  {/* A rule rather than an `@@ -a,b +c,d @@` header: the line
                      numbers are already in the gutter, so the header would be the
                      same four numbers in a notation that has to be learned. */}
                  {index > 0 && <div className="h-px bg-edge" />}
                  {hunk.lines.map((line, i) => (
                    <Row key={i} line={line} created={change.oldText === null} />
                  ))}
                </div>
              ))}
            </div>
          </pre>
          {diff.omitted > 0 && (
            <p className="border-t border-edge px-2 py-1 text-2xs text-faint">
              … {diff.omitted} more changed line{diff.omitted === 1 ? "" : "s"}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Row({ line, created }: { line: DiffLine; created: boolean }): ReactNode {
  const tint = line.kind === "add" ? "bg-add" : line.kind === "del" ? "bg-del" : "";
  const sigil = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <div className={`flex ${tint}`}>
      {/*
       * Two columns, so a line's place in *both* files is readable — which is what
       * makes an addition and a modification tell themselves apart without reading
       * the text. Empty on the side the line does not exist in.
       *
       * **Except on a created file, where the old side is empty on every row** and
       * the column is 40px of guaranteed blank. That is expensive here in a way it
       * is nowhere else: the fixed chrome is already 95px of a box measured at
       * 312px for the common case — a diff inside an expanded card inside a folded
       * run — so the blank gutter is ~13% of the width, about five characters of
       * code, on the phone this is read from. The branch is not a new judgement:
       * `oldText === null` is the same test the header two blocks up already makes
       * to draw its `new` badge, and the pairing it distinguishes cannot arise,
       * because a created file has no old line for an addition to be paired with.
       */}
      {!created && <Gutter value={line.oldNo} />}
      <Gutter value={line.newNo} />
      <span
        className={`shrink-0 px-1 select-none ${
          line.kind === "add" ? "text-add-ink" : line.kind === "del" ? "text-del-ink" : "text-faint"
        }`}
      >
        {sigil}
      </span>
      {/* `text-fg` on a tinted line and `text-muted` on context: the tint says
          which kind of line this is, and the text stays at the contrast the palette
          measured for it. Nothing rests on hue. */}
      <span className={line.kind === "same" ? "text-muted" : "text-fg"}>
        {marked(line.text, line.marks, line.kind)}
      </span>
    </div>
  );
}

function Gutter({ value }: { value: number | null }): ReactNode {
  return (
    // `min-w-10` rather than a character count: the gutter has to hold still between
    // a two-digit line and a four-digit one, or every line of the body shifts as the
    // reader scrolls past line 1000.
    <span className="min-w-10 shrink-0 px-1 text-right tabular-nums text-faint select-none">
      {value ?? ""}
    </span>
  );
}

/**
 * The changed run inside a rewritten line, at a stronger grade of the same tint.
 *
 * Drawn only where the line is *paired* with one on the other side — `marks` is
 * `null` otherwise, because an inserted line is not a modified one and marking all
 * of it would say the opposite of what happened.
 */
function marked(text: string, marks: readonly Mark[] | null, kind: DiffLine["kind"]): ReactNode {
  if (marks === null || marks.length === 0) return text;
  const tint = kind === "add" ? "bg-add-ink/20" : "bg-del-ink/20";
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of marks) {
    // An empty range is the ordinary outcome of a pure insertion on the other
    // side, and drawing a zero-width mark would be a stray box.
    if (end <= start) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <span key={start} className={tint}>
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  if (parts.length === 0) return text;
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * `+N −M` for one change or a whole run.
 *
 * Four call sites want this — a group's summary row, a tool card's row, a
 * standalone change row and this file's own header — so the counting and the
 * wording live here once. The numbers come from `changeCounts`, which memoises per
 * event, so asking repeatedly costs nothing.
 *
 * `unknown` is not folded into the numbers: a change the log could not keep is
 * neither an addition nor a deletion, and adding zero for it would state that a
 * large edit changed nothing.
 */
export function ChangeCounts({ events }: { events: readonly FileChangeEvent[] }): ReactNode {
  // Through `totalCounts` rather than a loop of its own: this had the accumulation
  // written out a second time, which is the duplication this change's own note in
  // `permission.ts` argues against, one file over.
  const { added, removed, unknown } = totalCounts(events);
  if (added === 0 && removed === 0 && unknown === 0) return null;
  return (
    <span className="shrink-0 font-mono text-2xs tabular-nums">
      {(added > 0 || removed > 0) && (
        <>
          <span className="text-add-ink">+{added}</span>{" "}
          <span className="text-del-ink">−{removed}</span>
        </>
      )}
      {unknown > 0 && <span className="pl-1 text-faint">+? −?</span>}
    </span>
  );
}
