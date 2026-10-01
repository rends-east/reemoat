import { ApiError, errorText, meansRouteAbsent } from "./http";
import type { MachineState } from "./machine";
import type { MachineLinkAnswer, MachineLinkGrant, PeerMessagingState } from "./wire";

// Handing each of your machines its links to the others: minted by the control plane, carried to the daemon. No DOM in the module body: webcheck imports it.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A token lives 90 days; the set is re-minted once the earliest pushed has less than this left. */
export const LINK_RENEW_WITHIN_MS = 45 * DAY_MS;

/** And once a day whatever the expiry, which is what picks up a machine the control plane skipped. */
export const LINK_RESYNC_AFTER_MS = DAY_MS;

/** Not on every wake: each attempt spends the account's control-plane write budget, which minting machine tokens shares. */
export const LINK_RETRY_AFTER_MS = 15 * 60 * 1000;

/** A switch that has not reached its machine waits this long after a failure, not the link backoff: its local agents are still messaging. */
export const POLICY_RETRY_AFTER_MS = 30 * 1000;

const STORAGE_KEY = "reemoat.agentLinks";

export const MAX_LINK_RECORDS = 200;

export interface LinkScope {
  origin: string;
  account: string;
}

/** What this client last handed one machine. */
export interface LinkSyncRecord {
  /** `linkTargets` at the time, never the control plane's answer: one it skipped would otherwise read as a change on every wake. */
  targets: string[];
  earliestExpiresAt: number | null;
  syncedAt: number;
  /** The messaging flag handed over; absent on a record older than it, whose daemon took no flag and so is on. */
  messaging?: boolean;
  /** The isolation flag handed over; absent on a record older than it, whose daemon was never isolated. */
  isolated?: boolean;
  policyAt?: number;
}

export interface LinkCandidate {
  id: string;
  owned: boolean;
  enrolled: boolean;
  relayOnline: boolean;
  reachable: boolean;
  overLimit: boolean;
  ownerDisabled: boolean;
  /** Whether its agents may message, off the listing alone: `me` is re-read too rarely to be compared against (Q1.654). */
  messaging: boolean;
  /** Its own isolation switch, off the listing: an isolated machine is linked to nothing, and nothing to it (Q2.244). */
  isolated: boolean;
  /** The daemon process that last answered a probe, so an update is noticed without reading the version label. */
  daemon: string | null;
}

export type LinkSyncWhy =
  | "never_synced"
  | "policy_changed"
  | "targets_changed"
  | "expiring"
  | "stale"
  | "forced"
  | "current"
  | "unknown_machine"
  | "not_owned"
  | "not_enrolled"
  | "switched_off"
  | "offline"
  | "daemon_too_old"
  | "backing_off";

export interface LinkSyncVerdict {
  sync: boolean;
  why: LinkSyncWhy;
}

export interface LinkSyncStatus {
  tooOld: boolean;
  failure: { at: number; text: string } | null;
  /** The daemon's own `REEMOAT_PEER_MESSAGES`, as last echoed; null from a daemon that echoed none. */
  env: boolean | null;
}

export function linkCandidate(machine: MachineState): LinkCandidate {
  return {
    id: machine.id,
    owned: machine.owned,
    enrolled: machine.enrolled,
    relayOnline: machine.relayOnline,
    reachable: machine.reach !== "offline",
    overLimit: machine.overLimit,
    ownerDisabled: machine.ownerDisabled,
    messaging: machine.agentMessaging !== false,
    isolated: machine.agentMessagingIsolated === true,
    daemon: machine.health?.instanceId ?? null,
  };
}

/** Who a machine would be linked to, as far as this client can tell: the control plane also skips a machine with no pinned key. */
export function linkTargets(machines: readonly LinkCandidate[], source: string): string[] {
  const own = machines.find((one) => one.id === source);
  if (own?.messaging === false || own?.isolated === true) return [];
  return machines
    .filter(
      (one) =>
        one.id !== source && one.owned && one.enrolled && !one.overLimit && !one.ownerDisabled && one.messaging && !one.isolated,
    )
    .map((one) => one.id)
    .sort();
}

