import type { ReactNode } from "react";
import type { MachineId } from "../../ids";
import type { AppState } from "../../store";
import { Empty } from "../bits";
import { PluginList } from "./PluginsPanel";

/**
 * Plugins, inside the machine they run on.
 *
 * ⚠ **One depth now, and the second one left on purpose.** This was the sibling
 * of `MachineSystemsSection` down to the shape: a list, and one leaf holding that
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
 *
 * ⚠ **It draws no prose and no reachability line, and both were removed rather
 * than lost.** It carried a paragraph ending *"Nothing here is shared with your
 * other machines."* and, above it, `` `${machine.name} is not reachable right now
 * — …` `` — and `MachineSystemsSection` two hundred pixels up the same screen
 * carried word-for-word the same clause and near enough the same sentence, each
 * with a comment defending itself against being silently empty and neither aware
 * of the other. Both facts are about the *machine*, so both are stated once by
 * `MachineSection`: the per-machine lede at the top, and a single line that
 * replaces this section, Systems and Agents together when the daemon cannot be
 * read. That is also why there is no reachability branch left here — this
 * component is not mounted at all in the state it used to describe. Its one
 * caller is that screen; a second one would owe both sentences again.
 */
export function MachinePluginsSection({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;

  if (machine === null) {
    /*
     * A stale link, or a machine revoked in another tab. Kept even though
     * `MachineSection` returns its own answer for the same state one level up:
     * this component reads `state.machines` itself, so it owes the absent case an
     * answer rather than a `PluginList` pointed at an id nothing resolves. No way
     * out drawn here, unlike the systems screen's copy — this one is never the
     * whole screen, and the screen it sits in has already answered.
     */
    return <Empty>That machine is not in your list any more.</Empty>;
  }

  return (
    /* `mt-3` because the section's `<h2>` is directly above and `SETTINGS_HEADING`
       carries no margin of its own — the paragraph that used to hold this gap is
       the one folded into `MachineSection`'s lede. */
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
  );
}
