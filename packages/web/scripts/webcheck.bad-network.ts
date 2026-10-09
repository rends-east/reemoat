import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";
import { snapshot as baseSnapshot } from "./webcheck.ws.js";

// The real store, `MachineConnection`, `DaemonClient` and `SessionStream` over a daemon and a link that live on a virtual
// clock: every answer is delayed on its own, so answers overtake each other, get lost, and sockets die mid-conversation.
// Only the Noise channel and React are stood in for; the channel keeps `MachineChannel`'s rule that `dispose` ends what is in use.

interface Stored {
  seq: number;
  ts: number;
  event: Record<string, unknown>;
}

interface Timer {
  at: number;
  order: number;
  run: () => void;
}

const BASE = 1_800_000_000_000;
/** Each schedule starts this far after the last, on one clock: a stamp the store kept from an earlier one is then in the past. */
const SCHEDULE_SPAN_MS = 1_000_000;

class VirtualClock {
  now: number;
  private order = 0;

  constructor(start: number) {
    this.now = start;
  }

  get pending(): number {
    return this.timers.size;
  }

  private readonly timers = new Map<number, Timer>();

  set(run: () => void, ms: number): number {
    this.order += 1;
    this.timers.set(this.order, { at: this.now + Math.max(0, ms), order: this.order, run });
    return this.order;
  }

  clear(id: number): void {
    this.timers.delete(id);
  }

  /** Runs the earliest timer; false when none is due by `until`. */
  step(until: number): boolean {
    let next: [number, Timer] | null = null;
    for (const entry of this.timers) {
      if (next === null || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].order < next[1].order)) next = entry;
    }
    if (next === null || next[1].at > until) return false;
    this.timers.delete(next[0]);
    this.now = Math.max(this.now, next[1].at);
    next[1].run();
    return true;
  }
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LinkProfile {
  /** Typical one-way latency. */
  baseMs: number;
  /** How often one leg takes far longer than the rest, and how long at most. */
  stallChance: number;
  stallMs: number;
  /** A request or an answer that never arrives. */
  lossChance: number;
  /** Mean life of a socket, or 0 for one that never dies. */
  socketLifeMs: number;
  /** Mean time between the device reporting itself offline and back, or 0 for never. */
  flapEveryMs: number;
  /** A total outage that ends as the link heals: for this long nothing passes in either direction. */
  deadMs?: number;
  /** What the device says of that outage; a shell whose platform reports no change says nothing. */
  says?: Says;
}

/** `early` is a device back on its network some seconds before the path to the server is: a VPN or an overlay still joining. */
export type Says = "nothing" | "both" | "early";

/** How long after the link was back each sign of the outage was last drawn, in ms; 0 for one gone by then. */
export interface Recovery {
  server: number;
  machine: number;
  /** The open conversation's working line, drawn stale. */
  stale: number;
  pill: number;
}

const ONLINE_EARLY_MS = 6_000;
/** An event follows its cause. */
const ONLINE_LATE_MS = 100;

export function outage(deadMs: number, says: Says): LinkProfile {
  return { baseMs: 40, stallChance: 0, stallMs: 0, lossChance: 0, socketLifeMs: 0, flapEveryMs: 0, deadMs, says };
}

/** `stays` never leaves the conversation it opened; `reenters` goes back and opens it again once it has drawn nothing for a while. */
export type Reader = "stays" | "reenters";

/** What the link did to the client, counted so a clean result is known to have been earned. */
export interface Hazards {
  /** Listings taken before the session existed that landed after its row did. */
  staleListings: number;
  /** Listings that landed after one asked later than them. */
  overtaken: number;
  /** Sends whose request failed in transit. */
  failedSends: number;
  /** Of those, the ones the daemon had taken. */
  failedButTaken: number;
}

/**
 * What a reader was shown of the link's trouble, each beside what the facts alone would have shown them (Q3.714): first what
 * a rule keyed on the fact itself draws, then what is drawn.
 */
export interface Flicker {
  /** The machine found down by a probe or a failed request, and the machine drawn down. */
  machineDown: [fact: number, drawn: number];
  /** The open conversation's stream no longer live, and its working line drawn stale. */
  stale: [fact: number, drawn: number];
  /** The pill as a one-second grace over the facts would raise it, and as it is raised; after the first connection, whose wait is a launch's own. */
  pill: [fact: number, drawn: number];
  /** Anything drawn of a spell shorter than the quiet window, on a device that did not say it was offline. */
  early: number;
}

const NO_FLICKER = (): Flicker => ({ machineDown: [0, 0], stale: [0, 0], pill: [0, 0], early: 0 });

export interface Outcome {
  seed: number;
  hazards: Hazards;
  flicker: Flicker;
  /** The first moment each thing a reader must never see was seen, in virtual ms from the start. */
  seen: Map<string, number>;
  settled: string[];
  /** Share of the run the machine was drawn unreachable while its daemon was answering. */
  offlineShare: number;
  recovery: Recovery;
  /** The pill was up as the link came back: without that a quick recovery proves nothing. */
  drawnAtHeal: boolean;
}

const MACHINE_NAMED = "a machine was named as its own trouble in an outage that took the server too";

/** A wake ends what was dialled before the absence, a send included; what follows it is held to every other rule. */
export const WAKE_ENDS_SEND = "a send in flight was ended with its channel";

const CP_TIMEOUT_MS = 10_000;
const POLL_MS = 4_000;
/** `e2ee.ts`'s own, which exports none of its bounds; the section on who may end a request reads it off the source. */
const STREAM_PROBATION_MS = 4_000;
const REDIALLED = "closed to be dialled again";
const MESSAGE = "take the repository and build it";
const MACHINE_KEY = "A".repeat(43);

const TRACE = process.env["BAD_NETWORK_TRACE"] !== undefined;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDateNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);
const realRandom = Math.random;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();

/** `SessionView` opens its session once per reference and never again for a row that comes back; the model below does the same, and this is what holds it to that. */
export function viewOpensOncePerRef(): boolean {
  const source = readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8");
  return /useEffect\(\(\) => \{\s*store\.openSession\(sessionRef\);\s*\}, \[sessionRef\.machineId, sessionRef\.sessionId\]\);/.test(source);
}

