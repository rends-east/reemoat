import { Shield } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MachineId, SessionKey } from "../ids";
import type { AppState } from "../store";
import { Icon } from "./bits";
import { connectionTrouble, TROUBLE_GRACE_MS, troubleShown, troubleSince, troubleWords, type Trouble } from "./connection";
import { useLeaving } from "./leaving";

/** `animate-rise-out`'s own 140ms: the backstop is the exit, not the wait. */
export const PILL_EXIT_MS = 140;

// The one place connection trouble is drawn: a circle at the bottom-left that opens into words, never a banner (Q3.659).
export function ConnectionPill({
  state,
  openKey,
  machines,
  placement,
  style,
}: {
  state: AppState;
  /** The conversation on screen, whose machine and stream this screen reads. */
  openKey: SessionKey | null;
  machines: "all" | readonly MachineId[];
  /** Whole class strings for where it floats; it displaces nothing. */
  placement: string;
  style?: CSSProperties;
}): ReactNode {
  const row = openKey === null ? undefined : state.rowsByKey.get(openKey);
  const trouble = connectionTrouble(state, {
    machines,
    open: row === undefined ? null : { machine: row.ref.machineId, stream: state.transcripts.get(row.key)?.stream ?? null },
  });

  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const troubled = trouble !== null;
  useEffect(() => {
    setSince((previous) => troubleSince(previous, troubled, Date.now()));
  }, [troubled]);
  useEffect(() => {
    if (since === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, since + TROUBLE_GRACE_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [since]);
  const shown = troubled && troubleShown(since, now);

  // The words stay through the exit, after the trouble that named them has cleared.
  const said = useRef<Trouble | null>(null);
  if (shown && trouble !== null) said.current = trouble;
  const drawn = said.current;
  const words = drawn === null ? "" : troubleWords(drawn);

  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!shown) setExpanded(false);
  }, [shown]);
  const { shown: mounted, leaving, onAnimationEnd } = useLeaving(shown, PILL_EXIT_MS);

  return (
    <>
      {/* Mounted for good and changed only when the words do, so a spell is announced once and a retry never is. */}
      <p role="status" aria-live="polite" className="sr-only">
        {shown ? words : ""}
      </p>
      {mounted && drawn !== null && (
        <div className={`pointer-events-none absolute z-10 ${placement}`} style={style}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={words}
            title={words}
            // A finger has no hover: a tap opens the words and a second tap folds them.
            onClick={() => setExpanded(!expanded)}
            onAnimationEnd={onAnimationEnd}
            // 36px drawn, as Telegram's is, and 44px under a finger.
            className={`group pointer-events-auto relative flex h-9 items-center rounded-full border border-edge bg-surface text-muted shadow-lg [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] ${
              leaving ? "animate-rise-out" : "animate-rise"
            }`}
          >
            <span className="flex aspect-square h-full shrink-0 items-center justify-center" aria-hidden="true">
              <span className="block h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-fg" />
            </span>
            <span
              className={`grid transition-[grid-template-columns] duration-200 ease-out ${
                expanded ? "grid-cols-[1fr]" : "grid-cols-[0fr]"
              } pointer-fine:group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr]`}
            >
              {/* The padding is inside the clipped box, or a folded column keeps it and the circle grows a tail. */}
              <span className="min-w-0 overflow-hidden">
                <span className="flex items-center gap-2 pr-3 text-xs whitespace-nowrap">
                  {words}
                  {/* Only a stream down the relay is end-to-end encrypted; the server and loopback are not (e2ee.md). */}
                  {drawn.kind === "connecting" && drawn.e2ee && <Icon as={Shield} size={16} className="text-faint" />}
                </span>
              </span>
            </span>
          </button>
        </div>
      )}
    </>
  );
}
