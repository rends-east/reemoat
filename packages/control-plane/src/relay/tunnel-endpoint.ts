import type { IncomingMessage } from "node:http";
import { connect as h2connect } from "node:http2";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import { bearerToken } from "../../../../src/http.js";
import {
  CLOSE_TUNNEL_BACKPRESSURE,
  CLOSE_TUNNEL_SUPERSEDED,
  CONNECTION_WINDOW_BYTES,
  DAEMON_VERSION_HEADER,
  MAX_CONCURRENT_STREAMS,
  MAX_TUNNEL_BUFFERED_BYTES,
  MAX_TUNNEL_MESSAGE_BYTES,
  PRE_NEGOTIATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_MIN_VERSION,
  RELAY_PROTOCOL_VERSION,
  STREAM_WINDOW_BYTES,
  TUNNEL_AGREED_VERSION_HEADER,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MISSES,
  TUNNEL_AUTH_HEADER,
  TUNNEL_VERSION_HEADER,
  negotiateProtocolVersion,
} from "../../../../src/relay/protocol.js";
import { recordDaemonBuild, readDaemonVersionHeader } from "../machines.js";
import { resolveTunnelKey } from "../keys.js";
import { machineStanding } from "../quota.js";
import { RelayTunnel, type TunnelRegistry } from "./registry.js";

/**
 * Where a daemon dials in.
 *
 * One WebSocket per daemon, held open for as long as the daemon lives, carrying
 * an HTTP/2 session. Every browser connection to that daemon is one h2 CONNECT
 * stream inside it.
 *
 * The direction is the whole point: the daemon dials *out*, so nothing needs to
 * be reachable on the customer's network. The relay is the h2 client even though
 * it is the TCP server, because it is the relay that opens streams.
 */

export interface TunnelEndpointOptions {
  db: DatabaseSync;
  registry: TunnelRegistry;
  onEvent?: (event: string, detail: string) => void;
}

