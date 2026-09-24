import { serve } from "@hono/node-server";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
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
  generateStaticKey,
  localStaticKey,
  type CipherState,
  type CloseFrame,
  type ResponseFrame,
} from "@reemoat/protocol";
import { check, report } from "./daemoncheck.env.js";
import { app, boundToken, tokenFor, verifier } from "./daemoncheck.fixtures.js";
import { serveSecureSession } from "../src/e2ee.js";
import { jwkThumbprint, x25519Jwk } from "../src/token.js";

process.stdout.write("\nan encrypted session, against the real daemon\n");

// Resolve inside the listening callback: `server.address()` is null at any synchronous point after `serve` returns.
const listener = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
});
const local = { host: "127.0.0.1", port: (listener.address() as AddressInfo).port };
report("the daemon's own listener is up", local.port > 0, `127.0.0.1:${local.port}`);

const machine = generateStaticKey();
const device = generateStaticKey();
const stranger = generateStaticKey();
const deviceThumbprint = jwkThumbprint(x25519Jwk(device.publicKey));
const strangerThumbprint = jwkThumbprint(x25519Jwk(stranger.publicKey));

// Written by hand rather than imported from the client, so it can send what a real client never would.
class Peer {
  private readonly reader = new LengthReader();
  private readonly frames: { type: number; payload: Uint8Array }[] = [];
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private wake: (() => void) | null = null;
  readonly carried: Uint8Array[] = [];
  ended = false;
  private pauses = 0;

  private constructor(
    private readonly handshake: NoiseHandshake,
    private readonly out: PassThrough,
    // Pause this, never `wire`: `wire`'s readable half is the daemon's inbound leg.
    private readonly inbound: PassThrough,
    private readonly wire: Duplex,
  ) {}

  static async connect(secretKey: Uint8Array, at: { host: string; port: number } = local): Promise<Peer> {
    const toDaemon = new PassThrough();
    const toPeer = new PassThrough();
    // Daemon and peer must hold the same Duplex: the backpressure guard reads its `writableLength`, visible only from the end that made it.
    const wire = Duplex.from({ readable: toDaemon, writable: toPeer });
    const peer = new Peer(
      NoiseHandshake.start({
        initiator: true,
        staticKey: localStaticKey(secretKey),
        remoteStatic: machine.publicKey,
      }),
      toDaemon,
      toPeer,
      wire,
    );

    toDaemon.on("data", (chunk: Buffer) => peer.carried.push(new Uint8Array(chunk)));
    toPeer.on("data", (chunk: Buffer) => {
      peer.carried.push(new Uint8Array(chunk));
      peer.consume(new Uint8Array(chunk));
    });
    toPeer.on("close", () => {
      peer.ended = true;
      peer.wake?.();
    });
    wire.on("pause", () => {
      peer.pauses += 1;
    });

    serveSecureSession({
      stream: wire,
      staticKey: localStaticKey(machine.secretKey),
      verifier,
      local: at,
    });

    peer.out.write(frameLength(await peer.handshake.writeMessage()));
    await peer.until(() => peer.send !== null || peer.ended);
    return peer;
  }

  private consume(chunk: Uint8Array): void {
    for (const message of this.reader.push(chunk)) {
      if (this.send === null) {
        void this.handshake.readMessage(message).then(() => {
          const transport = this.handshake.split();
          this.send = transport.send;
          this.receive = transport.receive;
          this.wake?.();
        });
        continue;
      }
      try {
        const frame = decodeFrame(this.receive!.decrypt(new Uint8Array(0), message));
        if (frame !== null) this.frames.push(frame);
      } catch {
        this.frames.push({ type: -1, payload: new Uint8Array(0) });
      }
      this.wake?.();
    }
  }

  get established(): boolean {
    return this.send !== null;
  }

  write(frame: Uint8Array): void {
    this.out.write(frameLength(this.send!.encrypt(new Uint8Array(0), frame)));
  }

  // Seals every frame into one chunk so `LengthReader` delivers them together; separate writes may or may not coalesce.
  writeAll(...frames: Uint8Array[]): void {
    this.out.write(Buffer.concat(frames.map((f) => frameLength(this.send!.encrypt(new Uint8Array(0), f)))));
  }

  stopReading(): void {
    this.inbound.pause();
  }

  startReading(): void {
    this.inbound.resume();
  }

