/**
 * The HTTP vocabulary both services answer in.
 *
 * Shared the same way `cors.ts` and `relay/protocol.ts` are: the control plane
 * imports *downhill* from `src/`, and nothing here may ever import back.
 *
 * ⚠ **A file in `src/` reached by the control plane must be copied into its
 * image.** `deploy/docker/Dockerfile` names those files literally, and an import
 * it does not name passes `typecheck` and every offline driver while breaking
 * only `pnpm imagecheck` — which needs Docker and runs as its own CI job. This
 * module is on that COPY line; keep it there.
 *
 * What lives here is what was written twice and had already begun to drift: the
 * error envelope, the `Bearer` parse, the JSON-object body read, and the
 * "message out of an unknown" one-liner that existed in four declarations and
 * seventeen inline copies.
 */

import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";

const gzip = promisify(gzipCallback);

/**
 * Below this, gzip costs more than it saves.
 *
 * 8 KiB rather than a few hundred bytes because the win is *uplink*, and a
 * response small enough to fit a packet or two crosses a home connection in one
 * round trip either way — while the CPU and the extra `Vary` are paid every time.
 */
export const COMPRESS_MIN_BYTES = 8 * 1024;

/** Whether the caller said it would take gzip. Case- and `q`-insensitive on purpose. */
export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header
    .toLowerCase()
    .split(",")
    .some((part) => part.trim().split(";")[0]?.trim() === "gzip");
}

/**
 * Whether a response of this type may be compressed, **keyed on the content type
 * and never on the path**.
 *
 * This is the load-bearing half of the middleware and the reason it is a named
 * predicate. `GET /sessions/:id/files` and `/uploads/:uploadId` stream arbitrary
 * bytes as `application/octet-stream`, and the client refuses an oversized file by
 * reading `content-length` **before** the body is resident — `Content-Length` being
 * the one size header CORS exposes without `Access-Control-Expose-Headers`. Compress
 * those and that number describes the compressed size, so the 100 MiB guard silently
 * measures the wrong thing and a file that does not fit gets through it.
 *
 * A path test would have done the same job today and failed open the day somebody
 * adds a route that streams bytes — the same argument `readCredential` makes for
 * keying on the `upgrade` header rather than on the stream route's path. The type is
 * a fact about what is being sent; the path is a fact about who is sending it.
 *
 * Octet streams are also incompressible in the general case (they are usually
 * already-compressed images), so nothing is lost by the exclusion.
 */
export function compressible(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/json") return true;
  if (type === "application/javascript" || type === "text/javascript") return true;
  if (type === "application/wasm") return false;
  return type.startsWith("text/") || type === "image/svg+xml";
}

/**
 * gzip what is worth gzipping, once, for both services.
 *
 * **Measured, and this is why it exists.** Nothing in this system compressed
 * anything: not the daemon, not the control plane, and deliberately not the relay
 * (that carries h2 frames, which are already framed). So a transcript page of 5000
 * events crossed a home uplink at **1.23 MB** where it gzips to about 90 KB, and the
 * web bundle at **625 KB** where it gzips to 187 KB. On the sample measured with the
 * real middleware: 574 607 B → 45 779 B, 12.5×, with no measurable time cost. The
 * scarce resource on this path is the *upstream* of the machine an agent runs on,
 * and every byte of a transcript crosses it twice — once to the relay, once to the
 * browser.
 *
 * Registered **first**, so it wraps every later middleware including the auth gate's
 * own refusals, and so nothing else has to know about it.
 *
 * Three things it declines, each for its own reason: a body already encoded by
 * somebody else, anything under {@link COMPRESS_MIN_BYTES}, and any content type
 * {@link compressible} refuses. An upgrade request is covered by the third — a 101
 * carries no content type — and by the explicit check, because a WebSocket handshake
 * that this touched at all would be a failure with no obvious cause.
 */
