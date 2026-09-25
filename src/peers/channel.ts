import { WebSocket } from "ws";
import {
  FRAME,
  LengthReader,
  NoiseHandshake,
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  frameLength,
  type CipherState,
  type StaticKey,
} from "@reemoat/protocol";
import { RELAY_URL_HEADER } from "../relay/protocol.js";

/** The relay's app-facing path. A copy, since src/ may not import the relay's; relaycheck compares the two. */
export const PEER_CHANNEL_PATH = "/__relay/channel";
export const PEER_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PEER_RESPONSE_BYTES = 1024 * 1024;

export interface PeerTarget {
  relayUrl: string;
  /** The target's machine key, base64url: this handshake fails unless it is the one answering. */
  machineKey: string;
  token: string;
}

export type PeerAnswer =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; code: string; relayUrl: string | null };

/**
 * One request to another machine's daemon, exactly as an app makes one: a Noise_IK initiator whose static is this
 * machine's key, the link capability in HELLO, then one REQUEST. One connection per request, so the relay reads the
 * link's row again every time (Q7.38 is why a pool would outlive a revocation).
 */
export async function peerRequest(
  target: PeerTarget,
  staticKey: StaticKey,
  request: { method: "GET" | "POST"; path: string; body?: unknown },
  timeoutMs = PEER_REQUEST_TIMEOUT_MS,
): Promise<PeerAnswer> {
  const remote = new Uint8Array(Buffer.from(target.machineKey, "base64url"));
  if (remote.length !== 32) return { ok: false, status: 0, code: "no_machine_key", relayUrl: null };
  let url: URL;
  try {
    url = new URL(PEER_CHANNEL_PATH, target.relayUrl);
  } catch {
    return { ok: false, status: 0, code: "bad_relay_url", relayUrl: null };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, status: 0, code: "bad_relay_url", relayUrl: null };
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", target.token);

  const body = request.body === undefined ? null : new TextEncoder().encode(JSON.stringify(request.body));
  return await new Promise<PeerAnswer>((resolve) => {
    const ws = new WebSocket(url, { maxPayload: 2 * MAX_PEER_RESPONSE_BYTES });
    const reader = new LengthReader();
    const handshake = NoiseHandshake.start({ initiator: true, staticKey, remoteStatic: remote });
    let send: CipherState | null = null;
    let receive: CipherState | null = null;
    let head: { status: number } | null = null;
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const give = (answer: PeerAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(answer);
    };
    const fail = (status: number, code: string, relayUrl: string | null = null): void =>
      give({ ok: false, status, code, relayUrl });
    const timer = setTimeout(() => fail(0, "timeout"), timeoutMs);
    timer.unref();

    const write = (frame: Uint8Array): void => {
      ws.send(frameLength(send!.encrypt(new Uint8Array(0), frame)));
    };

    ws.on("open", () => {
      void handshake
        .writeMessage()
        .then((first: Uint8Array) => ws.send(frameLength(first)))
        .catch(() => fail(0, "handshake_failed"));
    });
    ws.on("message", (data: Buffer) => {
      for (const message of reader.push(new Uint8Array(data))) {
        if (send === null) {
          void handshake
            .readMessage(message)
            .then(() => {
              const transport = handshake.split();
              send = transport.send;
              receive = transport.receive;
              write(encodeJsonFrame(FRAME.HELLO, { capability: target.token }));
            })
            .catch(() => fail(0, "handshake_failed"));
          continue;
        }
        let frame: { type: number; payload: Uint8Array } | null;
        try {
          frame = decodeFrame(receive!.decrypt(new Uint8Array(0), message));
        } catch {
          fail(0, "crypto_failure");
          return;
        }
        if (frame === null) continue;
        switch (frame.type) {
          case FRAME.READY:
            write(
              encodeJsonFrame(FRAME.REQUEST, {
                method: request.method,
                path: request.path,
                headers: body === null ? {} : { "content-type": "application/json" },
                body: body !== null,
              }),
            );
            if (body !== null) {
              write(encodeFrame(FRAME.REQUEST_BODY, body));
              write(encodeFrame(FRAME.REQUEST_END));
            }
            break;
          case FRAME.RESPONSE:
            try {
              head = JSON.parse(new TextDecoder().decode(frame.payload)) as { status: number };
            } catch {
              fail(0, "unreadable_response");
            }
            break;
          case FRAME.RESPONSE_BODY:
            received += frame.payload.length;
            if (received > MAX_PEER_RESPONSE_BYTES) {
              fail(0, "response_too_large");
              return;
            }
            chunks.push(Buffer.from(frame.payload));
            break;
          case FRAME.RESPONSE_END: {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = text.length === 0 ? null : JSON.parse(text);
            } catch {
              parsed = null;
            }
            give({ ok: true, status: head?.status ?? 0, body: parsed });
            break;
          }
          case FRAME.FAILED: {
            let reason = "refused";
            try {
              reason = String((JSON.parse(new TextDecoder().decode(frame.payload)) as { reason?: unknown }).reason ?? reason);
            } catch {
              // The code alone is enough to report.
            }
            fail(401, reason);
            break;
          }
        }
      }
    });
    // The relay refuses on the upgrade's status line; a 421 names the relay that holds the tunnel.
    ws.on("unexpected-response", (_req, res) => {
      const moved = res.headers[RELAY_URL_HEADER];
      fail(res.statusCode ?? 0, res.statusMessage ?? "refused", typeof moved === "string" ? moved : null);
    });
    ws.on("error", () => fail(0, "unreachable"));
  });
}
