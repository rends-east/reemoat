import { createHash, timingSafeEqual, type KeyObject } from "node:crypto";
import { decodeToken, jwkToPublicKey, looksLikeSignedToken, parseClaims, verifySignature } from "./token.js";

/**
 * Who is asking, and what they may do.
 *
 * The daemon used to answer that with one shared secret: holding it made you
 * every user, on every session, with every capability. This file replaces that
 * check with a seam — `verify(token) -> Principal | rejection` — behind which
 * either the old shared secret or a control-plane-signed token can sit.
 *
 * Everything downstream reads the *result*. Nothing outside this file and
 * `token.ts` ever sees the raw token, which is what stops a second, subtly
 * different check from growing somewhere else later.
 *
 * There is no network access here and there never should be. A daemon verifies
 * with a public key it already holds; it does not call the control plane to ask
 * about a token. That is the whole reason a control-plane outage cannot reach a
 * running session.
 */

export type Scope = "session:read" | "session:write" | "machine:admin";

export const ALL_SCOPES: readonly Scope[] = ["session:read", "session:write", "machine:admin"];

function isScope(value: string): value is Scope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

/**
 * Clock leeway, applied symmetrically to `nbf` and `exp`.
 *
 * Sixty seconds. NTP-synced hosts drift well under a second; unsynced consumer
 * hardware — a laptop that has been asleep, a phone that has just changed
 * network — routinely drifts tens of seconds. 60s absorbs the realistic case
 * while costing only a fifth of a five-minute token's lifetime.
 *
 * One constant, not a per-request parameter and not a library default, because
 * the failure it guards against is silent in both directions: too little and
 * valid tokens are rejected as expired, too much and expired ones are accepted.
 * Neither shows up as an error anywhere unless somebody chose the number on
 * purpose and wrote down why.
 *
 * The control plane refuses to mint a token whose lifetime is less than twice
 * this, since below that the leeway dominates and the stated TTL stops meaning
 * anything.
 */
export const AUTH_LEEWAY_MS = 60_000;

/**
 * How far outside the window still looks like a clock problem rather than an
 * attack. A token five minutes out of step is a machine that never synced; one
 * five hours out is not worth a diagnostic.
 */
const SKEW_DIAGNOSTIC_LIMIT_MS = 5 * AUTH_LEEWAY_MS;

export interface Principal {
  /** The user id from the token, or `shared-secret` in the legacy mode. */
  subject: string;
  scopes: readonly Scope[];
  /** The machine the token was minted for; `null` under the shared secret. */
  machineId: string | null;
  /**
   * Epoch ms, or `null` for a credential that never expires.
   *
   * Carried on the principal rather than checked once and discarded because a
   * WebSocket outlives the request that opened it — `server.ts` re-checks this
   * on its ping tick, which is what bounds revocation for a live stream.
   */
  expiresAt: number | null;
  /** `jti`, for the audit trail. `null` under the shared secret. */
  tokenId: string | null;
  via: "shared_secret" | "signed";
}

export type AuthFailureCode =
  | "missing_token"
  | "malformed_token"
  /** The shared secret did not match. Distinct from `bad_signature`, which is
   *  about a token that was signed by something we do not trust. */
  | "bad_credential"
  | "bad_signature"
  | "unknown_key"
  | "wrong_issuer"
  | "wrong_machine"
  | "token_expired"
  | "token_not_yet_valid";

export type VerifyResult =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      code: AuthFailureCode;
      message: string;
      /**
       * How far outside the acceptance window the token fell, in ms. Only set
       * on the two clock codes, and only reported so a caller can tell a stale
       * token from a wrong clock instead of seeing an undifferentiated 401.
       */
      skewMs?: number;
    };

export interface TokenVerifier {
  readonly mode: "shared_secret" | "signed" | "both";
  /**
   * `now` is a parameter, not a call to `Date.now()`, so the expiry and skew
   * paths can be driven from `scripts/` without touching the system clock.
   * There are no tests in this repo; this is what testable means here.
   */
  verify(token: string | null, now?: number): VerifyResult;
}

/* ------------------------------------------------------------------ *
 * Shared secret — the original behaviour, unchanged
 * ------------------------------------------------------------------ */

/**
 * One secret, all scopes, no expiry.
 *
 * This is what keeps the single-machine case working with no control plane
 * anywhere. It grants everything precisely because that is what it granted
 * before; narrowing it here would be a silent behaviour change for every
 * existing operator.
 */
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
        via: "shared_secret",
      },
    };
  }
}

/**
 * Constant-time within a length class.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees two equal-length
 * buffers. Comparing the raw strings needs an early length check, and that
 * check leaks the secret's length through timing — small, but free to avoid.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = sha256(provided);
  const b = sha256(expected);
  return timingSafeEqual(a, b);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/* ------------------------------------------------------------------ *
 * Signed tokens
 * ------------------------------------------------------------------ */

