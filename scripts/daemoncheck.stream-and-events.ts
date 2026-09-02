import type { Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { MemoryEventStore, estimateBytes, truncateEvent, type ToolCallEvent } from "../src/events.js";
import { toolCallLineage } from "../src/acp/subagents.js";
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

/* ------------------------------------------------------------------ *
 * The stream, over a real socket
 * ------------------------------------------------------------------ */

/**
 * The one route that cannot be checked with `app.fetch`.
 *
 * `upgradeWebSocket`'s handler only runs for an actual upgrade; a plain request
 * falls through and Hono answers 404 — for a real session id exactly as much as
 * for a made-up one. So any assertion built on `app.fetch` here was true no
 * matter what the handler did, and this route is the one that hands out a live
 * transcript feed. A real listener and a real `ws://` client is the only way to
 * tell the two 404s apart, and `relaycheck` already proves the technique works in
 * this repo.
 */
process.stdout.write("\nthe stream, over a real socket\n");

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
// The same cast `scripts/daemon.ts` makes: `serve` is typed as possibly
// returning an Http2Server, and `injectWebSocket` wants the http one.
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

/**
 * Every frame one attach delivers, in order, up to and including `caught_up`.
 *
 * One function with two call sites rather than the same promise written twice,
 * because the two attach cases below differ only in which log they are pointed
 * at and what they are both measuring is the frame *sequence* — a collector that
 * drifted between them would have the two cases describing different protocols
 * while both stayed green. `port` is a parameter because the second case needs a
 * registry whose store evicts, which means its own app and its own listener.
 */
function streamFrames(
  atPort: number,
  sessionId: string,
  sub: string,
  since: number,
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
      if (frame["type"] === "caught_up") done();
    });
    socket.on("error", done);
    setTimeout(done, 5_000);
  });
}

check("attaching to a real session opens and delivers", await attach("s_one", "u_alice"), "frame");
check("an id that exists nowhere is refused, over a real upgrade", await attach("s_nope", "u_alice"), "refused");

/* -- a request target the URL parser rejects ---------------------------- */

{
  /*
   * ⚠ **llhttp and the WHATWG URL parser disagree about what a request target
   * is**, and `@hono/node-ws`'s upgrade handler opens with an unguarded `new
   * URL(request.url ?? "/", "http://localhost")`. `GET //% HTTP/1.1` is accepted
   * by Node's HTTP parser and handed over verbatim; `new URL("//%", …)` throws.
   * Nothing then writes to the socket or destroys it — `requestTimeout` is
   * already cleared and `keepAliveTimeout` only arms once a response is sent —
   * so it is one leaked fd per line.
   *
   * Reachable through the relay with any token for this machine, because
   * `relay/proxy.ts`'s `readToken` reads the `Authorization` header *without*
   * touching the URL and then forwards `path: req.url` unchanged. That file
   * carries this exact guard, with a comment describing this exact failure; the
   * end it forwards to did not have one.
   *
   * Driven on a raw socket, because `fetch` and `ws` both normalize the target
   * through the very parser this is about — the same reason `relaycheck` drives
   * its copy this way.
   */
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
  /*
   * And the ordinary handshake still works, which is the half that says the
   * guard wrapped the injected listener rather than replacing it — a sweep that
   * dropped the real handler would pass every line above and serve nothing.
   */
  check("while an ordinary handshake is untouched", await attach("s_one", "u_alice"), "frame");
}

