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

// Where this plugin is: a table with per-row acts and a bar acting on the ticked rows. Removal and a fleet install ask first, in the bar only (Q3.218, Q3.469).
// Every enablement and word is decided in install.ts, and a row the filter hides stays selected.

const BUSY_RETRY_MS = 1_500;

// Past this a working row shows elapsed seconds: no install step is on the wire, so time is all the client knows.
const ELAPSED_AFTER_MS = 10_000;

// Each 2 MiB upload shares one uplink against its own wall clock; above about four at once they all time out.
const MAX_MACHINES_AT_ONCE = 4;

/** What to do on one machine. The signal is this component's, one controller per machine; arity is not checked, so never drop it. */
export type InstallAct = (
  daemon: DaemonClient,
  machineId: MachineId,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
) => Promise<TargetOutcome>;

type RowState =
  | { kind: "installed"; version: string; enabled: boolean }
  | { kind: "absent" }
  | { kind: "blocked"; reason: SkipReason }
  /** cancellable is whether this job holds a controller; since is the press, not when the job left the queue. */
  | { kind: "working"; label: string; cancellable: boolean; since: number }
  /** consent marks a broken consent, whose paragraph is drawn above the table rather than on the row. */
  | { kind: "failed"; message: string; consent: boolean };

/** Which question the bar asks: a removal, or an install on more than one machine. Both replace the bar in place and end with Cancel. */
type Confirming = "remove" | "install" | null;

