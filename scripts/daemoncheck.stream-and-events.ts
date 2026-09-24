import type { Server } from "node:http";
import { PassThrough } from "node:stream";
import { connect as netConnect, type AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { MemoryEventStore, estimateBytes, truncateEvent, type ToolCallEvent } from "../src/events.js";
import { toolCallLineage } from "../src/acp/subagents.js";
import { splitAsyncTaskUpdates } from "../src/acp/client.js";
import { SessionRegistry } from "../src/registry.js";
import { EVENTS_PAGE_LIMIT, createApp } from "../src/server.js";
import { openStores } from "../src/store/sqlite.js";
import { check, report } from "./daemoncheck.env.js";
import {
  sandbox,
  users,
  now,
  tokenFor,
  verifier,
  storeOf,
  rowFor,
  registry,
  credentials,
  app,
  injectWebSocket,
  get,
} from "./daemoncheck.fixtures.js";

// Driven over a real socket: app.fetch cannot upgrade, so every session id answers 404 alike.
process.stdout.write("\nthe stream, over a real socket\n");

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
// serve is typed as possibly an Http2Server, and injectWebSocket wants the http one.
injectWebSocket(server as unknown as Server);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;

/** Resolves how the socket ended: open with a frame, or refused. */
function attach(sessionId: string, sub: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/sessions/${sessionId}/stream?token=${tokenFor(sub)}`,
    );
    const done = (answer: string): void => {
      try {
        socket.close();
      } catch {
        // Already closing; the answer is what matters.
      }
      resolve(answer);
    };
    socket.on("message", () => done("frame"));
    socket.on("error", () => done("refused"));
    socket.on("unexpected-response", () => done("refused"));
    socket.on("close", () => resolve("closed"));
    setTimeout(() => done("silent"), 2_000);
  });
}

/** Every frame one attach delivers, in order, up to and including caught_up. */
function streamFrames(
  atPort: number,
  sessionId: string,
  sub: string,
  since: number,
  /** Raw byte length per message, taken here because a re-serialised frame is not the bytes that crossed. */
  sizes?: number[],
): Promise<Record<string, any>[]> {
  return new Promise((resolve) => {
    const out: Record<string, any>[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${atPort}/sessions/${sessionId}/stream?since=${since}&token=${tokenFor(sub)}`,
    );
    const done = (): void => {
      try {
        socket.close();
      } catch {
        // Already closing; what arrived is the answer.
      }
      resolve(out);
    };
    socket.on("message", (data: Buffer) => {
      let frame: Record<string, any>;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      out.push(frame);
      sizes?.push(data.length);
      if (frame["type"] === "caught_up") done();
    });
    socket.on("error", done);
    setTimeout(done, 5_000);
  });
}

check("attaching to a real session opens and delivers", await attach("s_one", "u_alice"), "frame");
check("an id that exists nowhere is refused, over a real upgrade", await attach("s_nope", "u_alice"), "refused");

{
  // @hono/node-ws throws on a target llhttp accepts and leaks the fd; driven on a raw socket since fetch and ws normalise it.
  const spoke = (target: string): Promise<string> =>
    new Promise((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port }, () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let seen = "";
      socket.on("data", (chunk: Buffer) => {
        seen += chunk.toString("utf8");
        if (seen.includes("\r\n")) {
          socket.destroy();
          resolve(seen.split("\r\n")[0] ?? "");
        }
      });
      socket.on("error", () => resolve("(socket error)"));
      socket.on("close", () => resolve(seen.split("\r\n")[0] ?? "(closed with nothing)"));
      setTimeout(() => {
        socket.destroy();
        resolve("(held open)");
      }, 2_000);
    });

  for (const target of ["//%", "/\\", "//["]) {
    check(`an unparseable target is answered rather than held: ${target}`, await spoke(target), "HTTP/1.1 400 Bad Request");
  }
  // The ordinary handshake must still work, so the guard wraps the listener rather than replacing it.
  check("while an ordinary handshake is untouched", await attach("s_one", "u_alice"), "frame");
}

// A query token authenticates only a WebSocket handshake: in any other URL it leaks a bearer into history and Referer.
{
  const query = `token=${encodeURIComponent(tokenFor("u_alice"))}`;
  const bare = async (path: string): Promise<Response> => app.fetch(new Request(`http://d${path}`));

  check("an ordinary GET is not authenticated by a token in the URL", (await bare(`/sessions?${query}`)).status, 401);
  check("nor is the route that serves a file's bytes", (await bare(`/sessions/s_one/files?path=notes.txt&${query}`)).status, 401);
  // The positive control: the header still authenticates every route.
  check("while the header is still all any route ever needed", (await get("/sessions", "u_alice")).status, 200);
  // Keyed on the Upgrade header, not the route path: a path list would fail open once it fell behind.
  const handshaking = await app.fetch(
    new Request(`http://d/sessions?${query}`, { headers: { upgrade: "websocket" } }),
  );
  check("a request that says it is a handshake may still carry it in the query", handshaking.status, 200);
}

