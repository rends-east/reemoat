import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";
import { ChannelExchange, type ChannelOutcome, type ChannelRequest, type DeviceDescription, type StaticKey } from "@reemoat/protocol";

/** The relay's app-facing path; the app's and the daemon's copies say the same. */
export const RELAY_CHANNEL_PATH = "/__relay/channel";
/** The header a relay's 421 names the relay holding the tunnel in; src/relay/protocol.ts's, which this package may not import. */
export const RELAY_URL_HEADER = "x-reemoat-relay-url";
/** The relay forwards the daemon's bytes in whatever pieces they arrive; its own bound on one. */
const MAX_SOCKET_MESSAGE_BYTES = 8 * 1024 * 1024;
/** A whole board's tasks can pass a MiB with their briefs; decompressed, never more than this. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const CHANNEL_TIMEOUT_MS = 30_000;

export interface ChannelTarget {
  relayUrl: string;
  token: string;
  machineKey: string;
  staticKey: StaticKey;
  device: DeviceDescription;
}

export type ChannelResult =
  | { kind: "answered"; status: number; headers: Record<string, string>; body: Uint8Array }
  | { kind: "relay_refused"; status: number; code: string; relayUrl: string | null }
  | { kind: "unreachable"; reason: string }
  | Exclude<ChannelOutcome, { kind: "answered" }>;

/** One request on one connection, as the app's channel opens one: the token rides the upgrade for the relay, and HELLO for the daemon. */
export async function channelRequest(target: ChannelTarget, request: ChannelRequest, timeoutMs = CHANNEL_TIMEOUT_MS): Promise<ChannelResult> {
  const url = new URL(RELAY_CHANNEL_PATH, target.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  if (url.protocol !== "wss:" && url.protocol !== "ws:") return { kind: "unreachable", reason: `the relay address ${target.relayUrl} is not https` };

  const remote = new Uint8Array(Buffer.from(target.machineKey, "base64url"));
  return await new Promise<ChannelResult>((resolve) => {
    // The Authorization header rather than ?token=, so no proxy log on the way carries the capability.
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${target.token}` }, maxPayload: MAX_SOCKET_MESSAGE_BYTES });
    const exchange = ChannelExchange.start({
      staticKey: target.staticKey,
      remoteStatic: remote,
      hello: { capability: target.token, device: target.device },
      request: { ...request, headers: { ...request.headers, "accept-encoding": "gzip" } },
      carrier: { send: (bytes) => ws.send(bytes) },
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    let settled = false;
    const give = (result: ChannelResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exchange.abort("settled");
      ws.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      exchange.abort("timeout");
    }, timeoutMs);
    timer.unref();

    void exchange.outcome.then((outcome) => {
      if (outcome.kind !== "answered") return give(outcome);
      const encoding = outcome.headers["content-encoding"];
      if (encoding === undefined || encoding === "identity") return give(outcome);
      if (encoding !== "gzip") return give({ kind: "unusable", reason: `an answer in ${encoding}`, requestSent: true });
      try {
        const body = new Uint8Array(gunzipSync(outcome.body, { maxOutputLength: MAX_RESPONSE_BYTES }));
        give({ ...outcome, body });
      } catch {
        give({ kind: "too_large", requestSent: true });
      }
    });

    ws.on("open", () => exchange.opened());
    ws.on("message", (data: Buffer) => exchange.receiveBytes(new Uint8Array(data)));
    ws.on("unexpected-response", (_req, res) => {
      const moved = res.headers[RELAY_URL_HEADER];
      give({ kind: "relay_refused", status: res.statusCode ?? 0, code: res.statusMessage ?? "refused", relayUrl: typeof moved === "string" ? moved : null });
    });
    ws.on("error", (error) => give({ kind: "unreachable", reason: error.message }));
    ws.on("close", () => exchange.closed());
  });
}

export function decodeBody(body: Uint8Array, headers: Record<string, string>): unknown {
  if (body.length === 0) return null;
  const text = new TextDecoder().decode(body);
  if (!/json/i.test(headers["content-type"] ?? "json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
