import { ChevronRight } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { isNewer } from "../../catalogue";
import type { DaemonClient } from "../../daemon";
import { ApiError } from "../../http";
import type { MachineId } from "../../ids";
import {
  draftAct,
  draftLabel,
  failureSummary,
  installedSummary,
  outcomeText,
  removalQuestion,
  skipReasonFor,
  skipText,
  type SkipReason,
  type TargetOutcome,
} from "../../install";
import type { MachineState } from "../../machine";
import { pluginFailure } from "../../plugins";
import { machineBadgeText } from "../../quota";
import { store, type AppState } from "../../store";
import { ambiguousNames } from "../../wire";
import { Badge, Button, Empty, Icon, SETTINGS_HEADING, Spinner } from "../bits";

/**
 * Where this plugin is, and changing that.
 *
 * ⚠ **The boxes are a *draft* of where it should be, and one button at the foot
 * applies the whole draft.** They were the live state for a while — ticking
 * installed, unticking removed — and the thing that model cannot express is the
 * ordinary act: *move* a plugin from one machine to another. Untick, wait, tick,
 * wait is two irreversible steps with no way back between them, and a mis-tap in
 * the middle leaves a fleet in a state nobody asked for. Drafting first makes the
 * whole change one act, reviewable before it happens, and abandonable by walking
 * away.
 *
 * ⚠ **What the button says is derived from the draft, and it is the only place
 * the act is named.** `Install` where the draft only adds, `Remove` where it only
 * takes away, `Reconfigure` where it does both at once — the case that motivated
 * the redraft — and `Reinstall` where the machine set is unchanged but something
 * on it is behind the version the catalogue carries. That last arm is why the
 * separate *"2 machines have an older copy — Update to 0.3.0"* strip is gone: it
 * was a second button, in the middle of the screen, for a third of this button's
 * job.
 *
 * ⚠ **Disabled until the draft differs from what is installed.** A live button
 * over an unchanged draft would be a control that re-sends an archive to machines
 * that already have that exact commit — a request nobody asked for, which a
 * daemon has to unpack before it can discover is a no-op.
 *
 * ⚠ **The list is collapsed, and that is a size decision rather than a taste
 * one.** A fleet is unbounded; a plugin page that opened with every machine
 * listed grew without limit down a phone. The line on the closed row carries the
 * answer most people came for (`installedSummary`), so opening it is for changing
 * something rather than for finding out.
 *
 * ⚠ **The confirmation is on the button, never on a row.** It guards the act, and
 * the act is now the whole draft — a per-row confirm asked about a step that no
 * longer exists on its own, and asked it in the middle of a list somebody was
 * still editing. It replaces the button's own strip and **ends with Cancel**,
 * which is the settings rule and a measured safety property rather than an
 * ordering preference: both groups lay out in the same box, so the last child
 * occupies the same pixels and a second tap aimed at a control that looked inert
 * lands on the undo.
 *
 * ⚠ **Only a removal is confirmed.** Installing is undone by unticking and
 * pressing again; uninstalling takes the plugin's `plugin_data` with it and
 * nothing brings that back. A prompt in front of the reversible half is how the
 * prompt in front of the irreversible one stops being read.
 */

/** How long to wait before the one retry a busy machine gets. */
const BUSY_RETRY_MS = 1_500;

/**
 * What to do on one machine. Returns what happened, so the row can say it.
 *
 * ⚠ **`signal` is supplied by this component, one controller per machine.** A
 * caller that constructs its own is a caller whose upload cannot be called off —
 * which is what `InstalledList` did, on the one screen that reaches a whole fleet.
 * Per machine rather than one for the act, because a machine that fails or is
 * cancelled individually must not abort the four beside it.
 */
