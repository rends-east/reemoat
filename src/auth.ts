import { createHash, timingSafeEqual, type KeyObject } from "node:crypto";
import { decodeToken, jwkToPublicKey, looksLikeSignedToken, parseClaims, verifySignature } from "./token.js";

// Who is asking. No network access here: a daemon verifies with keys it already holds, so a control-plane outage cannot reach a session.

export type Scope = "session:read" | "session:write" | "machine:admin";

export const ALL_SCOPES: readonly Scope[] = ["session:read", "session:write", "machine:admin"];

function isScope(value: string): value is Scope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

export const AUTH_LEEWAY_MS = 60_000;

const SKEW_DIAGNOSTIC_LIMIT_MS = 5 * AUTH_LEEWAY_MS;

export interface Principal {
  subject: string;
  scopes: readonly Scope[];
  machineId: string | null;
  expiresAt: number | null;
  tokenId: string | null;
  /** Advisory, for the audit trail only; cnf is the binding that decides. */
  deviceId: string | null;
  via: "shared_secret" | "signed";
}

export interface ChannelIdentity {
  peerKeyThumbprint: string | null;
}

export type AuthFailureCode =
  | "missing_token"
  | "malformed_token"
  | "bad_credential"
  | "bad_signature"
  | "unknown_key"
  | "wrong_issuer"
  | "wrong_machine"
  | "unbound_capability"
  | "wrong_device"
  | "token_expired"
  | "token_not_yet_valid";

export type VerifyResult =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      code: AuthFailureCode;
      message: string;
      skewMs?: number;
    };

export interface TokenVerifier {
  readonly mode: "shared_secret" | "signed" | "both";
  verify(token: string | null, now?: number, channel?: ChannelIdentity): VerifyResult;
}

/** A spelling, not a fence: both verify signatures default to it, which is how the loopback auth gate in server.ts reaches it. */
export const NO_CHANNEL: ChannelIdentity = { peerKeyThumbprint: null };

export class SharedSecretVerifier implements TokenVerifier {
  readonly mode = "shared_secret";

  constructor(private readonly secret: string) {}

  verify(token: string | null): VerifyResult {
    if (token === null || token.length === 0) {
      return { ok: false, code: "missing_token", message: "missing bearer token" };
    }
    if (!secretMatches(token, this.secret)) {
      return { ok: false, code: "bad_credential", message: "invalid bearer token" };
    }
    return {
      ok: true,
      principal: {
        subject: "shared-secret",
        scopes: ALL_SCOPES,
        machineId: null,
        expiresAt: null,
        tokenId: null,
        deviceId: null,
        via: "shared_secret",
      },
    };
  }
}