/* ------------------------------------------------------------------ *
 * `?token=` is the handshake's exception, and only the handshake's
 *
 * The parameter has always been justified by one sentence — a browser cannot set
 * a header on a WebSocket handshake — and `readCredential` is called from the
 * single `app.use("*")` gate, so it authenticated *every* route. This section
 * exists because that gap could only be seen by asking two routes the same
 * question: the socket, which must still open on a query credential, and an
 * ordinary GET, which must not.
 *
 * The one it mattered on is `files`. `GET /sessions/:id/files?path=chart.png&
 * token=<jws>` answered with the bytes, which put a live bearer in
 * `location.search`, in browser history, in the `Referer` of whatever the page
 * loaded next and in every intermediary's log — on the same origin whose
 * `localStorage` holds `reemoat.credential`.
 * ------------------------------------------------------------------ */
{
  const query = `token=${encodeURIComponent(tokenFor("u_alice"))}`;
  // `async` rather than a bare arrow: Hono's own `fetch` is typed
  // `Response | Promise<Response>`, and awaiting copes with either.
  const bare = async (path: string): Promise<Response> => app.fetch(new Request(`http://d${path}`));

  check("an ordinary GET is not authenticated by a token in the URL", (await bare(`/sessions?${query}`)).status, 401);
  // The route the leak was actually reachable on, and the one whose whole answer
  // is bytes: a 200 here is a credential parked in the address bar of a tab
  // showing somebody's file.
  check("nor is the route that serves a file's bytes", (await bare(`/sessions/s_one/files?path=notes.txt&${query}`)).status, 401);
  // The positive control, and the half that carries the weight: the narrowing
  // must not have been done by simply deleting the parameter. `attach` above
  // already passes it as the only credential a `ws://` client can send, and this
  // says the same thing where the refusals are, so the two are read together.
  check("while the header is still all any route ever needed", (await get("/sessions", "u_alice")).status, 200);
  /*
   * And the rule is the `Upgrade` header rather than the stream route's path,
   * which is deliberate and therefore pinned. A route reader would have to be
   * kept in step with the routes and would fail *open* the day it fell behind.
   * Somebody who sets the header by hand gains nothing — they are holding the
   * token either way — because what this closes is the URL a browser follows,
   * and a browser following one never sends it.
   */
  const handshaking = await app.fetch(
    new Request(`http://d/sessions?${query}`, { headers: { upgrade: "websocket" } }),
  );
  check("a request that says it is a handshake may still carry it in the query", handshaking.status, 200);
}