  get outboundQueued(): number {
    return this.wire.writableLength;
  }

  streamListeners(event: "close" | "drain"): number {
    return this.wire.listenerCount(event);
  }

  // `stream.pause()` has one caller in src/e2ee.ts (the upload path), so each "pause" event is one backpressure cycle.
  get inboundPauses(): number {
    return this.pauses;
  }

  // `destroy`, not `end`: teardown hangs off `close`, and a half-closed pipe waits out FAIL_FLUSH_TIMEOUT_MS instead.
  hangUp(): void {
    this.wire.destroy();
  }

  writeTampered(frame: Uint8Array): void {
    const sealed = this.send!.encrypt(new Uint8Array(0), frame);
    sealed[sealed.length - 1] = (sealed[sealed.length - 1]! ^ 0x01) & 0xff;
    this.out.write(frameLength(sealed));
  }

  private async until(done: () => boolean): Promise<void> {
    if (done()) return;
    await new Promise<void>((resolve) => {
      this.wake = () => {
        if (!done()) return;
        this.wake = null;
        resolve();
      };
      setTimeout(() => {
        this.wake = null;
        resolve();
      }, 4_000).unref();
    });
  }

  async next(): Promise<{ type: number; payload: Uint8Array } | null> {
    await this.until(() => this.frames.length > 0 || this.ended);
    return this.frames.shift() ?? null;
  }

  async request(method: string, path: string, headers: Record<string, string> = {}): Promise<{
    status: number;
    body: string;
    ended: number;
  }> {
    this.write(encodeJsonFrame(FRAME.REQUEST, { method, path, headers, body: false }));
    return this.collect();
  }

  async collect(): Promise<{ status: number; body: string; ended: number }> {
    let status = 0;
    let body = "";
    for (;;) {
      const frame = await this.next();
      if (frame === null) return { status, body, ended: -1 };
      if (frame.type === FRAME.RESPONSE) {
        status = decodeJson<ResponseFrame>(frame.payload)?.status ?? 0;
      } else if (frame.type === FRAME.RESPONSE_BODY) {
        body += new TextDecoder().decode(frame.payload);
      } else if (frame.type === FRAME.RESPONSE_END || frame.type === FRAME.FAILED) {
        return { status, body, ended: frame.type };
      }
    }
  }

  async hello(capability: string): Promise<number> {
    this.write(encodeJsonFrame(FRAME.HELLO, { capability }));
    return (await this.next())?.type ?? -1;
  }

  async open(path: string): Promise<number> {
    this.write(encodeJsonFrame(FRAME.OPEN, { path }));
    return (await this.next())?.type ?? -1;
  }

  // Awaiting the daemon's CLOSE makes a later listener count race-free: its close handler writes CLOSE before removing listeners.
  async closeSocket(code = 1000): Promise<number> {
    this.write(encodeJsonFrame(FRAME.CLOSE, { code, reason: "" } satisfies CloseFrame));
    return (await this.next())?.type ?? -1;
  }

  // Reassembled with `MessageAssembler` so the check covers both ends agreeing; the chunk count is the non-vacuity control.
  async message(): Promise<{ bytes: Uint8Array | null; chunks: Uint8Array[] }> {
    const assembler = new MessageAssembler();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const frame = await this.next();
      if (frame === null) return { bytes: null, chunks };
      if (frame.type === FRAME.MESSAGE) {
        chunks.push(frame.payload);
        assembler.push(frame.payload);
        continue;
      }
      if (frame.type === FRAME.MESSAGE_END) return { bytes: assembler.end(), chunks };
      if (frame.type === FRAME.CLOSE || frame.type === FRAME.FAILED) return { bytes: null, chunks };
    }
  }

  // Assert the reason, not the code: dispatch's backstop fails with 400 too, so a code alone cannot tell a named refusal from a caught throw.
  async failure(): Promise<CloseFrame | null> {
    for (;;) {
      const frame = await this.next();
      if (frame === null) return null;
      if (frame.type === FRAME.FAILED) return decodeJson<CloseFrame>(frame.payload);
    }
  }
}

