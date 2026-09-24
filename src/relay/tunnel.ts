import { createServer as createH2Server, type Http2Server, type ServerHttp2Stream } from "node:http2";
import { WebSocket, createWebSocketStream } from "ws";
import {
  AGENT_CLIS_HEADER,
  AGENT_CLI_VERSION_RE,
  CONNECTION_WINDOW_BYTES,
  DAEMON_VERSION_HEADER,
  MACHINE_KEY_HEADER,
  MAX_CONCURRENT_STREAMS,
  MAX_TUNNEL_BUFFERED_BYTES,
  MAX_TUNNEL_MESSAGE_BYTES,
  PRE_NEGOTIATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_MIN_VERSION,
  RELAY_PROTOCOL_VERSION,
  STREAM_ENCRYPTION_HEADER,
  STREAM_ENCRYPTION_NOISE_IK,
  STREAM_SUBJECT_HEADER,
  STREAM_VERSION_HEADER,
  STREAM_WINDOW_BYTES,
  TUNNEL_AGREED_VERSION_HEADER,
  TUNNEL_PATH,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MISSES,
  TUNNEL_STABLE_AFTER_MS,
  TUNNEL_AUTH_HEADER,
  TUNNEL_VERSION_HEADER,
  formatAgentClis,
  reconnectDelayMs,
  type AgentClis,
} from "./protocol.js";
import { DAEMON_VERSION } from "../version.js";
import { serveSecureSession } from "../e2ee.js";
import type { TokenVerifier } from "../auth.js";
import type { StaticKey } from "@reemoat/protocol";
import { AGENT_IDS } from "../acp/agents.js";
import type { SessionRuntime } from "../runtime/types.js";

// Relayed streams reach this daemon's own listener exactly as direct requests do; a relay that is down must cost nothing but log lines.

export type TunnelEventKind =
  | "connecting"
  | "connected"
  | "disconnected"
  | "rejected"
  | "stream_error"
  | "backpressure";

export interface TunnelOptions {
  relayUrl: string;
  tunnelKey: string;
  /** From the server's address, not config: a bind address like 0.0.0.0 is not connectable everywhere. */
  local: { host: string; port: number };
  onEvent?: (kind: TunnelEventKind, detail: string) => void;
  /** Asked at each handshake, since the answer moves under a running daemon; absent, empty, throwing or slow all send no header. */
  agentClis?: () => Promise<AgentClis>;
  /** The public half announced on each dial; rotateMachineKey may replace it after a 409. */
  machineKey?: string;
  staticKey?: StaticKey;
  /** After a 409: promotes another key this machine holds, or `null`; each kth is offered once per process, so it cannot loop. */
  rotateMachineKey?: () => { kth: string; machineKey: string; staticKey: StaticKey } | null;
  verifier?: TokenVerifier;
  upstreamTimeoutMs?: number;
  announceTimeoutMs?: number;
  random?: () => number;
}

export const ANNOUNCE_TIMEOUT_MS = 3_000;

export async function announcedAgentClis(runtime: Pick<SessionRuntime, "agentCli">): Promise<AgentClis> {
  const chosen = await Promise.all(AGENT_IDS.map((agent) => runtime.agentCli(agent)));
  const clis: AgentClis = {};
  AGENT_IDS.forEach((agent, index) => {
    const choice = chosen[index] ?? null;
    if (choice === null) return;
    clis[agent] = choice.version !== null && AGENT_CLI_VERSION_RE.test(choice.version) ? choice.version : null;
  });
  return clis;
}

export class RelayTunnel {
  private ws: WebSocket | null = null;
  private h2: Http2Server | null = null;
  /** Reset to v1 on every dial: a reconnect may reach a different relay, and a silent peer predates negotiation. */
  private agreedVersion: number = PRE_NEGOTIATION_PROTOCOL_VERSION;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private stopping: Promise<void> | null = null;

  // Moved together by rotateMachineKey: announcing one key while terminating with the other fails every handshake.
  private machineKey: string | undefined;
  private staticKey: StaticKey | undefined;

  private constructor(private readonly options: TunnelOptions) {
    this.machineKey = options.machineKey;
    this.staticKey = options.staticKey;
  }

