import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { publicKeyToJwk, type PublicKeyJwk } from "../../../src/token.js";

/**
 * Signing keys, ids, and the API-key credential.
 *
 * The one thing worth stating twice: no credential is ever stored in a form it
 * can be recovered from. API keys and enrollment codes are hashed; only the
 * signing key's private half is kept, because signing needs it and there is
 * nowhere else for it to live.
 */

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: PublicKeyJwk;
}

/**
 * A key id derived from the key itself.
 *
 * Deterministic rather than random so the same key always has the same id — two
 * control planes restored from the same backup cannot disagree about what `k_…`
 * refers to, and a daemon holding an old key set can recognise a re-published
 * key rather than treating it as new.
 */
export function keyIdFor(jwk: PublicKeyJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return `k_${createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 12)}`;
}

/**
 * The active signing key, minted on first use.
 *
 * "Active" means every key that is not retired; the newest signs, and all of
 * them are published. A daemon never re-fetches, so publishing the whole active
 * set is what makes a rotation possible at all: both keys are handed out during
 * the overlap while daemons re-enroll one by one.
 */
export function activeSigningKeys(db: DatabaseSync): SigningKey[] {
  const rows = db
    .prepare("SELECT kid, private_pem, public_jwk FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC")
    .all();
  return rows.map((row) => ({
    kid: String(row["kid"]),
    privateKey: createPrivateKey(String(row["private_pem"])),
    jwk: JSON.parse(String(row["public_jwk"])) as PublicKeyJwk,
  }));
}

/**
 * The same active set, public halves only — no private key ever loaded.
 *
 * For `/v1/jwks` and for the `keys` array in an enrollment response, both of
 * which hand out public keys and neither of which signs anything. `/v1/jwks` is
 * *unauthenticated*, correctly so (a public key is public), and that is exactly
 * why it should not reach a function that calls `createPrivateKey` on the
 * fleet-wide signing key and then discards it.
 *
 * No key material was ever disclosed by the old arrangement; this is the same
 * discipline `relay/authorize.ts` already states for the same reason — keeping
 * the signing key out of code paths that run on unauthenticated input is worth
 * the extra four lines of SQL rather than being reasoned about each time.
 */
export function activePublicKeys(db: DatabaseSync): { kid: string; jwk: PublicKeyJwk }[] {
  const rows = db
    .prepare("SELECT kid, public_jwk FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC")
    .all();
  return rows.map((row) => ({
    kid: String(row["kid"]),
    jwk: JSON.parse(String(row["public_jwk"])) as PublicKeyJwk,
  }));
}

export function ensureSigningKey(db: DatabaseSync): SigningKey {
  const existing = activeSigningKeys(db);
  const newest = existing[0];
  if (newest) return newest;
  return mintSigningKey(db);
}

/**
 * Mint a signing key and make it the newest active one.
 *
 * ⚠ **This existed only inside `ensureSigningKey`, and that made rotation a
 * capability the schema described and the code did not have.** `schema.sql` says
 * the table is plural and `retired_at` exists "so a rotation can overlap: both
 * keys are published while daemons re-enroll, then the old one is retired" —
 * and there was one `INSERT INTO signing_keys` in the whole service, behind an
 * early return, with **nothing anywhere writing `retired_at`**. Two readers, no
 * writer.
 *
 * That is exactly the shape `api_keys.revoked_at` was named for: *a credential
 * the code can read is a credential something must be able to write*, and *a
 * property the code appears to have and nothing enforces is worse than one it
 * visibly lacks*. Same defect, one table over, on the key that mints every token
 * in the fleet — so the remedy that leaked database was hand-editing SQLite
 * inside a `read_only: true` container, under pressure.
 *
 * Everything the overlap needs was already true: `activePublicKeys` returns the
 * whole set, `/v1/jwks` and `/v1/enroll` publish all of it, and `keyIdFor` is
 * deterministic so a daemon recognises a key it already holds. The only thing
 * missing was a second row.
 */
export function mintSigningKey(db: DatabaseSync, now = Date.now()): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKeyToJwk(publicKey);
  const kid = keyIdFor(jwk);
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  db.prepare(
    "INSERT INTO signing_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)",
  ).run(kid, pem, JSON.stringify(jwk), now);
  return { kid, privateKey, jwk };
}

