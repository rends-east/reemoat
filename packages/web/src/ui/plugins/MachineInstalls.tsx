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
import { pluginFailure } from "../../plugins";
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
 * ticked. `plugin_data` still does not come back, so **only a removal is
 * confirmed** — in the bar, ending with Cancel, which is Q3.218's measured
 * property rather than an ordering preference.
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
  /** `cancellable` is literally whether this job holds a controller. See {@link act}. */
  | { kind: "working"; label: string; cancellable: boolean }
  | { kind: "failed"; message: string };

/**
 * Whether the bar is asking about a removal.
 *
 * ⚠ **There is only one question on this screen, and it is the bar's.** A row used
 * to be able to ask its own — it had a bin — and both the bin and the question went
 * together: see {@link drawnActs}. A boolean rather than the old two-armed union,
 * because with one asker there is nothing left to tell apart.
 */
type Confirming = boolean;

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
  const [confirming, setConfirming] = useState<Confirming>(false);
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
  const [needle, setNeedle] = useState("");
  const [filter, setFilter] = useState<InstallFilter>("all");
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

  const write = useCallback((id: MachineId, row: RowState | null, epoch: number): void => {
    if (epochs.current.get(id) !== epoch) return;
    setLocal((held) => {
      const next = new Map(held);
      if (row === null) next.delete(id);
      else next.set(id, row);
      return next;
    });
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
    setConfirming(false);
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
        write(id, { kind: "failed", message: "That machine is not in your list any more." }, mine.get(id) ?? 0);
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
        { kind: "working", label: what === "install" ? "installing" : "removing", cancellable: controller !== null },
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
      const once = async (): Promise<void> => {
        if (what === "remove") {
          await daemon.removePlugin(pluginId);
          return;
        }
        if (install === null || controller === null) return;
        await install(
          daemon,
          id,
          (fraction) =>
            write(id, { kind: "working", label: `${Math.round(fraction * 100)}%`, cancellable: true }, mine.get(id) ?? 0),
          controller.signal,
        );
      };
      try {
        await once();
        // Cleared rather than set to a success state: the store is about to
        // carry the answer, and a row that kept a local "installed" would be a
        // second copy of the truth that nothing invalidates.
        write(id, null, mine.get(id) ?? 0);
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
         * one.** `pluginFailure` has no arm for an abort, so it falls through to
         * "That did not work. Try again." — a failure sentence, on a row, for an
         * act the person took deliberately. The row is cleared instead, so it
         * falls back to what the store says: whatever was there before. Checked
         * before the retry, or a cancelled `plugin_busy` would wait 1.5s and
         * then send again, which is the opposite of cancelling.
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
            await once();
            write(id, null, mine.get(id) ?? 0);
            return;
          } catch (second) {
            if (calledOff()) {
              write(id, null, mine.get(id) ?? 0);
              return;
            }
            write(id, { kind: "failed", message: pluginFailure(second) }, mine.get(id) ?? 0);
            return;
          }
        }
        write(id, { kind: "failed", message: pluginFailure(error) }, mine.get(id) ?? 0);
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
  const anyCancellable = rows.some((one) => one.row.kind === "working" && one.row.cancellable);
  const failure = failureSummary(rows.filter((one) => one.row.kind === "failed").map((one) => one.name));
  const notice = settingsNotice(blockedSettings);
  const allShown = shown.length > 0 && shown.every((one) => one.selected);
  const someShown = shown.some((one) => one.selected);

  const toggle = (id: MachineId): void => {
    setConfirming(false);
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
        <label className="tap inline-flex min-h-11 shrink-0 items-center pr-1">
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
              setConfirming(false);
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
               * ⚠ **`chip` and never the `md` default.** `md` is `h-9 w-9` with no
               * growth mechanism at all — the one size in `ICON_BUTTON_SIZE` that
               * does not reach 44px — and `webcheck`'s ratchet on that may only
               * shrink. `chip` is 32px of ink reaching 44 through `TAP_GROW_Y`,
               * which grows **vertically only**, so it cannot put its target over
               * the search box's face the way a symmetric inset would.
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
         * ⚠ **Not a live region**, unlike the failure below: this changes on every
         * tick of a checkbox, and announcing that would be chatter beside a region
         * meant to speak a failure.
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
       * ⚠ **The failure, said outside the scroller.** The rows scroll, so a failure
       * on row nine of a six-row viewport is off screen, and this is the only thing
       * that speaks it. Mounted **unconditionally** with only its text swapping:
       * `EventList` and `Toast` both record that a `role="status"` inserted in the
       * same paint as its content is commonly not spoken at all, VoiceOver on iOS
       * included. `polite` rather than an alert, because this line does not expire.
       */}
      <p role="status" aria-live="polite" className={failure.length === 0 ? "" : "mt-3 text-xs wrap-anywhere text-fg"}>
        {failure}
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
        {confirming ? (
          <>
            <span className="basis-full text-xs text-muted">{removalQuestion(removableNames)}</span>
            <Button
              tone="destructive"
              size="sm"
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={() => act([], idsWith("remove"))}
            >
              Remove
            </Button>
            <Button tone="primary" size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button disabled={!can.install} onClick={() => act(idsWith("install"), [])}>
              Install
            </Button>
            <Button disabled={!can.update} onClick={() => act(idsWith("update"), [])}>
              Update
            </Button>
            <DangerButton icon={Trash2} disabled={!can.remove} onClick={() => setConfirming(true)}>
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
 * ⚠ **A `<div>` with a `<label htmlFor>`, never a `<label>` wrapping the row.** The
 * draft's row *was* a label so the whole strip toggled its box — and a `<label>` may
 * hold no `<button>`. Left as one, a tap on this row's Remove icon would toggle the
 * checkbox as well. `htmlFor` buys the large target back without containing the
 * controls.
 */
function MachineRow({
  one,
  ambiguous,
  available,
  canInstall,
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
  onToggle: () => void;
  onAct: (what: RowAct) => void;
  onCancel: () => void;
}): ReactNode {
  const boxId = useId();
  const { machine, row } = one;
  return (
    <li className="border-b border-edge last:border-b-0">
        <div className={`flex min-h-11 items-center gap-2.5 px-2 py-1.5 ${row.kind === "blocked" ? "opacity-60" : ""}`}>
          <input
            id={boxId}
            type="checkbox"
            checked={one.selected}
            disabled={row.kind === "blocked"}
            onChange={onToggle}
            className="h-4 w-4 shrink-0"
          />
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
              {sublineFor(row, canInstall, available)}
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

/** What one row says about itself under its name. */
function sublineFor(row: RowState, canInstall: boolean, available: string | null): string {
  switch (row.kind) {
    case "installed":
      return installedSubline(row.version, available, row.enabled);
    case "absent":
      // Says why there is no Install icon, rather than leaving a row that offers
      // nothing and does not say so.
      return canInstall ? "not installed" : "not installed — this plugin did not come from the market";
    case "blocked":
      return skipText(row.reason);
    case "working":
      return row.label;
    case "failed":
      return row.message;
  }
}
