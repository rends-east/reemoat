import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { MAX_FRAME_PAYLOAD, generateStaticKey, localStaticKey } from "@reemoat/protocol";
import { check, report, sleep } from "./webcheck.env.js";
import { serveSecureSession } from "../../../src/e2ee.js";
import { SignedTokenVerifier } from "../../../src/auth.js";
import { jwkThumbprint, publicKeyToJwk, signToken, x25519Jwk, type TokenClaims } from "../../../src/token.js";
import { MachineChannel, RELAY_CHANNEL_PATH, bodyBytes, type StreamSocket } from "../src/e2ee.js";
// Imported from its owner, so the flood below always crosses the app's real bound.
import { MAX_DOWNLOAD_BYTES } from "../src/machine.js";

// The shipped MachineChannel against the real serveSecureSession; the driver holds the device key because hostReady fires at import.

process.stdout.write("\nthe app's encrypted channel, against the real daemon session\n");

/** The one string that must never appear in anything the relay carried. */
const SECRET_BODY = "the-quick-brown-fox-jumped-over-a-diff";
const SECRET_PATH = "/sessions/s_confidential/changes";

let daemonSaw: { method: string; path: string; auth: string | undefined }[] = [];

const daemon = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = req.url ?? "/";
  daemonSaw.push({ method: req.method ?? "?", path, auth: req.headers.authorization });

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, instanceId: "i_e2ee" }));
    return;
  }
  if (path === SECRET_PATH) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ diff: SECRET_BODY }));
    return;
  }
  if (path === "/bytes") {
    const payload = new Uint8Array(200_000);
    for (let at = 0; at < payload.length; at += 1) payload[at] = at % 251;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payload.length) });
    res.end(payload);
    return;
  }
  if (path === "/echo") {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bytes: Buffer.concat(parts).length }));
    });
    return;
  }
  // Never answered, so only the caller's AbortSignal or timeoutMs can settle it.
  if (path === "/hang") return;
  // Streamed past MAX_DOWNLOAD_BYTES with no content-length, so only the check on what actually arrives can refuse it.
  if (path === "/flood") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const block = Buffer.alloc(1024 * 1024, 7);
    let written = 0;
    const pump = (): void => {
      while (written <= MAX_DOWNLOAD_BYTES) {
        written += block.length;
        if (!res.write(block)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
    return;
  }
  // Hono's bare 404 must survive unwrapped: clients read it as a daemon too old for the route.
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("404 Not Found");
});

const daemonPort = await new Promise<number>((resolve) => {
  daemon.listen(0, "127.0.0.1", () => resolve((daemon.address() as AddressInfo).port));
});
report("a daemon-shaped listener is up", daemonPort > 0, `127.0.0.1:${daemonPort}`);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const identity = {
  machineId: "m_e2ee",
  issuer: "reemoat-cp",
  keys: [{ kid: "k_webcheck", jwk: publicKeyToJwk(publicKey) }],
};
const verifier = new SignedTokenVerifier({ identity });

const machineKey = generateStaticKey();
const device = generateStaticKey();
const stranger = generateStaticKey();

function capability(jkt: string, lifetimeSeconds = 300): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    iss: "reemoat-cp",
    sub: "u_1",
    aud: "m_e2ee",
    jti: `t_${String(iat)}_${String(Math.round(lifetimeSeconds))}`,
    iat,
    nbf: iat,
    exp: iat + lifetimeSeconds,
    scp: ["session:read", "session:write"],
    cnf: { jkt },
  };
  return signToken(claims, "k_webcheck", privateKey);
}

const deviceThumbprint = jwkThumbprint(x25519Jwk(device.publicKey));
const strangerThumbprint = jwkThumbprint(x25519Jwk(stranger.publicKey));

let carried: Uint8Array[] = [];
// Off only for the flood section; the sections below assert over carried, so it must be switched back on.
let recording = true;
// Counted, not kept: proves an upload was under way, never that a cancel stopped the wire.
let appToRelayBytes = 0;
let channelsOpened = 0;
// Closes seen at the relay: the only way a disposed connection is observed.
let channelsClosed = 0;
let tamperNext = false;

