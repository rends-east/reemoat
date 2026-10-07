import { isTransportFailure } from "./http";
import type { MachineState, OfflineReason, Reach } from "./machine";

// What could not be reached, as separate facts: this device's network, the server, a machine. Pure, and store-free (Q3.707).

export type DeviceNetwork = "online" | "offline";

/** `refusing` answered, with an error that is not a sign-out: its operator reads a log, not a network. */
export type ServerState = "unknown" | "ok" | "unreachable" | "refusing";

/** Whether the machine list was ever read this sitting: an empty-state sentence is drawn only from `known`. */
export type Registry = "unknown" | "failed" | "known";

export type Answer = "unknown" | "failed" | "known";

/** `since` is the monotonic start of the trouble, kept across its two kinds; null with none. */
export interface ServerFact {
  state: ServerState;
  since: number | null;
}

export const SERVER_UNASKED: ServerFact = { state: "unknown", since: null };

/** The spell's first ten seconds read as a reconnect; past them the server is named. */
export const SERVER_NAMED_AFTER_MS = 10_000;

/** A link that drops and is back inside this is never drawn: no pill, no stale line, no machine called down (Q3.714). */
export const RECONNECT_QUIET_MS = 5_000;

/** A listing's failure is asked again before it is drawn: time for that ask to go out and a healthy server to answer it (Q3.716). */
export const SERVER_CONFIRM_MS = 2_500;

/** Whether a spell that began at `since` has outlasted `after`, both on one clock. */
export function outlasted(since: number | null, now: number, after: number = RECONNECT_QUIET_MS): boolean {
  return since !== null && now - since >= after;
}

/** A first failure is asked again soon and each one after it later, up to the pace an outage is asked at. */
export function retryDelay(failures: number, ceiling: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), ceiling);
}

/** Offline only on a positive signal: `true` proves nothing. */
export function deviceNetwork(onLine: boolean | undefined): DeviceNetwork {
  return onLine === false ? "offline" : "online";
}

/** A sign-out never reaches here: `cpFetch` has already ended the session. */
export function listingFailure(error: unknown): "unreachable" | "refusing" {
  return isTransportFailure(error) ? "unreachable" : "refusing";
}

/** `began` is when the attempt started, so a listing that timed out has already spent its wait. */
export function serverAfter(previous: ServerFact, next: ServerState, began: number): ServerFact {
  if (next === "ok" || next === "unknown") return { state: next, since: null };
  return { state: next, since: previous.since ?? began };
}

/** A token the server did not answer for is the server's trouble, whether the machine still runs on a held one or not. */
export function serverEvidence(
  machines: readonly Pick<MachineState, "reach" | "offlineReason" | "tokenDegraded">[],
): boolean {
  return machines.some((machine) => machine.tokenDegraded || wantsServer(machine.reach, machine.offlineReason));
}

/** Offline for want of the server: never named as the machine's own trouble. */
export function wantsServer(reach: Reach, reason: OfflineReason): boolean {
  return reach === "offline" && reason === "cp_unreachable";
}

/** Down on the wire: from here a dead machine and a dead server look alike, until the server is asked. */
export function onTheWire(reach: Reach, reason: OfflineReason): boolean {
  return reach === "offline" && (reason === null || reason === "no_route");
}

/** Down for a reason the app keeps retrying, the wire or the server its token is minted by; any other reason is an answer. */
export function retriedDown(reach: Reach, reason: OfflineReason): boolean {
  return onTheWire(reach, reason) || wantsServer(reach, reason);
}

/** When each machine was first seen down on the wire: kept while it stays down, dropped the moment it is not, or is gone. */
export function wireDownSince<Id extends string>(
  previous: ReadonlyMap<Id, number>,
  machines: readonly { id: Id; reach: Reach; offlineReason: OfflineReason }[],
  now: number,
  down: (reach: Reach, reason: OfflineReason) => boolean = onTheWire,
): Map<Id, number> {
  const next = new Map<Id, number>();
  for (const machine of machines) {
    if (down(machine.reach, machine.offlineReason)) next.set(machine.id, previous.get(machine.id) ?? now);
  }
  return next;
}

/**
 * What a machine is drawn as. One found down keeps what it was drawn as until it has been down for the quiet window: one
 * failed probe is weak evidence, and the probes that follow settle it. `before` is its reach when it was last not down. One
 * never drawn up is held only while the server says its daemon is dialled in, and nothing is held on a device that says it
 * is offline.
 */
