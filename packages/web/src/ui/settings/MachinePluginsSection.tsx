import type { ReactNode } from "react";
import type { MachineId } from "../../ids";
import { MACHINE_GONE } from "../../plugins";
import type { AppState } from "../../store";
import { Empty } from "../bits";
import { PluginList } from "./PluginsPanel";

/** Per-machine plugin state only; each plugin's settings live on its own page, and reachability is stated by `MachineSection`. */
export function MachinePluginsSection({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;

  if (machine === null) {
    // Reads `state.machines` itself, so it owes the absent case an answer.
    return <Empty>{MACHINE_GONE}</Empty>;
  }

  return (
    <div className="mt-3">
      {/* Keyed on the machine: `usePlugins` has no late-write gate, so a stale listing could send Remove to the wrong daemon. */}
      <PluginList key={machineId} machineId={machineId} />
    </div>
  );
}
