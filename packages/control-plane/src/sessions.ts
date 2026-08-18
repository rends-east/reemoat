import type { DatabaseSync } from "node:sqlite";
import { credentialMatches, keyPrefix, newId, newSessionToken } from "./keys.js";
import { MAX_ADDRESS_CHARS } from "./net.js";

/**
 * Signed-in browsers.
 *
 * A session is a bearer token and a row saying when it stops working. It is not a
 * cookie and it is not ambient — see the comment on `user_sessions` in
 * `schema.sql` for why that is load-bearing rather than a preference.
 *
 * Everything here is synchronous, like the rest of this service's storage:
 * `node:sqlite` is synchronous, so an async wrapper would buy nothing and cost the
 * ability to reason about ordering. Only `password.ts` is async, because only
 * scrypt belongs on the threadpool.
 */

/**
 * How long a session lives, absolutely.
 *
 * Long, deliberately. The thing this bounds is a stolen token nobody noticed, and
 * the three levers that actually matter are immediate rather than timed: disable
 * the user, change the password, sign out everywhere. All three are checked live
 * on the next request. A short absolute expiry would mostly succeed at signing
 * out the person holding the phone this product exists to be used from.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a session may sit unused.
 *
 * Separate from the absolute expiry and shorter, so a token left on a device
 * somebody stopped using stops working long before the thirty days are up.
 */
export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How stale `last_seen_at` may get before it is worth a write.
 *
 * This is the whole reason idle expiry is affordable. Writing on every request
 * would mean an `UPDATE` on the authentication path of the process that carries
 * every relay tunnel, against a database running `synchronous = FULL` — an fsync
 * per request, to record something nothing authenticates against. Fifteen minutes
 * of imprecision against a fourteen-day window costs nothing anybody can observe.
 *
 * Exported for a driver. It was reachable from nowhere, so the guard that makes
 * idle expiry affordable at all was asserted nowhere either — and a guard that
 * silently stops guarding looks exactly like one that works.
 */
export const LAST_SEEN_WRITE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How many live sessions one user may hold.
 *
 * Phones, laptops, a tab somebody forgot. The cap exists so signing in cannot
 * grow a table without bound, and the oldest is revoked rather than the newest
 * refused — being unable to sign in on a new device because of an old one is the
 * wrong failure.
 *
 * Exported for the same reason as `LAST_SEEN_WRITE_INTERVAL_MS`: the eviction
 * inside `mintSession` is the only thing bounding this table, and a driver that
 * cannot name the cap cannot assert that the eleventh sign-in retires the first.
 */
export const MAX_SESSIONS_PER_USER = 10;

/**
 * The two statements on the authentication path, compiled once per database.
 *
 * `store.ts` sets this precedent and states the reason: every proxied request and
 * every WebSocket upgrade goes through authorization, so `db.prepare(...)` inline
 * means re-compiling on every request, synchronously, on the event loop that also
 * carries the tunnels. These two are reached by every authenticated request that
 * presents a session, which is the same hot path one door along.
 *
 * Keyed by the database handle so tests that open several in-memory databases
 * cannot collide, and weak so a closed database is not retained by its cache.
 * Every other statement in this file is administrative and prepared inline.
 */
interface AuthStatements {
  byPrefix: ReturnType<DatabaseSync["prepare"]>;
  touch: ReturnType<DatabaseSync["prepare"]>;
}

const authStatements = new WeakMap<DatabaseSync, AuthStatements>();

function statements(db: DatabaseSync): AuthStatements {
  let held = authStatements.get(db);
  if (held === undefined) {
    held = {
      byPrefix: db.prepare(
        "SELECT id, user_id, token_hash, revoked_at, expires_at, last_seen_at FROM user_sessions WHERE prefix = ?",
      ),
      touch: db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?"),
    };
    authStatements.set(db, held);
  }
  return held;
}

/**
 * How much of a `User-Agent` to keep.
 *
 * Caller-supplied and unbounded — Chrome's own is ~130 characters and a bot's can
 * be a paragraph. Clamped at ingest, like every other agent-shaped string in this
 * system, rather than at render: the bound belongs where the value enters the
 * database, not where somebody remembers to apply it.
 */
const MAX_USER_AGENT_CHARS = 256;

