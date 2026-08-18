import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { corsHeaders } from "../../../../src/cors.js";
import { RELAY_HEADER_PREFIX } from "../../../../src/relay/protocol.js";
import { bearerToken } from "../../../../src/http.js";
import { createRelayAuthorizer } from "./authorize.js";
import type { TunnelRegistry } from "./registry.js";

/**
 * The browser-facing half of the relay.
 *
 * Every request is authorized, then forwarded down the tunnel belonging to the
 * machine named by the token's `aud`. Both steps are here and in that order:
 * **nothing reaches a tunnel before the grant check passes.**
 *
 * The forwarding itself is deliberately dull. A CONNECT stream is a byte pipe, so
 * `http.request({createConnection: () => stream})` lets Node serialize the
 * request, decide chunked-versus-content-length, and raise `upgrade` for a 101 —
 * all the HTTP/1.1 detail we would otherwise be hand-writing and getting subtly
 * wrong. Verified against a real daemon-shaped server for both an ordinary
 * request and a WebSocket upgrade.
 *
 * The daemon re-verifies the caller's token when the request arrives, because the
 * request arrives at its real listener carrying the caller's real credentials.
 * The check here is additive; the relay is never trusted to have done it.
 */

export interface RelayProxyOptions {
  db: DatabaseSync;
  issuer: string;
  registry: TunnelRegistry;
  onEvent?: (event: string, detail: string) => void;
  /**
   * How long a daemon may hold a proxied request without answering.
   *
   * A seam rather than a constant only, for the reason `SmtpDialer` and
   * `AgentProcess` are seams: the behaviour is a two-minute wait, and a driver
   * that had to spend two minutes to see it would not assert it at all. See
   * {@link UPSTREAM_IDLE_TIMEOUT_MS} for why the real number is what it is.
   */
  upstreamTimeoutMs?: number;
}

export interface RelayProxy {
  handleRequest(req: IncomingMessage, res: ServerResponse): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * How long a daemon may hold a proxied request without answering.
 *
 * ⚠ **There was no bound here at all.** A tunnel that accepts a CONNECT stream
 * and then says nothing held the browser until its own socket closed, and held
 * one of `MAX_CONCURRENT_STREAMS` on that tunnel for the same length of time —
 * which on a daemon wedged behind a stalled filesystem call is until somebody
 * restarts it. Nothing else covered it: `res.on("close")` fires when the *client*
 * gives up, and the tunnel's ping tick proves the socket is alive, which is
 * exactly the state this is about.
 *
 * 120 s rather than something tighter, because the slowest legitimate request is
 * a real one: `POST /sessions` starts an agent and the web client already allows
 * 90 s for it, `worktree add` runs the repository's own hooks and LFS filters on
 * a 120 s budget, and refusing at 30 s would break creating a session on a large
 * repository. This is the "nobody is ever coming back" bound, not a latency
 * budget — the client's own 15 s and 90 s deadlines are that.
 *
 * **Post-authorization availability only**, so it is deliberately not a defence
 * against anything: a caller who can open a stream already holds a grant.
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Headers that describe *this* hop and must not be forwarded to the next one.
 *
 * `upgrade` and `connection` are in the list but re-added deliberately on the
 * upgrade path — there they are the message, not metadata about the connection.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function createRelayProxy(options: RelayProxyOptions): RelayProxy {
  const { db, registry } = options;
  const onEvent = options.onEvent ?? ((): void => {});
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  const authorizer = createRelayAuthorizer(db, options.issuer);

  return {
    handleRequest(req, res) {
      /*
       * A CORS preflight, answered here and never forwarded.
       *
       * This is not a shortcut, it is the only thing that can happen: a preflight
       * carries no `Authorization` header and no `?token=` by specification, so
       * there is no `aud` to read, so there is no machine to route it to. The
       * alternative to answering it is refusing every browser.
       *
       * It opens no stream and does not touch `requestsProxied` — the existing
       * rule that a request which never reached a tunnel must not move that
       * counter applies here exactly as it does to a refusal, and for the same
       * reason: the counter is how "the client went direct" stays a measurement.
       */
      if (isPreflight(req)) {
        res.writeHead(204, { ...corsHeaders(), "content-length": 0 });
        res.end();
        return;
      }

      const auth = authorizer.authorize(readToken(req));
      if (!auth.ok) {
        onEvent("proxy_refused", `${auth.code} ${req.method ?? "?"} ${pathOf(req)}`);
        return sendJson(res, auth.status, { error: { code: auth.code, message: auth.message, detail: null } });
      }

      const tunnel = registry.get(auth.machineId);
      if (tunnel === null) return sendNoTunnel(res, auth.machineId);

      const stream = tunnel.open(auth.subject);
      if (stream === null) return sendNoTunnel(res, auth.machineId);

      const upstream = httpRequest(
        {
          createConnection: () => stream,
          method: req.method,
          path: req.url,
          headers: forwardHeaders(req, false),
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, stripHopByHop(upRes.headers));
          /*
           * ⚠ **`pipe` forwards `end` and never a premature close.**
           *
           * Without these two lines an upstream that dies *after* the response
           * has started left `res` open for ever, holding a browser against a
           * `content-length` promising bytes nobody was going to send. Every
           * mid-body death did it — the idle bound below, a tunnel drop, a
           * daemon killed mid-answer — and the client had no failure to react
           * to, so `isReplayable`'s retry never got its turn. Measured: a
           * half-answering daemon behind a 2s bound still had the client waiting
           * at 12s. Q6.103.
           *
           * `complete` rather than the `aborted` event: it is the undeprecated
           * check and the wider one, catching an upstream that closes *short of
           * its own `content-length`* without erroring at all — which would
           * otherwise hand the client a truncated transcript as a whole one.
           */
          upRes.on("error", () => res.destroy());
          upRes.on("close", () => {
            if (!upRes.complete) res.destroy();
          });
          upRes.pipe(res);
        },
      );

      /*
       * A daemon that took the stream and never answered, or stopped answering
       * partway through.
       *
       * **Destroyed with an error on purpose.** `ClientRequest.destroy()` with no
       * argument emits no `'error'`, so before the response starts it produced a
       * socket that merely stopped, and after `writeHead` it reached nothing at
       * all — the handler below is what closes `res`, and it was never called.
       * With the error it reports as `tunnel_failed` rather than inventing a
       * fourth code: from the client's side "the tunnel to this machine failed"
       * is exactly what happened.
       */
      upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error("upstream idle")));

