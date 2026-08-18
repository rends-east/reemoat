import { createServer as createH2Server, type Http2Server, type ServerHttp2Stream } from "node:http2";
import { connect as netConnect, type Socket } from "node:net";
import { WebSocket, createWebSocketStream } from "ws";
import {
  CONNECTION_WINDOW_BYTES,
  DAEMON_VERSION_HEADER,
  LOOPBACK_DIAL_TIMEOUT_MS,
  MAX_CONCURRENT_STREAMS,
  MAX_TUNNEL_BUFFERED_BYTES,
  MAX_TUNNEL_MESSAGE_BYTES,
  PRE_NEGOTIATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_MIN_VERSION,
  RELAY_PROTOCOL_VERSION,
  STREAM_ENCRYPTION_HEADER,
  STREAM_ENCRYPTION_NONE,
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
  reconnectDelayMs,
} from "./protocol.js";
import { DAEMON_VERSION } from "../version.js";

/**
 * The daemon's end of the relay tunnel.
 *
 * One outbound WebSocket to the control plane, held open, carrying an HTTP/2
 * session on which the *relay* opens streams. Each stream is spliced to a fresh
 * connection to this daemon's own HTTP listener, so a relayed request arrives at
 * the server exactly as a direct one does — same parser, same auth middleware,
 * same everything. That is what makes "the daemon serves both paths identically"
 * true by construction rather than by discipline, and it is why nothing in
 * `server.ts` or `registry.ts` had to change for any of this.
 *
 * Three properties this file must never lose:
 *
 *   - **It cannot break the daemon.** A relay that is down, unreachable, or
 *     rejecting must cost nothing but log lines. Startup does not wait for it,
 *     no request path touches it, and every error here is caught.
 *   - **It is not the verification path.** Tokens are still verified locally
 *     against a public key. Nothing here is consulted to decide anything.
 *   - **It prints nothing.** Nothing in `src/` writes to stdout or stderr;
 *     `onEvent` hands the words to `scripts/daemon.ts`.
 */

export type TunnelEventKind =
  | "connecting"
  | "connected"
  | "disconnected"
  | "rejected"
  | "stream_error"
  | "backpressure";

export interface TunnelOptions {
  /** The relay origin from enrollment, e.g. `https://relay.example`. */
  relayUrl: string;
  /** The long-lived credential from enrollment. The relay derives the machine id from it. */
  tunnelKey: string;
  /**
   * Where this daemon's own HTTP server is listening.
   *
   * Taken from `server.address()` rather than from configuration: the configured
   * host may be `0.0.0.0`, which is a bind address and not somewhere you can
   * connect to on every platform.
   */
  local: { host: string; port: number };
  onEvent?: (kind: TunnelEventKind, detail: string) => void;
  /** Injectable so `relaycheck` can drive the backoff curve without waiting on it. */
  random?: () => number;
}

export class RelayTunnel {
  private ws: WebSocket | null = null;
  private h2: Http2Server | null = null;
  /**
   * The protocol version this tunnel is speaking, as the relay agreed it.
   *
   * Reset on every dial rather than carried across one, because a reconnect may
   * land on a *different* relay — the fleet may hold several, and a rolling
   * deploy replaces them one at a time — so a version agreed with the last one
   * says nothing about this one.
   *
   * Reset to `PRE_NEGOTIATION_PROTOCOL_VERSION` rather than to this build's
   * maximum: until the 101 says otherwise the honest belief about a peer is that
   * it predates negotiation, and guessing high is the mis-parse this handshake
   * exists to prevent. In practice `upgrade` always fires before `open`, so this
   * value survives only on a socket that never completed one.
   */
  private agreedVersion: number = PRE_NEGOTIATION_PROTOCOL_VERSION;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  /** Sockets opened for live streams, so a teardown does not strand them. */
  private readonly locals = new Set<Socket>();

  private constructor(private readonly options: TunnelOptions) {}

  /**
   * Start dialling. Returns immediately — the first connection happens in the
   * background, because a daemon must come up whether or not the relay answers.
   */
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
    for (const socket of this.locals) socket.destroy();
    this.locals.clear();
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

