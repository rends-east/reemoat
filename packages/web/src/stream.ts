import type { SessionId, SessionRef } from "./ids";
import { SOCKET_ROTATE_MARGIN_MS, describe, type MachineConnection, type Route } from "./machine";
import type { LaggedFrame, SessionSnapshot, StoredEvent, StreamFrame } from "./wire";

/**
 * One session's live stream.
 *
 * The whole design rests on a single number, `lastAppliedSeq`, and on the daemon
 * guaranteeing two things about it: `read` is `WHERE seq > ?`, and `attach` has no
 * `await` between reading the backlog and subscribing. Given those, reconnecting
 * with `since = lastAppliedSeq` fills the gap **exactly once** — an append lands
 * strictly in the backlog or strictly through the listener, never both and never
 * neither.
 *
 * Everything else here exists to keep that number honest across the four ways a
 * socket ends: expiry, a network change, the daemon restarting, and the phone
 * being asleep.
 */

/** Close codes the daemon uses. Each means something different to a client. */
const CLOSE_SESSION_NOT_FOUND = 4404;
const CLOSE_TOKEN_EXPIRED = 4401;
const CLOSE_SLOW_CONSUMER = 4003;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/** A collapse means the daemon threw away queued events. Do not come straight back. */
const SLOW_CONSUMER_BACKOFF_MS = 5_000;
/** How long a pending connect is left alone by `reconnect`. One handshake's worth. */
const CONNECT_SETTLE_MS = 2_000;
/**
 * How long to wait before trying a rotation again.
 *
 * Reached for three different reasons — the successor died, there was no token,
 * there was no route — and named so that a reader does not have to prove three
 * bare `15_000`s were meant to be the same number. The current socket stays live
 * until the daemon closes it at `exp + leeway`, so this only has to be shorter
 * than the margin the rotation was scheduled with.
 */
const ROTATE_RETRY_MS = 15_000;

export type StreamPhase = "idle" | "connecting" | "live" | "waiting" | "closed";

export interface StreamStatus {
  phase: StreamPhase;
  lastAppliedSeq: number;
  /** Changes when the daemon restarted. The cursor stays valid; the log is durable. */
  instanceId: string | null;
  error: string | null;
}

export interface StreamSink {
  /** Contiguous, deduplicated, in order. Never called with a seq already applied. */
  onEvents(ref: SessionRef, events: StoredEvent[]): void;
  onSnapshot(ref: SessionRef, session: SessionSnapshot): void;
  /** History the client will never see. `from`/`to` inclusive. */
  onGap(ref: SessionRef, from: number, to: number, reason: LaggedFrame["reason"]): void;
  onStatus(ref: SessionRef, status: StreamStatus): void;
  /** The session no longer exists on that daemon. */
  onVanished(ref: SessionRef): void;
}

export class SessionStream {
  readonly ref: SessionRef;

  private socket: WebSocket | null = null;
  /** The make-before-break replacement, live until its `hello` arrives. */
  private successor: WebSocket | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private lastAppliedSeq = 0;
  private instanceId: string | null = null;
  private phase: StreamPhase = "idle";
  private error: string | null = null;
  private attempt = 0;
  private stopped = false;
  private connectStartedAt = 0;
  /**
   * Bumped on every deliberate (re)connect. A socket whose generation is stale
   * has been superseded and its frames are ignored — which is what stops a
   * lingering `close` event from an old socket tearing down its replacement.
   */
  private generation = 0;

  constructor(
    ref: SessionRef,
    private readonly machine: MachineConnection,
    private readonly sink: StreamSink,
    since: number,
  ) {
    this.ref = ref;
    this.lastAppliedSeq = since;
  }

  get cursor(): number {
    return this.lastAppliedSeq;
  }

  status(): StreamStatus {
    return {
      phase: this.phase,
      lastAppliedSeq: this.lastAppliedSeq,
      instanceId: this.instanceId,
      error: this.error,
    };
  }

  start(): void {
    if (this.stopped) return;
    if (this.socket !== null || this.phase === "connecting") return;
    void this.connect();
  }

  /**
   * Reconnect now, from the cursor.
   *
   * This is what the resume path calls. It tears the old socket down first,
   * because after a sleep that socket is dead-but-not-reported and waiting for it
   * to say so takes as long as a TCP timeout.
   *
   * The exception is a connect that is already in flight and young. Opening a
   * session fires `resume` moments later, and tearing down a socket that is
   * mid-handshake to open an identical one achieves nothing except a browser
   * console warning and a wasted round trip. An *old* pending connect is
   * different — that is a socket that will never open — so the guard is on age,
   * not on the phase alone.
   */
  reconnect(): void {
    if (this.stopped) return;
    if (this.phase === "connecting" && Date.now() - this.connectStartedAt < CONNECT_SETTLE_MS) return;
    this.teardown();
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    this.setPhase("closed");
  }

