import type { ReactNode } from "react";
import type { MachineId } from "../../ids";
import { daemonRead } from "../../machine";
import { MACHINE_GONE } from "../../plugins";
import { registryUnread } from "../Unreachable";
import { navigate } from "../../router";
import { settingsPath } from "../../settings";
import type { AppState } from "../../store";
import { Button, Empty, NotReachable, Spinner } from "../bits";
import { PluginInstall, PluginList } from "./PluginsPanel";

/** Per-machine plugin state only, on a screen of its own; each plugin's settings live on its own page (Q3.459). */
export function MachinePluginsList({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;

  if (machine === null) {
    // The chevron leads back to a machine that is gone as well, so the way out to the list is drawn here (Q3.415).
    return (
      registryUnread(state) ?? (
        <Empty
          action={
            <Button size="sm" onClick={() => navigate(settingsPath("machines"), true)}>
              All machines
            </Button>
          }
        >
          {MACHINE_GONE}
        </Empty>
      )
    );
  }

  // A machine not yet asked is a wait; only offline earns the unreachable sentence.
  const read = daemonRead(machine.reach);
  if (read === "asking") {
    return (
      <Empty>
        <span className="inline-flex items-center gap-2">
          <Spinner /> Checking whether {machine.name} is reachable…
        </span>
      </Empty>
    );
  }
  if (read === "unreachable") {
    return (
      <Empty failed>
        <NotReachable machine={machine} />
      </Empty>
    );
  }

  // Keyed on the machine: `usePlugins` has no late-write gate, so a stale listing could send Remove to the wrong daemon.
  return <PluginList key={machineId} machineId={machineId} />;
}

export function PluginInstallScreen({ state, machineId }: { state: AppState; machineId: MachineId }): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;
  if (machine === null) return registryUnread(state) ?? <Empty>{MACHINE_GONE}</Empty>;
  return <PluginInstall key={machineId} machineId={machineId} />;
}
