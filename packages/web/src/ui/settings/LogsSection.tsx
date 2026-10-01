import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { daemonLog, daemonState, inNativeShell } from "../../native";
import { Empty } from "../bits";
import { CopyButton } from "../kit/CopyButton";
import { Group } from "../kit/List";
import { Pending } from "../kit/Status";

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
    // `still`: the box holds output to read, not a control, so it takes the hairline.
    <Group
      title="This computer’s daemon"
      count={lines.length > 0 ? `last ${lines.length} lines` : undefined}
      action={lines.length > 0 ? <CopyButton value={lines.join("\n")} label="the daemon’s output" /> : undefined}
      still
    >
      {!native ? (
        <Empty>The daemon&rsquo;s output is on the computer it runs on. Open Reemoat there to read it.</Empty>
      ) : !read ? (
        <div className="px-4">
          <Pending>Reading the daemon’s output…</Pending>
        </div>
      ) : lines.length === 0 ? (
        <Empty failed={status === "exited"}>{nothingHere(status, stranger)}</Empty>
      ) : (
        // No Clear: an empty ring tells `host_daemon_state` nothing was ever started here.
        <pre
          ref={paneRef}
          onScroll={(event) => {
            following.current = followsTail(event.currentTarget);
          }}
          className="max-h-[60vh] overflow-auto overscroll-contain rounded-lg p-3 font-mono text-2xs whitespace-pre-wrap wrap-anywhere text-fg/80"
        >
          {lines.join("\n")}
        </pre>
      )}
    </Group>
  );
}

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