{
  const peer = await Peer.connect(device.secretKey);
  report("the handshake completes against the daemon's own key", peer.established, "Noise_IK, one round trip");

  check("a capability bound to this device is accepted", await peer.hello(boundToken("u_ab", deviceThumbprint)), FRAME.READY);

  const health = await peer.request("GET", "/health");
  check("and an ordinary request is answered", health.status, 200);
  report("with the daemon's own body", health.body.includes('"ok"'), health.body.slice(0, 40));
  check("and the answer is marked whole rather than given up on", health.ended, FRAME.RESPONSE_END);

  // The shape, not the status: `meansRouteAbsent` keys on Hono's bare 404 with no error envelope.
  // No credential on the request: the session pins the capability it authenticated onto every inner request.
  const absent = await peer.request("GET", "/no-such-route");
  check("an absent route keeps its bare 404", absent.status, 404);
  report("and carries no error envelope", !absent.body.includes('"error"'), absent.body.slice(0, 60) || "(empty)");

  const carried = Buffer.concat(peer.carried.map((c) => Buffer.from(c))).toString("latin1");
  report("the relay carried bytes at all", carried.length > 0, `${carried.length} bytes`);
  report("the control: the answer this session read names the instance in the clear", health.body.includes("instanceId"), health.body.slice(0, 60));
  check("and none of the daemon's answer is readable in them", carried.includes("instanceId"), false);
  check("nor the path that was asked for", carried.includes("/health"), false);
}

{
  const peer = await Peer.connect(stranger.secretKey);
  const answer = await peer.hello(boundToken("u_ab", deviceThumbprint));
  check("a capability for another device is refused", answer, FRAME.FAILED);
  await peer.next();
  report("and the session is torn down rather than left open", peer.ended, "FAILED then close");
}

{
  const peer = await Peer.connect(stranger.secretKey);
  check("while one minted for it is accepted", await peer.hello(boundToken("u_ab", strangerThumbprint)), FRAME.READY);
}

{
  const peer = await Peer.connect(device.secretKey);
  check("a capability naming no device is refused on a channel that proved one", await peer.hello(tokenFor("u_ab")), FRAME.FAILED);
}

{
  const peer = await Peer.connect(device.secretKey);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/health", headers: {}, body: false }));
  check("a request before any capability is refused", (await peer.next())?.type ?? -1, FRAME.FAILED);
}

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(boundToken("u_ab", deviceThumbprint)), FRAME.READY);

  peer.writeTampered(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/health", headers: {}, body: false }));
  await peer.next();
  report("a tampered frame ends the session rather than being served", peer.ended, "stream destroyed");
}

{
  const laptop = await Peer.connect(device.secretKey);
  const phone = await Peer.connect(stranger.secretKey);
  check("both devices are accepted", [
    await laptop.hello(boundToken("u_ab", deviceThumbprint)),
    await phone.hello(boundToken("u_ab", strangerThumbprint)),
  ], [FRAME.READY, FRAME.READY]);

  const one = await laptop.request("GET", "/health");
  const two = await phone.request("GET", "/health");
  check("and both reach the same daemon", [one.status, two.status], [200, 200]);
  const idOf = (body: string): string => (/"instanceId":"([^"]+)"/.exec(body)?.[1] ?? "?");
  check("which is the same instance", idOf(one.body), idOf(two.body));

  const first = Buffer.concat(laptop.carried.map((c) => Buffer.from(c))).toString("base64");
  const second = Buffer.concat(phone.carried.map((c) => Buffer.from(c))).toString("base64");
  report("with independent session keys", first !== second, "the two streams share no ciphertext");
}

const BIG = ((): string => {
  // A two-byte character straddles the first frame boundary: reassembly must be over bytes, never text.
  const head = '{"pad":"';
  const tail = '"}';
  const before = "a".repeat(MAX_FRAME_PAYLOAD - head.length - 1);
  const after = "b".repeat(200_000 - head.length - before.length - 2 - tail.length);
  return `${head}${before}é${after}${tail}`;
})();

const FLOOD_MESSAGES = 24;

const echoes: { url: string; authorization: string | undefined; xTest: string | string[] | undefined }[] = [];
const upgrades: { url: string; authorization: string | undefined }[] = [];
const socketCloses: { code: number; reason: string }[] = [];

const floodSockets: WebSocket[] = [];

// Keeps the listener's end of each loopback socket: `destroyed` polled later is the only sign the daemon let go of it.
const arrivals: { url: string; socket: Socket }[] = [];

