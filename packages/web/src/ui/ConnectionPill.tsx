import { Shield } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MachineId, SessionKey } from "../ids";
import { controlPlaneOrigin } from "../native";
import { SERVER_NAMED_AFTER_MS } from "../reach";
import { serverLabel } from "../slot";
import type { AppState } from "../store";
import { monotonicNow } from "../wake";
import { Icon } from "./bits";
import {
  connectionSpell,
  opensByItself,
  TROUBLE_MIN_SHOWN_MS,
  troubleDue,
  troubleLive,
  troubleShown,
  troubleSince,
  troubleWords,
  type Trouble,
} from "./connection";
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
  silent = false,
}: {
  state: AppState;
  /** The conversation on screen, whose machine and stream this screen reads. */
  openKey: SessionKey | null;
  machines: "all" | readonly MachineId[];
  /** Whole class strings for where it floats; it displaces nothing. */
  placement: string;
  style?: CSSProperties;
  /** This screen's body already names what is unreachable: one place says it. */
  silent?: boolean;
}): ReactNode {
  const row = openKey === null ? undefined : state.rowsByKey.get(openKey);
  // Every wait here is on the monotonic clock, as each cause's own start is; the timer below renders again at the next one.
  const [turn, setTurn] = useState(0);
  const at = monotonicNow();
  const spell = silent
    ? null
    : connectionSpell(
        state,
        {
          machines,
          open: row === undefined ? null : { machine: row.ref.machineId, stream: state.transcripts.get(row.key)?.stream ?? null },
        },
        at,
      );
  const trouble = spell?.trouble ?? null;

  const seen = useRef<number | null>(null);
  seen.current = troubleSince(seen.current, spell !== null, at);
  const due = spell === null || seen.current === null ? null : troubleDue(spell, seen.current);
  // Whether the trouble on screen is this spell's own, and not the last one's kept through its minimum.
  const drawing = useRef(false);
  const live = troubleLive(due, drawing.current, at);
  drawing.current = live;
  const shownAt = useRef<number | null>(null);
  // Where the body speaks the pill leaves at once, minimum or not: one place says it.
  const shown = !silent && troubleShown(live, shownAt.current, at);
  shownAt.current = shown ? (shownAt.current ?? at) : null;
  const naming = state.server.state === "unreachable" && state.server.since !== null ? state.server.since + SERVER_NAMED_AFTER_MS : null;
  const next = [live ? null : due, shown && !live && shownAt.current !== null ? shownAt.current + TROUBLE_MIN_SHOWN_MS : null, naming]
    .filter((wait): wait is number => wait !== null && wait > at)
    .reduce<number | null>((first, wait) => (first === null || wait < first ? wait : first), null);
  useEffect(() => {
    if (next === null) return;
    const timer = window.setTimeout(() => setTurn((count) => count + 1), Math.max(0, next - monotonicNow()));
    return () => window.clearTimeout(timer);
    // `turn` too: a timer that fires a hair early leaves `next` as it was, and has to be set again.
  }, [next, turn]);

  // The words stay through the exit, after the trouble that named them has cleared.
  const said = useRef<Trouble | null>(null);
  if (live && trouble !== null) said.current = trouble;
  const drawn = said.current;
  const words = drawn === null ? "" : troubleWords(drawn, serverLabel(controlPlaneOrigin()));

  // Null leaves it to the stylesheet: folded, and open by itself under a finger for a cause somebody acts on (Q3.710).
  const [choice, setChoice] = useState<"open" | "folded" | null>(null);
  useEffect(() => {
    if (!shown) setChoice(null);
  }, [shown]);
  const wordsBox = useRef<HTMLSpanElement | null>(null);
  const cols =
    choice === "open"
      ? "grid-cols-[1fr]"
      : choice === "folded" || drawn === null || !opensByItself(drawn)
        ? "grid-cols-[0fr]"
        : "grid-cols-[0fr] [@media(pointer:coarse)]:grid-cols-[1fr]";
  const { shown: mounted, leaving, onAnimationEnd } = useLeaving(shown, PILL_EXIT_MS);

  return (
    <>
      {/* Mounted for good and changed only when the words do, so a spell is announced once and a retry never is. */}
      <p role="status" aria-live="polite" className="sr-only">
        {shown ? words : ""}
      </p>
      {mounted && drawn !== null && (
        <div className={`pointer-events-none absolute z-10 ${placement} right-3 flex`} style={style}>
          <button
            type="button"
            aria-expanded={choice === null ? undefined : choice === "open"}
            aria-label={words}
            title={words}
            // A finger has no hover: a tap folds the words or opens them. What is drawn now is the stylesheet's answer, read at the tap.
            onClick={() => setChoice((wordsBox.current?.offsetWidth ?? 0) > 0 ? "folded" : "open")}
            onAnimationEnd={onAnimationEnd}
            // 36px drawn, as Telegram's is, and 44px under a finger.
            className={`group pointer-events-auto relative flex h-9 max-w-full min-w-0 items-center rounded-full border border-edge bg-surface text-muted shadow-lg [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] ${
              leaving ? "animate-rise-out" : "animate-rise"
            }`}
          >
            <span className="flex aspect-square h-full shrink-0 items-center justify-center" aria-hidden="true">
              <span className="block h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-fg" />
            </span>
            <span
              className={`grid min-w-0 transition-[grid-template-columns] duration-200 ease-out ${cols} pointer-fine:group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr]`}
            >
              {/* The padding is inside the clipped box, or a folded column keeps it and the circle grows a tail. */}
              <span ref={wordsBox} className="min-w-0 overflow-hidden">
                <span className="flex items-center gap-2 pr-3 text-xs">
                  {/* A long host is cut with an ellipsis rather than by the window's edge; the whole of it is the title. */}
                  <span className="truncate">{words}</span>
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
