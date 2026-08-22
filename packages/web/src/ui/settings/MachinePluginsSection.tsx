import type { ReactNode } from "react";
import { daemonReadable } from "../../machine";
import type { MachineId } from "../../ids";
import type { AppState } from "../../store";
import { Empty, reachText } from "../bits";
import { PluginList, PluginSettings } from "./PluginsPanel";

/**
 * Plugins, inside the machine they run on.
 *
 * The sibling of `MachineAgentsSection`, and deliberately shaped identically:
 * two depths, the same unreachable branch, the same argument for why neither is a
 * fleet-wide screen. What is installed lives on one host's disk and what it has
 * stored lives in one daemon's database, so a list that spanned machines would
 * open with a dropdown asking which one — a screen asking a question its own copy
 * answers.
 */
export function MachinePluginsSection({
  state,
  machineId,
  plugin,
}: {
  state: AppState;
  machineId: MachineId;
  plugin: string | null;
}): ReactNode {
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
        {machine.name} is not reachable right now — {reachText(machine.reach, machine.offlineReason)}
        {plugin === null ? "." : `, so nothing about ${plugin} can be read or changed.`}
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
        {plugin === null ? (
          /*
           * Keyed for `PluginSettings`' reason, and for a sharper one: `usePlugins`
           * has no late-write gate, so without a remount machine A's in-flight
           * listing lands under B's `machineId` and every row on screen is A's
           * while `PluginRow` resolves its daemon from B. Remove then sends A's
           * plugin id to B — and since the same plugin on both your machines is the
           * ordinary case, that hits a real target and takes its `plugin_data`
           * with it.
           */
          <PluginList key={machineId} machineId={machineId} />
        ) : (
          /*
           * Keyed on both, so switching plugin or machine remounts rather than
           * carrying the previous one's form state — the same reason `AgentDetail`
           * is keyed, and it matters more here because the state is somebody's
           * half-typed API token.
           */
          <PluginSettings key={`${machineId}:${plugin}`} machineId={machineId} pluginId={plugin} />
        )}
      </div>
    </div>
  );
}
