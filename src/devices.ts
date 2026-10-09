import { approvalCode, keyFingerprint, type DeviceDescription } from "@reemoat/protocol";
import type { Principal } from "./auth.js";

// Which keys have opened an encrypted channel to this machine: a journal while the lock is off, the allowlist while it is on (Q1.655).
// Loopback is outside it: a request with no channel has no key, and is this computer's own.

export type KnownDeviceKind = "device" | "machine";

export type KnownDeviceState = "known" | "pending";

export interface KnownDevice {
  /** RFC 7638 thumbprint of the initiator's static key, as a capability's cnf.jkt spells it. */
  kth: string;
  publicKey: string;
  kind: KnownDeviceKind;
  /** What the caller calls itself, or the Authority's label for a linked machine. Drawn, never decided on. */
  label: string | null;
  platform: string | null;
  subject: string;
  /** The Authority's id for it: a device id, or the linked machine's. */
  ref: string | null;
  state: KnownDeviceState;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface KnownDeviceStore {
  get(kth: string): KnownDevice | null;
  list(): KnownDevice[];
  save(device: KnownDevice): void;
  remove(kth: string): boolean;
  locked(): boolean;
  setLocked(on: boolean): void;
}

export interface DeviceView {
  id: string;
  kind: KnownDeviceKind;
  label: string | null;
  platform: string | null;
  subject: string;
  ref: string | null;
  state: KnownDeviceState;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Compared by eye with what the waiting device shows; null with no machine key to derive it from. */
  code: string | null;
}

export const MAX_DEVICE_LABEL_CHARS = 128;
export const MAX_DEVICE_PLATFORM_CHARS = 32;

/** Journal rows kept while the lock is off; the least recently seen goes first. A locked list is never trimmed. */
export const MAX_KNOWN_DEVICES = 256;

/** Requests waiting at once. Past it the oldest goes, and a device still asking comes back on its next dial. */
export const MAX_PENDING_DEVICES = 16;

export const PENDING_DEVICE_TTL_MS = 24 * 60 * 60 * 1000;

/** A row's last_seen moves at most this often: a pool opens a connection per request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Control characters out first: this is drawn in a list and printed in a terminal.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, max);
}

export function readDeviceDescription(value: unknown): DeviceDescription | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = clamp(record["name"], MAX_DEVICE_LABEL_CHARS);
  if (name === null) return null;
  return { name, platform: clamp(record["platform"], MAX_DEVICE_PLATFORM_CHARS) ?? "" };
}

function decodeKey(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  return bytes.length === 32 ? bytes : null;
}

export class DeviceGate {
  private readonly watchers = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: KnownDeviceStore,
    /** Read at every use: a 409 on the dial can promote another key (machineKeyRotation). */
    private readonly machineKey: () => string | null,
  ) {}

  get locked(): boolean {
    return this.store.locked();
  }

  /** Called once per channel, after the capability verified against the handshake's key. False refuses the channel. */
  admit(
    peer: { kth: string; publicKey: Uint8Array },
    principal: Principal,
    described: DeviceDescription | null,
    now = Date.now(),
  ): boolean {
    const kind: KnownDeviceKind = principal.link === null ? "device" : "machine";
    const label = kind === "machine" ? clamp(principal.link?.sourceLabel, MAX_DEVICE_LABEL_CHARS) : (described?.name ?? null);
    const platform = kind === "machine" ? null : described?.platform || null;
    const ref = kind === "machine" ? (principal.link?.sourceMachineId ?? null) : principal.deviceId;
    let held: KnownDevice | null;
    let locked: boolean;
    try {
      held = this.store.get(peer.kth);
      locked = this.store.locked();
    } catch {
      // Whether this key is let in cannot be read, so it is not: the app dials again, and an open door is the worse mistake.
      return false;
    }
    const next: KnownDevice = {
      kth: peer.kth,
      publicKey: Buffer.from(peer.publicKey).toString("base64url"),
      kind,
      // A build that sends no description must not blank what an earlier one said.
      label: label ?? held?.label ?? null,
      platform: platform ?? held?.platform ?? null,
      subject: principal.subject,
      ref: ref ?? held?.ref ?? null,
      state: "known",
      firstSeenAt: held?.firstSeenAt ?? now,
      lastSeenAt: now,
    };

    if (held?.state === "known") {
      if (changed(held, next) || now - held.lastSeenAt >= TOUCH_INTERVAL_MS) this.record(() => this.store.save(next));
      return true;
    }
    if (!locked) {
      this.record(() => {
        this.store.save(next);
        this.trim("known", MAX_KNOWN_DEVICES);
      });
      return true;
    }
    this.record(() => {
      this.store.save({ ...next, state: "pending" });
      this.expirePending(now);
      this.trim("pending", MAX_PENDING_DEVICES);
    });
    return false;
  }

  /** The decision is already made when this runs: a write that will not land costs a stale row, never a channel. */
  private record(write: () => void): void {
    try {
      write();
    } catch {
      // Nothing to report through: the next dial writes the row again.
    }
  }

  /** Ends a channel when its key is removed; the returned function forgets the watcher. */
  watch(kth: string, onRemoved: () => void): () => void {
    const set = this.watchers.get(kth) ?? new Set<() => void>();
    set.add(onRemoved);
    this.watchers.set(kth, set);
    return () => {
      set.delete(onRemoved);
      if (set.size === 0) this.watchers.delete(kth);
    };
  }

  list(now = Date.now()): DeviceView[] {
    this.expirePending(now);
    const machine = decodeKey(this.machineKey() ?? "");
    return this.store
      .list()
      .sort((a, b) => Number(b.state === "pending") - Number(a.state === "pending") || b.lastSeenAt - a.lastSeenAt)
      .map((device) => {
        const key = decodeKey(device.publicKey);
        return {
          id: device.kth,
          kind: device.kind,
          label: device.label,
          platform: device.platform,
          subject: device.subject,
          ref: device.ref,
          state: device.state,
          firstSeenAt: device.firstSeenAt,
          lastSeenAt: device.lastSeenAt,
          code: machine === null || key === null ? null : approvalCode(key, machine),
        };
      });
  }

  /** What the machine itself prints, for comparing against what an app pinned. */
  fingerprint(): string | null {
    const machine = decodeKey(this.machineKey() ?? "");
    return machine === null ? null : keyFingerprint(machine);
  }

  /** Zero while unlocked: nothing waits on anybody then, and a row left over is let in at its next dial. */
  pendingCount(now = Date.now()): number {
    if (!this.store.locked()) return 0;
    return this.store.list().filter((device) => device.state === "pending" && now - device.lastSeenAt < PENDING_DEVICE_TTL_MS)
      .length;
  }

  /** By id, or by the code as somebody reads it off the waiting screen. Null when nothing or more than one row answers. */
  find(wanted: string): KnownDevice | null {
    const exact = this.store.get(wanted);
    if (exact !== null) return exact;
    const spelled = wanted.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (spelled.length === 0) return null;
    const hits = this.list()
      .filter((view) => view.code !== null && view.code.replace(/-/g, "") === spelled)
      .map((view) => this.store.get(view.id));
    const one = hits.length === 1 ? hits[0] : null;
    return one ?? null;
  }

  approve(kth: string): boolean {
    const held = this.store.get(kth);
    if (held === null) return false;
    if (held.state !== "known") this.store.save({ ...held, state: "known" });
    return true;
  }

  /** Lets a caller in beside the switch it is about to turn on, when no channel ever recorded its key. */
  vouch(publicKey: string, kth: string, principal: Principal, described: DeviceDescription | null, now = Date.now()): boolean {
    const key = decodeKey(publicKey);
    if (key === null) return false;
    const held = this.store.get(kth);
    this.store.save({
      kth,
      publicKey,
      kind: "device",
      label: described?.name ?? held?.label ?? null,
      platform: described?.platform || held?.platform || null,
      subject: principal.subject,
      ref: principal.deviceId ?? held?.ref ?? null,
      state: "known",
      firstSeenAt: held?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
    return true;
  }

  remove(kth: string): boolean {
    const removed = this.store.remove(kth);
    for (const end of [...(this.watchers.get(kth) ?? [])]) end();
    return removed;
  }

  setLocked(on: boolean): void {
    this.store.setLocked(on);
  }

  private expirePending(now: number): void {
    for (const device of this.store.list()) {
      if (device.state === "pending" && now - device.lastSeenAt >= PENDING_DEVICE_TTL_MS) this.store.remove(device.kth);
    }
  }

  private trim(state: KnownDeviceState, max: number): void {
    const rows = this.store
      .list()
      .filter((device) => device.state === state)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const device of rows.slice(0, Math.max(0, rows.length - max))) this.store.remove(device.kth);
  }
}

function changed(held: KnownDevice, next: KnownDevice): boolean {
  return (
    held.label !== next.label ||
    held.platform !== next.platform ||
    held.subject !== next.subject ||
    held.ref !== next.ref ||
    held.kind !== next.kind
  );
}
