import type { Me } from "./wire.js";

/** Mirrors the control plane's `MAX_MACHINES_PER_USER`; webcheck pins the two equal. */
export const HARD_MACHINE_CEILING = 50;

export const MACHINE_LIMIT_KEY = "machines.per_user";

export type MachineQuota =
  | { kind: "unknown" }
  | { kind: "room"; count: number; limit: number }
  | { kind: "full"; count: number; limit: number }
  | { kind: "none"; count: number };

export function machineQuota(me: Me | null): MachineQuota {
  const limit = me?.machineLimit;
  if (typeof limit !== "number") return { kind: "unknown" };
  const count = typeof me?.machineCount === "number" ? me.machineCount : 0;
  if (limit === 0) return { kind: "none", count };
  return count >= limit ? { kind: "full", count, limit } : { kind: "room", count, limit };
}

/** Only a definite no hides the door: `unknown` fails open, since the installer is the only way to add a machine. */
export function mayAddMachine(me: Me | null): boolean {
  if (typeof me?.canAddMachine === "boolean") return me.canAddMachine;
  const kind = machineQuota(me).kind;
  return kind !== "full" && kind !== "none";
}

/** `null` iff `mayAddMachine` is true, so a hidden door always has a sentence. */
export function machineQuotaNotice(me: Me | null): string | null {
  // Asked first so the iff holds even when `canAddMachine` disagrees with the counts.
  if (mayAddMachine(me)) return null;
  const quota = machineQuota(me);
  switch (quota.kind) {
    case "unknown":
    case "room":
      return "This account cannot add machines. Ask whoever runs this server.";
    case "none":
      return quota.count === 0
        ? "Your machine limit is 0. Ask for it to be raised."
        : "Your limit is 0, so your machines are off. Ask for a higher limit.";
    case "full": {
      const over = quota.count - quota.limit;
      if (over <= 0) {
        return `All ${quota.limit} machines in use. Retire one, or ask for a higher limit.`;
      }
      return (
        `Over the limit: the newest ${over === 1 ? "one is" : `${over} are`} off. ` +
        "Retire one, or ask for more."
      );
    }
  }
}

export function machineBadgeText(machine: {
  overLimit: boolean;
  ownerDisabled?: boolean;
  enrolled: boolean;
}): string | null {
  // A ban outranks the limit: retiring a machine cannot fix it.
  if (machine.ownerDisabled === true) return "owner disabled";
  if (machine.overLimit) return "over the limit";
  if (!machine.enrolled) return "not enrolled";
  return null;
}

/** Non-null iff the admin screen must confirm the change. */
export function machineLimitChangeNotice(name: string, owned: number, next: number): string | null {
  const stopping = owned - next;
  if (stopping <= 0) return null;
  // At most fourteen words, the confirmation cap (Q3.544).
  return (
    `${name} has ${owned}. Limit ${next} stops the newest ` +
    `${stopping === 1 ? "one" : String(stopping)} working; raising brings ` +
    `${stopping === 1 ? "it" : "them"} back.`
  );
}

/** Kept apart from `machineQuotaNotice` so that one stays null whenever the door is drawn. */
export function machineAllowanceText(me: Me | null): string | null {
  const quota = machineQuota(me);
  switch (quota.kind) {
    case "unknown":
      return null;
    case "none":
      return `${quota.count} of 0`;
    case "room":
    case "full":
      return `${quota.count} of ${quota.limit}`;
  }
}

/** Non-null iff the admin screen must confirm; empty resolves to the fleet ceiling, as on the server. */
export function fleetMachineLimitNotice(current: string, next: string): string | null {
  const resolve = (raw: string): number => {
    const text = raw.trim();
    if (text.length === 0) return HARD_MACHINE_CEILING;
    return /^\d+$/.test(text) ? Number.parseInt(text, 10) : HARD_MACHINE_CEILING;
  };
  const from = resolve(current);
  const to = resolve(next);
  if (to >= from) return null;
  return to === 0
    ? "Every machine on the server stops. Raising the limit brings them back."
    : `Default drops to ${to}; machines over it stop. Raising the limit brings them back.`;
}

export function machineLimitProblem(draft: string): string | null {
  const text = draft.trim();
  if (text.length === 0) return null;
  if (!/^\d+$/.test(text)) return "Whole number, or empty for the default.";
  if (Number.parseInt(text, 10) > HARD_MACHINE_CEILING) {
    return `${HARD_MACHINE_CEILING} machines per person is the fleet-wide ceiling.`;
  }
  return null;
}
