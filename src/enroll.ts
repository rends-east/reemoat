import { createHash } from "node:crypto";
import { jwkToPublicKey } from "./token.js";
import { describeError } from "./http.js";

// The only control-plane request, made once; rotating the signing key means re-enrolling every daemon.

export type EnrollErrorCode =
  | "unreachable"
  /** The OS refused a private-network connect; unlike unreachable, waiting will not help. */
  | "local_network"
  | "timeout"
  | "code_rejected"
  | "bad_response"
  | "no_usable_keys";

/** EHOSTUNREACH to a private address: macOS Local Network Privacy refusing the app's child, not a network fault. */
function localNetworkBlocked(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (!(cause instanceof Error)) return false;
  const code = (cause as { code?: unknown }).code;
  if (code !== "EHOSTUNREACH" && code !== "ENETUNREACH") return false;
  const address = (cause as { address?: unknown }).address;
  return typeof address === "string" && isPrivateAddress(address);
}

function isPrivateAddress(address: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address);
  if (v4 !== null) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const v6 = address.toLowerCase();
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** The errno and message hidden in fetch's cause, which is where a TLS failure is named. */
function causeOf(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (!(cause instanceof Error)) return "";
  const code = (cause as { code?: unknown }).code;
  return ` (${typeof code === "string" && code.length > 0 ? `${code}: ` : ""}${cause.message})`;
}

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
  /** The only secret enrollment returns, so the relay can identify the daemon; null from an older control plane. */
  tunnelKey: string | null;
  relayUrl: string | null;
}

export interface EnrollOptions {
  controlPlane: string;
  code: string;
  /** Sent beside the code so re-enrollment replaces a pinned machine key the dial would refuse; omitted when absent. */
  machineKey?: string;
  timeoutMs?: number;
}

const DEFAULT_ENROLL_TIMEOUT_MS = 15_000;

/** Stored instead of the code: the same fingerprint skips enrollment, a different one exchanges again. */
export function codeFingerprint(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex").slice(0, 32);
}

export async function enroll(options: EnrollOptions): Promise<EnrollResult> {
  const url = new URL("/v1/enroll", options.controlPlane);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENROLL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const machineKey = options.machineKey?.trim() ?? "";
  const payload: Record<string, unknown> = { code: options.code.trim() };
  if (machineKey.length > 0) payload["machineKey"] = machineKey;

  let body: unknown;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Inside the timeout: fetch resolves at the headers, and a stalled body must still abort.
    body = await response.json().catch((error: unknown) => {
      // Rethrow an abort so a stalled body reports timeout, not bad_response.
      if (controller.signal.aborted) throw error;
      return null;
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EnrollError("timeout", `the control plane at ${url.origin} did not answer within ${timeoutMs / 1000}s`);
    }
    throw new EnrollError(
      localNetworkBlocked(error) ? "local_network" : "unreachable",
      `could not reach the control plane at ${url.origin}: ${describeError(error)}${causeOf(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = readError(body);
    throw new EnrollError(
      "code_rejected",
      `the control plane refused this enrollment code (${response.status}${detail ? `: ${detail}` : ""})`,
      body,
    );
  }

  return parseEnrollResponse(body);
}

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
    // Parsed now, where an operator is watching, not at the first rejected token months later.
    if (jwkToPublicKey(jwk) === null) continue;
    keys.push({ kid, jwk });
  }

  if (keys.length === 0) {
    throw new EnrollError(
      "no_usable_keys",
      "the control plane returned keys, but none of them was a usable Ed25519 public key",
    );
  }

  // Relay fields are optional both ways, so a relay can be introduced without a fleet upgrade.
  const rawTunnelKey = fields["tunnelKey"];
  const tunnelKey = typeof rawTunnelKey === "string" && rawTunnelKey.length > 0 ? rawTunnelKey : null;

  let relayUrl: string | null = null;
  const relay = fields["relay"];
  if (typeof relay === "object" && relay !== null && !Array.isArray(relay)) {
    const url = (relay as Record<string, unknown>)["url"];
    if (typeof url === "string" && url.length > 0) {
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