export async function runSchedule(seed: number, link: LinkProfile, run: number, reader: Reader = "stays"): Promise<Outcome> {
  const { store } = await import("../src/store.js");
  const { keyOf, machineId, sessionId } = await import("../src/ids.js");
  const echoes = await import("../src/echo.js");
  const cp = await import("../src/cp.js");
  const { MachineConnection } = await import("../src/machine.js");
  const { DaemonClient } = await import("../src/daemon.js");
  const { isTransportFailure } = await import("../src/http.js");
  const { connectionSpell, connectionTrouble, TROUBLE_GRACE_MS, troubleDue, troubleLive, troubleShown, troubleSince } = await import("../src/ui/connection.js");
  const { outlasted, RECONNECT_QUIET_MS, retriedDown } = await import("../src/reach.js");
  const { CLOSE_REDIAL } = await import("../src/e2ee.js");

  const random = mulberry(seed);
  const clock = new VirtualClock(BASE + (run + 1) * SCHEDULE_SPAN_MS);
  const started = clock.now;
  const healAt = started + 150_000;
  const pick = (low: number, high: number): number => low + random() * (high - low);

  (globalThis as Record<string, unknown>)["setTimeout"] = (fn: () => void, ms?: number) => clock.set(fn, ms ?? 0);
  (globalThis as Record<string, unknown>)["clearTimeout"] = (id: number) => clock.clear(id);
  Date.now = () => clock.now;
  performance.now = () => clock.now - BASE;
  Math.random = random;
  const realFetch = globalThis.fetch;

  // Healed at the end, so what is left is what the client could not recover from by itself.
  let healed = false;
  const leg = (): number => {
    if (healed) return 20;
    return random() < link.stallChance ? pick(link.baseMs, link.stallMs) : pick(link.baseMs * 0.3, link.baseMs * 1.7);
  };
  const deadFrom = link.deadMs === undefined ? Number.POSITIVE_INFINITY : healAt - link.deadMs;
  const dead = (): boolean => !healed && clock.now >= deadFrom;
  const lost = (): boolean => dead() || (!healed && random() < link.lossChance);

  const machine = machineId(`m_bad_${run}`);
  const session = sessionId(`s_bad_${run}`);
  const ref = { machineId: machine, sessionId: session };
  const key = keyOf(ref);
  const record = { id: machine, name: "alpha", relayUrl: "https://relay.invalid", relayOnline: true, enrolled: true, owned: true, scopes: [] };

  // The daemon: one log, one snapshot, and the sockets watching it.
  const log: Stored[] = [];
  let exists = false;
  let status = "starting";
  let turn: number | null = null;
  const watchers = new Set<(frame: unknown) => void>();
  const others = ["s_old_1", "s_old_2"];

  const snap = (id: string = session): Record<string, unknown> => ({
    ...baseSnapshot,
    id,
    agent: "claude",
    status: id === session ? status : "idle",
    turn: id === session ? turn : null,
    lastSeq: id === session ? log.length : 3,
    createdAt: id === session ? started : started - 86_400_000,
    lastEventAt: id === session ? (log.at(-1)?.ts ?? null) : null,
  });
  const append = (event: Record<string, unknown>): Stored => {
    const stored = { seq: log.length + 1, ts: clock.now, event };
    log.push(stored);
    for (const watcher of [...watchers]) watcher({ type: "events", events: [stored] });
    return stored;
  };
  const changed = (): void => {
    for (const watcher of [...watchers]) watcher({ type: "snapshot", session: snap() });
  };

  type Answer = { status: number; body: unknown };
  const ok = (body: unknown): Answer => ({ status: 200, body });
  const handle = (method: string, path: string): Answer | Promise<Answer> => {
    const url = new URL(path, "http://daemon.invalid");
    const route = `${method} ${url.pathname}`;
    if (route === "GET /health") return ok({ ok: true, instanceId: "i_bad", startedAt: started, uptimeMs: 1, shuttingDown: false, time: clock.now, authMode: "signed" });
    if (route === "GET /sessions") {
      return ok({
        sessions: [...(exists ? [snap()] : []), ...others.map((id) => snap(id))],
        total: others.length + (exists ? 1 : 0),
        truncated: false,
        now: clock.now,
        instanceId: "i_bad",
      });
    }
    if (route === "GET /fs/roots") return ok({ roots: [] });
    if (route === "GET /plugins") return ok({ plugins: [] });
    if (route === `GET /sessions/${session}/events`) {
      const since = Number(url.searchParams.get("since") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "200");
      return ok({ events: log.filter((stored) => stored.seq > since).slice(0, limit), firstSeq: 1 });
    }
    if (route === "POST /sessions") {
      return new Promise<Answer>((resolve) => {
        exists = true;
        append({ type: "workspace" });
        append({ type: "status", status: "starting", exit: null });
        // The agent takes a moment to start, and the session is listed while it does.
        clock.set(() => {
          status = "idle";
          append({ type: "status", status: "idle", exit: null });
          append({ type: "session_started", agent: "claude" });
          changed();
          resolve(ok({ session: snap() }));
        }, 1_900);
      });
    }
    if (route === `POST /sessions/${session}/prompt`) {
      const stored = append({ type: "prompt", text: MESSAGE, attachments: [], from: null });
      turn = 1;
      status = "running";
      changed();
      // Half the turns are over in seconds; the other half work until after the link heals, which is when a reader watches the line.
      const long = random() < 0.5;
      const steps = long ? Math.ceil((healAt + 15_000 - clock.now) / 900) : 6 + Math.floor(random() * 10);
      let at = 0;
      for (let i = 1; i <= steps; i += 1) {
        at += pick(300, 1_500);
        clock.set(() => {
          if (i < steps) {
            append({ type: "text", role: "assistant", thought: false, text: `#${i} ` });
            return;
          }
          append({ type: "turn_end", turn: 1, stopReason: "end_turn" });
          turn = null;
          status = "idle";
          changed();
        }, at);
      }
      return ok({ accepted: true, turn: 1, seq: stored.seq, session: snap() });
    }
    return { status: 404, body: { error: { code: "not_found", message: `no route for ${route}` } } };
  };

  const hazards: Hazards = { staleListings: 0, overtaken: 0, failedSends: 0, failedButTaken: 0 };
  let listingsAsked = 0;
  let newestListingLanded = 0;

  // The channel: one connection per request or socket, as the real one dials, and `dispose` ends every one of them.
  let sendKilledBy: string | null = null;
  const channels = (options: { credential: () => Promise<unknown> }): unknown => {
    const inUse = new Map<(why: string) => void, { dialledAt: number; streaming: boolean; heard?: () => number }>();
    return {
      async request(wanted: { method: string; path: string; timeoutMs: number }): Promise<unknown> {
        await options.credential();
        return await new Promise((resolve, reject) => {
          let done = false;
          const isSend = wanted.method === "POST" && wanted.path.endsWith("/prompt");
          const kill = (why: string): void => {
            if (done) return;
            done = true;
            clock.clear(deadline);
            inUse.delete(kill);
            if (isSend) sendKilledBy = why;
            reject(new Error(why));
          };
          inUse.set(kill, { dialledAt: performance.now(), streaming: false });
          const deadline = clock.set(() => kill("the request timed out"), wanted.timeoutMs);
          const listing = wanted.method === "GET" && wanted.path.startsWith("/sessions?") ? (listingsAsked += 1) : 0;
          // A create always reaches the daemon: a session that was never made is not this driver's subject.
          if (!(wanted.method === "POST" && wanted.path === "/sessions") && lost()) return;
          clock.set(() => {
            // Handled whether or not the client has given up: what was written to the socket still arrives.
            void Promise.resolve(handle(wanted.method, wanted.path)).then((answer) => {
              if (lost()) return;
              const body = encoder.encode(JSON.stringify(answer.body));
              clock.set(() => {
                if (done) return;
                done = true;
                clock.clear(deadline);
                inUse.delete(kill);
                if (listing > 0) {
                  if (listing < newestListingLanded) hazards.overtaken += 1;
                  newestListingLanded = Math.max(newestListingLanded, listing);
                  const lists = (answer.body as { sessions: { id: string }[] }).sessions.some((one) => one.id === session);
                  if (!lists && store.getSnapshot().rowsByKey.has(key)) hazards.staleListings += 1;
                }
                resolve({ status: answer.status, statusText: "", headers: {}, body });
              }, leg());
            });
          }, leg());
        });
      },
      openSocket(path: string): unknown {
        const since = Number(new URL(path, "http://daemon.invalid").searchParams.get("since") ?? "0");
        const socket = {
          onmessage: null as ((event: { data: string }) => void) | null,
          onclose: null as ((event: { code: number; reason: string }) => void) | null,
          onerror: null as (() => void) | null,
          over: false,
          heardAt: performance.now(),
          close(): void {
            socket.over = true;
            watchers.delete(send);
            inUse.delete(die);
          },
        };
        // A socket is ordered: a frame never arrives before the one sent ahead of it.
        let arrival = 0;
        // In an outage nothing arrives, and a socket that lost a frame ends as the link comes back: the cursor asks for it again.
        const starve = (): void => void clock.set(() => die(), Math.max(0, healAt - clock.now));
        const send = (frame: unknown): void => {
          if (dead()) {
            starve();
            return;
          }
          const at = Math.max(arrival, clock.now + leg());
          arrival = at;
          const data = JSON.stringify(frame);
          clock.set(() => {
            if (socket.over) return;
            if (dead()) {
              starve();
              return;
            }
            socket.heardAt = performance.now();
            socket.onmessage?.({ data });
          }, at - clock.now);
        };
        const die = (why = "the link dropped"): void => {
          if (socket.over) return;
          socket.over = true;
          watchers.delete(send);
          inUse.delete(die);
          // `MachineChannel`'s own close of a stream nothing arrived on carries its own code, and is no error.
          if (why === REDIALLED) {
            socket.onclose?.({ code: CLOSE_REDIAL, reason: why });
            return;
          }
          socket.onerror?.();
          socket.onclose?.({ code: 1006, reason: why });
        };
        inUse.set(die, { dialledAt: performance.now(), streaming: true, heard: () => socket.heardAt });
        if (lost()) {
          clock.set(() => die(), 15_000);
          return socket;
        }
        clock.set(() => {
          if (socket.over) return;
          if (!exists) {
            socket.over = true;
            inUse.delete(die);
            socket.onclose?.({ code: 4404, reason: "session not found" });
            return;
          }
          const asked = Math.min(since, log.length);
          send({ type: "hello", instanceId: "i_bad", session: snap(), firstSeq: 1, lastSeq: log.length, since: asked, gap: false });
          const backlog = log.filter((stored) => stored.seq > asked);
          if (backlog.length > 0) send({ type: "events", events: backlog });
          watchers.add(send);
          send({ type: "caught_up", seq: log.length });
        }, leg());
        if (link.socketLifeMs > 0) {
          clock.set(() => {
            if (!healed) die();
          }, pick(link.socketLifeMs * 0.2, link.socketLifeMs * 1.8));
        }
        return socket;
      },
      /** `MachineChannel.dispose`: every connection, the ones in use and the live stream included. */
      dispose(): void {
        for (const end of [...inUse.keys()]) end("the channel was disposed");
      },
      /** `MachineChannel.closeDialledBefore`: what a wake ends, in use or not. */
      closeDialledBefore(since: number): void {
        for (const [end, held] of [...inUse]) if (held.dialledAt < since) end("the channel was disposed");
      },
      /** `MachineChannel.dropIdle`: this stand-in pools nothing. */
      dropIdle(): void {},
      /** `MachineChannel.dropRedialable`: this stand-in pools nothing, so only a stream nothing arrives on goes, after its probation. */
      dropRedialable(): void {
        const suspected = performance.now();
        const streams = [...inUse].filter(([, held]) => held.streaming);
        clock.set(() => {
          for (const [end, held] of streams) if ((held.heard?.() ?? 0) <= suspected) end(REDIALLED);
        }, STREAM_PROBATION_MS);
      },
    };
  };

  // The control plane, over the same link.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = String(input);
      let done = false;
      const deadline = clock.set(() => {
        if (done) return;
        done = true;
        reject(new TypeError("fetch failed"));
      }, CP_TIMEOUT_MS);
      if (lost()) return;
      clock.set(() => {
        const now = clock.now;
        const answer =
          url === "/v1/tokens"
            ? { status: 200, body: { token: `jws-${now}`, expiresAt: now + 900_000, serverTime: now, machine: { relayUrl: record.relayUrl, relayOnline: true, key: MACHINE_KEY } } }
            : url === "/v1/machines"
              ? { status: 200, body: { machines: [record] } }
              : { status: 404, body: { error: { code: "not_found", message: `no route for ${init?.method ?? "GET"} ${url}` } } };
        if (lost()) return;
        clock.set(() => {
          if (done) return;
          done = true;
          clock.clear(deadline);
          resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
        }, leg());
      }, leg());
    })) as typeof fetch;

  cp.setSession("rs_bad_network");
  const internals = store as unknown as {
    connections: Map<string, unknown>;
    daemons: Map<string, unknown>;
    streams: Map<string, { status: () => { phase: string } }>;
    streamOrder: string[];
    serverRaw: { state: string; since: number | null };
    pollTimer: unknown;
    emit: () => void;
  };
  const connection = new MachineConnection(record as never, () => internals.emit(), channels as never);
  const daemon = new DaemonClient(connection);
  if (TRACE && run >= 0) {
    // What the store asked and when, which the drawn line beside it does not show.
    const say = (what: string): void => void process.stdout.write(`  ${((clock.now - started) / 1000).toFixed(1).padStart(6)}s    ${what}\n`);
    const resolve = connection.resolveRoute.bind(connection);
    connection.resolveRoute = async () => {
      say("route asked");
      const route = await resolve();
      say(route === null ? "route: none" : "route: found");
      return route;
    };
    const machines = cp.machines;
    const tick = (store as unknown as { tick: (early?: boolean) => Promise<void> }).tick.bind(store);
    (store as unknown as { tick: (early?: boolean) => Promise<void> }).tick = (early?: boolean) => {
      const peek = store as unknown as { nextProbeAt: Map<string, number>; probeFailures: Map<string, number>; nextListingAt: number };
      const due = peek.nextProbeAt.get(machine);
      say(`${early === true ? "early pass" : "poll"} (probe ${due === undefined ? "free" : `in ${((due - clock.now) / 1000).toFixed(1)}s`}, after ${String(peek.probeFailures.get(machine) ?? 0)} failures; reach ${connection.state().reach}/${String(connection.state().offlineReason)})`);
      return tick(early);
    };
    void machines;
  }
  internals.connections.set(machine, connection);
  internals.daemons.set(machine, daemon);
  // The poll here is the model's own. The marker and a visible page are what let the store's early pass over what is down run.
  internals.pollTimer = 0;
  (document as unknown as { visibilityState?: string }).visibilityState = "visible";

  let over = false;

  // The reader: what `NewSession`, `SessionView` and `Composer` do with the store, in their own order.
  let viewing = false;
  let sent = false;
  let draft: string | null = null;

  const openView = (): void => {
    viewing = true;
    store.openSession(ref);
  };

  const create = (): void => {
    void daemon.createSession({ agent: "claude", cwd: "/tmp", nickname: "bad" } as never).then(
      (result) => {
        store.applySnapshot(ref, result.session);
        openView();
      },
      () => {
        // Refused before it left: the sheet says so and the reader presses Create again.
        if (!exists) {
          clock.set(create, 3_000);
          return;
        }
        // A create that never answered: the reader finds the session in the list and opens it there.
        const wait = (): void => {
          if (store.getSnapshot().rowsByKey.has(key)) openView();
          else clock.set(wait, 1_000);
        };
        wait();
      },
    );
  };

  // A create still unanswered while its session sits in the list: the reader opens it from there.
  let listedSince: number | null = null;
  const openFromList = (): void => {
    if (viewing || over) return;
    if (store.getSnapshot().rowsByKey.has(key)) {
      listedSince ??= clock.now;
      if (clock.now - listedSince >= 5_000) {
        openView();
        return;
      }
    } else {
      listedSince = null;
    }
    clock.set(openFromList, 1_000);
  };

  const send = (): void => {
    const held = store.getSnapshot().transcripts.get(key)?.events.at(-1)?.seq ?? 0;
    const rowLast = store.getSnapshot().rowsByKey.get(key)?.snapshot.lastSeq ?? 0;
    const echo = { text: MESSAGE, seq: Number.MAX_SAFE_INTEGER, after: echoes.sendFloor(key, held, rowLast), attachments: [] };
    echoes.setEcho(key, echo);
    sent = true;
    void daemon.prompt(session, MESSAGE, []).then(
      (result) => {
        store.promptLanded(ref, echo, result.seq);
        store.applySnapshot(ref, result.session);
      },
      (cause: unknown) => {
        if (isTransportFailure(cause)) {
          hazards.failedSends += 1;
          if (log.some((stored) => stored.event["type"] === "prompt")) hazards.failedButTaken += 1;
        }
        if (isTransportFailure(cause) && sendKilledBy === "the channel was disposed") note(WAKE_ENDS_SEND);
        if (isTransportFailure(cause) && echoes.echoClaimed(echo)) return;
        echoes.clearEcho(key, echo);
        if (isTransportFailure(cause)) echoes.doubtSend(key, echo);
        draft = MESSAGE;
      },
    );
  };

  // A reader facing a conversation that draws nothing goes back to the list and opens it again.
  const reenterAfter = pick(3_000, 45_000);
  let blankSince: number | null = null;
  const reenter = (): void => {
    if (!viewing) return;
    const state = store.getSnapshot();
    const blank = !state.rowsByKey.has(key) || state.transcripts.get(key) === undefined;
    if (!blank) {
      blankSince = null;
      return;
    }
    blankSince ??= clock.now;
    if (clock.now - blankSince < reenterAfter || !state.rowsByKey.has(key)) return;
    blankSince = null;
    openView();
  };

  const seen = new Map<string, number>();
  function note(what: string): void {
    if (!seen.has(what)) seen.set(what, clock.now - started);
  }
  let rowSeen = false;
  let lastSeqSeen = 0;
  let offlineMs = 0;
  let observedAt = clock.now;

  // What the reader is shown of the trouble, by the rules the screens themselves use, beside the facts those rules read.
  const flicker = NO_FLICKER();
  const scopeNow = (): { machines: never[]; open: { machine: never; stream: never } | null } => ({
    machines: [machine as never],
    open: viewing ? { machine: machine as never, stream: (store.getSnapshot().transcripts.get(key)?.stream ?? null) as never } : null,
  });
  let factReach = "unknown";
  let shownReach = "unknown";
  let wasFrozenByFact = false;
  let wasFrozen = false;
  let wasStale = false;
  let factSeen: number | null = null;
  let factUp = false;
  let pillSeen: number | null = null;
  let pillShownAt: number | null = null;
  let pillDrawing = false;
  let factDownAt: number | null = null;
  let spellDrawn = 0;
  let streamDownAt: number | null = null;
  /** How late this watcher may be: it looks after each step of the clock, and the store acts within one. */
  const LOOK_MS = 50;
  /** The screens set a timer for each wait; here a no-op one makes the loop look again at that moment. */
  const lookAt = (monotonic: number): void => {
    const wait = monotonic - (clock.now - BASE);
    if (wait > 0) clock.set(() => {}, wait);
  };
  const watch = (): void => {
    const state = store.getSnapshot();
    const now = clock.now - BASE;
    const raw = connection.state();
    const fact: string = raw.reach;
    const shown = state.machines.find((one) => one.id === machine)?.reach ?? "unknown";
    // Dated here, by this watcher's own clock, so the store's rule is not checked against the store's own arithmetic.
    const down = retriedDown(raw.reach, raw.offlineReason);
    if (!down) factDownAt = null;
    else factDownAt ??= now;
    if (fact === "offline" && factReach !== "offline") {
      flicker.machineDown[0] += 1;
      spellDrawn = 0;
    }
    if (shown === "offline" && shownReach !== "offline") {
      flicker.machineDown[1] += 1;
      spellDrawn += 1;
      // The watcher looks after every step of the clock, so it may see the machine down a step later than the store did.
      if (state.device === "online" && down && !outlasted(factDownAt, now + LOOK_MS)) flicker.early += 1;
      if (spellDrawn > 1 && fact === "offline") note("one spell of a machine down was drawn as down twice");
    }
    if (down && state.device === "online" && outlasted(factDownAt, now, RECONNECT_QUIET_MS + LOOK_MS) && shown !== "offline") {
      note("a machine down past the quiet window was still drawn as up");
    }
    factReach = fact;
    shownReach = shown;

    const stream = viewing ? (state.transcripts.get(key)?.stream ?? null) : null;
    const live = stream?.phase === "live";
    // The working line exists only while the client believes the agent is working: that is the line a reader watches freeze.
    const working = state.rowsByKey.get(key)?.snapshot.status === "running";
    if (live) everLive = true;
    // Only a line that had been live: the wait of a conversation just opened is the opening's own.
    const frozenByFact = working && everLive && stream !== null && !live;
    if (frozenByFact && !wasFrozenByFact) flicker.stale[0] += 1;
    wasFrozenByFact = frozenByFact;
    // The same from the stream: its loss is dated once, and a retry that fails may not date it again.
    if (stream === null || live) streamDownAt = null;
    else streamDownAt ??= now;
    if (stream !== null && stream.downSince !== null && streamDownAt !== null && stream.downSince > streamDownAt) {
      note("a stream's loss was dated again by a retry");
    }
    const stale = stream !== null && outlasted(stream.downSince, now);
    if (stale && working && everLive && !wasFrozen) flicker.stale[1] += 1;
    wasFrozen = stale && working && everLive;
    wasStale = stale;
    if (stream !== null && stream.downSince !== null) lookAt(stream.downSince + RECONNECT_QUIET_MS);

    // The pill before the quiet window: the same causes read off the facts, raised after the grace.
    const facts = { device: state.device, server: internals.serverRaw, machines: [connection.state()], doubted: state.doubted };
    factSeen = troubleSince(factSeen, connectionTrouble(facts as never, scopeNow(), now) !== null, now);
    const up = factSeen !== null && now - factSeen >= TROUBLE_GRACE_MS;
    if (shown === "online") connected = true;
    if (up && !factUp && connected) flicker.pill[0] += 1;
    factUp = up;
    if (factSeen !== null) lookAt(factSeen + TROUBLE_GRACE_MS);

    const spell = connectionSpell(state, scopeNow(), now);
    pillSeen = troubleSince(pillSeen, spell !== null, now);
    const due = spell === null || pillSeen === null ? null : troubleDue(spell, pillSeen);
    const drew = pillDrawing;
    pillDrawing = troubleLive(due, pillDrawing, now);
    // One spell of trouble is one pill: a change of cause inside it may not take back what was drawn of it.
    if (drew && !pillDrawing && spell !== null) note("a spell of trouble was drawn and then taken back while it lasted");
    // Nothing in an outage of the whole link is the machine's own doing, before it ends or after.
    if (link.deadMs !== undefined && pillDrawing && spell?.trouble.kind === "unreachable") note(MACHINE_NAMED);
    const raised = troubleShown(pillDrawing, pillShownAt, now);
    if (raised && pillShownAt === null && connected) flicker.pill[1] += 1;
    pillShownAt = raised ? (pillShownAt ?? now) : null;
    if (due !== null) lookAt(due);
  };
  let everLive = false;
  let connected = false;

  let drawnBefore = "";
  const observe = (): void => {
    if (reader === "reenters") reenter();
    watch();
    // `Composer`'s effect: a send given back as lost that the log has since shown leaves the box, unless the reader changed it.
    const arrived = echoes.arrivedFor(key);
    if (arrived !== null) {
      echoes.takeArrived(key, arrived);
      if (draft === arrived.text) draft = null;
    }
    const state = store.getSnapshot();
    const row = state.rowsByKey.get(key);
    const transcript = state.transcripts.get(key);

    if (TRACE && run >= 0) {
      const bubbles = (transcript?.events ?? []).filter((stored) => stored.event.type === "prompt").length;
      const says = [
        row === undefined ? "list: no row" : `list: row (${row.snapshot.status}, seq ${row.snapshot.lastSeq})`,
        !viewing ? "pane: closed" : row === undefined ? "pane: no session" : transcript === undefined ? "pane: blank" : `pane: ${transcript.events.length} events, ${bubbles} message bubble(s)${echoes.echoFor(key) !== null ? " + echo" : ""}`,
        `stream: ${internals.streams.get(key)?.status().phase ?? "none"}`,
        `machine: ${state.machines.find((one) => one.id === machine)?.reach ?? "?"} (found ${connection.state().reach})`,
        `server: ${state.server.state} (found ${internals.serverRaw.state})`,
        pillShownAt === null ? "" : "pill",
        ((spell) => (spell === null ? "" : `cause: ${spell.trouble.kind}`))(connectionSpell(state, scopeNow(), clock.now - BASE)),
        state.listFailingSince.has(machine) ? "sessions unread" : "",
        healed ? "LINK BACK" : dead() ? "NOTHING PASSES" : "",
        draft === null ? "" : "box: the text is back",
      ].filter((part) => part !== "").join(" | ");
      if (says !== drawnBefore) {
        drawnBefore = says;
        process.stdout.write(`  ${((clock.now - started) / 1000).toFixed(1).padStart(6)}s  ${says}\n`);
      }
    }

    if (!healed && state.machines.find((one) => one.id === machine)?.reach === "offline") offlineMs += clock.now - observedAt;
    observedAt = clock.now;

    if (healed) {
      const after = clock.now - healAt;
      if (state.server.state !== "ok") recovery.server = after;
      if (shownReach !== "online") recovery.machine = after;
      if (wasStale) recovery.stale = after;
      if (pillShownAt !== null) recovery.pill = after;
    }

    if (row !== undefined) {
      rowSeen = true;
      if (row.snapshot.lastSeq < lastSeqSeen) note("the row went back to an older snapshot");
      lastSeqSeen = Math.max(lastSeqSeen, row.snapshot.lastSeq);
    } else if (rowSeen) {
      note("a session the daemon still holds left the list");
    }

    const events = transcript?.events ?? [];
    for (let i = 1; i < events.length; i += 1) {
      if (events[i]!.seq <= events[i - 1]!.seq) note("the conversation holds an event twice");
    }

    if (!sent) return;
    const delivered = events.filter((stored) => stored.event.type === "prompt").length;
    const echo = echoes.echoFor(key) !== null ? 1 : 0;
    // `SessionView` draws the conversation only with a row and a transcript, and the echo inside it.
    const drawn = row !== undefined && transcript !== undefined ? delivered + echo : 0;
    if (drawn > 1) note("the sent message was drawn twice");
    if (drawn === 0 && draft === null) note("the sent message was drawn nowhere");
    if (draft !== null && delivered > 0) note("the message arrived and its text is also back in the box");
  };

  // Polls start off-phase from the create, so a listing is routinely in flight around it.
  const poll = (): void => {
    if (over) return;
    void store.poll();
    clock.set(poll, POLL_MS);
  };
  clock.set(poll, pick(0, POLL_MS));
  clock.set(create, pick(4_000, 12_000));
  clock.set(openFromList, 12_000);
  let sendArmed = true;
  const trySend = (): void => {
    if (!sendArmed) return;
    // Only from an open conversation on a machine the composer would send to, as a reader can.
    if (viewing && store.getSnapshot().rowsByKey.has(key)) {
      sendArmed = false;
      send();
      return;
    }
    clock.set(trySend, 1_000);
  };
  clock.set(trySend, pick(25_000, 60_000));

  // The device calling itself offline and back, as a flaky Wi-Fi does: `resume.ts` turns that into a wake.
  if (link.flapEveryMs > 0) {
    const flap = (): void => {
      if (healed) return;
      const since = clock.now - BASE;
      store.noteDevice(false);
      clock.set(() => {
        store.noteDevice(true);
        void store.wake("online", since);
      }, pick(200, 3_000));
      clock.set(flap, pick(link.flapEveryMs * 0.3, link.flapEveryMs * 1.7));
    };
    clock.set(flap, pick(link.flapEveryMs * 0.3, link.flapEveryMs * 1.7));
  }

  // The outage as the device reports it: `resume.ts` turns the second word into a wake naming the first.
  if (link.deadMs !== undefined && link.says !== undefined && link.says !== "nothing") {
    let since = 0;
    clock.set(() => {
      since = clock.now - BASE;
      store.noteDevice(false);
    }, deadFrom - clock.now);
    clock.set(() => {
      store.noteDevice(true);
      void store.wake("online", since);
    }, healAt + (link.says === "early" ? -Math.min(ONLINE_EARLY_MS, link.deadMs / 2) : ONLINE_LATE_MS) - clock.now);
  }

  const recovery: Recovery = { server: 0, machine: 0, stale: 0, pill: 0 };
  let drawnAtHeal = false;
  const settled: string[] = [];
  const endAt = healAt + 120_000;
  try {
    for (;;) {
      if (!healed && clock.now >= healAt) {
        healed = true;
        drawnAtHeal = pillShownAt !== null;
      }
      if (!clock.step(healed ? endAt : healAt)) {
        if (healed) break;
        clock.now = healAt;
        continue;
      }
      await settle();
      observe();
    }

    const state = store.getSnapshot();
    const transcript = state.transcripts.get(key);
    const held = (transcript?.events ?? []).map((stored) => stored.seq);
    const whole = log.map((stored) => stored.seq);
    if (!state.rowsByKey.has(key)) settled.push("no row");
    else if (state.rowsByKey.get(key)?.snapshot.lastSeq !== log.length) settled.push("a stale row");
    if (viewing) {
      if (JSON.stringify(held) !== JSON.stringify(whole)) settled.push(`holds ${held.length} of ${whole.length} events`);
      if (internals.streams.get(key)?.status().phase !== "live") settled.push("no live stream");
    } else {
      settled.push("the conversation never opened");
    }
    if (echoes.echoFor(key) !== null) settled.push("an echo still held");
    if (shownReach !== "online") settled.push(`the machine still drawn ${shownReach}`);
    if (wasStale) settled.push("the working line still drawn stale");
    if (pillShownAt !== null) settled.push("the pill still up");
  } finally {
    // Nothing of this schedule may still be in flight when the next begins: the store is one object for all of them.
    over = true;
    internals.pollTimer = null;
    store.noteDevice(true);
    let resumed = false;
    void store.resume("settle").then(
      () => void (resumed = true),
      () => void (resumed = true),
    );
    for (let i = 0; i < 2_000 && !resumed; i += 1) {
      await settle();
      if (!resumed && !clock.step(Number.POSITIVE_INFINITY)) break;
    }
    store.forgetMachine(machine);
    for (let i = 0; i < 2_000 && clock.pending > 0; i += 1) {
      if (!clock.step(Number.POSITIVE_INFINITY)) break;
      await settle();
    }
    internals.streamOrder = internals.streamOrder.filter((held) => held !== key);
    echoes.clearEcho(key);
    cp.clearSession();
    delete (document as unknown as { visibilityState?: string }).visibilityState;
    globalThis.fetch = realFetch;
    (globalThis as Record<string, unknown>)["setTimeout"] = realSetTimeout;
    (globalThis as Record<string, unknown>)["clearTimeout"] = realClearTimeout;
    Date.now = realDateNow;
    performance.now = realPerformanceNow;
    Math.random = realRandom;
  }

  return { seed, hazards, flicker, seen, settled, offlineShare: offlineMs / (healAt - started), recovery, drawnAtHeal };
}

