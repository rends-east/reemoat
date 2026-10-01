import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { corsHeaders } from "../../../../src/cors.js";
import {
  LINK_CONNECT_BURST,
  LINK_CONNECT_REFILL_MS,
  MAX_TUNNEL_MESSAGE_BYTES,
  RELAY_URL_HEADER,
  STREAM_ENCRYPTION_NOISE_IK,
} from "../../../../src/relay/protocol.js";
import { bearerToken } from "../../../../src/http.js";
import { createRelayAuthorizer } from "./authorize.js";
import type { RelayView, TunnelRegistry } from "./registry.js";
import type { RelayUrlMap } from "./routing.js";

// Nothing reaches a tunnel before the grant check passes; the daemon re-verifies the token regardless.

export interface RelayProxyOptions {
  db: DatabaseSync;
  issuer: string;
  registry: TunnelRegistry;
  onEvent?: (event: string, detail: string) => void;
  channelTimeoutMs?: number;
  /** Absent, a tunnel this relay does not hold is a 503; present, one a named sibling holds is a 421 naming where. */
  siblings?: SiblingRelays | null;
}

export interface SiblingRelays {
  /** Presence as rows, which is the only place another relay's tunnels are visible from here. */
  view: RelayView;
  urls: RelayUrlMap;
  /** This relay's own slot: a row naming it is a tunnel that has just gone, never a sibling. */
  relayId: string;
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
  const linkOpens = new LinkConnectBudget();
  const siblings = options.siblings ?? null;

  const siblingUrlFor = (machineId: string): string | null => {
    if (siblings === null) return null;
    const slot = siblings.view.relayFor(machineId);
    if (slot === null || slot === siblings.relayId || !Object.hasOwn(siblings.urls, slot)) return null;
    const url = siblings.urls[slot]!;
    // Written into a raw status line below, so anything but visible ASCII is not a URL worth sending.
    return /^[\x21-\x7e]+$/.test(url) ? url : null;
  };

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

      // Spent before the tunnel is looked up, so a link hammering a machine that is offline is bounded too.
      if (auth.limiter.link && !linkOpens.take(auth.limiter.key)) {
        onEvent("channel_rate_limited", `${auth.machineId} ${auth.limiter.key}`);
        return refuseUpgrade(socket, 429, "link_rate_limited", {
          "retry-after": String(Math.ceil(LINK_CONNECT_REFILL_MS / 1000)),
        });
      }

      const tunnel = registry.get(auth.machineId);
      if (tunnel === null) {
        // Only after authorize: where a machine's tunnel is would otherwise be answered to anyone holding any token.
        const elsewhere = siblingUrlFor(auth.machineId);
        if (elsewhere !== null) {
          onEvent("channel_wrong_relay", auth.machineId);
          return refuseUpgrade(socket, 421, "wrong_relay", { [RELAY_URL_HEADER]: elsewhere });
        }
        onEvent("channel_no_tunnel", auth.machineId);
        return refuseUpgrade(socket, 503, "no_tunnel");
      }

      const stream = tunnel.open(auth.subject, auth.limiter, STREAM_ENCRYPTION_NOISE_IK);
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

function refuseUpgrade(socket: Duplex, status: number, code: string, headers: Record<string, string> = {}): void {
  const extra = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  try {
    socket.write(`HTTP/1.1 ${status} ${code}\r\n${extra}Connection: close\r\n\r\n`);
  } catch {
    // Peer already gone.
  }
  socket.destroy();
}

/** How often a take sweeps buckets that have refilled, which are then the same as absent ones. */
const LINK_BUDGET_SWEEP_EVERY = 256;

/** A token bucket per link: LINK_CONNECT_BURST opens, then one per LINK_CONNECT_REFILL_MS. Keyed on the link, so its owner is never charged. */
export class LinkConnectBudget {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private takes = 0;

  take(key: string, now: number = Date.now()): boolean {
    this.takes += 1;
    if (this.takes % LINK_BUDGET_SWEEP_EVERY === 0) this.sweep(now);
    const tokens = this.available(key, now);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private available(key: string, now: number): number {
    const held = this.buckets.get(key);
    if (held === undefined) return LINK_CONNECT_BURST;
    // max(0, …): a clock stepped backwards refills nothing rather than draining the bucket.
    const refilled = Math.max(0, now - held.at) / LINK_CONNECT_REFILL_MS;
    return Math.min(LINK_CONNECT_BURST, held.tokens + refilled);
  }

  private sweep(now: number): void {
    for (const key of [...this.buckets.keys()]) {
      if (this.available(key, now) >= LINK_CONNECT_BURST) this.buckets.delete(key);
    }
  }
}
