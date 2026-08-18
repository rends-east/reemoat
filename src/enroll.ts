import { createHash } from "node:crypto";
import { jwkToPublicKey } from "./token.js";
import { describeError } from "./http.js";

/**
 * The one and only time this daemon talks to a control plane.
 *
 * An enrollment code is exchanged, exactly once, for a machine id and the
 * public keys that verify tokens addressed to it. All of that is then written
 * to the local database and this module is never called again — not to refresh
 * a key, not to check a revocation list, not to renew anything. That is what
 * makes a control-plane outage invisible to a running daemon, and it is a
 * property worth defending: any future "just poll for X" turns every daemon
 * into something that stops working when the control plane does.
 *
 * The consequence, stated where it will be read: rotating the control plane's
 * signing key requires re-enrolling every daemon. The key set is plural so old
 * and new can be trusted at once while that happens.
 */

export type EnrollErrorCode =
  | "unreachable"
  | "timeout"
  | "code_rejected"
  | "bad_response"
  | "no_usable_keys";

export class EnrollError extends Error {
  constructor(
    readonly code: EnrollErrorCode,
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = "EnrollError";
  }
}

export interface EnrollResult {
  machineId: string;
  issuer: string;
  keys: { kid: string; jwk: unknown }[];
  /**
   * The long-lived credential this daemon holds a relay tunnel with, or `null`
   * from a control plane too old to issue one.
   *
   * Everything else enrollment hands over is *public* — a machine id is a name
   * and a public key is public — so none of it lets the daemon prove who it is on
   * a later connection. This is the only secret in the exchange, and it exists so
   * that a daemon dialling the relay can be identified rather than believed.
   *
   * Rotated by re-enrolling, like the signing keys, because one rotation story is
   * better than two.
   */
  tunnelKey: string | null;
  /** Where to dial for a relay tunnel, or `null` when the control plane runs none. */
  relayUrl: string | null;
}

export interface EnrollOptions {
  controlPlane: string;
  code: string;
  /** Startup is not allowed to hang on a control plane that accepts and stalls. */
  timeoutMs?: number;
}

const DEFAULT_ENROLL_TIMEOUT_MS = 15_000;

/**
 * A stable fingerprint of an enrollment code.
 *
 * Stored instead of the code so that "this daemon was started with the same
 * code as last time" is answerable without keeping a live credential on disk.
 * That comparison is the whole of the re-enrollment rule: same fingerprint,
 * do nothing; different fingerprint, exchange again.
 */
export function codeFingerprint(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex").slice(0, 32);
}

export async function enroll(options: EnrollOptions): Promise<EnrollResult> {
  const url = new URL("/v1/enroll", options.controlPlane);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENROLL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body: unknown;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: options.code.trim() }),
      signal: controller.signal,
    });
    // Inside the timeout, not after it. `fetch` resolves as soon as the headers
    // arrive, so a control plane that answers `200` and then stalls the body
    // would hang startup for ever if the timer were cleared here — which is the
    // precise failure this timeout exists to prevent. Aborting the signal after
    // the response resolves still tears down the body stream.
    body = await response.json().catch((error: unknown) => {
      /*
       * An abort here is the timeout firing *during the body*, which is the exact
       * case the comment above is about — so it has to be rethrown.
       *
       * A blanket `() => null` swallowed it, and the effect was subtle: the abort
       * never reached the handler below, `response.ok` was still true for the 200
       * whose headers had arrived, and startup failed with `bad_response` — "the
       * control plane sent something malformed" — for a control plane that had in
       * fact simply stopped talking. Measured by `pnpm authcheck`'s stalling-server
       * case, which is why that case exists.
       *
       * Anything else really is a body that would not parse, and staying lenient
       * there is deliberate: `parseEnrollResponse` gives a better message for it.
       */
      if (controller.signal.aborted) throw error;
      return null;
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EnrollError("timeout", `the control plane at ${url.origin} did not answer within ${timeoutMs / 1000}s`);
    }
    throw new EnrollError("unreachable", `could not reach the control plane at ${url.origin}: ${describeError(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // The control plane's own error code, when it sent one. A code that was
    // already redeemed and a code that never existed are different problems and
    // the operator has to be able to tell them apart.
    const detail = readError(body);
    throw new EnrollError(
      "code_rejected",
      `the control plane refused this enrollment code (${response.status}${detail ? `: ${detail}` : ""})`,
      body,
    );
  }

  return parseEnrollResponse(body);
}

/** Split out from the fetch so the shape rules can be exercised without a server. */
export function parseEnrollResponse(body: unknown): EnrollResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EnrollError("bad_response", "the control plane did not return a JSON object");
  }
  const fields = body as Record<string, unknown>;
  const machineId = fields["machineId"];
  const issuer = fields["issuer"];
  const rawKeys = fields["keys"];

  if (typeof machineId !== "string" || machineId.length === 0) {
    throw new EnrollError("bad_response", "the enrollment response carried no machineId");
  }
  if (typeof issuer !== "string" || issuer.length === 0) {
    throw new EnrollError("bad_response", "the enrollment response carried no issuer");
  }
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    throw new EnrollError("bad_response", "the enrollment response carried no keys");
  }

  const keys: { kid: string; jwk: unknown }[] = [];
  for (const entry of rawKeys) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kid = record["kid"];
    const jwk = record["jwk"];
    if (typeof kid !== "string" || kid.length === 0) continue;
    // Parsed now, not at first use. A key that cannot be turned into an Ed25519
    // public key is worthless, and finding that out at enrollment — where an
    // operator is watching — beats finding out on the first request months
    // later, when the symptom is "every token is rejected".
    if (jwkToPublicKey(jwk) === null) continue;
    keys.push({ kid, jwk });
  }

  if (keys.length === 0) {
    throw new EnrollError(
      "no_usable_keys",
      "the control plane returned keys, but none of them was a usable Ed25519 public key",
    );
  }

  /*
   * The relay fields are optional in both directions, and neither direction is a
   * failure.
   *
   * A control plane with no relay omits them; a daemon that finds them missing
   * simply never dials one and behaves exactly as it did before any of this
   * existed. Making either an error would mean a relay could not be introduced
   * without a synchronised fleet upgrade, which is the opposite of what
   * "additive" is supposed to buy.
   */
  const rawTunnelKey = fields["tunnelKey"];
  const tunnelKey = typeof rawTunnelKey === "string" && rawTunnelKey.length > 0 ? rawTunnelKey : null;

  let relayUrl: string | null = null;
  const relay = fields["relay"];
  if (typeof relay === "object" && relay !== null && !Array.isArray(relay)) {
    const url = (relay as Record<string, unknown>)["url"];
    if (typeof url === "string" && url.length > 0) {
      // Parsed here, where an operator is watching, rather than at first dial —
      // the same reason the keys above are parsed at enrollment.
      try {
        relayUrl = new URL(url).toString();
      } catch {
        throw new EnrollError("bad_response", `the control plane offered a relay at an unparseable URL: ${url}`);
      }
    }
  }

  return { machineId, issuer, keys, tunnelKey, relayUrl };
}

function readError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return null;
  const fields = error as Record<string, unknown>;
  const code = fields["code"];
  const message = fields["message"];
  if (typeof code === "string" && typeof message === "string") return `${code} — ${message}`;
  return typeof code === "string" ? code : null;
}

