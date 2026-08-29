import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MACHINE_GONE, pluginDestination, pluginFailure, pluginPath, readView } from "../plugins";
import { refOf, sessionId, type MachineId } from "../ids";
import { navigate, sessionPath } from "../router";
import { store } from "../store";
import type { PluginOpen, PluginView as PluginViewShape } from "../wire";
import { Button, Empty, Spinner } from "./bits";
import { PluginView } from "./PluginView";
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
export function PluginScreen({
  machineId,
  pluginId,
  onTitle,
}: {
  machineId: MachineId;
  pluginId: string;
  /** What the panel's head should say. See the effect at the foot of this file. */
  onTitle: (title: string) => void;
}): ReactNode {
  const [view, setView] = useState<PluginViewShape | null>(null);
  /**
   * Why there is no board, when there is none.
   *
   * ⚠ **`failed` is carried beside the words rather than derived from them**,
   * because the two arms that write this are different kinds of nothing and
   * {@link Empty} draws them differently. A read that did not come back is an
   * *event*: it takes the triangle and the live region, because nothing else on
   * screen says it happened. A machine this client has no daemon for is a settled
   * answer about the world, and announcing it would be announcing a state
   * somebody arrived in rather than something that just occurred.
   */
  const [error, setError] = useState<{ text: string; failed: boolean } | null>(null);
  /**
   * What the plugin said when it answered a *view* read with a toast.
   *
   * ⚠ **Its own state, and never a synthesized `notice` block.** `notice` is the
   * *plugin's* diagnostic channel — for a plugin with no screen it is the only one
   * it has — so a sentence this app wrote, drawn in that box, would be
   * indistinguishable from the plugin's own words. `PluginSettings` states the
   * same rule where it draws the same kind of line.
   */
  const [spoke, setSpoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Bumped to ask for a re-read. The interval lives in an effect keyed on the
   * *interval*, so a plugin that changes it between reads gets the new cadence
   * without the timer being rebuilt on every redraw — which it would be if the
   * effect depended on `view`.
   */
  const [round, setRound] = useState(0);
  /**
   * A read somebody asked for, as against one the clock asked for.
   *
   * ⚠ **Separate from {@link round} precisely because `round === 0` is what
   * "nothing is on screen yet" is spelled as** — the two guards in the read effect
   * below both test it, and a Retry that bumped `round` would satisfy neither: the
   * second failure of a mount would clear the old error and set no new one,
   * leaving a spinner that never resolves.
   *
   * ⚠ **What this said next was "so bumping this re-runs the same effect with
   * `round` still at 0", and that was true of exactly one of the two screens that
   * draw a Retry.** The other is the `spoke !== null` one, which keeps the
   * plugin's `refreshMs` deliberately — so its interval goes on ticking, `round`
   * goes on climbing, and by the time anybody presses Try again *both* guards are
   * being skipped: the press cleared nothing and set no error, which is a dead
   * button on an ordinary path (view loads → poll → plugin answers with a toast →
   * press). The error screen reaches the same state through a different door: the
   * `daemonFor` arm below sets an error at any round, so a machine that comes back
   * into the list leaves a spinner that never resolves — precisely the failure the
   * paragraph above says this state exists to prevent.
   *
   * So the effect asks whether *this* run is the one this counter moved for
   * ({@link askedFor}) instead of inferring it from `round`, and reports a failure
   * on that too. `round` is still not touched by a press, and now for a second
   * reason: resetting it would clear the view, and the view is where the `spoke`
   * screen keeps its cadence.
   */
  const [attempt, setAttempt] = useState(0);
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
  /**
   * The {@link attempt} the read effect has already run for.
   *
   * A ref for the same reason as the two above — nothing on screen reads it — and
   * it is the whole of how one effect tells a read a *person* asked for from a
   * read the clock asked for, which `round` alone cannot do once the clock is
   * running. Read and written inside the effect rather than during render, so a
   * render React discards cannot consume a press.
   */
  const askedFor = useRef(0);

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
    /*
     * Whether a person asked for this read. `attempt` moving is the only thing
     * that makes it true, and it is *consumed* here rather than compared down in
     * the guard because this effect also runs for every tick of the clock, for a
     * switch of plugin, and — under StrictMode — twice on mount: a press is one
     * run, and the run after it is the clock's again.
     */
    const asked = attempt !== askedFor.current;
    askedFor.current = attempt;
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setView(null);
      /*
       * ⚠ **Not "not reachable right now", which is what this said.**
       * `store.daemonFor` answers `undefined` only where the machine has left the
       * listing — `store.ts` writes and drops `daemons` in step with
       * `connections` — so this is a grant revoked in another tab or a machine
       * retired, and the old sentence named a remedy (wait, wake the host) for a
       * state that waking the host does not change. An unreachable machine keeps
       * its client and reports through `machine.reach` instead. See
       * {@link MACHINE_GONE}, which is also why `failed` stays `false`: a settled
       * answer about the world rather than an event.
       */
      setError({ text: MACHINE_GONE, failed: false });
      return;
    }
    /*
     * ⚠ **The view is cleared on a *switch*, and never on a refresh.** Blanking to
     * a spinner every few seconds is a screen that flashes; keeping the old one
     * until the new one arrives is what makes a refreshing board readable. `round`
     * moving is the refresh, so it is the one dependency that must not clear.
     *
     * `attempt` moving is neither, and it is deliberately still not part of this
     * test. ⚠ **This said a Retry is "pressed on the error screen, so there is
     * nothing on screen to keep and `round` is still 0", and there are two screens
     * that draw one.** On the error screen it holds — the view is already `null`
     * and the clear is a no-op. On the `spoke !== null` screen it does not: the
     * poll is still running there, so `round` is past 0, and what a clear would
     * throw away is the `refreshMs` that screen keeps on purpose. A retry answered
     * with another toast would then inherit `null` from a blanked view and stop the
     * clock for the rest of the mount — the exact defect the substitution below
     * exists to prevent, re-entered through the button that is supposed to be the
     * way out. So a press keeps the board and the cadence, and says what happened
     * to it through `asked` in the `catch` instead.
     */
    if (round === 0) setView(null);
    setError(null);
    reading.current += 1;
    void daemon
      .pluginView(pluginId, "screen")
      .then((answer) => {
        if (!live) return;
        if (answer.result.kind === "view") {
          setSpoke(null);
          setView(readView(answer.result.view));
          return;
        }
        /*
         * A plugin that answers a view request with a toast is answering the wrong
         * question, and drawing nothing is more honest than drawing its sentence as
         * though it were a screen. The blocks go rather than going stale: a view is
         * the plugin's assertion about its own state, so keeping the old board over
         * a fresh answer that is not one would be this client holding a second copy
         * of the truth.
         *
         * ⚠ **What is kept is the cadence, and that is the defect this closes.**
         * `refreshMs` was nulled along with the blocks — and the interval effect is
         * keyed on `refreshMs`, so one misbehaving answer stopped the clock for the
         * rest of the mount and the screen stayed frozen after the plugin had
         * recovered. The title is kept for a smaller reason of the same kind: the
         * head names the *screen*, and dropping it would flip the head to the raw
         * plugin id for a whole poll interval over an answer that said nothing
         * about the name.
         */
        setSpoke(answer.result.text);
        setView((held) => ({ title: held?.title ?? null, refreshMs: held?.refreshMs ?? null, blocks: [] }));
      })
      .catch((cause: unknown) => {
        /*
         * A refresh that fails leaves what is on screen and says nothing: the
         * machine dropping off LTE for one tick is not news, and a board that
         * replaced itself with an error every time the train went into a tunnel
         * would be worse than one that is briefly stale.
         *
         * ⚠ **`asked` is the exception, and it is the whole of what makes a Retry
         * mean the same thing on both screens.** A read the *clock* asked for owes
         * nobody an answer; a read somebody pressed a button for owes one at every
         * round, or the button is inert — which is what it was on the `spoke`
         * screen, where the clock keeps running and `round === 0` is therefore
         * false for every press. Nothing is lost by reporting it: the two screens
         * that draw the button are the two with no board on them, so the "briefly
         * stale" this guard protects is not a thing either of them has.
         *
         * Where the clock is still running, the error it writes stands until the
         * next tick clears it by asking again — one refresh interval, and then the
         * plugin's own last words are back with the button under them. That is the
         * `setError(null)` above doing what it is for, and the alternative is worse
         * in the direction that matters: an error only a person can dismiss would
         * outlive the plugin recovering.
         */
        if (live && (round === 0 || asked)) setError({ text: pluginFailure(cause), failed: true });
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
  }, [machineId, pluginId, round, attempt]);

  // A switch of plugin starts a fresh cycle, or the new one inherits the old
  // one's round and skips its own first clear. `attempt` is deliberately not
  // reset with it: it is a monotonic "somebody asked", and putting it back to 0
  // would issue a second read of the plugin this effect has just switched to.
  useEffect(() => {
    liveRoute.current = pluginPath(machineId, pluginId);
    setRound(0);
    // And `busy`, which belongs to a press on the plugin that has just left the
    // screen. The gates in `act` are what stop its answer clearing this, so
    // without the reset an action still out at the moment of the switch would
    // hold the *new* plugin's board disabled with nothing of its own in flight.
    setBusy(false);
    // And what the *previous* plugin said instead of drawing a board, for the
    // same reason: the read effect runs once under the old round before the reset
    // lands, so without this there is a render where one plugin's message stands
    // under another plugin's name.
    setSpoke(null);
  }, [machineId, pluginId]);

  /*
   * ⚠ **Hoisted into a `useCallback`, and this is the half of `PluginView`'s
   * memoising that lives here.** Every `Row` and every block down there is
   * memoised on a comparator that compares these two by identity, because a
   * function is not comparable any other way — so redeclared per render they make
   * every comparison answer `false`, and the memos become a cost with no return
   * on the one screen that redraws itself on a timer.
   *
   * ⚠ **`[machineId, pluginId]` is genuinely the whole of it**, which is what
   * makes the callback stable across a poll: `round` moving is what a refresh
   * *is*, and it is not in here. The rest of the body reads `store` and `toast`
   * (modules), `liveRoute` (a ref, whose identity never changes) and `setBusy` (a
   * setter React guarantees stable). The two that are left are the route, and the
   * route only moves when the sheet moves to another plugin — which is the one
   * moment every row *should* redraw.
   */
  const act = useCallback((actionId: string, context: { row?: string; form?: Record<string, string> }): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      // The same fact as the read guard above, so the same sentence: the machine
      // left the listing between the board being drawn and this row being pressed.
      toast("error", MACHINE_GONE);
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
  }, [machineId, pluginId]);

  /**
   * A row tapped.
   *
   * The destination is resolved from the plugin's `open` against **this** machine
   * — a plugin names a session id, never a URL and never a machine, so it cannot
   * point at a host somebody else's grant covers. `navigate` rather than a link,
   * because the sheet has to close: the session is *behind* it, and pushing a
   * route over the pop-up would leave the board on top of the thing it opened.
   */
  const go = useCallback(
    (where: PluginOpen): void => {
      const target = pluginDestination(where);
      if (target === null) return;
      if (target.kind === "screen") {
        navigate(pluginPath(machineId, pluginId), true);
        return;
      }
      navigate(sessionPath(refOf(machineId, sessionId(target.sessionId))));
    },
    // Same two, and for {@link act}'s reason. Everything else this reads is a
    // module-level function.
    [machineId, pluginId],
  );

  /*
   * ⚠ **The title is reported up rather than rendered here**, because the panel is
   * one element for every route-backed pop-up now and its head belongs to
   * `OverlaySheet`. This is the only pop-up whose name is not a constant — it is
   * whatever the plugin called its view — so it is the only one that has to say
   * so. One frame late, which costs nothing: the name arrives with the view and
   * the head shows the plugin's id until it does. Q3.484.
   */
  useEffect(() => {
    onTitle(view?.title ?? pluginId);
  }, [onTitle, view?.title, pluginId]);

  return error !== null ? (
    /*
     * ⚠ **A first read that failed was the terminal state of this mount, and the
     * Retry is what ends that.** The interval is keyed on `refreshMs`, which is
     * read off the view — so with no view there is no timer, `round` never moves,
     * and nothing was ever going to ask again. A phone dropping to LTE for one
     * second and a plugin that is genuinely dead drew the identical screen, and
     * the only way out was guessing that closing the sheet and reopening it
     * remounts this component.
     *
     * It bumps `attempt` rather than `round`: see that state's own docblock, where
     * the difference is the difference between reporting a second failure and
     * spinning for ever.
     */
    <Empty
      failed={error.failed}
      action={
        <Button size="sm" onClick={() => setAttempt((held) => held + 1)}>
          Try again
        </Button>
      }
    >
      {error.text}
    </Empty>
  ) : view === null ? (
    <div className="flex justify-center py-8">
      <Spinner />
    </div>
  ) : spoke !== null ? (
    /*
     * ⚠ **Not `PluginView`'s "This plugin drew nothing."** That sentence is about
     * a board with no blocks in it, which is a plugin's own answer about its own
     * state; this is a plugin that answered the wrong question, and the two send
     * whoever is holding the plugin to different places. Its words are carried
     * through rather than dropped, because this read is the only place they
     * arrive — an action's toast has a `toast` to go to and a view's has none.
     *
     * ⚠ **It takes the same Retry, for the case the substitution above cannot
     * cover.** A *first* read answered this way has no previous `refreshMs` to
     * keep, so there is no cadence to inherit and the poll never starts — which is
     * the error screen's terminal state wearing the plugin's own clothes.
     *
     * And where there *is* a cadence, the press is still not a no-op: the read it
     * asks for reports its own failure whatever the round, which it did not — see
     * {@link attempt}, where the same button on this screen was silent for a
     * release because the clock had moved `round` past the guard that speaks.
     */
    <Empty
      action={
        <Button size="sm" onClick={() => setAttempt((held) => held + 1)}>
          Try again
        </Button>
      }
    >
      {spoke.length === 0
        ? "That plugin answered with a message rather than a screen."
        : `That plugin answered with a message rather than a screen — ${spoke}`}
    </Empty>
  ) : (
    <PluginView view={view} busy={busy} onAction={act} onOpen={go} />
  );
}
