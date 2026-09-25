import { errorText, meansRouteAbsent } from "./http";
import type { MachineState } from "./machine";
import type { MachineLinkGrant, MachineLinkRecord, PeerLinkView } from "./wire";

// Handing each of your machines its links to the others: minted by the control plane, carried to the daemon. No DOM in the module body: webcheck imports it.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A token lives 90 days; the set is re-minted once the earliest pushed has less than this left. */
export const LINK_RENEW_WITHIN_MS = 45 * DAY_MS;

/** And once a day whatever the expiry, which is what picks up a machine the control plane skipped. */
export const LINK_RESYNC_AFTER_MS = DAY_MS;

/** Not on every wake: each attempt spends the account's control-plane write budget, which minting machine tokens shares. */
export const LINK_RETRY_AFTER_MS = 15 * 60 * 1000;

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
}

export interface LinkCandidate {
  id: string;
  owned: boolean;
  enrolled: boolean;
  relayOnline: boolean;
  reachable: boolean;
  overLimit: boolean;
  ownerDisabled: boolean;
  /** The daemon process that last answered a probe, so an update is noticed without reading the version label. */
  daemon: string | null;
}

export type LinkSyncWhy =
  | "never_synced"
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
    daemon: machine.health?.instanceId ?? null,
  };
}

/** Who a machine would be linked to, as far as this client can tell: the control plane also skips a machine with no pinned key. */
export function linkTargets(machines: readonly LinkCandidate[], source: string): string[] {
  return machines
    .filter((one) => one.id !== source && one.owned && one.enrolled && !one.overLimit && !one.ownerDisabled)
    .map((one) => one.id)
    .sort();
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, at) => id === b[at]);
}

/**
 * `tooOldOn` is the daemon that answered 404, `undefined` if none has; a different daemon since is worth one more try.
 * Refusals come first and `force` passes only the timing rules: a person's Revoke still cannot reach an offline machine.
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
  if (!machine.owned) return { sync: false, why: "not_owned" };
  if (!machine.enrolled) return { sync: false, why: "not_enrolled" };
  if (machine.overLimit || machine.ownerDisabled) return { sync: false, why: "switched_off" };
  if (!machine.relayOnline || !machine.reachable) return { sync: false, why: "offline" };
  if (input.tooOldOn !== undefined && input.tooOldOn === machine.daemon) return { sync: false, why: "daemon_too_old" };
  if (input.force === true) return { sync: true, why: "forced" };
  if (input.failedAt !== null && now - input.failedAt < LINK_RETRY_AFTER_MS) return { sync: false, why: "backing_off" };
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
    typeof held["syncedAt"] === "number"
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

export interface LinkSyncDeps {
  /** `POST /v1/machines/:id/links`. */
  link(machineId: string): Promise<MachineLinkGrant[]>;
  /** `PUT /peers/links` on that machine's daemon, with exactly what `link` answered. */
  push(machineId: string, links: readonly MachineLinkGrant[]): Promise<unknown>;
  now(): number;
}

export interface LinkSyncResult {
  verdict: LinkSyncVerdict;
  outcome: "skipped" | "synced" | "failed" | "daemon_too_old";
}

/** Best effort: nothing here throws, toasts or blocks, and what went wrong is kept per machine for the Agent links screen. */
export class LinkSync {
  private readonly tooOld = new Map<string, string | null>();
  private readonly failures = new Map<string, { at: number; text: string }>();
  private readonly running = new Map<string, Promise<LinkSyncResult>>();

  constructor(private readonly deps: LinkSyncDeps) {}

  async syncAll(scope: LinkScope, machines: readonly LinkCandidate[]): Promise<void> {
    await Promise.allSettled(
      machines.filter((one) => one.owned).map((one) => this.syncOne(scope, machines, one.id)),
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
    };
  }

  private async run(scope: LinkScope, machines: readonly LinkCandidate[], id: string, force: boolean): Promise<LinkSyncResult> {
    const machine = machines.find((one) => one.id === id);
    if (machine === undefined) return { verdict: { sync: false, why: "unknown_machine" }, outcome: "skipped" };
    const key = linkRecordKey(scope, id);
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

    let links: MachineLinkGrant[];
    try {
      links = await this.deps.link(id);
    } catch (error) {
      this.failures.set(id, { at: now, text: errorText(error) });
      return { verdict, outcome: "failed" };
    }
    try {
      await this.deps.push(id, links);
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
    const earliest = links.reduce<number | null>(
      (least, one) => (least === null || one.expiresAt < least ? one.expiresAt : least),
      null,
    );
    writeLinkRecord(key, { targets, earliestExpiresAt: earliest, syncedAt: now });
    return { verdict, outcome: "synced" };
  }
}

export type LinkDirection = "out" | "in";

export const LINK_DIRECTION_TEXT: Record<LinkDirection, string> = {
  out: "can message",
  in: "can be messaged by",
};

export interface LinkRow {
  id: string;
  direction: LinkDirection;
  other: { id: string; name: string };
  /** The machine whose daemon holds the token, which is the one a re-sync hands a new one. */
  source: string;
}

/** Grouped by the other machine, the way this machine reaches it before the way it is reached. */
export function linkRows(links: readonly MachineLinkRecord[], machine: string): LinkRow[] {
  return links
    .filter((link) => link.source.id === machine || link.target.id === machine)
    .map(
      (link): LinkRow =>
        link.source.id === machine
          ? { id: link.id, direction: "out", other: link.target, source: link.source.id }
          : { id: link.id, direction: "in", other: link.source, source: link.source.id },
    )
    .sort(
      (a, b) =>
        a.other.name.localeCompare(b.other.name) ||
        a.other.id.localeCompare(b.other.id) ||
        (a.direction === b.direction ? 0 : a.direction === "out" ? -1 : 1),
    );
}

/** Only an outgoing link has a daemon-side answer on this machine; `held` is null until `GET /peers/links` has answered. */
export function linkNote(
  row: LinkRow,
  held: readonly PeerLinkView[] | null,
  machineName: string,
): { text: string; failed: boolean } | null {
  if (row.direction !== "out" || held === null) return null;
  const entry = held.find((one) => one.id === row.id);
  if (entry === undefined) return { text: `Not handed to ${machineName} yet.`, failed: false };
  if (entry.lastError === null || entry.lastError.length === 0) return null;
  return { text: entry.lastError, failed: true };
}