export function gzipResponses(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // Never a socket. `arrayBuffer()` on a handshake response is not a thing to
    // find out about in production.
    if (c.req.header("upgrade") !== undefined) return;
    if (!acceptsGzip(c.req.header("accept-encoding"))) return;
    if (c.res.headers.has("content-encoding")) return;
    if (!compressible(c.res.headers.get("content-type"))) return;
    /*
     * ⚠ **Reading the body consumes it, so from here every path must put one
     * back.** This returned early on `byteLength < COMPRESS_MIN_BYTES` and left
     * `c.res` holding a body already read: `@hono/node-server` then calls
     * `getReader()` on it and throws `ERR_INVALID_STATE: ReadableStream is
     * locked`, which is a 500 with no body on **every compressible response under
     * the threshold** — `GET /sessions` among them, i.e. the whole app. It reached
     * production, and it survived a driver that only asserted the *compressed*
     * path and a `/health` small enough to be answered from a string rather than a
     * stream.
     *
     * There is no way to avoid the read: `c.json` sets no `content-length`, so the
     * size is not knowable without buffering. So the rule is the other way round —
     * buffer once, then always replace, and let the branch decide only *what* is
     * put back.
     */
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
    /*
     * ⚠ **`content-length` is written *after* the assignment, and it has to be.**
     *
     * Hono's `set res` merges the **previous** response's headers onto the new one
     * (`context.js`: every header but `content-type`, with `.set()`), so a
     * `content-length` the old response carried wins over the one set on the new —
     * whatever the middleware did. `serveStatic` sets one, so the web bundle went
     * out as `content-encoding: gzip` with `content-length: 639870` beside a body of
     * **192 402**. curl exits 18, HTTP/2 through a proxy answers
     * `INTERNAL_ERROR (err 2)` and curl exits 92, undici throws
     * `TypeError: terminated` — and a browser drops the bundle in silence, which is
     * a **white page with an empty console**. The bytes were never the problem: they
     * matched the file on disk exactly.
     *
     * `content-encoding` and `vary` survive the merge only because the old response
     * has neither, which is precisely why this one had to be found the hard way:
     * two of the three headers arrived and the code read as correct.
     *
     * Rewritten rather than deleted, for the reason the exclusion above exists: a
     * client that reads this — and this one does, for downloads — must never see a
     * length that describes different bytes than the ones it is being sent.
     */
    c.res.headers.set("content-length", String(packed.byteLength));
  };
}

/**
 * Every non-2xx body in this system, in one shape.
 *
 * Typed rather than spelled out per call site because it is also hand-built in
 * raw `node:http` handlers in the relay, where there is no `c.json` to go
 * through — four places that previously agreed by copy.
 *
 * The matching rule on the client is that **not every non-2xx is one of these**:
 * a repeated permission answer is a 409 carrying a *success*-shaped body. See
 * the invariant of that name; a reader here must not assume the presence of an
 * `error` key from the status alone.
 */
export interface ErrorEnvelope {
  error: { code: string; message: string; detail: unknown };
}

export function errorEnvelope(code: string, message: string, detail: unknown = null): ErrorEnvelope {
  return { error: { code, message, detail } };
}

/**
 * The statuses this system refuses with.
 *
 * One union rather than one per service. 413 is in it because "too big" and
 * "wrong state" are genuinely different answers and collapsing the first into a
 * 409 is the kind of thing this codebase refuses elsewhere. Safe in both
 * directions on the client: the route memo keys on the *code* rather than the
 * status, and the replay whitelist is `GET`/`DELETE`, so a 413 on a POST is
 * never re-sent.
 *
 * 429 joins it for the same shape of reason: a throttled login is a refusal that
 * *expires*, and the only other honest status for it would be 403, which says the
 * opposite. A client that cannot tell them apart shows "wrong password" to
 * somebody whose password is right and who only has to wait — and, worse, retries
 * into the throttle that is already refusing them. It carries `Retry-After`.
 */
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

/**
 * The credential out of an `Authorization` header, or `null` if there was none.
 *
 * The two answers are deliberately different: **a present-but-malformed header
 * is `""`, not `null`.** That distinction is the whole point — it used to fall
 * through to the `?token=` query whenever the header was not exactly `Bearer `,
 * so `authorization: bearer x` (which some clients send) took the no-header path
 * and was reported as a *missing* token rather than a rejected one. A caller
 * that wants the query fallback must therefore test `=== null` and never
 * falsiness.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is; the
 * credential after it is not touched.
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  return /^Bearer +(.*)$/i.exec(header.trim())?.[1]?.trim() ?? "";
}

/**
 * A JSON *object* body, or `null` for anything else.
 *
 * An array and a bare scalar are both `null` rather than passed through, because
 * every caller then indexes the result by key and would read `undefined` off a
 * shape the sender never meant as a record.
 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A caller-supplied integer, bounded, falling back rather than refusing.
 *
 * `Number.isInteger` rather than `Number.isFinite`, which is what one of the two
 * originals used: they agree on every `parseInt` output (it yields an integer or
 * `NaN`, never a fraction or an infinity), and the stricter one says what is
 * actually meant.
 */
export function boundedInt(raw: string | undefined, fallback: number, max = Number.POSITIVE_INFINITY): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * A message out of something thrown.
 *
 * `describeError` rather than `describe`: this codebase already has two other
 * `describe`s meaning different things — a `DirEntry` builder in `browse.ts` and
 * a launch-config lookup in `runtime/local.ts` — and a bare `describe` here
 * shadowed the first and was shadowed by the second.
 *
 * Trivial, and worth one home anyway: it had four identical private declarations
 * and seventeen inline copies of the same ternary. Nothing in `src/` prints, so
 * every one of those fed a callback or an error envelope.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