export const LINKS: Record<string, LinkProfile> = {
  // Nothing wrong with it: the baseline every check below is measured against.
  good: { baseMs: 40, stallChance: 0, stallMs: 0, lossChance: 0, socketLifeMs: 0, flapEveryMs: 0 },
  // Slow and uneven, nothing lost: answers overtake each other and that is all.
  slow: { baseMs: 500, stallChance: 0.3, stallMs: 9_000, lossChance: 0, socketLifeMs: 0, flapEveryMs: 0 },
  // Stalls, lost answers, sockets that die every few seconds.
  lossy: { baseMs: 400, stallChance: 0.25, stallMs: 12_000, lossChance: 0.06, socketLifeMs: 15_000, flapEveryMs: 0 },
  // A phone on a train: all of that, and a device that says offline and back, which is a wake.
  flapping: { baseMs: 400, stallChance: 0.25, stallMs: 12_000, lossChance: 0.06, socketLifeMs: 15_000, flapEveryMs: 40_000 },
};

export interface Sweep {
  seen: Map<string, number[]>;
  settled: Map<string, number[]>;
  hazards: Hazards;
  flicker: Flicker;
  offlineShare: number;
}

let warmed = false;
/** The store's first listing ever does more than any later one, so one schedule is spent before the first that counts. */
async function warm(): Promise<void> {
  if (warmed) return;
  warmed = true;
  await runSchedule(1, LINKS["good"]!, -1);
}

