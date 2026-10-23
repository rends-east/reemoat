import { WebSocket } from "ws";
import { ChannelExchange, type StaticKey } from "@reemoat/protocol";
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
    const exchange = ChannelExchange.start({
      staticKey,
      remoteStatic: remote,
      hello: { capability: target.token },
      request: { method: request.method, path: request.path, headers: body === null ? {} : { "content-type": "application/json" }, body },
      carrier: { send: (bytes) => ws.send(bytes) },
      maxResponseBytes: MAX_PEER_RESPONSE_BYTES,
    });
    let settled = false;

    const give = (answer: PeerAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exchange.abort("settled");
      ws.terminate();
      resolve(answer);
    };
    const fail = (status: number, code: string, relayUrl: string | null = null): void => give({ ok: false, status, code, relayUrl });
    const timer = setTimeout(() => fail(0, "timeout"), timeoutMs);
    timer.unref();

    void exchange.outcome.then((outcome) => {
      switch (outcome.kind) {
        case "answered": {
          const text = new TextDecoder().decode(outcome.body);
          let parsed: unknown = null;
          try {
            parsed = text.length === 0 ? null : JSON.parse(text);
          } catch {
            parsed = null;
          }
          return give({ ok: true, status: outcome.status, body: parsed });
        }
        // Its own status, so the daemon's 502 (its loopback did not answer) reads as the relay's does.
        case "refused":
          return fail(outcome.status ?? 401, outcome.reason);
        case "too_large":
          return fail(0, "response_too_large");
        case "unusable":
          return fail(0, "unreadable_response");
        case "handshake_failed":
        case "crypto_failure":
        case "closed":
          return fail(0, outcome.kind);
        case "aborted":
          return fail(0, outcome.reason);
      }
    });

    ws.on("open", () => exchange.opened());
    ws.on("message", (data: Buffer) => exchange.receiveBytes(new Uint8Array(data)));
    // The relay refuses on the upgrade's status line; a 421 names the relay that holds the tunnel.
    ws.on("unexpected-response", (_req, res) => {
      const moved = res.headers[RELAY_URL_HEADER];
      fail(res.statusCode ?? 0, res.statusMessage ?? "refused", typeof moved === "string" ? moved : null);
    });
    ws.on("error", () => fail(0, "unreachable"));
    // A channel that ends with neither an answer nor a refusal is settled now rather than by the timer.
    ws.on("close", () => exchange.closed());
  });
}
