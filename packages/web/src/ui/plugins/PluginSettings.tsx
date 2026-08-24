import { useEffect, useState, type ReactNode } from "react";
import type { MachineId } from "../../ids";
import type { MachineState } from "../../machine";
import { pluginFailure, readView } from "../../plugins";
import { store, type AppState } from "../../store";
import { ambiguousNames, type PluginSummary, type PluginView as PluginViewShape } from "../../wire";
import { Dropdown, Empty, Spinner } from "../bits";
import { PluginView } from "../PluginView";
import { toast } from "../Toast";

/**
 * A plugin's own settings, as a screen of its own.
 *
 * ⚠ **It used to be a leaf of the settings sheet and nobody found it.** The path
 * was Settings → Machines → *a* machine → Plugins → a kebab → Settings, six taps
 * behind a control that looks like a row's overflow menu, on a screen that draws
 * one machine at a time. The question that ended it was asked in those words:
 * *"where in settings is the normal plugin setting?"*
 *
 * ⚠ **And then it was a section on the plugin's page, which was still wrong.**
 * That page is what a plugin *is* — what it does, what it may do, where it is,
 * what it was before this version — and it is read once. Its settings are what
 * somebody comes back for, every time, and they sat below a fold of permissions
 * and above an install control: a form buried in a brochure. So the gear in the
 * head opens them as their own screen, one push deep, with the ◀ back to the
 * plugin.
 *
 * ⚠ **Which machine is asked here rather than assumed, and only where there is
 * something to ask.** Q3.447's argument — that a fleet-wide plugin screen would
 * open with a dropdown, which is a screen asking a question its own copy answers
 * — is why this lived inside a machine at all. It is answered rather than
 * reversed: this screen already knows which machines the plugin is on, so the
 * choice is over *those* and not over the fleet, and where it is on one machine
 * there is no choice and no control. The dropdown appears exactly when a person
 * genuinely has two answers, which is the case that argument never covered.
 *
 * ⚠ **Per machine because the data is.** `plugin_data` is a table in one daemon's
 * SQLite, so there is no such thing as this plugin's settings across a fleet —
 * two machines running the same plugin are two configurations, and a control
 * implying otherwise would be the one lie this screen can tell.
 */
export function PluginSettingsScreen({
  state,
  pluginId,
  onIdentified,
}: {
  state: AppState;
  pluginId: string;
  /**
   * What this plugin turned out to be called, handed to the sheet's head.
   *
   * ⚠ **From the machines rather than from the catalogue**, unlike the entry page
   * one level up. This screen makes no catalogue request — it has no use for one —
   * and a plugin that arrived as a file is not in the catalogue at all while being
   * exactly as configurable. The installed rows carry the name the daemon parsed
   * out of the manifest, which is the name of the code actually running.
   */
  onIdentified: (identity: { id: string; name: string; version: string }) => void;
}): ReactNode {
  /**
   * The machine being configured, once somebody has chosen one.
   *
   * `null` means "whichever the list starts with", rather than being seeded from
   * the installs — which change on every plugin poll, so a seeded value would need
   * re-seeding, and a re-seed lands under somebody's fingers.
   */
  const [picked, setPicked] = useState<MachineId | null>(null);

  const installs = installsOf(state, pluginId);
  const offering = installs.filter((one) => one.plugin.contributes.settings);
  const name = installs[0]?.plugin.name ?? pluginId;
  const version = [...new Set(offering.map((one) => one.plugin.version))].join(", ");

  useEffect(() => {
    onIdentified({ id: pluginId, name, version });
  }, [onIdentified, pluginId, name, version]);

  if (installs.length === 0) {
    // Reachable: the gear is drawn from this same list, but a machine can be
    // revoked or go quiet between the press and the render — and a deep link is
    // not pressed at all.
    return <Empty>This plugin is not on any of your machines, so there is nothing to configure.</Empty>;
  }
  const chosen = offering.find((one) => one.machine.id === picked) ?? offering[0];
  if (chosen === undefined) return <Empty>{name} has no settings of its own.</Empty>;
  const ambiguous = ambiguousNames(state.machines);

  return (
    <div>
      {offering.length > 1 && (
        <div className="mb-3 flex min-h-11 items-center gap-2 text-xs text-muted">
          <span className="shrink-0">On</span>
          {/*
           * ⚠ **The app's own picker, never a bare `<select>`.** A native select
           * keeps the platform's own chrome unless every one of `appearance`, the
           * border, the radius and the arrow is overridden — which is why the one
           * that shipped here drew a heavy system outline in the middle of a form
           * of `edge-strong` boxes, and opened a menu nothing in this palette can
           * reach. `Dropdown` is the one popover picker in this app: it takes
           * Escape through `overlay.ts`, keeps the whole listbox ARIA set, and
           * looks like everything around it because it is what everything around
           * it uses.
           */}
          <Dropdown
            items={offering.map((one) => ({
              value: one.machine.id,
              // The id only where the name does not tell two hosts apart — a
              // property of the list, asked once rather than per row.
              label: ambiguous.has(one.machine.name.toLowerCase())
                ? `${one.machine.name} (${one.machine.id})`
                : one.machine.name,
              description: one.plugin.version,
            }))}
            value={chosen.machine.id}
            onChange={setPicked}
            heading="Machine"
            trigger={<span className="min-w-0 truncate">{chosen.machine.name}</span>}
            className="min-w-0 flex-1"
          />
        </div>
      )}
      {/*
       * Keyed on the pair, so switching machine remounts rather than carrying the
       * previous one's form state across — the same reason `AgentDetail` is keyed,
       * and it matters more here because the state is somebody's half-typed
       * configuration for a *different* host.
       */}
      <PluginPane key={`${chosen.machine.id}:${pluginId}`} machineId={chosen.machine.id} pluginId={pluginId} />
    </div>
  );
}