const relay = createServer();
const relaySockets = new WebSocketServer({ noServer: true });

relay.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const url = new URL(req.url ?? "/", "http://relay");
  if (url.pathname !== RELAY_CHANNEL_PATH) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  // Presence of a credential only; real authorization is relaycheck's.
  if (url.searchParams.get("token") === null) {
    socket.write("HTTP/1.1 401 missing_token\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  relaySockets.handleUpgrade(req, socket, head, (ws) => {
    channelsOpened += 1;
    const fromApp = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        if (recording) carried.push(new Uint8Array(chunk));
        appToRelayBytes += chunk.length;
        toDaemon.push(chunk);
        done();
      },
    });
    const toDaemon = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        if (recording) carried.push(new Uint8Array(chunk));
        const out = new Uint8Array(chunk);
        if (tamperNext) {
          tamperNext = false;
          out[out.length - 1] = (out[out.length - 1]! ^ 0x01) & 0xff;
        }
        fromApp.push(out);
        done();
      },
    });

    const carrier = createWebSocketStream(ws);
    carrier.pipe(fromApp);
    fromApp.pipe(carrier);

    serveSecureSession({
      stream: toDaemon,
      staticKey: localStaticKey(machineKey.secretKey),
      verifier,
      local: { host: "127.0.0.1", port: daemonPort },
    });

    const shut = (): void => {
      carrier.destroy();
      fromApp.destroy();
      toDaemon.destroy();
    };
    ws.on("close", () => {
      channelsClosed += 1;
      shut();
    });
    carrier.on("error", shut);
  });
});

const relayPort = await new Promise<number>((resolve) => {
  relay.listen(0, "127.0.0.1", () => resolve((relay.address() as AddressInfo).port));
});
const relayUrl = `http://127.0.0.1:${String(relayPort)}`;
report("a relay that only moves bytes is up", relayPort > 0, relayUrl);

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

let registrations = 0;
let mints = 0;

