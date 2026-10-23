import {
  FRAME,
  LengthReader,
  MAX_FRAME_PAYLOAD,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  frameLength,
  type CloseFrame,
  type HelloFrame,
  type ResponseFrame,
} from "./frames.js";
import { NoiseHandshake, type CipherState, type StaticKey } from "./noise.js";

// One request over one channel, as the initiator: the handshake, the capability in HELLO, one REQUEST and its answer.
// No transport here: whoever owns the socket hands bytes in and sends the bytes handed out.

/** What carries the channel's bytes; framed already, so a carrier that delivers messages or bytes both work. */
export interface ChannelCarrier {
  send(bytes: Uint8Array): void;
}

export interface ChannelRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
}

export type ChannelOutcome =
  | { kind: "answered"; status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }
  /** A FAILED frame: before READY it is the capability or the device refused, and nothing was sent. */
  | { kind: "refused"; status: number | null; reason: string; requestSent: boolean }
  | { kind: "handshake_failed"; requestSent: false }
  | { kind: "crypto_failure"; requestSent: boolean }
  | { kind: "too_large"; requestSent: true }
  | { kind: "unusable"; reason: string; requestSent: boolean }
  /** `handshaken` false: the responder never answered the handshake, which is also how one holding another key answers (e2ee.md). */
  | { kind: "closed"; requestSent: boolean; handshaken: boolean }
  | { kind: "aborted"; reason: string; requestSent: boolean; handshaken: boolean };

export interface ChannelExchangeOptions {
  staticKey: StaticKey;
  /** The machine's key: reaching the transport phase is proof it answered, there being no name to check. */
  remoteStatic: Uint8Array;
  hello: HelloFrame;
  request: ChannelRequest;
  carrier: ChannelCarrier;
  maxResponseBytes: number;
}

/** Refused here before anything is sent: the responder refuses them too, and a framing header would let a second request ride the body. */
const LOCAL_ONLY_HEADERS = new Set(["content-length", "transfer-encoding", "authorization"]);
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const EMPTY = new Uint8Array(0);

/** Whether the responder would take this request at all; a sentence when it would not, so a caller's bug is not spent on a dial. */
export function requestProblem(request: ChannelRequest): string | null {
  if (!HTTP_TOKEN.test(request.method)) return `${JSON.stringify(request.method)} is not an HTTP method`;
  if (!request.path.startsWith("/")) return "a path starts with /";
  for (const name of Object.keys(request.headers ?? {})) {
    if (!HTTP_TOKEN.test(name)) return `${JSON.stringify(name)} is not a header name`;
    if (LOCAL_ONLY_HEADERS.has(name.toLowerCase())) return `${name} is the channel's, never the request's`;
  }
  return null;
}

export class ChannelExchange {
  readonly outcome: Promise<ChannelOutcome>;
  private settleWith!: (outcome: ChannelOutcome) => void;
  private settled = false;
  private readonly reader = new LengthReader();
  private readonly handshake: NoiseHandshake;
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private answerRead = false;
  private requestSent = false;
  private head: ResponseFrame | null = null;
  private readonly chunks: Uint8Array[] = [];
  private received = 0;

  private constructor(private readonly options: ChannelExchangeOptions) {
    this.outcome = new Promise((resolve) => (this.settleWith = resolve));
    this.handshake = NoiseHandshake.start({ initiator: true, staticKey: options.staticKey, remoteStatic: options.remoteStatic });
  }

  /** Throws on a request the responder would refuse; call `opened` once the carrier is up. */
  static start(options: ChannelExchangeOptions): ChannelExchange {
    const problem = requestProblem(options.request);
    if (problem !== null) throw new Error(problem);
    if (options.remoteStatic.length !== 32) throw new Error("a machine key is 32 bytes");
    return new ChannelExchange(options);
  }

  get done(): boolean {
    return this.settled;
  }

  opened(): void {
    if (this.settled) return;
    void this.handshake
      .writeMessage()
      .then((first) => this.options.carrier.send(frameLength(first)))
      .catch(() => this.settle({ kind: "handshake_failed", requestSent: false }));
  }