/** What an act finished on one machine. Never a RowState, since the store carries what is installed. */
type Done = "installed" | "updated" | "removed";

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
  /** null where this screen cannot install, such as a plugin that arrived as a file with no repo and commit. */
  install: InstallAct | null;
  /** The catalogue's version; without it no row offers Update and removal is the only path. */
  available?: string | null;
  /** Derived from the rows, since acts overlap; for a caller whose own controls would unmount this. */
  onBusyChange?: (busy: boolean) => void;
  heading?: string;
  /** A callback so this stays router-free and the import screen can decline it. */
  onConfigure?: (machines: readonly MachineId[]) => void;
}): ReactNode {
  const [confirming, setConfirming] = useState<Confirming>(null);
  /** The ticked machines: pointer state, not derived from the store, and not cleared by an act. */
  const [chosen, setChosen] = useState<ReadonlySet<MachineId>>(new Set());
  const [local, setLocal] = useState<ReadonlyMap<MachineId, RowState>>(new Map());
  const [finished, setFinished] = useState<ReadonlyMap<MachineId, Done>>(new Map());
  const [needle, setNeedle] = useState("");
  const [filter, setFilter] = useState<InstallFilter>("all");
  const [now, setNow] = useState(0);
  /** Per-machine act epochs, so overlapping acts on different rows cannot discard each other's answers. */
  const epochs = useRef(new Map<MachineId, number>());
  const inFlight = useRef(new Map<MachineId, AbortController>());
  const noticeId = useId();
  /** Focus goes to the question, not the armed button, so a repeating Enter cannot complete a removal. */
  const askRef = useRef<HTMLParagraphElement | null>(null);
  /** Whether the one-machine fleet was ticked; a ref, so a poll cannot re-tick a row somebody unticked. */
  const seeded = useRef(false);
  const busy = [...local.values()].some((one) => one.kind === "working");

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // Date.now at each tick, so a phone that slept shows the true elapsed time.
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [busy]);

  // A fleet of one arrives ticked, once; a machine still being asked latches nothing, and a blocked one is never ticked.
  useEffect(() => {
    if (seeded.current || state.machines.length === 0) return;
    const only = state.machines.length === 1 ? state.machines[0] : undefined;
    const reason = only === undefined ? null : skipReasonFor(only);
    if (reason === "asking") return;
    seeded.current = true;
    if (only === undefined || reason !== null) return;
    setChosen(new Set([only.id]));
  }, [state.machines]);

  // Focused as well as announced: an alert inserted in the same paint as its text is often not spoken.
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

  /** Records a finished act under the same epoch gate; null for nothing sent or any failure, cancellation included. */
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

  /** Aborts every install in flight. Removals hold no controller and finish; each job deletes its own entry. */
  const cancelAll = (): void => {
    for (const controller of inFlight.current.values()) controller.abort();
  };

  const act = (adding: readonly MachineId[], removing: readonly MachineId[]): void => {
    setConfirming(null);
    const mine = new Map<MachineId, number>();
    for (const id of [...adding, ...removing]) {
      const next = (epochs.current.get(id) ?? 0) + 1;
      epochs.current.set(id, next);
      mine.set(id, next);
    }
    setFinished((held) => {
      const next = new Map(held);
      for (const id of [...adding, ...removing]) next.delete(id);
      return next;
    });
    const pressedAt = Date.now();
    const jobs = [
      ...adding.map((id) => ({ id, what: "install" as const })),
      ...removing.map((id) => ({ id, what: "remove" as const })),
    ];

    // Every row is marked and every controller minted before the pool starts, so a queued job is cancellable from the press.
    const queued: {
      id: MachineId;
      what: "install" | "remove";
      daemon: DaemonClient;
      controller: AbortController | null;
    }[] = [];
    for (const { id, what } of jobs) {
      const daemon = store.daemonFor(id);
      if (daemon === undefined) {
        write(
          id,
          { kind: "failed", message: MACHINE_GONE, consent: false },
          mine.get(id) ?? 0,
        );
        continue;
      }
      // One controller per install job, kept across the retry; a removal has none and still reports its failures.
      const controller = what === "install" && install !== null ? new AbortController() : null;
      if (controller !== null) inFlight.current.set(id, controller);
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

    /** Settles rather than rejects, or the worker running it would die and shrink the pool. */
    const run = async ({ id, what, daemon, controller }: (typeof queued)[number]): Promise<void> => {
      const calledOff = (): boolean => controller?.signal.aborted === true;
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
              { kind: "working", label: `${Math.round(fraction * 100)}%`, cancellable: true, since: pressedAt },
              mine.get(id) ?? 0,
            ),
          controller.signal,
        );
      };
      try {
        const outcome = await once();
        write(id, null, mine.get(id) ?? 0);
        finish(id, doneOf(outcome), mine.get(id) ?? 0);
      } catch (error) {
        // Only plugin_busy is retried, once: a POST is not replayable, and a remove retries in machine.ts.
        // A cancelled upload is not a failure: the row is cleared, and it is checked before the retry so a cancel never resends.
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
        inFlight.current.delete(id);
        store.refreshPlugins(id);
      }
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        // next is claimed and advanced with no await between, so two workers cannot draw the same job.
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
    // plugin is the daemon's own answer and never overlaid; row is the local overlay for this act.
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
  const failures = rows.flatMap((one) =>
    one.row.kind === "failed" ? [{ name: one.name, message: one.row.message, consent: one.row.consent }] : [],
  );
  const consentAlert = consentAlertText(failures.filter((one) => one.consent));
  const failure = failureDetail(failures.filter((one) => !one.consent));
  const doneNames = (kind: Done): string[] =>
    rows.filter((one) => finished.get(one.machine.id) === kind).map((one) => one.name);
  const said = [doneSummary(doneNames("installed"), doneNames("updated"), doneNames("removed")), failure]
    .filter((one) => one.length > 0)
    .join(" ");
  const named = rows.find((one) => one.plugin !== null)?.plugin?.name ?? (pluginId.length > 0 ? pluginId : "this plugin");
  const notice = settingsNotice(blockedSettings);
  const allShown = shown.length > 0 && shown.every((one) => one.selected);
  const someShown = shown.some((one) => one.selected);

  const toggle = (id: MachineId): void => {
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
      {heading.length > 0 && <h2 className={SETTINGS_HEADING}>{heading}</h2>}

      {state.machines.length > 1 && (
        <p className="mt-1 text-2xs text-muted">
          Tick machines to act on several at once{canInstall ? ", or use a row's own button for one." : "."}
        </p>
      )}

      {/* Always mounted with only the text swapping, and assertive: it describes authority nobody agreed to give. */}
      <p
        role="alert"
        className={consentAlert.length === 0 ? "" : "mt-2 rounded-md border border-edge-strong px-3 py-2 text-sm wrap-anywhere text-fg"}
      >
        {consentAlert}
      </p>

      {/* A definite height, so typing in the search cannot move the bar; 15.25rem leaves 3.5 rows, and the half row shows it scrolls. */}
      <div className="mt-2 flex h-[15.25rem] flex-col overflow-hidden rounded-md border border-edge">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-2">
        <label className="tap inline-flex min-h-11 shrink-0 items-center px-2">
          <input
            type="checkbox"
            ref={(el) => {
              if (el !== null) el.indeterminate = someShown && !allShown;
            }}
            checked={allShown}
            disabled={shown.length === 0}
            onChange={() => {
              setConfirming(null);
              // Over the shown rows only, so a filter change never deselects hidden ones.
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
        <Menu
          align="right"
          panelClassName="w-44"
          className="shrink-0"
          trigger={(open, toggleMenu) => (
            <IconButton
              icon={ListFilter}
              label={`Showing ${FILTERS.find((one) => one.value === filter)?.label ?? "All"}`}
              size="chip"
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

      {/* No overscroll-contain: Chrome ends the scroll chain at a contained box even when it has nothing to scroll. */}
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
        {/* Inside the fixed-height box, so no string it holds can move the bar; deliberately not a live region. */}
        <p
          id={noticeId}
          title={notice || undefined}
          className="flex h-6 shrink-0 items-center truncate border-t border-edge px-2 text-2xs text-muted"
        >
          {notice || (chosenRows.length === 0 ? "" : selectionLine(chosenRows.length, hidden))}
        </p>
      </div>

      {/* Always mounted with only its text swapping, or a status inserted with its content is often not spoken. */}
      <p role="status" aria-live="polite" className={said.length === 0 ? "" : "mt-3 text-xs wrap-anywhere text-fg"}>
        {said}
      </p>
      {/* The destructive control sits in the middle; not disabled while working, since busy rows offer no acts. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming !== null ? (
          <>
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
              // Outlined rather than destructive: the red is spent on the irreversible removal, and the filled button in a pair is Cancel.
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
            {/* A fan-out asks and one machine acts; installTargets is shared, so the question's count and the act's list agree. */}
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

/** A div with labels pointing at the box, never a label wrapping the row, which may hold no button. */
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
  now: number;
  onToggle: () => void;
  onAct: (what: RowAct) => void;
  onCancel: () => void;
}): ReactNode {
  const boxId = useId();
  const { machine, row } = one;
  // A machine still being asked keeps its box but draws no acts, and is not dimmed as out.
  const waiting = row.kind === "blocked" && row.reason === "asking";
  const out = row.kind === "blocked" && !waiting;
  return (
    <li className="border-b border-edge last:border-b-0">
        <div className={`flex min-h-11 items-center gap-2.5 px-2 py-1.5 ${out ? "opacity-60" : ""}`}>
          {/* The label pads the box, since a native checkbox cannot be grown; -m-2 keeps its footprint, and no min-h-11 or every row grows. */}
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
            {/* A failure is not truncated: the clipped half is what identifies it. */}
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
                // lg, never sm: adjacent sm targets overlap and the later, destructive one wins the hit test.
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

function sublineFor(row: RowState, canInstall: boolean, available: string | null, now: number): string {
  switch (row.kind) {
    case "installed":
      return installedSubline(row.version, available, row.enabled);
    case "absent":
      return canInstall ? "not installed" : "not installed — this plugin did not come from the market";
    case "blocked":
      return skipText(row.reason);
    case "working": {
      const elapsed = now - row.since;
      return elapsed < ELAPSED_AFTER_MS ? row.label : `${row.label} · ${Math.round(elapsed / 1000)}s`;
    }
    case "failed":
      return row.consent ? "refused — see the notice above the table" : row.message;
  }
}

/** A broken consent arrives as ConsentBrokenError on import or plugin_consent_broken from the market; both draw the same. */
function isConsentFailure(cause: unknown): boolean {
  if (ConsentBrokenError.isConsentBroken(cause)) return true;
  return ApiError.isApiError(cause) && cause.code === "plugin_consent_broken";
}

/** Grouped by message, since daemons usually answer identically; every machine is named. */
function consentAlertText(failures: readonly { name: string; message: string }[]): string {
  const groups = new Map<string, string[]>();
  for (const one of failures) {
    const held = groups.get(one.message);
    if (held === undefined) groups.set(one.message, [one.name]);
    else held.push(one.name);
  }
  return [...groups.entries()].map(([message, names]) => `${names.join(", ")}: ${message}`).join(" ");
}

/** The messages themselves up to NAMES_BEFORE_COUNT, since a live region cannot point at the rows. */
function failureDetail(failures: readonly { name: string; message: string }[]): string {
  if (failures.length === 0) return "";
  if (failures.length > NAMES_BEFORE_COUNT) return failureSummary(failures.map((one) => one.name));
  return failures.map((one) => `Failed on ${one.name} — ${one.message}`).join(" ");
}

function doneSummary(installed: readonly string[], updated: readonly string[], removed: readonly string[]): string {
  const part = (verb: string, names: readonly string[]): string[] => {
    if (names.length === 0) return [];
    return [names.length <= NAMES_BEFORE_COUNT ? `${verb} ${names.join(", ")}.` : `${verb} ${names.length} machines.`];
  };
  return [...part("Installed on", installed), ...part("Updated on", updated), ...part("Removed from", removed)].join(" ");
}

function installQuestion(name: string, count: number): string {
  return `Install ${name} on ${count} machines? It runs on each of them as you, with your files.`;
}

function doneOf(outcome: TargetOutcome | null): Done | null {
  if (outcome === null) return null;
  if (outcome.kind === "installed" || outcome.kind === "updated" || outcome.kind === "removed") return outcome.kind;
  return null;
}
