import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_KEYSET_ENDORSEMENTS, MAX_ROOT_HANDOVERS } from "../../../src/relay/protocol.js";
import {
  KEYSET_TYP,
  MAX_STATEMENT_KEYS,
  ROOT_TYP,
  decodeSigned,
  jwkToPublicKey,
  parseKeysetStatement,
  parseRootEndorsement,
  publicKeyToJwk,
  signCompact,
  verifySignature,
  type PublicKeyJwk,
} from "../../../src/token.js";
import {
  activePublicKeys,
  activeSigningKeys,
  ensureSigningKey,
  erasingKeys,
  keyIdFor,
  loadPrivateKey,
  mintSigningKey,
  retireSigningKey,
  wrapPrivateKey,
  type RetireKeyResult,
  type SigningKey,
} from "./keys.js";

// The root that vouches for the signing keys, and the statements it signs. A daemon takes both off its tunnel dial, so a
// rotation reaches a machine nobody visits. The relay reads only announcedKeyset, which loads no private key.

export interface TrustRoot {
  kid: string;
  jwk: PublicKeyJwk;
  /** False for a root whose private half is kept off this host: only its holder can sign a statement. */
  online: boolean;
  createdAt: number;
}

export interface StoredStatement {
  version: number;
  rootKid: string;
  statement: string;
  createdAt: number;
  kids: string[];
}

export function liveRoot(db: DatabaseSync): TrustRoot | null {
  const row = db
    .prepare(
      "SELECT kid, public_jwk, private_pem IS NOT NULL AS online, created_at FROM trust_roots WHERE retired_at IS NULL",
    )
    .get();
  if (!row) return null;
  return {
    kid: String(row["kid"]),
    jwk: JSON.parse(String(row["public_jwk"])) as PublicKeyJwk,
    online: Number(row["online"]) === 1,
    createdAt: Number(row["created_at"]),
  };
}

function rootPrivateKey(db: DatabaseSync, kid: string): KeyObject | null {
  const row = db.prepare("SELECT private_pem FROM trust_roots WHERE kid = ?").get(kid);
  const stored = row?.["private_pem"];
  return typeof stored === "string" ? loadPrivateKey(stored, kid) : null;
}

export function newestStatement(db: DatabaseSync): StoredStatement | null {
  const row = db
    .prepare("SELECT version, root_kid, statement, created_at FROM key_statements ORDER BY version DESC LIMIT 1")
    .get();
  if (!row) return null;
  const statement = String(row["statement"]);
  const decoded = decodeSigned(statement, KEYSET_TYP);
  const payload = decoded.ok ? parseKeysetStatement(decoded.payloadJson) : null;
  return {
    version: Number(row["version"]),
    rootKid: String(row["root_kid"]),
    statement,
    createdAt: Number(row["created_at"]),
    kids: (payload?.keys ?? []).map((key) => key.kid).sort(),
  };
}

function activeKids(db: DatabaseSync): string[] {
  return activePublicKeys(db)
    .map((key) => key.kid)
    .sort();
}

/** Each key as its id and its bytes: a statement is compared on both, since a kid is only a name. */
function namedKeys(keys: { kid: string; jwk: PublicKeyJwk }[]): string {
  return JSON.stringify(keys.map((key) => `${key.kid} ${key.jwk.x}`).sort());
}

/** The newest statement is the live root's and names exactly the keys that are active now. */
export function statementIsCurrent(db: DatabaseSync): boolean {
  const root = liveRoot(db);
  const newest = newestStatement(db);
  if (root === null || newest === null || newest.rootKid !== root.kid) return false;
  return JSON.stringify(newest.kids) === JSON.stringify(activeKids(db));
}

/** Signs and stores the next statement; `null` where the root's private half is not on this host, or there is nothing to state. */
function issueStatement(db: DatabaseSync, issuer: string, now: number): StoredStatement | null {
  const root = liveRoot(db);
  if (root === null) return null;
  const privateKey = rootPrivateKey(db, root.kid);
  const keys = activePublicKeys(db);
  if (privateKey === null || keys.length === 0) return null;
  const version = (newestStatement(db)?.version ?? 0) + 1;
  const statement = signCompact(
    KEYSET_TYP,
    { iss: issuer, v: version, iat: Math.floor(now / 1000), keys },
    root.kid,
    privateKey,
  );
  db.prepare("INSERT INTO key_statements (version, root_kid, statement, created_at) VALUES (?, ?, ?, ?)").run(
    version,
    root.kid,
    statement,
    now,
  );
  return newestStatement(db);
}