const fixture = createServer((request, response) => {
  arrivals.push({ url: request.url ?? "", socket: request.socket });
  echoes.push({
    url: request.url ?? "",
    authorization: request.headers.authorization,
    xTest: request.headers["x-test"],
  });
  if (request.url?.startsWith("/slow") === true) return;
  if (request.url?.startsWith("/slurp") === true) {
    let read = 0;
    // `/slurp-slow` pauses per chunk: a greedy reader drains loopback so fast that `upstream.write()` rarely answers false.
    const slow = request.url.startsWith("/slurp-slow");
    request.on("data", (chunk: Buffer) => {
      read += chunk.length;
      if (!slow) return;
      request.pause();
      // A real delay, not `setImmediate`: a next-turn resume drains the loopback buffer before it can fill.
      setTimeout(() => request.resume(), 5);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ read }));
    });
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      authorization: request.headers.authorization ?? null,
      xTest: request.headers["x-test"] ?? null,
    }),
  );
});

const fixtureSockets = new WebSocketServer({ noServer: true });
fixture.on("upgrade", (request, socket, head) => {
  fixtureSockets.handleUpgrade(request, socket, head, (ws) => {
    upgrades.push({ url: request.url ?? "", authorization: request.headers.authorization });
    ws.on("close", (code: number, reason: Buffer) => socketCloses.push({ code, reason: reason.toString("utf8") }));
    if (request.url?.startsWith("/big") === true) ws.send(BIG);
    if (request.url?.startsWith("/flood") === true) {
      floodSockets.push(ws);
      ws.on("message", () => {
        for (let i = 0; i < FLOOD_MESSAGES; i += 1) ws.send(BIG);
      });
    }
  });
});

await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureLocal = { host: "127.0.0.1", port: (fixture.address() as AddressInfo).port };

let sinkDials = 0;
const sink = createServer((_request, response) => {
  response.writeHead(204);
  response.end();
});
sink.on("connection", () => {
  sinkDials += 1;
});
await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
const sinkPort = (sink.address() as AddressInfo).port;
const elsewhere = `127.0.0.1:${sinkPort}`;

report(
  "the driver's own listener and the sink are up, on ports of their own",
  fixtureLocal.port > 0 && sinkPort > 0 && new Set([local.port, fixtureLocal.port, sinkPort]).size === 3,
  `daemon ${local.port}, fixture ${fixtureLocal.port}, sink ${sinkPort}`,
);

// The poll timer is deliberately not unref'd: it may be all that keeps the loop alive, and the run would exit silently mid-file.
async function settle(done: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return done();
}

// Armed for one block only: later sections share this process, and a listener left armed would report their emitters.
function watchListenerLeaks(): { leaks: string[]; stop: () => void } {
  const leaks: string[] = [];
  const onWarning = (warning: Error): void => {
    if (warning.name !== "MaxListenersExceededWarning") return;
    leaks.push(warning.message);
  };
  process.on("warning", onWarning);
  return {
    leaks,
    stop: () => process.off("warning", onWarning),
  };
}

const sessionCap = boundToken("u_ab", deviceThumbprint);

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  peer.write(new Uint8Array(0));
  check("an empty sealed frame is refused as an empty frame", await peer.failure(), { code: 400, reason: "empty frame" });
}

{
  const peer = await Peer.connect(device.secretKey);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/health", headers: {}, body: false }));
  check("anything before a capability is refused, and says why", await peer.failure(), {
    code: 401,
    reason: "the first frame must present a capability",
  });
}

{
  const peer = await Peer.connect(device.secretKey);
  peer.write(encodeJsonFrame(FRAME.HELLO, ["a capability"]));
  check("a HELLO carrying a JSON array is unreadable rather than a capability", await peer.failure(), {
    code: 400,
    reason: "unreadable capability",
  });
}

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  peer.write(Uint8Array.of(0x7f));
  check("a frame type nothing names is refused, and names the byte", await peer.failure(), {
    code: 400,
    reason: "unexpected frame 127",
  });
}

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: 7, headers: {}, body: false }));
  check("a request whose path is a number is refused", await peer.failure(), { code: 400, reason: "unreadable request" });
}

{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  peer.write(encodeJsonFrame(FRAME.OPEN, {}));
  check("and an OPEN with no path at all is refused", await peer.failure(), { code: 400, reason: "unreadable open" });
}

// `new URL` still lets `//` and `/\` resolve to another origin, so the origin is compared after parsing.
// Each door asserts the refusal and that the sink saw no dial, against a control dial made first.