/**
 * Retire a key, or say why it cannot be.
 *
 * **The last active key may not be retired**, and that refusal is the whole of
 * why this is a function rather than an `UPDATE` at a route. A control plane with
 * no active key cannot sign, so `POST /v1/tokens` fails for every machine in the
 * fleet — and it cannot mint a replacement without one either, because
 * `ensureSigningKey` runs at startup and this service does not restart itself.
 * The operator would have taken the fleet off the network with one request, and
 * the way back would be the container's own read-only filesystem.
 *
 * Retiring is also **not** revocation of what that key already signed. A token
 * lives 300s and every daemon verifies locally against a key set it captured at
 * enrollment, so a retired key keeps verifying at the edge until each daemon
 * re-enrolls. That is the same property that makes a control-plane outage
 * survivable, read from the other side, and it is why the rotation is
 * "publish both, retire later" rather than "swap".
 */
export type RetireKeyResult = { ok: true } | { ok: false; reason: "not_found" | "last_active" };

export function retireSigningKey(db: DatabaseSync, kid: string, now = Date.now()): RetireKeyResult {
  const active = db
    .prepare("SELECT kid FROM signing_keys WHERE retired_at IS NULL")
    .all()
    .map((row) => String(row["kid"]));
  if (!active.includes(kid)) return { ok: false, reason: "not_found" };
  if (active.length <= 1) return { ok: false, reason: "last_active" };
  db.prepare("UPDATE signing_keys SET retired_at = ? WHERE kid = ? AND retired_at IS NULL").run(now, kid);
  return { ok: true };
}

/** Every key, retired or not, for an admin deciding what to retire. */
export function signingKeyRows(db: DatabaseSync): { kid: string; createdAt: number; retiredAt: number | null }[] {
  return db
    .prepare("SELECT kid, created_at, retired_at FROM signing_keys ORDER BY created_at DESC")
    .all()
    .map((row) => ({
      kid: String(row["kid"]),
      createdAt: Number(row["created_at"]),
      retiredAt: row["retired_at"] == null ? null : Number(row["retired_at"]),
    }));
}

/* ------------------------------------------------------------------ *
 * Opaque credentials
 * ------------------------------------------------------------------ */

/** 32 bytes from the CSPRNG. Long enough that guessing is not a threat model. */
function secret(): string {
  return randomBytes(32).toString("base64url");
}

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `rk_${secret()}`;
  return { key, prefix: keyPrefix(key), hash: hashCredential(key) };
}

export function newEnrollmentCode(): { code: string; hash: string } {
  const code = `ec_${secret()}`;
  return { code, hash: hashCredential(code) };
}

/**
 * The credential that provisions a machine for somebody else.
 *
 * Same shape and the same three-character prefix as every other key here, so
 * `keyPrefix` works on it unchanged. Long-lived and fleet-wide by design — it is
 * meant to sit in an installer — which is exactly why it authorizes one route
 * and why rotation exists. See `provisioning_keys` in `schema.sql`.
 */
export function newProvisioningKey(): { key: string; prefix: string; hash: string } {
  const key = `pk_${secret()}`;
  return { key, prefix: keyPrefix(key), hash: hashCredential(key) };
}

/**
 * The credential a daemon holds a relay tunnel with.
 *
 * Same shape and same three-character prefix as an API key so `keyPrefix` — which
 * slices past exactly three characters — works on it unchanged. Long-lived, unlike
 * a user token: a daemon cannot renew anything, since the whole design is that it
 * never calls the control plane after enrollment. Rotation is re-enrollment.
 */
export function newTunnelKey(): { key: string; prefix: string; hash: string } {
  const key = `tk_${secret()}`;
  return { key, prefix: keyPrefix(key), hash: hashCredential(key) };
}

/**
 * The credential a signed-in browser holds.
 *
 * Fourth of the same shape, and the sameness is the point: `rs_` is three
 * characters like `rk_`, `ec_` and `tk_`, so `keyPrefix` — which slices past
 * exactly three — works on it unchanged, and one middleware can tell a session
 * from an API key by looking at those three characters rather than probing two
 * tables and hoping only one answers.
 *
 * 32 bytes from the CSPRNG, like the rest, and **never `newId`**, which is four
 * bytes and is for naming rows rather than for being unguessable.
 */
export function newSessionToken(): { token: string; prefix: string; hash: string } {
  const token = `rs_${secret()}`;
  return { token, prefix: keyPrefix(token), hash: hashCredential(token) };
}

