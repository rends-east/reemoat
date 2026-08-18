import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { TUNNEL_PATH } from "../../../../src/relay/protocol.js";
import { startPresenceFlush, type PresenceWriter } from "./presence.js";
import { createRelayProxy } from "./proxy.js";
import type { TunnelRegistry } from "./registry.js";
import { createTunnelEndpoint } from "./tunnel-endpoint.js";

/**
 * The relay's listener, in one place because there are two entry points now.
 *
 * `main.ts` still starts one in `embedded` mode — one process, exactly as it
 * always was, which is what keeps `pnpm cp` a single command and `relaycheck` an
 * offline driver — and `relay/main.ts` starts one as the whole of its job. Two
 * copies of this wiring would be two things to keep in agreement, and the
 * disagreement would show up as "the deployed relay behaves differently from the
 * one the driver exercises".
 */

/**
 * The relay's own health check, and it is **not** `/health`.
 *
 * That path belongs to the daemon on the other side of a tunnel: the browser
 * resolves a machine's route by fetching `<relayUrl>/health` with a token, so
 * intercepting it here would answer for the relay and report every machine in
 * the fleet as reachable — including the ones that are not connected at all.
 *
 * Under the prefix the relay already reserves, beside `TUNNEL_PATH`. There is no
 * credential on it, like both other services' `/health`, and it says nothing
 * about who is connected — a listener that is up, and nothing more.
 *
 * Deliberately declared here rather than in `src/relay/protocol.ts`: no daemon
 * ever sends this path, so it is not shared vocabulary — and a change under
 * `src/` puts the *daemon* on `deploy.sh`'s restart list, which would mean
 * interrupting every live session in the fleet to ship a health route.
 */
export const RELAY_HEALTH_PATH = "/__relay/health";

export interface RelayListenerOptions {
  db: DatabaseSync;
  issuer: string;
  host: string;
  port: number;
  registry: TunnelRegistry;
  /** Where tunnel presence is mirrored, or nothing to keep it in memory alone. */
  presence?: PresenceWriter | null;
  onEvent?: (event: string, detail: string) => void;
  /** Seam for `relaycheck`: how long a daemon may hold a request. See `proxy.ts`. */
  upstreamTimeoutMs?: number;
  /**
   * What to do when the listener cannot bind.
   *
   * A callback rather than an `exit(2)` in here, because the two entry points
   * have genuinely different remedies to print: one of them has already started
   * an API listener and possibly printed a one-time admin key.
   */
  onListenError?: (error: NodeJS.ErrnoException) => void;
}

export interface RelayListener {
  /** The bound port, or 0 before `listening` fires. Useful to a driver on port 0. */
  readonly server: Server;
  close(): void;
}

export function createRelayListener(options: RelayListenerOptions): RelayListener {
  const { db, issuer, host, port, registry } = options;
  const presence = options.presence ?? null;
  const onEvent = options.onEvent ?? ((): void => {});

  const proxy = createRelayProxy({ db, issuer, registry, onEvent, upstreamTimeoutMs: options.upstreamTimeoutMs });
  const endpoint = createTunnelEndpoint({ db, registry, onEvent });
  // Prepared once, for `presence.ts`'s reason: this runs on the event loop that
  // carries every tunnel, and a healthcheck every 15s is not a place to compile
  // SQL.
  const healthRead = db.prepare("SELECT 1 AS ok FROM signing_keys LIMIT 1");

  const server = createServer((req, res) => {
    const path = pathOf(req.url);
    // The one path the relay keeps. A non-upgrade request to it is a daemon that
    // failed to ask for an upgrade, not something to forward to one.
    if (path === TUNNEL_PATH) {
      res.writeHead(426, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "upgrade_required", message: "this endpoint expects a WebSocket upgrade" } }),
      );
      return;
    }
    if (path === RELAY_HEALTH_PATH) {
      /*
       * Before `proxy.handleRequest`, so it never reaches `authorize` and never
       * needs a token — this is what a supervisor and a healthcheck probe.
       *
       * It answered a literal, which meant it could not go red. A relay that
       * cannot read `signing_keys` cannot verify a single token and refuses the
       * whole fleet with 401, and this route said `ok: true` throughout — so
       * compose's healthcheck stayed green over a relay that was authorizing
       * nothing. One indexed read against the one table `authorize.ts` needs
       * fixes that, and **absence is not failure**: on a first boot this process
       * may create the schema before the API has minted a key, which
       * `compose.yml` documents as expected, so only a throw is unhealthy.
       *
       * What it still does **not** say is who is connected. That is deliberate
       * and unchanged — there is no credential on this path, and a tunnel count
       * here would be an unauthenticated read of how much of the fleet is online.
       *
       * **And it does not say what went wrong, either.** `database` carried
       * `error.message`, and `node:sqlite` writes the absolute path of the
       * database file into its messages — so this route handed the host's disk
       * layout to anybody who asked, at exactly the moment something was broken.
       * The token goes on the wire and the text goes to `onEvent`, which is where
       * everything else in the relay reports and the only place an operator is
       * meant to read one.
       */
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
    if (pathOf(req.url) === TUNNEL_PATH) return endpoint.handleUpgrade(req, socket, head);
    return proxy.handleUpgrade(req, socket, head);
  });

  // A dead client socket must never reach the top level as an unhandled 'error'.
  server.on("clientError", (_error, socket) => socket.destroy());

  if (options.onListenError) server.on("error", options.onListenError);

  /*
   * The presence flush, started with the listener and stopped with it.
   *
   * Here rather than in either entry point because it is part of what a running
   * relay *is*: the rows it writes are the only way anything outside this
   * process can see the map inside it, and a listener whose rows stop being
   * stamped reads as a relay carrying nothing.
   */
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
