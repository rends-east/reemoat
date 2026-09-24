import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { daemonLog, daemonState, inNativeShell } from "../../native";
import { Button, Empty, SETTINGS_HEADING, Spinner } from "../bits";
import { copyText } from "../clipboard";
import { toast } from "../Toast";

const LOG_POLL_MS = 2_000;

/** Pixels from the bottom that still count as following, so a poll does not steal the scroll. */
const FOLLOW_SLACK = 32;

/** Asked on scroll, never after a poll renders: by then the new lines have already moved the bottom away from a reader who was on it. */
export function followsTail(pane: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight < FOLLOW_SLACK + 1;
}

/** Only the ring of the daemon this app spawned here, not the fleet's; not a reversal of Q3.225. */
export function LogsSection(): ReactNode {
  const native = inNativeShell();
  const [lines, setLines] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  /** `DaemonState.stranger`: the daemon behind `status` enrolled with another control plane. */
  const [stranger, setStranger] = useState(false);
  const [read, setRead] = useState(!native);
  const paneRef = useRef<HTMLPreElement | null>(null);
  const following = useRef(true);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const ask = async (): Promise<void> => {
      const [said, state] = await Promise.all([daemonLog(), daemonState()]);
      if (cancelled) return;
      setLines(said);
      setStatus(state?.status ?? null);
      setStranger(state?.stranger === true);
      setRead(true);
    };
    void ask();
    const timer = setInterval(() => void ask(), LOG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [native]);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (pane !== null && following.current) pane.scrollTop = pane.scrollHeight;
  }, [lines]);

  return (
    // No padding: `Settings.tsx` already pads the column.
    <div>
      <section>
        <div className="flex items-baseline gap-2">
          <h2 className={SETTINGS_HEADING}>This computer&rsquo;s daemon</h2>
          {lines.length > 0 && <span className="text-2xs text-faint">last {lines.length} lines</span>}
        </div>

        <div className="mt-3">
          {!native ? (
            <Empty>The daemon&rsquo;s output is on the computer it runs on. Open Reemoat there to read it.</Empty>
          ) : !read ? (
            <Spinner />
          ) : lines.length === 0 ? (
            <Empty failed={status === "exited"}>{nothingHere(status, stranger)}</Empty>
          ) : (
            <>
              <pre
                ref={paneRef}
                onScroll={(event) => {
                  following.current = followsTail(event.currentTarget);
                }}
                className="max-h-[60vh] overflow-auto overscroll-contain rounded-md border border-edge bg-surface p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere text-fg/80"
              >
                {lines.join("\n")}
              </pre>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  onClick={() => {
                    void copyText(lines.join("\n")).then((ok) => {
                      toast(ok ? "ok" : "error", ok ? "Copied." : "Could not copy.");
                    });
                  }}
                >
                  Copy
                </Button>
                {/* No Clear: an empty ring tells `host_daemon_state` nothing was ever started here. */}
                <span className="text-2xs text-faint">{FOOTNOTE}</span>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

const FOOTNOTE = "A ring in memory, not a file — it starts empty at every launch.";

/** Four states share one empty list, so the sentence comes from `status`; every one is about this server (Q7.148). */
function nothingHere(status: string | null, stranger: boolean): string {
  switch (status) {
    case "running":
      return "The daemon is running and has printed nothing since it started.";
    case "foreign":
      return stranger
        ? "Reemoat has not started a daemon for this server on this computer, so it holds no output to show. The daemon it found here is for a different server, and whatever started that one has its output."
        : "The daemon for this server on this computer was not started by this copy of Reemoat, so Reemoat holds none of its output. Whatever started it has it.";
    case "exited":
      return "The daemon stopped without printing anything.";
    default:
      return "Reemoat has not started a daemon for this server on this computer yet.";
  }
}