  receiveBytes(chunk: Uint8Array): void {
    if (this.settled) return;
    for (const message of this.reader.push(chunk)) {
      if (this.settled) return;
      if (this.send === null) {
        this.finishHandshake(message);
        continue;
      }
      let frame: { type: number; payload: Uint8Array } | null;
      try {
        frame = decodeFrame(this.receive!.decrypt(EMPTY, message));
      } catch {
        this.settle({ kind: "crypto_failure", requestSent: this.requestSent });
        return;
      }
      if (frame !== null) this.onFrame(frame.type, frame.payload);
    }
  }

  /** The carrier ended; an answer not already whole is not one. */
  closed(): void {
    this.settle({ kind: "closed", requestSent: this.requestSent, handshaken: this.send !== null });
  }

  /** The owner's own reason to stop, a timeout or a shutdown. */
  abort(reason: string): void {
    this.settle({ kind: "aborted", reason, requestSent: this.requestSent, handshaken: this.send !== null });
  }

  private finishHandshake(message: Uint8Array): void {
    // IK has one answer: anything before it is split is a responder speaking out of turn.
    if (this.answerRead) return this.settle({ kind: "handshake_failed", requestSent: false });
    this.answerRead = true;
    void this.handshake
      .readMessage(message)
      .then(() => {
        const transport = this.handshake.split();
        this.send = transport.send;
        this.receive = transport.receive;
        this.write(encodeJsonFrame(FRAME.HELLO, this.options.hello));
      })
      .catch(() => this.settle({ kind: "handshake_failed", requestSent: false }));
  }

  private onFrame(type: number, payload: Uint8Array): void {
    switch (type) {
      case FRAME.READY:
        return this.sendRequest();
      case FRAME.RESPONSE: {
        const head = decodeJson<ResponseFrame>(payload);
        if (head === null || typeof head.status !== "number") return this.settle({ kind: "unusable", reason: "unreadable response", requestSent: true });
        this.head = { status: head.status, statusText: typeof head.statusText === "string" ? head.statusText : "", headers: stringHeaders(head.headers) };
        return;
      }
      case FRAME.RESPONSE_BODY:
        this.received += payload.length;
        if (this.received > this.options.maxResponseBytes) return this.settle({ kind: "too_large", requestSent: true });
        this.chunks.push(payload.slice());
        return;
      case FRAME.RESPONSE_END: {
        if (this.head === null) return this.settle({ kind: "unusable", reason: "an answer with no head", requestSent: true });
        const body = new Uint8Array(this.received);
        let at = 0;
        for (const chunk of this.chunks) {
          body.set(chunk, at);
          at += chunk.length;
        }
        return this.settle({ kind: "answered", ...this.head, body });
      }
      case FRAME.FAILED: {
        const failed = decodeJson<CloseFrame>(payload);
        const code = failed?.code;
        const status = typeof code === "number" && Number.isInteger(code) && code >= 400 && code < 600 ? code : null;
        return this.settle({ kind: "refused", status, reason: typeof failed?.reason === "string" ? failed.reason : "refused", requestSent: this.requestSent });
      }
      default:
        return this.settle({ kind: "unusable", reason: `unexpected frame ${type}`, requestSent: this.requestSent });
    }
  }

  private sendRequest(): void {
    if (this.requestSent) return;
    const { method, path, headers = {}, body = null } = this.options.request;
    this.requestSent = true;
    this.write(encodeJsonFrame(FRAME.REQUEST, { method, path, headers, body: body !== null }));
    if (body === null) return;
    for (let at = 0; at < body.length; at += MAX_FRAME_PAYLOAD) {
      this.write(encodeFrame(FRAME.REQUEST_BODY, body.subarray(at, at + MAX_FRAME_PAYLOAD)));
    }
    this.write(encodeFrame(FRAME.REQUEST_END));
  }

  private write(frame: Uint8Array): void {
    if (this.settled) return;
    this.options.carrier.send(frameLength(this.send!.encrypt(EMPTY, frame)));
  }

  private settle(outcome: ChannelOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.settleWith(outcome);
  }
}

function stringHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [name, one] of Object.entries(value as Record<string, unknown>)) {
    if (typeof one === "string") out[name.toLowerCase()] = one;
  }
  return out;
}
