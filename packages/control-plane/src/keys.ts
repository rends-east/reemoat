import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { publicKeyToJwk, type PublicKeyJwk } from "../../../src/token.js";

// No credential is stored recoverably; only the private halves of the signing keys and of an online root are kept.

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: PublicKeyJwk;
}

// Private keys at rest. With REEMOAT_CP_KEY_SECRET set they are AES-256-GCM under a key scrypt derives from it, so the
// database file and every backup of it stop being the fleet's signing key. Unset, a row is the PEM it always was.

const WRAPPED_PREFIX = "enc:v1:";
const WRAP_SALT_BYTES = 16;
const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;

let keySecret: string | null = null;
// scrypt once per salt and one parse per stored value: activeSigningKeys runs on every token mint.
const wrappingKeys = new Map<string, Buffer>();
const loadedKeys = new Map<string, KeyObject>();

/** The Authority's entry point alone calls this, once, before any key is read; the relay never holds the secret. */
export function configureKeySecret(secret: string | null): void {
  keySecret = secret !== null && secret.length > 0 ? secret : null;
  wrappingKeys.clear();
  loadedKeys.clear();
}

export class KeySecretError extends Error {
  constructor(readonly reason: "missing" | "wrong") {
    super(
      reason === "missing"
        ? "a private key in this database is wrapped and REEMOAT_CP_KEY_SECRET is not set"
        : "REEMOAT_CP_KEY_SECRET does not open a private key in this database",
    );
    this.name = "KeySecretError";
  }
}

function wrappingKey(salt: Buffer): Buffer {
  const name = salt.toString("base64url");
  let key = wrappingKeys.get(name);
  if (key === undefined) {
    key = scryptSync(keySecret ?? "", salt, 32);
    wrappingKeys.set(name, key);
  }
  return key;
}