function ensureStatement(db: DatabaseSync, issuer: string, now: number): StoredStatement | null {
  return statementIsCurrent(db) ? newestStatement(db) : issueStatement(db, issuer, now);
}

function endorse(db: DatabaseSync, issuer: string, root: { kid: string; jwk: PublicKeyJwk }, signer: SigningKey, now: number): void {
  const endorsement = signCompact(ROOT_TYP, { iss: issuer, iat: Math.floor(now / 1000), root }, signer.kid, signer.privateKey);
  writeEndorsement(db, root.kid, signer.kid, endorsement, now);
}

function writeEndorsement(db: DatabaseSync, rootKid: string, signerKid: string, endorsement: string, now: number): void {
  db.prepare(
    "INSERT INTO root_endorsements (root_kid, signer_kid, endorsement, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(root_kid, signer_kid) DO UPDATE SET endorsement = excluded.endorsement, created_at = excluded.created_at",
  ).run(rootKid, signerKid, endorsement, now);
}

function transact<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN");
  try {
    const answer = body();
    db.exec("COMMIT");
    return answer;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Active signing keys that have not endorsed this root, so a daemon holding only one of them could never be introduced to it. */
function unendorsing(db: DatabaseSync, rootKid: string): SigningKey[] {
  const endorsed = new Set(
    db
      .prepare("SELECT signer_kid FROM root_endorsements WHERE root_kid = ?")
      .all(rootKid)
      .map((row) => String(row["signer_kid"])),
  );
  return activeSigningKeys(db).filter((key) => !endorsed.has(key.kid));
}

/**
 * The live root, made here and kept on this host when there is none. Every active signing key endorses it, which is what
 * introduces it to a daemon that enrolled before there was a root. A statement for the current keys is issued beside it.
 */
export function ensureTrustRoot(db: DatabaseSync, issuer: string, now = Date.now()): TrustRoot {
  ensureSigningKey(db);
  const held = liveRoot(db);
  if (held !== null) {
    const missing = unendorsing(db, held.kid);
    if (missing.length > 0 || !statementIsCurrent(db)) {
      transact(db, () => {
        for (const signer of missing) endorse(db, issuer, { kid: held.kid, jwk: held.jwk }, signer, now);
        if (!statementIsCurrent(db)) issueStatement(db, issuer, now);
      });
    }
    return held;
  }
  return transact(db, () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKeyToJwk(publicKey);
    const kid = keyIdFor(jwk);
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    db.prepare("INSERT INTO trust_roots (kid, public_jwk, private_pem, created_at) VALUES (?, ?, ?, ?)").run(
      kid,
      JSON.stringify(jwk),
      wrapPrivateKey(pem, kid),
      now,
    );
    for (const signer of activeSigningKeys(db)) endorse(db, issuer, { kid, jwk }, signer, now);
    issueStatement(db, issuer, now);
    return { kid, jwk, online: true, createdAt: now };
  });
}

/** `statement` names the new key, or is `null` where the root is off this host and somebody has to sign one. */
export type RotationAnswer =
  | { ok: true; key: SigningKey; statement: StoredStatement | null }
  | { ok: false; reason: "too_many_keys" };

/**
 * Publishes a new signing key, which endorses the live root, and with the root here the statement naming it, in one
 * transaction. The old key goes on signing. Refused with nothing written at as many keys as a statement's reader takes.
 */
export function rotateSigningKey(db: DatabaseSync, issuer: string, now = Date.now()): RotationAnswer {
  if (activePublicKeys(db).length >= MAX_STATEMENT_KEYS) return { ok: false, reason: "too_many_keys" };
  const root = ensureTrustRoot(db, issuer, now);
  return transact<RotationAnswer>(db, () => {
    const key = mintSigningKey(db, now);
    endorse(db, issuer, { kid: root.kid, jwk: root.jwk }, key, now);
    return { ok: true, key, statement: ensureStatement(db, issuer, now) };
  });
}

export type RetirementAnswer =
  | { ok: true; statement: StoredStatement | null }
  | { ok: false; reason: Extract<RetireKeyResult, { ok: false }>["reason"] | "statement_stale" | "machines_behind" };

/**
 * Retiring is the switch: the next token is signed by the oldest key left. Refused with the root off this host until an
 * installed statement names every key that stays, and then while `behind` is above zero: a caller that forces passes zero.
 */
