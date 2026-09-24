// Shared with the control plane, which imports downhill: never import back, and keep this file on the Dockerfile COPY line.

import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";

const gzip = promisify(gzipCallback);

export const COMPRESS_MIN_BYTES = 8 * 1024;

export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header
    .toLowerCase()
    .split(",")
    .some((part) => part.trim().split(";")[0]?.trim() === "gzip");
}

/** Keyed on content type, never path: compressing an octet stream would falsify the content-length a download guard reads. */
export function compressible(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/json") return true;
  if (type === "application/javascript" || type === "text/javascript") return true;
  if (type === "application/wasm") return false;
  return type.startsWith("text/") || type === "image/svg+xml";
}

/** Registered first, so it wraps every later middleware. Skips encoded bodies, small bodies, incompressible types and upgrades. */
export function gzipResponses(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.header("upgrade") !== undefined) return;
    if (!acceptsGzip(c.req.header("accept-encoding"))) return;
    if (c.res.headers.has("content-encoding")) return;
    if (!compressible(c.res.headers.get("content-type"))) return;
    // Reading the body consumes it, so every path below must put a body back.
    const raw = Buffer.from(await c.res.arrayBuffer());
    if (raw.byteLength < COMPRESS_MIN_BYTES) {
      c.res = new Response(raw, { status: c.res.status, headers: c.res.headers });
      return;
    }
    const packed = await gzip(raw);
    const headers = new Headers(c.res.headers);
    headers.set("content-encoding", "gzip");
    headers.append("vary", "accept-encoding");
    c.res = new Response(packed, { status: c.res.status, headers });
    // Set after the assignment: Hono merges the old response's content-length over the new one.
    c.res.headers.set("content-length", String(packed.byteLength));
  };
}

/** Not every non-2xx is one of these: a repeated permission answer is a 409 with a success-shaped body. */
interface ErrorEnvelope {
  error: { code: string; message: string; detail: unknown };
}

export function errorEnvelope(code: string, message: string, detail: unknown = null): ErrorEnvelope {
  return { error: { code, message, detail } };
}

/** 413 and 429 are distinct on purpose: too big is not wrong state, and a throttle expires (it carries Retry-After). */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503 | 504;

export function jsonError(
  c: Context,
  status: ErrorStatus,
  code: string,
  message: string,
  detail: unknown = null,
): Response {
  return c.json(errorEnvelope(code, message, detail), status);
}

/** null only when absent; a malformed header is an empty string, so a query fallback must test === null. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  return /^Bearer +(.*)$/i.exec(header.trim())?.[1]?.trim() ?? "";
}

export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function boundedInt(raw: string | undefined, fallback: number, max = Number.POSITIVE_INFINITY): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