      upstream.on("error", () => {
        // The tunnel died mid-request. A clean 502 so the client retries and
        // re-probes, rather than a socket that just stops.
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: { code: "tunnel_failed", message: "the tunnel to this machine failed mid-request", detail: null },
          });
        } else {
          res.destroy();
        }
        stream.destroy();
      });
      res.on("close", () => stream.destroy());

      req.pipe(upstream);
      req.on("error", () => upstream.destroy());
    },

    /**
     * The WebSocket path — `/sessions/:id/stream`.
     *
     * Nothing here knows it is a WebSocket. The tunnel carries bytes, so an
     * upgrade is an upgrade the same as it would be on the direct path; the relay
     * copies the 101 back and then gets out of the way. That is why "tunneling WS
     * inside WS" needed no special handling: it is not a case, it is the absence
     * of one.
     */
    handleUpgrade(req, socket, head) {
      /*
       * An error listener, before anything else can happen.
       *
       * Node removes its own `socketOnError` handler *before* emitting `upgrade`,
       * so between this line and the `socket.on("error")` inside the `upgrade`
       * callback below the socket would carry zero listeners — and an `'error'`
       * event with no listener is an uncaught exception, which takes down the
       * process holding the API, the relay, the web UI and every tunnel in the
       * fleet at once.
       *
       * The window is not theoretical and it is not short: authorizing, opening a
       * CONNECT stream, and waiting for the daemon to dial its own loopback
       * listener and answer 101 is a full tunnel round trip. A phone that leaves
       * Wi-Fi during it sends RST rather than FIN, which is exactly this event.
       * Measured: `upgrade seen; socket error listeners = 0` followed by
       * `Error: read ECONNRESET` and a non-zero exit.
       *
       * It is attached first rather than after `authorize` because the refusal
       * paths write to this socket too.
       */
      socket.on("error", () => socket.destroy());

      // A browser cannot set headers on a WebSocket, so the token arrives as a
      // query parameter here — exactly as the daemon's own `readCredential`
      // expects on the direct path.
      const auth = authorizer.authorize(readToken(req));
      if (!auth.ok) {
        onEvent("proxy_refused", `${auth.code} upgrade ${pathOf(req)}`);
        return refuseUpgrade(socket, auth.status, auth.code);
      }

      /*
       * Logged on this path too, matching `sendNoTunnel` on the request path.
       *
       * The WebSocket is the connection a phone actually holds, so a machine
       * whose tunnel is down is *most* visible here — and it was the one path
       * where the relay said nothing at all, which made "the daemon is asleep"
       * indistinguishable from "the relay is broken" in the log.
       */
      const tunnel = registry.get(auth.machineId);
      if (tunnel === null) {
        onEvent("proxy_no_tunnel", auth.machineId);
        return refuseUpgrade(socket, 503, "no_tunnel");
      }

      const stream = tunnel.open(auth.subject);
      if (stream === null) {
        onEvent("proxy_no_tunnel", `${auth.machineId} (stream limit)`);
        return refuseUpgrade(socket, 503, "no_tunnel");
      }

      const upstream = httpRequest({
        createConnection: () => stream,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req, true),
      });

      upstream.on("upgrade", (upRes, upSocket, upHead) => {
        const statusLine = `HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? "Switching Protocols"}`;
        const lines = [statusLine];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upHead.length > 0) socket.write(upHead);

        socket.on("error", () => upSocket.destroy());
        upSocket.on("error", () => socket.destroy());
        socket.pipe(upSocket);
        upSocket.pipe(socket);
      });

      // A daemon that answers an upgrade with an ordinary response — a 401 from
      // its own auth, say. Relay it verbatim; the client has to see its own
      // daemon's answer, not one this service invented.
      upstream.on("response", (upRes) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ""}`.trimEnd()];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        // The same premature-close hole as the request path, and it leaks the raw
        // client socket rather than a `ServerResponse`. Q6.103.
        upRes.on("error", () => socket.destroy());
        upRes.on("close", () => {
          if (!upRes.complete) socket.destroy();
        });
        upRes.pipe(socket);
      });

      /*
       * The same bound on the handshake, and **cleared the moment it completes**
       * — a WebSocket that sits quiet between events is healthy, which is the
       * distinction `tunnel.ts` draws with the same words about its loopback dial
       * timer. Left armed this would tear down every idle stream at two minutes.
       */
      upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy());
      upstream.once("upgrade", () => upstream.setTimeout(0));
      upstream.once("response", () => upstream.setTimeout(0));

      upstream.on("error", () => {
        refuseUpgrade(socket, 502, "tunnel_failed");
        stream.destroy();
      });
      socket.on("close", () => stream.destroy());

      // Bytes the client already sent past the request headers. Rare, but dropping
      // them silently corrupts the stream in a way that is very hard to find.
      if (head.length > 0) upstream.write(head);
      upstream.end();
    },
  };

  function sendNoTunnel(res: ServerResponse, machineId: string): void {
    onEvent("proxy_no_tunnel", machineId);
    /*
     * Refused immediately, never queued.
     *
     * Holding requests until a daemon reappears would turn a relay outage into a
     * relay memory leak — during precisely the incident it should be surviving.
     * The client drops its route belief on this code and re-probes; there is no
     * second path to fall back to, which is what the message says.
     */
    sendJson(res, 503, {
      error: {
        code: "no_tunnel",
        message:
          "this machine has no relay tunnel: its daemon is not running, or cannot dial out. " +
          "There is no other way in, so there is nothing else to try — it comes back on its own " +
          "when the daemon reconnects",
        detail: null,
      },
    });
  }
}

/**
 * A CORS preflight, rather than an `OPTIONS` somebody meant.
 *
 * Both conditions, because `OPTIONS` alone is a legitimate HTTP method a daemon
 * could one day answer for itself; `access-control-request-method` is what makes
 * it the browser's own question rather than the caller's. Getting this wrong in
 * the lenient direction would silently stop forwarding a method the daemon
 * supports.
 */
function isPreflight(req: IncomingMessage): boolean {
  return req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined;
}

/**
 * A request's path, with the query string dropped — safe to log.
 *
 * Never log `req.url` on either path. A browser cannot set headers on a
 * WebSocket, so the credential arrives as `?token=<JWS>`; interpolating the raw
 * URL into a log line writes a live bearer token to stderr, and from there to
 * journald or whatever ships the container's logs.
 *
 * The tokens on the refusal paths are the *worst* ones to leak, not the most
 * harmless. `no_scopes`, `machine_not_found` (a deleted grant or a revoked
 * machine), `user_disabled` and `machine_over_limit` all refuse tokens that are
 * cryptographically intact and unexpired — and the daemon never asks this service
 * anything, so such a token is still accepted on the direct path for the rest of
 * its lifetime. A revocation that stops working at the relay is precisely when
 * the token in the log becomes a working credential for whoever can read the log.
 * The fourth is the *most* reversible of them and therefore the likeliest to be
 * refused in bulk while somebody is watching the logs to find out why.
 *
 * `auth.code` says why it was refused, and `authorize` already returns `tokenId`
 * and `subject` for anyone who needs to identify the caller. None of those are
 * credentials.
 */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://relay").pathname;
  } catch {
    // An unparseable request target. There is nothing safe to quote from it, and
    // quoting it raw is the one thing this function exists to prevent.
    return "(unparseable)";
  }
}

/**
 * The caller's token: `Authorization: Bearer`, else `?token=`.
 *
 * The same rule as the daemon's `readCredential`, and it matters that it is the
 * same: a *present* header is authoritative even when malformed, rather than
 * falling through to the query parameter. Falling through means a client sending
 * `authorization: bearer x` — lowercase, which some send — silently takes a
 * different code path from the one it thinks it is on.
 */
function readToken(req: IncomingMessage): string | null {
  // `=== null` and not falsiness: `bearerToken` answers `""` for a present but
  // malformed header, and that must be refused rather than fall through to the
  // query — the same rule as the daemon's `readCredential`, and it matters that
  // it is the same, which is now true by construction rather than by copy.
  const fromHeader = bearerToken(req.headers.authorization);
  if (fromHeader !== null) return fromHeader;
  try {
    return new URL(req.url ?? "/", "http://relay").searchParams.get("token");
  } catch {
    /*
     * An unparseable request target, guarded for the same reason `pathOf` is —
     * and this is the copy that mattered, because this one runs *first*.
     *
     * llhttp and the WHATWG URL parser do not agree about what a request target
     * is. Measured: `GET //% HTTP/1.1` is accepted by Node's HTTP parser and
     * handed over as `req.url` verbatim, and `new URL("//%", "http://relay")`
     * throws `Invalid URL` (so do `/\` and `//[`). Unguarded, that throw escaped
     * the `'request'`/`'upgrade'` emit *before* `authorize`, so no credential was
     * needed to reach it: `main.ts`'s `uncaughtException` backstop kept the
     * process alive, and nothing wrote a response or destroyed the socket —
     * `requestTimeout` was already cleared and `keepAliveTimeout` only arms once
     * a response is sent. One unauthenticated line per leaked socket, against the
     * only ingress this system has, until the fd limit stops every daemon
     * dialling in and every browser reaching any machine.
     *
     * `null` rather than a throw puts it on the existing refusal path as
     * `401 missing_token`, which is the honest answer: there is no readable
     * credential here. `pathOf` logs `(unparseable)` beside it.
     */
    return null;
  }
}