export async function sweep(link: LinkProfile, seeds: number, offset = 0, reader: Reader = "stays"): Promise<Sweep> {
  await warm();
  const seen = new Map<string, number[]>();
  const settled = new Map<string, number[]>();
  let offline = 0;
  const hazards: Hazards = { staleListings: 0, overtaken: 0, failedSends: 0, failedButTaken: 0 };
  const flicker = NO_FLICKER();
  for (let i = 0; i < seeds; i += 1) {
    const outcome = await runSchedule(1_000 + offset + i, link, offset + i, reader);
    offline += outcome.offlineShare;
    for (const name of Object.keys(hazards) as (keyof Hazards)[]) hazards[name] += outcome.hazards[name];
    for (const name of ["machineDown", "stale", "pill"] as const) {
      flicker[name][0] += outcome.flicker[name][0];
      flicker[name][1] += outcome.flicker[name][1];
    }
    flicker.early += outcome.flicker.early;
    for (const what of outcome.seen.keys()) seen.set(what, [...(seen.get(what) ?? []), outcome.seed]);
    for (const what of outcome.settled) {
      const kind = what.replace(/\d+/g, "N");
      settled.set(kind, [...(settled.get(kind) ?? []), outcome.seed]);
    }
  }
  return { seen, settled, hazards, flicker, offlineShare: offline / seeds };
}

