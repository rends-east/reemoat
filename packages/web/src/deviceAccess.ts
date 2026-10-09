import type { MachineId } from "./ids";
import type { DeviceView, DevicesAnswer, Scope } from "./wire";

// What the screen over a machine's device list says, as functions a driver can assert without a DOM (Q1.655).

/** A device names itself, so one that said nothing still needs words; a linked machine is never called a device. */
export function deviceName(device: Pick<DeviceView, "label" | "kind">): string {
  if (device.label !== null && device.label.length > 0) return device.label;
  return device.kind === "machine" ? "A linked machine" : "Unnamed device";
}

export interface DeviceRows {
  waiting: DeviceView[];
  known: DeviceView[];
}

/** Waiting rows exist only under the lock: with it off nothing waits on anybody, and a leftover row is let in at its next dial. */
export function deviceRows(answer: DevicesAnswer): DeviceRows {
  return {
    waiting: answer.lock ? answer.devices.filter((device) => device.state === "pending") : [],
    known: answer.devices.filter((device) => device.state === "known"),
  };
}

/** The row's own trailing word, or null where there is nothing to wait for. */
export function waitingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 waiting" : `${String(count)} waiting`;
}

/** Letting a device in is a machine admin's act, so nobody else is told that one is waiting. */
export function mayLetIn(machine: { scopes: readonly Scope[] }): boolean {
  return machine.scopes.includes("machine:admin");
}

/** The first machine, in the list's order, with a device waiting that this account may let in. */
export function waitingMachine(
  machines: readonly { id: MachineId; scopes: readonly Scope[] }[],
  waiting: ReadonlyMap<MachineId, number>,
): MachineId | null {
  return machines.find((machine) => (waiting.get(machine.id) ?? 0) > 0 && mayLetIn(machine))?.id ?? null;
}

/** Removing the device that is asking would end the channel carrying the answer, and the machine refuses it. */
export function removable(device: Pick<DeviceView, "id">, you: string | null): boolean {
  return you === null || device.id !== you;
}