export function retireKey(db: DatabaseSync, issuer: string, kid: string, behind = 0, now = Date.now()): RetirementAnswer {
  const root = ensureTrustRoot(db, issuer, now);
  const active = activeKids(db);
  if (!active.includes(kid)) return { ok: false, reason: "not_found" };
  if (active.length <= 1) return { ok: false, reason: "last_active" };
  if (!root.online) {
    const stated = newestStatement(db);
    const named = stated !== null && stated.rootKid === root.kid ? stated.kids : [];
    if (active.some((one) => one !== kid && !named.includes(one))) return { ok: false, reason: "statement_stale" };
  }
  if (behind > 0) return { ok: false, reason: "machines_behind" };
  return transact<RetirementAnswer>(db, () => {
    const retired = retireSigningKey(db, kid, now);
    if (!retired.ok) return retired;
    return { ok: true, statement: ensureStatement(db, issuer, now) };
  });
}

/** What the root's holder signs next: the active keys under the next version. `iat` is the signer's to add. */
export function draftStatement(db: DatabaseSync, issuer: string): { iss: string; v: number; keys: { kid: string; jwk: PublicKeyJwk }[] } {
  return { iss: issuer, v: (newestStatement(db)?.version ?? 0) + 1, keys: activePublicKeys(db) };
}

export type InstallRefusal =
  | "no_root"
  | "unreadable"
  | "wrong_root"
  | "bad_signature"
  | "wrong_issuer"
  | "not_newer"
  | "keyset_mismatch";

/** A statement signed elsewhere. It must name exactly the active keys, by id and by bytes: one that left the signer out would darken the fleet. */
export function installStatement(
  db: DatabaseSync,
  issuer: string,
  statement: string,
  now = Date.now(),
): { ok: true; version: number } | { ok: false; reason: InstallRefusal } {
  const root = liveRoot(db);
  if (root === null) return { ok: false, reason: "no_root" };
  const decoded = decodeSigned(statement, KEYSET_TYP);
  if (!decoded.ok) return { ok: false, reason: "unreadable" };
  if (decoded.header.kid !== root.kid) return { ok: false, reason: "wrong_root" };
  const rootKey = jwkToPublicKey(root.jwk);
  if (rootKey === null || !verifySignature(decoded, rootKey)) return { ok: false, reason: "bad_signature" };
  const payload = parseKeysetStatement(decoded.payloadJson);
  if (payload === null) return { ok: false, reason: "unreadable" };
  if (payload.iss !== issuer) return { ok: false, reason: "wrong_issuer" };
  if (payload.v <= (newestStatement(db)?.version ?? 0)) return { ok: false, reason: "not_newer" };
  if (namedKeys(payload.keys) !== namedKeys(activePublicKeys(db))) return { ok: false, reason: "keyset_mismatch" };
  db.prepare("INSERT INTO key_statements (version, root_kid, statement, created_at) VALUES (?, ?, ?, ?)").run(
    payload.v,
    root.kid,
    statement,
    now,
  );
  return { ok: true, version: payload.v };
}

export type AdoptRefusal = "bad_key" | "unchanged" | "retired_root" | "handover_required" | "bad_handover";

/**
 * Hands the root to a key whose private half was never here: the root being left signs the handover (or its holder supplies
 * one), every active signing key endorses the new one, and the old private half is erased. Its holder signs the next statement.
 */
export function adoptRoot(
  db: DatabaseSync,
  issuer: string,
  publicJwk: unknown,
  handover: string | null,
  now = Date.now(),
): { ok: true; root: TrustRoot } | { ok: false; reason: AdoptRefusal } {
  const publicKey = jwkToPublicKey(publicJwk);
  if (publicKey === null) return { ok: false, reason: "bad_key" };
  const jwk = publicKeyToJwk(publicKey);
  const kid = keyIdFor(jwk);

  const leaving = liveRoot(db);
  if (leaving?.kid === kid) return { ok: false, reason: "unchanged" };
  if (db.prepare("SELECT 1 AS hit FROM trust_roots WHERE kid = ?").get(kid) !== undefined) {
    return { ok: false, reason: "retired_root" };
  }

  let signed: string | null = null;
  if (leaving !== null) {
    const leavingKey = rootPrivateKey(db, leaving.kid);
    if (leavingKey !== null) {
      signed = signCompact(ROOT_TYP, { iss: issuer, iat: Math.floor(now / 1000), root: { kid, jwk } }, leaving.kid, leavingKey);
    } else {
      if (handover === null) return { ok: false, reason: "handover_required" };
      const decoded = decodeSigned(handover, ROOT_TYP);
      const leavingPublic = jwkToPublicKey(leaving.jwk);
      if (!decoded.ok || decoded.header.kid !== leaving.kid || leavingPublic === null || !verifySignature(decoded, leavingPublic)) {
        return { ok: false, reason: "bad_handover" };
      }
      const payload = parseRootEndorsement(decoded.payloadJson);
      if (payload === null || payload.iss !== issuer || payload.root.kid !== kid || payload.root.jwk.x !== jwk.x) {
        return { ok: false, reason: "bad_handover" };
      }
      signed = handover;
    }
  }

  return erasingKeys<{ ok: true; root: TrustRoot }>(
    db,
    () => {
      db.prepare("UPDATE trust_roots SET retired_at = ?, private_pem = NULL WHERE retired_at IS NULL").run(now);
      db.prepare("INSERT INTO trust_roots (kid, public_jwk, private_pem, created_at) VALUES (?, ?, NULL, ?)").run(
        kid,
        JSON.stringify(jwk),
        now,
      );
      if (leaving !== null && signed !== null) writeEndorsement(db, kid, leaving.kid, signed, now);
      for (const signer of activeSigningKeys(db)) endorse(db, issuer, { kid, jwk }, signer, now);
      return { ok: true, root: { kid, jwk, online: false, createdAt: now } };
    },
    () => leaving?.online === true,
  );
}