const traced = process.env["BAD_NETWORK_TRACE"];
if (traced !== undefined) {
  const [name, reader, seed] = traced.split(":");
  await warm();
  // `outage-90-nothing:stays:5003` is one schedule of `BAD_NETWORK_OUTAGE`.
  const [, deadS, says] = /^outage-(\d+)-(\w+)$/.exec(name ?? "") ?? [];
  const link = deadS === undefined ? LINKS[name ?? "slow"]! : outage(Number(deadS) * 1000, says as Says);
  const outcome = await runSchedule(Number(seed), link, Number(seed) - 1_000, (reader ?? "stays") as Reader);
  for (const [what, at] of outcome.seen) process.stdout.write(`  seen at ${(at / 1000).toFixed(1)}s: ${what}\n`);
  for (const what of outcome.settled) process.stdout.write(`  settled: ${what}\n`);
  process.exit(0);
}

const OUTAGES_MS = [8_000, 20_000, 45_000, 90_000];
const SAYS: Says[] = ["nothing", "both", "early"];

/** Each outage length under each thing a device may say of it; the schedules differ in where the outage falls in the client's own cycles. */
export async function outages(seeds: number, offset: number): Promise<{ says: Says; deadMs: number; outcomes: Outcome[] }[]> {
  await warm();
  const all: { says: Says; deadMs: number; outcomes: Outcome[] }[] = [];
  let run = offset;
  for (const says of SAYS) {
    for (const deadMs of OUTAGES_MS) {
      const outcomes: Outcome[] = [];
      for (let i = 0; i < seeds; i += 1) outcomes.push(await runSchedule(5_000 + i, outage(deadMs, says), (run += 1)));
      all.push({ says, deadMs, outcomes });
    }
  }
  return all;
}

const outageTool = process.env["BAD_NETWORK_OUTAGE"];
if (outageTool !== undefined) {
  const spread = (values: number[]): string => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (share: number): string => ((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0) / 1000).toFixed(1).padStart(5);
    return `median ${at(0.5)}s  p90 ${at(0.9)}s  worst ${at(1)}s`;
  };
  for (const { says, deadMs, outcomes } of await outages(Number(outageTool) || 40, 200_000)) {
    process.stdout.write(`\n${String(deadMs / 1000)} s with nothing passing, the device says ${says}: after the link is back\n`);
    for (const what of ["server", "machine", "stale", "pill"] as const) {
      const worst = outcomes.reduce((a, b) => (b.recovery[what] > a.recovery[what] ? b : a));
      process.stdout.write(`  ${what.padEnd(8)} ${spread(outcomes.map((outcome) => outcome.recovery[what]))}  (seed ${String(worst.seed)})\n`);
    }
    const seen = new Map<string, number>();
    for (const outcome of outcomes) for (const what of [...outcome.seen.keys(), ...outcome.settled]) seen.set(what, (seen.get(what) ?? 0) + 1);
    for (const [what, count] of seen) process.stdout.write(`  seen     ${String(count).padStart(4)}  ${what}\n`);
  }
  process.exit(0);
}

const explore = process.env["BAD_NETWORK_EXPLORE"];
if (explore !== undefined) {
  const seeds = Number(explore) || 100;
  const only = process.env["BAD_NETWORK_LINKS"]?.split(",");
  for (const [name, link] of Object.entries(LINKS)) {
    if (only !== undefined && !only.includes(name)) continue;
    for (const reader of ["stays", "reenters"] as const) {
      const { seen, settled, hazards, flicker, offlineShare } = await sweep(link, seeds, reader === "stays" ? 0 : 10_000, reader);
      process.stdout.write(`\n${name}, a reader who ${reader}: ${seeds} schedules, machine drawn unreachable ${(offlineShare * 100).toFixed(1)}% of the time\n`);
      process.stdout.write(`  hazards  ${JSON.stringify(hazards)}\n`);
      process.stdout.write(`  flicker  [by the fact, as drawn]  ${JSON.stringify(flicker)}\n`);
      for (const [what, hit] of seen) process.stdout.write(`  seen     ${String(hit.length).padStart(4)}  ${what}  (first seed ${hit[0]})\n`);
      for (const [what, hit] of settled) process.stdout.write(`  settled  ${String(hit.length).padStart(4)}  ${what}  (first seed ${hit[0]})\n`);
      if (seen.size === 0 && settled.size === 0) process.stdout.write("  clean\n");
    }
  }
  process.exit(0);
}

process.stdout.write("\nwhich of two snapshots is the newer, when arrival order proves nothing\n");
{
  const { supersedes } = await import("../src/store.js");
  check("a row never read before takes whatever arrives", supersedes({ lastSeq: 3 }, undefined, 0, 1), true);
  check("a later log replaces an earlier one, however long ago it was asked for", supersedes({ lastSeq: 9 }, { lastSeq: 5 }, 40, 7), true);
  check("an earlier log never replaces a later one, however recently it was asked for", supersedes({ lastSeq: 5 }, { lastSeq: 9 }, 7, 40), false);
  check("of two reads of one log, the one asked after the row last moved wins", supersedes({ lastSeq: 5 }, { lastSeq: 5 }, 7, 8), true);
  check("and the one asked before it does not", supersedes({ lastSeq: 5 }, { lastSeq: 5 }, 8, 7), false);
}

process.stdout.write("\na sent message whose request failed in transit\n");
{
  const echoes = await import("../src/echo.js");
  const { keyOf, machineId, sessionId } = await import("../src/ids.js");
  const key = keyOf({ machineId: machineId("m_echo"), sessionId: sessionId("s_echo") });
  const prompt = (seq: number, text: string): never => ({ seq, ts: seq, event: { type: "prompt", text, attachments: [] } }) as never;
  const sent = (after: number): { text: string; seq: number; after: number; attachments: never[] } => ({
    text: "build it",
    seq: Number.MAX_SAFE_INTEGER,
    after,
    attachments: [],
  });

  const first = sent(4);
  echoes.setEcho(key, first);
  check("an echo is not claimed until its event is seen", echoes.echoClaimed(first), false);
  echoes.claimEcho(key, [prompt(5, "build it")]);
  check("its own prompt event takes it", echoes.echoFor(key), null);
  check("and it is remembered as taken, so a lost answer gives nothing back", echoes.echoClaimed(first), true);

  const second = sent(5);
  echoes.setEcho(key, second);
  echoes.clearEcho(key, second);
  echoes.doubtSend(key, second);
  check("a doubted send has not arrived until the log says so", echoes.arrivedFor(key), null);
  echoes.claimEcho(key, [prompt(5, "build it")]);
  check("an event at or under its floor is an earlier message, not this one", echoes.arrivedFor(key), null);
  echoes.claimEcho(key, [prompt(6, "something else")]);
  check("nor is another text", echoes.arrivedFor(key), null);
  echoes.claimEcho(key, [prompt(7, "build it")]);
  check("its own event, wherever it came from, says it arrived", echoes.arrivedFor(key) === second, true);
  echoes.takeArrived(key, second);
  check("and it is taken once", echoes.arrivedFor(key), null);

  const third = sent(7);
  echoes.setEcho(key, third);
  echoes.clearEcho(key, third);
  echoes.doubtSend(key, third);
  const again = sent(7);
  echoes.setEcho(key, again);
  echoes.claimEcho(key, [prompt(8, "build it")]);
  check("sending again spends the doubt: the first event is the new echo's", [echoes.echoFor(key), echoes.arrivedFor(key)], [null, null]);

  const fourth = sent(8);
  echoes.setEcho(key, fourth);
  echoes.clearEcho(key, fourth);
  echoes.doubtSend(key, fourth);
  echoes.clearEcho(key);
  echoes.claimEcho(key, [prompt(9, "build it")]);
  check("a forgotten session takes its doubt with it", echoes.arrivedFor(key), null);
}

