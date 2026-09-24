import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { corsHeaders } from "../../../../src/cors.js";
import { MAX_TUNNEL_MESSAGE_BYTES, STREAM_ENCRYPTION_NOISE_IK } from "../../../../src/relay/protocol.js";
import { bearerToken } from "../../../../src/http.js";
import { createRelayAuthorizer } from "./authorize.js";
import type { TunnelRegistry } from "./registry.js";

// Nothing reaches a tunnel before the grant check passes; the daemon re-verifies the token regardless.

export interface RelayProxyOptions {
  db: DatabaseSync;
  issuer: string;
  registry: TunnelRegistry;
  onEvent?: (event: string, detail: string) => void;
  channelTimeoutMs?: number;
}

export interface RelayProxy {
  handleRequest(req: IncomingMessage, res: ServerResponse): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  handleChannel(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/** Bounds the wait for the daemon's 200, which comes before the WebSocket handshake; one h2 round trip, so short. */
const CHANNEL_OPEN_TIMEOUT_MS = 10_000;

/** A valve behind the real backpressure, for a socket that neither drains nor errors (a dead phone on a live connection). */
const MAX_CHANNEL_BUFFERED_BYTES = 8 * 1024 * 1024;

export function createRelayProxy(options: RelayProxyOptions): RelayProxy {
  const { db, registry } = options;
  const onEvent = options.onEvent ?? ((): void => {});
  const channelTimeoutMs = options.channelTimeoutMs ?? CHANNEL_OPEN_TIMEOUT_MS;
  const authorizer = createRelayAuthorizer(db, options.issuer);
  const channels = new WebSocketServer({ noServer: true, maxPayload: MAX_TUNNEL_MESSAGE_BYTES });

  return {
    /** Plaintext proxying is retired: refused with 426, and not authorized first because no credential makes this path work. */
    handleRequest(req, res) {
      onEvent("proxy_retired", `${req.method ?? "?"} ${pathOf(req)}`);
      sendJson(res, 426, {
        error: {
          code: "upgrade_required",
          message:
            "this relay carries encrypted channels only: open a WebSocket to /__relay/channel. " +
            "A plaintext request cannot be proxied to a daemon any more, by design — the relay " +
            "is not able to read what it carries",
          detail: null,
        },
      });
    },

    handleUpgrade(req, socket, _head) {
      socket.on("error", () => socket.destroy());
      onEvent("proxy_retired", `upgrade ${pathOf(req)}`);
      refuseUpgrade(socket, 426, "upgrade_required");
    },

    /** Authorize, then splice bytes between app and daemon; this process holds no key for the Noise channel inside. */
    handleChannel(req, socket, head) {
      // First: Node has already removed its own socketOnError, and every refusal below writes to this socket.
      socket.on("error", () => socket.destroy());

      const auth = authorizer.authorize(readToken(req));
      if (!auth.ok) {
        onEvent("channel_refused", `${auth.code} ${pathOf(req)}`);
        return refuseUpgrade(socket, auth.status, auth.code);
      }

      const tunnel = registry.get(auth.machineId);
      if (tunnel === null) {
        onEvent("channel_no_tunnel", auth.machineId);
        return refuseUpgrade(socket, 503, "no_tunnel");
      }

      const stream = tunnel.open(auth.subject, STREAM_ENCRYPTION_NOISE_IK);
      if (stream === null) {
        onEvent("channel_no_tunnel", `${auth.machineId} (stream limit)`);
        return refuseUpgrade(socket, 503, "no_tunnel");
      }

      // Upgrade only after the daemon's 200: an old daemon's 501 after the upgrade would look like a network drop and be retried for ever.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.destroy();
        onEvent("channel_timeout", auth.machineId);
        refuseUpgrade(socket, 504, "tunnel_timeout");
      }, channelTimeoutMs);
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };

      stream.once("error", () => {
        if (!settle()) return socket.destroy();
        onEvent("channel_failed", auth.machineId);
        refuseUpgrade(socket, 502, "tunnel_failed");
      });

      stream.once("response", (headers) => {
        if (!settle()) return;
        const status = Number(headers[":status"] ?? 0);
        if (status !== 200) {
          stream.destroy();
          onEvent("channel_unsupported", `${auth.machineId} answered ${String(status)}`);
          return refuseUpgrade(socket, 501, "encryption_unsupported");
        }

        channels.handleUpgrade(req, socket, head, (ws) => {
          const carrier = createWebSocketStream(ws);

          const valve = setInterval(() => {
            if (ws.bufferedAmount > MAX_CHANNEL_BUFFERED_BYTES) {
              onEvent("channel_backpressure", `${auth.machineId} ${String(ws.bufferedAmount)} bytes`);
              ws.terminate();
            }
          }, 1_000);
          valve.unref();

          const done = (): void => {
            clearInterval(valve);
            carrier.destroy();
            stream.destroy();
          };

          // Both directions and nothing between: no forwardHeaders step, because the relay cannot read what it carries (Q5.10).
          carrier.pipe(stream);
          stream.pipe(carrier);

          carrier.on("error", done);
          stream.on("error", done);
          stream.on("close", done);
          ws.on("close", done);
          onEvent("channel_open", auth.machineId);
        });
      });
    },
  };
}

/** Never log req.url: a WebSocket carries its token as ?token=, and a token refused here may still work at the daemon. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://relay").pathname;
  } catch {
    // Nothing safe to quote from an unparseable target.
    return "(unparseable)";
  }
}

function readToken(req: IncomingMessage): string | null {
  // Compared with null, not falsiness: a present but malformed header yields an empty string and must be refused, as in readCredential.
  const fromHeader = bearerToken(req.headers.authorization);
  if (fromHeader !== null) return fromHeader;
  try {
    return new URL(req.url ?? "/", "http://relay").searchParams.get("token");
  } catch {
    // Must not throw: this runs before authorize, and a throw leaks the socket because requestTimeout is already cleared. null answers 401.
    return null;
  }
}

/** Carries CORS headers so the browser can read the relay's own refusal codes. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function refuseUpgrade(socket: Duplex, status: number, code: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\n\r\n`);
  } catch {
    // Peer already gone.
  }
  socket.destroy();
}