/**
 * The two credentials that arrive by email.
 *
 * Fifth and sixth of the same shape, minted here rather than beside the tables
 * that store them so that "everything unguessable in this service comes out of
 * `secret()`" stays true by inspection.
 *
 * **The prefixes matter beyond tidiness, and there are three couplings.** Both
 * are deliberately outside the `rk_`/`rs_` family that `callerAuth` resolves and
 * that the browser's `credentialKind` sorts on: a value that reached
 * `setSession` by mistake would otherwise be stored as *the* credential and
 * every later request would answer 401 with nothing to explain it. Both are
 * base64url after the prefix, so they carry **no `.`** — the control plane's SPA
 * fallback treats a last path segment matching `/\.[a-zA-Z0-9]{1,8}$/` as an
 * asset and answers a JSON 404, which would turn a reset link into a blank page.
 * And neither is looked up by `keyPrefix`: these tables have a UNIQUE index on
 * the hash and are read once, so there is no hot path to narrow.
 *
 * The plaintext is put in exactly one place — the body of one message — and only
 * the hash is stored, like every other credential here.
 */
export function newEmailToken(): { token: string; hash: string } {
  const token = `et_${secret()}`;
  return { token, hash: hashCredential(token) };
}

export function newRegistrationToken(): { token: string; hash: string } {
  const token = `pr_${secret()}`;
  return { token, hash: hashCredential(token) };
}

/**
 * The clear-text handle a key is looked up by.
 *
 * Not a secret: it narrows an indexed lookup to (almost always) one row so the
 * constant-time compare below runs once instead of per row. Taken from after
 * the `rk_` prefix, which every key shares and which therefore distinguishes
 * nothing.
 */
export function keyPrefix(key: string): string {
  return key.slice(3, 11);
}

export function hashCredential(value: string): string {
  return createHash("sha256").update(value.trim(), "utf8").digest("hex");
}

/**
 * Constant-time compare of two hex digests.
 *
 * Both sides are fixed-length sha256 output, so there is no length to leak and
 * `timingSafeEqual` never sees mismatched buffers — but the length is checked
 * anyway, because it throws rather than returning false when they differ and a
 * corrupt row must not crash a request.
 */
