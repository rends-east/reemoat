import { useEffect, useRef, useState, type ReactNode } from "react";
import { pluginDestination, pluginFailure, pluginPath, readView } from "../plugins";
import { refOf, sessionId, type MachineId } from "../ids";
import { navigate, sessionPath } from "../router";
import { store } from "../store";
import type { PluginOpen, PluginView as PluginViewShape } from "../wire";
import { Empty, Spinner } from "./bits";
import { PluginView } from "./PluginView";
import { Sheet } from "./Sheet";
import { toast } from "./Toast";

/**
 * A plugin's own screen, as a pop-up over whatever you were looking at.
 *
 * A **route-backed** sheet, like Settings: `/p/:machineId/:pluginId` deep-links,
 * survives a reload, and the phone's Back button closes it because the pop-up is
 * a route. It is not under `/settings` because it is not configuration — a board
 * is a thing somebody opens several times a day, and four taps into a settings
 * sheet is not where that goes.
 *
 * ⚠ **Nothing here is drawn before the plugin has answered.** There is no skeleton
 * board, no optimistic row and no locally-applied action: a plugin's view is the
 * plugin's assertion about its own state, and this client has no second copy of it
 * to guess from. Pressing something replaces the view with what came back, which
 * is why an action may return a whole view rather than only a sentence.
 */