export interface AnnouncedKeyset {
  statement: string | null;
  version: number | null;
  endorsements: string[];
}

/**
 * What the relay hands a daemon on its dial, as strings another process signed: the live root's newest statement, then the
 * handover into each root back along the chain, then the live root's introductions by the active signing keys, oldest first,
 * then those by keys since retired while there is room.
 */
export function announcedKeyset(db: DatabaseSync): AnnouncedKeyset {
  const live = db.prepare("SELECT kid FROM trust_roots WHERE retired_at IS NULL").get();
  const liveKid = live === undefined ? null : String(live["kid"]);
  const newest =
    liveKid === null
      ? undefined
      : db.prepare("SELECT version, statement FROM key_statements WHERE root_kid = ? ORDER BY version DESC LIMIT 1").get(liveKid);
  const endorsements: string[] = [];
  const handover = db.prepare(
    "SELECT e.signer_kid, e.endorsement FROM root_endorsements e JOIN trust_roots r ON r.kid = e.signer_kid WHERE e.root_kid = ?",
  );
  const chain: string[] = [];
  let rootKid = liveKid;
  for (let hop = 0; hop < MAX_ROOT_HANDOVERS && rootKid !== null; hop += 1) {
    chain.push(rootKid);
    const row = handover.get(rootKid);
    if (row === undefined) break;
    endorsements.push(String(row["endorsement"]));
    rootKid = String(row["signer_kid"]);
  }
  if (liveKid !== null) {
    const introductions = db
      .prepare(
        "SELECT e.endorsement FROM root_endorsements e JOIN signing_keys k ON k.kid = e.signer_kid " +
          "WHERE e.root_kid = ? AND k.retired_at IS NULL ORDER BY k.created_at ASC, k.rowid ASC",
      )
      .all(liveKid);
    for (const row of introductions) endorsements.push(String(row["endorsement"]));
  }
  // Last, a daemon that slept through a rotation: the key it holds is retired here and still introduces a root to it.
  const retired = db.prepare(
    "SELECT e.endorsement FROM root_endorsements e JOIN signing_keys k ON k.kid = e.signer_kid " +
      "WHERE e.root_kid = ? AND k.retired_at IS NOT NULL ORDER BY k.retired_at DESC, k.rowid DESC",
  );
  for (const kid of chain) for (const row of retired.all(kid)) endorsements.push(String(row["endorsement"]));
  return {
    statement: newest ? String(newest["statement"]) : null,
    version: newest ? Number(newest["version"]) : null,
    endorsements: endorsements.slice(0, MAX_KEYSET_ENDORSEMENTS),
  };
}

/** Machines dialled in that have not been offered this statement: no dial since it was issued, or a daemon too old to say what it holds. */
export function machinesBehind(db: DatabaseSync, statement: StoredStatement | null, online: (machineId: string) => boolean): number {
  if (statement === null) return 0;
  const rows = db
    .prepare("SELECT id, daemon_keyset, daemon_seen_at FROM machines WHERE revoked_at IS NULL AND enrolled_at IS NOT NULL")
    .all();
  return rows.filter(
    (row) =>
      online(String(row["id"])) &&
      (row["daemon_keyset"] == null || Number(row["daemon_seen_at"] ?? 0) < statement.createdAt),
  ).length;
}