export interface TunnelEndpoint {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export function createTunnelEndpoint(options: TunnelEndpointOptions): TunnelEndpoint {
  const { db, registry } = options;
  const onEvent = options.onEvent ?? ((): void => {});
  /*
   * `maxPayload` is the one inbound bound in this file, and everything else that
   * looks like one is above the ws layer — see `MAX_TUNNEL_MESSAGE_BYTES`. Left
   * unset, `ws` defaults to 100 MiB per message and a daemon that never sets FIN
   * parks that much in a process holding every tunnel in the fleet.
   */
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_TUNNEL_MESSAGE_BYTES,
  });

  /*
   * Tell the daemon what was agreed, on the 101 itself.
   *
   * `ws` writes the handshake response, and this event is the one place a header
   * can be added to it. Recomputed from the request rather than carried out of
   * `handleUpgrade` in a variable: this fires once per handshake with that
   * handshake's request, so recomputing is exact, and threading state between the
   * two would be a map keyed on a socket for no gain.
   *
   * A daemon that ignores it is not broken — with one version in existence the
   * answer is always the number it offered. It matters at two.
   */
  wss.on("headers", (headers, request) => {
    const offered = request.headers[TUNNEL_VERSION_HEADER];
    const agreed = negotiateProtocolVersion(
      offered === undefined ? PRE_NEGOTIATION_PROTOCOL_VERSION : Number(offered),
    );
    if (agreed !== null) headers.push(`${TUNNEL_AGREED_VERSION_HEADER}: ${agreed}`);
  });

  return {
    handleUpgrade(req, socket, head) {
      /*
       * Authenticated *before* the handshake completes, not after.
       *
       * A caller with no credential never gets a WebSocket at all, so there is no
       * window in which an unauthenticated peer holds a live socket on this
       * process. It also means the failure is an ordinary HTTP status the daemon
       * can log plainly, rather than a close code it has to have a table for.
       * The 4xxx close codes are for conditions that arise *after* a tunnel is
       * established, where a status line is no longer available.
       */
      /*
       * The protocol version, negotiated rather than matched.
       *
       * ⚠ This was `String(version) !== String(RELAY_PROTOCOL_VERSION)`, and that
       * one line made every future protocol bump a **flag day**: a relay moved to
       * v2 refused every v1 daemon in the fleet, and the relay is the only way in,
       * so refusing them is not degradation, it is the fleet switched off until
       * the last laptop is updated by hand. `negotiateProtocolVersion` takes the
       * newest both ends know instead — so a daemon ahead of this relay is
       * negotiated down and keeps working, and one behind keeps working until the
       * floor is deliberately raised past it.
       *
       * A missing header is read as v1 — `PRE_NEGOTIATION_PROTOCOL_VERSION`, the
       * literal, and **not** `RELAY_PROTOCOL_MIN_VERSION`. Only a daemon that
       * predates this header omits it, and that daemon speaks v1 by definition;
       * the floor is a number this build moves. They are equal today and diverge
       * at exactly the moment the floor is raised, which is the moment a
       * pre-header daemon must be refused rather than promoted to a version it
       * has never heard of. See that constant's docblock.
       */
      const version = req.headers[TUNNEL_VERSION_HEADER];
      const offered = version === undefined ? PRE_NEGOTIATION_PROTOCOL_VERSION : Number(version);
      const agreed = negotiateProtocolVersion(offered);
      if (agreed === null) {
        onEvent(
          "tunnel_rejected",
          `unsupported protocol version ${String(version ?? "(none)")}; ` +
            `this relay speaks v${RELAY_PROTOCOL_MIN_VERSION}-v${RELAY_PROTOCOL_VERSION}`,
        );
        return refuse(socket, 426, "Upgrade Required");
      }

      const presented = bearerToken(req.headers[TUNNEL_AUTH_HEADER]);
      if (presented === null || presented.length === 0) {
        onEvent("tunnel_rejected", "no tunnel credential");
        return refuse(socket, 401, "Unauthorized");
      }

      /*
       * The machine id comes out of this lookup. It is never read from the
       * request, because there is nothing in the request to read it from — no
       * header, no query parameter, no handshake field names a machine. A daemon
       * that wants to be machine B has to hold machine B's credential.
       */
      const machineId = resolveTunnelKey(db, presented);
      if (machineId === null) {
        onEvent("tunnel_rejected", "unknown or revoked tunnel credential");
        return refuse(socket, 401, "Unauthorized");
      }

      /*
       * Over its owner's machine limit, so it does not get a tunnel.
       *
       * Checked here rather than inside `resolveTunnelKey`, whose whole claim is
       * the paragraph above — the machine id is an *output* of that function and
       * nothing in the request names a machine. Folding a settings read and two
       * joins into it would dilute the one sentence it exists to make.
       *
       * **Refused rather than allowed to hold a tunnel that carries nothing**,
       * and the deciding reason is that `relayOnline` would otherwise be a lie.
       * That field is read by `POST /v1/tokens` and by `GET /v1/machines`, so a
       * machine holding a tunnel and answering 403 to every proxied request
       * presents as *online and broken* — indistinguishable from a bug in the
       * relay or the daemon. Refused at dial it is `relayOnline: false`, which
       * every client already draws and explains, plus `overLimit: true`, which
       * is what turns "asleep" into "switched off, and here is why".
       *
       * The daemon's own 1s→30s full-jitter backoff then becomes the recovery
       * mechanism rather than a cost: raise the limit and it reappears with
       * nobody touching the host. That is the difference between this and a
       * revoke, and it is why suspension can be reversible at all.
       *
       * 403 rather than 401 so the daemon's log distinguishes it — 401 means the
       * credential is wrong, which invites a re-enrollment that would not help.
       */
      const standing = machineStanding(db, machineId);
      if (standing !== null && (standing.over || standing.ownerDisabled)) {
        // Both gates, one refusal: a daemon has nothing to do differently about
        // them, and the distinction is for the *person*, who reads it on a
        // screen rather than in this log line.
        onEvent(
          "tunnel_rejected",
          standing.ownerDisabled
            ? `${machineId} belongs to a disabled user`
            : `${machineId} is over its owner's machine limit`,
        );
        return refuse(socket, 403, "Forbidden");
      }

      /*
       * What build just dialled in, recorded against the machine.
       *
       * Best-effort and wrapped, like every other write on this path: this is the
       * inventory a staged rollout is planned from, and losing a row costs a stale
       * answer to "what is out there", where throwing would cost the tunnel. It is
       * written here — after the credential resolved a machine id, before the
       * handshake completes — so a refused dial records nothing.
       */
      recordDaemonBuild(db, machineId, {
        daemonVersion: readDaemonVersionHeader(req.headers[DAEMON_VERSION_HEADER]),
        protocolVersion: agreed,
        at: Date.now(),
      });

      wss.handleUpgrade(req, socket, head, (ws) => {
        attach(ws, machineId, agreed);
      });
    },

    close() {
      registry.closeAll(CLOSE_TUNNEL_SUPERSEDED, "relay shutting down");
      wss.close();
    },
  };

  /**
   * `protocolVersion` is what this handshake **negotiated**, not what this build
   * speaks. It is carried rather than recomputed because it is the number every
   * stream down this tunnel must be stamped with, and the daemon refuses any
   * stream that disagrees with what it was told on the 101.
   */
  function attach(ws: WebSocket, machineId: string, protocolVersion: number): void {
    // Binary, no compression: this carries h2 frames, which are already framed
    // and mostly incompressible. perMessageDeflate would add CPU and latency to
    // every event for nothing.
    ws.binaryType = "nodebuffer";

    const duplex = createWebSocketStream(ws);
    // Never fatal to the process. A tunnel dying is routine; the daemon reconnects.
    duplex.on("error", () => ws.terminate());

    const session = h2connect("http://tunnel", {
      createConnection: () => duplex,
      settings: {
        // Our receive window per stream — this is the flow control for the
        // daemon-to-browser direction, which is the one that carries event
        // streams and therefore the one that matters. Credit is granted on
        // consumption, so a browser that stops reading stops the daemon writing.
        initialWindowSize: STREAM_WINDOW_BYTES,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      },
    });

    /*
     * The connection-level window, which is separate from the per-stream ones and
     * defaults to 64 KiB.
     *
     * Left at the default it becomes the real bottleneck: it is shared by every
     * stream on the tunnel, and it too is only replenished on consumption, so a
     * few stalled browsers would hold it all and slow the healthy ones. Sized as
     * `CONNECTION_WINDOW_BYTES / STREAM_WINDOW_BYTES` fully-stalled streams before
     * they can affect anyone else — and the daemon's own slow-consumer collapse
     * fires long before that.
     */
    try {
      session.setLocalWindowSize(CONNECTION_WINDOW_BYTES);
    } catch {
      // Older Node, or a session that died during setup. The per-stream windows
      // still apply; this is a widening, not a correctness requirement.
    }

    const tunnel = new RelayTunnel(machineId, Date.now(), protocolVersion, session, (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    });

    let misses = 0;
    const heartbeat = setInterval(() => {
      // The tunnel socket's safety valve. Per-stream and connection windows
      // should make this unreachable; if it is reached, something upstream is
      // wrong and an unbounded socket buffer is the worst way to find out.
      if (ws.bufferedAmount > MAX_TUNNEL_BUFFERED_BYTES) {
        onEvent("tunnel_backpressure", `${machineId} buffered ${ws.bufferedAmount}`);
        tunnel.close(CLOSE_TUNNEL_BACKPRESSURE, "tunnel backpressure");
        return;
      }
      if (misses >= TUNNEL_PING_MAX_MISSES) {
        ws.terminate();
        return;
      }
      misses += 1;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, TUNNEL_PING_INTERVAL_MS);

    ws.on("pong", () => {
      misses = 0;
    });

    const teardown = (): void => {
      clearInterval(heartbeat);
      registry.unregister(tunnel);
      try {
        session.destroy();
      } catch {
        // Already gone.
      }
    };

    ws.once("close", teardown);
    ws.once("error", teardown);
    session.once("close", () => ws.terminate());
    // An h2 protocol error must not take the process down with it.
    session.on("error", () => ws.terminate());

    registry.register(tunnel, CLOSE_TUNNEL_SUPERSEDED);
  }
}

/** Refuse an upgrade with a plain HTTP status, before any WebSocket exists. */
function refuse(socket: Duplex, status: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // The peer already went away; the destroy below is all that is left to do.
  }
  socket.destroy();
}
