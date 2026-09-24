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
  AGENT_CLIS_HEADER,
  DAEMON_VERSION_HEADER,
  MACHINE_KEY_HEADER,
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
  parseMachineKey,
  negotiateProtocolVersion,
} from "../../../../src/relay/protocol.js";
import { recordDaemonBuild, readAgentClisHeader, readDaemonVersionHeader } from "../machines.js";
import { pinMachineKey, type MachineKeyPin } from "../machinekeys.js";
import { resolveTunnelKey } from "../keys.js";
import { machineStanding } from "../quota.js";
import { RelayTunnel, type TunnelRegistry } from "./registry.js";

// Where a daemon dials out to: one WebSocket per daemon carrying HTTP/2, with the relay as h2 client because it opens the streams.

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
  // The one inbound bound at the ws layer; unset, ws allows 100 MiB per message.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_TUNNEL_MESSAGE_BYTES,
  });

  // The agreed version rides the 101 itself; this event is the only place ws lets a header be added.
  wss.on("headers", (headers, request) => {
    const offered = request.headers[TUNNEL_VERSION_HEADER];
    const agreed = negotiateProtocolVersion(
      offered === undefined ? PRE_NEGOTIATION_PROTOCOL_VERSION : Number(offered),
    );
    if (agreed !== null) headers.push(`${TUNNEL_AGREED_VERSION_HEADER}: ${agreed}`);
  });

  return {
    handleUpgrade(req, socket, head) {
      // Authenticated before the handshake, so an unauthenticated peer never holds a socket and a refusal is a plain HTTP status.
      // Negotiated, not matched, so a protocol bump is no flag day. A missing header is PRE_NEGOTIATION_PROTOCOL_VERSION, never the moving floor.
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

      // The machine id is an output of the credential lookup; nothing in the request names a machine.
      const machineId = resolveTunnelKey(db, presented);
      if (machineId === null) {
        onEvent("tunnel_rejected", "unknown or revoked tunnel credential");
        return refuse(socket, 401, "Unauthorized");
      }

      // Over the limit or owner disabled: refused at dial, 403 not 401, so relayOnline stays truthful and the daemon's backoff restores it once lifted.
      const standing = machineStanding(db, machineId);
      if (standing !== null && (standing.over || standing.ownerDisabled)) {
        onEvent(
          "tunnel_rejected",
          standing.ownerDisabled
            ? `${machineId} belongs to a disabled user`
            : `${machineId} is over its owner's machine limit`,
        );
        return refuse(socket, 403, "Forbidden");
      }

      // Only a proven key mismatch refuses the dial; a failed lookup fails open, since a stale pin only breaks the app's handshake visibly.
      const announcedKey = parseMachineKey(req.headers[MACHINE_KEY_HEADER]);
      if (announcedKey !== null) {
        let pin: MachineKeyPin = "unchanged";
        try {
          pin = pinMachineKey(db, machineId, announcedKey);
        } catch {
          // A write that would not land. One stale row, never a refused dial.
        }
        if (pin === "mismatch") {
          onEvent("tunnel_refused", `${machineId} announced a machine key that is not the one pinned for it`);
          refuse(socket, 409, "Conflict");
          return;
        }
      }

      recordDaemonBuild(db, machineId, {
        daemonVersion: readDaemonVersionHeader(req.headers[DAEMON_VERSION_HEADER]),
        protocolVersion: agreed,
        agentClis: readAgentClisHeader(req.headers[AGENT_CLIS_HEADER]),
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

  // protocolVersion is the negotiated one: every stream is stamped with it, and the daemon refuses a stream that disagrees.
  function attach(ws: WebSocket, machineId: string, protocolVersion: number): void {
    ws.binaryType = "nodebuffer";

    const duplex = createWebSocketStream(ws);
    // Never fatal to the process. A tunnel dying is routine; the daemon reconnects.
    duplex.on("error", () => ws.terminate());

    const session = h2connect("http://tunnel", {
      createConnection: () => duplex,
      settings: {
        // Per-stream receive window for the daemon-to-browser direction; credit is granted on consumption.
        initialWindowSize: STREAM_WINDOW_BYTES,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      },
    });

    // The connection window defaults to 64 KiB and is shared by every stream, so a few stalled browsers would starve the rest.
    try {
      session.setLocalWindowSize(CONNECTION_WINDOW_BYTES);
    } catch {
      // Older Node, or a session that died in setup; the per-stream windows still apply.
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
      // Safety valve: the flow-control windows should make this unreachable.
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

function refuse(socket: Duplex, status: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // The peer already went away; the destroy below is all that is left to do.
  }
  socket.destroy();
}
