import type { ReactNode } from "react";
import { daemonRead } from "../../machine";
import type { MachineId } from "../../ids";
import { MACHINE_GONE } from "../../plugins";
import { navigate } from "../../router";
import { harnessSigninPath, settingsPath } from "../../settings";
import type { AppState } from "../../store";
import { Button, Empty, NotReachable, Spinner } from "../bits";
import { AgentDetail } from "./AgentsPanel";
import { SystemChooser, SystemDetail } from "./SystemsPanel";

export function MachineSystemsSection({
  state,
  machineId,
  system,
  signin,
}: {
  state: AppState;
  machineId: MachineId;
  system: string | null;
  signin: string | null;
}): ReactNode {
  const machine = state.machines.find((candidate) => candidate.id === machineId) ?? null;

  if (machine === null) {
    // The chevron leads back to this same dead end, so the way out to the list is drawn here (Q3.415).
    return (
      <Empty
        action={
          <Button size="sm" onClick={() => navigate(settingsPath("machines"), true)}>
            All machines
          </Button>
        }
      >
        {MACHINE_GONE}
      </Empty>
    );
  }

  // A machine not yet asked is a wait; only offline earns the unreachable sentence.
  const read = daemonRead(machine.reach);

  return (
    <div>
      {read === "asking" ? (
        <Empty>
          <span className="inline-flex items-center gap-2">
            <Spinner /> Checking whether {machine.name} is reachable…
          </span>
        </Empty>
      ) : read === "unreachable" ? (
        <Empty failed>
          <NotReachable machine={machine} />
        </Empty>
      ) : signin !== null ? (
        <AgentDetail key={`${machineId}:${signin}`} machineId={machineId} agentId={signin} />
      ) : system === null ? (
        // probing lands here on purpose: a re-probe must not take the panel away.
        <SystemChooser
          machineId={machineId}
          onPick={(picked) => navigate(settingsPath("machines", machineId, picked))}
          onPickHarness={(agent) => navigate(harnessSigninPath(machineId, agent))}
        />
      ) : (
        // Keyed on both so a switch never shows one system's login run under another's name.
        <SystemDetail key={`${machineId}:${system}`} machineId={machineId} systemId={system} />
      )}
    </div>
  );
}