{
  const base = `ws://${local.host}:${local.port}`;
  check("the concatenated form reads the daemon's own host:port as userinfo", new URL(`${base}@${elsewhere}/x`).host, elsewhere);
  check("a reference beginning // resolves to another origin", new URL(`//${elsewhere}/x`, base).host, elsewhere);
  check("and so does one beginning /\\, which is not caught by a // prefix check", new URL(`/\\${elsewhere}/x`, base).host, elsewhere);
  check("while the path of an honest request stays on the daemon's own origin", new URL("/health", base).host, `${local.host}:${local.port}`);
}

{
  const answered = await new Promise<number>((resolve) => {
    const probe = httpRequest(`http://${elsewhere}/x`, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    probe.on("error", () => resolve(0));
    probe.end();
  });
  check("the control: a dial at that address is answered by the sink", answered, 204);
  report(
    "and it moved the counter, so \"nothing was dialled\" is an observable rather than a constant",
    await settle(() => sinkDials === 1, 250),
    `${sinkDials} connection(s) to ${elsewhere}`,
  );
  sinkDials = 0;
}

for (const path of [`@${elsewhere}/x`, `//${elsewhere}/x`, `/\\${elsewhere}/x`]) {
  {
    const peer = await Peer.connect(device.secretKey);
    check("a session is established", await peer.hello(sessionCap), FRAME.READY);
    peer.write(encodeJsonFrame(FRAME.OPEN, { path }));
    check(`OPEN ${path} is refused`, await peer.failure(), { code: 400, reason: "unreadable open" });
  }
  {
    const peer = await Peer.connect(device.secretKey);
    check("a session is established", await peer.hello(sessionCap), FRAME.READY);
    peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path, headers: {}, body: false }));
    check(`REQUEST ${path} is refused`, await peer.failure(), { code: 400, reason: "unreadable request" });
  }
}

report(
  "and nothing was dialled at the address those six frames named",
  !(await settle(() => sinkDials > 0, 250)),
  `${sinkDials} connections to ${elsewhere} in 250 ms`,
);

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/slow", headers: {}, body: false }));
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "GET", path: "/echo", headers: {}, body: false }));
  check("a second request on a connection already carrying one is refused", await peer.failure(), {
    code: 400,
    reason: "this connection is already carrying something",
  });
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the first socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.OPEN, { path: "/idle" }));
  check("and a second OPEN on the same connection is refused rather than orphaning the first", await peer.failure(), {
    code: 400,
    reason: "this connection is already carrying something",
  });
}

// Assert on the fixture, not the FAILED count: `fail()` ends the stream, so one FAILED crosses whether or not the loop stopped.
{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the control: an OPEN on its own reaches the listener", await peer.open("/control-open"), FRAME.OPENED);
  report(
    "and the fixture recorded it, so this is an observable that moves",
    upgrades.some((u) => u.url === "/control-open"),
    `${upgrades.length} upgrade(s)`,
  );
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  peer.writeAll(
    encodeFrame(FRAME.REQUEST, new TextEncoder().encode("{not json")),
    encodeJsonFrame(FRAME.OPEN, { path: "/after-refusal" }),
  );
  check("an unreadable request is refused", await peer.failure(), { code: 400, reason: "unreadable request" });
  report(
    "and the OPEN behind it in the same chunk was never dispatched",
    !(await settle(() => upgrades.some((u) => u.url === "/after-refusal"), 250)),
    `${upgrades.filter((u) => u.url === "/after-refusal").length} upgrade(s) for a refused session`,
  );
}

// A late body frame is dropped, not refused: a client keeps writing after an early answer.
// Safe only because `response.on("end")` destroys the request handle.
{
  const peer = await Peer.connect(device.secretKey);
  check("a session is established", await peer.hello(sessionCap), FRAME.READY);
  check("an ordinary request is answered", (await peer.request("GET", "/health")).status, 200);
  peer.write(encodeFrame(FRAME.REQUEST_BODY, new TextEncoder().encode("late")));
  peer.write(encodeFrame(FRAME.REQUEST_END));
  check("a body frame arriving after the answer is dropped rather than refused", (await peer.request("GET", "/health")).status, 200);
  report("and the session was never failed", !peer.ended, peer.ended ? "the stream ended" : "still open");
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeFrame(FRAME.REQUEST_BODY, new TextEncoder().encode("a")));
  check("a body frame on a connection carrying a socket is refused", await peer.failure(), {
    code: 400,
    reason: "this connection is carrying a socket",
  });
}

