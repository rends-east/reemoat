import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { publicKeyToJwk, type PublicKeyJwk } from "../../../src/token.js";

// No credential is stored recoverably; only the signing key's private half is kept.

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: PublicKeyJwk;
}

/** Deterministic, so the same key always has the same id across restores and re-publishes. */
export function keyIdFor(jwk: PublicKeyJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return `k_${createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 12)}`;
}

/** The newest signs and all are published, so a rotation can overlap: a daemon never re-fetches keys. */
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

/** Public halves only, for unauthenticated paths: never loads a private key. */
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

/** Rotation: mint, let daemons re-enroll, then retire the old key. */
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

/** The last active key cannot be retired. Tokens it signed keep verifying until daemons re-enroll. */
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

// Every unguessable value in this service comes from here.
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

export function newProvisioningKey(): { key: string; prefix: string; hash: string } {
  const key = `pk_${secret()}`;
  return { key, prefix: keyPrefix(key), hash: hashCredential(key) };
}

/** Long-lived: a daemon never calls back to renew it, so rotation is re-enrollment. */
export function newTunnelKey(): { key: string; prefix: string; hash: string } {
  const key = `tk_${secret()}`;
  return { key, prefix: keyPrefix(key), hash: hashCredential(key) };
}

/** Every credential prefix is three characters, so keyPrefix works on all of them. */
export function newSessionToken(): { token: string; prefix: string; hash: string } {
  const token = `rs_${secret()}`;
  return { token, prefix: keyPrefix(token), hash: hashCredential(token) };
}

/** Deliberately outside the rk_/rs_ prefixes callerAuth resolves; looked up by unique hash, not keyPrefix. */
export function newEmailToken(): { token: string; hash: string } {
  const token = `et_${secret()}`;
  return { token, hash: hashCredential(token) };
}

export function newRegistrationToken(): { token: string; hash: string } {
  const token = `pr_${secret()}`;
  return { token, hash: hashCredential(token) };
}

/** Not a secret: narrows an indexed probe to one row. */
export function keyPrefix(key: string): string {
  return key.slice(3, 11);
}

export function hashCredential(value: string): string {
  return createHash("sha256").update(value.trim(), "utf8").digest("hex");
}

/** A length mismatch (a corrupt row) answers false rather than throwing. */
export function credentialMatches(provided: string, storedHash: string): boolean {
  const a = Buffer.from(hashCredential(provided), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The machine id is only ever an output. Checked per dial only; relay/proxy.ts re-checks revocation per request. */
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

export function hasProvisioningKey(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS hit FROM provisioning_keys WHERE revoked_at IS NULL LIMIT 1").get() !== undefined;
}

/** Retires every live key in the same transaction, so at most one ever works. Returns the only plaintext. */
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

/** 8 random bytes (older rows carry 4). An identifier, never a credential. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

// Spent codes are kept a week: used_from is the only forensic trail of an enrollment.
const ENROLLMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function pruneEnrollmentCodes(db: DatabaseSync, now = Date.now()): number {
  const cutoff = now - ENROLLMENT_RETENTION_MS;
  const changed = db
    .prepare("DELETE FROM enrollment_codes WHERE COALESCE(used_at, expires_at) < ?")
    .run(cutoff);
  return Number(changed.changes);
}

/** Burns the machine's previous code, so at most one is live. Returns the only plaintext. */
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

/** Call inside the revoke transaction. */
export function burnMachineCodes(db: DatabaseSync, machineId: string, now = Date.now()): number {
  return Number(
    db
      .prepare("UPDATE enrollment_codes SET used_at = ?, used_from = 'revoked' WHERE machine_id = ? AND used_at IS NULL")
      .run(now, machineId).changes,
  );
}

export type UserCodeBurnReason = "user_deleted" | "user_disabled";

/** /v1/enroll never reads disabled_at, so removing a user must burn their codes. created_by is left dangling on purpose. */
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

/** Burns codes for machines the user holds a grant on, so call it before the grants go. */
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