/**
 * Every machine this plugin is installed on, with the row that machine reports.
 *
 * ⚠ **Walked from `state.machines` rather than from `pluginsByMachine`**, so the
 * order is the order the fleet is drawn in everywhere else, and so a plugin row
 * left behind for a machine that has since been revoked cannot put a host on this
 * screen that is not in the person's list.
 */
function installsOf(state: AppState, pluginId: string): { machine: MachineState; plugin: PluginSummary }[] {
  return state.machines.flatMap((machine) => {
    const found = state.pluginsByMachine.get(machine.id)?.find((one) => one.id === pluginId);
    return found === undefined ? [] : [{ machine, plugin: found }];
  });
}

/**
 * One machine's pane, drawn by the same renderer the plugin's screen uses.
 *
 * There is no second vocabulary for settings: a settings pane *is* a view, and a
 * plugin that wants a form returns one. That is what stops this subsystem growing
 * a config schema beside the drawing schema, which would be two ways to describe a
 * text field.
 *
 * ⚠ **What it may contain is narrower than a screen, and that narrowing is
 * applied here as well as in the daemon.** `readView(…, "settings")` keeps `text`,
 * `notice` and `form`, and inside a form keeps the three kinds a setting may be —
 * a box, a switch, a dropdown. The daemon clamps the same set when it answers the
 * *read*, which is what produces the notice its author sees; this side is what
 * makes it hold for an **action's** answer as well, because a form submit reaches
 * the daemon as an action id that says nothing about which pane it was pressed
 * on. The component drawing the pane is the only thing that knows for certain.
 */
function PluginPane({ machineId, pluginId }: { machineId: MachineId; pluginId: string }): ReactNode {
  /*
   * **No refresh timer here, deliberately, and the reason is the form.** A
   * settings pane is a thing somebody is typing into, and re-reading it under
   * them would either discard what they typed or keep it over a value the plugin
   * has since changed. `refreshMs` is honoured on the plugin's *screen*, which is
   * a thing you look at; a form is a thing you fill in.
   */
  const [view, setView] = useState<PluginViewShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * ⚠ **What re-seeds the form after a save, and why it is a counter here rather
   * than a key on the form itself.**
   *
   * `Form` seeds its state once per mount, so a plugin that normalises a value on
   * save drew the un-normalised one until reload. Its own docblock claimed it was
   * "keyed on what the plugin sent" and there was no key anywhere — but adding a
   * content-derived one inside `PluginView` would have been worse than the bug:
   * `PluginView` also draws the plugin's **screen**, which `PluginScreen` re-reads
   * on `refreshMs` (floor 2s), so any poll that changed a field would have wiped
   * what somebody was typing.
   *
   * The distinction the two callers already make is the answer. This pane has no
   * timer, deliberately, so `view` changes only when the person here acted — and
   * that is exactly the moment a re-seed is wanted. The screen passes nothing and
   * keeps today's behaviour.
   */
  const [saves, setSaves] = useState(0);

  useEffect(() => {
    let live = true;
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setError("That machine is not reachable right now.");
      return;
    }
    setError(null);
    void daemon
      .pluginView(pluginId, "settings")
      .then((answer) => {
        if (!live) return;
        setView(
          answer.result.kind === "view"
            ? readView(answer.result.view, "settings")
            : { title: null, refreshMs: null, blocks: [] },
        );
      })
      .catch((cause: unknown) => {
        if (live) setError(pluginFailure(cause));
      });
    return () => {
      live = false;
    };
  }, [machineId, pluginId]);

  const act = (actionId: string, context: { row?: string; form?: Record<string, string> }): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    setBusy(true);
    void daemon
      .pluginAction(pluginId, actionId, context)
      .then((answer) => {
        if (answer.result.kind === "view") {
          // Narrowed to the settings vocabulary here too: this answer is being
          // drawn *into this pane*, and the daemon could not know that — an action
          // id says which action, never which surface pressed it.
          setView(readView(answer.result.view, "settings"));
          setSaves((held) => held + 1);
          return;
        }
        toast(answer.result.tone === "danger" ? "error" : "ok", answer.result.text);
      })
      .catch((cause: unknown) => toast("error", pluginFailure(cause)))
      .finally(() => setBusy(false));
  };

  if (error !== null) return <Empty>{error}</Empty>;
  if (view === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  return <PluginView key={saves} view={view} busy={busy} onAction={act} />;
}