{
  /*
   * **The attach is bounded where the history used to be.**
   *
   * A session's log is no longer truncated, so "attach at 0" can mean an
   * arbitrary number of events — and `attach` drains its whole backlog into the
   * outbound queue in one synchronous block, which past `MAX_QUEUE_EVENTS`
   * collapses and reports `lagged{slow_consumer}` about a client that was never
   * given the chance to be slow. That lie is what the old 5000-event retention
   * window was really buying, and paying for it with somebody's conversation was
   * the wrong trade.
   *
   * So the socket replays the newest `ATTACH_REPLAY_MAX` and says what it skipped,
   * with the one `lagged` reason that is **not** a loss: `backlog` means the
   * events are on disk and `GET /sessions/:id/events` serves them. Three separate
   * things have to hold, and only the first is obvious.
   */
  const many = registry.get("s_three");
  for (let n = 1; n <= 3_000; n += 1) {
    many?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}` });
  }
  const lastSeq = many?.log.stats().lastSeq ?? 0;

  const frames = await streamFrames(port, "s_three", "u_alice", 0);

  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  check("a since=0 attach past the cap is told, with `backlog`", lagged.map((f) => f["reason"]), ["backlog"]);
  // Bounded, and by a real margin rather than "some events were skipped" — the
  // number that matters is that it stays under `MAX_QUEUE_EVENTS`, since going
  // over is what turns this into a `slow_consumer` close.
  check("and replays no more than the cap", delivered <= 2_000, true);
  check("but genuinely replays that much rather than nothing", delivered > 1_900, true);
  /*
   * The two that a "fewer events arrived" assertion would pass without.
   *
   * The skipped range has to be *named* — a client that is not told which seqs it
   * did not get cannot page them, and a silent skip is the contiguous-looking
   * transcript with a hole in the middle that this whole area exists to prevent.
   * And the cursor has to end at the head: `caught_up` is what says the socket is
   * live, and reporting it below `lastSeq` would leave the client believing it is
   * following a session it is 3000 events behind on.
   */
  check("the skipped range starts at the first event", lagged[0]?.["from"], 1);
  check("and ends where the replay begins", lagged[0]?.["to"], lastSeq - 2_000);
  check("the socket still goes live at the head of the log", caughtUp?.["seq"], lastSeq);
}

await new Promise<void>((resolve) => server.close(() => resolve()));

/* ------------------------------------------------------------------ *
 * An attach that is both evicted and behind
 * ------------------------------------------------------------------ */

/*
 * The hole in the case above, and the one place the arithmetic actually bites.
 *
 * `s_three`'s log has `dropped: 0`, so its attach emits exactly one `lagged`
 * frame and `Math.max(asked, oldest - 1)` is never exercised — replacing it with
 * the pre-diff `asked + 1` leaves every assertion up there green. Both frames
 * only appear together on a session that is *both* missing a prefix an older
 * daemon destroyed *and* further behind than `ATTACH_REPLAY_MAX`, which is
 * exactly the session that has been open longest.
 *
 * The two mean opposite things and the client draws them differently: `evicted`
 * is a loss, and the transcript ends there with a marker saying so; `backlog` is
 * not a loss at all — those events are on disk and `GET /sessions/:id/events`
 * serves them, so the client pages them in. Overlapping the ranges therefore
 * costs twice: the same seqs are reported destroyed *and* offered for paging,
 * and the two `dropped` counts a client adds up come to more than the log ever
 * held. Adjacency is the whole property, and it is one `Math.max` wide.
 */
process.stdout.write("\nan attach that is both evicted and behind\n");
{
  /*
   * The one registry in this driver whose store evicts. `dropped > 0` is the
   * entire precondition, and it cannot be reached on the main registry: a
   * session's log is unbounded by default, deliberately, which is why an
   * explicit window has to be built here rather than found.
   */
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

  // Past the store's window *and* past the replay cap, which is what produces
  // both frames from one attach: a thousand evicted, three thousand skipped,
  // two thousand replayed.
  const managed = lagRegistry.get("s_lag");
  for (let n = 1; n <= 6_000; n += 1) {
    managed?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}` });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  // The positive control. Without it every assertion below is about a session
  // that lost nothing, which is the case already covered — and a future default
  // that stopped this store evicting would make this whole section green and
  // meaningless rather than red.
  check("the store really did evict, or none of this is being driven", stats.dropped > 0, true);

  const frames = await streamFrames(lagPort, "s_lag", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // Order rather than membership: the loss is what ends the readable transcript,
  // so it has to be the frame a client sees first — it arrives before the range
  // that merely has to be fetched.
  check("both are reported, the loss before the backlog", lagged.map((f) => f["reason"]), ["evicted", "backlog"]);
  /*
   * **The load-bearing one.** With `asked + 1` the backlog range starts back at
   * 1 and swallows the evicted range whole, so a client is told to page seqs
   * that no longer exist — and every other assertion in this section except the
   * one below it still passes.
   */
  check(
    "and the second range begins exactly where the first ended",
    (lagged[0]?.["to"] ?? -1) + 1,
    lagged[1]?.["from"],
  );
  /*
   * Nothing is counted twice, stated against the socket's own behaviour rather
   * than against a copy of `attach`'s arithmetic: the client asked from 0, so
   * every seq up to `lastSeq` either arrived or was named in one of the two
   * frames, and in exactly one of them.
   */
  check(
    "so the two counts add up to exactly what was not delivered",
    lagged.reduce((n, f) => n + Number(f["dropped"] ?? 0), 0),
    stats.lastSeq - delivered,
  );
  // And the replay itself is unchanged by any of it. Exactly the cap, not
  // "about" it: the cursor is `lastSeq - ATTACH_REPLAY_MAX` and nothing in
  // between is dropped, so a delivery short of 2000 is a hole rather than a bound.
  check("the replay is still exactly the cap", delivered, 2_000);
  check("and the socket still goes live at the head of the log", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => lagServer.close(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * An attach that is small enough to replay and too large to send
 * ------------------------------------------------------------------ */

/*
 * **`ATTACH_REPLAY_MAX` bounds the count and `MAX_QUEUE_BYTES` bounds the bytes,
 * and only one of them was told the truth about which is which.**
 *
 * The constant is justified as sitting under `MAX_QUEUE_EVENTS` so that a big
 * attach can never be mistaken for a client that fell behind — but `enqueue`
 * collapses on *either* ceiling, and two thousand events of transcript is
 * comfortably past 16 MiB. The whole drain is one synchronous block and the first
 * `send` callback has not run, so at the moment of the collapse nothing has
 * drained and the client has not been given a single frame to be slow about. It
 * was told `slow_consumer` anyway, which the browser records as a permanent
 * "events lost" marker over a conversation the daemon still holds intact.
 *
 * The fixture is therefore deliberately *under* the count cap and over the byte
 * one: four hundred events at 48 KiB is a fifth of `ATTACH_REPLAY_MAX` and about
 * 19 MiB, so the frame this produces can only have come from the byte ceiling.
 *
 * What is **not** driven here is the other half of the same fix — that a backlog
 * collapse is not recorded in the window that closes the socket `4003`. One
 * attach can collapse only once (the cursor jumps to the head, so the drain loop
 * reads an empty slice and stops), and a second collapse on the same connection
 * needs a live client that genuinely stops reading, which is real TCP
 * backpressure and the one thing this driver cannot manufacture.
 */
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
    managed?.log.append({ type: "text", role: "agent", thought: false, text: fat });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  // The precondition, said as a measurement rather than as a restatement of the
  // constants: the replay is well inside the count cap and well past the byte
  // one, so a collapse here cannot be the count cap firing.
  check("the fixture is far under the replay cap", stats.lastSeq < 2_000, true);
  check("and far over the outbound byte ceiling", stats.approxBytes > 16 * 1024 * 1024, true);

  const frames = await streamFrames(fatPort, "s_fatreplay", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // Asked from 0 with nothing evicted and nothing skipped, so `attach` itself
  // emits no `lagged` at all — which is what makes the single frame below
  // unambiguously the collapse's own.
  check("exactly one lagged frame, and it is the collapse's", lagged.length, 1);
  /*
   * **The one that catches the revert.** With the reason hardcoded, this reads
   * `slow_consumer` — a client that has not yet received a frame being blamed for
   * not reading it, and a hole drawn over events that are all still on disk.
   */
  check("a replay too large in bytes is a backlog, not a slow consumer", lagged[0]?.["reason"], "backlog");
  // And it names the range, ending at the head, because `backlog` is an
  // instruction to page `GET /sessions/:id/events` rather than a report of loss.
  check("naming a range that ends at the head of the log", lagged[0]?.["to"], stats.lastSeq);
  check("and the socket still goes live there rather than being closed", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => fatServer.close(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * GET /sessions/:id/events — the page a lagged client is pointed at
 * ------------------------------------------------------------------ */

/*
 * The route the `backlog` frame above names, driven as more than a 404.
 *
 * It was in the unknown-id table and nowhere else, which was defensible while a
 * client only ever read history over the socket. It is not any more: the attach
 * is bounded and everything past the bound is *this* route's problem, so the
 * browser's whole paging loop rests on three properties of a page that nothing
 * asserted — where it starts, that it may be shorter than asked for, and which
 * end it is short at.
 *
 * The third is the one that shipped a defect. A page is filled by scanning
 * ascending from `since` and breaking on the byte budget, in **both** stores, so
 * a byte-capped page keeps its oldest events and drops its newest — a client
 * that anchors its window on the page's first event and assumes it received the
 * whole range it asked for splices the page's *last* event onto a window that
 * begins hundreds of seqs later, and loses everything in between with nothing
 * anywhere to say so. That direction is decided here, so it is pinned here.
 */
process.stdout.write("\nthe events page\n");
{
  /** The route's response shape, so the assertions below are not written against `any`. */
  interface EventPage {
    events: { seq: number; ts: number; event: unknown }[];
    firstSeq: number;
    lastSeq: number;
    dropped: number;
    gap: boolean;
  }

  const pagePath = join(sandbox, "paging", "reemoat.db");
  /*
   * Two opens, because `seedFloors` runs at open from `sessions.list()` — the
   * floors on a session whose events are *entirely* gone can only be picked up
   * by a daemon that finds the row already there, which is the same two-phase
   * shape the store's own floors case uses.
   */
  {
    const seed = openStores({ path: pagePath, instanceId: "i_page_seed" });
    seed.sessions.put(rowFor("s_page", join(users, "u_alice", "paging")));
    seed.sessions.put(rowFor("s_fat", join(users, "u_alice", "paging-fat")));
    // The case the route's own comment calls the one a paging client must not be
    // told history begins at 1: the table knows nothing about this session and
    // the row says the log reached 500.
    seed.sessions.put({
      ...rowFor("s_gone", join(users, "u_alice", "paging-gone")),
      lastSeq: 500,
      dropped: 500,
    });
    seed.close();
  }

  /*
   * **Both bounds have to be exercisable in one store, and that is what sets these
   * two numbers.** Eviction needs a log longer than `maxEventsPerSession`; the
   * route's count clamp needs more than `EVENTS_PAGE_LIMIT` events *above the
   * cursor the clamp is asked from*. When the page was 500 this was a cap of 5000
   * and 6000 events, and raising the page to 5000 left the second property
   * unprovable — the whole live log was smaller than one page, so the route
   * returning all of it proved nothing about honouring `limit`. Scaled off the
   * constant rather than re-typed, so the next move does not need this comment.
   */
  const pageCap = EVENTS_PAGE_LIMIT * 4;
  const store = openStores({ path: pagePath, instanceId: "i_page", maxEventsPerSession: pageCap });
  // Small enough that a page of them is nowhere near the byte budget, so the count
  // clamp is what bounds a page here and the byte cap is measured separately, on
  // `s_fat`.
  for (let n = 1; n <= pageCap + 1_000; n += 1) {
    store.events.append("s_page", { type: "text", role: "agent", thought: false, text: `p${n}` });
  }
  /*
   * And large enough that five hundred cannot fit: a `text` event is accounted
   * at `64 + text.length`, so 8 KiB apiece puts 500 of them at ~4 MiB against
   * the route's 2 MiB budget. Six hundred exist so the page is short of both the
   * count clamp and the end of the log — a page that stopped because it ran out
   * of events would prove nothing about the budget.
   */
  const fat = "f".repeat(8 * 1024);
  for (let n = 1; n <= 600; n += 1) {
    store.events.append("s_fat", { type: "text", role: "agent", thought: false, text: fat });
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

  /*
   * `since` is a cursor and cursors here are exclusive — the same rule
   * `StreamConnection.attach` gets from `WHERE seq > ?`. A client pages by
   * handing back the seq it already holds, so an inclusive read would repeat one
   * event at every page boundary, forever, in a transcript nobody can tell it
   * from a repeated agent message.
   */
  const window = await pageOf("s_page", "?since=2000&limit=5");
  check("`since` is exclusive, so a client's own cursor is never repeated", window.events.map((stored) => stored.seq), [
    2001, 2002, 2003, 2004, 2005,
  ]);

  const clamped = await pageOf("s_page", "?since=2000&limit=1000000");
  // Asking for more than a page holds is answered with a page, not with the
  // whole log. This is the bound the socket's `backlog` reason hands the client
  // over to, so a route that honoured `limit` would move the unbounded read one
  // layer down rather than removing it. Against the constant, because a literal
  // here is a literal that goes stale the next time the page moves — which is
  // exactly what happened.
  check("a page is clamped to what one request may carry", clamped.events.length, EVENTS_PAGE_LIMIT);
  check(
    "and runs from the cursor to the clamp, ascending with no hole",
    clamped.events.every((stored, i) => stored.seq === 2001 + i),
    true,
  );

  /*
   * The byte cap, and then the direction of it.
   *
   * Short is the easy half — `limit` was 500 by default and fewer came back.
   * Which end it is short at is the half a "fewer events arrived" assertion
   * passes without, and it is the whole reason a client may not treat a page as
   * the range it asked for: the page begins at `since + 1` and stops early, so
   * what is missing is at the *new* end and the next request carries on from the
   * last seq received rather than from `since + limit`.
   */
  const capped = await pageOf("s_fat", "?since=0");
  check("a page of large events is cut short by bytes rather than by count", capped.events.length < 500, true);
  /*
   * **This one proves nothing on its own, and that is recorded rather than
   * hidden.** Both stores guard the byte break with `out.length > 0 &&` so a
   * single oversized record cannot wedge a reader that can never get past it.
   * Deleting that guard from either store — or from both at once — leaves this
   * whole suite green, because the branch is unreachable with this fixture and,
   * more to the point, unreachable in production: `truncateEvent` caps one event
   * at 128 KiB, sixteen times below `EVENTS_PAGE_BYTES`, so no event can be
   * larger than the page budget while both defaults stand.
   *
   * Kept because it is the assertion that would start meaning something the day
   * somebody raises the per-event cap or lowers the page budget, and because
   * `capped.events.length >= 1` is a precondition of the sibling below actually
   * reading `events[0]`. Not kept as evidence that the wedge guard works.
   */
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

  /*
   * `firstSeq` is `oldestAvailable(stats)` and not the raw column, in both of
   * the states where the two differ.
   *
   * A client reads this to decide whether there is anything left to page — the
   * browser draws "the start of this conversation is gone" from it — so a route
   * that reported the raw value would send it asking for history that cannot be
   * served, once per page, forever.
   */
  const evicted = await pageOf("s_page", "?since=0&limit=1");
  check("a log whose prefix is gone does not claim to begin at 1", evicted.firstSeq, evicted.dropped + 1);
  check("and a cursor below that floor is named as a gap", evicted.gap, true);
  // The boundary either side of it, because `since < oldestAvailable - 1` is the
  // one predicate that decides whether a client believes it lost anything.
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

  /*
   * And the case the raw column answers with **zero**: the log is empty and the
   * sequence is not. `firstSeq` is 0 there, so `firstSeq - 1` is -1 and every
   * gap predicate written against it silently answers "no gap" — on the one path
   * where absolutely everything was lost.
   */
  const gone = await pageOf("s_gone", "?since=0");
  check("a session whose events are all gone serves none", gone.events, []);
  check("while its sequence is intact", gone.lastSeq, 500);
  check("and history begins one past the end rather than at 1 or at 0", gone.firstSeq, gone.lastSeq + 1);
  check("with a cursor of 0 named as the gap it is", gone.gap, true);

  process.stdout.write("\nwhat crosses the wire, and what must not be touched\n");
  {
    /*
     * ⭐ **Nothing in this system compressed anything, and the scarce resource on
     * this path is the uplink of the machine an agent runs on.**
     *
     * Measured against the fleet's largest conversation: a page of 5000 events is
     * **1.23 MB** raw and **98 KB** gzipped, and every byte of it crosses that
     * uplink once to the relay and again to the browser. The relay cannot help —
     * it carries h2 frames, which are already framed — so the daemon is where it
     * has to happen.
     *
     * The second assertion is the load-bearing one and the reason `compressible`
     * keys on the **content type** rather than the path: `GET /sessions/:id/files`
     * streams arbitrary bytes and the client refuses an oversized file by reading
     * `content-length` *before* the body is resident. Compressed, that number
     * describes the packed size, so a 100 MiB guard measures the wrong thing.
     */
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

    /*
     * ⭐ **A compressible response *under* the threshold must still be readable,
     * and this is the assertion whose absence let a 500 reach production.**
     *
     * Deciding the size means reading the body, and reading it consumes it — so an
     * early `return` past that point leaves `c.res` holding a body already read, and
     * `@hono/node-server` answers `ERR_INVALID_STATE: ReadableStream is locked`. It
     * is a 500 with no body on **every** small JSON answer, `GET /sessions`
     * included. The compressed path was asserted and this one was not, which is
     * exactly the half that broke.
     */
    const small = await raw("/sessions/s_page/events?since=0&limit=2", { "accept-encoding": "gzip" });
    check("a small answer is not compressed", small.headers.get("content-encoding"), null);
    // Read through a catch, so a body left consumed is a *sentence* rather than a
    // throw that ends the driver before everything after it has run.
    const smallText = await small.text().then(
      (text) => text,
      (error: unknown) => `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    check("and it still has its body", smallText.slice(0, 11), '{"events":[');
    // Guarded, so an unreadable body is one FAIL rather than a throw that ends the
    // driver with everything after it unrun.
    const smallEvents = smallText.startsWith('{"events":[') ? (JSON.parse(smallText) as EventPage).events.length : -1;
    check("carrying what was asked for", smallEvents, 2);
    check("with the status it had", small.status, 200);
    const unpacked = JSON.parse(gunzipSync(packedBody).toString("utf8")) as EventPage;
    check(
      "and the two carry the same events, which is the only thing that matters",
      [unpacked.events.length, unpacked.events.at(-1)?.seq, unpacked.firstSeq],
      [plainPage.events.length, plainPage.events.at(-1)?.seq, plainPage.firstSeq],
    );
    // The uncompressed size is measured off the body rather than off a header:
    // `c.json` does not set `content-length`, which is itself why the middleware
    // has to *write* one when it packs a body.
    const plainBytes = Buffer.byteLength(JSON.stringify(plainPage));
    report(
      "measured on this fixture",
      packedBody.byteLength * 4 < plainBytes,
      `${(packedBody.byteLength / 1024).toFixed(0)} KiB gzipped from ${(plainBytes / 1024).toFixed(0)} KiB`,
    );

    store.close();
  }
}

/* ------------------------------------------------------------------ *
 * Subagent lineage — the one projection out of an agent-shaped blob
 * ------------------------------------------------------------------ */

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

  // Kimi sends no `_meta` on anything, ever, and filters its subagents' events
  // at the source. It gets `false` by absence rather than by us pattern-matching
  // its `Agent` tool, which would be a container that can never have contents.
  check("kimi sends no metadata, and that is the answer", call(undefined), {
    parentToolCallId: null,
    subagent: false,
  });
  check("a `_meta` without claude's key says nothing", call({ somethingElse: {} }), {
    parentToolCallId: null,
    subagent: false,
  });

  // Never coerced. `String(42)` as a tree edge names a call that will never
  // exist, and a reader cannot tell that from a parent that was merely evicted.
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

  // The `alg === "EdDSA"` discipline: an exact comparison makes a family of
  // near-misses impossible rather than defended one at a time.
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

  // Bounded at ingest, because there is nowhere later to bound it: `truncateEvent`
  // deliberately spreads `parentToolCallId` through untouched on both arms, so an
  // unshrinkable field with no ceiling walks an event straight past the per-event
  // cap that the bounds table calls enforced. A real ACP id is under 40
  // characters; anything over 256 was never an edge.
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

  // The assertion that fails if somebody later "simplifies" this into a
  // passthrough. `_meta` is an unbounded agent-shaped blob; two scalars is the
  // whole of what may cross.
  const huge = { claudeCode: { parentToolUseId: "toolu_parent", junk: "x".repeat(200_000) } };
  check(
    "a 200 KB blob beside the id contributes nothing but the id",
    JSON.stringify(call(huge)).length,
    JSON.stringify({ parentToolCallId: "toolu_parent", subagent: false }).length,
  );

  // So the per-event cap stays honest rather than becoming decorative.
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

  /*
   * ⚠ **`locations` was charged nothing and cut by nothing**, on both tool-call
   * arms, while being an array of agent-chosen paths bounded by neither length
   * nor element size. That defeats three bounds at once and all three read this
   * number rather than the payload: the 128 KiB per-event cap, the per-session
   * byte budget (`schema.sql` stores what `estimateBytes` returns), and the WS
   * outbound queue's `MAX_QUEUE_BYTES`.
   *
   * Asserted as a *proportionality*, not as a constant: what made the defect
   * possible was a term being absent, so what has to be true is that the number
   * moves with the payload at all.
   */
  const sited: ToolCallEvent = {
    ...base,
    locations: Array.from({ length: 40 }, (_, i) => ({ path: `${"/deep/path".repeat(80)}/${i}`, line: null })),
  };
  report(
    "and a file list is charged rather than carried for free",
    estimateBytes(sited) - estimateBytes(base) > 20_000,
    `${estimateBytes(sited) - estimateBytes(base)} bytes for 40 long locations`,
  );
  // And shrinks, which the spread used to carry through untouched — so an event
  // over the cap stayed over it however often this ran.
  const cutSited = truncateEvent(sited, 4_096) as ToolCallEvent;
  report(
    "and truncating really shortens it",
    estimateBytes(cutSited) < estimateBytes(sited),
    `${estimateBytes(sited)} -> ${estimateBytes(cutSited)} bytes`,
  );
}
