import type { KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AUTH_LEEWAY_MS } from "../../../../src/auth.js";
import { MAX_STREAMS_PER_LINK, MAX_STREAMS_PER_SUBJECT } from "../../../../src/relay/protocol.js";
import { decodeToken, jwkToPublicKey, parseClaims, verifySignature } from "../../../../src/token.js";
import { machineStanding } from "../quota.js";
import { activeUser, grantFor, linkById, machineById } from "../store.js";
import type { StreamLimiter } from "./registry.js";

// Reachability only; what a token may do stays with the daemon's requireScope.
// Reads live rows per request, so a revoked grant stops here at once, sooner than on the direct path.

export type RelayAuth =
  | {
      ok: true;
      subject: string;
      machineId: string;
      scopes: string[];
      /** Epoch ms. Checked once, at open: the daemon's ping tick ends a stream whose token expired. */
      expiresAt: number;
      tokenId: string;
      limiter: StreamLimiter;
    }
  | { ok: false; status: 401 | 403 | 404; code: string; message: string };

export interface RelayAuthorizer {
  authorize(token: string | null, now?: number): RelayAuth;
}

/** Small, so a bogus kid cannot delay a genuine rotation, while a flood still costs one indexed read per second. */
export const KEY_REFRESH_MS = 1_000;

