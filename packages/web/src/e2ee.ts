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
  frameLength,
  type CipherState,
  type CloseFrame,
  type ResponseFrame,
  type StaticKey,
} from "@reemoat/protocol";
// Import cycle with machine.ts: read MAX_DOWNLOAD_BYTES only inside handlers, since a module-level alias would throw in the TDZ.
import { MAX_DOWNLOAD_BYTES } from "./machine";
import { hostDeviceDh, nativeBoot } from "./native";

/** Must equal the relay listener's RELAY_CHANNEL_PATH; webcheck.e2ee.ts is what compares the two. */
export const RELAY_CHANNEL_PATH = "/__relay/channel";

const BODY_CHUNK_BYTES = MAX_FRAME_PAYLOAD;

// Upload progress comes from this: a chunk counts once the socket has taken it.
const SEND_HIGH_WATER_BYTES = 512 * 1024;

const DRAIN_POLL_MS = 25;

const CHANNEL_READY_TIMEOUT_MS = 20_000;

const MAX_IDLE_CONNECTIONS = 2;

// Decides only whether an idle connection is reused: its HELLO capability is pinned to every request it carries (Q5.24).
const REUSE_MARGIN_MS = 30_000;

// No Buffer here, since the package compiles with no Node types; unpadded URL-safe base64, as the rest of the fleet speaks.

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at);
    return out;
  } catch {
    return null;
  }
}

/** The daemon refusing the channel: the only error thrown from this module that is not a transport failure. */
export class ChannelRefused extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(`the daemon refused this channel: ${reason}`);
    this.name = "ChannelRefused";
    this.status = status;
    this.reason = reason;
  }

  static is(error: unknown): error is ChannelRefused {
    return error instanceof ChannelRefused;
  }
}

export interface ChannelRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
  onProgress?: ((fraction: number) => void) | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

export interface ChannelResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The four WebSocket members stream.ts uses, typed with DOM events so a real WebSocket satisfies it (Q5.75). */
export interface StreamSocket {
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

/** A seam for drivers, not a switch: MachineChannel is the only implementation that ships. */
export interface Channel {
  request(wanted: ChannelRequest): Promise<ChannelResponse>;
  openSocket(path: string): StreamSocket;
  dispose(): void;
}

export type ChannelFactory = (options: ChannelOptions) => Channel;

export const openChannel: ChannelFactory = (options) => new MachineChannel(options);

export interface ChannelOptions {
  relayUrl: string;
  machineKey: string;
  /** A live capability and the instant it dies, on this device's clock. */
  credential: () => Promise<{ token: string; expiresAt: number }>;
  /** Called at most once per channel, and only for wrong_device. */
  onWrongDevice: () => Promise<void>;
  /** Defaults to deviceStaticKey; a parameter only so a driver can hold a real key. */
  deviceKey?: () => StaticKey | null;
}

/** Only dh crosses the bridge: the private half stays in the shell. */
function deviceStaticKey(): StaticKey | null {
  const boot = nativeBoot();
  const encoded = boot?.devicePublicKey ?? null;
  if (encoded === null) return null;
  const publicKey = fromBase64Url(encoded);
  if (publicKey === null || publicKey.length !== 32) return null;
  return {
    publicKey,
    async dh(peer: Uint8Array): Promise<Uint8Array> {
      const shared = fromBase64Url(await hostDeviceDh(toBase64Url(peer)));
      if (shared === null || shared.length !== 32) throw new Error("the shell answered an unusable shared secret");
      return shared;
    },
  };
}

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Waiter<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

type Carrying =
  | { kind: "none" }
  | {
      kind: "request";
      waiter: Waiter<ChannelResponse>;
      head: ResponseFrame | null;
      chunks: Uint8Array[];
      bytes: number;
    }
  | { kind: "socket"; sink: ChannelSocket };

class Connection {
  private readonly socket: WebSocket;
  private readonly reader = new LengthReader();
  private readonly handshake: NoiseHandshake;
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private carrying: Carrying = { kind: "none" };

  // Serializes all Noise work: DH steps await the bridge, and two readers on one CipherState would race its nonce.
  private queue: Promise<void> = Promise.resolve();

  private readyWaiters: Waiter<void>[] = [];
  private isReady = false;
  private failure: Error | null = null;
  private closed = false;

