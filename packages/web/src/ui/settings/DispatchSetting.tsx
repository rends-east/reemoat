import { useSyncExternalStore, type ReactNode } from "react";
import { dispatchMachine, dispatchVersion, setDispatchMachine, subscribeDispatch } from "../../dispatch";
import type { MachineId } from "../../ids";
import type { AppState } from "../../store";
import { Dropdown } from "../bits";
import { Group } from "../kit/List";

/** Stands for no machine named: the dispatcher is then wherever one already runs. */
const ANYWHERE = "";

/** Which machine the dispatcher is started on. This device's own choice, as the order of the machines is (Q3.720). */
export function DispatchSetting({ state }: { state: AppState }): ReactNode {
  useSyncExternalStore(subscribeDispatch, dispatchVersion);
  if (state.machines.length === 0) return null;
  const chosen = dispatchMachine();
  // A machine since revoked keeps the choice and reads as none, as a remembered tab does.
  const current = state.machines.find((machine) => machine.id === chosen) ?? null;
  return (
    <Group title="Dispatch">
      <Dropdown
        variant="row"
        title="Machine"
        items={[
          { value: ANYWHERE, label: "Wherever it runs" },
          ...state.machines.map((machine) => ({ value: machine.id as string, label: machine.name })),
        ]}
        value={current === null ? ANYWHERE : current.id}
        onChange={(value) => setDispatchMachine(value === ANYWHERE ? null : (value as MachineId))}
        trigger={<span className="truncate">{current === null ? "Wherever it runs" : current.name}</span>}
      />
    </Group>
  );
}