process.stdout.write("\nlistings read by the daemon in one order and landing in another\n");
{
  const { store } = await import("../src/store.js");
  const { keyOf, machineId, sessionId } = await import("../src/ids.js");
  const machine = machineId("m_order");
  const ref = { machineId: machine, sessionId: sessionId("s_order") };
  const key = keyOf(ref);
  const internals = store as unknown as {
    connections: Map<string, unknown>;
    daemons: Map<string, unknown>;
    streams: Map<string, unknown>;
    streamOrder: string[];
    listedAsOf: Map<string, number>;
    epoch: number;
    refreshMachineSessions: (connection: unknown, epoch: number) => Promise<void>;
  };
  const connection = { id: machine, state: () => ({ id: machine, name: "alpha", reach: "online", offlineReason: null, tokenDegraded: false }) };
  const asked: ((body: unknown) => void)[] = [];
  internals.connections.set(machine, connection);
  internals.daemons.set(machine, {
    listSessions: () => new Promise((resolve) => asked.push(resolve)),
    roots: async () => ({ roots: [] }),
    plugins: async () => ({ plugins: [] }),
  });
  const shot = (lastSeq: number, status = "idle"): never => ({ ...baseSnapshot, id: "s_order", status, lastSeq }) as never;
  const listing = (sessions: unknown[], instanceId = "i_one"): unknown => ({ sessions, total: sessions.length, truncated: false, now: 1, instanceId });
  const ask = (): { lands: (body: unknown) => Promise<void> } => {
    const pass = internals.refreshMachineSessions(connection, internals.epoch);
    const resolve = asked.at(-1)!;
    return {
      lands: async (body) => {
        resolve(body);
        await pass;
      },
    };
  };
  const held = (): { status: string; lastSeq: number } | null => {
    const row = store.getSnapshot().rowsByKey.get(key);
    return row === undefined ? null : { status: row.snapshot.status, lastSeq: row.snapshot.lastSeq };
  };

  {
    // Asked first, read last: it lists the session, with a later log than the create's own answer.
    const first = ask();
    const second = ask();
    store.applySnapshot(ref, shot(4));
    await first.lands(listing([shot(5)]));
    check("a listing asked before the row landed still brings its later log", held(), { status: "idle", lastSeq: 5 });
    await second.lands(listing([]));
    check("and the one asked after it, read before the session existed, cannot prune what that confirmed", held(), { status: "idle", lastSeq: 5 });
  }
  {
    const first = ask();
    const second = ask();
    await first.lands(listing([shot(6)]));
    store.applySnapshot(ref, shot(4, "starting"));
    check("an answer that took the slow way round changes nothing drawn", held(), { status: "idle", lastSeq: 6 });
    await second.lands(listing([]));
    check("yet it says the session exists, so a listing asked before it landed cannot prune either", held(), { status: "idle", lastSeq: 6 });
  }
  {
    const late = ask();
    await late.lands(listing([shot(6, "running")]));
    check("of two reads of one log, one asked after the row last moved replaces it", held(), { status: "running", lastSeq: 6 });
  }
  {
    const restarted = ask();
    await restarted.lands(listing([shot(2, "interrupted")], "i_two"));
    check("a daemon that started again is its own order, shorter log and all", held(), { status: "interrupted", lastSeq: 2 });
  }
  {
    // With its stream open, as a conversation on screen has: closing that takes the key out of the order, and it is put back.
    let stopped = 0;
    const stream = { ref, stop: () => void (stopped += 1), status: () => ({ phase: "live" }) };
    internals.streams.set(key, stream);
    internals.streamOrder = ["k_other", key];
    const gone = ask();
    await gone.lands(listing([], "i_two"));
    check("a listing asked after everything else, and lacking the session, removes it", held(), null);
    check(
      "its stream is closed and the conversation on screen stays wanted, so its row coming back opens it again",
      [stopped, internals.streams.has(key), internals.streamOrder],
      [1, false, ["k_other", key]],
    );
    store.onVanished(ref);
    check("and the conversation on screen stays wanted once, however often it is forgotten", internals.streamOrder, ["k_other", key]);
    internals.streams.set(key, stream);
    internals.streamOrder = [key, "k_other"];
    store.onVanished(ref);
    check("while one nobody is looking at is closed and wanted by nobody", [stopped, internals.streams.has(key), internals.streamOrder], [2, false, ["k_other"]]);
    internals.streamOrder = [];
  }
  const waiting = (): number | undefined => store.getSnapshot().devicesWaiting.get(machine);
  {
    // Q3.711: a daemon restarted between two listings, and the one the process before it read lands last, with that process's longer log.
    const old = ask();
    await old.lands(listing([shot(100)], "i_old"));
    check("a long log is held", held(), { status: "idle", lastSeq: 100 });
    const late = ask();
    const fresh = ask();
    await fresh.lands(listing([shot(2)], "i_new"));
    check("the daemon starts again, and its own shorter log replaces it", held(), { status: "idle", lastSeq: 2 });
    const stamped = internals.listedAsOf.get(machine);
    await late.lands({ ...(listing([shot(100)], "i_old") as object), devicesPending: 4 });
    check(
      "a listing from the process before it, landing late with that longer log, replaces nothing and stamps nothing",
      [held(), internals.listedAsOf.get(machine) === stamped, waiting()],
      [{ status: "idle", lastSeq: 2 }, true, undefined],
    );
    const next = ask();
    await next.lands(listing([shot(3)], "i_new"));
    check("so the restarted daemon's row moves on with its next listing", held(), { status: "idle", lastSeq: 3 });
  }
  {
    // Q1.655: the count behind the bell is the listing's own field, and a listing without it says nobody is waiting.
    const counted = ask();
    await counted.lands({ ...(listing([shot(3)], "i_new") as object), devicesPending: 2 });
    check("a listing that counts the devices waiting to be let in is where that count is read", waiting(), 2);
    const again = ask();
    await again.lands({ ...(listing([shot(3)], "i_new") as object), devicesPending: 2 });
    check("the same count again is the same count", waiting(), 2);
    const silent = ask();
    await silent.lands(listing([shot(3)], "i_new"));
    check("one that carries none, as an older daemon's does or one sent to somebody who may not let them in, clears it", waiting(), undefined);
    const odd = ask();
    await odd.lands({ ...(listing([shot(3)], "i_new") as object), devicesPending: "2" });
    check("and a count that is no number is none", waiting(), undefined);
  }

  store.forgetMachine(machine);
}

process.stdout.write("\na message sent into a conversation that holds nothing yet\n");
{
  const { store } = await import("../src/store.js");
  const echoes = await import("../src/echo.js");
  const { keyOf, machineId, sessionId } = await import("../src/ids.js");
  const machine = machineId("m_floor");
  const ref = { machineId: machine, sessionId: sessionId("s_floor") };
  const key = keyOf(ref);
  const internals = store as unknown as {
    daemons: Map<string, unknown>;
    transcripts: Map<string, unknown>;
    primed: Set<string>;
    primeBlocked: (ref: unknown, snapshot: { lastSeq: number }) => Promise<void>;
  };
  const prompt = (seq: number): unknown => ({ seq, ts: seq, event: { type: "prompt", text: "continue", attachments: [] } });
  const other = (seq: number): unknown => ({ seq, ts: seq, event: { type: "text", role: "assistant", thought: false, text: `#${String(seq)} ` } });
  const cold = (log: unknown[], rowLast: number): void => {
    internals.daemons.set(machine, {
      events: async (_id: string, since: number, limit: number) => ({
        events: (log as { seq: number }[]).filter((stored) => stored.seq > since).slice(0, limit),
        firstSeq: 1,
      }),
    });
    internals.transcripts.set(key, { events: [], gaps: [], heldBytes: 0, loadedFrom: rowLast + 1, daemonFirstSeq: 1, clearedAt: null, loadingHistory: false, stream: null });
  };

  check(
    "the composer's floor is the later of what it holds and what the row has seen",
    /after: sendFloor\(key, held\.transcripts\.get\(key\)\?\.events\.at\(-1\)\?\.seq \?\? 0, held\.rowsByKey\.get\(key\)\?\.snapshot\.lastSeq \?\? 0\)/.test(
      readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8"),
    ),
    true,
  );
  check("with nothing held, the floor is the row's log", echoes.sendFloor(key, 0, 9), 9);
  check("and whichever of the two is later, once something is", [echoes.sendFloor(key, 12, 9), echoes.sendFloor(key, 7, 9)], [12, 9]);

  // The same words were sent before; the page of history that carries them lands after this send.
  cold([other(1), prompt(5), other(6), other(7), other(8), other(9)], 9);
  const sent = { text: "continue", seq: Number.MAX_SAFE_INTEGER, after: echoes.sendFloor(key, 0, 9), attachments: [] };
  echoes.setEcho(key, sent);
  await store.loadAll(ref);
  check("the same words from earlier in the log are not this send", [echoes.echoFor(key) === sent, echoes.echoClaimed(sent)], [true, false]);

  // Opened cold after the daemon took it: its own event is in the page, past the floor.
  cold([other(1), prompt(5), other(6), other(7), other(8), other(9), prompt(10), other(11)], 11);
  await store.loadAll(ref);
  check("its own event in a page of history is", [echoes.echoFor(key), echoes.echoClaimed(sent)], [null, true]);

  // The third door: the page read for a session that waits on somebody, before anybody has opened it.
  const unopened = (log: unknown[], rowLast: number): Promise<void> => {
    cold(log, rowLast);
    internals.transcripts.delete(key);
    internals.primed.delete(key);
    return internals.primeBlocked(ref, { lastSeq: rowLast });
  };
  const waited = { text: "continue", seq: Number.MAX_SAFE_INTEGER, after: echoes.sendFloor(key, 0, 9), attachments: [] };
  echoes.setEcho(key, waited);
  await unopened([other(1), prompt(5), other(6), other(7), other(8), other(9)], 9);
  check(
    "a waiting session's first page holds to the same floor: the same words from earlier are not this send",
    [internals.transcripts.has(key), echoes.echoFor(key) === waited, echoes.echoClaimed(waited)],
    [true, true, false],
  );
  await unopened([other(1), prompt(5), other(6), other(7), other(8), other(9), prompt(10), other(11)], 11);
  check("and its own event in that page claims it", [internals.transcripts.has(key), echoes.echoFor(key), echoes.echoClaimed(waited)], [true, null, true]);
  internals.primed.delete(key);

  echoes.clearEcho(key);
  internals.daemons.delete(machine);
  internals.transcripts.delete(key);
}