/** What a daemon that took no flag is doing: messaging, as it always has. */
function handedMessaging(last: LinkSyncRecord | null): boolean {
  return last === null ? true : (last.messaging ?? true);
}

function handedIsolated(last: LinkSyncRecord | null): boolean {
  return last?.isolated ?? false;
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, at) => id === b[at]);
}

/**
 * `tooOldOn` is the daemon that answered 404, `undefined` if none has; a different daemon since is worth one more try.
 * Refusals come first. `force` passes the timing rules, and the relay for a machine this app reaches over loopback;
 * a person's Revoke still cannot reach a machine this app cannot reach.
 */
export function linkSyncDecision(input: {
  machine: LinkCandidate;
  targets: readonly string[];
  last: LinkSyncRecord | null;
  tooOldOn: string | null | undefined;
  failedAt: number | null;
  now: number;
  force?: boolean;
}): LinkSyncVerdict {
  const { machine, last, now } = input;
  const policyMoved = handedMessaging(last) !== machine.messaging || handedIsolated(last) !== machine.isolated;
  if (!machine.owned) return { sync: false, why: "not_owned" };
  if (!machine.enrolled) return { sync: false, why: "not_enrolled" };
  if (machine.overLimit || machine.ownerDisabled) return { sync: false, why: "switched_off" };
  // A policy still reaches a machine this app has over loopback alone, since its local agents are the ones it governs.
  if (!machine.reachable || (!machine.relayOnline && !policyMoved && input.force !== true)) {
    return { sync: false, why: "offline" };
  }
  if (input.tooOldOn !== undefined && input.tooOldOn === machine.daemon) return { sync: false, why: "daemon_too_old" };
  if (input.force === true) return { sync: true, why: "forced" };
  const retryAfter = policyMoved ? POLICY_RETRY_AFTER_MS : LINK_RETRY_AFTER_MS;
  if (input.failedAt !== null && now - input.failedAt < retryAfter) return { sync: false, why: "backing_off" };
  if (policyMoved) return { sync: true, why: "policy_changed" };
  if (last === null) return { sync: true, why: "never_synced" };
  if (!sameTargets(last.targets, [...input.targets].sort())) return { sync: true, why: "targets_changed" };
  if (last.earliestExpiresAt !== null && last.earliestExpiresAt - now < LINK_RENEW_WITHIN_MS) {
    return { sync: true, why: "expiring" };
  }
  if (now - last.syncedAt > LINK_RESYNC_AFTER_MS) return { sync: true, why: "stale" };
  return { sync: false, why: "current" };
}

export function linkRecordKey(scope: LinkScope, machineId: string): string {
  return `${scope.origin} ${scope.account} ${machineId}`;
}

function isRecord(value: unknown): value is LinkSyncRecord {
  if (value === null || typeof value !== "object") return false;
  const held = value as Record<string, unknown>;
  return (
    Array.isArray(held["targets"]) &&
    held["targets"].every((id) => typeof id === "string") &&
    (held["earliestExpiresAt"] === null || typeof held["earliestExpiresAt"] === "number") &&
    typeof held["syncedAt"] === "number" &&
    (held["messaging"] === undefined || typeof held["messaging"] === "boolean") &&
    (held["isolated"] === undefined || typeof held["isolated"] === "boolean") &&
    (held["policyAt"] === undefined || typeof held["policyAt"] === "number")
  );
}

function readRecords(): Record<string, LinkSyncRecord> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, LinkSyncRecord> = {};
    for (const [key, value] of Object.entries(parsed)) if (isRecord(value)) out[key] = value;
    return out;
  } catch {
    // Private mode, quota or a hand-edited value: every machine reads as never synced, which costs one mint each.
    return {};
  }
}