  constructor(
    url: string,
    staticKey: StaticKey,
    remoteStatic: Uint8Array,
    private readonly capability: string,
    readonly expiresAt: number,
    // Pool bookkeeping hangs off this one callback, because there are too many close sites to maintain it at each.
    private readonly onClosed: () => void,
  ) {
    this.handshake = NoiseHandshake.start({ initiator: true, staticKey, remoteStatic });
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = (): void => {
      this.run(async () => {
        this.raw(frameLength(await this.handshake.writeMessage()));
      });
    };
    this.socket.onmessage = (event): void => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const chunk = new Uint8Array(event.data);
      this.run(() => this.consume(chunk));
    };
    this.socket.onerror = (): void => {
      // Always followed by close, where the one handler lives.
    };
    this.socket.onclose = (): void => {
      this.fail(new Error("the channel closed"));
    };
  }

  get usable(): boolean {
    return !this.closed && this.failure === null && this.carrying.kind === "none";
  }

  get fresh(): boolean {
    return this.usable && this.isReady && Date.now() < this.expiresAt - REUSE_MARGIN_MS;
  }

  private run(step: () => Promise<void>): void {
    this.queue = this.queue.then(step).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  ready(): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.isReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /** Settles whatever was riding it. Idempotent, and never a verdict: that is fail's job. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.onmessage = null;
    this.socket.onclose = null;
    this.socket.onerror = null;
    this.socket.onopen = null;
    try {
      this.socket.close();
    } catch {
      // Already closing or closed. Nothing above needs to know.
    }
    const carrying = this.carrying;
    this.carrying = { kind: "none" };
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    const error = this.failure ?? new Error("the channel was closed");
    for (const waiter of waiters) waiter.reject(error);
    if (carrying.kind === "request") carrying.waiter.reject(error);
    if (carrying.kind === "socket") carrying.sink.transportEnded(error);
    this.onClosed();
  }

  /** Fatal by design, even for one bad frame: a diverged nonce never recovers. */
  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    const carrying = this.carrying;
    this.carrying = { kind: "none" };
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    this.close();
    for (const waiter of waiters) waiter.reject(error);
    if (carrying.kind === "request") carrying.waiter.reject(error);
    if (carrying.kind === "socket") carrying.sink.transportEnded(error);
  }

