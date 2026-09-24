import type { StreamSocket } from "./e2ee";
import type { SessionId, SessionRef } from "./ids";
import { SOCKET_ROTATE_MARGIN_MS, describe, type MachineConnection, type Route } from "./machine";
import type { LaggedFrame, SessionSnapshot, StoredEvent, StreamFrame } from "./wire";

// Resuming from lastAppliedSeq fills a gap exactly once: the daemon reads seq greater than since, and attaches with no await between backlog and subscribe.

const CLOSE_SESSION_NOT_FOUND = 4404;
const CLOSE_TOKEN_EXPIRED = 4401;
const CLOSE_SLOW_CONSUMER = 4003;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const SLOW_CONSUMER_BACKOFF_MS = 5_000;
const CONNECT_SETTLE_MS = 2_000;
/** Must stay shorter than the rotation margin: the current socket lives until the token's exp plus leeway. */
const ROTATE_RETRY_MS = 15_000;

export type StreamPhase = "idle" | "connecting" | "live" | "waiting" | "closed";

export interface StreamStatus {
  phase: StreamPhase;
  lastAppliedSeq: number;
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
  onVanished(ref: SessionRef): void;
}

export class SessionStream {
  readonly ref: SessionRef;

  private socket: StreamSocket | null = null;
  private successor: StreamSocket | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private lastAppliedSeq = 0;
  private instanceId: string | null = null;
  private phase: StreamPhase = "idle";
  private error: string | null = null;
  private attempt = 0;
  private stopped = false;
  private connectStartedAt = 0;
  /** Bumped on every deliberate reconnect; frames and closes from a stale generation are ignored. */
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

  /** Tears down first, since a slept socket is dead but unreported; a young pending connect is left alone. */
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
      token = await this.machine.ensureToken();
      route = await this.machine.resolveRoute();
    } catch (error) {
      return this.retryLater(describe(error));
    }
    if (route === null) return this.retryLater("no route to this machine");
    if (this.stopped) return;

    // Drop an in-flight successor before the generation moves, or its silenced onclose leaves it set and rotation stops for good.
    closeQuietly(this.successor);
    this.successor = null;

    const generation = ++this.generation;
    const socket = this.open(token, route, generation, false);
    this.socket = socket;
  }

  private open(token: string, route: Route, generation: number, isSuccessor: boolean): StreamSocket {
    const socket = this.machine.openStream(this.ref.sessionId as SessionId, this.lastAppliedSeq, token, route);

    socket.onmessage = (message): void => {
      if (generation !== this.generation) return;
      if (typeof message.data !== "string") return;
      let frame: StreamFrame;
      try {
        frame = JSON.parse(message.data) as StreamFrame;
      } catch {
        // Unparseable: the cursor is unchanged, so the next reconnect replays it.
        return;
      }
      this.apply(frame, socket, isSuccessor);
    };

    socket.onerror = (): void => {
      // Always followed by close, which handles it.
    };

    socket.onclose = (event): void => {
      if (generation !== this.generation) return;
      if (isSuccessor && this.successor === socket) {
        this.successor = null;
        this.scheduleRotation(ROTATE_RETRY_MS);
        return;
      }
      this.socket = null;
      this.handleClose(event.code, event.reason);
    };

    return socket;
  }

  private apply(frame: StreamFrame, socket: StreamSocket, isSuccessor: boolean): void {
    switch (frame.type) {
      case "hello": {
        if (isSuccessor) {
          // Close the old socket only here: any earlier leaves a window with neither socket live.
          closeQuietly(this.socket);
          this.socket = socket;
          this.successor = null;
        }
        this.instanceId = frame.instanceId;
        this.attempt = 0;
        // Never backwards: during a rotation the old socket has already moved the cursor past this socket's since.
        this.lastAppliedSeq = Math.max(this.lastAppliedSeq, frame.since);
        this.sink.onSnapshot(this.ref, frame.session);
        // Not turned into onGap: the daemon sends an explicit lagged frame right after.
        this.setPhase("live");
        this.scheduleRotation();
        return;
      }

      case "events": {
        const fresh: StoredEvent[] = [];
        for (const stored of frame.events) {
          // Rotation overlap: two sockets deliver the same seqs, and this skip makes it free.
          if (stored.seq <= this.lastAppliedSeq) continue;
          if (stored.seq !== this.lastAppliedSeq + 1) {
            // A hole means our cursor is wrong: deliver what is contiguous, then reconnect so the replay fills it.
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
        this.setPhase("live");
        return;

      case "lagged": {
        this.sink.onGap(this.ref, frame.from, frame.to, frame.reason);
        this.lastAppliedSeq = Math.max(this.lastAppliedSeq, frame.to);
        return;
      }

      case "error":
        this.setPhase(this.phase, `${frame.code}: ${frame.message}`);
        return;

      default:
        return;
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.stopped) return;
    this.clearTimers();

    switch (code) {
      case CLOSE_TOKEN_EXPIRED:
        // Not an error; the route is fine, so the memo is kept rather than re-probed.
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
        this.retryLater("dropped for falling behind", SLOW_CONSUMER_BACKOFF_MS);
        return;

      default:
        // A transport failure: the only close that drops the route memo.
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

  /** Opens a replacement before the token expires so expiry is invisible; the daemon's WS cannot re-authenticate in place. */
  private scheduleRotation(overrideMs?: number): void {
    if (this.rotateTimer !== null) clearTimeout(this.rotateTimer);
    this.rotateTimer = null;
    if (this.stopped) return;

    let delay = overrideMs;
    if (delay === undefined) {
      const expiresAt = this.machine.tokenExpiresAt();
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
      // No fresh token: the current socket stays live until the daemon closes it, so retry before then.
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

function closeQuietly(socket: StreamSocket | null): void {
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