function forwardHeaders(req: IncomingMessage, upgrade: boolean): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    // Everything in the relay's own namespace is relay-controlled. Dropping any
    // client-supplied copy is what stops `reemoat-sub` being forgeable — though
    // the reason it is *safe* is that the daemon re-verifies the real token and
    // never reads this for a decision.
    if (key.startsWith(RELAY_HEADER_PREFIX)) continue;
    if (value !== undefined) out[key] = value;
  }

  if (upgrade) {
    out["connection"] = "Upgrade";
    out["upgrade"] = req.headers.upgrade ?? "websocket";
  }

  const forwarded = req.socket.remoteAddress;
  if (forwarded !== undefined) {
    const existing = req.headers["x-forwarded-for"];
    out["x-forwarded-for"] = existing === undefined ? forwarded : `${String(existing)}, ${forwarded}`;
  }
  return out;
}

function stripHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The relay's own answers — refusals, `no_tunnel`, `tunnel_failed`.
 *
 * These carry CORS headers because they are the relay speaking, not the daemon:
 * nothing proxied ever reaches this function, and a response the browser cannot
 * read is one the client cannot distinguish from a network failure. That
 * distinction is the whole point of these codes — "this machine is asleep"
 * (`no_tunnel`) and "your token died" (`token_expired`) call for completely
 * different behaviour, and a client that sees neither will guess wrong.
 *
 * Proxied responses are untouched: they arrive with the daemon's own CORS headers
 * and pass through `stripHopByHop`, which is not in this path.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** No WebSocket exists yet, so the refusal is a status line on the raw socket. */
function refuseUpgrade(socket: Duplex, status: number, code: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\n\r\n`);
  } catch {
    // Peer already gone.
  }
  socket.destroy();
}
