import type { DatabaseSync } from "node:sqlite";
import { hashCredential, newEmailToken, newId } from "./keys.js";
import { foldEmail } from "./mail/address.js";

/**
 * The address on an account, and the single-use links that prove or reset it.
 *
 * Two tables, one file, because they are one question: an address is only worth
 * anything once somebody has proved they read mail at it, and the proof is a
 * token that has to name the address it was minted for.
 */

/** A link that proves an address. Long, because people read mail hours later. */
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A link that takes over an account. Short, deliberately.
 *
 * One hour rather than a day: it is the only token here that replaces a
 * credential, and the person asking for it is sitting at the screen when they
 * ask. `enrollment_codes` picked the same number for the same reason.
 */
export const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * An invitation is a reset against an account that has never had a password.
 *
 * Longer than a reset because nobody is waiting at a screen — an admin created
 * the account and the person may be asleep — and shorter than forever because it
 * is still a link that hands somebody an account.
 */
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export type TokenPurpose = "verify" | "reset";

/**
 * Why a token stopped being usable.
 *
 * A **required** argument wherever a burn happens, never a default inside the
 * function, for `UserCodeBurnReason`'s reason: `used_from` is the only forensic
 * trail there is, and a burn recorded under the wrong reason is indistinguishable
 * from one that never happened.
 */
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

/**
 * Who has *proved* this address, if anybody.
 *
 * Reads `verified_at IS NOT NULL` rather than the address alone, and that is the
 * whole of the anti-squatting rule expressed as a query: an unverified claim
 * reserves nothing, so it must not answer this question. The partial unique
 * index in `schema.sql` is the same sentence expressed as a constraint.
 */
export function verifiedOwnerOf(db: DatabaseSync, emailFolded: string): string | null {
  const row = db
    .prepare("SELECT user_id FROM user_emails WHERE email_folded = ? AND verified_at IS NOT NULL")
    .get(emailFolded);
  return row === undefined ? null : String(row["user_id"]);
}

/**
 * Write an address onto an account, unverified.
 *
 * Overwrites, because there is one address per account. The caller is
 * responsible for having told the *old* address first — the notice cannot be
 * sent afterwards, since the row it names is gone.
 */
export function setEmail(db: DatabaseSync, userId: string, email: string, now = Date.now()): void {
  db.prepare(
    "INSERT INTO user_emails (user_id, email, email_folded, verified_at, updated_at) VALUES (?, ?, ?, NULL, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, email_folded = excluded.email_folded, " +
      "verified_at = NULL, updated_at = excluded.updated_at",
  ).run(userId, email, foldEmail(email), now);
}

/**
 * Mark the address on an account proved.
 *
 * Throws on the partial unique index when somebody else has already proved the
 * same address — which is the intended outcome, not an error to smooth over:
 * two accounts may hold the same unverified claim and exactly one may prove it.
 * The caller maps that to `409 email_taken`.
 */
export function markVerified(db: DatabaseSync, userId: string, emailFolded: string, now = Date.now()): boolean {
  const changed = db
    .prepare("UPDATE user_emails SET verified_at = ?, updated_at = ? WHERE user_id = ? AND email_folded = ?")
    .run(now, now, userId, emailFolded);
  return Number(changed.changes) === 1;
}

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

export interface MintedToken {
  token: string;
  expiresAt: number;
}

/**
 * A fresh link, and the death of any earlier one for the same purpose.
 *
 * `mintEnrollmentCode`'s rule, and for its reason: one live credential at a
 * time, so a message intercepted earlier stops working the moment somebody asks
 * for another. Both statements are in one transaction because a supersede that
 * committed without its replacement would leave an account with no way in.
 */
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

/**
 * Look a token up **without** spending it.
 *
 * Read and claim are two calls on purpose. `POST /v1/reset` has to check the
 * new password's policy *before* it burns anything: burning first means
 * somebody who typed a short password needs a whole new email, which is the
 * kind of dead end that makes people give up on a recovery flow.
 */
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

/**
 * Spend it, once.
 *
 * A conditional `UPDATE` then `changes === 1` — `enrollment_codes`' template, so
 * single-use is a property of the database rather than of application logic that
 * could be raced by two taps on a phone.
 */
export function claimEmailToken(db: DatabaseSync, token: string, from: string, now = Date.now()): boolean {
  const claimed = db
    .prepare(
      "UPDATE user_email_tokens SET used_at = ?, used_from = ? " +
        "WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    )
    .run(now, from, hashCredential(token), now);
  return Number(claimed.changes) === 1;
}

/**
 * Retire every live link for an account.
 *
 * Called by a password change, an address change, `disable` and `delete`.
 * **`disable` is the one worth naming**, and for `burnUserCodes`' exact reason:
 * `POST /v1/reset` sits above THE LINE, has no caller at all, and asks only
 * whether a token is unused and unexpired — so without this sweep a banned
 * account could redeem a link it was mailed minutes earlier. The route
 * re-reads `disabled_at` as well; two independent answers, because a sweep is a
 * thing somebody can forget to call.
 */
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

/** Everything a deleted account leaves behind here. Called inside the sweep. */
export function deleteEmailState(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM user_email_tokens WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM user_emails WHERE user_id = ?").run(userId);
}

/** Expired rows, swept at startup beside `pruneSessions`. */
export function pruneEmailTokens(db: DatabaseSync, now = Date.now()): number {
  const changed = db.prepare("DELETE FROM user_email_tokens WHERE expires_at < ?").run(now - VERIFY_TTL_MS);
  return Number(changed.changes);
}
