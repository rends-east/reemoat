import type { MachineId } from "../ids";
import type { MachineState, OfflineReason } from "../machine";
import type { StreamStatus } from "../stream";

// What the connection pill says, as pure functions over the store's own state (Q3.659).

/** Offline for these is the wire failing, which the app keeps retrying; every other reason is a refusal somebody acts on where it is drawn. */
const TRANSPORT_REASONS: ReadonlySet<OfflineReason> = new Set<OfflineReason>(["no_route", "cp_unreachable", null]);

/** Long enough that a sub-second reconnect never draws the pill. */
export const TROUBLE_GRACE_MS = 1_000;

export type Trouble =
  | { kind: "connecting"; e2ee: boolean }
  | { kind: "unreachable"; names: readonly string[] };

export interface ConnectionScope {
  /** Every machine for the list's All tab, else the ones this screen reads; under All only a probe counts, never a machine that is off. */
  machines: "all" | readonly MachineId[];
  /** The conversation on screen: its machine is read too, and its stream has to be live. */
  open: { machine: MachineId; stream: StreamStatus | null } | null;
}

type Watched = Pick<MachineState, "id" | "name" | "reach" | "offlineReason" | "route">;

/**
 * The server first, since nothing else can be asked without it; then a machine that cannot be reached, by name; then the open
 * conversation's stream reconnecting, which is end-to-end encrypted only over the relay (e2ee.md); then a first probe.
 */
export function connectionTrouble(
  state: { cpError: string | null; machines: readonly Watched[] },
  scope: ConnectionScope,
): Trouble | null {
  if (state.cpError !== null) return { kind: "connecting", e2ee: false };
  const watched = state.machines.filter(
    (machine) => scope.machines === "all" || scope.machines.includes(machine.id) || scope.open?.machine === machine.id,
  );
  // Under All a machine that is simply switched off would hold the pill for as long as it stays off.
  const named = (machine: Watched) => scope.machines !== "all" || scope.open?.machine === machine.id;
  const down = watched.filter(
    (machine) => machine.reach === "offline" && TRANSPORT_REASONS.has(machine.offlineReason) && named(machine),
  );
  if (down.length > 0) return { kind: "unreachable", names: down.map((machine) => machine.name) };
  const phase = scope.open?.stream?.phase;
  if (phase === "connecting" || phase === "waiting") {
    const machine = watched.find((candidate) => candidate.id === scope.open?.machine);
    return { kind: "connecting", e2ee: machine?.route?.kind === "relay" };
  }
  if (watched.some((machine) => machine.reach === "unknown" || machine.reach === "probing")) {
    return { kind: "connecting", e2ee: false };
  }
  return null;
}

export function troubleWords(trouble: Trouble): string {
  if (trouble.kind === "connecting") return "Connecting…";
  const [only] = trouble.names;
  return trouble.names.length === 1 && only !== undefined ? `${only} is unreachable` : `${trouble.names.length} machines are unreachable`;
}

/** When the current spell of trouble began, kept across a change of kind: a reconnect that becomes an outage is one spell. */
export function troubleSince(previous: number | null, troubled: boolean, now: number): number | null {
  if (!troubled) return null;
  return previous ?? now;
}

export function troubleShown(since: number | null, now: number): boolean {
  return since !== null && now - since >= TROUBLE_GRACE_MS;
}
