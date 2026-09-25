import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { TUNNEL_PATH } from "../../../../src/relay/protocol.js";
import { startPresenceFlush, type PresenceWriter } from "./presence.js";
import { createRelayProxy, type SiblingRelays } from "./proxy.js";
import type { TunnelRegistry } from "./registry.js";
import { createTunnelEndpoint } from "./tunnel-endpoint.js";

/** Not /health, which belongs to the daemon behind a tunnel. Declared outside src/ so shipping it never restarts the daemon. */
export const RELAY_HEALTH_PATH = "/__relay/health";

/** Encrypted channel: authorized like a proxied request, then spliced as opaque bytes. The app keeps a copy that webcheck compares. */
export const RELAY_CHANNEL_PATH = "/__relay/channel";

export interface RelayListenerOptions {
  db: DatabaseSync;
  issuer: string;
  host: string;
  port: number;
  registry: TunnelRegistry;
  presence?: PresenceWriter | null;
  onEvent?: (event: string, detail: string) => void;
  channelTimeoutMs?: number;
  siblings?: SiblingRelays | null;
  /** A callback, because each entry point prints a different remedy. */
  onListenError?: (error: NodeJS.ErrnoException) => void;
}

export interface RelayListener {
  readonly server: Server;
  close(): void;
}

export function createRelayListener(options: RelayListenerOptions): RelayListener {
  const { db, issuer, host, port, registry } = options;
  const presence = options.presence ?? null;
  const onEvent = options.onEvent ?? ((): void => {});

  const proxy = createRelayProxy({
    db,
    issuer,
    registry,
    onEvent,
    channelTimeoutMs: options.channelTimeoutMs,
    siblings: options.siblings ?? null,
  });
  const endpoint = createTunnelEndpoint({ db, registry, onEvent });
  const healthRead = db.prepare("SELECT 1 AS ok FROM signing_keys LIMIT 1");

  const server = createServer((req, res) => {
    const path = pathOf(req.url);
    // A non-upgrade request here is a daemon that failed to upgrade; it is never forwarded.
    if (path === TUNNEL_PATH) {
      res.writeHead(426, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "upgrade_required", message: "this endpoint expects a WebSocket upgrade" } }),
      );
      return;
    }
    if (path === RELAY_HEALTH_PATH) {
      // Unauthenticated, so it names no tunnels and no error text (node:sqlite messages carry the database path).
      // Only a throw is unhealthy: on a first boot signing_keys may still be empty.
      let database = "ok";
      try {
        healthRead.get();
      } catch (error) {
        database = "unavailable";
        onEvent("relay_health_read_failed", error instanceof Error ? error.message : String(error));
      }
      const ok = database === "ok";
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok, service: "relay", database }));
      return;
    }
    proxy.handleRequest(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const path = pathOf(req.url);
    if (path === TUNNEL_PATH) return endpoint.handleUpgrade(req, socket, head);
    // Spliced, not proxied: the bytes on it are not HTTP.
    if (path === RELAY_CHANNEL_PATH) return proxy.handleChannel(req, socket, head);
    return proxy.handleUpgrade(req, socket, head);
  });

  // A dead client socket must never reach the top level as an unhandled 'error'.
  server.on("clientError", (_error, socket) => socket.destroy());

  if (options.onListenError) server.on("error", options.onListenError);

  const stopFlush = presence === null ? (): void => {} : startPresenceFlush(presence, registry);

  server.listen(port, host);

  return {
    server,
    close() {
      stopFlush();
      endpoint.close();
      server.close();
    },
  };
}

function pathOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://relay").pathname;
  } catch {
    return "/";
  }
}