process.stdout.write("\na slow, lossy link: what a late, lost or reordered answer may not undo\n");
{
  const SCHEDULES = 60;
  check("the model opens a conversation as SessionView does, once per reference", viewOpensOncePerRef(), true);

  const totals: Record<string, Hazards> = {};
  const drawn: Record<string, Flicker> = {};
  let offset = 0;
  for (const [name, link] of Object.entries(LINKS)) {
    totals[name] = { staleListings: 0, overtaken: 0, failedSends: 0, failedButTaken: 0 };
    drawn[name] = NO_FLICKER();
    for (const reader of ["stays", "reenters"] as const) {
      const result = await sweep(link, SCHEDULES, offset, reader);
      offset += 10_000;
      for (const hazard of Object.keys(result.hazards) as (keyof Hazards)[]) totals[name]![hazard] += result.hazards[hazard];
      for (const what of ["machineDown", "stale", "pill"] as const) {
        drawn[name]![what][0] += result.flicker[what][0];
        drawn[name]![what][1] += result.flicker[what][1];
      }
      drawn[name]!.early += result.flicker.early;
      const allowed = link.flapEveryMs > 0 ? [WAKE_ENDS_SEND] : [];
      check(
        `a ${name} link, a reader who ${reader}: nothing drawn that a reader must never see`,
        [...result.seen].filter(([what]) => !allowed.includes(what)).map(([what, seeds]) => `${what} (${String(seeds.length)} of ${String(SCHEDULES)}, first seed ${String(seeds[0])})`),
        [],
      );
      check(
        "and once the link heals the list, the conversation and its stream are whole",
        [...result.settled].map(([what, seeds]) => `${what} (${String(seeds.length)} of ${String(SCHEDULES)}, first seed ${String(seeds[0])})`),
        [],
      );
    }
  }

  // A clean sweep proves nothing unless the link did what it is named for.
  report("a good link handed the store nothing out of order", totals["good"]!.overtaken + totals["good"]!.staleListings === 0, JSON.stringify(totals["good"]));
  report("a slow one handed it listings older than the session, after the session's row", totals["slow"]!.staleListings > 0, `${String(totals["slow"]!.staleListings)} of them`);
  report("while none overtook another, since a poll waits for its own answer", totals["slow"]!.overtaken === 0, `${String(totals["slow"]!.overtaken)} of them`);
  report("a lossy one failed sends the daemon had taken", totals["lossy"]!.failedButTaken > 0, `${String(totals["lossy"]!.failedButTaken)} of ${String(totals["lossy"]!.failedSends)} failed sends`);
  report("and so did a flapping one", totals["flapping"]!.failedButTaken > 0, `${String(totals["flapping"]!.failedButTaken)} of ${String(totals["flapping"]!.failedSends)} failed sends`);

  // Q3.714: what a reader is shown of all that. A drop that is back inside the quiet window is drawn nowhere.
  check(
    "nothing is drawn of a spell shorter than the quiet window, on any link",
    Object.entries(drawn).filter(([, flicker]) => flicker.early > 0).map(([name, flicker]) => `${name}: ${String(flicker.early)}`),
    [],
  );
  check("a good link draws no trouble at all", drawn["good"], NO_FLICKER());
  for (const name of ["slow", "lossy", "flapping"]) {
    const flicker = drawn[name]!;
    const says = (["machineDown", "stale", "pill"] as const).map((what) => `${what} ${String(flicker[what][0])} by the fact, ${String(flicker[what][1])} drawn`).join("; ");
    const kinds = ["machineDown", "stale", "pill"] as const;
    report(
      `a ${name} link gave the facts trouble a reader was not shown`,
      kinds.every((what) => flicker[what][1] <= flicker[what][0]) && kinds.some((what) => flicker[what][1] < flicker[what][0]),
      says,
    );
  }
}