export function credentialMatches(provided: string, storedHash: string): boolean {
  const a = Buffer.from(hashCredential(provided), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Which machine holds this tunnel credential — or `null`.
 *
 * **The machine id is an output of this function, never an input.** Nothing in
 * the tunnel handshake lets a daemon name the machine it wants to be; it
 * presents a secret and the relay looks up whose it is. That is what makes "a
 * daemon cannot open a tunnel claiming a machine id that isn't its own" a
 * property of the code rather than a check that could be forgotten, mis-ordered,
 * or bypassed by a request field somebody adds later.
 *
 * Revoked credentials and revoked machines both answer `null`. This runs on every
 * tunnel dial — not on every proxied request — so a revoked machine keeps a tunnel
 * it already holds until it next reconnects; `relay/proxy.ts` re-checks the machine
 * per request, which is what actually bounds it.
 */
export function resolveTunnelKey(db: DatabaseSync, presented: string): string | null {
  const key = presented.trim();
  if (key.length === 0) return null;
  const rows = db
    .prepare(
      "SELECT t.key_hash, t.revoked_at, t.machine_id, m.revoked_at AS machine_revoked " +
        "FROM machine_tunnel_keys t JOIN machines m ON m.id = t.machine_id WHERE t.prefix = ?",
    )
    .all(keyPrefix(key));

  for (const row of rows) {
    if (!credentialMatches(key, String(row["key_hash"]))) continue;
    if (row["revoked_at"] !== null) return null;
    if (row["machine_revoked"] !== null) return null;
    return String(row["machine_id"]);
  }
  return null;
}

/**
 * Whether this is the live provisioning key — its id, or `null`.
 *
 * The same shape as `resolveTunnelKey` and for the same reasons: looked up by
 * prefix, compared with `credentialMatches` (constant time, and never a `WHERE
 * key_hash = ?`), and a revoked row answers `null` rather than being filtered in
 * SQL, so "revoked means no" is a statement in this function rather than a
 * clause somebody can drop.
 */
export function resolveProvisioningKey(db: DatabaseSync, presented: string): string | null {
  const key = presented.trim();
  if (key.length === 0) return null;
  const rows = db
    .prepare("SELECT id, key_hash, revoked_at FROM provisioning_keys WHERE prefix = ?")
    .all(keyPrefix(key));
  for (const row of rows) {
    if (!credentialMatches(key, String(row["key_hash"]))) continue;
    if (row["revoked_at"] !== null) return null;
    return String(row["id"]);
  }
  return null;
}

/**
 * Whether the fleet has a provisioning key at all.
 *
 * **A boolean, and deliberately not a record.** Nothing anywhere draws this key
 * or any part of it — not the value, not the prefix, not an id — so a projection
 * carrying those would exist only to be a second place they can leak from.
 * "There is one" is the whole of what an admin can act on, because the only act
 * is minting another.
 */
export function hasProvisioningKey(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS hit FROM provisioning_keys WHERE revoked_at IS NULL LIMIT 1").get() !== undefined;
}

/**
 * Mint the provisioning key, retiring every live one in the same transaction.
 *
 * **There is at most one, and minting is the only verb.** The reason to mint a
 * second is that the first leaked, so a window in which both work is the window
 * being closed — which is why the retire and the insert are one act rather than
 * two, and why there is no separate revoke.
 *
 * Turning provisioning *off* therefore has no control at all, and that is a
 * deliberate gap rather than an oversight: it would be a third state to reason
 * about for a fleet that either hands out hosts or does not, and the key is
 * useless to anybody who cannot also reach `POST /v1/provision`.
 *
 * Rows are kept rather than deleted — `created_by` and `revoked_at` are the only
 * trail there is for a credential that provisions hardware.
 *
 * Returns the plaintext, which exists here and in one response body and nowhere
 * else, ever.
 */
export function mintProvisioningKey(
  db: DatabaseSync,
  createdBy: string | null,
  now = Date.now(),
): { key: string } {
  const minted = newProvisioningKey();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE provisioning_keys SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
    db.prepare(
      "INSERT INTO provisioning_keys (id, prefix, key_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
    ).run(newId("pk"), minted.prefix, minted.hash, now, createdBy);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { key: minted.key };
}

/**
 * Issue a tunnel credential for a machine, retiring whatever it had.
 *
 * Re-enrollment is the rotation story for the signing keys a daemon trusts, so it
 * is the rotation story for this too — one operation, not two to forget one of.
 * The old row is revoked rather than deleted so the audit trail survives.
 */
export function issueTunnelKey(db: DatabaseSync, machineId: string): string {
  const now = Date.now();
  const tunnel = newTunnelKey();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE machine_tunnel_keys SET revoked_at = ? WHERE machine_id = ? AND revoked_at IS NULL").run(
      now,
      machineId,
    );
    db.prepare(
      "INSERT INTO machine_tunnel_keys (id, machine_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(newId("mt"), machineId, tunnel.prefix, tunnel.hash, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return tunnel.key;
}

/**
 * The primary key of every row this service writes.
 *
 * **Eight bytes, and it used to be four.** Four is 32 bits, so a birthday
 * collision arrives around 2^16 — 65 000 rows of one kind, which `users` will
 * never reach but `mail_outbox` and `user_sessions` reasonably can. What made
 * that worth widening rather than watching is *how* it fails: the insert trips
 * the primary key's UNIQUE constraint, and on the sign-up path that surfaces as
 * `409 user_exists` — a random collision reported to somebody as "that name is
 * taken", destroying a pending registration and telling them nothing true.
 *
 * Widening is free and backward-compatible: nothing parses these by length.
 * `keyPrefix` slices the three-character prefix of a *credential* (`rs_`, `rk_`,
 * `pk_`), which is a different thing from an id, and every existing short id
 * keeps working — this only changes what new ones look like.
 *
 * ⚠ **Not for anything anybody presents as proof.** This is an identifier, not a
 * credential: it is short, it appears in URLs and it is not compared in constant
 * time. Tokens are 32 bytes from the CSPRNG and are minted elsewhere — see the
 * note on `newSecret` above, which says the same thing from the other side.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * How long a spent or expired enrollment code is kept before it is dropped.
 *
 * Seven days, the same margin `mail_outbox` keeps and for the same reason: the
 * row is worthless to an attacker the moment it expires, and worth something to
 * a person for as long as "did that machine ever enroll, and who minted the code"
 * is a question somebody might ask. `used_from` is the only forensic trail in
 * this service, so sweeping on the tick of expiry would delete the record of a
 * *successful* enrollment along with the dead ones.
 */
const ENROLLMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop enrollment codes nothing can redeem any more.
 *
 * ⚠ **This table was the one expiring-credential table with no sweeper**, and
 * `throttle.ts` had already noticed in a comment — *"against a table nothing
 * prunes (`DELETE FROM enrollment_codes` exists nowhere)"* — without anything
 * being done about it. Every mint burns the previous code for a machine, so the
 * live set is bounded by the machine count; what was unbounded is the *dead* set,
 * one row per code ever minted, growing for the life of the instance in the same
 * SQLite file as the signing key. An authenticated caller can add to it as fast
 * as `WRITE_THROTTLE` allows.
 *
 * Both halves are swept, and they expire differently: a code that was **used** is
 * dead from that moment, and one that was not is dead at `expires_at`. Keyed on
 * whichever applies rather than on `created_at`, or a live code would be dropped
 * out from under a machine still holding it.
 */
export function pruneEnrollmentCodes(db: DatabaseSync, now = Date.now()): number {
  const cutoff = now - ENROLLMENT_RETENTION_MS;
  const changed = db
    .prepare("DELETE FROM enrollment_codes WHERE COALESCE(used_at, expires_at) < ?")
    .run(cutoff);
  return Number(changed.changes);
}

/**
 * Mint an enrollment code for a machine, retiring whatever it had.
 *
 * Here rather than in a route because there are **two** routes that mint one now
 * — the admin's and the machine owner's — and two hand-written copies of "burn
 * the old one, insert the new one, remember who asked" is how they come to
 * disagree about the first clause.
 *
 * **Burning the previous code is the answer to "how many outstanding codes may
 * somebody hold", rather than a number.** A code is a full machine identity until
 * it is redeemed or expires, so an unbounded pile of live ones is a pile of keys
 * to a machine; and now that any user can ask for one, the pile is somebody
 * else's to grow. One live code per machine removes the question. It mirrors
 * `issueTunnelKey` directly, which retires a machine's previous tunnel key for
 * the same reason.
 *
 * The plaintext is returned once and only the hash is stored.
 */
export function mintEnrollmentCode(
  db: DatabaseSync,
  machineId: string,
  createdBy: string,
  ttlMs: number,
  now = Date.now(),
): { code: string; expiresAt: number } {
  const minted = newEnrollmentCode();
  const expiresAt = now + ttlMs;
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE enrollment_codes SET used_at = ?, used_from = 'superseded' WHERE machine_id = ? AND used_at IS NULL",
    ).run(now, machineId);
    db.prepare(
      "INSERT INTO enrollment_codes (id, code_hash, machine_id, created_by, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(newId("ec"), minted.hash, machineId, createdBy, now, expiresAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { code: minted.code, expiresAt };
}

/**
 * Invalidate every unredeemed code for one machine.
 *
 * Here for the reason `mintEnrollmentCode` already argues one line above: there
 * are **two** routes that revoke a machine — the admin's and the owner's — and
 * two hand-written copies of the same `UPDATE` is how they come to disagree
 * about one of its clauses. They were already byte-identical copies; this is the
 * third caller's worth of drift removed before it happened.
 *
 * Called inside the revoke transaction. A revoked machine that a five-minute-old
 * code could still enroll is not revoked in any useful sense — a redemption mints
 * a machine identity *and* a tunnel key, neither of which asks whether the
 * machine is still on the network.
 *
 * Returns the number of codes burned, which is what the route reports as
 * `enrollmentCodesInvalidated`.
 */
export function burnMachineCodes(db: DatabaseSync, machineId: string, now = Date.now()): number {
  return Number(
    db
      .prepare("UPDATE enrollment_codes SET used_at = ?, used_from = 'revoked' WHERE machine_id = ? AND used_at IS NULL")
      .run(now, machineId).changes,
  );
}

/**
 * Why a user's codes were burned, and the value written to the forensic column.
 *
 * A union rather than a `string`, because this column is the only trail there is
 * and a typo in it is indistinguishable from an event that never happened. The
 * two members are the two acts that take an account away from somebody: one
 * reversible, one not.
 */
export type UserCodeBurnReason = "user_deleted" | "user_disabled";

/**
 * Invalidate every unredeemed code **a removed user minted**.
 *
 * `DELETE /v1/admin/users/:id` sweeps every table that authenticates as them —
 * sessions, origins, passwords, api keys, grants, ownership — and did not sweep
 * this one. Measured: a user deleted while holding a code they had just minted
 * could still redeem it, because `/v1/enroll` is above the `/v1/*` gate and asks
 * only whether the code is unused and unexpired. It answers with the machine id
 * and the fleet's public keys, and `issueTunnelKey` **retires the legitimate
 * daemon's tunnel key** in the same call — so a just-removed account can take a
 * machine off the relay and put itself on it.
 *
 * **`created_by` is still left dangling, on purpose.** The delete route's own
 * comment draws that distinction: the row's job is to say what happened, and
 * rewriting history to keep a join valid is the opposite of an audit trail. So
 * this burns the *code* — `used_at`, `used_from` — and touches nothing that
 * records who minted it. The audit row survives naming a user who is gone; what
 * does not survive is the credential.
 *
 * `'user_deleted'` rather than `'revoked'` because those are different events and
 * this column is the only forensic trail there is.
 *
 * **`usedFrom` is a required argument for that last reason.** The second caller
 * is `POST /v1/admin/users/:id/disable`, which has exactly the same hole for
 * exactly the same reason — `/v1/enroll` sits above THE LINE and never reads
 * `users.disabled_at`, so a banned account whose every other credential
 * `callerAuth` now refuses could still redeem a held code, receive the machine
 * id and the public keys, and have `issueTunnelKey` retire the running daemon's
 * tunnel key. Disabling is the *reversible* act and burning a code is not, which
 * is the same trade `enable` already states about sessions: re-enabling restores
 * the account, not the credentials that were live while it was somebody's
 * problem. Writing `'user_disabled'` there rather than reusing `'user_deleted'`
 * keeps the two events apart in the only column that records them; a default
 * would have made the wrong one the easy one to write.
 */
export function burnUserCodes(
  db: DatabaseSync,
  userId: string,
  usedFrom: UserCodeBurnReason,
  now = Date.now(),
): number {
  return Number(
    db
      .prepare("UPDATE enrollment_codes SET used_at = ?, used_from = ? WHERE created_by = ? AND used_at IS NULL")
      .run(now, usedFrom, userId).changes,
  );
}

/**
 * Invalidate every unredeemed code **for a machine a removed user can reach**.
 *
 * The sibling above, asked the other way round, and it exists because
 * `created_by` is the wrong column for half the question. `burnUserCodes` burns
 * what *they* minted; this burns what was minted *for them*. The gap between the
 * two is one route: `POST /v1/admin/machines/:id/enrollments` — `cpctl admin
 * enroll` — where the admin is `created_by` and the machine belongs to somebody
 * else. Offboard that somebody, and the code they were handed five minutes ago
 * survives both the delete and the disable, because neither sweep names it and
 * `/v1/enroll` sits above THE LINE reading neither `created_by` nor
 * `users.disabled_at`.
 *
 * What redeeming it still buys, unchanged from the sibling's argument: the
 * machine id, the fleet's public keys, and an `issueTunnelKey` that retires the
 * running daemon's tunnel key in the same call — so an offboarded person can
 * take a machine off the relay and put themselves on it, inside the code's hour.
 *
 * **Keyed on the grant, not on ownership**, and the wider of the two is right: a
 * grantee is exactly who `POST /v1/admin/machines/:id/enrollments` is usually
 * driven for, and the delete route drops their grants in the same transaction,
 * so asking afterwards would find nothing. Call it *before* `DELETE FROM grants`.
 *
 * Separate from `burnUserCodes` rather than folded into it, because the two
 * answer different questions about different rows and a single `WHERE … OR …`
 * would make "which of the two reasons applies" unanswerable from the statement.
 */
export function burnGranteeCodes(
  db: DatabaseSync,
  userId: string,
  usedFrom: UserCodeBurnReason,
  now = Date.now(),
): number {
  return Number(
    db
      .prepare(
        "UPDATE enrollment_codes SET used_at = ?, used_from = ? " +
          "WHERE used_at IS NULL AND machine_id IN (SELECT machine_id FROM grants WHERE user_id = ?)",
      )
      .run(now, usedFrom, userId).changes,
  );
}
