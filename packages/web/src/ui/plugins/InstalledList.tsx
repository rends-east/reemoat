import { ChevronRight, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { CATALOGUE_PATHS, isNewer, readCatalogue, type CatalogueEntry } from "../../catalogue";
import type { MachineId } from "../../ids";
import type { MachineState } from "../../machine";
import { marketEntryPath } from "../../market";
import type { DaemonClient } from "../../daemon";
import { installedSummary, type TargetOutcome } from "../../install";
import { peekPluginArchive, type ArchivePeek } from "../../pluginArchive";
import { consentBroken, ConsentBrokenError } from "../../plugins";
import { navigate } from "../../router";
import type { AppState } from "../../store";
import type { PluginSummary } from "../../wire";
import { Badge, Button, DangerButton, Empty, Icon, SETTINGS_HEADING, SETTINGS_SECTION } from "../bits";
import { PluginConsent } from "../PluginConsent";
import { MachineInstalls } from "./MachineInstalls";
import { useCatalogue } from "./MarketList";

/**
 * What is on your machines, gathered by plugin rather than by host.
 *
 * ⚠ **This is not a second settings screen, and the line is worth holding.** A
 * plugin's settings pane, its switch and its own screen all live inside the
 * machine it runs on — `.claude/rules/plugins.md` argues that at length, and the
 * argument is unchanged: the code is on one host's disk and its data is in one
 * daemon's database, so a fleet-wide *configuration* screen would open with a
 * dropdown asking which machine, which is a screen asking a question its own copy
 * answers.
 *
 * What this screen owns is the one question that genuinely spans machines and has
 * no home anywhere else: **where is this plugin, and where should it be.** Every
 * row links through to the machine for anything else.
 */
export function InstalledList({ state, base }: { state: AppState; base: string | null }): ReactNode {
  /*
   * The catalogue, only so a row can say an update exists. Its absence is
   * ordinary — an instance with no market still installs plugins from files — and
   * costs exactly the "update available" badge.
   */
  const read = useCatalogue(base, CATALOGUE_PATHS.list, readCatalogue);
  const catalogue = read?.kind === "ok" ? read.entries : [];

  const rows = gather(state);

  return (
    <div>
      {rows.length === 0 ? (
        <Empty>Nothing is installed on any of your machines yet.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <InstalledRow state={state} row={row} entry={catalogue.find((one) => one.id === row.id) ?? null} />
            </li>
          ))}
        </ul>
      )}

      <section className={rows.length === 0 ? "" : SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Import a plugin</h2>
        <ImportPlugin state={state} />
      </section>
    </div>
  );
}

/** One plugin, and everywhere it is. */
interface InstalledRow {
  id: string;
  name: string;
  /** Every machine holding it, with the copy that machine has. */
  on: { machine: MachineState; plugin: PluginSummary }[];
}

/**
 * One plugin, and every machine of yours that has it.
 *
 * ⚠ **Gathered by plugin id rather than by machine, which is the whole reason
 * this screen exists.** `state.pluginsByMachine` is keyed the other way — it is
 * what the rail's launcher and a machine's own settings read — and answers "what
 * is on this host". The question here is "where is this plugin", and it has no
 * home anywhere else in the app.
 */
interface Row {
  id: string;
  name: string;
  on: { machine: MachineState; plugin: PluginSummary }[];
}

/**
 * Every installed plugin across the fleet, in name order.
 *
 * Name order and not install order: a list somebody scans for a plugin they know
 * the name of must not reorder itself when a machine comes back online.
 * `machines` is walked rather than the map's keys so a plugin on a machine that
 * has dropped out of the grant list is not drawn under a host with no name.
 */