  private raw(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      // Every value here is a fresh array from frameLength, never one backed by a SharedArrayBuffer.
      this.socket.send(bytes as Uint8Array<ArrayBuffer>);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("could not write to the channel"));
    }
  }

  private write(frame: Uint8Array): void {
    // Check closed before encrypting, so a cancelled upload stops sealing chunks.
    if (this.closed) return;
    if (this.send === null) return this.fail(new Error("the channel is not established"));
    this.raw(frameLength(this.send.encrypt(EMPTY, frame)));
  }

  private async consume(chunk: Uint8Array): Promise<void> {
    if (this.closed || this.failure !== null) return;
    let messages: Uint8Array[];
    try {
      messages = this.reader.push(chunk);
    } catch {
      return this.fail(new Error("the channel sent unframeable bytes"));
    }

    for (const message of messages) {
      if (this.closed || this.failure !== null) return;
      if (this.send === null) {
        await this.finishHandshake(message);
        continue;
      }
      let frame: Uint8Array;
      try {
        frame = this.receive!.decrypt(EMPTY, message);
      } catch {
        return this.fail(new Error("a frame on this channel could not be authenticated"));
      }
      this.dispatch(frame);
    }
  }

  /** Reading IK's second message is the machine's authentication; there is no separate comparison. */
  private async finishHandshake(message: Uint8Array): Promise<void> {
    await this.handshake.readMessage(message);
    const transport = this.handshake.split();
    this.send = transport.send;
    this.receive = transport.receive;
    // The capability rides the first transport message, not IK's replayable first message.
    this.write(encodeJsonFrame(FRAME.HELLO, { capability: this.capability }));
  }

  private dispatch(frame: Uint8Array): void {
    const decoded = decodeFrame(frame);
    if (decoded === null) return this.fail(new Error("an empty frame arrived on this channel"));

    switch (decoded.type) {
      case FRAME.READY: {
        this.isReady = true;
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const waiter of waiters) waiter.resolve();
        return;
      }
      case FRAME.FAILED: {
        const close = decodeJson<CloseFrame>(decoded.payload);
        return this.fail(new ChannelRefused(close?.code ?? 502, close?.reason ?? "the channel failed"));
      }
      case FRAME.RESPONSE: {
        if (this.carrying.kind !== "request") return this.fail(new Error("a response arrived with nothing waiting"));
        const head = decodeJson<ResponseFrame>(decoded.payload);
        if (head === null) return this.fail(new Error("an unreadable response head arrived"));
        this.carrying.head = head;
        return;
      }
      case FRAME.RESPONSE_BODY: {
        if (this.carrying.kind !== "request") return;
        // Enforced as frames arrive, because by the time machine.ts checks the memory is spent. A plain Error, not a refusal.
        if (this.carrying.bytes + decoded.payload.length > MAX_DOWNLOAD_BYTES) {
          return this.fail(new Error("the answer to this request is larger than this client will hold"));
        }
        this.carrying.chunks.push(decoded.payload);
        this.carrying.bytes += decoded.payload.length;
        return;
      }
      case FRAME.RESPONSE_END: {
        if (this.carrying.kind !== "request") return;
        const carrying = this.carrying;
        const head = carrying.head;
        this.carrying = { kind: "none" };
        if (head === null) return this.fail(new Error("a response ended before it began"));
        const body = new Uint8Array(carrying.bytes);
        let at = 0;
        for (const part of carrying.chunks) {
          body.set(part, at);
          at += part.length;
        }
        carrying.waiter.resolve({
          status: head.status,
          statusText: head.statusText,
          headers: head.headers,
          body,
        });
        return;
      }
      case FRAME.OPENED: {
        if (this.carrying.kind === "socket") this.carrying.sink.opened();
        return;
      }
      // A MESSAGE frame is a chunk; only MESSAGE_END makes a message whole.
      case FRAME.MESSAGE: {
        if (this.carrying.kind !== "socket") return;
        if (this.carrying.sink.messageChunk(decoded.payload)) return;
        return this.fail(new Error("a socket message on this channel outgrew what may be reassembled"));
      }
      case FRAME.MESSAGE_END: {
        if (this.carrying.kind !== "socket") return;
        if (this.carrying.sink.messageEnd()) return;
        return this.fail(new Error("a socket message on this channel outgrew what may be reassembled"));
      }
      case FRAME.CLOSE: {
        if (this.carrying.kind !== "socket") return;
        const close = decodeJson<CloseFrame>(decoded.payload);
        const sink = this.carrying.sink;
        this.carrying = { kind: "none" };
        // Pass the daemon's close code through untouched: stream.ts's close-code table decides what happens next.
        sink.daemonClosed(close?.code ?? 1006, close?.reason ?? "");
        this.close();
        return;
      }
      default:
        return this.fail(new Error(`an unexpected frame ${String(decoded.type)} arrived on this channel`));
    }
  }

  private drain(): Promise<void> {
    if (this.closed || this.socket.bufferedAmount <= SEND_HIGH_WATER_BYTES) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (this.closed || this.failure !== null || this.socket.bufferedAmount <= SEND_HIGH_WATER_BYTES) {
          clearInterval(tick);
          resolve();
        }
      }, DRAIN_POLL_MS);
    });
  }

  async request(wanted: ChannelRequest): Promise<ChannelResponse> {
    await this.ready();
    if (this.carrying.kind !== "none") throw new Error("this channel is already carrying something");

    const body = wanted.body ?? null;
    const answer = new Promise<ChannelResponse>((resolve, reject) => {
      this.carrying = { kind: "request", waiter: { resolve, reject }, head: null, chunks: [], bytes: 0 };
    });

    this.write(
      encodeJsonFrame(FRAME.REQUEST, {
        method: wanted.method,
        path: wanted.path,
        headers: wanted.headers ?? {},
        body: body !== null && body.length > 0,
      }),
    );

    if (body !== null && body.length > 0) {
      // Exit on closed as well as failure: a cancel closes without failing.
      for (let at = 0; at < body.length; at += BODY_CHUNK_BYTES) {
        await this.drain();
        if (this.failure !== null) throw this.failure;
        if (this.closed) return await answer;
        this.write(encodeFrame(FRAME.REQUEST_BODY, body.subarray(at, at + BODY_CHUNK_BYTES)));
        wanted.onProgress?.(Math.min(1, (at + BODY_CHUNK_BYTES) / body.length));
      }
      this.write(encodeFrame(FRAME.REQUEST_END));
    }

    return await answer;
  }

  adopt(sink: ChannelSocket, path: string): void {
    this.carrying = { kind: "socket", sink };
    this.write(encodeJsonFrame(FRAME.OPEN, { path }));
  }
}

/** Constructed synchronously and connected later, like WebSocket; an early failure arrives as a 1006 close. */
class ChannelSocket implements StreamSocket {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private connection: Connection | null = null;
  private done = false;

  // A part-assembled message is abandoned on CLOSE or FAILED, never delivered (Q6.103).
  private readonly assembler = new MessageAssembler();