export function readLinkRecord(key: string): LinkSyncRecord | null {
  return readRecords()[key] ?? null;
}

/** Past the bound, the records synced longest ago go first. */
export function writeLinkRecord(key: string, record: LinkSyncRecord): void {
  const held = { ...readRecords(), [key]: record };
  const kept = Object.entries(held)
    .sort(([, a], [, b]) => b.syncedAt - a.syncedAt)
    .slice(0, MAX_LINK_RECORDS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Unwritten means the next launch mints again; nothing else depends on it.
  }
}

export function forgetLinkRecord(key: string): void {
  const held = readRecords();
  if (!(key in held)) return;
  delete held[key];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(held));
  } catch {
    // Unwritten means the old record stands until it goes stale, a day at most.
  }
}

export interface LinkSyncDeps {
  /** `POST /v1/machines/:id/links`. */
  link(machineId: string): Promise<MachineLinkAnswer>;
  /** `PUT /peers/links` on that machine's daemon, with exactly what `link` answered; `policy` is null when it answered none. */
  push(
    machineId: string,
    links: readonly MachineLinkGrant[],
    policy: { messaging: boolean; isolated?: boolean; policyAt?: number } | null,
  ): Promise<unknown>;
  now(): number;
}

/** The daemon's echo of what it enforces, read field by field; null from a daemon that predates the flag. */
export function messagingEcho(answer: unknown): PeerMessagingState | null {
  if (answer === null || typeof answer !== "object") return null;
  const held = (answer as Record<string, unknown>)["messaging"];
  if (held === null || typeof held !== "object") return null;
  const { policy, isolated, env, policyAt } = held as Record<string, unknown>;
  if (typeof policy !== "boolean" || typeof isolated !== "boolean" || typeof env !== "boolean" || typeof policyAt !== "number") {
    return null;
  }
  return { policy, isolated, env, policyAt };
}

export interface LinkSyncResult {
  verdict: LinkSyncVerdict;
  outcome: "skipped" | "synced" | "failed" | "daemon_too_old";
}

/** Best effort: nothing here throws, toasts or blocks, and what went wrong is kept per machine for the Agent links screen. */
export class LinkSync {
  private readonly tooOld = new Map<string, string | null>();
  private readonly failures = new Map<string, { at: number; text: string }>();
  private readonly echoes = new Map<string, PeerMessagingState | null>();
  private readonly running = new Map<string, Promise<LinkSyncResult>>();

  constructor(private readonly deps: LinkSyncDeps) {}

  /** `force` is a changed permission's: the machines still have to be reachable, but not a backoff away. */
  async syncAll(scope: LinkScope, machines: readonly LinkCandidate[], force = false): Promise<void> {
    await Promise.allSettled(
      machines.filter((one) => one.owned).map((one) => this.syncOne(scope, machines, one.id, force)),
    );
  }

  /** One run per machine at a time; a forced run waits out the one in flight rather than sharing its answer. */
  async syncOne(scope: LinkScope, machines: readonly LinkCandidate[], id: string, force = false): Promise<LinkSyncResult> {
    const prior = this.running.get(id);
    if (prior !== undefined) {
      if (!force) return prior;
      await prior;
    }
    const run = this.run(scope, machines, id, force).finally(() => {
      if (this.running.get(id) === run) this.running.delete(id);
    });
    this.running.set(id, run);
    return run;
  }

  status(machine: LinkCandidate): LinkSyncStatus {
    return {
      tooOld: this.tooOld.has(machine.id) && this.tooOld.get(machine.id) === machine.daemon,
      failure: this.failures.get(machine.id) ?? null,
      env: this.echoes.get(machine.id)?.env ?? null,
    };
  }