function channelFor(
  options: {
    key?: Uint8Array;
    secret?: Uint8Array;
    jkt?: string;
    lifetimeSeconds?: number;
    onWrongDevice?: () => Promise<void>;
  } = {},
): MachineChannel {
  const secret = options.secret ?? device.secretKey;
  return new MachineChannel({
    relayUrl,
    machineKey: toBase64Url(options.key ?? machineKey.publicKey),
    credential: async () => {
      mints += 1;
      const seconds = options.lifetimeSeconds ?? 300;
      return {
        token: capability(options.jkt ?? deviceThumbprint, seconds),
        expiresAt: Date.now() + seconds * 1_000,
      };
    },
    onWrongDevice:
      options.onWrongDevice ??
      (async () => {
        registrations += 1;
      }),
    deviceKey: () => localStaticKey(secret),
  });
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

{
  const channel = channelFor();
  const answer = await channel.request({ method: "GET", path: SECRET_PATH, timeoutMs: 5_000 });
  check("an ordinary request is answered through the channel", answer.status, 200);
  check("with the daemon's own body", JSON.parse(text(answer.body)), { diff: SECRET_BODY });
  check("and the daemon saw the path the app asked for", daemonSaw.at(-1)?.path, SECRET_PATH);

  const wire = Buffer.concat(carried.map((one) => Buffer.from(one))).toString("latin1");
  report("the relay carried bytes at all", wire.length > 200, `${String(wire.length)} bytes`);
  check("and the daemon's answer is not in them", wire.includes(SECRET_BODY), false);
  check("nor the path that was asked for", wire.includes("s_confidential"), false);
  check("nor the capability that opened it", wire.includes("eyJ"), false);

  report(
    "the daemon's listener was given the capability as a header",
    (daemonSaw.at(-1)?.auth ?? "").startsWith("Bearer ey"),
    daemonSaw.at(-1)?.auth === undefined ? "no authorization header" : "Bearer …",
  );

  channel.dispose();
}

{
  const channel = channelFor();
  const missing = await channel.request({ method: "GET", path: "/nope", timeoutMs: 5_000 });
  check("a bare 404 survives the round trip as itself", [missing.status, text(missing.body)], [404, "404 Not Found"]);
  check("and it is not wrapped in an error envelope", text(missing.body).startsWith("{"), false);

  const bytes = await channel.request({ method: "GET", path: "/bytes", timeoutMs: 10_000 });
  check("a body larger than one Noise message arrives whole", bytes.body.length, 200_000);
  const intact = bytes.body.every((byte, at) => byte === at % 251);
  report("and every byte of it is the one the daemon wrote", intact, "200000 bytes, chunked and reassembled");
  check("with the daemon's own content-length beside it", bytes.headers["content-length"], "200000");

  channel.dispose();
}

{
  const channel = channelFor();
  const seen: number[] = [];
  const payload = new Uint8Array(180_000);
  const answer = await channel.request({
    method: "POST",
    path: "/echo",
    body: payload,
    onProgress: (fraction) => seen.push(fraction),
    timeoutMs: 10_000,
  });
  check("a request body arrives whole", JSON.parse(text(answer.body)), { bytes: 180_000 });
  report("progress was reported more than once", seen.length > 1, `${String(seen.length)} reports`);
  check("it never exceeds one", seen.filter((one) => one > 1), []);
  check("and it ends at one", seen.at(-1), 1);
  report("progress is monotonic", seen.every((one, at) => at === 0 || one >= seen[at - 1]!), seen.length + " reports");

  channel.dispose();
}

{
  // The assertion is the clock: a cancel that settles only on timeoutMs must fail, so the timeout is enormous.
  const channel = channelFor();
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = channel.request({
    method: "GET",
    path: "/hang",
    timeoutMs: 120_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  let cancelled: { name: string; message: string } | null = null;
  try {
    await pending;
  } catch (error) {
    cancelled = { name: (error as Error).name, message: (error as Error).message };
  }
  const spent = Date.now() - startedAt;
  report("a cancelled request rejects rather than hanging", cancelled !== null, cancelled?.message ?? "it resolved");
  report("and it does so promptly rather than on the request's own timeout", spent < 2_000, `${String(spent)}ms of 120000`);
  // AbortError, matching what the fetch/XHR arm of machine.ts rejects a cancel with.
  check("named as the cancellation it is", cancelled?.name, "AbortError");

  // A signal that fired before acquire added its listener must still be honoured.
  const already = new AbortController();
  already.abort();
  const secondStartedAt = Date.now();
  let refused = "";
  try {
    await channel.request({ method: "GET", path: "/hang", timeoutMs: 120_000, signal: already.signal });
  } catch (error) {
    refused = (error as Error).name;
  }
  check("a signal that had already fired is honoured too", refused, "AbortError");
  report(
    "and just as promptly",
    Date.now() - secondStartedAt < 2_000,
    `${String(Date.now() - secondStartedAt)}ms of 120000`,
  );

  channel.dispose();
}

{
  // Asserted through onProgress: no byte crosses after a cancel either way, so counting frames could not fail.
  // The cancel fires inside onProgress, so it lands between two iterations deterministically.
  const CHUNKS = 16;
  const CANCEL_AFTER = 3;
  // BODY_CHUNK_BYTES is MAX_FRAME_PAYLOAD, which is what makes the exact counts below hold.
  const payload = new Uint8Array(MAX_FRAME_PAYLOAD * CHUNKS);

  {
    // Positive control: a cancelled upload and one that never started both report no progress.
    const channel = channelFor();
    const echoes = daemonSaw.filter((one) => one.path === "/echo").length;
    const seen: number[] = [];
    const answer = await channel.request({
      method: "POST",
      path: "/echo",
      body: payload,
      onProgress: (fraction) => seen.push(fraction),
      timeoutMs: 60_000,
    });
    check("an upload nobody cancels arrives whole", JSON.parse(text(answer.body)), { bytes: payload.length });
    check("with one progress report per chunk", seen.length, CHUNKS);
    check("and the last of them is one", seen.at(-1), 1);
    check("and the daemon was asked exactly once", daemonSaw.filter((one) => one.path === "/echo").length - echoes, 1);
    channel.dispose();
  }

  {
    const channel = channelFor();
    const echoes = daemonSaw.filter((one) => one.path === "/echo").length;
    const crossedBefore = appToRelayBytes;
    const controller = new AbortController();
    const seen: number[] = [];
    let cancelled = "";
    try {
      await channel.request({
        method: "POST",
        path: "/echo",
        body: payload,
        onProgress: (fraction) => {
          seen.push(fraction);
          if (seen.length === CANCEL_AFTER) controller.abort();
        },
        // Enormous, so the request's own timeout can never be what settles this.
        timeoutMs: 120_000,
        signal: controller.signal,
      });
    } catch (error) {
      cancelled = (error as Error).name;
    }
    // A setTimeout drains the microtask queue, so a loop without a closed exit has finished reporting by now.
    await sleep(100);
    check("a cancelled upload rejects as the cancellation it is", cancelled, "AbortError");
    check("⭐ and the loop behind it stops where the cancel landed", seen.length, CANCEL_AFTER);
    check("so the bar never reaches one", seen.filter((one) => one >= 1), []);
    // Preconditions measured past the loopback hop, so a client that buffered or never sent the body cannot pass.
    const echoed = (): number => daemonSaw.filter((one) => one.path === "/echo").length - echoes;
    for (let at = 0; at < 200 && (appToRelayBytes - crossedBefore <= MAX_FRAME_PAYLOAD || echoed() === 0); at += 1) {
      await sleep(10);
    }
    report(
      "the cancelled upload really was under way",
      appToRelayBytes - crossedBefore > MAX_FRAME_PAYLOAD,
      `${String(appToRelayBytes - crossedBefore)} bytes crossed the relay`,
    );
    check("and the daemon really had the request", echoed(), 1);
    channel.dispose();
  }
}

{
  // Enforced as frames arrive, since no content-length is sent; a plain Error rather than ChannelRefused, so isTransportFailure treats it as weather.
  recording = false;
  const channel = channelFor();
  let refused = "";
  let reason: unknown;
  try {
    await channel.request({ method: "GET", path: "/flood", timeoutMs: 120_000 });
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
    reason = (error as { reason?: string }).reason;
  }
  check(
    "an answer past the ceiling fails the connection with a legible sentence",
    refused,
    "the answer to this request is larger than this client will hold",
  );
  check("and not as a refusal the daemon made", reason, undefined);
  channel.dispose();
  recording = true;
  carried = [];
}

{
  // IK's second message needs the machine's private static, so a wrong machine key cannot complete the handshake.
  const wrong = generateStaticKey();
  const dialled = channelsOpened;
  const channel = channelFor({ key: wrong.publicKey });
  let refused = "";
  try {
    await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  report("a channel to the wrong machine key never comes up", refused !== "", refused || "it came up");
  // Exactly one dial: a local refusal in dial would satisfy the report above without any handshake.
  check("having dialled and failed the handshake rather than refusing locally", channelsOpened - dialled, 1);
  check("and nothing reached the daemon's listener", daemonSaw.filter((one) => one.path === "/health").length, 0);
  channel.dispose();
}

{
  const channel = channelFor({ jkt: strangerThumbprint });
  let reason = "";
  try {
    await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  } catch (error) {
    reason = (error as { reason?: string }).reason ?? (error as Error).message;
  }
  check("a capability minted for another device is refused at the handshake", reason, "wrong_device");
  channel.dispose();
}

{
  // A reset credential store: minting succeeds, the daemon answers wrong_device, and the channel re-registers the same device id once and retries.
  registrations = 0;
  let named = strangerThumbprint;
  const channel = new MachineChannel({
    relayUrl,
    machineKey: toBase64Url(machineKey.publicKey),
    credential: async () => ({ token: capability(named), expiresAt: Date.now() + 300_000 }),
    onWrongDevice: async () => {
      registrations += 1;
      named = deviceThumbprint;
    },
    deviceKey: () => localStaticKey(device.secretKey),
  });

  const answer = await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  check("a re-keyed installation recovers on its own", answer.status, 200);
  check("having re-registered exactly once", registrations, 1);
  channel.dispose();
}

{
  registrations = 0;
  const channel = channelFor({
    jkt: strangerThumbprint,
    onWrongDevice: async () => {
      registrations += 1;
    },
  });
  let reason = "";
  try {
    await channel.request({ method: "GET", path: "/health", timeoutMs: 6_000 });
  } catch (error) {
    reason = (error as { reason?: string }).reason ?? (error as Error).message;
  }
  check("a recovery that does not take is reported rather than retried", [reason, registrations], ["wrong_device", 1]);
  channel.dispose();
}

{
  channelsOpened = 0;
  const channel = channelFor();
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  check("three requests share one connection", channelsOpened, 1);
  channel.dispose();
}

{
  // A pooled connection past its capability's exp earns a 401; this decides only what the pool hands back (Q5.24).
  channelsOpened = 0;
  // Inside REUSE_MARGIN_MS from minting, so the connection is stale the moment it is idle.
  const channel = channelFor({ lifetimeSeconds: 20 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  check("a connection near its capability's expiry is replaced instead", channelsOpened, 2);
  channel.dispose();
}

{
  // No resync: a diverged nonce fails every later frame, so the channel must end.
  const channel = channelFor();
  await channel.request({ method: "GET", path: "/health", timeoutMs: 5_000 });
  tamperNext = true;
  let failed = "";
  try {
    await channel.request({ method: "GET", path: SECRET_PATH, timeoutMs: 5_000 });
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  }
  check("a frame altered in flight ends the channel", failed, "a frame on this channel could not be authenticated");
  check("and it is not reported as a refusal the daemon made", (failed as string).includes("refused"), false);
  check("nor as the timeout that used to satisfy this check", (failed as string).includes("timed out"), false);
  tamperNext = false;
  channel.dispose();
}

// The é begins in the last byte of frame one, so a UTF-8 character straddles the boundary; ASCII alone would pass per-chunk decoding.
const STRADDLE_HEAD = '{"type":"events","straddle":"';
const BIG_MESSAGE = `${STRADDLE_HEAD}${"a".repeat(MAX_FRAME_PAYLOAD - 1 - STRADDLE_HEAD.length)}é","tail":"${"z".repeat(40_000)}"}`;

const sockets = new WebSocketServer({ server: daemon, path: "/stream" });
// One server, three behaviours selected by the query: ws matches the pathname alone.
sockets.on("connection", (ws, req) => {
  const path = req.url ?? "/stream";
  daemonSaw.push({ method: "GET", path, auth: req.headers.authorization });
  if (path.includes("big=1")) {
    ws.send(BIG_MESSAGE);
    return;
  }
  // Never ended by the daemon: the only state in which disposing can be observed.
  if (path.includes("quiet=1")) {
    ws.send(JSON.stringify({ type: "hello", instanceId: "i_e2ee" }));
    return;
  }
  ws.send(JSON.stringify({ type: "hello", instanceId: "i_e2ee" }));
  ws.send(JSON.stringify({ type: "events", events: [{ seq: 1 }] }));
  // Must arrive as itself: stream.ts's close-code table is the client's whole model of the daemon.
  setTimeout(() => ws.close(4401, "token_expired"), 60);
});

{
  const channel = channelFor();
  const socket: StreamSocket = channel.openSocket("/stream?since=7");
  const frames: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  socket.onmessage = (event): void => {
    frames.push(String((event as MessageEvent).data));
  };
  socket.onclose = (event): void => {
    closed = { code: event.code, reason: event.reason };
  };

  for (let at = 0; at < 200 && closed === null; at += 1) await sleep(10);

  check("a socket over a channel delivers the daemon's frames", frames.length, 2);
  check("as strings, which is what the transcript reducer requires", typeof frames[0], "string");
  check("in order", frames.map((one) => (JSON.parse(one) as { type: string }).type), ["hello", "events"]);
  check("and the daemon's own close code survives the channel", closed, { code: 4401, reason: "token_expired" });
  check("the socket's query reached the daemon", daemonSaw.at(-1)?.path, "/stream?since=7");
  report(
    "and its credential was a header rather than a query parameter",
    (daemonSaw.at(-1)?.auth ?? "").startsWith("Bearer ey") && !(daemonSaw.at(-1)?.path ?? "").includes("token="),
    daemonSaw.at(-1)?.path ?? "(none)",
  );
  channel.dispose();
}

{
  // A MESSAGE frame is a chunk: one socket message must arrive as one event, or stream.ts drops the pieces and never moves the cursor.
  const bytes = new TextEncoder().encode(BIG_MESSAGE);
  report(
    "the fixture is larger than one frame can carry",
    bytes.length > MAX_FRAME_PAYLOAD,
    `${String(bytes.length)} bytes against ${String(MAX_FRAME_PAYLOAD)}`,
  );
  check(
    "with a multi-byte character beginning in the last byte of the first frame",
    bytes.findIndex((byte) => byte >= 0x80),
    MAX_FRAME_PAYLOAD - 1,
  );

  const channel = channelFor();
  const socket: StreamSocket = channel.openSocket("/stream?big=1");
  const frames: string[] = [];
  socket.onmessage = (event): void => {
    frames.push(String((event as MessageEvent).data));
  };
  for (let at = 0; at < 300 && frames.length === 0; at += 1) await sleep(10);
  // A beat past the first arrival, so a second MessageEvent has time to show up.
  await sleep(120);

  check("a message larger than a frame arrives as one message", frames.length, 1);
  let parsed: { straddle?: string; tail?: string } | null = null;
  try {
    parsed = JSON.parse(frames[0] ?? "null") as { straddle?: string; tail?: string };
  } catch {
    // Left null for the report below; a throw would end the driver.
  }
  report("and it parses as the JSON the daemon sent", parsed !== null, frames[0]?.slice(0, 40) ?? "(nothing arrived)");
  check("with the character that straddled the boundary intact", parsed?.straddle?.endsWith("é"), true);
  check("and no replacement character anywhere in it", (frames[0] ?? "").includes("�"), false);
  check("and the bytes after the boundary are the ones that followed it", parsed?.tail?.length, 40_000);

  socket.close();
  channel.dispose();
}

{
  // The live socket's connection is never in idle, so disposing must close it too: onclose alone is satisfied by nulled handlers.
  const closedBefore = channelsClosed;
  const channel = channelFor();
  const socket: StreamSocket = channel.openSocket("/stream?quiet=1");
  const frames: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  socket.onmessage = (event): void => {
    frames.push(String((event as MessageEvent).data));
  };
  socket.onclose = (event): void => {
    closed = { code: event.code, reason: event.reason };
  };

  for (let at = 0; at < 300 && frames.length === 0; at += 1) await sleep(10);
  check("a socket the daemon holds open is delivering", frames.length, 1);
  check("and nothing has closed it", closed, null);

  channel.dispose();
  for (let at = 0; at < 300 && closed === null; at += 1) await sleep(10);
  // The reason, not the code, says the close was deliberate: 1006 is shared with a dropped socket.
  check("⭐ disposing the channel ends the live socket", closed, { code: 1006, reason: "the channel was closed" });

  for (let at = 0; at < 300 && channelsClosed === closedBefore; at += 1) await sleep(10);
  report(
    "and the connection under it is gone from the relay too",
    channelsClosed > closedBefore,
    `${String(channelsClosed - closedBefore)} channel(s) closed`,
  );
}

{
  carried = [];
  const second = generateStaticKey();
  const secondThumbprint = jwkThumbprint(x25519Jwk(second.publicKey));
  const one = channelFor();
  const two = channelFor({ secret: second.secretKey, jkt: secondThumbprint });

  const answers = await Promise.all([
    one.request({ method: "GET", path: "/health", timeoutMs: 6_000 }),
    two.request({ method: "GET", path: "/health", timeoutMs: 6_000 }),
  ]);
  check("two devices reach the same daemon at once", answers.map((a) => a.status), [200, 200]);
  check(
    "and both see the same instance",
    answers.map((a) => (JSON.parse(text(a.body)) as { instanceId: string }).instanceId),
    ["i_e2ee", "i_e2ee"],
  );
  // Any shared key or reused ephemeral shows up as a repeated frame.
  const frames = carried.map((one) => Buffer.from(one).toString("base64"));
  // The check below passes vacuously over an empty recording.
  report("the wire really was recorded", frames.length > 4, `${String(frames.length)} frames`);
  check("with no frame appearing twice on the wire", frames.length - new Set(frames).size, 0);

  one.dispose();
  two.dispose();
}

{
  // The only comparison of the two RELAY_CHANNEL_PATH literals: the packages cannot share the constant and relaycheck never reads the app's.
  const listener = readFileSync(new URL("../../control-plane/src/relay/listener.ts", import.meta.url), "utf8");
  // Anchored at line start so a copy quoted in a comment cannot match.
  const declared = /^export const RELAY_CHANNEL_PATH = "([^"]+)";/m.exec(listener)?.[1] ?? null;
  report("the relay declares a channel path at all", declared !== null, String(declared));
  check("and the app dials exactly that path", RELAY_CHANNEL_PATH, declared);
}

{
  check("a string body becomes its UTF-8 bytes", Array.from((await bodyBytes("hi")) ?? []), [104, 105]);
  check("nothing becomes nothing", await bodyBytes(null), null);
  check("and undefined too", await bodyBytes(undefined), null);
  check(
    "a Blob is read whole",
    Array.from((await bodyBytes(new Blob([new Uint8Array([7, 8, 9])]))) ?? []),
    [7, 8, 9],
  );
  // A refusal, not a conversion: no call site sends FormData or a stream.
  let refused = "";
  try {
    await bodyBytes(new URLSearchParams({ a: "b" }));
  } catch (error) {
    refused = (error as Error).message;
  }
  check(
    "a body shape nothing sends is refused rather than guessed at",
    refused,
    "this body cannot be sent over an encrypted channel",
  );
}

// Comments stripped, so the assertion reads code rather than the prose beside it.
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line !== "")
    .join("\n");
}

{
  // Source assertion: Connection.write must return on closed before it encrypts, which nothing outside the object can observe.
  const source = readFileSync(new URL("../src/e2ee.ts", import.meta.url), "utf8");
  const HEAD = "private write(frame: Uint8Array): void {";
  const opens = source.indexOf(HEAD);
  const ends = source.indexOf("\n  }", opens);
  report(
    "`Connection.write` is still where it was",
    opens > 0 && ends > opens,
    opens > 0 ? HEAD : "no method with that signature",
  );
  const body = withoutComments(opens > 0 && ends > opens ? source.slice(opens + HEAD.length, ends) : "");
  const guardsTheSeal = (text: string): boolean => {
    const guard = text.indexOf("if (this.closed) return;");
    const seal = text.indexOf(".encrypt(");
    return guard !== -1 && seal > guard;
  };
  report("it drops a frame before it seals one", guardsTheSeal(body), body.split("\n")[0] ?? "(an empty method body)");
  // Negative controls: the predicate must fail with the guard deleted or moved below the seal.
  const deleted = body.replace("if (this.closed) return;", "").trim();
  const moved = `${deleted}\nif (this.closed) return;`;
  report("and the check can tell when the guard is gone", !guardsTheSeal(deleted), "the predicate fails with it removed");
  report("or when it has moved below the seal", !guardsTheSeal(moved), "the predicate fails with it reordered");
}

sockets.close();
relay.close();
daemon.close();
relaySockets.close();
daemonSaw = [];