  private teardown(): void {
    this.generation += 1;
    this.clearTimers();
    closeQuietly(this.socket);
    closeQuietly(this.successor);
    this.socket = null;
    this.successor = null;
  }

  private clearTimers(): void {
    if (this.rotateTimer !== null) clearTimeout(this.rotateTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.rotateTimer = null;
    this.retryTimer = null;
  }

  private setPhase(phase: StreamPhase, error: string | null = null): void {
    this.phase = phase;
    this.error = error;
    this.sink.onStatus(this.ref, this.status());
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.connectStartedAt = Date.now();
    this.setPhase("connecting");

    let token: string;
    let route: Route | null;
    try {
      // Minted per connection, so a reconnect after an expiry close carries a
      // token that is actually valid rather than the one that was just refused.
      token = await this.machine.ensureToken();
      // Resolved per connection rather than once, so a reconnect after the
      // direct path died lands on the relay instead of retrying a route that is
      // gone. That only works because every close that is not an expiry calls
      // `forgetRoute` — the memo alone would hand back the dead route for ever.
      route = await this.machine.resolveRoute();
    } catch (error) {
      return this.retryLater(describe(error));
    }
    if (route === null) return this.retryLater("no route to this machine");
    if (this.stopped) return;

    /*
     * A rotation still in flight belonged to the socket we are replacing, and it
     * has to go before the generation moves.
     *
     * `this.successor` is cleared in exactly three places — `teardown()`, the
     * `hello` that promotes it, and its own `onclose` — and every one of the
     * three except `teardown()` is behind `if (generation !== this.generation)`.
     * So the primary closing mid-handshake (a phone handing over Wi-Fi→LTE sends
     * RST, and the successor's open is a full relay round trip) reached
     * `handleClose` → `retryLater` → here, the bump silenced the orphan's
     * `onclose`, and the field stayed non-null for the life of the stream: every
     * later `rotate()` returned at its first line, so the make-before-break this
     * class exists for stopped happening and the session flapped through a
     * daemon-sent 4401 every five minutes instead. The socket itself was left
     * attached too, holding a `StreamConnection` on the daemon.
     *
     * Only ever reached with a dead or absent primary — `start()` declines while
     * `socket !== null` and `reconnect()` has already run `teardown()` — so this
     * cannot cancel a healthy rotation.
     */
    closeQuietly(this.successor);
    this.successor = null;

    const generation = ++this.generation;
    const socket = this.open(token, route, generation, false);
    this.socket = socket;
  }

  /**
   * Open a socket and wire its frames.
   *
   * `isSuccessor` marks the make-before-break replacement: it does not become the
   * live socket until its `hello` arrives, at which point the old one is closed.
   */
  private open(token: string, route: Route, generation: number, isSuccessor: boolean): WebSocket {
    const url = this.machine.streamUrl(this.ref.sessionId as SessionId, this.lastAppliedSeq, token, route);
    const socket = new WebSocket(url);

    socket.onmessage = (message): void => {
      if (generation !== this.generation) return;
      if (typeof message.data !== "string") return;
      let frame: StreamFrame;
      try {
        frame = JSON.parse(message.data) as StreamFrame;
      } catch {
        // A frame we cannot parse is one we cannot act on, and the cursor is
        // unchanged, so the next reconnect will replay whatever it was.
        return;
      }
      this.apply(frame, socket, isSuccessor);
    };

    socket.onerror = (): void => {
      // Always followed by `close`, which is where the handling lives. A browser
      // gives no reason here, so there is nothing to record that `close` will not
      // record better.
    };

    socket.onclose = (event): void => {
      if (generation !== this.generation) return;
      if (isSuccessor && this.successor === socket) {
        // The replacement failed before it took over. Keep the old socket, which
        // is still live, and try the rotation again shortly.
        this.successor = null;
        this.scheduleRotation(ROTATE_RETRY_MS);
        return;
      }
      this.socket = null;
      this.handleClose(event.code, event.reason);
    };

    return socket;
  }

  private apply(frame: StreamFrame, socket: WebSocket, isSuccessor: boolean): void {
    switch (frame.type) {
      case "hello": {
        if (isSuccessor) {
          /*
           * The rotation completes here, and only here.
           *
           * The replacement has attached and its backlog starts at
           * `lastAppliedSeq + 1`, so from this instant the old socket can only
           * deliver seqs the reducer will skip. Closing it now is safe; closing
           * it any earlier would open a window where neither socket was live.
           */
          closeQuietly(this.socket);
          this.socket = socket;
          this.successor = null;
        }
        this.instanceId = frame.instanceId;
        this.attempt = 0;
        /*
         * Never backwards. `frame.since` is what *this* socket asked for, captured
         * in `open()` before the handshake — and during a rotation the old socket
         * is still live and still delivering, so by the time the successor's
         * `hello` arrives the cursor has usually moved past it.
         *
         * Assigning it unconditionally rewound the cursor and thereby defeated the
         * `stored.seq <= this.lastAppliedSeq` skip below, which is the one
         * comparison the overlap depends on: everything the old socket delivered
         * during the handshake was then replayed out of the successor's backlog and
         * appended a second time. The hole check did not catch it either, because a
         * replay from a rewound cursor is perfectly contiguous.
         *
         * `max` still absorbs the case this assignment exists for — the daemon
         * clamping us *forward* with `Math.min(sinceParam, stats.lastSeq)` when the
         * cursor names a seq the log no longer has.
         */
        this.lastAppliedSeq = Math.max(this.lastAppliedSeq, frame.since);
        this.sink.onSnapshot(this.ref, frame.session);
        /*
         * `frame.gap` is deliberately *not* turned into an `onGap` here.
         *
         * The daemon already sends an explicit `lagged{reason:"evicted"}` as the
         * frame immediately after this one whenever `gap` is true, carrying
         * `from = since + 1` and `to = oldest - 1` — and the `lagged` case below
         * handles it correctly. Deriving a second one from `hello` reported the
         * range backwards (`firstSeq` as `from`, `since` as `to`), which
         * `store.onGap` silently dropped via `if (to < from) return` whenever the
         * log retained anything, and which survived only in the total-loss case to
         * fabricate a bogus gap at seq 0 beside the daemon's correct one.
         *
         * `hello` does not carry enough to compute the range anyway: the honest
         * floor is `oldestAvailable`, and one number cannot say both where history
         * starts and where our cursor was.
         */
        this.setPhase("live");
        this.scheduleRotation();
        return;
      }

      case "events": {
        const fresh: StoredEvent[] = [];
        for (const stored of frame.events) {
          // The rotation overlap arrives here: for a moment two sockets deliver
          // the same seqs, and this one comparison is what makes that free.
          if (stored.seq <= this.lastAppliedSeq) continue;
          if (stored.seq !== this.lastAppliedSeq + 1) {
            /*
             * A hole. This should be impossible on one socket — the daemon
             * batches contiguously — so treat it as a bug in our own cursor
             * rather than as data: drop the frame, reconnect from where we are,
             * and let the replay fill it properly. Rendering it would put events
             * in the DOM under numbers we never received.
             *
             * Every event in the batch, not only the first accepted one. This
             * carried `&& fresh.length === 0`, which made the check the *frame's*
             * first event rather than each event's own predecessor: after one
             * `fresh.push` a gap in the middle of the batch was accepted
             * silently and the cursor jumped straight over it, which is the one
             * outcome this branch exists to prevent.
             *
             * What is contiguous is delivered before reconnecting, because the
             * cursor has already moved over it: `open()` re-attaches at
             * `lastAppliedSeq`, so anything counted and not handed to the sink
             * would be a hole of this socket's own making.
             */
            if (fresh.length > 0) this.sink.onEvents(this.ref, fresh);
            this.reconnect();
            return;
          }
          fresh.push(stored);
          this.lastAppliedSeq = stored.seq;
        }
        if (fresh.length > 0) this.sink.onEvents(this.ref, fresh);
        return;
      }

      case "snapshot":
        this.sink.onSnapshot(this.ref, frame.session);
        return;

      case "caught_up":
        // The only "nothing more is coming" signal for a session that was already
        // terminal when we attached — it will never send a snapshot.
        this.setPhase("live");
        return;

      case "lagged": {
        // `from`/`to` are inclusive, so the cursor goes to `to`, not `to - 1`.
        this.sink.onGap(this.ref, frame.from, frame.to, frame.reason);
        this.lastAppliedSeq = Math.max(this.lastAppliedSeq, frame.to);
        return;
      }

      case "error":
        this.setPhase(this.phase, `${frame.code}: ${frame.message}`);
        return;

      default:
        // An unrecognised frame from a newer daemon. Ignoring it is correct;
        // the cursor only moves on `events` and `lagged`.
        return;
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.stopped) return;
    this.clearTimers();

    switch (code) {
      case CLOSE_TOKEN_EXPIRED:
        /*
         * Normal operation, not an error.
         *
         * The socket outlived its token — which is the wake-from-sleep case, and
         * the rotation below exists to make it rare rather than impossible. The
         * route is fine, so the memo is deliberately *not* dropped: re-probing
         * here would flap a perfectly good direct connection every five minutes.
         */
        void this.machine.ensureToken(true).then(
          () => this.connect(),
          (error: unknown) => this.retryLater(describe(error)),
        );
        return;

      case CLOSE_SESSION_NOT_FOUND:
        this.stopped = true;
        this.setPhase("closed", "session not found on this daemon");
        this.sink.onVanished(this.ref);
        return;

      case CLOSE_SLOW_CONSUMER:
        // The daemon collapsed our queue twice in 30 seconds. Coming straight
        // back would earn a third collapse; the cursor is at the head anyway.
        this.retryLater("dropped for falling behind", SLOW_CONSUMER_BACKOFF_MS);
        return;

      default:
        /*
         * Everything else is a transport failure — 1006 on a phone leaving a
         * LAN, 1001 on a daemon shutting down. This is exactly the case
         * `forgetRoute` exists for, and the only one: a close code is not an
         * HTTP status, so nothing here can be the daemon answering.
         */
        this.machine.forgetRoute();
        this.retryLater(reason.length > 0 ? reason : `socket closed (${code})`);
        return;
    }
  }

  private retryLater(error: string, floorMs = RECONNECT_MIN_MS): void {
    if (this.stopped) return;
    this.attempt += 1;
    const backoff = Math.min(RECONNECT_MIN_MS * 2 ** (this.attempt - 1), RECONNECT_MAX_MS);
    const jittered = Math.round(Math.max(backoff, floorMs) * (0.8 + Math.random() * 0.4));
    this.setPhase("waiting", error);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, jittered);
  }

