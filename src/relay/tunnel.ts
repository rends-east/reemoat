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
  /**
   * Which build of each coding-agent CLI this daemon would launch, asked once per
   * dial and sent as `AGENT_CLIS_HEADER`. `announcedAgentClis` is the one
   * implementation; the option is a function rather than a value because the
   * answer moves under a running daemon and the handshake is the only moment it
   * is carried, so it is read *at* the handshake rather than at start.
   *
   * Optional, and an absent one sends no header — which is also what an empty
   * answer, an answer that throws, and one slower than `ANNOUNCE_TIMEOUT_MS` all
   * send. None of the four may cost the dial: the header is a report, and this
   * file's first property is that nothing here can break the daemon.
   */
  agentClis?: () => Promise<AgentClis>;
  /**
   * The X25519 static this machine answers on, base64url, announced as
   * `MACHINE_KEY_HEADER`.
   *
   * A **value** rather than a function, unlike `agentClis` beside it, and the
   * difference is a fact about the thing rather than a style: which CLI a launch
   * would resolve moves under a running daemon, so it is asked at the handshake;
   * a machine key is generated once and does not move, so asking again would be
   * asking the same question repeatedly and pretending it might answer
   * differently. Optional, and an absent one sends no header — which is what a
   * daemon that has not generated one yet looks like on the wire.
   *
   * ⚠ **This is the key the *first* dial announces, not the key every dial
   * announces.** `rotateMachineKey` below may replace it after a 409, which is
   * the one thing that moves it and is not the daemon changing its mind — it is
   * the Authority saying which of the keys already on this disk it pinned.
   */
  machineKey?: string;
  /**
   * This machine's static, for terminating an encrypted stream.
   *
   * The **private** half, unlike `machineKey` above, which is the public one the
   * dial announces. Absent on a daemon that has not generated one, which is a
   * state only a driver reaches; an encrypted stream is then refused with the same
   * 501 an unknown mode gets, because a daemon with no key genuinely cannot speak
   * this mode.
   */
  staticKey?: StaticKey;
  /**
   * After the relay answers 409: another key this machine holds, now live, or
   * `null` when there is none left to try.
   *
   * ⚠ **A 409 is the only evidence anywhere about which key the Authority
   * pinned, and without this it was thrown away.** A file that lost the
   * two-daemon startup race holds two keys; `migrateMachineKeysToOneLive` has to
   * leave one live and picks by `created_at`, which is right for a machine
   * nobody repaired and backwards for one an operator already cleared the pin on.
   * Rather than making that guess load-bearing, the guess is announced and the
   * refusal is believed: the daemon promotes the other key and dials again.
   * `machinekey.ts`'s `machineKeyRotation` is the one implementation and it is
   * what makes the set finite — each `kth` is offered at most once per process,
   * so this can never become a redial loop.
   *
   * Absent, or answering `null`, is the whole of the old behaviour: the 409
   * sentence below, unchanged, and a backoff that outlasts nothing. That is what
   * a machine with exactly one key gets, which is every legitimate 409 — a host
   * restored from backup, a wiped `~/.reemoat`, a reused machine id.
   */
  rotateMachineKey?: () => { kth: string; machineKey: string; staticKey: StaticKey } | null;
  /** What decides whether a capability entitles its holder to anything. */
  verifier?: TokenVerifier;
  /** Seam for `relaycheck`: how long a request may sit unanswered. See `e2ee.ts`. */
  upstreamTimeoutMs?: number;
  /** `ANNOUNCE_TIMEOUT_MS`, injectable so a driver can pin the bound without waiting three seconds on it. */
  announceTimeoutMs?: number;
  /** Injectable so `relaycheck` can drive the backoff curve without waiting on it. */
  random?: () => number;
}

/**
 * How long a dial waits for `agentClis` before dialling without it.
 *
 * The answer is normally a cache hit — `LocalRuntime.agentCli` holds a choice for
 * ten minutes — and the miss costs up to four `--version` spawns, each bounded at
 * `LOGIN_PROBE_TIMEOUT_MS` and run together. A hit is not free any more: it costs
 * one bounded `realpath` and `stat` of the file the choice names, and a build that
 * moved since costs its `--version` inside this same budget. Three seconds is
 * longer than any of them takes on a healthy machine and far shorter than the
 * reachability a daemon would forfeit waiting for a hung binary: past it the dial
 * proceeds with no header and the next dial carries what the probe has resolved by
 * then.
 */