// An answer that ends before the body was read must still release the loopback socket, or it is held until UPSTREAM_IDLE_TIMEOUT_MS.
// The first REQUEST_BODY is required: a ClientRequest with no write never flushes its head.

{
  const before = arrivals.length;
  const unfinished = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await unfinished.hello(sessionCap), FRAME.READY);
  unfinished.write(encodeJsonFrame(FRAME.REQUEST, { method: "POST", path: "/echo", headers: {}, body: true }));
  unfinished.write(encodeFrame(FRAME.REQUEST_BODY, new TextEncoder().encode("a")));
  const answered = await unfinished.collect();
  check("a request whose body the listener never reads is answered anyway", answered.status, 200);
  check("and that answer is marked whole rather than given up on", answered.ended, FRAME.RESPONSE_END);

  const finished = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await finished.hello(sessionCap), FRAME.READY);
  check("and so is one that declared no body at all", (await finished.request("POST", "/echo")).status, 200);

  const left = arrivals.at(-2);
  const done = arrivals.at(-1);
  report(
    "the control: both reached the listener, on sockets of their own",
    left !== undefined &&
      done !== undefined &&
      arrivals.length === before + 2 &&
      left.url === "/echo" &&
      done.url === "/echo" &&
      left.socket !== done.socket,
    `${arrivals.length - before} arrival(s), ${left?.socket === done?.socket ? "one socket" : "two sockets"}`,
  );

  unfinished.hangUp();
  finished.hangUp();

  report(
    "the loopback socket of the request nobody finished does not outlive the session",
    await settle(() => left?.socket.destroyed === true, 1_000),
    left?.socket.destroyed === true ? "closed" : "still open, two minutes short of the idle bound",
  );
  report(
    "while the one the daemon did finish is left for the pool",
    done?.socket.destroyed === false,
    done?.socket.destroyed === true ? "closed" : "still open",
  );
}

// "unusable close code" is `isCloseCode` refusing by name; "unusable frame" would be `dispatch` catching ws's TypeError.

for (const code of [1005, 9999]) {
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.CLOSE, { code, reason: "" }));
  check(`a CLOSE carrying ${code} is refused by name rather than thrown on`, await peer.failure(), {
    code: 400,
    reason: "unusable close code",
  });
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.CLOSE, { code: 1000, reason: "r".repeat(124) }));
  check("and a close reason above what a control frame holds is refused too", await peer.failure(), {
    code: 400,
    reason: "unusable close reason",
  });
}

{
  // The positive control: a CLOSE arm that refused everything would pass the three checks above.
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  peer.write(encodeJsonFrame(FRAME.CLOSE, { code: 4001, reason: "bye" }));
  report(
    "while a registered code reaches the socket whole",
    await settle(() => socketCloses.some((closed) => closed.code === 4001 && closed.reason === "bye")),
    JSON.stringify(socketCloses.at(-1) ?? null),
  );
}

{
  const peer = await Peer.connect(device.secretKey);
  check("a session opened after all of those refusals still completes", await peer.hello(sessionCap), FRAME.READY);
  check("and the daemon answers it exactly as before", (await peer.request("GET", "/health")).status, 200);
}