{
  // An attach replays the newest ATTACH_REPLAY_MAX and names the skipped range as backlog, which is not a loss.
  const many = registry.get("s_three");
  for (let n = 1; n <= 3_000; n += 1) {
    many?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}`, messageId: null });
  }
  const lastSeq = many?.log.stats().lastSeq ?? 0;

  const frames = await streamFrames(port, "s_three", "u_alice", 0);

  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  check("a since=0 attach past the cap is told, with `backlog`", lagged.map((f) => f["reason"]), ["backlog"]);
  // Must stay under MAX_QUEUE_EVENTS, or the attach becomes a slow_consumer close.
  check("and replays no more than the cap", delivered <= 2_000, true);
  check("but genuinely replays that much rather than nothing", delivered > 1_900, true);
  // The skipped range must be named so the client can page it, and caught_up must sit at the head.
  check("the skipped range starts at the first event", lagged[0]?.["from"], 1);
  check("and ends where the replay begins", lagged[0]?.["to"], lastSeq - 2_000);
  check("the socket still goes live at the head of the log", caughtUp?.["seq"], lastSeq);
}

await new Promise<void>((resolve) => server.close(() => resolve()));

// evicted and backlog ranges must be adjacent: overlapping would report the same seqs as destroyed and as pageable.
process.stdout.write("\nan attach that is both evicted and behind\n");
{
  // The one registry here whose store evicts; dropped > 0 is the whole precondition.
  const evicting = new MemoryEventStore({ maxEventsPerSession: 5_000 });
  const lagRegistry = new SessionRegistry(evicting, storeOf([rowFor("s_lag", join(users, "u_alice", "lag"))]));
  lagRegistry.restore({ reapOrphans: false });
  const { app: lagApp, injectWebSocket: injectLag } = createApp({
    registry: lagRegistry,
    verifier,
    instanceId: "i_lag",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const lagServer = serve({ fetch: lagApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectLag(lagServer as unknown as Server);
  await new Promise<void>((resolve) => lagServer.once("listening", resolve));
  const lagPort = (lagServer.address() as AddressInfo).port;

  // Past both the store's window and the replay cap, so one attach produces both frames.
  const managed = lagRegistry.get("s_lag");
  for (let n = 1; n <= 6_000; n += 1) {
    managed?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}`, messageId: null });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  // The positive control: without eviction this section is about a session that lost nothing.
  check("the store really did evict, or none of this is being driven", stats.dropped > 0, true);

  const frames = await streamFrames(lagPort, "s_lag", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // The loss is reported before the range that only has to be fetched.
  check("both are reported, the loss before the backlog", lagged.map((f) => f["reason"]), ["evicted", "backlog"]);
  check(
    "and the second range begins exactly where the first ended",
    (lagged[0]?.["to"] ?? -1) + 1,
    lagged[1]?.["from"],
  );
  check(
    "so the two counts add up to exactly what was not delivered",
    lagged.reduce((n, f) => n + Number(f["dropped"] ?? 0), 0),
    stats.lastSeq - delivered,
  );
  check("the replay is still exactly the cap", delivered, 2_000);
  check("and the socket still goes live at the head of the log", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => lagServer.close(() => resolve()));
}

