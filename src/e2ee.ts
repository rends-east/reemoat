import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";
import {
  FRAME,
  LengthReader,
  MAX_FRAME_PAYLOAD,
  MessageAssembler,
  NoiseHandshake,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrames,
  frameLength,
  tryEncodeJsonFrame,
  type CipherState,
  type CloseFrame,
  type OpenFrame,
  type RequestFrame,
  type StaticKey,
} from "@reemoat/protocol";
import type { TokenVerifier } from "./auth.js";
import { jwkThumbprint, x25519Jwk } from "./token.js";

// The daemon's end of an encrypted session: Noise_IK responder, capability bound to the handshake key, requests proxied to loopback.
// There is no unencrypted path: a failed handshake or refused capability destroys the stream.

/** How long one relayed request may sit without the daemon answering. */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

const BODY_CHUNK_BYTES = MAX_FRAME_PAYLOAD;

/** How long a refusal may take to flush before teardown, so a peer that stops reading cannot pin an upstream. */
const FAIL_FLUSH_TIMEOUT_MS = 2_000;

/** RFC 9110 token, checked because http.request throws on a bad method or header name and that would wedge the frame loop. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Node's own header-value set: no CR, LF, NUL or other control characters (request smuggling). */
const HTTP_FIELD_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/;

/** Refused: an app-written content-length lets a second request ride in on the body onto the loopback socket. */
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding"]);

/** `ws` throws a `RangeError` above this: a close reason rides in a control frame. */
const MAX_CLOSE_REASON_BYTES = 123;

/** Whether ws takes this as a close code rather than throwing; tracks the registered range, one code narrower than ws. */
function isCloseCode(code: unknown): code is number {
  if (typeof code !== "number" || !Number.isInteger(code)) return false;
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1013 && code !== 1004 && code !== 1005 && code !== 1006;
}

export type SecureEventKind = "handshake_failed" | "refused" | "crypto_failure" | "opened" | "closed";

export interface SecureSessionOptions {
  stream: Duplex;
  staticKey: StaticKey;
  verifier: TokenVerifier;
  local: { host: string; port: number };
  /** Bounds both a request left unanswered and a dial that never opens; a seam so a driver need not wait two minutes. */
  upstreamTimeoutMs?: number;
  onEvent?: (kind: SecureEventKind, detail: string) => void;
}

export function serveSecureSession(options: SecureSessionOptions): void {
  new SecureSession(options);
}

class SecureSession {
  private readonly reader = new LengthReader();
  private readonly handshake: NoiseHandshake;
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private peerThumbprint: string | null = null;
  private capability: string | null = null;
  private authorized = false;
  private closed = false;
  /** Refused but not yet torn down: only the FAILED frame may still go out, and queued frames are no longer dispatched. */
  private failed = false;

  /**
   * One request or one socket per connection, enforced here because this is the trust boundary.
   * Back to none when the answer or socket ends, so the app's pool can reuse the connection.
   */
  private carrying: "none" | "request" | "socket" = "none";

  private upstream: IncomingMessage | null = null;
  /** Held from creation and destroyed when the answer ends: an unended request keeps its loopback socket open, and the idle bound no longer covers it. */
  private upstreamRequest: ClientRequest | null = null;
  private socket: WebSocket | null = null;
  /** Fresh per socket; null means no socket, so a MESSAGE racing our CLOSE is ignored rather than refused. */
  private assembler: MessageAssembler | null = null;
  private requestBody: ((chunk: Uint8Array | null) => void) | null = null;

  /** Serializes everything touching Noise state: two concurrent readers advance the nonce and fail as a tag mismatch. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SecureSessionOptions) {
    this.handshake = NoiseHandshake.start({ initiator: false, staticKey: options.staticKey });

    options.stream.on("data", (chunk: Buffer) => {
      this.queue = this.queue.then(() => this.consume(chunk)).catch(() => {
        // Backstop: consume answers its own failures, so this only keeps an unexpected throw from becoming an unhandled rejection.
        this.destroy("the frame loop failed");
      });
    });
    options.stream.on("error", () => this.destroy("stream error"));
    options.stream.on("close", () => this.destroy("stream closed"));
  }

  private emit(kind: SecureEventKind, detail: string): void {
    this.options.onEvent?.(kind, detail);
  }

  /** Destroy, never end: ending would submit a partial body to the listener as though complete. */
  private destroy(detail: string): void {
    if (this.closed) return;
    this.closed = true;
    this.requestBody = null;
    this.carrying = "none";
    this.upstreamRequest?.destroy();
    this.upstreamRequest = null;
    this.upstream?.destroy();
    this.upstream = null;
    this.socket?.terminate();
    this.socket = null;
    this.assembler = null;
    this.options.stream.destroy();
    this.emit("closed", detail);
  }

