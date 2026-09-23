import { useEffect, useRef, useState, type ReactNode } from "react";
import { daemonLog, daemonState, inNativeShell } from "../../native";
import { Button, Empty, SETTINGS_HEADING, Spinner } from "../bits";
import { copyText } from "../clipboard";
import { toast } from "../Toast";

/**
 * How often the screen asks again while it is open.
 *
 * Two seconds rather than the setup flow's one: nothing here is waiting on a
 * state change, somebody is reading. And it is a poll rather than a stream
 * because the host has no event channel — `lib.rs` registers commands and
 * nothing emits — so a push would be a whole second mechanism for one screen.
 */
const LOG_POLL_MS = 2_000;

/**
 * How close to the bottom counts as *following*.
 *
 * ⚠ **Without it a poll steals the scroll from somebody reading.** The pane is
 * pinned to the newest line while it is already there, and left alone the moment
 * it is not — the alternative, scrolling on every tick, yanks a stack trace out
 * from under the reader every two seconds. Pixels, and generous: a line is about
 * sixteen tall, so this is "within a line or two".
 */
const FOLLOW_SLACK = 32;

/**
 * What the daemon on this computer has printed.
 *
 * ⚠ **This screen exists because a listing left another one** (owner's call,
 * 2026-09-15). `SetupNotice` in the session rail drew the daemon's last two
 * hundred lines verbatim under the sentence "This computer could not be set up."
 * — program output in the one place somebody is trying to read prose, on a rail
 * whose subject is their sessions. The *sentence* stayed there and names this
 * screen; the output came here. Neither half works alone: the notice with no
 * pointer re-creates the failure it was added to prevent (a cause sitting in a
 * string nothing renders), and this screen with no notice is a log nobody knows
 * to open.
 *
 * ⚠ **One ring, from one daemon, and the screen says which rather than pretending
 * otherwise.** It is the child *this app* spawned on *this* computer. It is not
 * the fleet's logs and not a machine picker: a daemon `deploy/install.sh`
 * installed is somebody else's child with no pipe to this process, and a machine
 * across the relay serves no log route at all (`src/server.ts` has none, by
 * decision). An empty scroller under a machine dropdown would be a screen
 * promising four things it can answer one of, so the empty states are the
 * deliverable here and not a detail.
 *
 * ⚠ **Not a reversal of Q3.225**, which removed the *delivery log* from Server
 * settings as noise. That log answered a question nobody was asking on a screen
 * people go to in order to configure things, and the one person who needed it had
 * a terminal. This is the output of a process the app itself spawns, supervises
 * and hides — the person it is for has no terminal *by construction*, because the
 * whole point of the desktop app is that they never opened one.
 */
