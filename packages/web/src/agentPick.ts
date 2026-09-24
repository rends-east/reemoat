import type { MachineId } from "./ids";
import type { Picked } from "./ui/NewSession";
import type { CustomAgent } from "./wire";

// Hand-offs from the builder route to the strip, which is unmounted meanwhile; each is taken once so it is never re-applied later.
const pending = new Map<MachineId, CustomAgent>();
const removed = new Map<MachineId, string>();

export function rememberPick(machine: MachineId, agent: CustomAgent): void {
  pending.set(machine, agent);
}

export function takePick(machine: MachineId): CustomAgent | null {
  const held = pending.get(machine) ?? null;
  pending.delete(machine);
  return held;
}

export function rememberRemoval(machine: MachineId, agentId: string): void {
  removed.set(machine, agentId);
}

export function takeRemoval(machine: MachineId): string | null {
  const held = removed.get(machine) ?? null;
  removed.delete(machine);
  return held;
}

// The standing tile choice per machine: read rather than taken, and never persisted; it survives StartSheet unmounting.
const chosen = new Map<MachineId, Picked>();

export function keepPick(machine: MachineId, picked: Picked): void {
  chosen.set(machine, picked);
}

export function heldPick(machine: MachineId): Picked | null {
  return chosen.get(machine) ?? null;
}

/** For removal of the chosen agent, so the next mount does not restore a pick naming a dropped row. */
export function forgetPick(machine: MachineId): void {
  chosen.delete(machine);
}