  constructor(open: Promise<Connection>, path: string) {
    open.then(
      (connection) => {
        if (this.done) {
          connection.close();
          return;
        }
        this.connection = connection;
        connection.adopt(this, path);
      },
      (error: unknown) => {
        this.transportEnded(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  close(): void {
    this.done = true;
    this.connection?.close();
    this.connection = null;
  }

  opened(): void {
    // Deliberately empty: stream.ts waits for the daemon's hello frame, not for an open event.
  }

  /** False once the message outgrows its bound. Holding views is safe only because each Noise message decrypts into a fresh array. */
  messageChunk(payload: Uint8Array): boolean {
    if (this.done) return true;
    return this.assembler.push(payload);
  }

  /** Concatenate, then decode once: a chunk boundary can split a UTF-8 sequence. */
  messageEnd(): boolean {
    if (this.done) return true;
    const whole = this.assembler.end();
    if (whole === null) return false;
    this.onmessage?.(new MessageEvent("message", { data: decoder.decode(whole) }));
    return true;
  }

  daemonClosed(code: number, reason: string): void {
    if (this.done) return;
    this.done = true;
    this.connection = null;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
  }

  transportEnded(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.connection = null;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006, reason: error.message, wasClean: false }));
  }
}

export class MachineChannel implements Channel {
  private readonly idle: Connection[] = [];

  // Every open connection, idle or in use, the live stream included; idle is not this set.
  private readonly live = new Set<Connection>();

  private recovered = false;

  constructor(private readonly options: ChannelOptions) {}

  /** Closes every connection, the live stream included; a disposed socket reaches stream.ts as a 1006. */
  dispose(): void {
    this.idle.length = 0;
    // A copy, because `close()` removes the connection from this set as it goes.
    for (const connection of [...this.live]) connection.close();
    this.live.clear();
  }

  /** Timeout and abort end the connection, since there is no cancel frame, and an abort rejects with an AbortError at once. */
  async request(wanted: ChannelRequest): Promise<ChannelResponse> {
    const connection = await this.acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: ((error: Error) => void) | null = null;
    const abort = (): void => {
      connection.close();
      cancel?.(new DOMException("the request was cancelled", "AbortError"));
    };
    try {
      const raced = new Promise<never>((_resolve, reject) => {
        cancel = reject;
        timer = setTimeout(() => {
          connection.close();
          reject(new Error("the request timed out"));
        }, wanted.timeoutMs);
      });
      wanted.signal?.addEventListener("abort", abort, { once: true });
      // A signal that fired during acquire never calls a listener added after it.
      if (wanted.signal?.aborted === true) abort();
      const answer = await Promise.race([connection.request(wanted), raced]);
      this.release(connection);
      return answer;
    } catch (error) {
      connection.close();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      wanted.signal?.removeEventListener("abort", abort);
    }
  }

  openSocket(path: string): StreamSocket {
    return new ChannelSocket(this.connect(), path);
  }

  private async acquire(): Promise<Connection> {
    for (;;) {
      const held = this.idle.pop();
      if (held === undefined) break;
      if (held.fresh) return held;
      held.close();
    }
    return await this.connect();
  }

  private release(connection: Connection): void {
    if (!connection.fresh || this.idle.length >= MAX_IDLE_CONNECTIONS) {
      connection.close();
      return;
    }
    this.idle.push(connection);
  }

  /** Recovers wrong_device once per channel by re-registering this device's key. */
  private async connect(): Promise<Connection> {
    try {
      return await this.dial();
    } catch (error) {
      if (!ChannelRefused.is(error) || error.reason !== "wrong_device" || this.recovered) throw error;
      this.recovered = true;
      await this.options.onWrongDevice();
      return await this.dial();
    }
  }

  private async dial(): Promise<Connection> {
    const staticKey = (this.options.deviceKey ?? deviceStaticKey)();
    if (staticKey === null) {
      throw new Error("this installation has no device key, so it cannot reach a machine over the relay");
    }
    const remoteStatic = fromBase64Url(this.options.machineKey);
    if (remoteStatic === null || remoteStatic.length !== 32) {
      throw new Error("this machine has not announced a usable key");
    }

    const { token, expiresAt } = await this.options.credential();
    const url = new URL(RELAY_CHANNEL_PATH, this.options.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // The credential rides the query on this hop only; inside the channel it is a frame.
    url.searchParams.set("token", token);

    const connection: Connection = new Connection(url.toString(), staticKey, remoteStatic, token, expiresAt, () =>
      this.live.delete(connection),
    );
    this.live.add(connection);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.ready(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("the channel did not come up")), CHANNEL_READY_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      connection.close();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return connection;
  }
}

export async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error("this body cannot be sent over an encrypted channel");
}

export function bodyText(body: Uint8Array): string {
  return decoder.decode(body);
}