// Under the count cap but over MAX_QUEUE_BYTES, so a collapse here can only come from the byte ceiling.
process.stdout.write("\nan attach too large to replay down a socket\n");
{
  const fatRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_fatreplay", join(users, "u_alice", "fatreplay"))]),
  );
  fatRegistry.restore({ reapOrphans: false });
  const { app: fatApp, injectWebSocket: injectFat } = createApp({
    registry: fatRegistry,
    verifier,
    instanceId: "i_fat",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const fatServer = serve({ fetch: fatApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectFat(fatServer as unknown as Server);
  await new Promise<void>((resolve) => fatServer.once("listening", resolve));
  const fatPort = (fatServer.address() as AddressInfo).port;

  const managed = fatRegistry.get("s_fatreplay");
  const fat = "b".repeat(48 * 1024);
  for (let n = 1; n <= 400; n += 1) {
    managed?.log.append({ type: "text", role: "agent", thought: false, text: fat , messageId: null });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  check("the fixture is far under the replay cap", stats.lastSeq < 2_000, true);
  check("and far over the outbound byte ceiling", stats.approxBytes > 16 * 1024 * 1024, true);

  const frames = await streamFrames(fatPort, "s_fatreplay", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // attach itself emits no lagged here, so the single frame is the collapse's own.
  check("exactly one lagged frame, and it is the collapse's", lagged.length, 1);
  check("a replay too large in bytes is a backlog, not a slow consumer", lagged[0]?.["reason"], "backlog");
  check("naming a range that ends at the head of the log", lagged[0]?.["to"], stats.lastSeq);
  check("and the socket still goes live there rather than being closed", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => fatServer.close(() => resolve()));
}

// A batch must be cut on UTF-8 wire bytes, not estimateBytes: escape-heavy stderr is ~6x larger on the wire.
// Measured on the direct path, where the ws client sees the exact message size.
process.stdout.write("\nthe outbound batch, cut on bytes rather than on an estimate\n");
{
  const cutRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_cut", join(users, "u_alice", "cut"))]),
  );
  cutRegistry.restore({ reapOrphans: false });
  const { app: cutApp, injectWebSocket: injectCut } = createApp({
    registry: cutRegistry,
    verifier,
    instanceId: "i_cut",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const cutServer = serve({ fetch: cutApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectCut(cutServer as unknown as Server);
  await new Promise<void>((resolve) => cutServer.once("listening", resolve));
  const cutPort = (cutServer.address() as AddressInfo).port;

  const managed = cutRegistry.get("s_cut");
  // Well under DEFAULT_MAX_EVENT_BYTES, so nothing is clipped at ingest.
  const escapes = "\u001b".repeat(24_000);
  const appended: { type: "text"; role: "agent"; thought: false; text: string; messageId: null }[] = [];
  for (let n = 0; n < 40; n += 1) {
    const event = { type: "text", role: "agent", thought: false as const, text: escapes, messageId: null } as const;
    managed?.log.append(event);
    appended.push(event as (typeof appended)[number]);
  }
  const lastSeq = managed?.log.stats().lastSeq ?? 0;

  const sizes: number[] = [];
  const frames = await streamFrames(cutPort, "s_cut", "u_alice", 0, sizes);
  const eventFrames = frames
    .map((frame, at) => ({ frame, bytes: sizes[at] ?? 0 }))
    .filter((f) => f.frame["type"] === "events");

  // Before any Math.max: an empty spread is -Infinity and the ceiling check would be vacuous.
  report("the socket delivered event frames at all", eventFrames.length > 0, `${eventFrames.length} events frame(s)`);
  const widest = eventFrames.reduce((most, f) => (f.bytes > most ? f.bytes : most), 0);

  // The non-vacuity control: the estimate rule must produce an oversized batch on this fixture.
  let charged = 0;
  let wouldTake = 0;
  for (const event of appended) {
    const one = estimateBytes(event) + 64;
    if (wouldTake > 0 && charged + one > 512 * 1024) break;
    charged += one;
    wouldTake += 1;
  }
  const wouldHaveSent = Buffer.byteLength(
    JSON.stringify({ type: "events", events: appended.slice(0, wouldTake).map((event, at) => ({ seq: at + 1, event })) }),
    "utf8",
  );
  report(
    "and the fixture really is one where the two numbers disagree",
    wouldHaveSent > 1024 * 1024,
    `the estimate rule would have written ${wouldHaveSent} bytes for ${wouldTake} events, charging ${charged}`,
  );

  report(
    "no stream frame is larger than the far end will reassemble",
    widest <= 1024 * 1024,
    `widest ${widest} bytes against MAX_SOCKET_MESSAGE_BYTES 1048576`,
  );
  // The only licensed way past the ceiling is a lone first event.
  check(
    "and a frame over the batch ceiling carries exactly one event",
    eventFrames.filter((f) => f.bytes > 512 * 1024).every((f) => (f.frame["events"] as unknown[]).length === 1),
    true,
  );
  // Progress, so bounding the frame by dropping events is not mistaken for cutting the batch.
  const delivered = eventFrames.reduce((n, f) => n + (f.frame["events"] as unknown[]).length, 0);
  check("every event still arrives", delivered, 40);
  check("with the socket caught up at the head", frames.find((f) => f["type"] === "caught_up")?.["seq"], lastSeq);

  await new Promise<void>((resolve) => cutServer.close(() => resolve()));
}

// A lone event over BATCH_MAX_BYTES must still be sent, or flush emits empty frames for ever.
process.stdout.write("\nand one event too large for the batch is still sent\n");
{
  const soloRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_solo", join(users, "u_alice", "solo"))]),
  );
  soloRegistry.restore({ reapOrphans: false });
  const { app: soloApp, injectWebSocket: injectSolo } = createApp({
    registry: soloRegistry,
    verifier,
    instanceId: "i_solo",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const soloServer = serve({ fetch: soloApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectSolo(soloServer as unknown as Server);
  await new Promise<void>((resolve) => soloServer.once("listening", resolve));
  const soloPort = (soloServer.address() as AddressInfo).port;

  const managed = soloRegistry.get("s_solo");
  managed?.log.append({
    type: "text",
    role: "agent",
    thought: false,
    text: "\u001b".repeat(200_000),
    messageId: null,
  });
  const lastSeq = managed?.log.stats().lastSeq ?? 0;

  const sizes: number[] = [];
  const frames = await streamFrames(soloPort, "s_solo", "u_alice", 0, sizes);
  const eventFrames = frames
    .map((frame, at) => ({ frame, bytes: sizes[at] ?? 0 }))
    .filter((f) => f.frame["type"] === "events");

  check(
    "one event past the batch ceiling is sent alone rather than wedging the socket",
    [eventFrames.length, (eventFrames[0]?.frame["events"] as unknown[] | undefined)?.length],
    [1, 1],
  );
  check("and the socket still reaches the head", frames.find((f) => f["type"] === "caught_up")?.["seq"], lastSeq);
  report(
    "while that frame is still one the far end will reassemble",
    (eventFrames[0]?.bytes ?? 0) > 512 * 1024 && (eventFrames[0]?.bytes ?? 0) <= 1024 * 1024,
    `${eventFrames[0]?.bytes ?? 0} bytes: over BATCH_MAX_BYTES, under MAX_SOCKET_MESSAGE_BYTES`,
  );

  await new Promise<void>((resolve) => soloServer.close(() => resolve()));
}

// hello carries the snapshot and cannot be split; driven on fitSnapshotFrame since no offline fixture reaches its rungs.
process.stdout.write("\na control frame too large to send whole\n");
{
  const { fitSnapshotFrame, CONTROL_MAX_BYTES } = await import("../src/server.js");
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

  const permission = (n: number, blob: number): Record<string, unknown> => ({
    id: `p_${n}`,
    toolCallId: `tc_${n}`,
    title: `Permission ${n}`,
    rawInput: { command: "x".repeat(blob) },
    content: "y".repeat(blob),
    options: [{ optionId: "o_yes", name: "Yes", kind: "allow_once" }],
  });
  const frameWith = (session: Record<string, unknown>): Record<string, unknown> => ({
    type: "hello",
    instanceId: "i_fit",
    firstSeq: 1,
    lastSeq: 1,
    since: 0,
    session,
  });

  // A frame that fits comes back byte-identical and with no reduced marker, since absent means whole.
  const small = frameWith({ backgroundTasks: [], pendingPermissions: [], pendingElicitations: [], id: "s_small" });
  const smallBuilt = JSON.stringify(small);
  check("a frame that already fits is returned unchanged", fitSnapshotFrame(small, smallBuilt), smallBuilt);
  check(
    "and therefore carries no reduction marker at all",
    Object.hasOwn(
      (JSON.parse(fitSnapshotFrame(small, smallBuilt)) as { session: Record<string, unknown> }).session,
      "reduced",
    ),
    false,
  );

  // Rung one alone is enough here, so the ladder must stop as soon as it can.
  const fatBlobs = frameWith({
    id: "s_blobs",
    backgroundTasks: [{ id: "b_1", outputFilePath: "/tmp/" + "p".repeat(4_000) }],
    pendingPermissions: [permission(1, 400_000)],
    pendingElicitations: [],
  });
  const fatBlobsBuilt = JSON.stringify(fatBlobs);
  report("the blob fixture really is over the ceiling", bytes(fatBlobsBuilt) > CONTROL_MAX_BYTES, `${bytes(fatBlobsBuilt)} bytes against ${CONTROL_MAX_BYTES}`);
  const fittedBlobs = fitSnapshotFrame(fatBlobs, fatBlobsBuilt);
  report("and the fitted frame is under it", bytes(fittedBlobs) <= CONTROL_MAX_BYTES, `${bytes(fittedBlobs)} bytes`);
  const blobsBack = JSON.parse(fittedBlobs) as { session: { pendingPermissions: { id: string }[]; backgroundTasks: { outputFilePath: string | null }[] } };
  // Reduced, not dropped: an invisible permission is a turn nobody can answer.
  check("with the permission still there to be answered", blobsBack.session.pendingPermissions.map((p) => p.id), ["p_1"]);
  check("and the background task's path nulled rather than the task removed", blobsBack.session.backgroundTasks.map((t) => t.outputFilePath), [null]);
  // blobs marks rung one, which can fire with no row cut; only it is recoverable from GET /sessions/:id.
  const blobsMark = (JSON.parse(fittedBlobs) as { session: { reduced?: Record<string, unknown> } }).session.reduced;
  check("and the frame says it is a reduction rather than a whole record", blobsMark, {
    pendingPermissions: 1,
    pendingElicitations: 0,
    blobs: true,
  });

  // Rung two needs its weight in the row count, or rung one runs twice and this passes vacuously.
  const many = frameWith({
    id: "s_many",
    backgroundTasks: [],
    // The weight is in title and options, which rung one does not touch.
    pendingPermissions: Array.from({ length: 400 }, (_, i) => ({
      id: `p_${i}`,
      toolCallId: `tc_${i}`,
      title: `Permission ${i} ${"t".repeat(2_000)}`,
      rawInput: { command: "x" },
      content: "y",
      options: [
        { optionId: "o_yes", name: "Yes ".repeat(200), kind: "allow_once" },
        { optionId: "o_no", name: "No ".repeat(200), kind: "reject_once" },
      ],
    })),
    pendingElicitations: [],
  });
  const manyBuilt = JSON.stringify(many);
  report("the count fixture really is over the ceiling", bytes(manyBuilt) > CONTROL_MAX_BYTES, `${bytes(manyBuilt)} bytes`);
  const fittedMany = fitSnapshotFrame(many, manyBuilt);
  const manyBack = JSON.parse(fittedMany) as { session: { pendingPermissions: unknown[] } };
  report("the halving rung ran, not just the blob one", manyBack.session.pendingPermissions.length < 400, `${manyBack.session.pendingPermissions.length} of 400 kept`);
  report("and the fitted frame is under the ceiling", bytes(fittedMany) <= CONTROL_MAX_BYTES, `${bytes(fittedMany)} bytes`);
  // Halving stops at one: a hello with no permission looks answerable and is not.
  report("with at least one permission left", manyBack.session.pendingPermissions.length >= 1, `${manyBack.session.pendingPermissions.length} kept`);
  // reduced carries the true count, so waitingCount does not flap between poll and frame.
  const manyMark = (JSON.parse(fittedMany) as { session: { reduced?: { pendingPermissions?: number } } }).session.reduced;
  check("and the frame says how many there really are", manyMark?.pendingPermissions, 400);
  report(
    "which is more than it is carrying, or the marker says nothing",
    (manyMark?.pendingPermissions ?? 0) > manyBack.session.pendingPermissions.length,
    `${manyMark?.pendingPermissions} against ${manyBack.session.pendingPermissions.length} on the frame`,
  );

  // The questions side: 200 at MAX_ELICITATION_MESSAGE_CHARS is the worst case the ladder can be handed.
  const asking = frameWith({
    id: "s_asking",
    backgroundTasks: [],
    pendingPermissions: [],
    pendingElicitations: Array.from({ length: 200 }, (_, i) => ({
      elicitationId: `e_${i}`,
      toolCallId: null,
      message: "m".repeat(4_096),
      fieldCount: 2,
      raisedAt: 1_700_000_000_000 + i,
    })),
  });
  const askingBuilt = JSON.stringify(asking);
  report("the question fixture really is over the ceiling", bytes(askingBuilt) > CONTROL_MAX_BYTES, `${bytes(askingBuilt)} bytes`);
  const fittedAsking = fitSnapshotFrame(asking, askingBuilt);
  const askingBack = JSON.parse(fittedAsking) as {
    session: { pendingElicitations: { elicitationId: string }[]; reduced?: { pendingElicitations?: number } };
  };
  report("and the fitted frame is under it", bytes(fittedAsking) <= CONTROL_MAX_BYTES, `${bytes(fittedAsking)} bytes`);
  report(
    "the halving cut questions rather than only permissions",
    askingBack.session.pendingElicitations.length < 200 && askingBack.session.pendingElicitations.length >= 1,
    `${askingBack.session.pendingElicitations.length} of 200 kept`,
  );
  // The oldest are kept, so oldestWait and the first card stay right.
  check("keeping the oldest rather than an arbitrary slice", askingBack.session.pendingElicitations[0]?.elicitationId, "e_0");
  check("and the frame says how many questions there really are", askingBack.session.reduced?.pendingElicitations, 200);

  // A frame no rung can shrink is sent anyway: a hello that never arrives is the stall.
  const stubborn = frameWith({
    id: "s_stubborn",
    backgroundTasks: [],
    pendingPermissions: [permission(1, 10)],
    pendingElicitations: [],
    note: "z".repeat(CONTROL_MAX_BYTES + 1_000),
  });
  const stubbornBuilt = JSON.stringify(stubborn);
  const fittedStubborn = fitSnapshotFrame(stubborn, stubbornBuilt);
  report(
    "a frame neither rung can shrink is still sent rather than dropped",
    fittedStubborn.length > 0 && JSON.parse(fittedStubborn)["type"] === "hello",
    `${bytes(fittedStubborn)} bytes, still a hello`,
  );

  const noSession = { type: "caught_up", seq: 7 };
  const noSessionBuilt = JSON.stringify(noSession);
  check("a control frame with no snapshot is left alone", fitSnapshotFrame(noSession, noSessionBuilt), noSessionBuilt);
}

// A byte-capped page keeps its oldest events, so a client continues from the last seq received, not since + limit.
process.stdout.write("\nthe events page\n");
{
  interface EventPage {
    events: { seq: number; ts: number; event: unknown }[];
    firstSeq: number;
    lastSeq: number;
    dropped: number;
    gap: boolean;
  }

  const pagePath = join(sandbox, "paging", "reemoat.db");
  // Two opens: seedFloors runs at open, so an all-gone session needs its row already there.
  {
    const seed = openStores({ path: pagePath, instanceId: "i_page_seed" });
    seed.sessions.put(rowFor("s_page", join(users, "u_alice", "paging")));
    seed.sessions.put(rowFor("s_fat", join(users, "u_alice", "paging-fat")));
    // The table knows nothing about this session while its row says the log reached 500.
    seed.sessions.put({
      ...rowFor("s_gone", join(users, "u_alice", "paging-gone")),
      lastSeq: 500,
      dropped: 500,
    });
    seed.close();
  }

  // Scaled off EVENTS_PAGE_LIMIT so both eviction and the count clamp are reachable in one store.
  const pageCap = EVENTS_PAGE_LIMIT * 4;
  const store = openStores({ path: pagePath, instanceId: "i_page", maxEventsPerSession: pageCap });
  // Small events, so the count clamp bounds a page here; the byte cap is measured on s_fat.
  for (let n = 1; n <= pageCap + 1_000; n += 1) {
    store.events.append("s_page", { type: "text", role: "agent", thought: false, text: `p${n}`, messageId: null });
  }
  // Large enough that the byte budget cuts the page before both the count clamp and the end of the log.
  const fat = "f".repeat(8 * 1024);
  for (let n = 1; n <= 600; n += 1) {
    store.events.append("s_fat", { type: "text", role: "agent", thought: false, text: fat , messageId: null });
  }

  const pageRegistry = new SessionRegistry(store.events, store.sessions);
  pageRegistry.restore({ reapOrphans: false });
  const { app: pageApp } = createApp({
    registry: pageRegistry,
    verifier,
    instanceId: "i_page",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const pageOf = async (id: string, query: string): Promise<EventPage> => {
    const response = await pageApp.fetch(
      new Request(`http://d/sessions/${id}/events${query}`, {
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    return (await response.json()) as EventPage;
  };

  // since is exclusive, as on attach: an inclusive read would repeat one event at every page boundary.
  const window = await pageOf("s_page", "?since=2000&limit=5");
  check("`since` is exclusive, so a client's own cursor is never repeated", window.events.map((stored) => stored.seq), [
    2001, 2002, 2003, 2004, 2005,
  ]);

  const clamped = await pageOf("s_page", "?since=2000&limit=1000000");
  // Clamped to EVENTS_PAGE_LIMIT, the bound the backlog reason hands a client over to.
  check("a page is clamped to what one request may carry", clamped.events.length, EVENTS_PAGE_LIMIT);
  check(
    "and runs from the cursor to the clamp, ascending with no hole",
    clamped.events.every((stored, i) => stored.seq === 2001 + i),
    true,
  );

  const capped = await pageOf("s_fat", "?since=0");
  check("a page of large events is cut short by bytes rather than by count", capped.events.length < 500, true);
  // Unreachable with today's defaults, since one event is always under the page budget; kept as the precondition for events[0].
  check("but never to nothing, since one oversized event must not wedge a reader", capped.events.length >= 1, true);
  check("what it keeps is the OLDEST requested seq", capped.events[0]?.seq, 1);
  check(
    "so it is short at the new end, and the next page carries on from the last seq received",
    capped.events.at(-1)?.seq,
    capped.events.length,
  );
  check(
    "the newest seq asked for is precisely the one that did not fit",
    capped.events.some((stored) => stored.seq === 500),
    false,
  );

  // firstSeq is oldestAvailable, not the raw column, or a client pages for history that cannot be served.
  const evicted = await pageOf("s_page", "?since=0&limit=1");
  check("a log whose prefix is gone does not claim to begin at 1", evicted.firstSeq, evicted.dropped + 1);
  check("and a cursor below that floor is named as a gap", evicted.gap, true);
  check(
    "a cursor exactly at the floor is not a gap",
    (await pageOf("s_page", `?since=${evicted.dropped}&limit=1`)).gap,
    false,
  );
  check(
    "and one seq below it is",
    (await pageOf("s_page", `?since=${evicted.dropped - 1}&limit=1`)).gap,
    true,
  );

  // An empty log with an intact sequence has raw firstSeq 0, which makes every gap check answer no gap.
  const gone = await pageOf("s_gone", "?since=0");
  check("a session whose events are all gone serves none", gone.events, []);
  check("while its sequence is intact", gone.lastSeq, 500);
  check("and history begins one past the end rather than at 1 or at 0", gone.firstSeq, gone.lastSeq + 1);
  check("with a cursor of 0 named as the gap it is", gone.gap, true);

  process.stdout.write("\nwhat crosses the wire, and what must not be touched\n");
  {
    // compressible keys on content type, not path: a compressed file stream's content-length would defeat the client's size guard.
    const raw = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
      pageApp.fetch(
        new Request(`http://d${path}`, {
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, ...headers },
        }),
      );

    const query = "/sessions/s_page/events?since=0&limit=5000";
    const packed = await raw(query, { "accept-encoding": "gzip" });
    const packedBody = Buffer.from(await packed.arrayBuffer());
    check("a page a client will take gzipped is gzipped", packed.headers.get("content-encoding"), "gzip");
    check("and says so in its length", packed.headers.get("content-length"), String(packedBody.byteLength));
    check("and tells a cache what it varied on", (packed.headers.get("vary") ?? "").includes("accept-encoding"), true);

    const plain = await raw(query);
    const plainPage = (await plain.json()) as EventPage;
    check("a client that did not ask for it gets none", plain.headers.get("content-encoding"), null);

    // A small compressible answer must keep its body: sizing it consumes the stream.
    const small = await raw("/sessions/s_page/events?since=0&limit=2", { "accept-encoding": "gzip" });
    check("a small answer is not compressed", small.headers.get("content-encoding"), null);
    // Read through a catch, so a consumed body fails one check rather than ending the driver.
    const smallText = await small.text().then(
      (text) => text,
      (error: unknown) => `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    check("and it still has its body", smallText.slice(0, 11), '{"events":[');
    const smallEvents = smallText.startsWith('{"events":[') ? (JSON.parse(smallText) as EventPage).events.length : -1;
    check("carrying what was asked for", smallEvents, 2);
    check("with the status it had", small.status, 200);
    const unpacked = JSON.parse(gunzipSync(packedBody).toString("utf8")) as EventPage;
    check(
      "and the two carry the same events, which is the only thing that matters",
      [unpacked.events.length, unpacked.events.at(-1)?.seq, unpacked.firstSeq],
      [plainPage.events.length, plainPage.events.at(-1)?.seq, plainPage.firstSeq],
    );
    // c.json sets no content-length, so the size is measured off the body.
    const plainBytes = Buffer.byteLength(JSON.stringify(plainPage));
    report(
      "measured on this fixture",
      packedBody.byteLength * 4 < plainBytes,
      `${(packedBody.byteLength / 1024).toFixed(0)} KiB gzipped from ${(plainBytes / 1024).toFixed(0)} KiB`,
    );

    store.close();
  }
}

process.stdout.write("\nsubagent lineage\n");
{
  const call = (meta: unknown, id = "toolu_child"): unknown =>
    toolCallLineage({ toolCallId: id, _meta: meta });

  check(
    "claude's spawn is a subagent with no parent of its own",
    call({ claudeCode: { toolName: "Agent", subagent: true } }),
    { parentToolCallId: null, subagent: true },
  );
  check(
    "and a call inside it carries the parent's id, byte for byte",
    call({ claudeCode: { toolName: "Read", parentToolUseId: "toolu_parent" } }),
    { parentToolCallId: "toolu_parent", subagent: false },
  );

  // Kimi sends no _meta, so it gets false by absence rather than by matching its Agent tool.
  check("kimi sends no metadata, and that is the answer", call(undefined), {
    parentToolCallId: null,
    subagent: false,
  });
  check("a `_meta` without claude's key says nothing", call({ somethingElse: {} }), {
    parentToolCallId: null,
    subagent: false,
  });

  // Never coerced: a stringified number names a call that will never exist.
  for (const [label, value] of [
    ["a number", 42],
    ["an object", {}],
    ["the empty string", ""],
    ["null", null],
  ] as const) {
    check(
      `a parent id that is ${label} is no parent`,
      call({ claudeCode: { parentToolUseId: value } }),
      { parentToolCallId: null, subagent: false },
    );
  }

  check(
    'the string "true" is not the boolean true',
    call({ claudeCode: { subagent: "true" } }),
    { parentToolCallId: null, subagent: false },
  );

  check(
    "a call cannot run inside itself",
    call({ claudeCode: { parentToolUseId: "toolu_self" } }, "toolu_self"),
    { parentToolCallId: null, subagent: false },
  );

  // Bounded at ingest: truncateEvent passes parentToolCallId through untouched.
  check(
    "an id too long to be one is no parent",
    call({ claudeCode: { parentToolUseId: "t".repeat(257) } }),
    { parentToolCallId: null, subagent: false },
  );
  check(
    "and one exactly at the ceiling still is",
    (call({ claudeCode: { parentToolUseId: "t".repeat(256) } }) as { parentToolCallId: string | null })
      .parentToolCallId?.length,
    256,
  );

  // _meta is an unbounded agent-shaped blob; only two scalars may cross.
  const huge = { claudeCode: { parentToolUseId: "toolu_parent", junk: "x".repeat(200_000) } };
  check(
    "a 200 KB blob beside the id contributes nothing but the id",
    JSON.stringify(call(huge)).length,
    JSON.stringify({ parentToolCallId: "toolu_parent", subagent: false }).length,
  );

  const base: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "toolu_child",
    title: "Read",
    kind: "read",
    status: "pending",
    locations: [],
    rawInput: null,
    parentToolCallId: null,
    subagent: false,
  };
  check(
    "an accounted parent id costs exactly its own length",
    estimateBytes({ ...base, parentToolCallId: "toolu_parent" }) - estimateBytes(base),
    "toolu_parent".length,
  );

  // locations must be charged by estimateBytes: three bounds read that number rather than the payload.
  const sited: ToolCallEvent = {
    ...base,
    locations: Array.from({ length: 40 }, (_, i) => ({ path: `${"/deep/path".repeat(80)}/${i}`, line: null })),
  };
  report(
    "and a file list is charged rather than carried for free",
    estimateBytes(sited) - estimateBytes(base) > 20_000,
    `${estimateBytes(sited) - estimateBytes(base)} bytes for 40 long locations`,
  );
  const cutSited = truncateEvent(sited, 4_096) as ToolCallEvent;
  report(
    "and truncating really shortens it",
    estimateBytes(cutSited) < estimateBytes(sited),
    `${estimateBytes(sited)} -> ${estimateBytes(cutSited)} bytes`,
  );
}


// What is taken and what passes byte-for-byte; a session/update carrying an id is a request and must never be taken.
// Driven at every chunk size 1..64 to split inside a multi-byte character and a CRLF.
{
  const marker = (kind: string, id?: unknown): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method: "session/update",
      params: { sessionId: "a1", update: { sessionUpdate: kind, asyncTaskId: "t1", state: "running" } },
    });

  const corpus: readonly (readonly [string, string, boolean])[] = [
    ["a spawn is taken", marker("async_task_spawned"), true],
    ["a progress frame is taken", marker("async_task_progress"), true],
    ["a state update is taken", marker("async_task_state_update"), true],
    // Every one of these has to reach the SDK untouched.
    ["a task update sent as a *request* is forwarded, never swallowed", marker("async_task_spawned", 7), false],
    ["and `id: null` is forwarded too, being malformed rather than a notification", marker("async_task_spawned", null), false],
    ["an `async_task_`-prefixed kind outside the three is forwarded", marker("async_task_invented"), false],
    ["a marker-bearing line that will not parse is the SDK's to answer for", "{async_task_ nope", false],
    [
      "so is one whose method is not session/update",
      JSON.stringify({ jsonrpc: "2.0", method: "session/other", params: { sessionId: "a1", update: { sessionUpdate: "async_task_spawned" } } }),
      false,
    ],
    [
      "and one whose sessionId is not a string",
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: 5, update: { sessionUpdate: "async_task_spawned" } } }),
      false,
    ],
    ["agent prose containing the marker is an agent talking about this feature", "I ran async_task_spawned for you — 日本語 ✅", false],
    ["an ordinary frame with no marker at all", JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "a1", update: { sessionUpdate: "agent_message_chunk" } } }), false],
  ];

  const feed = `${corpus.map(([, line]) => line).join("\n")}\n`;
  const wantForwarded = corpus.filter(([, , taken]) => !taken).map(([, line]) => line).join("\n") + "\n";
  const wantTaken = corpus.filter(([, , taken]) => taken).length;

  const run = async (chunkSize: number): Promise<[string, number]> => {
    const stdout = new PassThrough();
    const taken: unknown[] = [];
    const onward = splitAsyncTaskUpdates(stdout, (notification) => taken.push(notification));
    const out: Buffer[] = [];
    onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
    const bytes = Buffer.from(feed, "utf8");
    for (let at = 0; at < bytes.length; at += chunkSize) stdout.write(bytes.subarray(at, at + chunkSize));
    stdout.end();
    await done;
    return [Buffer.concat(out).toString("utf8"), taken.length];
  };

  {
    for (const [what, line, shouldTake] of corpus) {
      const stdout = new PassThrough();
      const taken: unknown[] = [];
      const onward = splitAsyncTaskUpdates(stdout, (notification) => taken.push(notification));
      const out: Buffer[] = [];
      onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
      stdout.end(Buffer.from(`${line}\n`, "utf8"));
      await done;
      check(what, [taken.length === 1, Buffer.concat(out).toString("utf8")], [shouldTake, shouldTake ? "" : `${line}\n`]);
    }
  }

  // Byte-for-byte: rewriting what passes through is the same defect as swallowing it.
  {
    let forwardedEverywhere = true;
    let takenEverywhere = true;
    for (let size = 1; size <= 64; size += 1) {
      const [forwarded, takenCount] = await run(size);
      if (forwarded !== wantForwarded) forwardedEverywhere = false;
      if (takenCount !== wantTaken) takenEverywhere = false;
    }
    report(
      "every forwarded byte survives every chunk boundary, 1..64",
      forwardedEverywhere,
      `${wantForwarded.length} chars of passthrough, including a split multi-byte character`,
    );
    report("and the same three frames are taken at every size", takenEverywhere, `${wantTaken} diverted`);
  }

  // The carriage return belongs to the line and must be forwarded with it.
  {
    const stdout = new PassThrough();
    const onward = splitAsyncTaskUpdates(stdout, () => {});
    const out: Buffer[] = [];
    onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
    stdout.end("hello\r\nworld\r\n");
    await done;
    check("a CRLF stream keeps its carriage returns", Buffer.concat(out).toString("utf8"), "hello\r\nworld\r\n");
  }

  {
    const stdout = new PassThrough();
    const onward = splitAsyncTaskUpdates(stdout, () => {});
    const out: Buffer[] = [];
    onward.on("data", (chunk: Buffer) => out.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => onward.on("end", () => resolve()));
    stdout.end("no newline here");
    await done;
    check("an unterminated tail is still forwarded on end", Buffer.concat(out).toString("utf8"), "no newline here");
  }

  // A throwing handler must destroy onward with its error, or the agent goes silent behind a live process.
  {
    const stdout = new PassThrough();
    const onward = splitAsyncTaskUpdates(stdout, () => {
      throw new Error("handler blew up");
    });
    onward.on("data", () => {});
    const failed = await new Promise<string | null>((resolve) => {
      onward.on("error", (error: Error) => resolve(error.message));
      onward.on("end", () => resolve(null));
      stdout.write(`${marker("async_task_spawned")}\n`);
      stdout.end("after\n");
    });
    check("a throwing session handler destroys the connection rather than going silent", failed, "handler blew up");
  }
}