function gather(state: AppState): Row[] {
  const byId = new Map<string, Row>();
  for (const machine of state.machines) {
    for (const plugin of state.pluginsByMachine.get(machine.id) ?? []) {
      const held = byId.get(plugin.id);
      if (held === undefined) byId.set(plugin.id, { id: plugin.id, name: plugin.name, on: [{ machine, plugin }] });
      else held.on.push({ machine, plugin });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/**
 * One installed plugin, as a link to its own page.
 *
 * ⚠ **A link and nothing else, which is a deliberate retreat from what this row
 * used to be.** It held a kebab, a machine list and an install control — a second
 * place to do everything the plugin's page already does, kept in step by hand. A
 * list of what you have is a list; the acts belong on the page the row opens, and
 * having them in one place is what stops the two disagreeing.
 *
 * The same row shape the market uses, because it is the same kind of thing: a
 * plugin you tap to open. What differs is only the trailing line, which here says
 * where it actually is rather than how much of the fleet has it.
 */
function InstalledRow({ state, row, entry }: { state: AppState; row: Row; entry: CatalogueEntry | null }): ReactNode {
  const versions = [...new Set(row.on.map((one) => one.plugin.version))];
  /*
   * The update, said on the row rather than found by opening it. `isNewer`
   * compares numerically component by component — `0.10.0` really is newer than
   * `0.9.0`, which a string comparison reports backwards for ever.
   */
  const behind = entry !== null && versions.some((version) => isNewer(entry.version, version));

  return (
    <button
      onClick={() => navigate(marketEntryPath(row.id))}
      className="tap press flex w-full min-h-14 items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5 text-left hover:border-edge-strong"
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
          <span className="shrink-0 text-xs text-muted">{versions.join(", ")}</span>
          {behind && entry !== null && <Badge tone="strong">{entry.version} available</Badge>}
        </span>
        <span className="block truncate text-2xs text-muted">{whereText(state, row)}</span>
      </span>
      <Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />
    </button>
  );
}

/**
 * Which machines have it, in the words the market screen uses for the same fact.
 *
 * `installedSummary` rather than a second phrasing: this row is now the **only**
 * caller — the plugin's own page dropped its summary line when the machine table
 * started answering the same question row by row — and it is kept shared because
 * this list and that table are one tap apart. Two sentences for one fact is how
 * they come to disagree about a fleet of one.
 */
function whereText(state: AppState, row: Row): string {
  return installedSummary(
    state.machines.length,
    row.on.map((one) => one.machine.name),
  );
}

/**
 * A plugin from a file, onto as many machines as you like.
 *
 * ⚠ **The consent step is unchanged and non-negotiable: nothing is sent until the
 * archive has been read here and what it asks for is on screen.** What is new is
 * only that the same read, and the same agreed-to manifest, then reaches several
 * daemons — each of which parses the archive itself, so `consentBroken` is checked
 * against every answer rather than against one.
 *
 * The blob is re-sent per machine. There is no fleet-side staging and none is
 * proposed: an archive is at most 2 MiB on the wire, and a place to stage one would
 * be a place code sits waiting to arrive on a host nobody named it on.
 */
function ImportPlugin({ state }: { state: AppState }): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<
    { kind: "idle" } | { kind: "reading" } | { kind: "confirming"; file: File; peek: ArchivePeek }
  >({ kind: "idle" });
  /*
   * ⚠ **The separate, named press an unreadable archive costs, which this screen
   * did not charge.** `plugins.md` states the rule for both readers: an archive
   * that cannot be read *says so*, and the way past is a press of its own.
   * `PluginsPanel` keeps it — its primary button becomes "Choose another file" and
   * installing anyway is a `DangerButton` reading "Install without reading it",
   * which `webcheck` pins by name. This path drew the machine multi-select
   * regardless, so an archive nobody could describe reached *every machine at
   * once* from an ordinary tickable box — the wider blast radius with the weaker
   * gate. And because `shown` is `null` in that state, the `consentBroken` check
   * on the way back was skipped too, so nothing downstream would have caught it
   * either.
   *
   * Reset with the phase rather than beside it: a second file is a second
   * decision, and a flag that outlived its archive would wave the next one
   * through.
   */
  const [unread, setUnread] = useState(false);
  /**
   * Whether `MachineInstalls` has an act in flight, lifted so this foot can be
   * gated on it.
   *
   * Lifted rather than moved: that component decides what busy *means* — a row
   * working, a retry pending — and owning a second copy here is how the two come
   * to disagree. This is a mirror it writes, read by nothing else.
   */
  const [sending, setSending] = useState(false);

  const shown = phase.kind === "confirming" && phase.peek.kind === "ok" ? phase.peek.manifest : null;
  const file = phase.kind === "confirming" ? phase.file : null;

  const install =
    file === null
      ? null
      : async (
          daemon: DaemonClient,
          machineId: MachineId,
          onProgress: (fraction: number) => void,
          signal: AbortSignal,
        ): Promise<TargetOutcome> => {
          /*
           * ⚠ **The signal is the caller's, and constructing one here was the
           * whole bug.** This line read `new AbortController().signal` — a
           * controller built and dropped on the same expression, so nothing could
           * ever call `abort`. `PluginsPanel` describes that exact defect in the
           * past tense one file over and keeps a real controller in a ref; the
           * screen that reaches a *whole fleet* had reintroduced it verbatim, so
           * the wider blast radius had the weaker control. `MachineInstalls` now
           * owns one controller per machine and hands it down, which is also what
           * makes "a machine that fails must not abort the four beside it" true by
           * construction rather than by comment.
           */
          const answer = await daemon.installPlugin(file, onProgress, signal);
          const broken = shown === null ? null : consentBroken(shown, answer.plugin);
          // Thrown rather than returned, so the row lands on `failed` and the box
          // stays unticked — a ticked box for a plugin this screen has just refused
          // to trust would be the one lie the consent step exists to prevent.
          if (broken !== null) throw new ConsentBrokenError(`${machineId}: ${broken}`);
          return answer.replaced === null
            ? { kind: "installed", version: answer.plugin.version, enabled: answer.plugin.enabled }
            : { kind: "updated", from: answer.replaced, to: answer.plugin.version, enabled: answer.plugin.enabled };
        };

  return (
    <div className="mt-2">
      <p className="text-xs text-muted">
        A <code className="text-muted/80">.tar.gz</code> or <code className="text-muted/80">.zip</code> holding{" "}
        <code className="text-muted/80">plugin.json</code> and <code className="text-muted/80">server.js</code>.
        Installing the same id again updates it and keeps what it has stored.
      </p>
      <p className="mt-1 text-xs text-muted">Nothing is sent until you have read what it asks for.</p>
      <input
        ref={input}
        type="file"
        accept=".tgz,.gz,.zip,application/gzip,application/zip"
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          // Cleared before the read, so choosing the same file twice in a row after
          // a failure fires `change` again.
          event.target.value = "";
          if (chosen === undefined) return;
          setUnread(false);
          setPhase({ kind: "reading" });
          void peekPluginArchive(chosen).then((peek) => setPhase({ kind: "confirming", file: chosen, peek }));
        }}
      />

      {phase.kind === "confirming" && phase.peek.kind === "ok" && <PluginConsent manifest={phase.peek.manifest} />}
      {phase.kind === "confirming" && phase.peek.kind === "unreadable" && (
        <div className="mt-3 rounded-lg border border-edge p-3">
          <p className="text-sm text-fg">This file cannot be read here</p>
          <p className="mt-1 text-xs text-muted">
            {phase.peek.reason}. Nothing has been sent. Each machine will still check it properly — but until it does,
            nobody can tell you what this plugin asks for.
          </p>
          {/*
           * The separate, named press. `DangerButton` and its own words, never the
           * ordinary Install below — see {@link unread}. It reaches a whole fleet
           * from here rather than one machine, so it says so.
           */}
          {!unread && (
            <DangerButton icon={Upload} onClick={() => setUnread(true)}>
              Install without reading it
            </DangerButton>
          )}
        </div>
      )}

      {phase.kind === "confirming" && (phase.peek.kind === "ok" || unread) && (
        <div className="mt-4">
          {/*
           * ⚠ **`pluginId` is what the *archive* said its id is**, so an import of
           * a plugin already installed shows those machines already ticked — which
           * is the truth, and is how somebody sees they are about to replace
           * something rather than add it. An unreadable archive has no id to go on,
           * so nothing is ticked and every box is an install.
           */}
          {/*
           * \u26a0 **`available` is the *archive's* own version, and omitting it made
           * the one act this screen exists for impossible.** Without it `isBehind`
           * is false on every row, so no row draws Update at all and the bar's
           * Update is dead \u2014 leaving Remove as the only route to a newer copy, and
           * Remove takes `plugin_data` with it: the destructive path as the only
           * path, on the screen whose entire purpose is putting a build onto a
           * fleet. With it, a machine holding an older copy is an update target
           * and says so on its own row.
           *
           * An archive at the *same* version still offers no Update, and that is
           * deliberate: `PluginsPanel` sends unconditionally per machine, which is
           * where iterating on one build belongs (see the same-version rollback
           * path in `host.ts`). This screen is for putting a known version onto a
           * fleet.
           */}
          {/*
           * ⚠ **No `onConfigure`, so this screen draws no Settings button — and the
           * reason is measured rather than tidy.** That control navigates the sheet
           * to the plugin's settings, which unmounts this component and takes the
           * chosen `File` with it. It is the same loss `onBusyChange` exists to
           * prevent one prop up — "Done" reading as *finish* while being the control
           * that abandons the act — except this one is not even gated on `busy`.
           * Absent rather than disabled: a control that is never usable here is one
           * somebody keeps trying.
           */}
          <MachineInstalls
            pluginId={shown?.id ?? ""}
            state={state}
            install={install}
            available={shown?.version ?? null}
            onBusyChange={setSending}
            heading="Install"
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase.kind !== "confirming" ? (
          <Button disabled={phase.kind === "reading"} onClick={() => input.current?.click()}>
            <Upload size={14} />
            {phase.kind === "reading" ? "Reading\u2026" : "Choose a file"}
          </Button>
        ) : (
          /*
           * \u26a0 **Both are disabled while the fan-out runs, and neither was.**
           * `busy` lives inside `MachineInstalls` and this component could not see
           * it, so either button unmounted that component mid-flight: the uploads
           * carried on against every remaining daemon with nothing on screen, and
           * every answer \u2014 including a `ConsentBrokenError` naming a scope the
           * plugin had gained \u2014 landed on an unmounted component and was dropped.
           * "Done" is the worse of the two, because it reads like the word for
           * *finish* while being the one control that abandons the thing it
           * appears to complete. `onBusyChange` lifts the flag rather than moving
           * the state, so `MachineInstalls` stays the one owner of what it is
           * doing.
           */
          <>
            <Button disabled={sending} onClick={() => input.current?.click()}>
              Choose another file
            </Button>
            <Button disabled={sending} onClick={() => setPhase({ kind: "idle" })}>
              Done
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