{
  const stolen = boundToken("u_abcd", strangerThumbprint);
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);

  const answer = await peer.request("GET", "/echo", {
    // Two spellings, because the strip compares `name.toLowerCase()`.
    Authorization: `Bearer ${stolen}`,
    AUTHORIZATION: `Bearer ${stolen}`,
    "X-Test": "keep",
  });
  check("the request is answered", answer.status, 200);

  const echoed = JSON.parse(answer.body) as { authorization: string | null; xTest: string | null };
  check("the listener saw the capability this channel authenticated", echoed.authorization, `Bearer ${sessionCap}`);
  report("and never the one the request carried", !answer.body.includes(stolen), `${stolen.length} bytes of somebody else's capability, dropped`);
  check("while an unrelated header is carried through untouched", echoed.xTest, "keep");
  report("with the daemon's own listener seeing one authorization rather than two", echoes.at(-1)?.authorization === `Bearer ${sessionCap}`, echoes.at(-1)?.authorization?.slice(0, 16) ?? "(none)");
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/idle"), FRAME.OPENED);
  check("a socket carries the same capability in a header", upgrades.at(-1)?.authorization, `Bearer ${sessionCap}`);
  check("and nothing in its URL", upgrades.at(-1)?.url.includes("token="), false);
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  check("the socket opens", await peer.open("/big"), FRAME.OPENED);

  const message = await peer.message();
  report("the message crossed the channel in several frames", message.chunks.length > 1, `${message.chunks.length} × up to ${MAX_FRAME_PAYLOAD} bytes`);
  check("and arrived as one whole message", message.bytes?.length ?? -1, 200_000);

  const text = new TextDecoder().decode(message.bytes ?? new Uint8Array(0));
  let parsed: { pad: string } | null = null;
  try {
    parsed = JSON.parse(text) as { pad: string };
  } catch {
    parsed = null;
  }
  report("whose JSON parses", parsed !== null, parsed === null ? text.slice(0, 40) : `pad is ${parsed.pad.length} characters`);
  report("with the character that straddled the chunk boundary intact", parsed?.pad.includes("é") === true, "no U+FFFD where é was");

  const perChunk = message.chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
  report("while a client that decoded each chunk on arrival would have corrupted it silently", perChunk !== text && perChunk.includes("�"), "U+FFFD where é was");
}

// The encrypted path's outbound queue has no ceiling of its own, and only `Peer.outboundQueued` can see it.
// `bufferedAmount` is printed, not asserted: a kernel buffer can absorb the backlog.

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);
  // Baseline taken before the socket opens: the drain listener exists only under backpressure, and the response path registers on it too.
  const drainBaseline = peer.streamListeners("drain");
  check("the socket opens", await peer.open("/flood"), FRAME.OPENED);

  // Pause before triggering: a flood that starts first races the drain and measures the clock.
  peer.stopReading();
  peer.write(encodeFrame(FRAME.MESSAGE, new TextEncoder().encode("go")));
  peer.write(encodeFrame(FRAME.MESSAGE_END));

  // Polled until it settles; `peak === 0` keeps it from settling before the flood has arrived.
  let peak = 0;
  let steady = 0;
  let last = -1;
  let peakDrain = drainBaseline;
  for (let poll = 0; poll < 600 && (peak === 0 || steady < 20); poll += 1) {
    const queued = peer.outboundQueued;
    peak = Math.max(peak, queued);
    peakDrain = Math.max(peakDrain, peer.streamListeners("drain"));
    steady = queued === last && queued > 0 ? steady + 1 : 0;
    last = queued;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  const flooded = FLOOD_MESSAGES * Buffer.byteLength(BIG);
  const held = floodSockets.at(-1)?.bufferedAmount ?? 0;
  report(
    "the control: the queue passed the mark the pause is keyed on",
    peak > MAX_FRAME_PAYLOAD * 8,
    `${peak} bytes queued, against a mark of ${MAX_FRAME_PAYLOAD * 8}`,
  );
  report(
    "and stopped there rather than taking the whole flood",
    peak < flooded / 2,
    `${peak} of ${flooded} bytes, with ${held} still on the listener's side`,
  );
  report(
    "the control: the pause hung its resume on the stream's own drain",
    peakDrain > drainBaseline,
    `${peakDrain} drain listener(s) while paused, from a baseline of ${drainBaseline}`,
  );
  // The `socketPaused ||` guard in `openSocket` keeps this to one outstanding resume.
  report(
    "and one only, however many messages piled up behind it",
    peakDrain <= drainBaseline + 1,
    `${peakDrain} at the peak, against ${drainBaseline + 1} for a single outstanding resume`,
  );

  // Guards against a pause with no resume, and is the non-vacuity control for `peak < flooded / 2`.
  peer.startReading();
  let whole = 0;
  for (let i = 0; i < FLOOD_MESSAGES; i += 1) {
    const message = await peer.message();
    if (message.bytes?.length !== Buffer.byteLength(BIG)) break;
    whole += 1;
  }
  report(
    "and every message arrives once the peer reads again",
    whole === FLOOD_MESSAGES,
    `${whole} of ${FLOOD_MESSAGES} whole messages`,
  );

  // A `drain` handler added with `on` would resume fine and leak one listener per cycle; bounded wait since the last drain lands a tick late.
  report(
    "and nothing is left on drain once the resume has fired",
    await settle(() => peer.streamListeners("drain") === drainBaseline, 1_000),
    `${peer.streamListeners("drain")} drain listener(s), from a baseline of ${drainBaseline}`,
  );
}

