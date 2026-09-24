import type { DatabaseSync } from "node:sqlite";
import { newId } from "./keys.js";

// A device id is not a credential (stored unhashed, read only after a session resolves), and grants stay per user, never per device.

/** Over the cap registration is refused, never evicted: eviction would let one stolen session sign out every real device. */
export const MAX_DEVICES_PER_USER = 20;

export const DEVICE_REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Clamped at ingest, because POST /v1/login reaches this before any caller is known. */
export const MAX_DEVICE_NAME_CHARS = 128;
export const MAX_DEVICE_PLATFORM_CHARS = 32;
const MAX_DEVICE_ID_CHARS = 64;

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
  hasKey: boolean;
  keySetAt: number | null;
}

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/** A missing or malformed key becomes `null` rather than refusing the registration, so an old or buggy client still signs in. */
export function readDeviceInput(
  value: unknown,
): { name: string; platform: string; publicKey: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = clamp(record["name"], MAX_DEVICE_NAME_CHARS);
  const platform = clamp(record["platform"], MAX_DEVICE_PLATFORM_CHARS);
  if (name === null || platform === null) return null;
  return { name, platform, publicKey: readDevicePublicKey(record["publicKey"]) };
}

/** Strict about alphabet and length: base64url decoding skips unknown characters, so two spellings could name one key. */
export function readDevicePublicKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length !== DEVICE_PUBLIC_KEY_CHARS) return null;
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : null;
}

export const DEVICE_PUBLIC_KEY_CHARS = 43;

export function readDeviceId(value: unknown): string | null {
  return clamp(value, MAX_DEVICE_ID_CHARS);
}

/** The user_id clause must stay: without it one account could bind its session to another account's device. */
export function liveDeviceFor(db: DatabaseSync, userId: string, deviceId: string): string | null {
  const row = db
    .prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .get(deviceId, userId);
  return row === undefined ? null : String(row["id"]);
}

export class DeviceLimitError extends Error {
  constructor() {
    super("device limit reached");
    this.name = "DeviceLimitError";
  }
}

/** An id that will not bind is ignored and a new device registered, never refused: a refusal loops a client that stored a revoked id. */
export function adoptDevice(
  db: DatabaseSync,
  userId: string,
  offeredId: string | null,
  input: { name: string; platform: string; publicKey?: string | null },
  now = Date.now(),
): string {
  if (offeredId !== null) {
    const adopted = liveDeviceFor(db, userId, offeredId);
    if (adopted !== null) {
      db.prepare("UPDATE devices SET name = ?, platform = ? WHERE id = ?").run(input.name, input.platform, adopted);
      // Re-keyed in place, so a reset credential store does not spend a device slot.
      if (input.publicKey != null) setDeviceKey(db, userId, adopted, input.publicKey, now);
      return adopted;
    }
  }

  const live = db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL")
    .get(userId);
  if (Number(live?.["n"] ?? 0) >= MAX_DEVICES_PER_USER) throw new DeviceLimitError();

  const id = newId("dv");
  db.prepare(
    "INSERT INTO devices (id, user_id, name, platform, created_at, public_key, key_set_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, input.name, input.platform, now, input.publicKey ?? null, input.publicKey == null ? null : now);
  return id;
}

/** Scoped by user_id. No proof of possession: the daemon checks this key against the one its handshake authenticated. */
export function setDeviceKey(db: DatabaseSync, userId: string, deviceId: string, publicKey: string, now = Date.now()): void {
  db.prepare("UPDATE devices SET public_key = ?, key_set_at = ? WHERE id = ? AND user_id = ?").run(
    publicKey,
    now,
    deviceId,
    userId,
  );
}

/** By device id alone: the caller is the mint, and the id came from a session already resolved with the owner clause. */
export function deviceKeyFor(db: DatabaseSync, deviceId: string): string | null {
  const row = db.prepare("SELECT public_key FROM devices WHERE id = ? AND revoked_at IS NULL").get(deviceId);
  if (!row) return null;
  return row["public_key"] == null ? null : String(row["public_key"]);
}

/** A second statement rather than a join in resolveSession: both tables have `id` and `revoked_at`, and the bare-key read would take the device's. */
export function deviceRevoked(db: DatabaseSync, deviceId: string): boolean {
  const row = db.prepare("SELECT revoked_at FROM devices WHERE id = ?").get(deviceId);
  // A missing row is a swept id, not a revocation; the session's own expiry bounds it.
  if (row === undefined) return false;
  return row["revoked_at"] !== null;
}

/** Scoped by user_id; `null` for no live device of this caller, which the route answers with the same 404 as an unknown id. */
export function revokeDevice(
  db: DatabaseSync,
  userId: string,
  deviceId: string,
  now = Date.now(),
): { sessionsRevoked: number } | null {
  db.exec("BEGIN");
  try {
    const changed = db
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(now, deviceId, userId);
    if (changed.changes !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    const sessions = db
      .prepare(
        "UPDATE user_sessions SET revoked_at = ? WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .run(now, deviceId, userId);
    db.exec("COMMIT");
    return { sessionsRevoked: Number(sessions.changes) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listDevices(db: DatabaseSync, userId: string, now = Date.now()): DeviceRow[] {
  const rows = db
    .prepare(
      "SELECT d.id, d.name, d.platform, d.created_at, d.revoked_at, d.public_key, d.key_set_at, " +
        "(SELECT MAX(s.last_seen_at) FROM user_sessions s WHERE s.device_id = d.id) AS last_seen_at " +
        "FROM devices d WHERE d.user_id = ? AND (d.revoked_at IS NULL OR d.revoked_at > ?) " +
        "ORDER BY d.created_at DESC",
    )
    .all(userId, now - DEVICE_REVOKED_RETENTION_MS);
  return rows.map((row) => ({
    id: String(row["id"]),
    name: String(row["name"]),
    platform: String(row["platform"]),
    createdAt: Number(row["created_at"]),
    revokedAt: row["revoked_at"] === null ? null : Number(row["revoked_at"]),
    lastSeenAt: row["last_seen_at"] === null || row["last_seen_at"] === undefined ? null : Number(row["last_seen_at"]),
    hasKey: row["public_key"] != null,
    keySetAt: row["key_set_at"] == null ? null : Number(row["key_set_at"]),
  }));
}

/** The second statement removes devices whose user is gone: nothing cascades here. */
export function pruneDevices(db: DatabaseSync, now = Date.now()): number {
  const changed = db
    .prepare("DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at <= ?")
    .run(now - DEVICE_REVOKED_RETENTION_MS);
  db.exec("DELETE FROM devices WHERE user_id NOT IN (SELECT id FROM users)");
  return Number(changed.changes);
}
