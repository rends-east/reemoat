import type { ReactNode } from "react";
import { daemonReadable } from "../../machine";
import type { MachineId } from "../../ids";
import type { AppState } from "../../store";
import { Empty, reachText } from "../bits";
import { PluginList } from "./PluginsPanel";

/**
 * Plugins, inside the machine they run on.
 *
 * ⚠ **One depth now, and the second one left on purpose.** This was the sibling
 * of `MachineAgentsSection` down to the shape: a list, and one leaf holding that
 * plugin's own settings. The leaf is gone. What it drew is a plugin's
 * configuration, which is a thing *about the plugin* rather than about this host,
 * and it sat four taps into a sheet behind a kebab where nobody found it — the
 * question this screen was asked, in those words, was *"where in settings is the
 * normal plugin setting?"*.
 *
 * What stays is what is genuinely per-machine and cannot be anywhere else: which
 * plugins this daemon has, whether each is switched on, what a failed one said,
 * and handing this host an archive from a file. Every row links to the plugin's
 * own page, which is where its settings now are.
 *
 * The argument that put settings here — that a fleet-wide screen would open with
 * a dropdown asking which machine — was answered rather than reversed: the
 * plugin's page **is** fleet-wide and already knows which machines it is on, so
 * where it asks, it asks with the answer already narrowed to those, and does not
 * ask at all where there is only one.
 */
export function MachinePluginsSection({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;

  if (machine === null) {
    // A stale link, or a machine revoked in another tab. Not an error screen: the
    // list two levels up is the answer, and the pane's chevron walks there one
    // step at a time.
    return <Empty>That machine is not in your list any more.</Empty>;
  }

  if (!daemonReadable(machine.reach)) {
    /*
     * Named rather than silently empty, for `MachineAgentsSection`'s reason: an
     * unreachable machine is a common reason to be on this screen, and "nothing
     * is installed" and "we could not ask" are different sentences.
     */
    return (
      <Empty>
        {machine.name} is not reachable right now — {reachText(machine.reach, machine.offlineReason)}.
      </Empty>
    );
  }

  return (
    <div>
      <p className="text-xs text-muted">
        Plugins are installed on <code className="text-muted/80">{machine.id}</code> and run there, as you. Nothing here
        is shared with your other machines.
      </p>
      <div className="mt-3">
        {/*
         * Keyed on the machine: `usePlugins` has no late-write gate, so without a
         * remount machine A's in-flight listing lands under B's `machineId` and
         * every row on screen is A's while `PluginRow` resolves its daemon from B.
         * Remove then sends A's plugin id to B — and since the same plugin on both
         * your machines is the ordinary case, that hits a real target and takes
         * its `plugin_data` with it.
         */}
        <PluginList key={machineId} machineId={machineId} />
      </div>
    </div>
  );
}