  static start(options: TunnelOptions): RelayTunnel {
    const tunnel = new RelayTunnel(options);
    tunnel.dial();
    return tunnel;
  }

  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.teardown();
    await Promise.resolve();
  }

  private emit(kind: TunnelEventKind, detail: string): void {
    this.options.onEvent?.(kind, detail);
  }

  private teardown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const { ws, h2 } = this;
    this.ws = null;
    this.h2 = null;
    try {
      h2?.close();
    } catch {
      // Already closed.
    }
    try {
      ws?.terminate();
    } catch {
      // Already gone.
    }
  }

  /** Full jitter: every daemon in the fleet reacts to one relay restart at the same instant. */
  private scheduleRetry(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = reconnectDelayMs(this.attempt, this.options.random ?? Math.random);
    this.timer = setTimeout(() => this.dial(), delay);
    this.timer.unref?.();
  }

  private dial(): void {
    if (this.stopped) return;

    let target: URL;
    try {
      target = new URL(TUNNEL_PATH, this.options.relayUrl);
    } catch {
      this.emit("rejected", `unusable relay URL ${this.options.relayUrl}`);
      return;
    }

    // Checked, not assigned over: assigning a protocol is a silent no-op on a non-special scheme, and the WebSocket constructor would then throw.
    const secure = target.protocol === "https:" || target.protocol === "wss:";
    if (!secure && target.protocol !== "http:" && target.protocol !== "ws:") {
      this.emit(
        "rejected",
        `unusable relay URL ${this.options.relayUrl}: ${target.protocol.replace(":", "")} is not one of http, https, ws, wss`,
      );
      return;
    }
    target.protocol = secure ? "wss:" : "ws:";

    this.emit("connecting", target.toString());
    this.agreedVersion = PRE_NEGOTIATION_PROTOCOL_VERSION;

    // `stopped` is re-read after the announce: stop may have run in the gap.
    void this.announce().then((announced) => {
      if (this.stopped) return;
      this.open(target, announced);
    });
  }

  private async announce(): Promise<string | null> {
    const ask = this.options.agentClis;
    if (ask === undefined) return null;
    let clear = (): void => {};
    const deadline = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.options.announceTimeoutMs ?? ANNOUNCE_TIMEOUT_MS);
      timer.unref?.();
      clear = () => clearTimeout(timer);
    });
    try {
      const value = await Promise.race<AgentClis | null>([ask(), deadline]);
      if (value === null) return null;
      const text = formatAgentClis(value);
      return text.length === 0 ? null : text;
    } catch {
      return null;
    } finally {
      clear();
    }
  }

  private open(target: URL, announced: string | null): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(target, {
        headers: {
          [TUNNEL_AUTH_HEADER]: `Bearer ${this.options.tunnelKey}`,
          [TUNNEL_VERSION_HEADER]: String(RELAY_PROTOCOL_VERSION),
          // Advisory, recorded, never acted on. See `DAEMON_VERSION`.
          [DAEMON_VERSION_HEADER]: DAEMON_VERSION,
          ...(announced === null ? {} : { [AGENT_CLIS_HEADER]: announced }),
          ...(this.machineKey === undefined ? {} : { [MACHINE_KEY_HEADER]: this.machineKey }),
        },
        perMessageDeflate: false,
        skipUTF8Validation: true,
        // Bounds what arrives from the relay, as tunnel-endpoint bounds what a daemon sends.
        maxPayload: MAX_TUNNEL_MESSAGE_BYTES,
      });
    } catch (error) {
      // Unreachable after the scheme check; caught because a throw here would be an unhandled rejection.
      this.emit(
        "rejected",
        `could not dial ${target.toString()}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      // A status, not a close code: the relay refuses before the handshake completes (426: update; 409: unpinned key).
      const status = res.statusCode ?? 0;
      if (status === 409) {
        // Guarded: the rotator writes SQLite and can throw; a throw must still end in terminate and a retry.
        let promoted: { kth: string; machineKey: string; staticKey: StaticKey } | null = null;
        try {
          promoted = this.options.rotateMachineKey?.() ?? null;
        } catch (error) {
          this.emit(
            "rejected",
            "relay refused the tunnel with 409, and looking for another key this machine holds failed: " +
              `${error instanceof Error ? error.message : String(error)}. ` +
              "The next dial looks again, past the key this one gave up on. " +
              "What follows is what an exhausted search reaches.",
          );
        }
        if (promoted !== null) {
          this.machineKey = promoted.machineKey;
          this.staticKey = promoted.staticKey;
          this.emit(
            "rejected",
            "relay refused the tunnel: the control plane did not pin the key this machine announced. " +
              `This database holds another — ${promoted.kth} is live now and the next dial announces it. ` +
              "Two daemons raced on this file once, and only the control plane knows which of them won.",
          );
          ws.terminate();
          return;
        }
      }
      this.emit(
        "rejected",
        status === 426
          ? `relay refused the tunnel: it no longer speaks protocol v${RELAY_PROTOCOL_VERSION}. ` +
              "This daemon is too old for it — update this machine."
          : status === 409
            ? "relay refused the tunnel: this machine announced an encryption key that does not match " +
              "the one the control plane pinned for it, so nothing can reach it and retrying will not help. " +
              "Re-enroll this machine, or have an operator run `cpctl admin clearkey <machineId>`."
            : `relay refused the tunnel with HTTP ${status}`,
      );
      ws.terminate();
    });

    // A missing agreed-version header reads as v1, never this build's maximum; out of range is a refusal, or frames would be mis-parsed.
    ws.on("upgrade", (res) => {
      const raw = res.headers[TUNNEL_AGREED_VERSION_HEADER];
      const agreed = Number(Array.isArray(raw) ? raw[0] : (raw ?? PRE_NEGOTIATION_PROTOCOL_VERSION));
      if (!Number.isInteger(agreed) || agreed < RELAY_PROTOCOL_MIN_VERSION || agreed > RELAY_PROTOCOL_VERSION) {
        this.emit(
          "rejected",
          `relay agreed protocol v${String(raw ?? "(none)")}, which this daemon does not speak ` +
            `(it speaks v${RELAY_PROTOCOL_MIN_VERSION}-v${RELAY_PROTOCOL_VERSION})`,
        );
        ws.terminate();
        return;
      }
      this.agreedVersion = agreed;
    });

    let connectedAt = 0;
    ws.on("open", () => {
      connectedAt = Date.now();
      this.emit("connected", `${target.toString()} (protocol v${this.agreedVersion})`);
      this.serve(ws);
    });

    // `error` always precedes `close`, so only `close` reports and retries.
    let lastError: string | null = null;
    ws.on("error", (error) => {
      lastError = error.message;
    });

    ws.on("close", (code, reason) => {
      const why = lastError ?? (reason.length > 0 ? reason.toString() : `code ${code}`);
      // Backoff resets only after a connection survives TUNNEL_STABLE_AFTER_MS, or a tunnel that dies on open retries sub-second for ever.
      if (connectedAt !== 0 && Date.now() - connectedAt >= TUNNEL_STABLE_AFTER_MS) {
        this.attempt = 0;
      }
      this.teardown();
      this.emit("disconnected", why);
      this.scheduleRetry();
    });
  }

  /** An h2 server on an outbound socket: the relay opens the streams, so a machine with no inbound ports can serve. */
  private serve(ws: WebSocket): void {
    const duplex = createWebSocketStream(ws);
    duplex.on("error", () => ws.terminate());

    const h2 = createH2Server({
      settings: {
        initialWindowSize: STREAM_WINDOW_BYTES,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      },
    });
    this.h2 = h2;

    h2.on("session", (session) => {
      try {
        // The shared connection window defaults to 64 KiB, which would throttle every stream.
        session.setLocalWindowSize(CONNECTION_WINDOW_BYTES);
      } catch {
        // A widening, not a correctness requirement.
      }
      session.on("error", () => ws.terminate());
    });
    h2.on("stream", (stream, headers) => this.accept(stream, headers));
    // A protocol error on one tunnel must not reach the top level.
    h2.on("sessionError", () => ws.terminate());
    h2.on("error", () => ws.terminate());

    h2.emit("connection", duplex);

    let misses = 0;
    ws.on("pong", () => {
      misses = 0;
    });
    this.heartbeat = setInterval(() => {
      if (ws.bufferedAmount > MAX_TUNNEL_BUFFERED_BYTES) {
        this.emit("backpressure", `tunnel buffered ${ws.bufferedAmount} bytes`);
        ws.terminate();
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
    this.heartbeat.unref?.();
  }

  /** Every CONNECT stream is a Noise_IK session: the relay holds only ciphertext, and e2ee.ts makes the loopback call. */
  private accept(stream: ServerHttp2Stream, headers: Record<string, unknown>): void {
    if (String(headers[":method"] ?? "") !== "CONNECT") {
      stream.respond({ ":status": 405 });
      stream.end();
      return;
    }

    const subject = String(headers[STREAM_SUBJECT_HEADER] ?? "unknown");

    // Version and encryption are refused per stream, never by dropping the tunnel, so a relay ahead of this daemon costs one request.
    const rawVersion = headers[STREAM_VERSION_HEADER];
    const streamVersion = rawVersion === undefined ? this.agreedVersion : Number(rawVersion);
    if (!Number.isInteger(streamVersion) || streamVersion !== this.agreedVersion) {
      this.emit(
        "stream_error",
        `refused a stream for ${subject}: protocol v${String(rawVersion)} on a tunnel speaking v${this.agreedVersion}`,
      );
      stream.respond({ ":status": 501 });
      stream.end();
      return;
    }

    const encryption = String(headers[STREAM_ENCRYPTION_HEADER] ?? "");
    if (encryption !== STREAM_ENCRYPTION_NOISE_IK) {
      this.emit("stream_error", `refused a stream for ${subject}: unsupported encryption "${encryption}"`);
      stream.respond({ ":status": 501 });
      stream.end();
      return;
    }

    // The rotated key, not the option's: after a 409 only it can open message 1.
    const staticKey = this.staticKey;
    const verifier = this.options.verifier;
    if (staticKey === undefined || verifier === undefined) {
      this.emit("stream_error", `refused an encrypted stream for ${subject}: this daemon has no machine key`);
      stream.respond({ ":status": 501 });
      stream.end();
      return;
    }

    stream.respond({ ":status": 200 });
    serveSecureSession({
      stream,
      staticKey,
      verifier,
      local: this.options.local,
      ...(this.options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: this.options.upstreamTimeoutMs }),
      onEvent: (kind, detail) => {
        if (kind === "opened") return;
        this.emit("stream_error", `${kind}: ${detail}`);
      },
    });
  }
}