export function drawnReach(
  raw: { reach: Reach; offlineReason: OfflineReason; relayOnline: boolean },
  before: Reach | undefined,
  since: number | undefined,
  now: number,
  device: DeviceNetwork,
): Reach {
  if (!retriedDown(raw.reach, raw.offlineReason) || device === "offline") return raw.reach;
  if (since === undefined || outlasted(since, now)) return raw.reach;
  if (before === "online") return before;
  return (before === "probing" || before === "unknown") && raw.relayOnline ? before : raw.reach;
}

/**
 * What the server is drawn as: unreachable only once that has outlasted the quiet window, and until then what it was.
 * `learned` is when the failure landed, which for a request that timed out is long after `since`: one lost listing would
 * otherwise be drawn the moment it was known, its window spent while it was out.
 */
export function drawnServer(raw: ServerFact, drawn: ServerFact, now: number, device: DeviceNetwork, learned: number | null = raw.since): ServerFact {
  if (raw.state !== "unreachable" || device === "offline") return raw;
  if (now >= serverDrawnAt(raw, learned)) return raw;
  return drawn.state === "unreachable" ? raw : drawn;
}

/** When a server found unreachable is drawn so, on the monotonic clock. */
export function serverDrawnAt(raw: ServerFact, learned: number | null): number {
  const since = raw.since ?? 0;
  return Math.max(since + RECONNECT_QUIET_MS, (learned ?? since) + SERVER_CONFIRM_MS);
}

/**
 * Machines that went down after the server last answered. Until it answers again nobody can say which of the two it is, so
 * neither is named: the server is asked, and its answer settles it.
 *
 * With `proof`, the answer names nothing by itself. A link that was down for both comes back to the server first, and the
 * probe that found the machine down ran in the outage: only one begun after an answer says it is the machine. `answered`
 * is when the first listing to answer since each went down did so, and stays that: held to the newest instead, every
 * later listing would put a machine already named back in doubt.
 */
export function doubtedOf<Id extends string>(
  since: ReadonlyMap<Id, number>,
  answeredAt: number,
  proof?: { answered: ReadonlyMap<Id, number>; probed: ReadonlyMap<Id, number> },
): Set<Id> {
  const unproved = (id: Id): boolean => {
    if (proof === undefined) return false;
    const answered = proof.answered.get(id);
    return answered === undefined || (proof.probed.get(id) ?? Number.NEGATIVE_INFINITY) < answered;
  };
  return new Set([...since].filter(([id, at]) => at > answeredAt || unproved(id)).map(([id]) => id));
}

/** A daemon the server says is not dialled in: nothing on the wire is asked of it, so only a listing says it is back. */
export function undialled(machine: Pick<MachineState, "reach" | "offlineReason" | "relayOnline">): boolean {
  return machine.reach === "offline" && machine.offlineReason === "no_route" && !machine.relayOnline;
}

export function registryOf(known: boolean, server: ServerState): Registry {
  if (known) return "known";
  return server === "unreachable" || server === "refusing" ? "failed" : "unknown";
}

export function serverTroubled(state: ServerState): state is "unreachable" | "refusing" {
  return state === "unreachable" || state === "refusing";
}

// Every sentence about what could not be reached is written here once, so the pill and a screen's body cannot drift.

export const NO_NETWORK = "No network connection";
export const WAITING_FOR_NETWORK = "Waiting for network…";
export const CONNECTING = "Connecting…";

/** The host sits between the two halves, so a caller with room draws it in mono. */
export function serverSentence(why: "unreachable" | "refusing"): { lead: string; tail: string } {
  return why === "unreachable" ? { lead: "Can’t reach ", tail: "" } : { lead: "", tail: " answered with an error" };
}

export function serverWords(why: "unreachable" | "refusing", host: string): string {
  const { lead, tail } = serverSentence(why);
  return `${lead}${host}${tail}`;
}

export function machinesWords(names: readonly string[]): string {
  const [only] = names;
  return names.length === 1 && only !== undefined ? `${only} is unreachable` : `${names.length} machines are unreachable`;
}

export function sessionsWords(name: string | null): string {
  return name === null ? "Couldn’t load some sessions" : `Couldn’t load ${name}’s sessions`;
}
