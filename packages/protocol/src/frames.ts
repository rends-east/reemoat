// One connection carries one request or one socket at a time: no stream ids, a pool of connections instead.

export const FRAME = {
  /** initiator → responder. The capability, as the first transport message. */
  HELLO: 0x01,
  /** responder → initiator. The capability was accepted. */
  READY: 0x02,

  /** initiator → responder. `{method, path, headers}`. */
  REQUEST: 0x10,
  /** initiator → responder. A chunk of the request body. */
  REQUEST_BODY: 0x11,
  /** initiator → responder. The request body is complete. */
  REQUEST_END: 0x12,

  /** responder → initiator. `{status, statusText, headers}`. */
  RESPONSE: 0x20,
  /** responder → initiator. A chunk of the response body. */
  RESPONSE_BODY: 0x21,
  // responder → initiator. The answer is complete and whole.
  RESPONSE_END: 0x22,

  /** initiator → responder. `{path}` — open a socket rather than send a request. */
  OPEN: 0x30,
  /** responder → initiator. The socket is open. */
  OPENED: 0x31,
  /** Either direction. One chunk of one socket message; every message ends with MESSAGE_END, even a single-frame one. */
  MESSAGE: 0x32,
  /** Either direction. `{code, reason}` — the socket's own close, carried whole. */
  CLOSE: 0x33,
  /** Either direction. The MESSAGE frames since the last one are a whole message; a connection dying mid-message delivers nothing (Q6.103). */
  MESSAGE_END: 0x34,

  /** Either direction. `{code, reason}`: this connection failed. Separate from RESPONSE_END so a truncated body is never taken as complete (Q6.103). */
  FAILED: 0x40,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

export const MAX_FRAME_PAYLOAD = 65535 - 16 - 1;

/** Derived from MAX_FRAME_PAYLOAD so encodeJsonFrame never admits a description encodeFrame would refuse. */
export const MAX_HEADER_JSON_BYTES = MAX_FRAME_PAYLOAD;

/** Bounds reassembly against a peer that never sends MESSAGE_END; matches the daemon's WebSocket maxPayload. */
export const MAX_SOCKET_MESSAGE_BYTES = 1024 * 1024;

export interface HelloFrame {
  capability: string;
}

export interface RequestFrame {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Whether any `REQUEST_BODY` frames follow. */
  body: boolean;
}

export interface ResponseFrame {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface OpenFrame {
  path: string;
}

export interface CloseFrame {
  code: number;
  reason: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type: FrameType, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new Error("frame payload is too large");
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export function encodeJsonFrame(type: FrameType, value: unknown): Uint8Array {
  const frame = tryEncodeJsonFrame(type, value);
  if (frame === null) throw new Error("frame description is too large");
  return frame;
}

/** Returns null instead of throwing, for the one description not chosen here: the loopback response's headers. */
export function tryEncodeJsonFrame(type: FrameType, value: unknown): Uint8Array | null {
  const json = encoder.encode(JSON.stringify(value));
  if (json.length > MAX_HEADER_JSON_BYTES) return null;
  return encodeFrame(type, json);
}

export function encodeMessageFrames(message: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < message.length; at += MAX_FRAME_PAYLOAD) {
    frames.push(encodeFrame(FRAME.MESSAGE, message.subarray(at, at + MAX_FRAME_PAYLOAD)));
  }
  frames.push(encodeFrame(FRAME.MESSAGE_END));
  return frames;
}

export function decodeFrame(frame: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (frame.length === 0) return null;
  return { type: frame[0]!, payload: frame.subarray(1) };
}

export function decodeJson<T>(payload: Uint8Array): T | null {
  if (payload.length > MAX_HEADER_JSON_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(payload));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** Reassembles bytes, decoded once whole (a chunk can split a UTF-8 sequence). Holds views: both ends must decrypt into fresh arrays. */
export class MessageAssembler {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private overflowed = false;

  /** One MESSAGE payload; false once past MAX_SOCKET_MESSAGE_BYTES, and the caller must then fail the connection. */
  push(payload: Uint8Array): boolean {
    if (this.overflowed) return false;
    if (this.bytes + payload.length > MAX_SOCKET_MESSAGE_BYTES) {
      this.overflowed = true;
      this.chunks = [];
      this.bytes = 0;
      return false;
    }
    this.chunks.push(payload);
    this.bytes += payload.length;
    return true;
  }

  end(): Uint8Array | null {
    if (this.overflowed) {
      this.overflowed = false;
      return null;
    }
    const out = new Uint8Array(this.bytes);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.chunks = [];
    this.bytes = 0;
    return out;
  }
}

// Length-prefixed: both legs underneath (the app's WebSocket stream, the relay's h2 CONNECT) deliver bytes, not messages.

export function frameLength(message: Uint8Array): Uint8Array {
  if (message.length > 65535) throw new Error("noise message is too large to frame");
  const out = new Uint8Array(message.length + 2);
  out[0] = (message.length >> 8) & 0xff;
  out[1] = message.length & 0xff;
  out.set(message, 2);
  return out;
}

export class LengthReader {
  private held = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.held.length + chunk.length);
    merged.set(this.held);
    merged.set(chunk, this.held.length);

    const out: Uint8Array[] = [];
    let at = 0;
    for (;;) {
      if (merged.length - at < 2) break;
      const length = (merged[at]! << 8) | merged[at + 1]!;
      if (merged.length - at - 2 < length) break;
      out.push(merged.slice(at + 2, at + 2 + length));
      at += 2 + length;
    }
    this.held = merged.subarray(at);
    return out;
  }
}
