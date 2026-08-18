import type { DatabaseSync } from "node:sqlite";
import { hashCredential, newId, newRegistrationToken } from "./keys.js";
import { foldEmail } from "./mail/address.js";

/**
 * A sign-up nobody has confirmed yet.
 *
 * **The row is not a user**, and that is the decision this file exists to hold.
 * A half-created row in `users` would be counted by `GET /v1/admin/users`, would
 * be a real login name against a UNIQUE index, and — the part that decides it —
 * would hold that name for ever, because there is no way to release a
 * `users.name` except by deleting the person. Here an expired registration stops
 * holding the name by doing nothing at all, since every probe filters
 * `used_at IS NULL AND expires_at > ?`.
 */

/** Long, because a confirmation is read whenever somebody next opens their mail. */
export const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Why a pending registration stopped being usable.
 *
 * Required at every call site rather than defaulted, for `UserCodeBurnReason`'s
 * reason: `used_from` is the only trail there is, and the two "somebody else got
 * there first" cases are genuinely different events that a shared literal would
 * merge.
 */
export type RegistrationBurnReason = "superseded" | "name_taken" | "email_taken";

export interface PendingRow {
  id: string;
  name: string;
  email: string;
  emailFolded: string;
  passwordHash: string;
}

/**
 * The login-name folding rule, in one place.
 *
 * `foldEmail`'s shape and `foldEmail`'s reason. This was written out inline three
 * times — twice in the probes and once in the value written to `name_folded`,
 * i.e. on both sides of the same comparison — so a fourth caller that folded even
 * slightly differently would have written rows the probes cannot find.
 *
 * Deliberately *not* NFKC, unlike `password.ts`: this only has to agree with the
 * `name_folded` column it populates, and a normalization added on one side of a
 * stored fold silently stops matching every row written before it.
 */
export function foldName(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Whether this login name is spoken for, by an account or by a live sign-up.
 *
 * Folded, which is **friendlier than the index it stands in front of**:
 * `users.name` is UNIQUE BINARY, so `Ada` and `ada` really are two accounts
 * today and this change does not alter that. Refusing the second here is a
 * courtesy; the UNIQUE violation at confirm time is the honest backstop, and
 * both are needed because this one cannot see a race.
 */
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

/**
 * The same question, asked on behalf of somebody who is signing up *again*.
 *
 * **This is what replaced the resend route.** A pending sign-up holds its login
 * name for the full 24 hours, so with a plain `nameTaken` somebody whose
 * confirmation mail was lost, filtered or deleted could not simply sign up
 * again: they got `409 name_taken` about *themselves*, and the only way out was
 * a separate "send it again" button. Removing that button without this would
 * have stranded the name for a day with no remedy at all.
 *
 * A pending row is ignored only when it holds the **same address**, which is
 * strictly narrower than the route it replaces: resend took an address and
 * nothing else, while this needs the name, the address and a password that
 * passes the policy. What it cannot do is let a stranger take a name somebody
 * else is holding — a different address still collides.
 */
export function nameTakenByAnother(
  db: DatabaseSync,
  name: string,
  emailFolded: string | null,
  now = Date.now(),
): boolean {
  const folded = foldName(name);
  if (db.prepare("SELECT 1 AS hit FROM users WHERE lower(name) = ?").get(folded) !== undefined) return true;
  /*
   * `email_folded != ?` and not a filter in code, because a null address must
   * collide with everything: that is the no-mail arm, where there is nothing to
   * confirm and a pending row can only be a leftover from before mail was
   * switched off.
   */
  const held = db
    .prepare(
      "SELECT 1 AS hit FROM pending_registrations " +
        "WHERE name_folded = ? AND used_at IS NULL AND expires_at > ? AND email_folded IS NOT ?",
    )
    .get(folded, now, emailFolded);
  return held !== undefined;
}

/** A live sign-up already holding this address, if any. */
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
 * Record a sign-up and mint the link that will finish it.
 *
 * The password hash is computed by the caller **before** this, at registration
 * time rather than at confirmation. Three reasons in order of weight: the arm of
 * the matrix with no SMTP takes a password at registration by definition, so
 * doing it in both arms means one form and one policy check; confirmation then
 * performs no KDF at all, which is what makes an unauthenticated route that
 * writes to `users` cheap enough to exist above THE LINE; and it means every
 * branch of the registration route spends the same ~51ms, so a `409 name_taken`
 * is not *also* a timing oracle.
 *
 * Any earlier live sign-up for the same address is superseded in the same
 * transaction, which is what makes **signing up again** safe — and, since the
 * resend route was deleted, what signing up again is *for*: the previous link
 * stops working the moment a new one is minted. `nameTakenByAnother` is the
 * other half, the one that lets the same name through.
 *
 * **What keeps that safe is the caller, and it is worth saying which caller.**
 * Substituting a second sign-up's password for a live one would be an account
 * takeover needing no credential and no race, since name and address are both
 * guessable. `POST /v1/register` never reaches here with a live pending row for
 * the address: it branches on `pendingForEmail` first and re-mints from the
 * *stored* name and hash, so the values below are only ever a fresh sign-up's
 * own. This function does not re-check that, deliberately — it is the recorder,
 * and the decision about whose password a link carries belongs at the route
 * where the branch is.
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
        "WHERE email_folded = ? AND used_at IS NULL",
    ).run(now, emailFolded);
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

/**
 * Spend a registration link, once.
 *
 * The conditional `UPDATE` + `changes === 1` template again. Returns the row it
 * just claimed, because the caller needs the name and the hash to create the
 * account and there must be no second read that could see a different row.
 */
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

/**
 * Retire a claimed row that turned out to be unusable.
 *
 * Reached when the confirming transaction rolls back on a UNIQUE violation:
 * somebody else took the name, or proved the address, between the sign-up and
 * the click. Burning is right rather than restoring — the row's name is
 * unusable, so leaving it live leaves a dead link somebody will click again and
 * get the same refusal from.
 */
export function burnRegistration(
  db: DatabaseSync,
  id: string,
  reason: RegistrationBurnReason,
  now = Date.now(),
): void {
  db.prepare("UPDATE pending_registrations SET used_at = ?, used_from = ? WHERE id = ?").run(now, reason, id);
}

/**
 * Expired sign-ups, swept at startup.
 *
 * **It is not what releases a held name**, which this used to claim. Every probe
 * here filters `expires_at > ?`, so the name comes back the moment the row
 * lapses and nothing has to run at all — there is no unique index on
 * `name_folded` for a dead row to keep holding. What the sweep reclaims is the
 * *row*, a further TTL later, along with the scrypt hash it is still carrying.
 * The distinction matters because "the name is free" is the property people
 * reason about, and it does not depend on this function ever being called.
 */
export function pruneRegistrations(db: DatabaseSync, now = Date.now()): number {
  const changed = db.prepare("DELETE FROM pending_registrations WHERE expires_at < ?").run(now - REGISTRATION_TTL_MS);
  return Number(changed.changes);
}