  /** After a refusal nothing goes out but the refusal itself, which fail writes through sealAndWrite. */
  private write(frame: Uint8Array): void {
    if (this.failed) return;
    this.sealAndWrite(frame);
  }

  /** Never throws upward; a write failure ends the session. */
  private sealAndWrite(frame: Uint8Array): void {
    if (this.closed || this.send === null) return;
    try {
      this.options.stream.write(frameLength(this.send.encrypt(new Uint8Array(0), frame)));
    } catch {
      this.destroy("could not write to the stream");
    }
  }

  /** Refuse and let the frame flush (end, not destroy): a lost refusal reads as a transport failure and is retried (Q6.103). */
  private fail(code: number, reason: string): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.requestBody = null;
    this.sealAndWrite(encodeJsonFrame(FRAME.FAILED, { code, reason } satisfies CloseFrame));
    this.options.stream.end();
    this.options.stream.once("close", () => this.destroy(reason));
    setTimeout(() => this.destroy(reason), FAIL_FLUSH_TIMEOUT_MS).unref();
  }

  private async consume(chunk: Buffer): Promise<void> {
    if (this.closed) return;
    let messages: Uint8Array[];
    try {
      messages = this.reader.push(new Uint8Array(chunk));
    } catch {
      this.destroy("unframeable bytes");
      return;
    }

    for (const message of messages) {
      if (this.closed || this.failed) return;
      if (this.send === null) {
        await this.doHandshake(message);
        continue;
      }
      let frame: Uint8Array;
      try {
        frame = this.receive!.decrypt(new Uint8Array(0), message);
      } catch {
        // A tag failure destroys the session and sends nothing: there is no key the peer would trust.
        this.emit("crypto_failure", "a frame failed to authenticate");
        this.destroy("bad ciphertext");
        return;
      }
      this.dispatch(frame);
    }
  }

  private async doHandshake(message: Uint8Array): Promise<void> {
    try {
      await this.handshake.readMessage(message);
      const reply = await this.handshake.writeMessage();
      this.options.stream.write(frameLength(reply));
      const transport = this.handshake.split();
      this.send = transport.send;
      this.receive = transport.receive;
      const remote = this.handshake.remoteStaticKey;
      if (remote === null) throw new Error("no peer key");
      this.peerThumbprint = jwkThumbprint(x25519Jwk(remote));
    } catch (error) {
      this.emit("handshake_failed", error instanceof Error ? error.message : String(error));
      this.destroy("handshake failed");
    }
  }

  /** Nothing here may unwind the frame loop: a throw would silently discard every frame behind it. */
  private dispatch(frame: Uint8Array): void {
    try {
      this.handle(frame);
    } catch (error) {
      this.emit("refused", error instanceof Error ? error.message : String(error));
      this.fail(400, "unusable frame");
    }
  }

  private handle(frame: Uint8Array): void {
    const decoded = decodeFrame(frame);
    if (decoded === null) return this.fail(400, "empty frame");

    if (!this.authorized) {
      if (decoded.type !== FRAME.HELLO) return this.fail(401, "the first frame must present a capability");
      const hello = decodeJson<{ capability: string }>(decoded.payload);
      if (hello === null || typeof hello.capability !== "string") return this.fail(400, "unreadable capability");

      // The capability must name the key this handshake authenticated; one copied from another device is refused.
      const verified = this.options.verifier.verify(hello.capability, Date.now(), {
        peerKeyThumbprint: this.peerThumbprint,
      });
      if (!verified.ok) {
        this.emit("refused", verified.code);
        return this.fail(401, verified.code);
      }
      this.authorized = true;
      this.capability = hello.capability;
      this.write(encodeFrame(FRAME.READY));
      this.emit("opened", verified.principal.deviceId ?? verified.principal.subject);
      return;
    }

    switch (decoded.type) {
      case FRAME.REQUEST:
        if (this.carrying !== "none") return this.fail(400, "this connection is already carrying something");
        return this.startRequest(decoded.payload);
      // Late body frames are ignored, not refused: a listener may answer before reading the body while the app keeps sending.
      // Safe because the finished request is destroyed on end; a body frame on a socket connection is still refused.
      case FRAME.REQUEST_BODY:
        if (this.carrying === "socket") return this.fail(400, "this connection is carrying a socket");
        if (this.requestBody === null) return;
        this.requestBody(decoded.payload);
        return;
      case FRAME.REQUEST_END:
        if (this.carrying === "socket") return this.fail(400, "this connection is carrying a socket");
        if (this.requestBody === null) return;
        this.requestBody(null);
        this.requestBody = null;
        return;
      case FRAME.OPEN:
        if (this.carrying !== "none") return this.fail(400, "this connection is already carrying something");
        return this.openSocket(decoded.payload);
      case FRAME.MESSAGE: {
        if (this.assembler === null) return;
        if (!this.assembler.push(decoded.payload)) return this.fail(400, "socket message too large");
        return;
      }
      // MESSAGE_END alone says a message is whole; bytes are forwarded undecoded, so a split UTF-8 sequence survives.
      case FRAME.MESSAGE_END: {
        if (this.assembler === null) return;
        const whole = this.assembler.end();
        if (whole === null) return this.fail(400, "socket message too large");
        // ws send throws before the socket is open, and the peer controls that window.
        if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
          return this.fail(400, "a message arrived before the socket was open");
        }
        this.socket.send(whole);
        return;
      }
      case FRAME.CLOSE: {
        const close = decodeJson<CloseFrame>(decoded.payload);
        // Code and reason are both validated before ws sees them, since ws throws on either; refused rather than clamped.
        const code = close?.code ?? 1000;
        const reason = close?.reason ?? "";
        if (!isCloseCode(code)) return this.fail(400, "unusable close code");
        if (typeof reason !== "string" || Buffer.byteLength(reason, "utf8") > MAX_CLOSE_REASON_BYTES) {
          return this.fail(400, "unusable close reason");
        }
        this.socket?.close(code, reason);
        return;
      }
      default:
        return this.fail(400, `unexpected frame ${decoded.type}`);
    }
  }

  /**
   * Resolves an app-chosen path against the loopback listener and compares origins, because the join alone is not the check (SSRF).
   * Callers send the resolved path, never the app's string.
   */
  private loopback(scheme: "http" | "ws", path: string): URL | null {
    if (!path.startsWith("/") || path.startsWith("//")) return null;
    const host = this.options.local.host.includes(":")
      ? `[${this.options.local.host}]`
      : this.options.local.host;
    const base = `${scheme}://${host}:${this.options.local.port}`;
    try {
      const origin = new URL(base).origin;
      const target = new URL(path, base);
      return target.origin === origin ? target : null;
    } catch {
      return null;
    }
  }

  private startRequest(payload: Uint8Array): void {
    const wanted = decodeJson<RequestFrame>(payload);
    if (wanted === null || typeof wanted.method !== "string" || typeof wanted.path !== "string") {
      return this.fail(400, "unreadable request");
    }
    if (!HTTP_TOKEN.test(wanted.method)) return this.fail(400, "unreadable request");
    const target = this.loopback("http", wanted.path);
    if (target === null) return this.fail(400, "unreadable request");

    // The inner credential is always the one this session authenticated; a client-supplied one is replaced, never merged.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(wanted.headers ?? {})) {
      const lowered = name.toLowerCase();
      if (lowered === "authorization") continue;
      if (typeof value !== "string" || !HTTP_TOKEN.test(name) || !HTTP_FIELD_VALUE.test(value)) {
        return this.fail(400, "unreadable request");
      }
      if (FRAMING_HEADERS.has(lowered)) return this.fail(400, "unreadable request");
      headers[name] = value;
    }
    if (this.capability !== null) headers["authorization"] = `Bearer ${this.capability}`;

    let upstream: ClientRequest;
    try {
      upstream = httpRequest({
        host: this.options.local.host,
        port: this.options.local.port,
        method: wanted.method,
        path: `${target.pathname}${target.search}`,
        headers,
      });
    } catch {
      return this.fail(400, "unreadable request");
    }
    this.carrying = "request";
    this.upstreamRequest = upstream;

    // Destroyed with an error: a ClientRequest destroyed without one emits no error event.
    upstream.setTimeout(this.options.upstreamTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS, () =>
      upstream.destroy(new Error("upstream idle")),
    );
    upstream.on("error", () => this.fail(502, "tunnel_failed"));

    upstream.on("response", (response) => {
      this.upstream = response;
      const answered: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        answered[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      // These headers are the listener's, so encoding may fail, and this listener is outside the frame loop's try.
      const head = tryEncodeJsonFrame(FRAME.RESPONSE, {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers: answered,
      });
      if (head === null) return this.fail(502, "the answer's head is too large to carry");
      this.write(head);

      const resumeResponse = (): void => {
        response.resume();
      };

      response.on("data", (chunk: Buffer) => {
        for (let at = 0; at < chunk.length; at += BODY_CHUNK_BYTES) {
          this.write(encodeFrame(FRAME.RESPONSE_BODY, chunk.subarray(at, at + BODY_CHUNK_BYTES)));
        }
        // Backpressure: pausing the loopback response carries a shut h2 window back to the daemon's outbound queue.
        if (this.options.stream.writableLength > BODY_CHUNK_BYTES * 8) {
          response.pause();
          this.options.stream.once("drain", resumeResponse);
        }
      });
      response.on("end", () => {
        this.upstream = null;
        this.options.stream.off("drain", resumeResponse);
        this.requestBody = null;
        this.carrying = "none";
        // complete separates an answer from a truncation: a short body must reach the app as a failure.
        if (response.complete) this.write(encodeFrame(FRAME.RESPONSE_END));
        else this.fail(502, "truncated");
        // The answer ending does not end the request: destroy an unended one after RESPONSE_END (never end it, which submits the partial body).
        if (!upstream.writableEnded) upstream.destroy();
        this.upstreamRequest = null;
      });
      response.on("error", () => this.fail(502, "tunnel_failed"));
    });

    if (wanted.body) {
      // Upload backpressure: pause the relay stream while the loopback request buffers, resume on drain or close.
      let paused = false;
      const resume = (): void => {
        if (!paused) return;
        paused = false;
        this.options.stream.resume();
      };
      // close is registered once, not per pause, or listeners accumulate past maxListeners.
      upstream.once("close", resume);
      this.requestBody = (chunk) => {
        if (chunk === null) {
          upstream.end();
          return;
        }
        if (upstream.write(chunk) || paused) return;
        paused = true;
        this.options.stream.pause();
        upstream.once("drain", resume);
      };
    } else {
      this.requestBody = null;
      upstream.end();
    }
  }

  private openSocket(payload: Uint8Array): void {
    const wanted = decodeJson<OpenFrame>(payload);
    if (wanted === null || typeof wanted.path !== "string") return this.fail(400, "unreadable open");
    const target = this.loopback("ws", wanted.path);
    if (target === null) return this.fail(400, "unreadable open");

    // Inside the channel the credential travels as a header, so no query-string token on this hop.

    // followRedirects stays off explicitly: a redirect would bypass the origin check.
    let socket: WebSocket;
    try {
      socket = new WebSocket(target, {
        followRedirects: false,
        headers: this.capability === null ? {} : { authorization: `Bearer ${this.capability}` },
      });
    } catch {
      return this.fail(400, "unreadable open");
    }
    this.carrying = "socket";
    this.socket = socket;
    this.assembler = new MessageAssembler();

    // Bounds a dial that connects and never upgrades, which would wedge the connection. ws handshakeTimeout is not used:
    // it measures inactivity and surfaces as a generic tunnel_failed. An open socket stays unbounded.
    const dialBound = this.options.upstreamTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
    const dialTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.CONNECTING) return;
      this.fail(502, "the socket never opened");
    }, dialBound);
    dialTimer.unref();

    socket.on("open", () => {
      clearTimeout(dialTimer);
      this.write(encodeFrame(FRAME.OPENED));
    });
    // MESSAGE chunks then MESSAGE_END: without the terminator each chunk would arrive as its own message.
    // This direction pauses too, or bytes pile up in the relay Duplex's unbounded buffer.
    let socketPaused = false;
    const resumeSocket = (): void => {
      if (!socketPaused) return;
      socketPaused = false;
      socket.resume();
    };
    // Once per socket and removed on close, or OPEN/CLOSE cycles accumulate listeners.
    this.options.stream.once("close", resumeSocket);
    socket.on("message", (data: Buffer) => {
      for (const frame of encodeMessageFrames(data)) this.write(frame);
      if (socketPaused || this.options.stream.writableLength <= BODY_CHUNK_BYTES * 8) return;
      socketPaused = true;
      socket.pause();
      this.options.stream.once("drain", resumeSocket);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      clearTimeout(dialTimer);
      this.write(encodeJsonFrame(FRAME.CLOSE, { code, reason: reason.toString("utf8") } satisfies CloseFrame));
      this.socket = null;
      // A part-assembled message is dropped with the socket, never delivered.
      this.assembler = null;
      this.carrying = "none";
      this.options.stream.off("close", resumeSocket);
      this.options.stream.off("drain", resumeSocket);
    });
    socket.on("error", () => this.fail(502, "tunnel_failed"));
  }
}