export function createRelayAuthorizer(db: DatabaseSync, issuer: string): RelayAuthorizer {
  // Public keys by kid, read from public_jwk so this unauthenticated path never loads a private key.
  let cache = new Map<string, KeyObject>();
  let refreshedAt = 0;

  const refresh = (): void => {
    const rebuilt = new Map<string, KeyObject>();
    for (const row of db.prepare("SELECT kid, public_jwk FROM signing_keys WHERE retired_at IS NULL").all()) {
      let jwk: unknown;
      try {
        jwk = JSON.parse(String(row["public_jwk"]));
      } catch {
        continue;
      }
      const parsed = jwkToPublicKey(jwk);
      // Dropped rather than fatal: a rotation in flight must not take the relay down.
      if (parsed !== null) rebuilt.set(String(row["kid"]), parsed);
    }
    cache = rebuilt;
    refreshedAt = Date.now();
  };

  // Refreshed on age, not only on a miss: a retired key is still a cache hit and would otherwise keep verifying.
  const keyFor = (kid: string): KeyObject | null => {
    if (Date.now() - refreshedAt >= KEY_REFRESH_MS) refresh();
    return cache.get(kid) ?? null;
  };

  // The row, both of its ends against the token, and the source's own standing; the target's is checked below with every caller's.
  const linkIsLive = (linkId: string, sourceMachineId: string, targetMachineId: string): boolean => {
    const row = linkById(db, linkId);
    if (row === null || row.revoked) return false;
    if (row.targetMachineId !== targetMachineId || row.sourceMachineId !== sourceMachineId) return false;
    const source = machineById(db, sourceMachineId);
    if (source === null || source.revoked) return false;
    const standing = machineStanding(db, sourceMachineId);
    return standing === null || (!standing.ownerDisabled && !standing.over);
  };

  return {
    authorize(token, now = Date.now()) {
      if (token === null || token.length === 0) {
        return { ok: false, status: 401, code: "missing_token", message: "missing token" };
      }

      // Structural decode only; the payload stays an unparsed string until the signature verifies.
      const decoded = decodeToken(token);
      if (!decoded.ok) {
        return { ok: false, status: 401, code: decoded.code, message: decoded.message };
      }

      const key = keyFor(decoded.header.kid);
      if (key === null) {
        return { ok: false, status: 401, code: "unknown_key", message: "token was signed by an unknown key" };
      }
      if (!verifySignature(decoded, key)) {
        return { ok: false, status: 401, code: "bad_signature", message: "token signature did not verify" };
      }

      const claims = parseClaims(decoded.payloadJson);
      if (claims === null) {
        return { ok: false, status: 401, code: "malformed_token", message: "token claims are malformed" };
      }
      if (claims.iss !== issuer) {
        return { ok: false, status: 401, code: "wrong_issuer", message: "token was issued by a different control plane" };
      }

      // The daemon's leeway, so a token accepted here is not refused one hop later.
      const notBefore = claims.nbf * 1000 - AUTH_LEEWAY_MS;
      const notAfter = claims.exp * 1000 + AUTH_LEEWAY_MS;
      if (now < notBefore) {
        return { ok: false, status: 401, code: "token_not_yet_valid", message: "token is not valid yet" };
      }
      if (now > notAfter) {
        return { ok: false, status: 401, code: "token_expired", message: "token has expired" };
      }

      // aud is the routing key: a caller can address only the machine its token was minted for.
      const machineId = claims.aud;

      const machine = machineById(db, machineId);
      // Same answer for "no such machine" and "no grant", so the fleet cannot be enumerated.
      if (!machine || machine.revoked) {
        return { ok: false, status: 404, code: "machine_not_found", message: "no such machine" };
      }

      const link = linkClaimsOf(decoded.payloadJson);
      if (link === "malformed") {
        return { ok: false, status: 401, code: "malformed_token", message: "token claims are malformed" };
      }
      // Every link refusal is the unknown machine's 404, so a link token cannot map which machine or link is alive.
      if (link !== null && !linkIsLive(link.id, link.sourceMachineId, machineId)) {
        return { ok: false, status: 404, code: "machine_not_found", message: "no such machine" };
      }

      const user = activeUser(db, claims.sub);
      if (!user) {
        return { ok: false, status: 403, code: "user_disabled", message: "this user has been disabled" };
      }

      const scopes = grantFor(db, claims.sub, machineId);
      if (scopes === null) {
        return { ok: false, status: 404, code: "machine_not_found", message: "no such machine" };
      }
      if (scopes.length === 0) {
        return { ok: false, status: 403, code: "no_scopes", message: "this grant carries no usable scopes" };
      }

      // Last, behind a proved grant: it names a real state and would otherwise be an enumeration oracle.
      // Read live with no cache; null (a machine nobody owns) passes.
      const standing = machineStanding(db, machineId);
      // owner_disabled, never user_disabled: the client signs a tab out on the latter.
      if (standing !== null && standing.ownerDisabled) {
        return {
          ok: false,
          status: 403,
          code: "owner_disabled",
          message: "this machine's owner has been disabled, so it is switched off",
        };
      }
      if (standing !== null && standing.over) {
        return {
          ok: false,
          status: 403,
          code: "machine_over_limit",
          message:
            standing.ownerId === claims.sub
              ? "you are over your machine limit, so the machines you added most recently are switched off. " +
                "Retire one, or ask whoever runs this control plane to raise the limit — nothing has been deleted."
              : "this machine is over its owner's machine limit and is switched off",
        };
      }

      return {
        ok: true,
        subject: claims.sub,
        machineId,
        scopes,
        expiresAt: claims.exp * 1000,
        tokenId: claims.jti,
        limiter:
          link === null
            ? { key: claims.sub, max: MAX_STREAMS_PER_SUBJECT, link: false }
            : { key: `lnk:${link.id}`, max: MAX_STREAMS_PER_LINK, link: true },
      };
    },
  };
}

export interface LinkClaims {
  id: string;
  sourceMachineId: string;
}

/** Call only after the signature verified. parseClaims drops what it does not know, so the link claims are read here; a half-formed link is malformed, never an ordinary token. */
export function linkClaimsOf(payloadJson: string): LinkClaims | null | "malformed" {
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return "malformed";
  }
  const lnk = fields["lnk"];
  if (lnk === undefined) return null;
  const src = fields["src"];
  const srcl = fields["srcl"];
  if (typeof lnk !== "string" || lnk.length === 0) return "malformed";
  if (typeof src !== "string" || src.length === 0) return "malformed";
  if (typeof srcl !== "string") return "malformed";
  return { id: lnk, sourceMachineId: src };
}