  private async run(
    scope: LinkScope,
    machines: readonly LinkCandidate[],
    id: string,
    force: boolean,
    retried = false,
  ): Promise<LinkSyncResult> {
    const machine = machines.find((one) => one.id === id);
    if (machine === undefined) return { verdict: { sync: false, why: "unknown_machine" }, outcome: "skipped" };
    const key = linkRecordKey(scope, id);
    // Forced by a changed permission, which revokes or mints links the record describes: a run that does not land leaves the next wake owing one.
    if (force) forgetLinkRecord(key);
    const targets = linkTargets(machines, id);
    const now = this.deps.now();
    const verdict = linkSyncDecision({
      machine,
      targets,
      last: readLinkRecord(key),
      tooOldOn: this.tooOld.has(id) ? (this.tooOld.get(id) ?? null) : undefined,
      failedAt: this.failures.get(id)?.at ?? null,
      now,
      force,
    });
    if (!verdict.sync) return { verdict, outcome: "skipped" };

    let answer: MachineLinkAnswer;
    try {
      answer = await this.deps.link(id);
    } catch (error) {
      this.failures.set(id, { at: now, text: errorText(error) });
      await this.deliverPolicyAlone(scope, id, error);
      return { verdict, outcome: "failed" };
    }
    const links = answer.links;
    const policy =
      answer.messaging === undefined
        ? null
        : {
            messaging: answer.messaging,
            ...(answer.isolated === undefined ? {} : { isolated: answer.isolated }),
            ...(answer.policyAt === undefined ? {} : { policyAt: answer.policyAt }),
          };
    let pushed: unknown;
    try {
      pushed = await this.deps.push(id, links, policy);
    } catch (error) {
      // Only the daemon's bare 404: the control plane answers an unrouted path with its envelope.
      if (meansRouteAbsent(error)) {
        this.tooOld.set(id, machine.daemon);
        this.failures.delete(id);
        return { verdict, outcome: "daemon_too_old" };
      }
      this.failures.set(id, { at: now, text: errorText(error) });
      return { verdict, outcome: "failed" };
    }
    this.tooOld.delete(id);
    this.failures.delete(id);
    const echo = messagingEcho(pushed);
    if (echo !== null || policy !== null) this.echoes.set(id, echo);
    // The daemon kept a newer switch than this answer: the answer was minted before somebody moved it, so ask again once.
    if (!retried && echo !== null && policy?.policyAt !== undefined && echo.policyAt > policy.policyAt) {
      return this.run(scope, machines, id, true, true);
    }
    const earliest = links.reduce<number | null>(
      (least, one) => (least === null || one.expiresAt < least ? one.expiresAt : least),
      null,
    );
    writeLinkRecord(key, {
      targets,
      earliestExpiresAt: earliest,
      syncedAt: now,
      messaging: policy?.messaging ?? machine.messaging,
      isolated: policy?.isolated ?? machine.isolated,
      ...(policy?.policyAt === undefined ? {} : { policyAt: policy.policyAt }),
    });
    return { verdict, outcome: "synced" };
  }

  /** A machine that can hold no link is still told its switch, from the refusal's detail; its links wait on the usual retry. */
  private async deliverPolicyAlone(scope: LinkScope, id: string, error: unknown): Promise<void> {
    const detail = error instanceof ApiError ? error.detail : null;
    if (detail === null || typeof detail !== "object") return;
    const { messaging, isolated, policyAt } = detail as Record<string, unknown>;
    if (typeof messaging !== "boolean" || typeof policyAt !== "number") return;
    if (isolated !== undefined && typeof isolated !== "boolean") return;
    const policy = { messaging, ...(isolated === undefined ? {} : { isolated }), policyAt };
    let pushed: unknown;
    try {
      pushed = await this.deps.push(id, [], policy);
    } catch {
      // The failure already recorded is the link's; this one is retried with it.
      return;
    }
    this.echoes.set(id, messagingEcho(pushed));
    const key = linkRecordKey(scope, id);
    const last = readLinkRecord(key);
    writeLinkRecord(key, { ...(last ?? { targets: [], earliestExpiresAt: null, syncedAt: 0 }), ...policy });
  }
}