  /**
   * Reconnect with exponential backoff and **full** jitter.
   *
   * Full jitter, not the ±20% the CLI client uses, because the population is
   * different: this is every daemon in a fleet reacting to one relay restarting
   * at one instant. Narrow jitter there keeps the herd synchronised and turns a
   * restart into a thundering one.
   */
  private scheduleRetry(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = reconnectDelayMs(this.attempt, this.options.random ?? Math.random);
    this.timer = setTimeout(() => this.dial(), delay);
    // The daemon must be able to exit without waiting for a reconnect timer.
    this.timer.unref?.();
  }

  private dial(): void {
    if (this.stopped) return;

    let target: URL;
    try {
      target = new URL(TUNNEL_PATH, this.options.relayUrl);
    } catch {
      // Validated at enrollment, so this is close to unreachable — but a bad URL
      // must not become a crash loop.
      this.emit("rejected", `unusable relay URL ${this.options.relayUrl}`);
      return;
    }

    /*
     * **The scheme is checked, not assigned over, and that is the whole of this
     * guard being worth anything.**
     *
     * `target.protocol = "ws:"` is a *silent no-op* when the URL's scheme is not
     * one of the ones the URL spec calls special — the assignment is ignored and
     * the object keeps what it had. So one typo upstream (`htps://relay…`, which
     * `new URL` accepts happily, and which `enroll.ts` and the control plane's own
     * `main.ts` both validate by exactly that constructor) left `htps:` in place,
     * fell through this guard, and threw out of `new WebSocket` two lines below —
     * *outside* the try, on a path `scripts/daemon.ts` has no `uncaughtException`
     * handler for. The daemon printed its whole startup banner and died, under a
     * unit with `KeepAlive`/`RunAtLoad`: a permanent crash loop in which every
     * restart re-runs `restore()` and auto-resume, spawning agents that are killed
     * seconds later. Which is the one thing this file's header promises cannot
     * happen — a relay that is unreachable must cost nothing but log lines.
     */
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
    // Reset per dial, not per instance: a reconnect may land on a different relay.
    this.agreedVersion = PRE_NEGOTIATION_PROTOCOL_VERSION;

    let ws: WebSocket;
    try {
      ws = new WebSocket(target, {
        headers: {
          [TUNNEL_AUTH_HEADER]: `Bearer ${this.options.tunnelKey}`,
          // The newest this build speaks. The relay negotiates **down** to what it
          // knows rather than refusing, so a daemon updated ahead of the relay it
          // dials keeps working — which is the direction that actually happens,
          // since the relay is deployed centrally and daemons are not.
          [TUNNEL_VERSION_HEADER]: String(RELAY_PROTOCOL_VERSION),
          // Advisory, recorded, never acted on. See `DAEMON_VERSION`.
          [DAEMON_VERSION_HEADER]: DAEMON_VERSION,
        },
        perMessageDeflate: false,
        // h2 frames are already framed and mostly incompressible.
        skipUTF8Validation: true,
        /*
         * ⚠ **The same bound as the relay's end, because the socket has two ends
         * and only one of them was bounded.** `tunnel-endpoint.ts` caps what a
         * daemon may send; left off here, `ws` defaults to 100 MiB for what
         * arrives *from* the relay — and the attack `MAX_TUNNEL_MESSAGE_BYTES`
         * documents works identically in this direction: fragments that never set
         * FIN accumulate inside `ws`, the h2 layer sees nothing so no window is
         * consumed, and control frames keep the ping answering. What it parks
         * memory in here is the process that owns every agent subprocess, the
         * event log and the SQLite store.
         *
         * The relay is more trusted than a daemon, which is an argument for the
         * order the two were fixed in and not for leaving this one off. The bound
         * cannot refuse anything legitimate: everything on this socket is an h2
         * frame, and a coalesced write cannot exceed `CONNECTION_WINDOW_BYTES`,
         * which is this same 8 MiB.
         */
        maxPayload: MAX_TUNNEL_MESSAGE_BYTES,
      });
    } catch (error) {
      // Unreachable with the scheme checked above, and caught anyway: this
      // constructor is synchronous and the only statement in `dial` that talks to
      // the outside world, so a throw here is the one that reaches `start()` on
      // the boot path and `setTimeout` on the retry path — neither of which has
      // anywhere to put it. Treated as an unusable URL, i.e. no retry: a
      // constructor that refuses these arguments will refuse them again.
      this.emit(
        "rejected",
        `could not dial ${target.toString()}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      // A status line rather than a close code, because the relay refuses a bad
      // credential *before* completing the handshake — there is no WebSocket yet
      // to carry a close code. 401 here means this daemon's tunnel key is wrong
      // or revoked, which re-enrolling fixes.
      //
      // 426 is the one worth naming, because it is the only refusal here that
      // re-enrolling cannot fix and updating can: this daemon speaks a protocol
      // version older than anything the relay still accepts.
      const status = res.statusCode ?? 0;
      this.emit(
        "rejected",
        status === 426
          ? `relay refused the tunnel: it no longer speaks protocol v${RELAY_PROTOCOL_VERSION}. ` +
              "This daemon is too old for it — update this machine."
          : `relay refused the tunnel with HTTP ${status}`,
      );
      ws.terminate();
    });

    /*
     * What the two ends agreed to speak, read off the 101.
     *
     * The relay negotiates **down** to the newest version both know, so a daemon
     * offering more than the relay can speak is accepted rather than refused —
     * and therefore has to be told what it was accepted *as*. With one version in
     * existence that is always the number it offered; the read is here so that
     * the day there are two, the answer is already arriving rather than being a
     * protocol change of its own.
     *
     * Out of range is treated as a refusal rather than tolerated. A relay that
     * agreed to something this build cannot speak has either been rolled forward
     * past it or is not a relay, and either way the frames that follow would be
     * mis-parsed — which is the failure this whole handshake exists to make
     * impossible.
     *
     * ⚠ **A missing header reads as v1, not as this build's maximum.** It was the
     * maximum, which is the mirror of the mistake the relay made reading a missing
     * *offer*: silence means the peer predates negotiation, and something that
     * predates it speaks 1. Read as the maximum, a daemon at v2 dialling a relay
     * too old to answer — or through any proxy that drops an unknown header off a
     * 101 — sets `agreedVersion = 2` and speaks v2 down a v1 tunnel, which is
     * precisely "appears connected and silently mis-parses every request".
     */
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

    /*
     * `error` always precedes `close`, so only `close` reports and retries.
     *
     * Reporting from both produced two log lines per disconnect — "ECONNREFUSED"
     * then "code 1006" — which reads as though the tunnel dropped twice as often
     * as it did. The cause is the useful half and the close code is the
     * uninformative half, so the cause is carried forward into the one line that
     * is actually printed.
     */
    let lastError: string | null = null;
    ws.on("error", (error) => {
      lastError = error.message;
    });

    ws.on("close", (code, reason) => {
      const why = lastError ?? (reason.length > 0 ? reason.toString() : `code ${code}`);
      /*
       * Backoff is reset by a connection that *survived*, not by one that opened.
       *
       * Resetting in `open` means a tunnel that dies immediately after connecting
       * never backs off at all: `attempt` returns to 0, the next delay is drawn
       * from [0, 1000] ms, and it stays there for ever. Two daemons holding the
       * same tunnel key — a restored database, a cloned VM image — then supersede
       * each other about twice a second indefinitely, because the relay cannot
       * tell them apart (the machine id is derived from the credential, by
       * design) and each close feeds a fresh sub-second retry. `4013`
       * backpressure closes produce the same tight loop on a single daemon,
       * during exactly the incident the valve exists to survive.
       *
       * `open` still clears the *reported* state; only the counter is held back
       * until the connection has proved it is worth calling a success.
       */
      if (connectedAt !== 0 && Date.now() - connectedAt >= TUNNEL_STABLE_AFTER_MS) {
        this.attempt = 0;
      }
      this.teardown();
      this.emit("disconnected", why);
      this.scheduleRetry();
    });
  }

  /**
   * Run an h2 *server* on the socket we just dialled out on.
   *
   * The inversion is the point of the whole design: TCP says this daemon is the
   * client, but the relay is the one that opens streams, so at the h2 layer the
   * daemon serves. That is what lets a machine with no inbound ports accept
   * connections.
   */
  private serve(ws: WebSocket): void {
    const duplex = createWebSocketStream(ws);
    duplex.on("error", () => ws.terminate());

    const h2 = createH2Server({
      settings: {
        // Our receive window per stream: the browser-to-daemon direction. The
        // direction that matters more — daemon to browser — is governed by the
        // window the relay advertises, and both are granted on consumption.
        initialWindowSize: STREAM_WINDOW_BYTES,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
      },
    });
    this.h2 = h2;

    h2.on("session", (session) => {
      try {
        // The connection-level window is shared by every stream and defaults to
        // 64 KiB. Left there it would be the real bottleneck no matter how large
        // the per-stream windows are.
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
        // Should be unreachable: the per-stream windows exist to stop exactly
        // this. If it happens, dropping the tunnel is better than growing a
        // socket buffer without bound, and the reconnect is cheap.
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

  /**
   * One CONNECT stream becomes one connection to this daemon's own listener.
   *
   * Nothing here parses HTTP. The stream carries whatever the client sent —
   * a request, a WebSocket upgrade, anything the daemon will ever serve — and
   * splicing it to a real socket means the daemon's own server does all of the
   * interpreting, exactly as it would for a client on the LAN.
   */
  private accept(stream: ServerHttp2Stream, headers: Record<string, unknown>): void {
    if (String(headers[":method"] ?? "") !== "CONNECT") {
      stream.respond({ ":status": 405 });
      stream.end();
      return;
    }

    /*
     * The reserved encryption seam.
     *
     * Today the only legal value is `none`. An unrecognised one is refused at the
     * *stream* level — one failed request — rather than by dropping the tunnel,
     * so a relay that learns a new mode before this daemon does degrades to
     * "that request didn't work" instead of "this machine went offline".
     */
    // Advisory, and used only in the words below. The daemon verifies the real
    // token when the request reaches its own listener; this exists so a failing
    // stream names a caller instead of being anonymous.
    const subject = String(headers[STREAM_SUBJECT_HEADER] ?? "unknown");

    /*
     * The per-stream protocol version, refused the same way and for the same
     * reason as the encryption seam below it.
     *
     * ⚠ **This header was sent by the relay on every stream and read by nobody.**
     * `STREAM_VERSION_HEADER` was defined here, written at `relay/registry.ts`,
     * and never compared against anything — a declared version that could not
     * refuse anything, which is worth less than no version at all because it
     * reads as a check. Absent is tolerated deliberately: a relay too old to send
     * it is a relay speaking v1, which is what this daemon speaks.
     *
     * Refused at the *stream* level rather than by dropping the tunnel, which is
     * the property that makes a version bump survivable: a relay that opens a
     * stream this daemon cannot parse costs that one request, not the machine.
     */
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

    const encryption = String(headers[STREAM_ENCRYPTION_HEADER] ?? STREAM_ENCRYPTION_NONE);
    if (encryption !== STREAM_ENCRYPTION_NONE) {
      this.emit("stream_error", `refused a stream for ${subject}: unsupported encryption "${encryption}"`);
      stream.respond({ ":status": 501 });
      stream.end();
      return;
    }

    const { host, port } = this.options.local;
    const socket = netConnect({ host, port });
    this.locals.add(socket);

    // A daemon that cannot reach its own listener resets the stream rather than
    // leaving the browser waiting on a connection that will never be answered.
    socket.setTimeout(LOOPBACK_DIAL_TIMEOUT_MS, () => {
      if (!socket.connecting) return;
      socket.destroy();
    });

    const cleanup = (): void => {
      this.locals.delete(socket);
      socket.destroy();
      if (!stream.destroyed) stream.destroy();
    };

    socket.once("connect", () => {
      // Once connected, the idle timer must go: a WebSocket that sits quiet
      // between events is healthy, not stalled.
      socket.setTimeout(0);
      stream.respond({ ":status": 200 });
      // Plain pipes, so backpressure propagates in both directions. This is the
      // link that carries "the browser stopped reading" all the way back to
      // `StreamConnection.flush`, where the bounded queue and the slow-consumer
      // collapse already live.
      stream.pipe(socket);
      socket.pipe(stream);
    });

    socket.on("error", cleanup);
    stream.on("error", cleanup);
    stream.on("close", cleanup);
    socket.on("close", () => {
      this.locals.delete(socket);
      if (!stream.destroyed) stream.destroy();
    });
  }
}
