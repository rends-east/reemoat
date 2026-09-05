import { Check, Download, ListFilter, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { DaemonClient } from "../../daemon";
import { ApiError } from "../../http";
import type { MachineId } from "../../ids";
import {
  bulkEnabled,
  drawnActs,
  failureSummary,
  installedSubline,
  isBehind,
  NAMES_BEFORE_COUNT,
  noRowsText,
  removalQuestion,
  rowActLabel,
  rowActs,
  selectionLine,
  settingsBlockFor,
  settingsNotice,
  shownRows,
  skipReasonFor,
  skipText,
  type InstallFilter,
  type RowAct,
  type SkipReason,
  type TargetOutcome,
} from "../../install";
import type { MachineState } from "../../machine";
import { ConsentBrokenError, MACHINE_GONE, pluginFailure } from "../../plugins";
import { machineBadgeText } from "../../quota";
import { store, type AppState } from "../../store";
import { ambiguousNames, type PluginSummary } from "../../wire";
import { Badge, Button, DangerButton, Empty, Icon, IconButton, Menu, menuRow, SEARCH_FIELD, SETTINGS_HEADING, Spinner } from "../bits";

/**
 * Where this plugin is, and changing that.
 *
 * ⚠ **The rows are a *table* and the boxes are a *selection*, and both reverse the
 * draft this screen used to be.** The boxes were a draft of where the plugin should
 * be, applied by one button at the foot; what that could express and this cannot is
 * *moving* a plugin from one host to another in a single press. What it could not
 * express is everything else: putting a plugin on one machine without composing a
 * fleet-wide act, finding a host by name, or seeing only the ones that have it. A
 * fleet is unbounded and the old answer to that was a collapsed disclosure, so the
 * list somebody came to read was behind a fold and the failures written into it
 * were behind the same fold.
 *
 * So: a fixed-height scroller with a search box and a filter above it, per-row acts
 * that happen when pressed, and a bar of four below that acts on whatever is
 * ticked. Two of those four ask first — a removal, because `plugin_data` does not
 * come back, and a **fleet install**, because it hands somebody else's code this
 * uid on every machine at once. Both ask in the bar and both end with Cancel,
 * which is Q3.218's measured property rather than an ordering preference; see
 * {@link Confirming} for why the second one exists and why one machine is exempt.
 *
 * ⚠ **In the bar and nowhere else: the row's bin went with the row's question**
 * (Q3.469). A confirming pair has to replace what it guards, and a row 44px from
 * its own checkbox has nothing it can replace itself with. `drawnActs` is where
 * that is enforced, and it is a *narrowing* of `rowActs` rather than a second
 * predicate, because the bar still needs the wider answer to know whether its own
 * Remove may light up.
 *
 * ⚠ **Every enablement and every word is decided in `install.ts`.** `rowActs` and
 * `bulkEnabled` are pure and swept, which is what `draftAct` was extracted for and
 * for the same reason: left inline they are ternaries nothing checks, in the one
 * place on this screen where being wrong means pressing a control that does
 * something other than what it says. The bar's counts are derived from `rowActs`,
 * so **the bar cannot offer an act the rows do not** — a construction rather than a
 * comment, and the failure mode ("Remove is live but every row's Remove is grey")
 * that a second set of predicates would invite.
 *
 * ⚠ **A hidden row is still a selected row.** Narrowing the filter does not
 * unselect, because hiding is not choosing — and `selectionLine` says so out loud,
 * or one press removes a plugin from machines that are not on screen.
 */

/** How long to wait before the one retry a busy machine gets. */
const BUSY_RETRY_MS = 1_500;

/**
 * How long a row may say one unchanging word before it starts saying how long.
 *
 * ⚠ **A clock rather than a stage, and the daemon is why.** An install here is a
 * fetch from GitHub, an unpack *and* a start before anything answers, all of it
 * inside one `POST` whose budget is `SLOW_ROUTE_TIMEOUT_MS` — 90 seconds, times
 * however many machines are ticked. None of those steps is on the wire: the only
 * progress this client is ever handed is the upload fraction on the *file* path,
 * and the market path has not even got that. So a label naming a step would be
 * this screen guessing at what a daemon is doing, which is the one thing it may
 * not do; the elapsed time is the only thing it actually knows.
 *
 * Ten seconds because that is roughly where an unchanging word stops reading as
 * "working" and starts reading as "stuck" — early enough to answer the question
 * before somebody presses Cancel, late enough that an ordinary install never
 * grows a counter.
 */
const ELAPSED_AFTER_MS = 10_000;

/**
 * How many machines a bulk act may be sending to at once.
 *
 * See {@link MachineInstalls}'s `act` for the arithmetic this number comes out of:
 * a bulk install is one 2 MiB upload per machine out of one phone, and above about
 * four of them at once each one starves past its own `uploadDeadlines` wall clock
 * and the whole fleet reports "upload timed out" rather than finishing slowly.
 */
const MAX_MACHINES_AT_ONCE = 4;

/**
 * What to do on one machine. Returns what happened, so the row can say it.
 *
 * ⚠ **`signal` is supplied by this component, one controller per machine.** A
 * caller that constructs its own is a caller whose upload cannot be called off —
 * which is what `InstalledList` did, on the one screen that reaches a whole fleet.
 * Per machine rather than one for the act, because a machine that fails or is
 * cancelled individually must not abort the four beside it.
 *
 * ⚠ **Arity is not checked for you**: a two-parameter closure is silently
 * assignable to this, which is exactly how the market's own install went on
 * dropping the signal while the Cancel belonging to it was still drawn.
 */
export type InstallAct = (
  daemon: DaemonClient,
  machineId: MachineId,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => Promise<TargetOutcome>;

/** What one row is, once everything that decides it has been asked. */
type RowState =
  | { kind: "installed"; version: string; enabled: boolean }
  | { kind: "absent" }
  /** Reachable-but-refusing, or not reachable at all. Never actionable. */
  | { kind: "blocked"; reason: SkipReason }
  /**
   * `cancellable` is literally whether this job holds a controller. See {@link act}.
   *
   * `since` is when the **press** was, not when this job left the queue: the pool
   * starts four at a time, and a row that has been waiting its turn for forty
   * seconds has still cost somebody forty seconds. See {@link ELAPSED_AFTER_MS}.
   */
  | { kind: "working"; label: string; cancellable: boolean; since: number }
  /**
   * `consent` marks the one failure whose words are **not** on this row.
   *
   * A broken consent is an alert about the *plugin* — it names authority the
   * plugin gained over what somebody agreed to — and it is a paragraph. Drawn as a
   * subline it filled the whole scroller: ~200 characters at 12px in ~200px of row
   * is about thirteen lines against 158px of usable height, so one breached row
   * consumed the entire table and the summary outside pointed at a row you had to
   * scroll a small box to read. The message is still carried here, because the
   * notice above the table is built from the rows; what the row *draws* is a
   * pointer to it. See {@link sublineFor} and {@link consentAlertText}.
   */
  | { kind: "failed"; message: string; consent: boolean };

/**
 * Which question the bar is asking, or `null` for none.
 *
 * ⚠ **Two questions now, and both are still the bar's.** A row used to be able to
 * ask its own — it had a bin — and both the bin and the question went together:
 * see {@link drawnActs}. What is new is the second asker rather than a second
 * *place* to ask, so the property that was actually measured is untouched: the
 * pair replaces the strip in place and ends with Cancel, so a second tap on a laggy
 * connection lands on the undo.
 *
 * ⚠ **The second question is the *install*, which reverses the older rule that
 * only a removal is confirmed.** That rule weighed reversibility alone — a removal
 * takes `plugin_data` with it and an install does not — and it left the act that
 * hands somebody else's code this uid, this `HOME`, these repositories and this
 * `~/.ssh` as the one unguarded tap on the screen. At fleet scale it is one tap
 * reaching every ticked machine at once, which is the wider blast radius with the
 * weaker gate, a shape this screen has been caught in twice before. So a fan-out
 * asks; a single machine does not, because that is the same reach as the row's own
 * icon and putting a question on that would put one on the commonest act in the
 * app.
 *
 * A union rather than the boolean it was, because with two askers there is
 * something to tell apart again — and the question, the verb on the confirming
 * button and what it acts on all come from this one value rather than from three
 * places that can disagree.
 */
type Confirming = "remove" | "install" | null;

/**
 * What an act finished on one machine, kept so the screen can say so.
 *
 * ⚠ **Never a {@link RowState}.** A row's success is *cleared* rather than
 * written, because the store carries what is installed and a local "installed"
 * row would be a second copy of the truth that nothing invalidates. This is not
 * a row: it is what this screen did, which no poll will ever tell anybody, and
 * `PluginSettings`' `Outcomes` keeps the same ledger for a save for the same
 * reason.
 *
 * The three verbs are the daemon's own — `replaced` is how a client learns
 * whether it installed or updated — rather than the verb the button carried, so a
 * fleet that turned out to be half up to date says so.
 */
type Done = "installed" | "updated" | "removed";

/** What the filter offers. Three words; nothing here needs a description. */
const FILTERS: readonly { value: InstallFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "installed", label: "Installed" },
  { value: "absent", label: "Not installed" },
];

const ACT_ICON = { install: Download, update: RefreshCw, remove: Trash2 } as const;

export function MachineInstalls({
  pluginId,
  state,
  install,
  available = null,
  onBusyChange,
  heading = "Install",
  onConfigure,
}: {
  pluginId: string;
  state: AppState;
  /**
   * How to install, or `null` where this screen cannot.
   *
   * `null` on an installed plugin the catalogue does not carry — a plugin that
   * arrived as a file has no `{repo, commit}` to hand a second daemon, so the only
   * honest thing that screen can offer is removal.
   */
  install: InstallAct | null;
  /**
   * The version the catalogue has, when there is one.
   *
   * ⚠ **Without it no row draws Update at all**, because `isBehind` is false
   * everywhere — so on the screen whose whole purpose is putting a build onto a
   * fleet the only remaining route would be Remove, which takes `plugin_data` with
   * it: the destructive path as the only path.
   */
  available?: string | null;
  /**
   * Told when an act starts and when the last of it settles.
   *
   * For a caller that draws controls of its own beside this one — `ImportPlugin`
   * has "Choose another file" and "Done", either of which unmounts this component.
   *
   * ⚠ **Derived from the rows rather than raised and lowered around an act**, which
   * it has to be now that acts overlap: "this act settled" stopped being the same
   * question as "nothing is running" the moment two rows could be pressed a second
   * apart.
   */
  onBusyChange?: (busy: boolean) => void;
  heading?: string;
  /**
   * Where to go to configure the plugin on the machines that are ticked, or absent
   * where this screen has nowhere to send them.
   *
   * ⚠ **A callback rather than a `navigate` in here**, so this component stays
   * router-free and the import screen can decline it by passing nothing — which it
   * does, because the button navigates the sheet, and that unmounts `InstalledList`
   * and drops the `File` somebody chose. The same loss `onBusyChange` exists to
   * prevent one prop up, except this one is not even gated on `busy`.
   */
  onConfigure?: (machines: readonly MachineId[]) => void;
}): ReactNode {
  const [confirming, setConfirming] = useState<Confirming>(null);
  /**
   * The machines somebody has ticked.
   *
   * ⚠ **A plain set is correct where the draft had to be an override map.** `picks`
   * read *through* to the store because a refresh lands after every act and would
   * have overwritten the draft it produced. A selection is not derived from the
   * store at all — it is this person's own pointer state — so nothing can overwrite
   * it, and a machine that leaves the fleet is handled by intersecting at read time
   * rather than by an effect writing state under the 4s poll.
   *
   * ⚠ **And it is not spent by an act**, reversing the draft's rule deliberately:
   * Install-then-Settings over the same four machines is one gesture, and clearing
   * in between would make it two.
   */
  const [chosen, setChosen] = useState<ReadonlySet<MachineId>>(new Set());
  /**
   * What this screen did, per machine, overlaying what the store says.
   *
   * Needed because the store is the truth only *between* acts: while a request is
   * out there is no row to read, and a refusal is a fact about this attempt that
   * `pluginsByMachine` will never carry.
   */
  const [local, setLocal] = useState<ReadonlyMap<MachineId, RowState>>(new Map());
  /**
   * What this screen *finished* on each machine, which is the half nothing else
   * says.
   *
   * ⚠ **The widest-reach screen in this client had no success state at all.** A
   * job that worked cleared its row to `null` and let the store answer, so the
   * only confirmation of a four-machine install was a 12px subline changing inside
   * a 244px scroller — no summary, no toast, and nothing in the live region below,
   * which carried failures only. `PluginsPanel` toasts "Installed Clock 1.0.0" for
   * the *one*-machine path, so the fleet path was the quieter of the two: the same
   * inversion `InstalledList` was caught in over its cancellation signal.
   *
   * It is not a row and must not become one — see {@link Done}. It is cleared per
   * machine at the top of {@link act}, so a second act on one host does not erase
   * what a first act said about the four beside it.
   */
  const [finished, setFinished] = useState<ReadonlyMap<MachineId, Done>>(new Map());
  const [needle, setNeedle] = useState("");
  const [filter, setFilter] = useState<InstallFilter>("all");
  /**
   * The clock the elapsed counters are read against.
   *
   * ⚠ **One clock for every row rather than a timer per job**, so a fleet of fifty
   * is one interval and every row's count moves in the same paint. It runs only
   * while something is working — `PluginScreen`'s rule for its own poll, and for
   * its reason: this sheet is routinely left open behind a locked screen, and a
   * timer nothing is waiting on is background work nobody asked for.
   */
  const [now, setNow] = useState(0);
  /**
   * Which act each machine's answers belong to.
   *
   * ⚠ **Per machine, and act-wide was a real defect the moment rows could act
   * alone.** A single counter is right while a draft is applied wholesale — a
   * second act supersedes the first — but row A's Install and row B's Remove a
   * second apart are two calls to {@link act}, and an act-wide epoch would make the
   * second discard the first's answer for a machine it never touched, leaving row A
   * on "installing" for ever. This is the same per-machine argument `inFlight` and
   * `store.refreshPlugins(id)` already make.
   */
  const epochs = useRef(new Map<MachineId, number>());
  /**
   * The controller for each machine with a request in flight.
   *
   * Entries are deleted as each machine settles, so the map is exactly "what is
   * still cancellable" and a Cancel over an empty one is a no-op rather than a lie.
   */
  const inFlight = useRef(new Map<MachineId, AbortController>());
  const noticeId = useId();
  /**
   * The confirming question, so focus can be put on it when it replaces the bar.
   *
   * ⚠ **The question and not the armed button, and the difference is a held key.**
   * Pressing Remove with Enter swaps the whole strip; move focus to the confirming
   * Remove and a keyboard that is still repeating that Enter lands the repeat on
   * the control that acts — a destructive act completed by one press. The question
   * takes nothing from a repeat, and Tab reaches the pair from there.
   */
  const askRef = useRef<HTMLParagraphElement | null>(null);
  /**
   * Whether the one-machine fleet has had its box ticked for it.
   *
   * A ref rather than state because nothing on screen reads it, and because it
   * must survive the poll that rebuilds `state.machines` four seconds later: the
   * tick is a courtesy on arrival, not a policy, and re-applying it would fight
   * somebody who has just unticked the only row they have.
   */
  const seeded = useRef(false);
  /*
   * ⚠ **Read off `local` rather than off the rows, so it is available above the
   * early return** — and it is exact rather than an approximation: `working` is
   * written by {@link act} and by nothing else, so this is precisely "a request is
   * out".
   */
  const busy = [...local.values()].some((one) => one.kind === "working");

  /*
   * ⚠ **Derived from the rows rather than raised and lowered around an act**, and
   * that had to change the moment two rows could be pressed a second apart: the
   * old shape lowered it in the `allSettled` finally, so the *first* act to settle
   * would tell `ImportPlugin` it was safe to offer "Done" while a second was still
   * uploading — and pressing it unmounts a running fan-out.
   *
   * Safe against a caller that rebuilds its closure: setting the same value bails
   * out in React, and `ImportPlugin` passes a stable `setSending`.
   */
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  /*
   * ⚠ **`setInterval` and not a chain of timeouts**, and one that is torn down the
   * moment nothing is working. `Date.now()` is read at each tick rather than
   * counted up, so a phone that slept through half of an install comes back with
   * the true elapsed time instead of the number of ticks the tab was awake for.
   */
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [busy]);

  /*
   * ⚠ **A fleet of one arrives ticked, because the entry page arrived with four
   * dead buttons and no visible way to install.** Nothing was selected on mount,
   * so `bulkEnabled` greyed all four and the only live affordance was an icon-only
   * glyph on the right of a row inside a 244px scroller, with its meaning carried
   * entirely by an accessible name. One machine is the common case and there is
   * nothing to choose between, so the choice is made and shown rather than
   * demanded — the tick is on screen before anything is sent, which is the same
   * thing that makes "all machines" honest one rule over.
   *
   * ⚠ **Once, and never for a machine that cannot take the act.** `seeded` is
   * raised as soon as the fleet is known at all, so a fleet that later *becomes*
   * one machine does not silently tick the survivor; and a blocked row's box is
   * `disabled`, so ticking it would draw a checked box nobody can uncheck.
   *
   * ⚠ **But "known" is not "answered", and the latch was raised on the wrong one.**
   * It was set before `skipReasonFor` was consulted, on the first non-empty fleet —
   * and on a cold load that fleet is `reach: "unknown"`, because `bootstrap`
   * promotes to `phase: "ready"` on the machine list, before any probe. The one
   * machine somebody has was therefore read as an outage, the effect returned
   * without ticking, and the latch it had *already* raised meant it never ticked
   * again: the four dead buttons this effect exists to prevent, permanently, on the
   * commonest fleet there is. So a machine still being asked latches nothing and
   * decides nothing; every reach change rebuilds `state.machines`, so there is
   * always a later publish to decide on. A fleet of more than one still latches at
   * once, which is the property above.
   */
  useEffect(() => {
    if (seeded.current || state.machines.length === 0) return;
    const only = state.machines.length === 1 ? state.machines[0] : undefined;
    const reason = only === undefined ? null : skipReasonFor(only);
    if (reason === "asking") return;
    seeded.current = true;
    if (only === undefined || reason !== null) return;
    setChosen(new Set([only.id]));
  }, [state.machines]);

  /*
   * ⚠ **The question is focused as well as announced, and neither alone is
   * enough.** A `role="alert"` inserted into the DOM in the same paint as its text
   * is commonly not spoken at all — `EventList`, `Toast` and the live region below
   * all record that measurement — and this one cannot be always-mounted, because
   * it *replaces* the bar rather than sitting beside it. Focus is what makes it
   * reliable: without it a keyboard user pressed Remove, heard nothing, and was
   * left on `<body>` at the top of the document with an armed destructive control
   * somewhere below.
   */
  useEffect(() => {
    if (confirming === null) return;
    askRef.current?.focus();
  }, [confirming]);

  const write = useCallback((id: MachineId, row: RowState | null, epoch: number): void => {
    if (epochs.current.get(id) !== epoch) return;
    setLocal((held) => {
      const next = new Map(held);
      if (row === null) next.delete(id);
      else next.set(id, row);
      return next;
    });
  }, []);

  /**
   * What one machine finished with, under the same per-machine epoch gate
   * {@link write} keeps.
   *
   * `null` for an act that sent nothing — the screen holds no archive, so there
   * was nothing to install — and for every failure, cancellation included: this
   * ledger says what happened rather than what was attempted, and a cancelled
   * upload finishing as "installed" would be the one claim the Cancel exists to
   * prevent.
   */
  const finish = useCallback((id: MachineId, done: Done | null, epoch: number): void => {
    if (epochs.current.get(id) !== epoch) return;
    if (done === null) return;
    setFinished((held) => new Map(held).set(id, done));
  }, []);

  const rowFor = (machine: MachineState, found: PluginSummary | undefined): RowState => {
    const held = local.get(machine.id);
    if (held !== undefined) return held;
    const blocked = skipReasonFor(machine);
    if (blocked !== null) return { kind: "blocked", reason: blocked };
    return found === undefined ? { kind: "absent" } : { kind: "installed", version: found.version, enabled: found.enabled };
  };

  /**
   * Call off everything still in flight.
   *
   * Only an *install* carries a controller — a remove is a `DELETE` already sent by
   * the time there is anything to cancel, and it inherits its own retry one layer
   * down in `machine.ts`. So this stops uploads and leaves removals to finish,
   * which is the honest thing: the bytes are what somebody is waiting on.
   *
   * ⚠ **Aborting the controllers is the whole of it, and there is deliberately no
   * act-wide flag.** There was one, and it silenced a *removal's* failure and the
   * `plugin_busy` retry with it. Each request asks its own signal instead. The map
   * is not cleared: each job removes its own entry in its `finally`, so clearing
   * here would only lose the ability to abort a retry still to come.
   */
  const cancelAll = (): void => {
    for (const controller of inFlight.current.values()) controller.abort();
  };

  const act = (adding: readonly MachineId[], removing: readonly MachineId[]): void => {
    setConfirming(null);
    /*
     * ⚠ **One epoch per machine, stamped before anything is sent**, so two acts
     * that overlap cannot discard each other's answers. `mine` is this act's view
     * of them; `epochs` is the live one every later answer is checked against.
     */
    const mine = new Map<MachineId, number>();
    for (const id of [...adding, ...removing]) {
      const next = (epochs.current.get(id) ?? 0) + 1;
      epochs.current.set(id, next);
      mine.set(id, next);
    }
    /*
     * ⚠ **Only what this act touches, which is the same per-machine rule the
     * epochs keep.** Clearing the whole ledger would make a single row's Install
     * erase the sentence describing the four machines a fan-out finished a second
     * earlier — an act-wide reset discarding an answer for machines it never
     * reached.
     */
    setFinished((held) => {
      const next = new Map(held);
      for (const id of [...adding, ...removing]) next.delete(id);
      return next;
    });
    /** When the press was. Every row's counter is measured from here — see {@link ELAPSED_AFTER_MS}. */
    const pressedAt = Date.now();
    const jobs = [
      ...adding.map((id) => ({ id, what: "install" as const })),
      ...removing.map((id) => ({ id, what: "remove" as const })),
    ];

    /*
     * ⚠ **Every row is marked and every controller minted here, before a single
     * byte goes out** — because the pool below starts only some of these and the
     * rest wait their turn. Left inside the job, a fleet of fifty would paint eight
     * working rows and forty-two that still read "not installed", and Cancel on a
     * machine whose turn had not come would have no controller to abort. Held
     * together up here, a queued job is cancellable from the paint of the press:
     * `sendWithProgress` refuses an already-aborted signal before it opens the
     * request, and `upload` does not retry what the caller called off.
     *
     * Nothing is lost by the move. The old shape marked every row in this same tick
     * anyway — an `async` body runs synchronously to its first `await` — so this is
     * where the rows were being painted from already, said once instead of once per
     * job.
     */
    const queued: {
      id: MachineId;
      what: "install" | "remove";
      daemon: DaemonClient;
      controller: AbortController | null;
    }[] = [];
    for (const { id, what } of jobs) {
      const daemon = store.daemonFor(id);
      if (daemon === undefined) {
        // The list moved under the act — a machine revoked in another tab. Said
        // on its own row rather than thrown, because every other machine in this
        // act is still going.
        write(
          id,
          // Not a broken consent: nothing was sent, so nothing gained anything.
          { kind: "failed", message: MACHINE_GONE, consent: false },
          mine.get(id) ?? 0,
        );
        continue;
      }
      /*
       * ⚠ **One controller per job, and `null` for a removal.** It is what makes
       * "this request was called off" a question each job answers about itself
       * rather than about the act — a removal has no controller, is never
       * aborted, and therefore still reports its own failures, which is exactly
       * what `cancelAll` promises. Held across the retry rather than per attempt:
       * a failed attempt leaves it unaborted, so it is still the right handle,
       * and a fresh one per attempt would leave a `plugin_busy` retry
       * uncancellable for the 1.5s it sleeps.
       */
      const controller = what === "install" && install !== null ? new AbortController() : null;
      if (controller !== null) inFlight.current.set(id, controller);
      /*
       * ⚠ **`cancellable` is *literally* the controller this job holds.** It was
       * set from `adding.length > 0` — a fact about the jobs the screen drafted —
       * and a removal-only act therefore drew a live Cancel over an act holding no
       * controller at all.
       */
      write(
        id,
        {
          kind: "working",
          label: what === "install" ? "installing" : "removing",
          cancellable: controller !== null,
          since: pressedAt,
        },
        mine.get(id) ?? 0,
      );
      queued.push({ id, what, daemon, controller });
    }

    /**
     * One machine's job, start to finish.
     *
     * ⚠ **Total: it settles rather than rejecting**, which is what lets the workers
     * below `await` it in a loop. A rejection here would end the worker that drew
     * it and quietly shrink the pool for the rest of the act.
     */
    const run = async ({ id, what, daemon, controller }: (typeof queued)[number]): Promise<void> => {
      /** Whether *this* request was the one called off. */
      const calledOff = (): boolean => controller?.signal.aborted === true;
      /*
       * ⚠ **The outcome is kept now rather than dropped.** This returned `void`
       * and threw away what the act answered — so the screen could not tell an
       * install from an update, which is the daemon's own distinction (`replaced`)
       * and the one a fleet half of which was already current turns on. `null` is
       * "nothing was sent", which is the arm a screen holding no archive takes.
       */
      const once = async (): Promise<TargetOutcome | null> => {
        if (what === "remove") {
          await daemon.removePlugin(pluginId);
          return { kind: "removed" };
        }
        if (install === null || controller === null) return null;
        return await install(
          daemon,
          id,
          (fraction) =>
            write(
              id,
              // `since` is the press rather than this fraction's arrival, or the
              // counter would restart on every byte that moved.
              { kind: "working", label: `${Math.round(fraction * 100)}%`, cancellable: true, since: pressedAt },
              mine.get(id) ?? 0,
            ),
          controller.signal,
        );
      };
      try {
        const outcome = await once();
        // Cleared rather than set to a success state: the store is about to
        // carry the answer, and a row that kept a local "installed" would be a
        // second copy of the truth that nothing invalidates. What this screen
        // *did* is recorded beside the rows instead — see {@link finish}.
        write(id, null, mine.get(id) ?? 0);
        finish(id, doneOf(outcome), mine.get(id) ?? 0);
      } catch (error) {
        /*
         * ⚠ **`plugin_busy` is retried once and nothing else is.** A busy
         * machine is a queue collision — installs are serialised for a whole
         * daemon — and asking again a second later is exactly right. Everything
         * else is not retried, because `POST` is not replayable: a transport
         * failure says nothing about whether the daemon acted, and it may be
         * halfway through unpacking. A *remove* is a `DELETE` and inherits its
         * retry from `machine.ts` one layer down.
         */
        /*
         * ⚠ **A cancelled upload is not a failure, and must not be reported as
         * one.** `pluginFailure` still has no arm for an abort, so whatever its
         * generic arm happens to say lands on the row for an act the person took
         * deliberately. This quoted that sentence as "That did not work. Try
         * again."; it now reads "That machine did not answer, and whether it acted
         * is not known. Check before trying again." — which is *worse* here, not
         * better, since it sends somebody to check a machine that was never asked
         * anything. Both are written down because the *change* is the thing worth
         * knowing; nothing here depends on which words that arm holds, and this
         * guard would still be right if it were rewritten again tomorrow.
         * `pluginFailure`'s own docblock now states as a fact that an abort never
         * reaches it, and this check — with the one `PluginsPanel` makes on the
         * single-machine path — is what makes that true. The row is cleared
         * instead, so it falls back to what the store says: whatever was there
         * before. Checked before the retry, or a cancelled `plugin_busy` would wait
         * 1.5s and then send again, which is the opposite of cancelling.
         */
        if (calledOff()) {
          write(id, null, mine.get(id) ?? 0);
          return;
        }
        if (ApiError.isApiError(error) && error.code === "plugin_busy") {
          await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
          if (calledOff()) {
            write(id, null, mine.get(id) ?? 0);
            return;
          }
          try {
            const outcome = await once();
            write(id, null, mine.get(id) ?? 0);
            finish(id, doneOf(outcome), mine.get(id) ?? 0);
            return;
          } catch (second) {
            if (calledOff()) {
              write(id, null, mine.get(id) ?? 0);
              return;
            }
            write(
              id,
              { kind: "failed", message: pluginFailure(second), consent: isConsentFailure(second) },
              mine.get(id) ?? 0,
            );
            return;
          }
        }
        write(
          id,
          { kind: "failed", message: pluginFailure(error), consent: isConsentFailure(error) },
          mine.get(id) ?? 0,
        );
      } finally {
        /*
         * Per machine, and after that machine's own answer rather than after the
         * whole act: the launcher in the account menu and a session's menu read
         * `pluginsByMachine`, and a fleet where four hosts are done and one is
         * slow should show four hosts' worth.
         */
        inFlight.current.delete(id);
        store.refreshPlugins(id);
      }
    };

    /*
     * ⚠ **A pool, because one `Promise.allSettled` over the whole list is an
     * unbounded fan-out and this is the widest one in the client.** Every job is an
     * upload of the same archive — `PLUGIN_LIMITS.maxBytes` is 2 MiB and
     * `MAX_MACHINES_PER_USER` is 50 — so ticking a whole fleet started 100 MiB of
     * simultaneous `XMLHttpRequest` out of one phone. `src/plugins/runtime.ts`
     * bounds exactly this shape on the daemon's own side and says what the bound is
     * for: "what it stops is the unbounded fan-out, not concurrency". This is that
     * sentence's other half.
     *
     * ⚠ **And unbounded here does not merely mean slow, it means every row fails.**
     * The uploads share one uplink, so fifty of them each get a fiftieth of it —
     * while each still runs against its own wall clock. `uploadDeadlines` gives a
     * 2 MiB archive `20_000 + 2097152/50 ≈ 62s`, and 2 MiB at a fiftieth of a
     * 250 KiB/s uplink is about 419s: past the cap on all fifty, with none of them
     * finished. `sendWithProgress` aborts each one — "upload timed out" — and since
     * a `POST` is not replayable nothing retries, so `pluginFailure` draws fifty
     * failed rows. The *stall* budget never fires, because the bytes really are
     * trickling; the wall clock is what kills it.
     *
     * Four leaves that arithmetic with room — ≈34s against 62s — on a link a phone
     * plausibly has. It is arithmetic against those two constants rather than a
     * measurement of a real fleet, which is the honest description of it, and it is
     * why the number is small rather than the 16 the daemon's own bound uses.
     *
     * ⚠ **The bound is on how many *start*, and on nothing else.** Progress stays
     * per row, each job keeps its own epoch, its own controller and its own
     * `write` — `plugin-ui.md`'s "epochs are per machine" is untouched, because
     * scheduling is the only thing this adds.
     */
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        // `next` is claimed and advanced with no `await` between the two, which is
        // the whole of the mutual exclusion: one thread, one turn of the loop, so
        // two workers cannot draw the same job.
        const job = queued[next];
        next += 1;
        if (job === undefined) return;
        await run(job);
      }
    };
    void Promise.allSettled(Array.from({ length: Math.min(MAX_MACHINES_AT_ONCE, queued.length) }, () => worker()));
  };

  if (state.machines.length === 0) {
    return (
      <div>
        {heading.length > 0 && <h2 className={SETTINGS_HEADING}>{heading}</h2>}
        <Empty>{noRowsText(0, "", filter)}</Empty>
      </div>
    );
  }

  const ambiguous = ambiguousNames(state.machines);
  const canInstall = install !== null;
  const rows = state.machines.map((machine) => {
    /*
     * ⚠ **Two sources per row, and the split is deliberate.** `plugin` is what the
     * daemon last said and is never overlaid, so `settingsBlockFor` asks about the
     * machine's real state; `row` is `rowFor`'s overlay of `local`, so the subline
     * and the acts are about *this* act.
     */
    const plugin = state.pluginsByMachine.get(machine.id)?.find((one) => one.id === pluginId) ?? null;
    const row = rowFor(machine, plugin ?? undefined);
    const installed = row.kind === "installed";
    const behind = row.kind === "installed" && isBehind(row.version, available);
    const busy = row.kind === "working";
    return {
      machine,
      id: machine.id as string,
      name: machine.name,
      plugin,
      row,
      installed,
      busy,
      selected: chosen.has(machine.id),
      acts: rowActs({ installed, behind, blocked: row.kind === "blocked", busy }, canInstall),
    };
  });
  type Row = (typeof rows)[number];

  /*
   * ⚠ **One call, because the select-all box's meaning and the scroller's contents
   * are the same list.** Two calls is how a box comes to select rows the list is not
   * drawing — `groups.ts`'s standing rule about a filter and the keyboard.
   */
  const shown = shownRows(rows, needle, filter);
  const chosenRows = rows.filter((one) => one.selected);
  const hidden = chosenRows.filter((one) => !shown.includes(one)).length;

  const blockedFor = (one: Row): ReturnType<typeof settingsBlockFor> =>
    settingsBlockFor(one.machine, one.plugin === null ? null : { version: one.plugin.version, contributes: one.plugin.contributes });
  const blockedSettings = chosenRows
    .filter((one) => blockedFor(one) !== null)
    .map((one) => ({ name: one.name, block: blockedFor(one) as NonNullable<ReturnType<typeof settingsBlockFor>>, version: one.plugin?.version ?? null }));

  const can = bulkEnabled({
    selected: chosenRows.length,
    installable: chosenRows.filter((one) => one.acts.includes("install")).length,
    updatable: chosenRows.filter((one) => one.acts.includes("update")).length,
    removable: chosenRows.filter((one) => one.acts.includes("remove")).length,
    configurable: chosenRows.length - blockedSettings.length,
    canInstall,
  });

  const idsWith = (what: RowAct): MachineId[] =>
    chosenRows.filter((one) => one.acts.includes(what)).map((one) => one.machine.id);
  const removableNames = chosenRows.filter((one) => one.acts.includes("remove")).map((one) => one.name);
  const installTargets = idsWith("install");
  const anyCancellable = rows.some((one) => one.row.kind === "working" && one.row.cancellable);
  /*
   * ⚠ **Failures split by whether their words belong on a row.** A broken consent
   * is an alert about the *plugin* and is drawn above the table; everything else
   * is a fact about one host and stays on that host's row, summarised below the
   * table. Both halves are said somewhere, which is the property that matters: a
   * machine somebody selected and never heard about again is the failure
   * `planTargets`' partition exists to prevent.
   */
  const failures = rows.flatMap((one) =>
    one.row.kind === "failed" ? [{ name: one.name, message: one.row.message, consent: one.row.consent }] : [],
  );
  const consentAlert = consentAlertText(failures.filter((one) => one.consent));
  const failure = failureDetail(failures.filter((one) => !one.consent));
  const doneNames = (kind: Done): string[] =>
    rows.filter((one) => finished.get(one.machine.id) === kind).map((one) => one.name);
  /*
   * ⚠ **What the act did and what it did not, in one string and one region.** The
   * region carried failures only, so the commonest fan-out — one that worked —
   * said nothing at all in the one channel a screen reader is listening to. Both
   * halves in one node rather than two regions: two live regions beside each other
   * interleave unpredictably, and "Installed on laptop, mini." followed by what
   * went wrong on the third is one sentence about one act.
   */
  const said = [doneSummary(doneNames("installed"), doneNames("updated"), doneNames("removed")), failure]
    .filter((one) => one.length > 0)
    .join(" ");
  /**
   * What to call the plugin in a question.
   *
   * Whatever the machines call it, because that is the only name this component is
   * given — the id is what the route and the archive carry, and it is a slug. The
   * fleet-install case is exactly the one where no machine has it yet, so the id is
   * what usually survives; the last arm is the import screen before an archive has
   * been read, where there is no id either.
   */
  const named = rows.find((one) => one.plugin !== null)?.plugin?.name ?? (pluginId.length > 0 ? pluginId : "this plugin");
  const notice = settingsNotice(blockedSettings);
  const allShown = shown.length > 0 && shown.every((one) => one.selected);
  const someShown = shown.some((one) => one.selected);

  const toggle = (id: MachineId): void => {
    // Either question is about the selection it was armed over, so changing the
    // selection takes it down rather than leaving it pointing at a count that has
    // moved under it.
    setConfirming(null);
    setChosen((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      {/* Empty where the caller already named the thing — an installed row says
          the plugin's name two lines up. An empty `<h2>` is not the same as none:
          it is a heading in the accessibility tree with no text. */}
      {heading.length > 0 && <h2 className={SETTINGS_HEADING}>{heading}</h2>}

      {/*
       * ⚠ **What to do here, said in words, because the screen said it in glyphs
       * only.** With nothing ticked all four controls below are grey and the line
       * inside the table is empty, so the only live affordance on the entry page
       * is a 44px Download glyph on the right of a row inside a scroller — a
       * control whose meaning is carried entirely by its accessible name, which is
       * to say invisible to everybody who can see it.
       *
       * ⚠ **Only past one machine, and it is the *fleet* that gates it rather than
       * the selection.** A fleet of one arrives ticked (see the effect above), so
       * there is nothing to explain; and a hint that came and went with the
       * selection would move the table and the bar under a thumb that is already
       * aimed at them, which is the whole reason the line inside the box is always
       * mounted. This one changes only when the fleet does.
       *
       * ⚠ **The second clause is gated on `canInstall` because without it a row
       * draws nothing.** `rowActs` answers `[]` for install and update where this
       * screen holds no archive, and `drawnActs` takes the removal off the row — so
       * on the Offline page every row is inert and the only act is the bar's. A
       * hint pointing at a control that is not there is worse than no hint.
       */}
      {state.machines.length > 1 && (
        <p className="mt-1 text-2xs text-muted">
          Tick machines to act on several at once{canInstall ? ", or use a row's own button for one." : "."}
        </p>
      )}

      {/*
       * ⚠ **A broken consent is drawn here rather than on the row it happened on,
       * and it is the only failure that is.** `plugin_consent_broken` is a
       * paragraph naming every scope, host and hook the plugin gained over what
       * the disclosure screen showed — about 200 characters, which on a row is
       * ~13 wrapped lines at 12px inside a scroller with 158px of usable height:
       * one breached machine consumed the whole table, and the summary below it
       * said "the row says why" about a row somebody had to scroll a small box to
       * read. It is also not a per-row status in the first place — it is an alert
       * about the **plugin**, and it is the most important sentence this product
       * has.
       *
       * ⚠ **Always mounted, only the text swapping**, and `role="alert"` rather
       * than the `status` below: `EventList` and `Toast` both record that a live
       * region inserted in the same paint as its content is commonly not spoken at
       * all, and this one is assertive because what it describes is authority
       * somebody did not agree to give.
       */}
      <p
        role="alert"
        className={consentAlert.length === 0 ? "" : "mt-2 rounded-md border border-edge-strong px-3 py-2 text-sm wrap-anywhere text-fg"}
      >
        {consentAlert}
      </p>

      {/*
       * ⚠ **One box, and the header is inside it.** The search, the select-all and
       * the filter are *about* the rows, so drawn above the border they read as a
       * second control that happens to sit near a list. `shrink-0` and outside the
       * scroller, so they do not scroll away from what they filter.
       *
       * ⚠ **A definite height rather than a ceiling, and it does not depend on the
       * contents.** A `max-h` made the box the size of whatever was in it — one
       * machine, and a no-results sentence, are different heights — so the bar below
       * moved every time somebody typed a letter into the search box.
       *
       * ⚠ **And the line under the rows is inside it**, so the only thing that can
       * change size on this screen is bounded by something that cannot.
       *
       * 15.25rem is arithmetic, and the first pass got it wrong by measuring the
       * search box instead of the tallest thing beside it: the select-all is a
       * `min-h-11` label, so the header is 8 + 44 + 8 and a 1px rule = 61. The
       * footer is 24 and its own rule = 25. A row is `min-h-11` plus 1, so
       * 244 − 61 − 25 leaves 3.5 of them. The **half row is the affordance** — the
       * only thing on screen saying the list scrolls — and it no longer moves with
       * the pointer, since `SEARCH_FIELD` growing to 44px on a coarse one is still
       * shorter than the label it sits beside.
       */}
      <div className="mt-2 flex h-[15.25rem] flex-col overflow-hidden rounded-md border border-edge">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-2">
        {/*
         * ⚠ **`px-2` rather than `pr-1`, because 44px tall and 20px wide is not a
         * 44px target.** This label is the whole target — the input inside it is
         * 16px and a native checkbox cannot be grown by padding, which is why the
         * padding is out here — and it was 16 + 4: a control the height of a
         * button and the width of a glyph, at the left edge of a row whose other
         * two controls are a search box and a menu. 8px each side makes it 32
         * wide, which is what fits beside a `flex-1` search field on a phone;
         * `min-h-11` already had the other axis.
         */}
        <label className="tap inline-flex min-h-11 shrink-0 items-center px-2">
          {/*
           * ⚠ **`indeterminate` needs a callback ref — React has no prop for it —
           * and it is worth the DOM write.** "Some but not all" is the state this
           * box is usually in once a filter is on, and a box drawn empty over four
           * ticked rows is the same class of lie as a Cancel drawn over an act
           * holding no controller.
           */}
          <input
            type="checkbox"
            ref={(el) => {
              if (el !== null) el.indeterminate = someShown && !allShown;
            }}
            checked={allShown}
            disabled={shown.length === 0}
            onChange={() => {
              setConfirming(null);
              /*
               * ⚠ **Over `shown`, and unticking leaves hidden selections alone.**
               * Otherwise select-all followed by a filter change would silently
               * deselect machines nobody untickled.
               */
              setChosen((held) => {
                const next = new Set(held);
                for (const one of shown) {
                  if (allShown) next.delete(one.machine.id);
                  else next.add(one.machine.id);
                }
                return next;
              });
            }}
            aria-label={`Select the ${shown.length} machines shown`}
            className="h-4 w-4 shrink-0"
          />
        </label>
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
            <Icon as={Search} size={13} />
          </span>
          <input
            type="search"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            aria-label="Search machines"
            placeholder="Search machines"
            className={SEARCH_FIELD}
          />
        </div>
        {/*
         * ⚠ **`Menu` and not `Dropdown`**, which `SessionBrowser` refuses in writing
         * for this exact pair of controls: `Dropdown` draws its own bordered pill
         * with a chevron, and this strip already holds one bordered box. `Menu`
         * draws nothing and hands the trigger back, which is what an icon needs.
         * What a bare glyph loses is the current value, bought back the three ways
         * that row already uses — `bg-raised` when narrowed, the name on the label,
         * and the count in words below.
         */}
        <Menu
          align="right"
          panelClassName="w-44"
          className="shrink-0"
          trigger={(open, toggleMenu) => (
            <IconButton
              icon={ListFilter}
              label={`Showing ${FILTERS.find((one) => one.value === filter)?.label ?? "All"}`}
              /*
               * ⚠ **`chip`, named rather than inherited — and this said "never the
               * `md` default", which has since expired three times over.** There is
               * no default: `IconButton.size` is required, so a call site cannot get
               * a size by not thinking about one. There is no `md` either — it was
               * `h-9 w-9` with no growth mechanism, the one entry that never reached
               * 44px, and it is *deleted* rather than resized, because widening it
               * would have moved every layout that had settled around a 36px box.
               * And `webcheck`'s ratchet over the call sites that took it is gone
               * with them: what the driver holds now is the table itself, that every
               * size left says how it reaches 44 and that 36px has not come back
               * under another name.
               *
               * What survives is the choice among the three that remain: `chip` is
               * 32px of ink reaching 44 through `TAP_GROW_Y`, which grows
               * **vertically only**, so it cannot put its target over the search
               * box's face the way a symmetric inset would.
               */
              size="chip"
              /* `expanded`, not `active`: `aria-pressed` is a toggle that stays
                 pressed and this is a control that reveals a region. */
              expanded={open}
              onClick={toggleMenu}
              className={filter === "all" && !open ? "" : "bg-raised text-fg"}
            />
          )}
        >
          {(close) => (
            <>
              {FILTERS.map((one) => (
                <button
                  key={one.value}
                  role="menuitem"
                  onClick={() => {
                    setFilter(one.value);
                    close();
                  }}
                  className={`${menuRow("center")} hover:bg-raised ${
                    one.value === filter ? "font-medium text-fg" : "text-muted"
                  }`}
                >
                  {/* A reserved slot, so choosing does not shift the three labels. */}
                  <span className="inline-flex w-3 shrink-0 justify-center">
                    {one.value === filter && <Icon as={Check} size={12} />}
                  </span>
                  {one.label}
                </button>
              ))}
            </>
          )}
        </Menu>
      </div>

      {/*
       * ⚠ **No `overscroll-contain`, deliberately.** `SHEET_BODY` records the
       * measurement and `Settings.tsx` restates it: Chrome ends the scroll chain at
       * a box carrying `overscroll-behavior: contain` even when it has nothing to
       * scroll — measured at 400px of travel against 0px. A fleet of one puts one
       * row in a box that then cannot move, and with containment it would swallow
       * every gesture aimed at the page it sits in the middle of.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <Empty>{noRowsText(state.machines.length, needle, filter)}</Empty>
        ) : (
          <ul className="flex flex-col">
            {shown.map((one) => (
              <MachineRow
                key={one.machine.id}
                one={one}
                ambiguous={ambiguous.has(one.name.toLowerCase())}
                available={available}
                canInstall={canInstall}
                now={now}
                onToggle={() => toggle(one.machine.id)}
                onAct={() => act([one.machine.id], [])}
                onCancel={() => inFlight.current.get(one.machine.id)?.abort()}
              />
            ))}
          </ul>
        )}
      </div>
        {/*
         * ⚠ **Inside the box, and that is the whole of "nothing moves".** This line
         * was below it, reserved at `min-h-4` — and `text-2xs` has an 18px line box,
         * so the reserve was 16 and the text was 18 and the bar still stepped 2px
         * every time somebody ticked something. Reserving the right number would
         * have fixed that one instance and left the next caller to rediscover it.
         * In here it is bounded by a container with a **definite** height, so no
         * string it ever holds can move anything below the table. `h-6` clears the
         * line box with room, and `truncate` keeps a long blocker on one line.
         *
         * ⚠ **One line for both, and the blocker wins where there is one**, because
         * the count is already visible in the ticked boxes above while *why a
         * control will not move* is visible nowhere else. It stays above the control
         * it explains — `AccountSection`'s consequence-before-the-button rule — and
         * is what that control's `aria-describedby` points at.
         *
         * ⚠ **Empty rather than "nothing selected"**: that named the *absence* of a
         * state, on a strip whose four controls are already visibly inert, and it
         * is the commonest state — a permanent line saying nothing. What the line
         * is for survives, because a row the filter is hiding is still selected and
         * one press reaches it.
         *
         * ⚠ **Not a live region**, unlike the one below it: this changes on every
         * tick of a checkbox, and announcing that would be chatter beside a region
         * that speaks once, when an act settles. This called that "the failure
         * below" and it has stopped being one — it carries `said`, which is what an
         * act finished as well as what it failed at, because a fan-out that worked
         * used to say nothing at all in the one channel that cannot be skimmed. The
         * contrast is with a region that speaks about *acts*, then; the reason this
         * one stays silent is unchanged.
         */}
        <p
          id={noticeId}
          title={notice || undefined}
          className="flex h-6 shrink-0 items-center truncate border-t border-edge px-2 text-2xs text-muted"
        >
          {notice || (chosenRows.length === 0 ? "" : selectionLine(chosenRows.length, hidden))}
        </p>
      </div>

      {/*
       * ⚠ **What the act did, said outside the scroller.** The rows scroll, so a
       * failure on row nine of a six-row viewport is off screen, and this is the
       * only thing that speaks it. Mounted **unconditionally** with only its text
       * swapping: `EventList` and `Toast` both record that a `role="status"`
       * inserted in the same paint as its content is commonly not spoken at all,
       * VoiceOver on iOS included. `polite` rather than an alert, because this line
       * does not expire.
       *
       * ⚠ **It carried failures only, which made the fleet path the quieter of the
       * two.** A fan-out that worked cleared its rows and said nothing anywhere —
       * no toast, no summary, and silence in the one channel that cannot be skimmed
       * — while `PluginsPanel` toasts "Installed Clock 1.0.0" for a single machine.
       * {@link doneSummary} is the mirror of {@link failureDetail}, and they share
       * this node rather than taking one region each: two regions beside each other
       * interleave, and this is one sentence about one act.
       */}
      <p role="status" aria-live="polite" className={said.length === 0 ? "" : "mt-3 text-xs wrap-anywhere text-fg"}>
        {said}
      </p>
      {/*
       * ⚠ **The bar, outside the scroller and always on screen.** Order puts the
       * destructive control in the middle, so a stray tap at either end of the strip
       * lands on something reversible. The confirming pair replaces it in place and
       * ends with Cancel, so the last child occupies the same pixels either way.
       *
       * ⚠ **Not disabled while something is working**: concurrency is the model now,
       * and double-sending is prevented at the row instead — `rowActs` answers `[]`
       * for a busy machine, so it is in none of the counts above.
       */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming !== null ? (
          <>
            {/*
             * ⚠ **A `role="alert"` that is also the focus target, and both halves
             * are load-bearing.** This element replaces the bar rather than sitting
             * beside it, so it cannot be always-mounted the way the region above it
             * is — and a live region inserted in the same paint as its text is
             * commonly not spoken at all. The focus move is what makes it reliable,
             * and it fixes the other half of the same defect: the button somebody
             * pressed unmounts, React leaves focus on `<body>`, and a keyboard user
             * was returned to the top of the document with an armed destructive
             * control somewhere below. `tabIndex={-1}` so it can take focus without
             * joining the tab order.
             *
             * ⚠ **The question and not the armed button.** A held Enter repeats,
             * and a repeat landing on the control that acts is a destructive act
             * completed by one press. Nothing repeats onto a paragraph.
             */}
            <p ref={askRef} role="alert" tabIndex={-1} className="basis-full text-xs text-muted">
              {confirming === "remove" ? removalQuestion(removableNames) : installQuestion(named, installTargets.length)}
            </p>
            {confirming === "remove" ? (
              <Button
                tone="destructive"
                size="sm"
                className="[@media(pointer:coarse)]:min-h-11"
                onClick={() => act([], idsWith("remove"))}
              >
                Remove
              </Button>
            ) : (
              /*
               * ⚠ **Not the destructive tone, and not because installing is safe.**
               * An install is dangerous and reversible; a removal is safe and
               * irreversible, and the red is spent on the second. `BUTTON_TONE`
               * fixes what is left: the filled button in a confirming pair is
               * always Cancel, so this one is the outlined `plain`.
               */
              <Button size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={() => act(installTargets, [])}>
                Install
              </Button>
            )}
            <Button tone="primary" size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {/*
             * ⚠ **A fan-out asks; one machine acts.** Installing hands somebody
             * else's code this uid, this `HOME` and these repositories — the daemon
             * confines a plugin no more than it confines an agent — and at fleet
             * scale this single tap reached every ticked machine at once. One
             * machine is the same reach as the row's own icon two inches up, and a
             * question there would put one on the commonest act in the app.
             *
             * `installTargets` rather than a fresh `idsWith("install")` in each
             * arm, so the count in the question and the list the answer acts on
             * cannot be two different walks.
             */}
            <Button
              disabled={!can.install}
              onClick={() => (installTargets.length > 1 ? setConfirming("install") : act(installTargets, []))}
            >
              Install
            </Button>
            <Button disabled={!can.update} onClick={() => act(idsWith("update"), [])}>
              Update
            </Button>
            <DangerButton icon={Trash2} disabled={!can.remove} onClick={() => setConfirming("remove")}>
              Remove
            </DangerButton>
            {onConfigure !== undefined && (
              <Button
                disabled={!can.settings}
                ariaLabel="Settings"
                aria-describedby={notice.length === 0 ? undefined : noticeId}
                onClick={() => onConfigure(chosenRows.map((row) => row.machine.id))}
              >
                Settings
              </Button>
            )}
            {anyCancellable && (
              <Button tone="primary" onClick={cancelAll}>
                Cancel
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One machine, as a row.
 *
 * ⚠ **A `<div>` with `<label htmlFor>`s inside it, never a `<label>` wrapping the
 * row.** The draft's row *was* a label so the whole strip toggled its box — and a
 * `<label>` may hold no `<button>`. Left as one, a tap on this row's Remove icon
 * would toggle the checkbox as well. `htmlFor` buys the large target back without
 * containing the controls, and it is what lets there be **two** of them: one over
 * the name, and one around the box itself. Both point at the same input, and an
 * empty label contributes nothing to its accessible name.
 */
function MachineRow({
  one,
  ambiguous,
  available,
  canInstall,
  now,
  onToggle,
  onAct,
  onCancel,
}: {
  one: {
    machine: MachineState;
    name: string;
    row: RowState;
    selected: boolean;
    busy: boolean;
    acts: RowAct[];
  };
  ambiguous: boolean;
  available: string | null;
  canInstall: boolean;
  /** The shared clock the working label is measured against. See {@link sublineFor}. */
  now: number;
  onToggle: () => void;
  onAct: (what: RowAct) => void;
  onCancel: () => void;
}): ReactNode {
  const boxId = useId();
  const { machine, row } = one;
  /*
   * ⚠ **A machine nobody has asked yet is a wait, and this row used to draw it as
   * an outage.** `skipReasonFor` folded `reach: "unknown"` into `unreachable`, so
   * for the seconds between `bootstrap` promoting to `phase: "ready"` and the first
   * probe landing every row here was dimmed with its box `disabled` — a whole fleet
   * drawn as switched off on every cold load, and a one-machine fleet locked out of
   * the tick the effect above exists to give it.
   *
   * Split out, the two halves go different ways. The **acts** stay away, because
   * what is installed there is genuinely not known yet and every icon would be
   * drawn from a guess. The **box** comes back, because ticking a row chooses a
   * machine rather than claiming anything about it, and a choice made during the
   * window is still the right choice when the probe lands a moment later — with the
   * bar's own counts, which come from the acts, staying honest throughout. The
   * dimming goes with the box: `opacity-60` is what this list says about a machine
   * that is out, and this one is merely late.
   */
  const waiting = row.kind === "blocked" && row.reason === "asking";
  const out = row.kind === "blocked" && !waiting;
  return (
    <li className="border-b border-edge last:border-b-0">
        <div className={`flex min-h-11 items-center gap-2.5 px-2 py-1.5 ${out ? "opacity-60" : ""}`}>
          {/*
           * ⚠ **The padding is on a label around the box, because a native
           * checkbox cannot be grown by padding of its own** — its size is `h-4
           * w-4` and `box-sizing: border-box`, so padding eats the glyph rather
           * than the gutter, and WebKit's answer to padding on a form control with
           * `appearance: auto` is its own anyway. So the target is this element:
           * 16px of ink in 32px of label.
           *
           * ⚠ **`-m-2` against the `p-2`, so nothing moves.** The label's border
           * box grows 8px on every side and its margin box shrinks back to exactly
           * the input's old 16px footprint — the same trick `IconButton.sm` plays
           * with `after:-inset-2.5`, spelled with a real element because a
           * pseudo-element on an `<input>` does not render. It reaches 8px into the
           * row's own `gap-2.5`, which is dead space, and it is deliberately **not**
           * `min-h-11`: this row is `min-h-11 py-1.5`, so a 44px child would make
           * every row 56px and the box's 3.5-row arithmetic wrong by a row and a
           * half.
           */}
          <label htmlFor={boxId} className="tap -m-2 flex shrink-0 items-center p-2">
            <input
              id={boxId}
              type="checkbox"
              checked={one.selected}
              disabled={out}
              onChange={onToggle}
              className="h-4 w-4 shrink-0"
            />
          </label>
          <label htmlFor={boxId} className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-sm">{machine.name}</span>
              {machineBadgeText(machine) !== null && <Badge tone="strong">{machineBadgeText(machine)}</Badge>}
            </span>
            {/*
             * ⚠ **A failure is not clipped, and it changes ink rather than weight.**
             * `truncate` throws away the half that identifies what went wrong, and
             * this line has nothing to open to: `pluginFailure` carries four daemon
             * codes through verbatim, and `plugin_consent_broken` is a paragraph
             * naming every scope the plugin gained.
             */}
            <span className={`block text-2xs ${row.kind === "failed" ? "wrap-anywhere text-fg" : "truncate text-muted"}`}>
              {ambiguous && (
                <>
                  <code className="text-2xs text-muted/80">{machine.id}</code>
                  {" · "}
                </>
              )}
              {sublineFor(row, canInstall, available, now)}
            </span>
          </label>
          {/*
           * ⚠ **A reserved slot two `lg` boxes wide**, so a row going
           * `[install]` → `[spinner][cancel]` → `[update]` does not mount sideways
           * into the name beside it. Two and not one even though `drawnActs` leaves
           * a settled row at most one icon: the *working* state draws the spinner
           * and the cancel beside it, and that pair is what sets the width.
           */}
          <span className="flex w-[5.5rem] shrink-0 items-center justify-end gap-1">
            {one.busy ? (
              <>
                <Spinner />
                {row.kind === "working" && row.cancellable && (
                  <IconButton icon={X} label={`Cancel installing on ${machine.name}`} size="lg" onClick={onCancel} />
                )}
              </>
            ) : (
              drawnActs(one.acts).map((what) => (
                /*
                 * ⚠ **`size="lg"` and never `size="sm"`.** An `sm` icon is 24px of
                 * ink reaching 44px through `after:-inset-2.5`, so two adjacent ones
                 * overlap their targets by 18px whatever the gap — and the later
                 * element in the DOM wins the hit test, which on this row is the
                 * destructive one. A tap on the right of Update's ink would remove
                 * a plugin and its `plugin_data`. `lg` is a real 44px box, and this
                 * row is already `min-h-11`, so it costs no height.
                 */
                <IconButton
                  key={what}
                  icon={ACT_ICON[what]}
                  label={rowActLabel(what, machine.name)}
                  size="lg"
                  onClick={() => onAct(what)}
                />
              ))
            )}
          </span>
        </div>
    </li>
  );
}

/**
 * What one row says about itself under its name.
 *
 * `now` is the shared clock, and `0` — its value before anything has worked — is
 * older than every `since`, so the elapsed arm simply does not fire. That is the
 * honest default: a row is drawn long before the first tick of a timer that only
 * runs while something is working.
 */
function sublineFor(row: RowState, canInstall: boolean, available: string | null, now: number): string {
  switch (row.kind) {
    case "installed":
      return installedSubline(row.version, available, row.enabled);
    case "absent":
      // Says why there is no Install icon, rather than leaving a row that offers
      // nothing and does not say so.
      return canInstall ? "not installed" : "not installed — this plugin did not come from the market";
    case "blocked":
      return skipText(row.reason);
    case "working": {
      /*
       * ⚠ **Seconds, and only past {@link ELAPSED_AFTER_MS}.** One word held for
       * the whole of a 90s budget is indistinguishable from a screen that has
       * stopped, and multiplying it by four concurrent machines is the state this
       * row spends most of its life in. A counter from the first second would be
       * noise on the ordinary install that takes three.
       */
      const elapsed = now - row.since;
      return elapsed < ELAPSED_AFTER_MS ? row.label : `${row.label} · ${Math.round(elapsed / 1000)}s`;
    }
    case "failed":
      /*
       * ⚠ **The one failure whose words are elsewhere.** A broken consent is a
       * paragraph about the *plugin* rather than a status for this host, and drawn
       * here it filled the scroller it sits in — see {@link RowState}. The row
       * still says that this machine is the one it happened on, and points at the
       * notice that says what happened.
       */
      return row.consent ? "refused — see the notice above the table" : row.message;
  }
}

/**
 * Whether a failure is a broken consent, through either of the two doors it has.
 *
 * The import path checks the answer against the archive it read *here* and throws
 * {@link ConsentBrokenError}; the market path is refused by the daemon itself,
 * before the plugin starts, and arrives as `plugin_consent_broken`. They are one
 * fact — the plugin has authority somebody did not agree to give it — and the
 * screen must not draw one of them differently from the other because of which
 * side noticed.
 */
function isConsentFailure(cause: unknown): boolean {
  if (ConsentBrokenError.isConsentBroken(cause)) return true;
  return ApiError.isApiError(cause) && cause.code === "plugin_consent_broken";
}

/**
 * The notice above the table, or the empty string where there is nothing to say.
 *
 * ⚠ **Grouped by the message rather than listed per machine**, because the daemons
 * usually answer identically — it is the same commit — and four copies of a
 * 200-character paragraph is a wall nobody reads, which is how a breach comes to be
 * skimmed past. Machines that answered differently keep their own group: two
 * daemons disagreeing about what a plugin asked for is itself the finding.
 *
 * Every machine is named even where there is one, because this is a fleet screen
 * and the reader's next question is always *which host is it on now*.
 */
function consentAlertText(failures: readonly { name: string; message: string }[]): string {
  const groups = new Map<string, string[]>();
  for (const one of failures) {
    const held = groups.get(one.message);
    if (held === undefined) groups.set(one.message, [one.name]);
    else held.push(one.name);
  }
  return [...groups.entries()].map(([message, names]) => `${names.join(", ")}: ${message}`).join(" ");
}

/**
 * What went wrong, for the live region under the table.
 *
 * ⚠ **The messages themselves while there are few of them.** `failureSummary`
 * answers *which machines* and sends the reader to the rows — which works for a
 * sighted reader and is a dead end in a live region, where the row's own words are
 * in a plain `<span>` that is never announced. So a screen reader was told that a
 * failure existed and pointed at text it would never read out.
 *
 * Past {@link NAMES_BEFORE_COUNT} it falls back to that same count form rather
 * than reading out six paragraphs, which is `installedSummary`'s rule and its
 * reason — and it is the shared function rather than a fourth phrasing of it, so
 * the two cannot come to disagree about where the line is.
 */
function failureDetail(failures: readonly { name: string; message: string }[]): string {
  if (failures.length === 0) return "";
  if (failures.length > NAMES_BEFORE_COUNT) return failureSummary(failures.map((one) => one.name));
  return failures.map((one) => `Failed on ${one.name} — ${one.message}`).join(" ");
}

/**
 * What an act finished, as the other half of {@link failureDetail}.
 *
 * The three verbs are kept apart because they answer different questions: a fleet
 * where two machines were already current and two were not is one act with two
 * true sentences, and collapsing them into "installed" would say the wrong one
 * about half the hosts.
 *
 * {@link NAMES_BEFORE_COUNT} rather than a fourth `3`, and names before a count for
 * `installedSummary`'s reason: a name answers "which one", and a list of six is a
 * paragraph where a sentence belongs.
 */
function doneSummary(installed: readonly string[], updated: readonly string[], removed: readonly string[]): string {
  const part = (verb: string, names: readonly string[]): string[] => {
    if (names.length === 0) return [];
    return [names.length <= NAMES_BEFORE_COUNT ? `${verb} ${names.join(", ")}.` : `${verb} ${names.length} machines.`];
  };
  return [...part("Installed on", installed), ...part("Updated on", updated), ...part("Removed from", removed)].join(" ");
}

/**
 * What the bar asks before it puts a plugin onto several machines at once.
 *
 * ⚠ **It names what an install actually is, because nothing else on this screen
 * does.** A plugin is a child process running as this user, with these files, this
 * `~/.ssh` and these repositories — `manifest.scopes` is hygiene rather than a
 * fence — and the count is the multiplier on all of it. The plugin is named for the
 * same reason a removal names its machines: a question that could be about anything
 * is one people learn to answer without reading.
 *
 * {@link removalQuestion}'s shape one file over — one sentence, the count where it
 * has one — so the two questions in this bar read as one control asking twice
 * rather than as two screens. There is no singular arm because there is no
 * singular question: one machine installs on the press, so `count` is always at
 * least two here. See {@link Confirming}.
 */
function installQuestion(name: string, count: number): string {
  return `Install ${name} on ${count} machines? It runs on each of them as you, with your files.`;
}

/** Which of {@link Done} an act's answer was, or `null` where nothing was sent. */
function doneOf(outcome: TargetOutcome | null): Done | null {
  if (outcome === null) return null;
  // Total over the union rather than a cast: `TargetOutcome` also carries the
  // states this screen never returns from a job — `pending`, `sending`, `skipped`,
  // `failed` — and none of them is something that finished.
  if (outcome.kind === "installed" || outcome.kind === "updated" || outcome.kind === "removed") return outcome.kind;
  return null;
}