/** What to store for a private key: the PEM itself while no secret is configured. The kid is bound in, so a blob opens only on its own row. */
export function wrapPrivateKey(pem: string, kid: string): string {
  if (keySecret === null) return pem;
  const salt = randomBytes(WRAP_SALT_BYTES);
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey(salt), iv);
  cipher.setAAD(Buffer.from(kid, "utf8"));
  const sealed = Buffer.concat([cipher.update(pem, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${WRAPPED_PREFIX}${salt.toString("base64url")}:${iv.toString("base64url")}:${sealed.toString("base64url")}`;
}

export function isWrapped(stored: string): boolean {
  return stored.startsWith(WRAPPED_PREFIX);
}

/** Throws KeySecretError for a wrapped value this process cannot open; a plain PEM loads with or without a secret. */
export function loadPrivateKey(stored: string, kid: string): KeyObject {
  const name = `${kid}\n${stored}`;
  const held = loadedKeys.get(name);
  if (held !== undefined) return held;
  const key = createPrivateKey(isWrapped(stored) ? unwrap(stored, kid) : stored);
  loadedKeys.set(name, key);
  return key;
}

function unwrap(stored: string, kid: string): string {
  if (keySecret === null) throw new KeySecretError("missing");
  const [salt, iv, sealed] = stored
    .slice(WRAPPED_PREFIX.length)
    .split(":")
    .map((part) => Buffer.from(part, "base64url"));
  if (salt === undefined || iv === undefined || sealed === undefined || sealed.length <= WRAP_TAG_BYTES) {
    throw new KeySecretError("wrong");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey(salt), iv);
    decipher.setAAD(Buffer.from(kid, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - WRAP_TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - WRAP_TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    // A tag failure: the wrong secret, or a blob moved onto another row.
    throw new KeySecretError("wrong");
  }
}

const PRIVATE_KEY_TABLES = ["signing_keys", "trust_roots"] as const;

/** Whether every stored private key opens with what this process was given, retired rows included: asked at start, before anything signs. */
export function keySecretProblem(db: DatabaseSync): "missing" | "wrong" | null {
  for (const table of PRIVATE_KEY_TABLES) {
    for (const row of db.prepare(`SELECT kid, private_pem FROM ${table} WHERE private_pem IS NOT NULL`).all()) {
      const stored = String(row["private_pem"]);
      if (!isWrapped(stored)) continue;
      try {
        loadPrivateKey(stored, String(row["kid"]));
      } catch (error) {
        if (error instanceof KeySecretError) return error.reason;
        throw error;
      }
    }
  }
  return null;
}

/** Wraps every private key still stored as a PEM, in one transaction; nothing to do, and zero, while no secret is configured. */
export function wrapStoredKeys(db: DatabaseSync): number {
  if (keySecret === null) return 0;
  let wrapped = 0;
  db.exec("BEGIN");
  try {
    for (const table of PRIVATE_KEY_TABLES) {
      const write = db.prepare(`UPDATE ${table} SET private_pem = ? WHERE kid = ?`);
      for (const row of db.prepare(`SELECT kid, private_pem FROM ${table} WHERE private_pem IS NOT NULL`).all()) {
        const stored = String(row["private_pem"]);
        if (isWrapped(stored)) continue;
        write.run(wrapPrivateKey(stored, String(row["kid"])), String(row["kid"]));
        wrapped += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return wrapped;
}

/** The way back, for a rollback past the build that wraps or for giving the secret up: every wrapped key stored as its PEM again. */
export function unwrapStoredKeys(db: DatabaseSync): number {
  let unwrapped = 0;
  db.exec("BEGIN");
  try {
    for (const table of PRIVATE_KEY_TABLES) {
      const write = db.prepare(`UPDATE ${table} SET private_pem = ? WHERE kid = ?`);
      for (const row of db.prepare(`SELECT kid, private_pem FROM ${table} WHERE private_pem IS NOT NULL`).all()) {
        const stored = String(row["private_pem"]);
        if (!isWrapped(stored)) continue;
        const key = loadPrivateKey(stored, String(row["kid"]));
        write.run(key.export({ type: "pkcs8", format: "pem" }).toString(), String(row["kid"]));
        unwrapped += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return unwrapped;
}

/** Deterministic, so the same key always has the same id across restores and re-publishes. */
export function keyIdFor(jwk: PublicKeyJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return `k_${createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 12)}`;
}

/** Newest first, all of them published. Which one signs is tokenSigningKey's answer, not this order's. */
export function activeSigningKeys(db: DatabaseSync): SigningKey[] {
  const rows = db
    .prepare(
      "SELECT kid, private_pem, public_jwk FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC, rowid DESC",
    )
    .all();
  return rows.map((row) => ({
    kid: String(row["kid"]),
    privateKey: loadPrivateKey(String(row["private_pem"]), String(row["kid"])),
    jwk: JSON.parse(String(row["public_jwk"])) as PublicKeyJwk,
  }));
}

/**
 * The oldest active key signs: it is the one every daemon already holds. So minting a key publishes it and darkens nothing,
 * and retiring the old one is the switch, taken once daemons have had the statement that names the new one.
 */
export function tokenSigningKey(db: DatabaseSync): SigningKey | null {
  const keys = activeSigningKeys(db);
  return keys[keys.length - 1] ?? null;
}

/** Public halves only, for unauthenticated paths: never loads a private key. */
export function activePublicKeys(db: DatabaseSync): { kid: string; jwk: PublicKeyJwk }[] {
  const rows = db
    .prepare("SELECT kid, public_jwk FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC, rowid DESC")
    .all();
  return rows.map((row) => ({
    kid: String(row["kid"]),
    jwk: JSON.parse(String(row["public_jwk"])) as PublicKeyJwk,
  }));
}

/** The key that signs, minted if there is none. */
export function ensureSigningKey(db: DatabaseSync): SigningKey {
  return tokenSigningKey(db) ?? mintSigningKey(db);
}

/** Publishes a key and leaves the signer alone. A rotation goes through trustroot.ts, which issues the statement beside it. */
export function mintSigningKey(db: DatabaseSync, now = Date.now()): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKeyToJwk(publicKey);
  const kid = keyIdFor(jwk);
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  db.prepare(
    "INSERT INTO signing_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)",
  ).run(kid, wrapPrivateKey(pem, kid), JSON.stringify(jwk), now);
  return { kid, privateKey, jwk };
}

/** The last active key cannot be retired. A daemon stops accepting the retired one when it takes the next statement. */
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

export interface SigningKeyRow {
  kid: string;
  createdAt: number;
  retiredAt: number | null;
  signs: boolean;
}

export function signingKeyRows(db: DatabaseSync): SigningKeyRow[] {
  const rows = db
    .prepare("SELECT kid, created_at, retired_at FROM signing_keys ORDER BY created_at DESC, rowid DESC")
    .all()
    .map((row) => ({
      kid: String(row["kid"]),
      createdAt: Number(row["created_at"]),
      retiredAt: row["retired_at"] == null ? null : Number(row["retired_at"]),
    }));
  const signer = rows.findLast((row) => row.retiredAt === null)?.kid ?? null;
  return rows.map((row) => ({ ...row, signs: row.kid === signer }));
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