export const ANNOUNCE_TIMEOUT_MS = 3_000;

/**
 * The daemon's answer to `TunnelOptions.agentClis`, over the runtime that picks
 * a build for a launch. The four built-in harnesses only: a contributed agent's
 * CLI is a plugin's to describe, and this header is about what this repository
 * ships and `deploy/agents.sh` moves.
 *
 * Reads `agentCli` rather than any cheaper probe so the report names **the build
 * a session would get** — the override, else the first copy on PATH — and not a
 * copy that happens to be installed somewhere. A harness with no CLI is left out;
 * a version outside `AGENT_CLI_VERSION_RE` is sent as unknown rather than sent
 * and refused whole by the relay, though `LocalRuntime.cliVersion` reduces a
 * `--version` line to a dotted number and cannot produce one. The four are
 * asked together, so a cold cache costs one probe's time rather than four.
 *
 * `scripts/daemoncheck` drives it over a fake runtime; `relaycheck` drives the
 * whole path from a real `RelayTunnel` to the machine row.
 */
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
  /*
   * ⚠ **The set of loopback sockets is gone with the splice that opened them.**
   *
   * This tunnel used to dial `127.0.0.1` itself for every relayed stream and hold
   * the sockets so a teardown did not strand them. It opens none now:
   * `serveSecureSession` terminates the stream and makes its own loopback calls
   * with Node's HTTP and WebSocket clients, and each session destroys what it
   * holds on the h2 stream's `close` — which a tunnel teardown produces, because
   * closing the session closes every stream under it. One owner for a socket's
   * lifetime rather than two agreeing about it.
   */

  /**
   * The static this tunnel is announcing and terminating streams with *now*.
   *
   * Two fields rather than reads of `options`, because `rotateMachineKey` moves
   * them together and they must never come apart: the public half is what the
   * Authority compares, the private half is what `serveSecureSession` opens
   * message 1 with, and a dial announcing one key while the responder holds the
   * other is a machine that is up, visible, and fails every handshake with no
   * key to send a refusal under. Seeded from `options` so a tunnel that never
   * sees a 409 is byte-identical to the one before this existed.
   */
  private machineKey: string | undefined;
  private staticKey: StaticKey | undefined;

  private constructor(private readonly options: TunnelOptions) {
    this.machineKey = options.machineKey;
    this.staticKey = options.staticKey;
  }

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

    /*
     * The one asynchronous step before a socket exists, and it is bounded, never
     * rejects, and cannot decide anything: the CLI inventory is asked for here so
     * the handshake carries what the daemon would launch *now* rather than at
     * boot. `stopped` is re-read after it, because `stop()` may have run in the
     * gap and a socket opened after it would be one nothing tears down.
     */
    void this.announce().then((announced) => {
      if (this.stopped) return;
      this.open(target, announced);
    });
  }

  /** `agentClis`, or nothing — on absence, on an empty answer, on a throw, on a timeout. */
  private async announce(): Promise<string | null> {
    const ask = this.options.agentClis;
    if (ask === undefined) return null;
    let clear = (): void => {};
    const deadline = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.options.announceTimeoutMs ?? ANNOUNCE_TIMEOUT_MS);
      // The daemon must be able to exit without waiting for a report.
      timer.unref?.();
      clear = () => clearTimeout(timer);
    });
    try {
      const value = await Promise.race<AgentClis | null>([ask(), deadline]);
      if (value === null) return null;
      const text = formatAgentClis(value);
      return text.length === 0 ? null : text;
    } catch {
      // A report. The dial is what matters, and it goes ahead without one.
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
          // The newest this build speaks. The relay negotiates **down** to what it
          // knows rather than refusing, so a daemon updated ahead of the relay it
          // dials keeps working — which is the direction that actually happens,
          // since the relay is deployed centrally and daemons are not.
          [TUNNEL_VERSION_HEADER]: String(RELAY_PROTOCOL_VERSION),
          // Advisory, recorded, never acted on. See `DAEMON_VERSION`.
          [DAEMON_VERSION_HEADER]: DAEMON_VERSION,
          // The same rule, for the CLIs. Absent rather than empty when there is
          // nothing to say, so a pre-header daemon and one with no CLI installed
          // are the same silence on the wire. See `AGENT_CLIS_HEADER`.
          ...(announced === null ? {} : { [AGENT_CLIS_HEADER]: announced }),
          // The static an app authenticates this machine by. Announced on every
          // dial rather than only the first, because the row it pins lives on the
          // control plane and a restored backup there must be able to catch up
          // without anybody touching this host. See `MACHINE_KEY_HEADER`.
          ...(this.machineKey === undefined ? {} : { [MACHINE_KEY_HEADER]: this.machineKey }),
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
      // Unreachable with the scheme checked in `dial`, and caught anyway: this
      // constructor is the only statement on the dial path that talks to the
      // outside world, and it now runs inside the `announce()` continuation, so a
      // throw here would be an unhandled rejection rather than reaching `start()`
      // on the boot path or `setTimeout` on the retry path — none of which has
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
      /*
       * A status line rather than a close code, because the relay refuses a bad
       * credential *before* completing the handshake — there is no WebSocket yet
       * to carry a close code. 401 here means this daemon's tunnel key is wrong
       * or revoked, which re-enrolling fixes.
       *
       * Two are worth naming, and they are the two a retry cannot outlast. Every
       * refusal here ends in `terminate()` and therefore in `scheduleRetry`, so a
       * status this handler does not explain becomes a daemon dialling on its
       * backoff for ever while the app draws the machine as not connected — the
       * symptom is identical to a relay that is merely down, and the remedy is
       * nothing like waiting.
       *
       * ⚠ **That sentence is now something this handler has to hold rather than
       * something it gets for free.** It was written when nothing between the
       * status read and the `emit` could fail. The 409 arm below calls out of
       * this file into an injected rotator that reads and writes SQLite, and the
       * guard around that call is the only reason "every refusal here ends in
       * `terminate()`" is still a true sentence — the measurement is beside it.
       *
       * 426: this daemon speaks a protocol version older than anything the relay
       * still accepts. The one refusal here that re-enrolling cannot fix and
       * updating can.
       *
       * 409: the key this daemon announced is not the one the control plane
       * pinned for this machine. It means the machine's local database and the
       * Authority's row disagree about which static an app should expect — a host
       * restored from a backup, a wiped `~/.reemoat`, a machine id reused for a
       * rebuilt box. Both remedies are named because which one is available
       * depends on the build: re-enrolling sends this key with the code and
       * replaces the pin, and an operator who cannot do that clears the pin so
       * the next dial is a first use again.
       *
       * ⚠ **"It is permanent, because the daemon regenerates nothing and the
       * Authority adopts nothing" was the rest of that paragraph, and it is now
       * true only of a machine holding one key.** A machine holding more — the
       * file that lost the two-daemon startup race, where
       * `migrateMachineKeysToOneLive` had to *guess* which of two the Authority
       * pinned — tries the other one instead of accepting the guess, because this
       * 409 is the only evidence in the system about which guess was right. The
       * daemon still regenerates nothing and the Authority still adopts nothing:
       * what moves is only which key already on this disk is the live one, and
       * the walk is finite because `rotateMachineKey` offers each `kth` at most
       * once per process. The refusal below is what an exhausted walk reaches,
       * and it is what the one-key machine reaches on its first 409.
       */
      const status = res.statusCode ?? 0;
      if (status === 409) {
        /*
         * ⚠ **This is the statement the guard exists for, and it is not the only
         * one in this handler that can throw.** That is a correction: this read
         * "the one statement here that runs code from outside this file, and the
         * only one that can throw", and a sweep of the handler on 2026-09-19 —
         * comments stripped, every statement read — says otherwise. Three
         * `this.emit` calls run the injected `this.options.onEvent`, and two
         * `ws.terminate()` calls are the `ws` library's; `teardown()` already
         * wraps `terminate()` in a `try` for precisely that reason. A throw out of
         * any of those five is the same class of failure as a throw out of this
         * one, and none of them is guarded here.
         *
         * What singles this statement out is not that it is alone: it is that its
         * one implementation has a *known* way to fail on an ordinary day, below.
         * The other five are unguarded on the judgement that a callback this
         * daemon injects and a `terminate()` on a socket that has not opened do
         * not have one — a judgement, not a measurement, and nothing in the
         * drivers holds it. `machinekey.ts`'s rotator —
         * the one implementation — reads every row of `machine_keys` and then
         * writes them inside a `BEGIN`/`COMMIT`. `SQLITE_BUSY` is not exotic
         * here: this daemon's own writers — the event log, the session table —
         * are live on the same file while it dials, and a dial is not a quiet
         * moment. A private half that is not 32 bytes throws too, out of
         * `localStaticKey`.
         *
         * A throw would escape into `ws`'s emit, which is an uncaught exception:
         * no `terminate()`, no `scheduleRetry`, a socket nobody closes and a
         * daemon that has stopped dialling. `machinekey.ts` swallows a `false`
         * from `promote` on the grounds that "this file's whole contract is that
         * the relay cannot break the daemon" — true of that file, and it was
         * never true of the two store calls around it, which is what this guard
         * is for.
         *
         * So a rotation that throws is a rotation that answered `null`: the
         * terminal 409 sentence below, `terminate()`, `scheduleRetry` — byte for
         * byte the behaviour of the build before any of this existed. And it is
         * a lost dial rather than a lost capability, in both shapes the throw
         * comes in. A read that failed left the tried set alone, so the next 409
         * walks the same candidates again, which is what a transient
         * `SQLITE_BUSY` wants. A *promotion* that failed had already added its
         * candidate to that set — `machineKeyRotation` adds before it promotes —
         * so the next 409 resumes past it rather than retrying it for ever.
         *
         * The cause is said rather than swallowed, because the sentence below
         * names two remedies and neither of them is the remedy for a locked
         * database. `onEvent` is the channel — nothing in `src/` prints, and it
         * is the only callback this path has.
         */
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
   * One CONNECT stream becomes one **encrypted session** with one app.
   *
   * ⚠ **There is no unencrypted arm here any more, and there is no way to ask for
   * one.** This used to splice the stream straight to a fresh loopback socket and
   * let the daemon's own server interpret whatever arrived — which worked, and
   * meant the relay had the plaintext of every prompt, diff, file and terminal
   * line in the fleet passing through it. The stream now terminates `Noise_IK`
   * here instead: the app and this daemon hold the keys, the relay holds
   * ciphertext, and `src/e2ee.ts` makes the loopback call itself with Node's own
   * HTTP and WebSocket clients.
   *
   * What did **not** change is the property that argument rested on. The bytes
   * reaching this daemon's listener are still the bytes Node produced from a real
   * request on a real socket, so nothing in `server.ts`, `session.ts` or
   * `registry.ts` knows any of this happened — the interpretation simply moved
   * from the relay to the endpoint that is supposed to do it.
   */
  private accept(stream: ServerHttp2Stream, headers: Record<string, unknown>): void {
    if (String(headers[":method"] ?? "") !== "CONNECT") {
      stream.respond({ ":status": 405 });
      stream.end();
      return;
    }

    /*
     * The encryption seam, spent.
     *
     * An unrecognised value is still refused at the *stream* level — one failed
     * connection — rather than by dropping the tunnel, so a relay that learns a
     * new mode before this daemon does degrades to "that request didn't work"
     * instead of "this machine went offline". What changed is which values are
     * recognised: there is exactly one, and `none` is not it.
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

    const encryption = String(headers[STREAM_ENCRYPTION_HEADER] ?? "");
    if (encryption !== STREAM_ENCRYPTION_NOISE_IK) {
      this.emit("stream_error", `refused a stream for ${subject}: unsupported encryption "${encryption}"`);
      stream.respond({ ":status": 501 });
      stream.end();
      return;
    }

    // The rotated half, not `options.staticKey`: after a 409 promoted another key
    // this is the one whose public half the app was handed, so it is the only one
    // that can open message 1.
    const staticKey = this.staticKey;
    const verifier = this.options.verifier;
    if (staticKey === undefined || verifier === undefined) {
      /*
       * A daemon with no machine key cannot speak the only mode there is, so it
       * cannot serve a relayed connection at all — which is why `daemon.ts`
       * generates one on first start and announces it on every dial. Answered on
       * the *stream* rather than by dropping the tunnel, so the machine stays
       * visible and the relay can say `501 encryption_unsupported` on the
       * upgrade; the app turns that into a sentence about updating this host.
       */
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