export interface SessionRow {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  /**
   * Where this session signed in from, or `null` — which happens for two
   * different reasons a client cannot tell apart and does not need to: the
   * session predates `user_session_origins`, or the value was not knowable.
   *
   * Neither is evidence. See the table's comment in `schema.sql`.
   */
  ip: string | null;
  userAgent: string | null;
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

/**
 * Issue a session, and retire the oldest if the user is at the cap.
 *
 * The eviction is inside the same transaction as the insert, so a user at the cap
 * cannot briefly hold eleven and cannot lose one to a mint that then fails.
 */
export function mintSession(
  db: DatabaseSync,
  userId: string,
  /**
   * Required with no default, deliberately. A default would let a future
   * sign-in path forget to record where it came from and produce a row the list
   * cannot describe, silently — the same argument `LaunchOptions.fileIo` makes
   * one package over. Passing `{ip: null, userAgent: null}` is allowed and is a
   * decision somebody made.
   */
  origin: SessionOrigin,
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
      "INSERT INTO user_sessions (id, user_id, prefix, token_hash, created_at, expires_at, last_seen_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, userId, minted.prefix, minted.hash, now, expiresAt, now);
    // In the same transaction as the session it describes: a row in one table and
    // not the other is a session the list draws as a device that never existed,
    // or a device belonging to no session.
    db.prepare("INSERT INTO user_session_origins (session_id, ip, user_agent) VALUES (?, ?, ?)").run(
      id,
      // The address is clamped a second time, on `net.ts`'s own bound rather
      // than a copy of the number: `callerAddressOf` already cut it, so this is
      // the belt — what stops a caller who assembled a `SessionOrigin` by some
      // other route from putting a paragraph in this column.
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

/** Clamp a caller-supplied string, mapping empty to `null` so absence has one shape. */
function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

export type SessionRefusal = "unknown" | "revoked" | "expired";

export interface ResolvedSession {
  id: string;
  userId: string;
}

/**
 * Which session a presented token is, or why it is not one.
 *
 * Three refusals rather than one, and unlike the login route this distinction is
 * safe to report: to reach any of them you had to present a real 256-bit token.
 * The client needs it — "expired" means show the sign-in form, "unknown" means the
 * stored credential is garbage — and `apiKeyAuth` already draws the same line
 * between `api_key_revoked` and `invalid_api_key`.
 */
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
    if (row["revoked_at"] !== null) return { ok: false, reason: "revoked" };
    if (Number(row["expires_at"]) <= now) return { ok: false, reason: "expired" };
    if (now - Number(row["last_seen_at"]) > SESSION_IDLE_MS) return { ok: false, reason: "expired" };
    return { ok: true, session: { id: String(row["id"]), userId: String(row["user_id"]) } };
  }
  return { ok: false, reason: "unknown" };
}

/**
 * Record that a session was used, at most once every fifteen minutes.
 *
 * Called from the authentication path, so the guard is the point rather than an
 * optimisation — see `LAST_SEEN_WRITE_INTERVAL_MS`. Failure is swallowed: this is
 * bookkeeping, and a request that authenticated must not fail because a write
 * that nothing reads for a decision did.
 */
export function touchSession(db: DatabaseSync, sessionId: string, now = Date.now()): void {
  try {
    statements(db).touch.run(now, sessionId, now - LAST_SEEN_WRITE_INTERVAL_MS);
  } catch {
    // Bookkeeping only. A busy database must not turn a valid request into a 500.
  }
}

/** Revoke one session. Idempotent; the caller decides whether "already gone" is a 404. */
export function revokeSession(db: DatabaseSync, sessionId: string, now = Date.now()): boolean {
  const changed = db
    .prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now, sessionId);
  return changed.changes === 1;
}

/**
 * Revoke every live session for a user, optionally sparing one.
 *
 * `exceptId` is what a password change passes: revoking *all* of them would sign
 * you out of the tab you just used, which reads as the change having failed and
 * trains people not to change passwords. Pass `null` to revoke everything, which
 * is what a disable and an admin reset do.
 */
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

/** This user's live sessions, newest first. Bounded by the per-user cap, so it needs no paging. */
export function listSessions(db: DatabaseSync, userId: string, now = Date.now()): SessionRow[] {
  const rows = db
    .prepare(
      "SELECT s.id, s.created_at, s.expires_at, s.last_seen_at, o.ip, o.user_agent FROM user_sessions s " +
        // LEFT, because a session that predates `user_session_origins` has no row
        // there and must still be listed — it is the one you are most likely to
        // want to end.
        "LEFT JOIN user_session_origins o ON o.session_id = s.id " +
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
    }))
    .filter((row) => now - row.lastSeenAt <= SESSION_IDLE_MS);
}

/**
 * How long a revoked row is kept after it stops working.
 *
 * `schema.sql` says rows are revoked rather than deleted so that "a list somebody
 * is shown should be able to say a session ended rather than forget it" — and
 * **no reader surfaces them today**: `listSessions` and the admin count both
 * filter `revoked_at IS NULL`, so a revoked row is invisible everywhere in this
 * service. What was left was the retention without the feature, at the absolute
 * TTL: a row somebody signed out of on day one sat there for thirty more.
 *
 * Seven days is what an audit read is actually for — "was I signed out on
 * Tuesday, and from where" is a question asked within the week, and the origin
 * row it joins to is caller-supplied and not evidence anyway (see `net.ts`). So
 * this is **a bound rather than a feature**: it is short because nothing reads
 * it, and it is not zero because the day something does read it, deleting on
 * revoke would have made the answer unrecoverable.
 */
export const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop rows that can never authenticate again.
 *
 * Run at startup, beside the other one-time work. Deliberately not on a timer: the
 * table is bounded by the per-user cap already, so this is housekeeping rather
 * than a bound, and a timer would be a second thing writing to this database for
 * no reason anybody can observe.
 */
export function pruneSessions(db: DatabaseSync, now = Date.now()): number {
  const cutoff = now - REVOKED_RETENTION_MS;
  const changed = db
    .prepare("DELETE FROM user_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)")
    .run(now, cutoff);
  /*
   * The origins of sessions that no longer exist, in the same pass.
   *
   * `store.ts` sets `PRAGMA foreign_keys = OFF`, so nothing deletes these for us
   * and the alternative to sweeping them is a table that only ever grows — the
   * one thing this whole function exists to prevent one table over. Written as
   * "orphans" rather than "the ids just deleted" so it also collects rows left
   * behind by any earlier version that forgot.
   */
  db.exec("DELETE FROM user_session_origins WHERE session_id NOT IN (SELECT id FROM user_sessions)");
  return Number(changed.changes);
}