// Both sides hashed first, so timingSafeEqual needs no length check that would leak the secret's length.
function secretMatches(provided: string, expected: string): boolean {
  const a = sha256(provided);
  const b = sha256(expected);
  return timingSafeEqual(a, b);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export interface MachineIdentity {
  machineId: string;
  issuer: string;
  keys: readonly { kid: string; jwk: unknown }[];
}

export interface SignedVerifierOptions {
  identity: MachineIdentity;
  leewayMs?: number;
  onSuspectedClockSkew?: (detail: string) => void;
}

export class SignedTokenVerifier implements TokenVerifier {
  readonly mode = "signed";

  private readonly keys: Map<string, KeyObject>;
  private readonly leewayMs: number;
  private readonly onSuspectedClockSkew: ((detail: string) => void) | undefined;

  constructor(private readonly options: SignedVerifierOptions) {
    this.keys = new Map();
    for (const entry of options.identity.keys) {
      const key = jwkToPublicKey(entry.jwk);
      // An unparseable key is dropped: the set is plural so a rotation can be in flight.
      if (key !== null) this.keys.set(entry.kid, key);
    }
    this.leewayMs = options.leewayMs ?? AUTH_LEEWAY_MS;
    this.onSuspectedClockSkew = options.onSuspectedClockSkew;
  }

  get keyCount(): number {
    return this.keys.size;
  }

  verify(token: string | null, now = Date.now(), channel: ChannelIdentity = NO_CHANNEL): VerifyResult {
    if (token === null || token.length === 0) {
      return { ok: false, code: "missing_token", message: "missing bearer token" };
    }

    const decoded = decodeToken(token);
    if (!decoded.ok) {
      return { ok: false, code: "malformed_token", message: decoded.message };
    }

    const key = this.keys.get(decoded.header.kid);
    if (key === undefined) {
      return {
        ok: false,
        code: "unknown_key",
        message: `token signed by unknown key ${decoded.header.kid}`,
      };
    }

    // Signature first: nothing below is safe to read until it passes.
    if (!verifySignature(decoded, key)) {
      return { ok: false, code: "bad_signature", message: "token signature does not verify" };
    }

    const claims = parseClaims(decoded.payloadJson);
    if (claims === null) {
      return { ok: false, code: "malformed_token", message: "token claims are missing or malformed" };
    }

    if (claims.iss !== this.options.identity.issuer) {
      return { ok: false, code: "wrong_issuer", message: "token was issued by a different control plane" };
    }

    // aud stops a grant for one machine from verifying fleet-wide, since every daemon trusts the same key.
    if (claims.aud !== this.options.identity.machineId) {
      return { ok: false, code: "wrong_machine", message: "token was issued for a different machine" };
    }

    // A channel that authenticated a key insists the capability names it (cnf.jkt); no channel means loopback.
    // After aud and before the clock checks, so a wrong-device token is never blamed on a clock.
    if (channel.peerKeyThumbprint !== null) {
      const bound = claims.cnf?.jkt;
      if (bound === undefined) {
        return {
          ok: false,
          code: "unbound_capability",
          message: "this capability names no device key, so nothing can be bound to it",
        };
      }
      if (bound !== channel.peerKeyThumbprint) {
        return {
          ok: false,
          code: "wrong_device",
          message: "this capability was issued to a different device",
        };
      }
    }

    const nbfMs = claims.nbf * 1000;
    const expMs = claims.exp * 1000;

    if (now < nbfMs - this.leewayMs) {
      const skewMs = nbfMs - this.leewayMs - now;
      this.reportSkew("not yet valid", skewMs, now);
      return { ok: false, code: "token_not_yet_valid", message: "token is not valid yet", skewMs };
    }
    if (now > expMs + this.leewayMs) {
      const skewMs = now - (expMs + this.leewayMs);
      this.reportSkew("expired", skewMs, now);
      return { ok: false, code: "token_expired", message: "token has expired", skewMs };
    }

    // Unknown scopes are dropped, not rejected, so a newer control plane keeps working.
    const scopes = claims.scp.filter(isScope);

    return {
      ok: true,
      principal: {
        subject: claims.sub,
        scopes,
        machineId: claims.aud,
        expiresAt: expMs,
        tokenId: claims.jti,
        deviceId: claims.dev ?? null,
        via: "signed",
      },
    };
  }

  private reportSkew(what: string, skewMs: number, now: number): void {
    if (this.onSuspectedClockSkew === undefined) return;
    if (skewMs > SKEW_DIAGNOSTIC_LIMIT_MS) return;
    this.onSuspectedClockSkew(
      `a token was rejected as ${what} by ${Math.round(skewMs / 1000)}s, which is within ` +
        `${Math.round(SKEW_DIAGNOSTIC_LIMIT_MS / 1000)}s of the acceptance window — ` +
        `this machine's clock is probably wrong (it reads ${new Date(now).toISOString()})`,
    );
  }
}

/** Migration and break-glass: the shared secret bypasses every grant and scope check. */
export class CompositeVerifier implements TokenVerifier {
  readonly mode = "both";

  constructor(
    private readonly signed: SignedTokenVerifier,
    private readonly shared: SharedSecretVerifier,
  ) {}

  verify(token: string | null, now: number = Date.now(), channel: ChannelIdentity = NO_CHANNEL): VerifyResult {
    if (token === null || token.length === 0) {
      return { ok: false, code: "missing_token", message: "missing bearer token" };
    }
    // By shape, so a signed token can never fall through to the shared-secret arm and escape the device binding.
    return looksLikeSignedToken(token) ? this.signed.verify(token, now, channel) : this.shared.verify(token);
  }
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}

/** Warning text for an enrolled daemon running without REEMOAT_AUTH; an explicit value, even shared_secret, gets none. */
export function enrollmentIgnored(
  authEnv: string | undefined,
  identity: { machineId: string } | null,
): string | null {
  if (identity === null) return null;
  if ((authEnv ?? "").trim().length > 0) return null;
  return (
    `this daemon enrolled as ${identity.machineId}, but REEMOAT_AUTH is not set, so it is\n` +
    "  running as shared_secret and ignoring that enrollment: control-plane tokens will not\n" +
    "  verify, and no relay tunnel will be dialled. Set REEMOAT_AUTH=signed (or both, which\n" +
    "  also keeps REEMOAT_TOKEN working)."
  );
}