export type InstallAct = (
  daemon: DaemonClient,
  machineId: MachineId,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => Promise<TargetOutcome>;

/** What one row is, once everything that decides it has been asked. */
type RowState =
  | { kind: "installed"; version: string }
  | { kind: "absent" }
  /** Reachable-but-refusing, or not reachable at all. Never tickable. */
  | { kind: "blocked"; reason: SkipReason }
  | { kind: "working"; label: string }
  | { kind: "failed"; message: string };

export function MachineInstalls({
  pluginId,
  state,
  install,
  available = null,
  onBusyChange,
  heading = "Install",
}: {
  pluginId: string;
  state: AppState;
  /**
   * How to install, or `null` where this screen cannot.
   *
   * `null` on an installed plugin the catalogue does not carry — a plugin that
   * arrived as a file has no `{repo, commit}` to hand a second daemon, so the only
   * honest thing that screen can offer is removal. Ticking is disabled and says so
   * rather than being absent, because a box that vanishes is one somebody looks
   * for.
   */
  install: InstallAct | null;
  /**
   * The version the catalogue has, when there is one.
   *
   * Feeds the `Reinstall` arm: a machine ticked, installed, and behind this is
   * something to do even though the draft matches what is installed. Without it
   * there is no gesture for an update at all, because a ticked box ticked again
   * is nothing.
   */
  available?: string | null;
  /**
   * Told when an act starts and when the last of it settles.
   *
   * For a caller that draws controls of its own beside this one — `ImportPlugin`
   * has "Choose another file" and "Done", either of which unmounts this component
   * — and therefore needs to know not to. Optional, because the market entry has
   * nothing beside it to gate.
   */
  onBusyChange?: (busy: boolean) => void;
  heading?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  /** Whether the foot is asking about the removals in the draft. */
  const [confirming, setConfirming] = useState(false);
  /**
   * The draft, as *overrides* rather than as a set of ticked machines.
   *
   * ⚠ **Only machines somebody actually toggled are in here**, and everything
   * else reads through to what the store says. A plain set would have to be seeded
   * from the store and then re-seeded on every refresh — and a refresh lands after
   * every act, so a draft held as a set would be silently overwritten by the very
   * answer it produced.
   */
  const [picks, setPicks] = useState<ReadonlyMap<MachineId, boolean>>(new Map());
  /**
   * What this screen did, per machine, overlaying what the store says.
   *
   * Needed because the store is the truth only *between* acts: while a request is
   * out there is no row to read, and a refusal is a fact about this attempt that
   * `pluginsByMachine` will never carry. Cleared per machine as soon as the store
   * has been refreshed, so it never becomes a second copy of the state.
   */
  const [local, setLocal] = useState<ReadonlyMap<MachineId, RowState>>(new Map());
  /**
   * Which run the answers landing now belong to.
   *
   * A ref because nothing on screen reads it. Two acts in a row are ordinary, and
   * a slow first answer must not overwrite a row the second has since moved on.
   * `PluginScreen` keeps the same gate with `liveRoute`, for the same reason.
   */
  const generation = useRef(0);
  /**
   * The controller for each machine with a request in flight.
   *
   * A ref because nothing on screen reads it — Cancel is drawn from `busy`, which
   * is derived from the rows. Entries are deleted as each machine settles, so the
   * map is exactly "what is still cancellable" and Cancel over an empty one is a
   * no-op rather than a lie.
   */
  const inFlight = useRef(new Map<MachineId, AbortController>());
  /**
   * Whether the act now running has anything that can actually be called off.
   *
   * ⚠ **State rather than a read of {@link inFlight}, because a ref cannot drive a
   * render** — which is what made the first version of this dishonest. The button
   * was gated on `install !== null`, a fact about the *screen*, so a removal-only
   * act drew a live Cancel over an act that holds no controller at all. Set from
   * the drafted jobs and cleared with `busy`.
   */
  const [cancellable, setCancellable] = useState(false);

  const write = useCallback((id: MachineId, row: RowState | null, epoch: number): void => {
    if (generation.current !== epoch) return;
    /*
     * ⚠ **A failure opens the list it is being written into.** The panel below is
     * `inert` and collapsed until somebody presses Machines, and the subline on a
     * row inside it is the only per-machine reason this screen holds — so a
     * fan-out that was refused on three hosts wrote three messages into a box
     * nobody could see, and the closed row went on saying `installedSummary`,
     * which is derived from what is installed and therefore just leaves a failed
     * machine out. The tick that reaches the whole fleet is *above* the
     * disclosure, which makes All machines → Install the one path that never
     * opens the panel at all.
     *
     * Only `failed` does this. A `working` row is already announced by the
     * spinner on the closed row, and a cleared row is the store's answer arriving
     * — neither is a reason to move something under somebody's thumb. Nothing
     * live moves with it either: `act` cleared `picks`, and a failed row reads
     * `installed === false`, so `draftAct` still answers `ready: false` and the
     * button below is disabled in the frame the panel opens in.
     */
    if (row?.kind === "failed") setOpen(true);
    setLocal((held) => {
      const next = new Map(held);
      if (row === null) next.delete(id);
      else next.set(id, row);
      return next;
    });
  }, []);

  const rowFor = (machine: MachineState): RowState => {
    const held = local.get(machine.id);
    if (held !== undefined) return held;
    const blocked = skipReasonFor(machine);
    if (blocked !== null) return { kind: "blocked", reason: blocked };
    const found = state.pluginsByMachine.get(machine.id)?.find((one) => one.id === pluginId);
    return found === undefined ? { kind: "absent" } : { kind: "installed", version: found.version };
  };

  const pick = (id: MachineId, want: boolean): void => {
    setConfirming(false);
    setPicks((held) => {
      const next = new Map(held);
      next.set(id, want);
      return next;
    });
  };

  /**
   * Call off everything still in flight.
   *
   * Only an *install* carries a controller — a remove is a `DELETE` that has
   * already been sent by the time there is anything to cancel, and it inherits its
   * own retry one layer down in `machine.ts`. So this stops uploads and leaves
   * removals to finish, which is the honest thing: the bytes are what somebody is
   * waiting on and the bytes are what this stops.
   */
  const cancelAll = (): void => {
    /*
     * ⚠ **Aborting the controllers is the whole of it, and there is deliberately
     * no act-wide flag.** There was one, and it was wrong in two directions at
     * once: it silenced a *removal's* failure — which this docblock promises to
     * let run — and it silenced the `plugin_busy` retry, so a 409 arriving after
     * Cancel cleared its row instead of waiting 1.5s and asking again. The guard
     * below asks each request's own signal whether **it** was called off, which is
     * the question that was always meant.
     *
     * The map is not cleared: each job removes its own entry in its `finally`, so
     * clearing here would only lose the ability to abort a retry that is still to
     * come.
     */
    for (const controller of inFlight.current.values()) controller.abort();
  };

  const act = (adding: readonly MachineId[], removing: readonly MachineId[]): void => {
    const epoch = (generation.current += 1);
    onBusyChange?.(true);
    /*
     * ⚠ **Whether this act has anything abortable, which is not the same question
     * as whether this screen can install.** The button was drawn from
     * `install !== null` — a fact about the *screen* — so a removal-only act drew
     * a live Cancel over an act holding no controller at all, and pressing it did
     * nothing. `adding` and `behind` are the jobs that carry one.
     */
    setCancellable(adding.length > 0);
    setConfirming(false);
    /*
     * The draft is spent the moment it is applied. Rows fall back to what the
     * store and `local` say — "installing", then the real answer — so a draft kept
     * past the act would be a second claim about the same machine, and a failed
     * install would leave a ticked box over a plugin that is not there.
     */
    setPicks(new Map());
    for (const id of adding) write(id, { kind: "working", label: "installing" }, epoch);
    for (const id of removing) write(id, { kind: "working", label: "removing" }, epoch);

    const jobs = [
      ...adding.map((id) => ({ id, what: "install" as const })),
      ...removing.map((id) => ({ id, what: "remove" as const })),
    ];

    void Promise.allSettled(
      jobs.map(async ({ id, what }) => {
        const daemon = store.daemonFor(id);
        if (daemon === undefined) {
          // The list moved under the act — a machine revoked in another tab. Said
          // on its own row rather than thrown, because every other machine in this
          // act is still going.
          write(id, { kind: "failed", message: "That machine is not in your list any more." }, epoch);
          return;
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
            (fraction) => write(id, { kind: "working", label: `${Math.round(fraction * 100)}%` }, epoch),
            controller.signal,
          );
        };
        try {
          await once();
          // Cleared rather than set to a success state: the store is about to
          // carry the answer, and a row that kept a local "installed" would be a
          // second copy of the truth that nothing invalidates.
          write(id, null, epoch);
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
            write(id, null, epoch);
            return;
          }
          if (ApiError.isApiError(error) && error.code === "plugin_busy") {
            await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
            if (calledOff()) {
              write(id, null, epoch);
              return;
            }
            try {
              await once();
              write(id, null, epoch);
              return;
            } catch (second) {
              if (calledOff()) {
                write(id, null, epoch);
                return;
              }
              write(id, { kind: "failed", message: pluginFailure(second) }, epoch);
              return;
            }
          }
          write(id, { kind: "failed", message: pluginFailure(error) }, epoch);
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
      }),
    ).finally(() => {
      // The whole act has settled, which is the only moment a caller drawing
      // controls beside this one can safely offer them again. Gated on the epoch
      // for `write`'s reason: a slow first act must not re-enable the foot over a
      // second one that is still running.
      if (generation.current !== epoch) return;
      onBusyChange?.(false);
      setCancellable(false);
    });
  };

  if (state.machines.length === 0) {
    return (
      <div>
        {heading.length > 0 && <h2 className={SETTINGS_HEADING}>{heading}</h2>}
        <Empty>You have no machines yet, so there is nowhere to put a plugin.</Empty>
      </div>
    );
  }

  const rows = state.machines.map((machine) => {
    const row = rowFor(machine);
    const installed = row.kind === "installed";
    const tickable = row.kind !== "blocked" && row.kind !== "working";
    return { machine, row, installed, tickable, ticked: (tickable ? picks.get(machine.id) : undefined) ?? installed };
  });
  type Row = (typeof rows)[number];

  const changeable = rows.filter((one) => one.tickable);
  const allOn = changeable.length > 0 && changeable.every((one) => one.ticked);
  /*
   * The draft, as the two lists the button acts on.
   *
   * `adding` is empty where this screen cannot install at all, so a plugin that
   * arrived as a file can never draft an install it has no archive for.
   */
  const adding: Row[] = install === null ? [] : changeable.filter((one) => one.ticked && !one.installed);
  const removing: Row[] = changeable.filter((one) => !one.ticked && one.installed);
  /*
   * Ticked, installed, and older than what the catalogue carries. `isNewer`
   * compares numerically component by component — `0.10.0` really is newer than
   * `0.9.0`, which a string comparison gets backwards and would report for ever.
   *
   * These ride along with whatever else the button does, so a fleet ends up on the
   * version this screen has been showing all along rather than one press short of
   * it.
   */
  const behind: Row[] =
    available == null || install === null
      ? []
      : changeable.filter((one) => one.ticked && one.row.kind === "installed" && isNewer(available, one.row.version));

  const busy = rows.some((one) => one.row.kind === "working");
  const installing = [...adding, ...behind];
  const anywhere = rows.some((one) => one.installed);
  const ambiguous = ambiguousNames(state.machines);
  /*
   * The machines this screen's own act could not reach, as the one sentence the
   * foot draws. Read through `rowFor` off `local` rather than off the store,
   * because a refusal is a fact about *this attempt* and `pluginsByMachine` will
   * never carry one — which is the same reason `local` exists at all.
   */
  const failure = failureSummary(rows.filter((one) => one.row.kind === "failed").map((one) => one.machine.name));

  /*
   * ⚠ **The word on the button and whether it moves are decided outside this
   * file, and that is the point.** `draftAct` is pure and DOM-free, so `webcheck`
   * sweeps the whole space — three sizes in each of three directions, both flags —
   * rather than the handful of cases somebody thought to write down. Left inline
   * it was a nested ternary nothing checked, in the one place on this screen where
   * being wrong means a person presses a control that does something other than
   * what it says.
   */
  const { act: what, ready } = draftAct({
    adding: adding.length,
    updating: behind.length,
    removing: removing.length,
    canInstall: install !== null,
    anywhere,
  });
  const label = draftLabel(what);

  return (
    <div>
      {/* Empty where the caller already named the thing — an installed row says
          the plugin's name two lines up, and a heading under it would be a label
          for a list that is plainly the machines. An empty `<h2>` is not the same
          as none: it is a heading in the accessibility tree with no text. */}
      {heading.length > 0 && <h2 className={SETTINGS_HEADING}>{heading}</h2>}

      {/*
       * ⚠ **44px, `UsersSection`'s idiom**: the `<label>` wraps the input so the
       * whole strip toggles it, and `w-fit` keeps that strip the width of the
       * control and its words — a full-bleed toggle catches taps aimed at nothing.
       *
       * It drafts rather than acts, so the sentence that used to sit under it —
       * that "all" means the machines in this list *right now* — went with the act
       * it was warning about. Nothing expands until the button is pressed, and
       * what it expands to is the list one line down, open.
       */}
      <label className="mt-1 inline-flex min-h-11 w-fit items-center gap-2 pr-2 text-xs text-fg">
        <input
          type="checkbox"
          checked={allOn}
          disabled={busy || changeable.length === 0 || (install === null && !allOn)}
          onChange={() => {
            const want = !allOn;
            setConfirming(false);
            setPicks(new Map(changeable.map((one) => [one.machine.id, want])));
          }}
          className="h-4 w-4 shrink-0"
        />
        All machines
      </label>

      {/*
       * The closed row carries the answer, so opening it is for *changing*
       * something rather than for finding out. A `<button>` rather than
       * `<details>` because the disclosure state has to survive a re-render this
       * component drives itself — the store refresh after every act.
       */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={`machines-${pluginId}`}
        className="tap flex min-h-11 w-full items-center gap-2 text-left text-xs text-muted hover:text-fg"
      >
        {/* The caret is the one thing this codebase already animates on a
            disclosure, and it turns with the panel rather than before it. */}
        <Icon
          as={ChevronRight}
          size={14}
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 text-fg">Machines</span>
        <span className="min-w-0 flex-1 truncate">
          {installedSummary(
            state.machines.length,
            rows.filter((one) => one.installed).map((one) => one.machine.name),
          )}
        </span>
        {busy && <Spinner />}
      </button>

      {/*
       * ⚠ **`0fr` → `1fr` on a grid row, which is the one way to animate to a
       * height nothing has measured.** A fleet is unbounded, so there is no
       * `max-height` to transition to that is not either a cap on the list or a
       * lie about its speed. The transition names its property — `transition: all`
       * is banned here for a measured reason, and a list that re-renders on every
       * store refresh is exactly the smear that ban is about. `prefers-reduced-
       * motion` is already handled globally in `index.css`, which zeroes every
       * transition duration in the document rather than asking each one to
       * remember.
       *
       * ⚠ **`inert` while closed, and it is not decoration.** The rows stay
       * mounted so there is something to animate, and a mounted checkbox behind
       * `overflow-hidden` is still in the tab order and still reachable by a
       * screen reader — a fleet's worth of invisible controls sitting between the
       * disclosure and the button.
       */}
      <div
        id={`machines-${pluginId}`}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <ul className="flex flex-col">
            {rows.map(({ machine, row, ticked, tickable }) => (
              <li key={machine.id} className="border-b border-edge last:border-b-0">
                <label
                  className={`flex min-h-11 items-center gap-2.5 py-1.5 ${row.kind === "blocked" ? "opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={busy || !tickable || (!ticked && install === null)}
                    onChange={() => pick(machine.id, !ticked)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-sm">{machine.name}</span>
                      {/* The badge orders a banned owner ahead of the limit,
                          because the remedies differ — `machineBadgeText` decides,
                          here as on the machines screen. */}
                      {machineBadgeText(machine) !== null && <Badge tone="strong">{machineBadgeText(machine)}</Badge>}
                    </span>
                    {/*
                     * ⚠ **A failure is not clipped, and it changes ink rather
                     * than weight.** `PluginView` argues the same thing one file
                     * over for a plugin's own row: `truncate` throws away the
                     * half that identifies what went wrong, and this line has
                     * nothing to open to. What lands here is a daemon's own
                     * sentence — `pluginFailure` carries `manifest_invalid`,
                     * `plugin_start_failed`, `plugin_source_invalid` and
                     * `plugin_consent_broken` through verbatim, and the last is a
                     * paragraph naming every scope the plugin gained, cut at one
                     * line to "That plugin asked for more than this screen…".
                     * `ConsentBrokenError` was added so that sentence would
                     * survive `pluginFailure`; truncating it here spent it again.
                     *
                     * `text-fg` where the row is otherwise `text-muted`, and no
                     * weight: `PluginsPanel` draws a failed single-machine
                     * install at full `text-fg` for the same reason. The
                     * transcript's Q3.207 rule — one tone for every machinery
                     * row, failures included — does not reach a settings list,
                     * where there is no run to fold into and no `X` glyph to
                     * carry it. `wrap-anywhere` rather than `break-words` to
                     * match the two places this app already draws a daemon's
                     * failure text, `Toast` and `PluginsPanel`, because these
                     * messages hold paths and ids that are single unbreakable
                     * tokens `min-w-0` cannot help with.
                     */}
                    <span
                      className={`block text-2xs ${
                        row.kind === "failed" ? "wrap-anywhere text-fg" : "truncate text-muted"
                      }`}
                    >
                      {/* The id only where the name does not tell two hosts apart
                          — a property of the list, asked once rather than per row. */}
                      {ambiguous.has(machine.name.toLowerCase()) && (
                        <>
                          <code className="text-2xs text-muted/80">{machine.id}</code>
                          {" · "}
                        </>
                      )}
                      {sublineFor(row, ticked, install, available ?? null)}
                    </span>
                  </span>
                  {row.kind === "working" && <Spinner />}
                </label>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/*
       * The foot. One control, and the confirming pair replaces it in place rather
       * than opening beside it — so the second tap of a double-tap lands on
       * Cancel, which is the last child either way.
       */}
      {/*
       * ⚠ **The failure, said out here rather than only on the row.** The panel
       * above is collapsed and `inert`, and `installedSummary` on its closed row
       * is derived from what is *installed*, so a machine that failed is omitted
       * rather than named and the act reads as a smaller fleet than the one that
       * was asked for. {@link write} opens the panel too; this is the half that
       * does not depend on somebody watching it open, and it is the only report
       * that survives the panel being closed again.
       *
       * ⚠ **Mounted unconditionally, and only its text swaps.** `EventList` and
       * `Toast` both record the same measurement: a `role="status"` inserted into
       * the DOM in the same paint as its content is commonly not spoken at all,
       * VoiceOver on iOS included, and this app is used from a phone. `polite`
       * rather than the `alert` a toast takes, because this line does not expire
       * — it stands until the next act rewrites the rows, so a reader who reaches
       * it late still reads it.
       *
       * An empty `<p>` carries no class and is zero-height under preflight's
       * margin reset, so with nothing failed the foot below keeps measuring its
       * own `mt-4` from the list exactly as before.
       */}
      <p role="status" aria-live="polite" className={failure.length === 0 ? "" : "mt-4 text-xs wrap-anywhere text-fg"}>
        {failure}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="basis-full text-xs text-muted">
              {removalQuestion(removing.map((one) => one.machine.name))}
            </span>
            <Button
              tone="destructive"
              size="sm"
              className="[@media(pointer:coarse)]:min-h-11"
              disabled={busy}
              onClick={() =>
                act(
                  installing.map((one) => one.machine.id),
                  removing.map((one) => one.machine.id),
                )
              }
            >
              {label}
            </Button>
            <Button
              tone="primary"
              size="sm"
              className="[@media(pointer:coarse)]:min-h-11"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              tone={removing.length > 0 ? "destructive" : "primary"}
              disabled={busy || !ready}
              onClick={() => {
                // Only the irreversible half is asked about. An install drafted by
                // mistake is undone by unticking it and pressing again.
                if (removing.length > 0) {
                  setConfirming(true);
                  return;
                }
                act(
                  installing.map((one) => one.machine.id),
                  [],
                );
              }}
            >
              {/*
               * ⚠ **The label stays beside the spinner rather than being replaced
               * by it.** `Spinner` is `aria-hidden` and carries no text, so
               * swapping the label out left a button with no accessible name *and*
               * no visible one — a grey box with a glyph, on the control that is
               * about to put somebody else's code on a fleet. `PluginsPanel`
               * already draws its spinner beside a percentage for the same reason.
               */}
              {busy && <Spinner />}
              {label}
            </Button>
            {/*
             * ⚠ **Cancel, and it only exists while there is something to cancel.**
             * A 2 MiB archive going to twelve machines from a phone is minutes of
             * upload that could not be called off at all — every box and the
             * button disabled by `busy`, and no third control. It sits after the
             * primary for the settings-row reason the confirming pair above gives:
             * the last child occupies the same pixels either way, so a second tap
             * aimed at a control that has just gone inert lands on the way out
             * rather than on nothing.
             */}
            {busy && cancellable && (
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

/** What one row says about itself under its name. */
function sublineFor(row: RowState, ticked: boolean, install: InstallAct | null, available: string | null): string {
  switch (row.kind) {
    case "installed":
      /*
       * ⚠ **The drafted change, where there is one, in place of the plain fact.**
       * A row whose box somebody has just unticked still reads `installed` from
       * the store and will until the button is pressed — so without this the list
       * shows a fleet that disagrees with the boxes drawn over it.
       */
      if (!ticked) return `${row.version} · will be removed`;
      if (available !== null && isNewer(available, row.version)) {
        return `${row.version} · will be updated to ${available}`;
      }
      return row.version;
    case "absent":
      if (ticked) return "will be installed";
      // Says why the box will not move, rather than leaving a dead control. The
      // remedy is on the plugin's own machine screen, which is where a file can be
      // handed to a daemon.
      return install === null ? "not installed — this plugin did not come from the market" : "not installed";
    case "blocked":
      return skipText(row.reason);
    case "working":
      return row.label;
    case "failed":
      return row.message;
  }
}

/** The row's outcome as this app words it elsewhere. Kept for a driver to reach. */
export { outcomeText };