  /**
   * Replace the socket before its token expires.
   *
   * The daemon closes a stream once `now > exp + leeway`, checked on the ping
   * tick it already runs. Rather than wait to be closed and reconnect after a
   * failure, the client opens a replacement while the current socket is still
   * live and healthy — so the visible behaviour of a token expiring is nothing at
   * all.
   *
   * Re-authenticating over the existing socket was the alternative and is not
   * available: the daemon's WS is read-only, and `ws.send()` into a half-open
   * socket succeeds silently, so an auth refresh that evaporated would leave a
   * client that believes it is connected right up until the close.
   */
  private scheduleRotation(overrideMs?: number): void {
    if (this.rotateTimer !== null) clearTimeout(this.rotateTimer);
    this.rotateTimer = null;
    if (this.stopped) return;

    let delay = overrideMs;
    if (delay === undefined) {
      const expiresAt = this.machine.tokenExpiresAt();
      // Null under a shared secret: that token never expires, so neither does the
      // socket, and there is nothing to rotate.
      if (expiresAt === null) return;
      delay = expiresAt - SOCKET_ROTATE_MARGIN_MS - Date.now();
    }

    this.rotateTimer = setTimeout(
      () => {
        this.rotateTimer = null;
        void this.rotate();
      },
      Math.max(delay, 1_000),
    );
  }

  private async rotate(): Promise<void> {
    if (this.stopped || this.socket === null || this.successor !== null) return;

    let token: string;
    let route: Route | null;
    try {
      token = await this.machine.ensureToken();
      route = this.machine.currentRoute() ?? (await this.machine.resolveRoute());
    } catch {
      // Could not get a fresh token — the control plane is probably down. The
      // current socket is still live until the daemon closes it, and that close
      // is handled. Try again before then.
      this.scheduleRotation(ROTATE_RETRY_MS);
      return;
    }
    if (route === null || this.stopped || this.socket === null) {
      this.scheduleRotation(ROTATE_RETRY_MS);
      return;
    }

    this.successor = this.open(token, route, this.generation, true);
  }
}

function closeQuietly(socket: WebSocket | null): void {
  if (socket === null) return;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  try {
    socket.close();
  } catch {
    // Already closing or closed. Nothing here needs to know.
  }
}