export function LogsSection(): ReactNode {
  const native = inNativeShell();
  const [lines, setLines] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  /** `DaemonState.stranger`: the daemon behind `status` enrolled with another control plane. */
  const [stranger, setStranger] = useState(false);
  /** Whether the first answer has landed. `true` in a browser: there is nothing to wait for. */
  const [read, setRead] = useState(!native);
  const paneRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const ask = async (): Promise<void> => {
      /*
       * Both, together, because the empty state is a *pair*: the lines say what
       * was printed and the status says whose daemon is running here, and "no
       * lines" means something different under `foreign` than under `exited`.
       * Concurrent rather than sequential — neither answer depends on the other,
       * and this is on a two-second timer.
       */
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

  useEffect(() => {
    const pane = paneRef.current;
    if (pane === null) return;
    /*
     * Measured *before* the paint that appended, which is why `following` is
     * computed against the previous scroll height: after React has written the
     * new lines, "am I at the bottom" is already false for a pane that was.
     * React runs layout effects after the DOM is updated, so this reads the new
     * height and the old `scrollTop` — which is exactly the comparison wanted.
     */
    const following = pane.scrollHeight - pane.scrollTop - pane.clientHeight < FOLLOW_SLACK + 1;
    if (following) pane.scrollTop = pane.scrollHeight;
  }, [lines]);

  return (
    // No padding of its own: `Settings.tsx` gives the column `px-4 py-4 sm:px-5`,
    // and a second one here insets the content twice. `MachinesSection` states it.
    <div>
      <section>
        <div className="flex items-baseline gap-2">
          {/* First section on the screen, so `SETTINGS_HEADING` alone — a rule
              above the first thing on a page is a line under the title. */}
          <h2 className={SETTINGS_HEADING}>This computer&rsquo;s daemon</h2>
          {lines.length > 0 && <span className="text-2xs text-faint">last {lines.length} lines</span>}
        </div>

        <div className="mt-3">
          {!native ? (
            /*
             * ⚠ **A sentence rather than nothing, and it names the app.** The
             * browser arm is structurally dead — there is no bridge to ask, for
             * ever — and rendering nothing is worse twice over, which is the
             * argument `LocalPath` already makes one screen along: somebody
             * reading on their phone gets a screen with no trace of the feature
             * and no way to tell whether their fleet has it, and `pnpm web` stops
             * being able to exercise the screen at all.
             */
            <Empty>The daemon&rsquo;s output is on the computer it runs on. Open Reemoat there to read it.</Empty>
          ) : !read ? (
            <Spinner />
          ) : lines.length === 0 ? (
            <Empty failed={status === "exited"}>{nothingHere(status, stranger)}</Empty>
          ) : (
            <>
              {/*
               * Program output, so mono — `web-typography.md`'s rule, and the
               * reason a stack trace stays readable instead of being reflowed
               * into a paragraph. `overscroll-contain` because the pane behind
               * this is already a scroller and a nested one that chains ends up
               * scrolling the sheet out from under a thumb.
               */}
              <pre
                ref={paneRef}
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
                {/*
                 * ⚠ **No "Clear".** The ring is the only evidence there is of a
                 * daemon that has already exited, and `host_daemon_state` reads
                 * its emptiness as *nothing was ever started here* — so a button
                 * that emptied it would not tidy the screen, it would tell the
                 * setup flow a different story about the computer.
                 */}
                <span className="text-2xs text-faint">{FOOTNOTE}</span>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * The bound, said once, where somebody reading a truncated log would ask.
 *
 * `LOG_LINES` in `packages/native/src-tauri/src/daemon.rs` is the number and this
 * is a sentence about it rather than a second copy: it says *that* there is a
 * bound and that nothing is on disk, which stays true if the host changes it.
 */
const FOOTNOTE = "A ring in memory, not a file — it starts empty at every launch.";

/**
 * Why there is nothing to show, from the state the daemon is in.
 *
 * ⚠ **Four absences that are one empty list and must not be one sentence.** The
 * host answers `[]` for all of them on purpose — it reports what *this app's*
 * child said, and it does not invent a distinction the ring cannot make — so the
 * distinction is drawn here, from `status`, which the same poll already has.
 *
 * `foreign` is the one worth the extra clause: a daemon installed by
 * `deploy/install.sh` is running perfectly and this screen is still empty, which
 * reads as a broken screen unless it says otherwise. Its output is where whatever
 * started it put it, and naming a path here would be this app guessing at another
 * installer's layout.
 *
 * ⚠ **Every one of these is about the server the app is on.** There is a daemon
 * per server now (Q7.148), and the ring shown is that server's child's — so a
 * sentence saying "the daemon on this computer" would be false beside another
 * server's daemon running perfectly, and `foreign` no longer means *installed
 * outside Reemoat*: a copy of Reemoat that is not this one, or a daemon started by
 * hand, is the same answer.
 *
 * ⚠ **Except a `stranger`, which is not this server's at all.** `~/.reemoat` is the
 * root of every daemon started without `REEMOAT_HOME`, so the one announced there
 * can be enrolled with another control plane, and "the daemon for this server"
 * would then be a false sentence about another fleet's. What is true is the empty
 * ring — nothing was started here for this server — and whose daemon was found.
 * Not "the one running here": this server's own daemon may be up as well, its
 * announcement written over by the stranger's, so the sentence may not imply
 * there is none.
 */
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