// Counts the `close` listeners `openSocket` hangs on the stream per socket; past ten they print to stderr from src/.
// Removing an outstanding `drain` listener is not asserted: a socket closing while paused is unreachable within these timeouts.

const SOCKET_CYCLES = 14;

// Enough frames for the loopback buffer to fill against a listener stalling 5 ms per chunk.
const UPLOAD_FRAMES = 14;

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);

  // A delta from a measured baseline, never a literal: the daemon and `Duplex.from` register `close` listeners of their own.
  const baseline = peer.streamListeners("close");
  const watch = watchListenerLeaks();

  check("the first socket opens", await peer.open("/idle"), FRAME.OPENED);
  const perSocket = peer.streamListeners("close") - baseline;
  report(
    "the control: a socket hangs a listener on a stream it did not make",
    perSocket > 0,
    `${perSocket} close listener(s) per socket, over a baseline of ${baseline}`,
  );
  check("and closing it is answered with the daemon's own CLOSE", await peer.closeSocket(), FRAME.CLOSE);
  report(
    "and the listener comes off with the socket",
    peer.streamListeners("close") === baseline,
    `${peer.streamListeners("close")} after one cycle, from a baseline of ${baseline}`,
  );

  let cycles = 1;
  let peak = peer.streamListeners("close");
  while (cycles < SOCKET_CYCLES) {
    if ((await peer.open("/idle")) !== FRAME.OPENED) break;
    peak = Math.max(peak, peer.streamListeners("close"));
    if ((await peer.closeSocket()) !== FRAME.CLOSE) break;
    peak = Math.max(peak, peer.streamListeners("close"));
    cycles += 1;
  }

  report(
    `${SOCKET_CYCLES} legal OPEN/CLOSE cycles on one session`,
    cycles === SOCKET_CYCLES,
    `${cycles} of ${SOCKET_CYCLES}`,
  );
  report(
    "leave the count where they found it",
    peer.streamListeners("close") === baseline,
    `${peer.streamListeners("close")} close listener(s), from a baseline of ${baseline}`,
  );
  report(
    "and never took it above what one socket costs",
    peak <= baseline + perSocket,
    `peak ${peak}, against ${baseline + perSocket} for one socket at a time`,
  );
  report(
    "with nothing in src/ printing a listener-leak warning along the way",
    watch.leaks.length === 0,
    watch.leaks[0] ?? "no MaxListenersExceededWarning",
  );
  check("and the session still opens a socket afterwards", await peer.open("/idle"), FRAME.OPENED);
  watch.stop();
}

{
  const peer = await Peer.connect(device.secretKey, fixtureLocal);
  check("a session against the driver's own listener", await peer.hello(sessionCap), FRAME.READY);

  // The upload direction's listener leak is not asserted: its emitter is private to `SecureSession` and the warning count is not reproducible here.
  const part = new Uint8Array(MAX_FRAME_PAYLOAD);
  peer.write(encodeJsonFrame(FRAME.REQUEST, { method: "POST", path: "/slurp-slow", headers: {}, body: true }));
  // One `setImmediate` between frames: waiting per cycle lets loopback drain (write answers true), and a burst lands in one chunk (one pause).
  for (let i = 0; i < UPLOAD_FRAMES; i += 1) {
    peer.write(encodeFrame(FRAME.REQUEST_BODY, part));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  peer.write(encodeFrame(FRAME.REQUEST_END));

  const answered = await peer.collect();
  const uploaded = UPLOAD_FRAMES * MAX_FRAME_PAYLOAD;
  check("an upload the listener reads to the end is answered", answered.status, 200);
  check("and that answer is marked whole rather than given up on", answered.ended, FRAME.RESPONSE_END);
  report(
    "with every byte of it delivered",
    answered.body.includes(`"read":${uploaded}`),
    `${answered.body.slice(0, 40)}, against ${uploaded} sent`,
  );
  report(
    "and the upload went through the daemon's own backpressure",
    peer.inboundPauses > 0,
    `${peer.inboundPauses} pause/resume cycle(s) on the way up`,
  );
}

listener.close();
fixture.closeAllConnections();
fixture.close();
sink.closeAllConnections();
sink.close();