/** What a daemon keeps after enrollment. None of it expires. */
export interface MachineIdentity {
  machineId: string;
  issuer: string;
  keys: readonly { kid: string; jwk: unknown }[];
}

export interface SignedVerifierOptions {
  identity: MachineIdentity;
  leewayMs?: number;
  /**
   * Fired when a token is rejected for a reason that looks like a clock rather
   * than an attack. Nothing in `src/` prints, so this callback is the only way
   * an operator hears that this machine's clock has drifted — which is the
   * failure mode that would otherwise present as "auth mysteriously broke".
   */
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
      // A key we cannot parse is dropped rather than fatal: the set is plural
      // so that a rotation can be in flight, and one unusable entry must not
      // cost us the others.
      if (key !== null) this.keys.set(entry.kid, key);
    }
    this.leewayMs = options.leewayMs ?? AUTH_LEEWAY_MS;
    this.onSuspectedClockSkew = options.onSuspectedClockSkew;
  }

  /** How many usable keys this daemon holds. Zero means nothing can verify. */
  get keyCount(): number {
    return this.keys.size;
  }

  verify(token: string | null, now: number = Date.now()): VerifyResult {
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

    // Signature first. Nothing below this line would be safe to read if this
    // check had not passed, and putting it anywhere else is how a claim gets
    // trusted before it was proven.
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

    // The claim that stops one grant from becoming a grant to the whole fleet.
    // Every daemon trusts the same public key, so without this a token minted
    // for another machine would verify here perfectly.
    if (claims.aud !== this.options.identity.machineId) {
      return { ok: false, code: "wrong_machine", message: "token was issued for a different machine" };
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

    // Unknown scope strings are dropped rather than rejected, so a control
    // plane that learns a new scope before this daemon does keeps working.
    const scopes = claims.scp.filter(isScope);

    return {
      ok: true,
      principal: {
        subject: claims.sub,
        scopes,
        machineId: claims.aud,
        expiresAt: expMs,
        tokenId: claims.jti,
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

/* ------------------------------------------------------------------ *
 * Both
 * ------------------------------------------------------------------ */

/**
 * Accepts either credential, chosen by shape.
 *
 * A migration and break-glass mode, and documented as one: the shared secret
 * bypasses every grant and every scope check, so a daemon left in this mode is
 * a daemon whose control plane is decorative. It exists because enrolling a
 * remote daemon over the network is exactly the moment you can lock yourself
 * out of it.
 */
export class CompositeVerifier implements TokenVerifier {
  readonly mode = "both";

  constructor(
    private readonly signed: SignedTokenVerifier,
    private readonly shared: SharedSecretVerifier,
  ) {}

  verify(token: string | null, now: number = Date.now()): VerifyResult {
    if (token === null || token.length === 0) {
      return { ok: false, code: "missing_token", message: "missing bearer token" };
    }
    // Shape, not trial-and-error: a shared secret that happened to contain two
    // dots would otherwise be reported with a signature error, and a signed
    // token that failed for a real reason would be retried as a secret and come
    // back as the wrong failure entirely.
    return looksLikeSignedToken(token) ? this.signed.verify(token, now) : this.shared.verify(token);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes(scope);
}

/**
 * A daemon that enrolled and is about to ignore it — the missing half of a check
 * that already exists.
 *
 * `daemon.ts` refuses to start for the opposite mismatch: `REEMOAT_AUTH=signed`
 * with no stored identity exits 2, naming the two variables that fix it. The
 * reverse — a stored identity with no `REEMOAT_AUTH` — was silent, and the
 * asymmetry is the defect rather than an omission. Measured 2026-08-01 on a
 * machine enrolled as `m_ffeaf8c7`: restarting it without the variable (which
 * lived in a shell, not in `.env`) brought it up as `shared_secret`, and **both**
 * routes to it disappeared at once — a browser holds a control-plane token, which
 * that mode does not verify, and the relay tunnel is never dialled either. The
 * fleet screen said "unreachable" while `/health` answered 200 the whole time.
 *
 * **A warning and not a refusal**, for the reason `.env.example` gives: enrolling
 * a daemon you reach over the network is exactly the moment you can lock yourself
 * out of it, so a deliberate drop to the shared secret has to stay available. The
 * precedent is `REEMOAT_ROOTS` in `daemon.ts`, whose comment states the rule —
 * silently dropping a setting somebody wrote on purpose is how a boundary ends up
 * somewhere other than where they think.
 *
 * **Unset and explicitly `shared_secret` are different things**, which is the
 * whole discrimination. Unset means nobody decided and the default answered for
 * them; an explicit value means somebody did, and warning at them would be
 * shouting at precisely the operator using the break-glass path. An empty value
 * counts as unset, because `resolveAuthMode` already treats it that way.
 *
 * Returns the message rather than printing it: nothing in `src/` writes to stdout
 * or stderr, and a pure function is the only shape `authcheck` can reach — this
 * lives on the entry point's behalf, not in it.
 */
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