export function PluginScreen({ machineId, pluginId }: { machineId: MachineId; pluginId: string }): ReactNode {
  const [view, setView] = useState<PluginViewShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Bumped to ask for a re-read. The interval lives in an effect keyed on the
   * *interval*, so a plugin that changes it between reads gets the new cadence
   * without the timer being rebuilt on every redraw — which it would be if the
   * effect depended on `view`.
   */
  const [round, setRound] = useState(0);
  const refreshMs = view?.refreshMs ?? null;
  /*
   * Which plugin the requests in flight were issued for, and how many view reads
   * are still out.
   *
   * Refs rather than state because nothing on screen reads either: a counter that
   * only decides whether a *timer* fires would, as state, redraw the whole board
   * twice per tick — on a sheet whose entire refresh discipline exists to stop it
   * flashing. `liveRoute` is the route rather than the two props because
   * `pluginPath` already makes the pair one unambiguous string, and it is written
   * from an effect rather than during render for `Composer`'s reason: a render
   * React discards must not be able to move it.
   */
  const liveRoute = useRef(pluginPath(machineId, pluginId));
  const reading = useRef(0);

  useEffect(() => {
    if (refreshMs === null) return;
    /*
     * **Only while somebody is looking.** Stopped when the tab goes to the
     * background, restarted when it comes back — a plugin must not be able to buy
     * background work on a phone by asking for a small number, and this sheet is
     * routinely left open behind a locked screen. `document.hidden` is checked at
     * each tick rather than through a `visibilitychange` listener, which would be
     * a second thing to unsubscribe.
     */
    const timer = setInterval(() => {
      if (document.hidden) return;
      /*
       * ⚠ **A tick that lands while a read is out is dropped, never queued.**
       * `round` moved on the clock alone, and nothing here cancels a request —
       * the effect's cleanup stops the answer being *drawn* and the work is done
       * anyway. So a plugin slower than its own `refreshMs` accumulated one read
       * per tick: at the 2 s floor against the daemon's 10 s call deadline that
       * is five concurrent `GET /plugins/:id/views/screen`, five relay streams
       * and five invocations against the one child, four of whose answers are
       * thrown away. Past eight in flight the daemon refuses with
       * `plugin_overloaded`, so a slow plugin had taught this screen to draw
       * errors it had caused itself.
       *
       * Dropping loses nothing: a poll is not a queue, and the skipped tick
       * would have asked the identical question. Dropping also keeps the cadence
       * on the plugin's own boundaries — rescheduling from each answer instead
       * would stretch the interval by however long the plugin took, which is the
       * plugin quietly choosing a number the host is supposed to clamp.
       */
      if (reading.current > 0) return;
      setRound((held) => held + 1);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  useEffect(() => {
    /*
     * Guarded on the pair, because this component is *not* remounted when the URL
     * moves from one plugin to another — the sheet stays and its props change. An
     * answer that arrives after the switch would draw one plugin's board under
     * another's name. Same rule `Composer` keeps with `liveKey`, one screen over.
     */
    let live = true;
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setView(null);
      setError("That machine is not reachable right now.");
      return;
    }
    /*
     * ⚠ **The view is cleared on a *switch*, and never on a refresh.** Blanking to
     * a spinner every few seconds is a screen that flashes; keeping the old one
     * until the new one arrives is what makes a refreshing board readable. `round`
     * moving is the refresh, so it is the one dependency that must not clear.
     */
    if (round === 0) setView(null);
    setError(null);
    reading.current += 1;
    void daemon
      .pluginView(pluginId, "screen")
      .then((answer) => {
        if (!live) return;
        // A plugin that answers a view request with a toast is answering the wrong
        // question, and drawing nothing is more honest than drawing its sentence
        // as though it were a screen.
        setView(answer.result.kind === "view" ? readView(answer.result.view) : { title: null, refreshMs: null, blocks: [] });
      })
      .catch((cause: unknown) => {
        // A refresh that fails leaves what is on screen and says nothing: the
        // machine dropping off LTE for one tick is not news, and a board that
        // replaced itself with an error every time the train went into a tunnel
        // would be worse than one that is briefly stale.
        if (live && round === 0) setError(pluginFailure(cause));
      })
      .finally(() => {
        /*
         * Counted rather than a flag, because a switch of plugin issues its
         * second read before the first has answered: this effect runs once for
         * the new pair under the old `round`, and again when the reset below
         * puts `round` back to 0. A boolean would be cleared by whichever of the
         * two answered first and let a tick land on top of the other. It cannot
         * be stranded above zero either — every request carries its own deadline
         * (`REQUEST_TIMEOUT_MS` in `machine.ts`), so a daemon that simply never
         * answers still settles this promise and the board resumes refreshing.
         */
        reading.current -= 1;
      });
    return () => {
      live = false;
    };
  }, [machineId, pluginId, round]);

  // A switch of plugin starts a fresh cycle, or the new one inherits the old
  // one's round and skips its own first clear.
  useEffect(() => {
    liveRoute.current = pluginPath(machineId, pluginId);
    setRound(0);
    // And `busy`, which belongs to a press on the plugin that has just left the
    // screen. The gates in `act` are what stop its answer clearing this, so
    // without the reset an action still out at the moment of the switch would
    // hold the *new* plugin's board disabled with nothing of its own in flight.
    setBusy(false);
  }, [machineId, pluginId]);

  const act = (actionId: string, context: { row?: string; form?: Record<string, string> }): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      toast("error", "That machine is not reachable right now.");
      return;
    }
    /*
     * ⚠ **Which plugin this press was for, captured before it goes out.**
     *
     * The view read is guarded by its own effect's cleanup, which runs on the
     * pair. An action has no effect and no cleanup, and this component is
     * deliberately *not* remounted when the route moves from one plugin to
     * another — so a slow action on A whose answer arrived after the sheet had
     * become B drew A's board under B's title, and then every row and form in it
     * submitted A-authored ids to B. That is not a near miss: action ids overlap
     * across plugins by construction, because two boards both call one "refresh".
     *
     * Asked only *after* the await, which is what makes writing `liveRoute` from
     * an effect safe rather than a race — `Composer`'s `liveKey` states both
     * halves of that rule one screen over.
     */
    const issuedFor = pluginPath(machineId, pluginId);
    setBusy(true);
    void daemon
      .pluginAction(pluginId, actionId, context)
      .then((answer) => {
        if (liveRoute.current !== issuedFor) return;
        if (answer.result.kind === "view") {
          setView(readView(answer.result.view));
          return;
        }
        toast(answer.result.tone === "danger" ? "error" : "ok", answer.result.text);
      })
      .catch((cause: unknown) => {
        // Gated too, and not only for tidiness: a toast has no plugin on it, so
        // A's failure under B's title reads as B having just failed at something
        // the person is looking straight at.
        if (liveRoute.current === issuedFor) toast("error", pluginFailure(cause));
      })
      .finally(() => {
        // The spinner belongs to the press, so a late answer must not clear the
        // one a *newer* press lit. The `setBusy(false)` in the `[machineId,
        // pluginId]` effect above is the other half of that: a late-write gate
        // always costs a reset, or the flag it stops writing is a flag the
        // switch strands.
        if (liveRoute.current === issuedFor) setBusy(false);
      });
  };

  /**
   * A row tapped.
   *
   * The destination is resolved from the plugin's `open` against **this** machine
   * — a plugin names a session id, never a URL and never a machine, so it cannot
   * point at a host somebody else's grant covers. `navigate` rather than a link,
   * because the sheet has to close: the session is *behind* it, and pushing a
   * route over the pop-up would leave the board on top of the thing it opened.
   */
  const go = (where: PluginOpen): void => {
    const target = pluginDestination(machineId, where);
    if (target === null) return;
    if (target.kind === "screen") {
      navigate(pluginPath(machineId, pluginId), true);
      return;
    }
    navigate(sessionPath(refOf(machineId, sessionId(target.sessionId))));
  };

  return (
    <Sheet title={view?.title ?? pluginId}>
      {error !== null ? (
        <Empty>{error}</Empty>
      ) : view === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <PluginView view={view} busy={busy} onAction={act} onOpen={go} />
      )}
    </Sheet>
  );
}