process.stdout.write("\nthe link back after an outage\n");
{
  // Q3.716. Each length under each thing a device may say of it; the schedules differ in where the outage falls in the
  // client's own cycles, which is what decided whether the reader waited two seconds or twenty-five.
  const SCHEDULES = 14;
  /** `DOWN_RETRY_MS` and a probe's own timeout, with room for the pass that asks; before this it was the outage's pace plus a listing's timeout. */
  const BACK_WITHIN_MS = 6_000;
  const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  check("the bound below is the store's own pace and a probe's timeout", [/const DOWN_RETRY_MS = 4_000;/.test(store), /const PROBE_TIMEOUT_MS = 1_500;/.test(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"))], [true, true]);
  const seconds = (ms: number): string => (ms / 1000).toFixed(1);
  for (const { says, deadMs, outcomes } of await outages(SCHEDULES, 200_000)) {
    const name = `${String(deadMs / 1000)} s with nothing passing, the device saying ${says === "nothing" ? "nothing" : says === "both" ? "so at both ends" : "it is back before it is"}`;
    const allowed = says === "nothing" ? [] : [WAKE_ENDS_SEND];
    const seen = new Map<string, number[]>();
    for (const outcome of outcomes) {
      for (const what of [...outcome.seen.keys(), ...outcome.settled]) seen.set(what, [...(seen.get(what) ?? []), outcome.seed]);
    }
    check(
      `${name}: nothing drawn that a reader must never see, and whole once it is back`,
      [...seen].filter(([what]) => !allowed.includes(what)).map(([what, seeds]) => `${what} (${String(seeds.length)} of ${String(SCHEDULES)}, first seed ${String(seeds[0])})`),
      [],
    );
    const worst = (what: keyof Recovery): number => Math.max(...outcomes.map((outcome) => outcome.recovery[what]));
    const late = outcomes.filter((outcome) => (["server", "machine", "stale", "pill"] as const).some((what) => outcome.recovery[what] > BACK_WITHIN_MS));
    report(
      `and nothing of it is still drawn ${seconds(BACK_WITHIN_MS)} s after the link is back`,
      late.length === 0,
      `worst: server ${seconds(worst("server"))} s, machine ${seconds(worst("machine"))} s, stale line ${seconds(worst("stale"))} s, pill ${seconds(worst("pill"))} s${late.length === 0 ? "" : `; late in seeds ${late.map((outcome) => String(outcome.seed)).join(", ")}`}`,
    );
    // A quick recovery from an outage nobody was shown would prove nothing.
    if (deadMs >= 45_000) {
      const drawn = outcomes.filter((outcome) => outcome.drawnAtHeal).length;
      report("an outage that long was on screen when it ended", drawn === SCHEDULES, `${String(drawn)} of ${String(SCHEDULES)} schedules`);
    }
  }
}

process.stdout.write("\nwho may end a request in flight\n");
{
  const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const read = (path: string): string => strip(readFileSync(new URL(path, import.meta.url), "utf8"));
  const machineSrc = read("../src/machine.ts");
  const storeSrc = read("../src/store.ts");
  const composerSrc = read("../src/ui/Composer.tsx");
  const body = (source: string, head: RegExp): string => {
    const at = source.search(head);
    if (at === -1) return "";
    const open = source.indexOf("{", at + (head.exec(source)?.[0].length ?? 0) - 1);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      if (source[i] === "}" && (depth -= 1) === 0) return source.slice(open, i + 1);
    }
    return "";
  };

  const forget = body(machineSrc, /\n {2}forgetRoute\(\): void \{/);
  check("forgetting a route drops what redials at no cost", /this\.channel\?\.dropRedialable\(\)/.test(forget), true);
  check("and never the channel, which would end every request riding it", /closeChannel|dispose/.test(forget), false);
  // Q3.714: a stream is ended by its own silence, never by another request's failure, and its first redial does not re-prove the route.
  const channelSrc = read("../src/e2ee.ts");
  const streamSrc = read("../src/stream.ts");
  const { CLOSE_REDIAL } = await import("../src/e2ee.js");
  const drop = body(channelSrc, /\n {2}dropRedialable\(\): void \{/);
  check(
    "which closes the idle connections at once, and a stream only if nothing arrived on it through its probation",
    [
      /this\.dropIdle\(\);/.test(drop),
      /if \(connection\.streaming && connection\.heardAt <= suspected\) connection\.close\(true\);/.test(drop),
      /\}, this\.options\.probationMs \?\? STREAM_PROBATION_MS\);/.test(drop),
      (drop.match(/connection\.close\(/g) ?? []).length,
      /this\.heardAt = monotonicNow\(\);\s*const chunk = new Uint8Array\(event\.data\);/.test(channelSrc),
    ],
    [true, true, true, 1, true],
  );
  // Taken for a dead link, that close made its stream suspect its siblings, and each probation closed the next for ever.
  const redialled = body(channelSrc, /\n {2}redialled\(\): void \{/);
  const redialArm = /case CLOSE_REDIAL:([\s\S]*?)return;/.exec(body(streamSrc, /private handleClose\(code: number, reason: string\): void \{/))?.[1] ?? "";
  check(
    "that close carries this client's own code, and a stream that gets it dials again and asks nothing of the route",
    [
      /if \(redial\) carrying\.sink\.redialled\(\);\s*else carrying\.sink\.transportEnded\(error\);/.test(channelSrc),
      /code: CLOSE_REDIAL/.test(redialled),
      /onerror/.test(redialled),
      /this\.retryLater\(reason, REDIAL_NOW_MS, true\);/.test(redialArm),
      /forgetRoute|suspectRoute/.test(redialArm),
      CLOSE_REDIAL,
    ],
    [true, true, false, true, false, 4990],
  );
  const idleOnly = body(channelSrc, /\n {2}dropIdle\(\): void \{/);
  check("and what is dropped as idle is idle: no stream is touched", [/this\.idle\.splice\(0\)/.test(idleOnly), /streaming|this\.live/.test(idleOnly)], [true, false]);
  check(
    "for as long as this model gives it",
    Number(/const STREAM_PROBATION_MS = ([\d_]+);/.exec(channelSrc)?.[1]?.replaceAll("_", "") ?? "NaN"),
    STREAM_PROBATION_MS,
  );
  const suspect = body(machineSrc, /\n {2}suspectRoute\(\): void \{/);
  check(
    "a suspected route keeps its memo and drops only what is idle, and a route already forgotten is suspected by nobody",
    [/this\.channel\?\.dropIdle\(\)/.test(suspect), /dropRedialable/.test(suspect), /if \(this\.chosen === null\) return;/.test(suspect), /this\.chosen = /.test(suspect)],
    [true, false, true, false],
  );
  const closed = body(streamSrc, /private handleClose\(code: number, reason: string\): void \{/);
  const transport = closed.slice(closed.indexOf("default:"));
  check(
    "a socket that dies after a while live is redialled at once on the route it rode, and the memo goes when one dies young or before its hello",
    [
      /if \(this\.liveSince !== null && monotonicNow\(\) - this\.liveSince >= REDIAL_NOW_AFTER_MS\) \{\s*this\.machine\.suspectRoute\(\);\s*this\.retryLater\(error, REDIAL_NOW_MS, true\);\s*return;\s*\}\s*this\.machine\.forgetRoute\(\);\s*this\.retryLater\(error\);/.test(transport),
      (streamSrc.match(/forgetRoute\(\)/g) ?? []).length,
      // What bounds the pace: a hello resets the attempt count, so only the while it had to be live keeps a daemon that greets and closes from a spin.
      Number(/const REDIAL_NOW_AFTER_MS = ([\d_]+);/.exec(streamSrc)?.[1]?.replaceAll("_", "") ?? "NaN") >= 5_000,
    ],
    [true, 1, true],
  );
  const abandon = body(machineSrc, /\n {2}abandonRoute\(absentSince: number\): void \{/);
  check("a wake closes what was dialled before the absence, and only that", /closeDialledBefore\(absentSince\)/.test(abandon) && !/closeChannel|dispose/.test(abandon), true);
  check(
    "having forgotten the route first, since a stream it closes reports a dead route at once",
    abandon.indexOf("this.chosen = null") !== -1 && abandon.indexOf("this.chosen = null") < abandon.indexOf("closeDialledBefore"),
    true,
  );
  const resume = body(storeSrc, /private async resumeMachine\([^)]*\): Promise<void> \{/);
  check("a resume is the one caller that abandons a route", (storeSrc.match(/abandonRoute\(/g) ?? []).length === 1 && /abandonRoute\(this\.absentSince\)/.test(resume), true);
  check("and nothing outside machine.ts abandons one", /abandonRoute/.test(streamSrc), false);
  const wake = body(storeSrc, /\n {2}wake\(reason: string, since: number \| null\): Promise<void> \{/);
  check("only a wake names the absence that may end a request", (storeSrc.match(/this\.absentSince = /g) ?? []).length === 1 && /this\.absentSince = raiseSuspicion\(this\.absentSince, since\)/.test(wake), true);
  const resumeSrc = read("../src/resume.ts");
  check("and wake detection is its one caller", [/store\.wake\(reason, reported\)/.test(resumeSrc), /store\.resume\(/.test(resumeSrc)], [true, false]);
  // The model above says the device's word and then wakes; these are the two handlers it stands in for.
  check(
    "the device's own word reaches the store from the two events that carry it: offline at once, and online before the wake it names",
    [
      /const onOffline = \(\): void => \{\s*clock\.offline\(monotonicNow\(\)\);\s*store\.noteDevice\(false\);\s*\};/.test(resumeSrc),
      /const onOnline = \(\): void => \{\s*store\.noteDevice\(true\);\s*wake\("online", clock\.online\(\)\);\s*\};/.test(resumeSrc),
      /window\.addEventListener\("offline", onOffline\);\s*window\.addEventListener\("online", onOnline\);/.test(resumeSrc),
      /window\.removeEventListener\("offline", onOffline\);\s*window\.removeEventListener\("online", onOnline\);/.test(resumeSrc),
    ],
    [true, true, true, true],
  );
  check(
    "and nothing else in the app says it",
    srcFiles().filter((rel) => /\bnoteDevice\(/.test(stripComments(srcFile(rel)))).sort(),
    ["resume.ts", "store.ts"],
  );

  const failed = /\.catch\(\(cause: unknown\) => \{([\s\S]*?)\}\)\s*\.finally/.exec(composerSrc.slice(composerSrc.indexOf("const flight: Promise<void>")))?.[1] ?? "";
  report("the composer's failed-send handler was found", failed.length > 200, `${String(failed.length)} chars`);
  // The statements themselves, from the handler's first: a negated test or a dropped return keeps every word in order.
  check(
    "a failed send is weighed against its own event before anything is given back",
    /^\s*if \(isTransportFailure\(cause\) && echoClaimed\(echo\)\) return;\s*clearEcho\(key, echo\);/.test(failed),
    true,
  );
  check(
    "and only a failure in transit is held in doubt, before the text and the chips go back",
    /clearEcho\(key, echo\);\s*if \(isTransportFailure\(cause\)\) doubtSend\(key, echo\);\s*if \(onScreen\(\)\) \{\s*update\(body\);\s*\} else if \(body\.length === 0\) \{\s*drafts\.delete\(key\);\s*\} else \{\s*drafts\.set\(key, body\);\s*\}\s*restoreAttachments\(key, sent\);/.test(failed),
    true,
  );
  // The model's own copy of this effect is what the schedules above ran; this is the one it stands in for.
  check(
    "a doubted send the log has since shown leaves the box, taken once, and only where the reader left it as sent",
    /const arrived = arrivedFor\(key\);\s*useEffect\(\(\) => \{\s*if \(arrived === null\) return;\s*takeArrived\(key, arrived\);\s*if \(\(drafts\.get\(key\) \?\? ""\) === arrived\.text\) \{\s*drafts\.delete\(key\);\s*setText\(""\);\s*\}\s*for \(const chip of attachmentsFor\(key\)\) \{[^}]*\}\s*toast\("ok", "That message did arrive\."\);\s*\}, \[arrived, key\]\);/.test(composerSrc),
    true,
  );

  const forgetSession = body(storeSrc, /private forgetSession\(key: SessionKey\): void \{/);
  check(
    "the conversation on screen stays wanted when forgotten, so its row coming back opens it again",
    /^\{\s*const onScreen = this\.streamOrder\.at\(-1\) === key;\s*this\.closeStream\(key\);\s*if \(onScreen && this\.streamOrder\.at\(-1\) !== key\) this\.streamOrder = \[\.\.\.this\.streamOrder, key\];\s*this\.rows\.delete\(key\);/.test(forgetSession),
    true,
  );
  const signedOut = body(storeSrc, /\n {2}handleSignedOut\(failure: AuthFailure\): void \{/);
  check("and a sign-out leaves nothing wanted", /this\.streamOrder = \[\]/.test(signedOut), true);
  const loadAll = body(storeSrc, /async loadAll\(ref: SessionRef\): Promise<void> \{/);
  check("history claims the echo too", /claimEcho\(key, block\)/.test(loadAll), true);
  const prime = body(storeSrc, /private async primeBlocked\(ref: SessionRef, snapshot: SessionSnapshot\): Promise<void> \{/);
  check(
    "and so does the page read for a session that waits on somebody, once that page is what is held",
    /this\.replaceTranscript\(key, \{[^}]*\}\);\s*claimEcho\(key, page\.events\);\s*this\.emit\(\);/.test(prime),
    true,
  );
  check("which makes three doors, and no fourth", (storeSrc.match(/\bclaimEcho\(key, /g) ?? []).length, 3);
}
