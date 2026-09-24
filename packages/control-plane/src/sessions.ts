import type { DatabaseSync } from "node:sqlite";
import { deviceRevoked } from "./devices.js";
import { credentialMatches, keyPrefix, newId, newSessionToken } from "./keys.js";
import { MAX_ADDRESS_CHARS } from "./net.js";

/** Long on purpose: disabling the user, a password change and signing out everywhere are all checked live on the next request. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/** last_seen_at is written at most this often, so authentication does not cost an fsync per request. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 15 * 60 * 1000;

/** At the cap the oldest session is revoked; a new sign-in is never refused. */
export const MAX_SESSIONS_PER_USER = 10;

// Compiled once per database: both run on every request that presents a session.
interface AuthStatements {
  byPrefix: ReturnType<DatabaseSync["prepare"]>;
  touch: ReturnType<DatabaseSync["prepare"]>;
}

const authStatements = new WeakMap<DatabaseSync, AuthStatements>();

function statements(db: DatabaseSync): AuthStatements {
  let held = authStatements.get(db);
  if (held === undefined) {
    held = {
      // Single-table on purpose: joined with devices, the bare revoked_at read would be the device's. deviceRevoked asks separately.
      byPrefix: db.prepare(
        "SELECT id, user_id, token_hash, revoked_at, expires_at, last_seen_at, device_id FROM user_sessions WHERE prefix = ?",
      ),
      touch: db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?"),
    };
    authStatements.set(db, held);
  }
  return held;
}

const MAX_USER_AGENT_CHARS = 256;

export interface SessionRow {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  deviceName: string | null;
}

/** What a sign-in said about itself. Recorded, never trusted. */
export interface SessionOrigin {
  ip: string | null;
  userAgent: string | null;
}

export interface MintedSession {
  /** The only time this value exists anywhere. Only its hash is stored. */
  token: string;
  id: string;
  expiresAt: number;
}

/** The eviction shares the insert's transaction, so a user at the cap never briefly holds one extra session. */
export function mintSession(
  db: DatabaseSync,
  userId: string,
  origin: SessionOrigin,
  /** Required on purpose: a session minted without a device escapes per-device revocation, so a caller must pass `null` explicitly. */
  deviceId: string | null,
  now = Date.now(),
): MintedSession {
  const minted = newSessionToken();
  const id = newId("s");
  const expiresAt = now + SESSION_TTL_MS;

  db.exec("BEGIN");
  try {
    const live = db
      .prepare(
        "SELECT id FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? " +
          "ORDER BY created_at DESC",
      )
      .all(userId, now);
    // Everything past the cap, counting the one about to be inserted.
    for (const row of live.slice(MAX_SESSIONS_PER_USER - 1)) {
      db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ?").run(now, String(row["id"]));
    }
    db.prepare(
      "INSERT INTO user_sessions (id, user_id, prefix, token_hash, created_at, expires_at, last_seen_at, device_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, userId, minted.prefix, minted.hash, now, expiresAt, now, deviceId);
    db.prepare("INSERT INTO user_session_origins (session_id, ip, user_agent) VALUES (?, ?, ?)").run(
      id,
      clamp(origin.ip, MAX_ADDRESS_CHARS),
      clamp(origin.userAgent, MAX_USER_AGENT_CHARS),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { token: minted.token, id, expiresAt };
}

function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

export type SessionRefusal = "unknown" | "revoked" | "expired" | "device_revoked";

export interface ResolvedSession {
  id: string;
  userId: string;
  deviceId: string | null;
}

/** Reporting the reason is safe because reaching any refusal takes a real token; `device_revoked` tells the client to give up its stored device id. */
export function resolveSession(
  db: DatabaseSync,
  presented: string,
  now = Date.now(),
): { ok: true; session: ResolvedSession } | { ok: false; reason: SessionRefusal } {
  const token = presented.trim();
  if (token.length === 0) return { ok: false, reason: "unknown" };

  const rows = statements(db).byPrefix.all(keyPrefix(token));

  for (const row of rows) {
    if (!credentialMatches(token, String(row["token_hash"]))) continue;
    // Before the session's own refusals: revokeDevice also revokes the sessions, so a later check would never report device_revoked.
    const deviceId = row["device_id"] === null || row["device_id"] === undefined ? null : String(row["device_id"]);
    if (deviceId !== null && deviceRevoked(db, deviceId)) {
      return { ok: false, reason: "device_revoked" };
    }
    if (row["revoked_at"] !== null) return { ok: false, reason: "revoked" };
    if (Number(row["expires_at"]) <= now) return { ok: false, reason: "expired" };
    if (now - Number(row["last_seen_at"]) > SESSION_IDLE_MS) return { ok: false, reason: "expired" };
    return { ok: true, session: { id: String(row["id"]), userId: String(row["user_id"]), deviceId } };
  }
  return { ok: false, reason: "unknown" };
}

export function touchSession(db: DatabaseSync, sessionId: string, now = Date.now()): void {
  try {
    statements(db).touch.run(now, sessionId, now - LAST_SEEN_WRITE_INTERVAL_MS);
  } catch {
    // Bookkeeping only. A busy database must not turn a valid request into a 500.
  }
}

/** Idempotent: false when there was no live session to revoke. */
export function revokeSession(db: DatabaseSync, sessionId: string, now = Date.now()): boolean {
  const changed = db
    .prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now, sessionId);
  return changed.changes === 1;
}

/** `exceptId` spares the caller's own session on a password change; `null` revokes every one. */
export function revokeAllSessions(
  db: DatabaseSync,
  userId: string,
  exceptId: string | null,
  now = Date.now(),
): number {
  const changed =
    exceptId === null
      ? db
          .prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
          .run(now, userId)
      : db
          .prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?")
          .run(now, userId, exceptId);
  return Number(changed.changes);
}

export function listSessions(db: DatabaseSync, userId: string, now = Date.now()): SessionRow[] {
  const rows = db
    .prepare(
      // Every column qualified: devices shares id, created_at and revoked_at with user_sessions.
      "SELECT s.id, s.created_at, s.expires_at, s.last_seen_at, o.ip, o.user_agent, " +
        "s.device_id, d.name AS device_name FROM user_sessions s " +
        "LEFT JOIN user_session_origins o ON o.session_id = s.id " +
        "LEFT JOIN devices d ON d.id = s.device_id " +
        "WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.created_at DESC",
    )
    .all(userId, now);
  return rows
    .map((row) => ({
      id: String(row["id"]),
      createdAt: Number(row["created_at"]),
      expiresAt: Number(row["expires_at"]),
      lastSeenAt: Number(row["last_seen_at"]),
      ip: row["ip"] === null || row["ip"] === undefined ? null : String(row["ip"]),
      userAgent: row["user_agent"] === null || row["user_agent"] === undefined ? null : String(row["user_agent"]),
      deviceId: row["device_id"] === null || row["device_id"] === undefined ? null : String(row["device_id"]),
      deviceName: row["device_name"] === null || row["device_name"] === undefined ? null : String(row["device_name"]),
    }))
    .filter((row) => now - row.lastSeenAt <= SESSION_IDLE_MS);
}

export const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function pruneSessions(db: DatabaseSync, now = Date.now()): number {
  const cutoff = now - REVOKED_RETENTION_MS;
  const changed = db
    .prepare("DELETE FROM user_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)")
    .run(now, cutoff);
  // foreign_keys is OFF, so origins of deleted sessions are swept here by hand.
  db.exec("DELETE FROM user_session_origins WHERE session_id NOT IN (SELECT id FROM user_sessions)");
  return Number(changed.changes);
}
