import type { DatabaseSync } from "node:sqlite";
import { hashCredential, newEmailToken, newId } from "./keys.js";
import { foldEmail } from "./mail/address.js";

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** Short: the only token here that replaces a credential, and the person asking is at the screen. */
export const RESET_TTL_MS = 60 * 60 * 1000;

export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export type TokenPurpose = "verify" | "reset";

/** Required at every burn: used_from is the only forensic trail. */
export type TokenBurnReason =
  | "superseded"
  | "password_changed"
  | "email_changed"
  | "user_disabled"
  | "user_deleted";

export interface EmailRow {
  email: string;
  emailFolded: string;
  verifiedAt: number | null;
}

export function emailOf(db: DatabaseSync, userId: string): EmailRow | null {
  const row = db.prepare("SELECT email, email_folded, verified_at FROM user_emails WHERE user_id = ?").get(userId);
  if (row === undefined) return null;
  return {
    email: String(row["email"]),
    emailFolded: String(row["email_folded"]),
    verifiedAt: row["verified_at"] === null ? null : Number(row["verified_at"]),
  };
}

/** Only a proved address has an owner; an unverified claim reserves nothing. */
export function verifiedOwnerOf(db: DatabaseSync, emailFolded: string): string | null {
  const row = db
    .prepare("SELECT user_id FROM user_emails WHERE email_folded = ? AND verified_at IS NOT NULL")
    .get(emailFolded);
  return row === undefined ? null : String(row["user_id"]);
}

/** One address per account, overwritten unverified. Notify the old address before calling this. */
export function setEmail(db: DatabaseSync, userId: string, email: string, now = Date.now()): void {
  db.prepare(
    "INSERT INTO user_emails (user_id, email, email_folded, verified_at, updated_at) VALUES (?, ?, ?, NULL, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, email_folded = excluded.email_folded, " +
      "verified_at = NULL, updated_at = excluded.updated_at",
  ).run(userId, email, foldEmail(email), now);
}

/** Throws on the partial unique index when another account already proved this address; the caller answers 409 email_taken. */
export function markVerified(db: DatabaseSync, userId: string, emailFolded: string, now = Date.now()): boolean {
  const changed = db
    .prepare("UPDATE user_emails SET verified_at = ?, updated_at = ? WHERE user_id = ? AND email_folded = ?")
    .run(now, now, userId, emailFolded);
  return Number(changed.changes) === 1;
}

export interface MintedToken {
  token: string;
  expiresAt: number;
}

/** Supersedes any earlier link for the same purpose in the same transaction, so at most one is live. */
export function mintEmailToken(
  db: DatabaseSync,
  userId: string,
  purpose: TokenPurpose,
  emailFolded: string,
  ttlMs: number,
  now = Date.now(),
): MintedToken {
  const minted = newEmailToken();
  const expiresAt = now + ttlMs;
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE user_email_tokens SET used_at = ?, used_from = 'superseded' " +
        "WHERE user_id = ? AND purpose = ? AND used_at IS NULL",
    ).run(now, userId, purpose);
    db.prepare(
      "INSERT INTO user_email_tokens (id, user_id, purpose, token_hash, email_folded, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(newId("ut"), userId, purpose, minted.hash, emailFolded, now, expiresAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { token: minted.token, expiresAt };
}

export interface TokenRow {
  id: string;
  userId: string;
  purpose: TokenPurpose;
  emailFolded: string;
}

/** Does not spend the token, so POST /v1/reset can check the password policy before burning it. */
export function readEmailToken(db: DatabaseSync, token: string, now = Date.now()): TokenRow | null {
  const row = db
    .prepare(
      "SELECT id, user_id, purpose, email_folded FROM user_email_tokens " +
        "WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .get(hashCredential(token), now);
  if (row === undefined) return null;
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    purpose: String(row["purpose"]) as TokenPurpose,
    emailFolded: String(row["email_folded"]),
  };
}

/** Single-use through a conditional UPDATE, so two taps cannot both spend it. */
export function claimEmailToken(db: DatabaseSync, token: string, from: string, now = Date.now()): boolean {
  const claimed = db
    .prepare(
      "UPDATE user_email_tokens SET used_at = ?, used_from = ? " +
        "WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .run(now, from, hashCredential(token), now);
  return Number(claimed.changes) === 1;
}

/** Includes disable: POST /v1/reset has no caller, and would otherwise redeem a link mailed to a banned account. */
export function burnEmailTokens(
  db: DatabaseSync,
  userId: string,
  reason: TokenBurnReason,
  now = Date.now(),
  purpose?: TokenPurpose,
): number {
  const changed =
    purpose === undefined
      ? db
          .prepare("UPDATE user_email_tokens SET used_at = ?, used_from = ? WHERE user_id = ? AND used_at IS NULL")
          .run(now, reason, userId)
      : db
          .prepare(
            "UPDATE user_email_tokens SET used_at = ?, used_from = ? " +
              "WHERE user_id = ? AND purpose = ? AND used_at IS NULL",
          )
          .run(now, reason, userId, purpose);
  return Number(changed.changes);
}

export function deleteEmailState(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM user_email_tokens WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM user_emails WHERE user_id = ?").run(userId);
}

export function pruneEmailTokens(db: DatabaseSync, now = Date.now()): number {
  const changed = db.prepare("DELETE FROM user_email_tokens WHERE expires_at < ?").run(now - VERIFY_TTL_MS);
  return Number(changed.changes);
}
