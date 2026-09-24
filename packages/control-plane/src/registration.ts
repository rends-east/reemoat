import type { DatabaseSync } from "node:sqlite";
import { hashCredential, newId, newRegistrationToken } from "./keys.js";
import { foldEmail } from "./mail/address.js";

// A pending sign-up is not a user: an expired row stops holding its name with no sweep, since every probe filters on used_at and expires_at.

export const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Required at every call site: used_from is the only trail, and the two "taken" cases are different events. */
export type RegistrationBurnReason = "superseded" | "name_taken" | "email_taken";

export interface PendingRow {
  id: string;
  name: string;
  email: string;
  emailFolded: string;
  passwordHash: string;
}

/** The one login-name fold, on both sides of every comparison. Not NFKC: it must keep matching stored name_folded rows. */
export function foldName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Folded, so friendlier than the BINARY unique index behind it; the UNIQUE violation at confirm time is the race backstop. */
export function nameTaken(db: DatabaseSync, name: string, now = Date.now()): boolean {
  const folded = foldName(name);
  const user = db.prepare("SELECT 1 AS hit FROM users WHERE lower(name) = ?").get(folded);
  if (user !== undefined) return true;
  const pending = db
    .prepare(
      "SELECT 1 AS hit FROM pending_registrations WHERE name_folded = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(folded, now);
  return pending !== undefined;
}

/** Ignores a live sign-up holding the same address, so signing up again replaces a lost confirmation. A different address still collides. */
export function nameTakenByAnother(
  db: DatabaseSync,
  name: string,
  emailFolded: string | null,
  now = Date.now(),
): boolean {
  const folded = foldName(name);
  if (db.prepare("SELECT 1 AS hit FROM users WHERE lower(name) = ?").get(folded) !== undefined) return true;
  // IS NOT, so a null address (the no-mail arm) collides with every live row.
  const held = db
    .prepare(
      "SELECT 1 AS hit FROM pending_registrations " +
        "WHERE name_folded = ? AND used_at IS NULL AND expires_at > ? AND email_folded IS NOT ?",
    )
    .get(folded, now, emailFolded);
  return held !== undefined;
}

export function pendingForEmail(db: DatabaseSync, emailFolded: string, now = Date.now()): PendingRow | null {
  const row = db
    .prepare(
      "SELECT id, name, email, email_folded, password_hash FROM pending_registrations " +
        "WHERE email_folded = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(emailFolded, now);
  return row === undefined ? null : rowOf(row);
}

function rowOf(row: Record<string, unknown>): PendingRow {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    email: String(row["email"]),
    emailFolded: String(row["email_folded"]),
    passwordHash: String(row["password_hash"]),
  };
}

export interface MintedRegistration {
  token: string;
  expiresAt: number;
}

/**
 * Supersedes only the same address under the same folded name; the route guarantees the values are the caller's own.
 * The caller hashes first, so confirmation runs no KDF and every registration branch costs the same.
 */
export function mintRegistration(
  db: DatabaseSync,
  input: { name: string; email: string; passwordHash: string },
  ttlMs = REGISTRATION_TTL_MS,
  now = Date.now(),
): MintedRegistration {
  const minted = newRegistrationToken();
  const expiresAt = now + ttlMs;
  const emailFolded = foldEmail(input.email);

  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE pending_registrations SET used_at = ?, used_from = 'superseded' " +
        "WHERE email_folded = ? AND name_folded = ? AND used_at IS NULL",
    ).run(now, emailFolded, foldName(input.name));
    db.prepare(
      "INSERT INTO pending_registrations " +
        "(id, token_hash, name, name_folded, email, email_folded, password_hash, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      newId("pr"),
      minted.hash,
      input.name,
      foldName(input.name),
      input.email,
      emailFolded,
      input.passwordHash,
      now,
      expiresAt,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { token: minted.token, expiresAt };
}

/** Spends the link once and returns the row it claimed. */
export function claimRegistration(
  db: DatabaseSync,
  token: string,
  from: string,
  now = Date.now(),
): PendingRow | null {
  const hash = hashCredential(token);
  const claimed = db
    .prepare(
      "UPDATE pending_registrations SET used_at = ?, used_from = ? " +
        "WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .run(now, from, hash, now);
  if (Number(claimed.changes) !== 1) return null;

  const row = db
    .prepare("SELECT id, name, email, email_folded, password_hash FROM pending_registrations WHERE token_hash = ?")
    .get(hash);
  return row === undefined ? null : rowOf(row);
}

/** After a UNIQUE violation at confirm time: burned rather than restored, since its name is unusable. */
export function burnRegistration(
  db: DatabaseSync,
  id: string,
  reason: RegistrationBurnReason,
  now = Date.now(),
): void {
  db.prepare("UPDATE pending_registrations SET used_at = ?, used_from = ? WHERE id = ?").run(now, reason, id);
}

/** Reclaims expired rows. A name is free the moment its row lapses, whether or not this runs. */
export function pruneRegistrations(db: DatabaseSync, now = Date.now()): number {
  const changed = db.prepare("DELETE FROM pending_registrations WHERE expires_at < ?").run(now - REGISTRATION_TTL_MS);
  return Number(changed.changes);
}
