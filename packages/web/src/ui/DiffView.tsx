import { useMemo, type ReactNode } from "react";
import { diffLines, totalCounts, type DiffLine, type Mark } from "../diff";
import type { FileChangeEvent } from "../wire";
import { Badge, shortPath } from "./bits";

export function DiffView({
  change,
  startLine = 1,
}: {
  change: FileChangeEvent;
  /** First line of the fragment in its file, matched to this change by path; 1 when no location names it. */
  startLine?: number;
}): ReactNode {
  const diff = useMemo(
    () => diffLines(change.oldText, change.newText, startLine),
    [change, startLine],
  );

  return (
    <div className="overflow-hidden rounded-md border border-edge bg-raised">
      <div className="flex items-center gap-2 border-b border-edge px-2 py-1">
        {/* Last two segments only: the worktree prefix alone is wider than this header. */}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted">
          {shortPath(change.path)}
        </span>
        <ChangeCounts events={[change]} />
        {change.oldText === null && <Badge>new</Badge>}
      </div>

      {diff.unavailable !== null ? (
        // Both sides were clipped at the same offset, so a diff would show the untouched tail as rewritten.
        <p className="px-2 py-1.5 text-2xs text-faint">
          this change was too large to keep in the log, so there is no diff to show
        </p>
      ) : diff.hunks.length === 0 ? (
        <p className="px-2 py-1.5 text-2xs text-faint">
          the file was written with no change to its contents
        </p>
      ) : (
        <>
          {/* No soft wrap: wrapped code reads as a different file, so long lines scroll inside the box. */}
          <pre className="max-h-56 overflow-auto overscroll-x-contain bg-surface font-mono text-2xs leading-snug">
            <div className="w-max min-w-full">
              {diff.hunks.map((hunk, index) => (
                <div key={index}>
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
      {!created && <Gutter value={line.oldNo} />}
      <Gutter value={line.newNo} />
      <span
        className={`shrink-0 px-1 select-none ${
          line.kind === "add" ? "text-add-ink" : line.kind === "del" ? "text-del-ink" : "text-faint"
        }`}
      >
        {sigil}
      </span>
      <span className={line.kind === "same" ? "text-muted" : "text-fg"}>
        {marked(line.text, line.marks, line.kind)}
      </span>
    </div>
  );
}

function Gutter({ value }: { value: number | null }): ReactNode {
  return (
    // Fixed width so the body does not shift when line numbers gain a digit.
    <span className="min-w-10 shrink-0 px-1 text-right tabular-nums text-faint select-none">
      {value ?? ""}
    </span>
  );
}

function marked(text: string, marks: readonly Mark[] | null, kind: DiffLine["kind"]): ReactNode {
  if (marks === null || marks.length === 0) return text;
  const tint = kind === "add" ? "bg-add-ink/20" : "bg-del-ink/20";
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of marks) {
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

/** A change the log could not keep shows as +? −?, never folded into the counts as zero. */
export function ChangeCounts({ events }: { events: readonly FileChangeEvent[] }): ReactNode {
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
