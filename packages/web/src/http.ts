import type { WireError } from "./wire";

/** One error type for every service's envelope; callers decide on code, not status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  /** A repeated permission answer is a 409 with a success-shaped body and no error envelope. */
  readonly body: unknown;

  constructor(status: number, code: string, message: string, detail: unknown = null, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }

  /** An ApiError means the route worked: never re-probe on one. */
  static isApiError(error: unknown): error is ApiError {
    return error instanceof ApiError;
  }
}

// No retry advice: a transport failure says nothing about whether the daemon acted.
const TRANSPORT_TEXT = "the connection failed, and whether the request arrived is not known";

export function errorText(cause: unknown): string {
  if (cause instanceof Error && isTransportFailure(cause)) return TRANSPORT_TEXT;
  return ApiError.isApiError(cause) ? cause.message : String(cause);
}

/** Keyed on codes, never 503: the daemon's 503 unresponsive comes from a live machine. */
export function meansMachineGone(error: unknown): boolean {
  if (!ApiError.isApiError(error)) return false;
  // owner_disabled is not user_disabled, which would sign the user out.
  return (
    error.code === "no_tunnel" || error.code === "machine_over_limit" || error.code === "owner_disabled"
  );
}

export function meansDeviceKeyMissing(error: unknown): boolean {
  return ApiError.isApiError(error) && error.code === "device_key_required";
}

export function meansWrongMachine(error: unknown): boolean {
  return ApiError.isApiError(error) && error.code === "wrong_machine";
}

/** Only the ultracode restart's 409 turn_in_flight; never add a code without a sentence on the control (Q3.429). */
export function meansRestartRefused(error: unknown): boolean {
  return ApiError.isApiError(error) && error.code === "turn_in_flight";
}

/** An older daemon: Hono's bare 404 with no envelope. Takes a remedy sentence and no retry. */
export function meansRouteAbsent(error: unknown): boolean {
  return ApiError.isApiError(error) && error.status === 404 && error.code === `http_${error.status}`;
}

/** True for anything that is not an ApiError, client bugs included; errorText narrows it. */
export function isTransportFailure(error: unknown): boolean {
  return !ApiError.isApiError(error);
}

/** Codes that clear with nobody acting; the admin-only refusals are excluded. */
export function meansLater(error: unknown): boolean {
  if (!ApiError.isApiError(error)) return false;
  return error.code === "unreachable" || error.code === "no_tunnel" || error.code === "tunnel_failed";
}

export function answerAlreadyLanded(error: unknown, expiredCode: string): boolean {
  if (!ApiError.isApiError(error) || error.status !== 409) return false;
  const body = error.body as { repeat?: boolean } | null;
  const detail = error.detail as { repeat?: boolean } | null;
  return body?.repeat === true || detail?.repeat === true || error.code === expiredCode;
}

/** Shared by fetch and the upload XHR so the 409-body rule has one copy. */
export function parseBody<T>(status: number, statusText: string, text: string): T {
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (status < 200 || status >= 300) {
    const envelope = parsed as WireError | null;
    const wire = envelope?.error;
    throw new ApiError(
      status,
      wire?.code ?? `http_${status}`,
      wire?.message ?? (text.slice(0, 200) || statusText || "request failed"),
      wire?.detail ?? null,
      parsed,
    );
  }

  return parsed as T;
}

export async function readJson<T>(response: Response): Promise<T> {
  return parseBody<T>(response.status, response.statusText, await response.text());
}

export function contentTypeFor(body: BodyInit | null | undefined): string | null {
  if (body === undefined || body === null) return null;
  // A string body is always JSON: every daemon.ts caller stringifies.
  if (typeof body === "string") return "application/json";
  return "application/octet-stream";
}

export function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return outer === undefined ? timeout : AbortSignal.any([timeout, outer]);
}
