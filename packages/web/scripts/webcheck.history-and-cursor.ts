import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";
import {
  type Attach,
  attaches,
  machine,
  nextAttach,
  snapshot,
} from "./webcheck.ws.js";
import {
  ATTACH_REPLAY_MAX,
  HISTORY_PAGE,
  hugWidth,
  MAX_AUTO_HISTORY,
  MAX_HELD_TRANSCRIPTS,
  MAX_TRANSCRIPT_BYTES,
  fillWindow,
  gapPlan,
  loadStop,
  nextCut,
  reattachSince,
  sentText,
  type StoredEvent,
  VERBATIM_FIELD,
} from "./webcheck.modules.js";

process.stdout.write("\nwhere a re-attaching socket resumes\n");
{
  // The boundary is the daemon's ATTACH_REPLAY_MAX, the most attach will replay; asking for more silently gets less.
  check("the replay boundary is the daemon's ATTACH_REPLAY_MAX", ATTACH_REPLAY_MAX, 2_000);
  // The tab's event cap MAX_TRANSCRIPT_EVENTS is gone, so the conflation is guarded off source: only the daemon's bound may be read here.
  const reattachBody = /export function reattachSince\([\s\S]*?\n\}/.exec(
    readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"),
  )?.[0] ?? "";
  check("and it is the only bound that function reads", /ATTACH_REPLAY_MAX/.test(reattachBody), true);
  check(
    "with no tab ceiling anywhere near it",
    /MAX_TRANSCRIPT/.test(reattachBody.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")),
    false,
  );

  check(
    "a lag of exactly ATTACH_REPLAY_MAX replays down the socket",
    reattachSince(1_000, 1_000 + ATTACH_REPLAY_MAX),
    { since: 1_000, keepHeld: true },
  );
  check(
    "one more than it drops what is held and restarts at the tail",
    reattachSince(1_000, 1_000 + ATTACH_REPLAY_MAX + 1),
    { since: 1_000 + ATTACH_REPLAY_MAX + 1, keepHeld: false },
  );
  check(
    "a lag between the two numbers restarts, it does not replay",
    reattachSince(1_000, 6_000),
    { since: 6_000, keepHeld: false },
  );

  check("a small lag replays exactly the hole", reattachSince(700, 900), { since: 700, keepHeld: true });
  check("nothing missed attaches at the tail and keeps what is held", reattachSince(900, 900), {
    since: 900,
    keepHeld: true,
  });
  // The row can be a poll old, so holding more is ordinary; the answer must be the held tail or the overlap is appended twice.
  check("holding more than the row reports keeps it too", reattachSince(901, 900), { since: 901, keepHeld: true });
  check(
    "keeping the transcript always attaches at its own tail",
    (
      [
        [700, 900],
        [900, 900],
        [901, 900],
        [1_000, 1_000 + ATTACH_REPLAY_MAX],
      ] as const
    ).map(([held, daemon]) => {
      const plan = reattachSince(held, daemon);
      return plan.keepHeld ? plan.since : "dropped";
    }),
    [700, 900, 901, 1_000],
  );

  check("nothing held at all restarts from the tail", reattachSince(null, 900), { since: 900, keepHeld: false });
  check("and on a session with no events yet, that is seq 0", reattachSince(null, 0), { since: 0, keepHeld: false });
}

// End to end: openSession must seed the socket with what reattachSince answers; the private maps are written through a cast.

process.stdout.write("\nwhere a re-opened session's socket is seeded\n");
{
  const { store } = await import("../src/store.js");
  const { keyOf, machineId, sessionId } = await import("../src/ids.js");

  const ref = { machineId: machineId("m_1"), sessionId: sessionId("s_1") };
  const key = keyOf(ref);
  const held = (seq: number): unknown => ({
    seq,
    ts: seq,
    event: { type: "text", role: "assistant", thought: false, text: `#${seq} ` },
  });

  const connection = {
    ...machine,
    state: () => ({
      id: "m_1",
      name: "alpha",
      relayUrl: null,
      relayOnline: true,
      enrolled: true,
      owned: true,
      scopes: [],
      route: null,
      reach: "online",
      offlineReason: null,
      tokenDegraded: false,
      tokenExpiresAt: null,
      health: null,
      lastError: null,
    }),
  };

  const internals = store as unknown as {
    connections: Map<string, unknown>;
    rows: Map<string, unknown>;
    transcripts: Map<string, unknown>;
  };
  internals.connections.set("m_1", connection);

  /** Seed a session holding `heldSeqs`, on a row the poll last saw at `rowLast`. */
  const openWith = async (heldSeqs: number[], rowLast: number): Promise<Attach> => {
    internals.rows.set(key, {
      key,
      ref,
      machineName: "alpha",
      snapshot: { ...snapshot, id: "s_1", lastSeq: rowLast },
      daemonNow: 0,
      fetchedAt: 0,
    });
    internals.transcripts.set(key, {
      events: heldSeqs.map(held),
      gaps: [],
      loadedFrom: heldSeqs[0] ?? 0,
      daemonFirstSeq: 1,
      clearedAt: null,
      loadingHistory: false,
      stream: null,
    });
    attaches.length = 0;
    store.openSession(ref);
    const attach = await nextAttach(1);
    // onVanished stops the stream and drops the row and transcript, so the next case starts clean.
    store.onVanished(ref);
    return attach;
  };

  check("a socket asks from the held tail, not from the row the poll left behind", (await openWith([899, 900, 901], 900)).since, 901);
  check("and from the replay point when the daemon is the one ahead", (await openWith([690, 700], 900)).since, 700);
  check("with nothing held it starts at the row", (await openWith([], 900)).since, 900);

  internals.connections.delete("m_1");
}

process.stdout.write("\nthe whole conversation arrives without being asked for\n");
{
  // daemons is a private map: a duck-typed stub is injected, and only events is called on this path.
  const { store } = await import("../src/store.js");
  const { keyOf, machineId, sessionId } = await import("../src/ids.js");

  const ref = { machineId: machineId("m_2"), sessionId: sessionId("s_2") };
  const key = keyOf(ref);
  const ev = (seq: number): unknown => ({
    seq,
    ts: seq,
    event: { type: "text", role: "agent", thought: false, text: `#${seq}` },
  });
  const spanOf = (block: readonly { seq: number }[]): string => {
    if (block.length === 0) return "empty";
    for (let i = 1; i < block.length; i += 1) {
      if (block[i]!.seq !== block[i - 1]!.seq + 1) return `broken at ${block[i - 1]!.seq}→${block[i]!.seq}`;
    }
    return `${block[0]!.seq}..${block[block.length - 1]!.seq}`;
  };

  const internals = store as unknown as {
    daemons: Map<string, unknown>;
    transcripts: Map<string, unknown>;
  };

  /** A daemon holding seqs 1..`total`, optionally dropping the `failAt`-th request. */
  const daemonHolding = (total: number, failAt = -1): { events: unknown; asked: () => number } => {
    let asked = 0;
    return {
      asked: () => asked,
      events: async (_id: string, since: number, limit: number) => {
        asked += 1;
        if (asked === failAt) throw new TypeError("Failed to fetch");
        const out: unknown[] = [];
        for (let seq = since + 1; seq <= Math.min(since + limit, total); seq += 1) out.push(ev(seq));
        return { events: out, firstSeq: 1 };
      },
    };
  };

  const seed = (total: number): void => {
    internals.transcripts.set(key, {
      events: [],
      gaps: [],
      loadedFrom: total + 1,
      daemonFirstSeq: 1,
      clearedAt: null,
      loadingHistory: false,
      stream: null,
    });
  };
  const held = (): { events: { seq: number }[]; loadedFrom: number } =>
    internals.transcripts.get(key) as { events: { seq: number }[]; loadedFrom: number };

  {
    // One call must reach seq 1; MAX_AUTO_HISTORY is only where the loop yields the main thread.
    const stub = daemonHolding(7_000);
    internals.daemons.set("m_2", stub);
    seed(7_000);
    await store.loadAll(ref);
    check("a conversation past the old budget loads in one call", held().loadedFrom, 1);
    check("and every event of it is there, in one run", spanOf(held().events), "1..7000");
    check("in one request per window", stub.asked(), Math.ceil(7_000 / HISTORY_PAGE));
  }

  {
    const stub = daemonHolding(1_200, 2);
    internals.daemons.set("m_2", stub);
    seed(1_200);
    await store.loadAll(ref);
    check("a dropped page does not end the conversation", held().loadedFrom, 1);
    check("and what arrives is still one contiguous run", spanOf(held().events), "1..1200");
  }

  internals.daemons.delete("m_2");
  internals.transcripts.delete(key);
}

process.stdout.write("\nhow many conversations a tab keeps\n");
{
  // MAX_TRANSCRIPT_BYTES bounds one conversation, MAX_HELD_TRANSCRIPTS how many; one with a live stream is never evicted.
  const { store } = await import("../src/store.js");
  const internals = store as unknown as {
    transcripts: Map<string, unknown>;
    streams: Map<string, unknown>;
    replaceTranscript: (key: string, next: unknown) => void;
    streamOrder: string[];
  };
  const before = new Set(internals.transcripts.keys());

  const seed = (key: string): void =>
    internals.replaceTranscript(key, {
      events: [],
      gaps: [],
      heldBytes: 0,
      loadedFrom: 1,
      daemonFirstSeq: null,
      clearedAt: null,
      loadingHistory: false,
      unfetched: 0,
    });

  // Pinned well before the cap, so eviction has to walk past it.
  internals.streams.set("m/keep", {});
  internals.streamOrder.push("m/keep");
  seed("m/keep");
  for (let i = 0; i < 40; i += 1) seed(`m/s${i}`);

  report(
    "a tab holds a bounded number of conversations",
    internals.transcripts.size <= MAX_HELD_TRANSCRIPTS,
    `${internals.transcripts.size} held after 41 opened, cap ${MAX_HELD_TRANSCRIPTS}`,
  );
  check("and the one with a live stream is never the one dropped", internals.transcripts.has("m/keep"), true);
  // m/s39 is the just argument trimTranscripts always keeps; m/s38 and m/s0 pin the policy: newest kept, oldest gone.
  check("while the most recently arrived at is still there", internals.transcripts.has("m/s38"), true);
  check("and the one arrived at longest ago is what went", internals.transcripts.has("m/s0"), false);

  for (const key of [...internals.transcripts.keys()]) if (!before.has(key)) internals.transcripts.delete(key);
  internals.streams.delete("m/keep");
  internals.streamOrder.splice(internals.streamOrder.indexOf("m/keep"), 1);
}

process.stdout.write("\nwhat a lagged frame means for the transcript\n");
{
  // backlog is attach declining to replay events still on disk, so it restarts at the far side rather than drawing a hole.
  check("a backlog frame is refetched from its far side, not drawn as a hole", gapPlan("backlog", 4_000), {
    kind: "restart",
    loadedFrom: 4_001,
  });
  check("retention having destroyed events is a real hole", gapPlan("evicted", 4_000), {
    kind: "record",
    reason: "evicted",
  });
  check("and so is this client having failed to keep up", gapPlan("slow_consumer", 4_000), {
    kind: "record",
    reason: "slow_consumer",
  });
}

process.stdout.write("\none window of history, filled forwards\n");
{
  // A byte-capped page keeps its oldest events and drops its newest, so a window is filled forwards from the last seq received (Q6.104).
  const ev = (seq: number): StoredEvent => ({
    seq,
    ts: seq * 1_000,
    event: { type: "text", role: "agent", thought: false, text: `#${seq}` },
  });
  const run = (from: number, to: number): StoredEvent[] => {
    const out: StoredEvent[] = [];
    for (let seq = from; seq <= to; seq += 1) out.push(ev(seq));
    return out;
  };
  const spanOf = (block: readonly StoredEvent[]): string => {
    if (block.length === 0) return "empty";
    for (let i = 1; i < block.length; i += 1) {
      const prev = block[i - 1]!.seq;
      const here = block[i]!.seq;
      if (here !== prev + 1) return `broken at ${prev}→${here}`;
    }
    return `${block[0]!.seq}..${block[block.length - 1]!.seq}`;
  };

  // Derived from HISTORY_PAGE so the expectations survive the page size moving; two pages up gives a real floor above 1.
  const loadedFrom = HISTORY_PAGE * 2 + 1;
  const windowFloor = HISTORY_PAGE + 1;
  const windowTop = HISTORY_PAGE * 2;
  const wholeWindow = `${windowFloor}..${windowTop}`;

  {
    const asked: number[] = [];
    const full = async (since: number): Promise<{ events: StoredEvent[]; firstSeq: number }> => {
      asked.push(since);
      return { events: run(since + 1, since + HISTORY_PAGE), firstSeq: 12 };
    };
    const window = await fillWindow(full, loadedFrom, MAX_AUTO_HISTORY);
    check("a full page closes the window in one request", [asked, window.closed], [[HISTORY_PAGE], true]);
    check("and the block is one run", spanOf(window.block), wholeWindow);
    check("which ends exactly where the held window begins", window.block.at(-1)!.seq + 1, loadedFrom);
    check("the floor the daemon reported comes back with it", window.firstSeq, 12);
    check("and the budget is spent by what was taken", window.fetched, HISTORY_PAGE);
  }

  {
    // One capped page must not close the window; asking forward from the last seq must close it contiguously.
    const asked: number[] = [];
    const capped = async (since: number): Promise<{ events: StoredEvent[]; firstSeq: number }> => {
      asked.push(since);
      return { events: run(since + 1, since + 20), firstSeq: 7 };
    };

    const one = await fillWindow(capped, loadedFrom, 20);
    check("one byte-capped page does not close the window", one.closed, false);
    check("and what it brought is the oldest end of it", spanOf(one.block), `${windowFloor}..${windowFloor + 19}`);

    asked.length = 0;
    const all = await fillWindow(capped, loadedFrom, MAX_AUTO_HISTORY);
    check("asking forward from the last seq received closes it", all.closed, true);
    check("the committed block is one run", spanOf(all.block), wholeWindow);
    check("contiguous with the held window, which is the property that failed", all.block.at(-1)!.seq + 1, loadedFrom);
    check(
      "in one request per capped page, each from the last seq it received",
      [asked.length, asked[0], asked.at(-1)],
      [HISTORY_PAGE / 20, HISTORY_PAGE, windowTop - 20],
    );
  }

  {
    // The escape at 50 turns a spin into a red line rather than a hung driver.
    let asked = 0;
    const stuck = async (): Promise<{ events: StoredEvent[]; firstSeq: number }> => {
      asked += 1;
      if (asked > 50) return { events: run(loadedFrom - 1, loadedFrom - 1), firstSeq: 900 };
      // Below the window's floor, so every one of them is filtered out.
      return { events: [ev(400)], firstSeq: 900 };
    };
    const window = await fillWindow(stuck, loadedFrom, MAX_AUTO_HISTORY);
    check("nothing usable ends the window at once, with no spin", [asked, window.closed], [1, false]);
    check("and brings nothing back to commit", window.block, []);
    check("the floor it reported is still worth keeping", window.firstSeq, 900);
  }

  {
    const asked: number[] = [];
    const capped = async (since: number): Promise<{ events: StoredEvent[]; firstSeq: number }> => {
      asked.push(since);
      return { events: run(since + 1, since + 20), firstSeq: 7 };
    };
    const window = await fillWindow(capped, loadedFrom, 60);
    check("the budget bounds requests within one window", [asked.length, window.fetched], [3, 60]);
    check("and an unfinished window is not closed", window.closed, false);
  }

  {
    // null rather than 0: EventList would draw a floor of 0 as the start of the conversation being gone.
    let asked = 0;
    const never = async (): Promise<{ events: StoredEvent[]; firstSeq: number }> => {
      asked += 1;
      return { events: [], firstSeq: 0 };
    };
    const window = await fillWindow(never, loadedFrom, 0);
    check("no budget asks nothing", asked, 0);
    check("and reports no floor rather than a floor of zero", window.firstSeq, null);
  }

  {
    // A window spans exactly HISTORY_PAGE seqs, so a budget of one page can never end one; loadAll passes exactly that.
    const full = async (since: number): Promise<{ events: StoredEvent[]; firstSeq: number }> => ({
      events: run(since + 1, since + HISTORY_PAGE),
      firstSeq: 12,
    });
    const capped = async (since: number): Promise<{ events: StoredEvent[]; firstSeq: number }> => ({
      events: run(since + 1, since + 20),
      firstSeq: 12,
    });
    const one = await fillWindow(full, loadedFrom, HISTORY_PAGE);
    const many = await fillWindow(capped, loadedFrom, HISTORY_PAGE);
    check("a budget of one page closes a window served whole", [one.closed, spanOf(one.block)], [true, wholeWindow]);
    check("and one served twenty at a time", [many.closed, spanOf(many.block)], [true, wholeWindow]);
    check("neither can exceed it, which is why it can never bind", [
      one.fetched <= HISTORY_PAGE,
      many.fetched <= HISTORY_PAGE,
    ], [true, true]);
  }
}

process.stdout.write("\nwhen the loader stops paging\n");
{
  const st = (over: {
    loadedFrom?: number;
    daemonFirstSeq?: number;
    clearedAt?: number | null;
    heldEvents?: number;
    heldBytes?: number;
  }): {
    loadedFrom: number;
    daemonFirstSeq: number;
    clearedAt: number | null;
    heldEvents: number;
    heldBytes: number;
  } => ({
    loadedFrom: 500,
    daemonFirstSeq: 0,
    clearedAt: null as number | null,
    heldEvents: 10,
    heldBytes: 1_000,
    ...over,
  });

  check("an ordinary window carries on", loadStop(st({})), null);
  check("the start of the log ends it", loadStop(st({ loadedFrom: 1 })), "start_of_log");
  check("the agent's own cut ends it", loadStop(st({ clearedAt: 400 })), "cleared");
  check(
    "with no way to ask past it, whatever else is true",
    [
      loadStop(st({ clearedAt: 400, heldEvents: 500_000 })),
      loadStop(st({ clearedAt: 1, loadedFrom: 500 })),
    ],
    ["cleared", "cleared"],
  );
  // The daemon's floor stops the per-poll re-drive; clamped to 1, since daemonFirstSeq 0 means no page has answered yet.
  check("the daemon's floor is the start of the log too", loadStop(st({ loadedFrom: 6145, daemonFirstSeq: 6145 })), "start_of_log");
  check("one event above it carries on", loadStop(st({ loadedFrom: 6146, daemonFirstSeq: 6145 })), null);
  check("and an unknown floor behaves as seq 1, not as done", [
    loadStop(st({ loadedFrom: 1, daemonFirstSeq: 0 })),
    loadStop(st({ loadedFrom: 2, daemonFirstSeq: 0 })),
  ], ["start_of_log", null]);
  // The only ceiling is bytes: an event count beside it would be the one that decides.
  check("the tab's own ceiling ends it", loadStop(st({ heldBytes: MAX_TRANSCRIPT_BYTES })), "held_full");
  check("one byte short of that does not", loadStop(st({ heldBytes: MAX_TRANSCRIPT_BYTES - 1 })), null);
  check(
    "and no number of events ends it by itself",
    loadStop(st({ heldEvents: 500_000, heldBytes: 4.53 * 1024 * 1024 })),
    null,
  );

  check(
    "the start of the log outranks everything",
    loadStop(st({ loadedFrom: 1, clearedAt: 400, heldBytes: MAX_TRANSCRIPT_BYTES })),
    "start_of_log",
  );
  check(
    "and a cut outranks the tab's own ceiling",
    loadStop(st({ clearedAt: 400, heldBytes: MAX_TRANSCRIPT_BYTES })),
    "cleared",
  );

  process.stdout.write("\na transcript missing its beginning says so\n");
  {
    // While history is outstanding and no cut is in force, the transcript must say something.
    const { transcriptNotice } = await import("../src/store.js");
    const ns = (over: {
      loadedFrom?: number;
      daemonFirstSeq?: number;
      clearedAt?: number | null;
      loadingHistory?: boolean;
      heldEvents?: number;
      heldBytes?: number;
      rows?: number;
    }): Parameters<typeof transcriptNotice>[0] => ({
      loadedFrom: 1_357,
      daemonFirstSeq: 1,
      clearedAt: null as number | null,
      loadingHistory: false,
      heldEvents: 1_500,
      heldBytes: 200_000,
      rows: 9,
      ...over,
    });

    check("a run still paging says it is loading, with the count", transcriptNotice(ns({ loadingHistory: true })), {
      kind: "loading",
      earlier: 1_356,
    });
    check("a run that gave up says it has not arrived, and that it retries", transcriptNotice(ns({})), {
      kind: "stalled",
      earlier: 1_356,
    });

    check("nothing arrived yet is the skeleton", transcriptNotice(ns({ rows: 0 })), { kind: "skeleton" });
    check(
      "the tab's own ceiling outranks both, because that is why paging stopped",
      transcriptNotice(ns({ heldEvents: 120_000, heldBytes: MAX_TRANSCRIPT_BYTES, loadingHistory: true })),
      { kind: "ceiling", held: 120_000 },
    );
    check(
      "a few heavy events stop it as readily as many light ones",
      transcriptNotice(ns({ heldEvents: 130, heldBytes: MAX_TRANSCRIPT_BYTES })),
      { kind: "ceiling", held: 130 },
    );
    check(
      "and the fleet's largest conversation reaches the ceiling at no count",
      loadStop(st({ loadedFrom: 2, heldEvents: 33_898, heldBytes: 4.53 * 1024 * 1024 })),
      null,
    );
    check(
      "a destroyed prefix is reported once paging has reached the floor",
      transcriptNotice(ns({ loadedFrom: 6_145, daemonFirstSeq: 6_145 })),
      { kind: "floor", destroyed: 6_144 },
    );
    check(
      "an empty log says so, and only with nothing outstanding and nothing on screen",
      transcriptNotice(ns({ loadedFrom: 1, daemonFirstSeq: 0, heldEvents: 0, rows: 0 })),
      { kind: "empty" },
    );
    check(
      "a whole conversation on screen says nothing at all",
      transcriptNotice(ns({ loadedFrom: 1, daemonFirstSeq: 1, heldEvents: 2_856, rows: 14 })),
      null,
    );
    check(
      "and a cut says nothing, because the marker row is the thing to read",
      transcriptNotice(ns({ clearedAt: 900 })),
      null,
    );

    // null is allowed only for a cut in force or nothing left to fetch.
    let silent = 0;
    let states = 0;
    for (const loadedFrom of [1, 2, 357, 1_357, 6_145]) {
      for (const daemonFirstSeq of [0, 1, 6_145]) {
        for (const clearedAt of [null, 900]) {
          for (const loadingHistory of [false, true]) {
            for (const [heldEvents, heldBytes] of [
              [0, 0],
              [1_500, 200_000],
              [120_000, MAX_TRANSCRIPT_BYTES],
            ] as const) {
              for (const rows of [0, 9]) {
                const state = ns({
                  loadedFrom,
                  daemonFirstSeq,
                  clearedAt,
                  loadingHistory,
                  heldEvents,
                  heldBytes,
                  rows,
                });
                states += 1;
                const answer = transcriptNotice(state);
                const cutInForce = clearedAt !== null;
                const outstanding = loadedFrom > Math.max(1, daemonFirstSeq);
                if (answer === null && !cutInForce && outstanding) silent += 1;
                // With nothing outstanding, null is allowed only with rows on screen.
                if (answer === null && !cutInForce && !outstanding && rows === 0) silent += 1;
              }
            }
          }
        }
      }
    }
    // The count rides the assertion so a shrunk grid cannot pass by covering less.
    check("no state with history outstanding is drawn silently", { states, silent }, { states: 360, silent: 0 });

    const willing = ns({ loadingHistory: false });
    check("while paging is willing, something is always said", [
      loadStop(willing) === null,
      transcriptNotice(willing) !== null,
    ], [true, true]);
  }
}

process.stdout.write("\na page that fails is retried long enough for a daemon to redial\n");
{
  const { historyRetry, HISTORY_RETRY_MS } = await import("../src/store.js");
  const { ApiError, meansLater } = await import("../src/http.js");
  const dropped = new TypeError("Failed to fetch");

  check("a dropped request is retried five times and then given up on", [
    historyRetry(0, dropped),
    historyRetry(1, dropped),
    historyRetry(2, dropped),
    historyRetry(3, dropped),
    historyRetry(4, dropped),
    historyRetry(5, dropped),
  ], [500, 2_000, 5_000, 10_000, 20_000, null]);

  check(
    "and the whole schedule outlasts the daemon's 30s reconnect cap",
    HISTORY_RETRY_MS.reduce((sum, ms) => sum + ms, 0) >= 30_000,
    true,
  );

  // Retry only refusals that mean later; a state only somebody else can change would loop with loadingHistory latched.
  check("a relay with no tunnel is retried, because the daemon is redialling", [
    historyRetry(0, new ApiError(503, "no_tunnel", "no daemon")),
    historyRetry(0, new ApiError(503, "unreachable", "not reachable")),
    historyRetry(0, new ApiError(502, "tunnel_failed", "the tunnel failed mid-request")),
  ], [500, 500, 500]);

  check("a session that is gone is not", historyRetry(0, new ApiError(404, "not_found", "no such session")), null);
  check(
    "nor a machine over its owner's limit — an admin has to act",
    historyRetry(0, new ApiError(403, "machine_over_limit", "over the limit")),
    null,
  );
  check(
    "nor one whose owner is banned",
    historyRetry(0, new ApiError(403, "owner_disabled", "owner disabled")),
    null,
  );

  check("meansLater is about answers only", [meansLater(dropped), meansLater(null), meansLater("nope")], [
    false,
    false,
    false,
  ]);
}

process.stdout.write("\na session with no row yet is loading, not missing\n");
{
  // The view mounts before the session list exists, so only an online, listed machine may report a session absent.
  const { missingRowReason } = await import("../src/machine.js");

  check("no machine at all is the grant being gone", [
    missingRowReason(null, false),
    missingRowReason(null, true),
  ], ["no_machine", "no_machine"]);
  check("an unprobed machine is loading", [
    missingRowReason("unknown", false),
    missingRowReason("unknown", true),
    missingRowReason("probing", false),
    missingRowReason("probing", true),
  ], ["loading", "loading", "loading", "loading"]);
  check("a machine that answered no route is unreachable", [
    missingRowReason("offline", false),
    missingRowReason("offline", true),
  ], ["unreachable", "unreachable"]);
  check("online but never listed is still loading", missingRowReason("online", false), "loading");
  check("online and listed is the only absence anybody may report", missingRowReason("online", true), "not_here");
}

process.stdout.write("\nhistory loads itself, and nothing asks the reader to retry\n");
{
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const eventList = strip(readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8"));
  const sessionView = strip(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
  const storeSrc = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));

  check("the transcript offers no retry", /did not load/.test(eventList), false);
  check("and carries no prop for one", /onLoadEarlier/.test(eventList), false);
  check("nor does the view pass one", /onLoadEarlier/.test(sessionView), false);

  check("real retention loss still says so", /the start of this conversation is gone/.test(eventList), true);
  check("nothing offers the conversation from before a /clear", /from before \/clear/.test(eventList), false);
  check("and no view wires a reveal", [/onReveal/.test(eventList), /revealBeforeClear/.test(sessionView)], [false, false]);
  check("nor does the store hold a flag for one", /revealedBeforeClear/.test(storeSrc), false);
  check("the marker draws the command that caused it", /<UserBubble text="\/clear" \/>/.test(eventList), true);
  check("and says the context was cleared", /Context cleared/.test(eventList), true);
  check("and no longer claims anything is above it", /forgotten everything above/.test(eventList), false);

  // Only the inner content is selectable: WebKit paints a selectable block's padding, so select-text on the padded box does nothing.
  const bubble = strip(readFileSync(new URL("../src/ui/Bubble.tsx", import.meta.url), "utf8"));
  const bubbleRow = /className="my-4 flex justify-end[^"]*"/.exec(bubble)?.[0] ?? "";
  const bubbleBox = /className="[^"]*\bml-auto w-fit[^"]*"/.exec(bubble)?.[0] ?? "";
  check("the user's bubble and the row it sits on were both found", [bubbleRow !== "", bubbleBox !== ""], [true, true]);
  check(
    "neither the row nor the padded box is selectable",
    [/\bselect-none\b/.test(bubbleRow), /\bselect-none\b/.test(bubbleBox)],
    [true, true],
  );
  check("and the padding is not inside what is selectable", /\bselect-text\b/.test(bubbleBox), false);
  check("while something inside it is", /className="select-text\b/.test(bubble), true);

  // sel-root makes each block a WebKit selection root so selection gaps are not painted; a flex container between puts the fill back (Q3.638).
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const selRoot = /\n\.sel-root[^{]*\{[^}]*\}/.exec(css)?.[0] ?? "";
  check("a rule makes a block its own selection root", selRoot !== "", true);
  // column-span, not a transform: a transform adds a stacking context that shifts table borders.
  check("with a property that makes no stacking context", /column-span:\s*all/.test(selRoot), true);
  check("and not with a transform", /transform/.test(selRoot), false);
  // pre, td and th need the rule themselves: nothing above the cells substitutes.
  check(
    "and the three shapes it cannot reach from above name themselves",
    ["pre", "td", "th"].filter((tag) => !new RegExp(`\\.sel-root ${tag}\\b`).test(selRoot)),
    [],
  );
  const markdown = strip(readFileSync(new URL("../src/ui/Markdown.tsx", import.meta.url), "utf8"));
  check("every markdown body is one", /className=\{`sel-root text-sm wrap-anywhere/.test(markdown), true);
  check("so is the bubble, which hangs in a flex row", /\bsel-root\b/.test(bubbleBox), true);
  check("and so is the column, which owns the space between messages", /className=\{`sel-root \$\{COLUMN\}/.test(eventList), true);
  check("and the zero-width space it replaced is not still there", /content: "\\200B"/.test(strip(css)), false);

  // CSS fit-content cannot hug wrapped text, so the width is computed from the line rects.
  check("a bubble is as wide as its longest line plus its chrome", hugWidth([120, 300.2, 80], 28), 329);
  check("and the rounding is up, never down", hugWidth([300.05], 0), 301);
  // Round up: a sub-pixel short re-wraps the text and walks the box narrower each pass.
  check("nothing to measure leaves the box alone", [hugWidth([], 28), hugWidth([0, 0], 28), hugWidth([100], -1)], [null, null, null]);

  const hug = strip(readFileSync(new URL("../src/ui/hug.ts", import.meta.url), "utf8"));
  // Reset, measure all, then write all: interleaving forces a layout per bubble.
  check("every box is reset before any is measured", /bubble\.style\.width = "";[\s\S]*boxes\.push/.test(hug), true);
  check("and every width is computed before any is written", /const widths = boxes\.map[\s\S]*boxes\.forEach/.test(hug), true);
  check("there is one observer and it is shared", (hug.match(/new ResizeObserver/g) ?? []).length, 1);
  check("and it watches the row rather than the bubble", /observer\.observe\(row\)/.test(hug), true);
  // Measured per text node: a range over the wrapper also returns the wrapper's own box.
  check("lines are walked as text nodes", /SHOW_TEXT/.test(hug), true);
  check("and no range is taken over the wrapper itself", /selectNodeContents\(inner\)/.test(hug), false);

  check("a conversation still arriving is drawn as one", /<TranscriptSkeleton \/>/.test(eventList), true);
  check("and so is a session whose row has not landed", /<TranscriptSkeleton \/>/.test(sessionView), true);

  check("a window is never given a budget that can cut it short", /MAX_AUTO_HISTORY - fetched/.test(storeSrc), false);
  check("and no stop is spelled `budget` any more", /return "budget"/.test(storeSrc), false);

  // attachWanted runs on every session listing, poll and wake, which is what re-drives a run that gave up.
  const attachWanted = /private attachWanted\(id: MachineId\): void \{[\s\S]*?\n  \}/.exec(storeSrc)?.[0] ?? "";
  check("an open session's history is re-driven on every list", /loadAll/.test(attachWanted), true);

  // EventList must ask transcriptNotice rather than re-derive the rule into booleans of its own.
  check("the transcript asks for its notice rather than deriving one", /transcriptNotice\(\{/.test(eventList), true);
  check("and computes no `unfetched` of its own", /unfetched\s*=/.test(eventList), false);
  check("nor keeps the booleans it replaced", /showFloor|atCeiling|awaitingHistory/.test(eventList), false);

  const liveRegion = /role="status"[\s\S]{0,200}?<\/p>/.exec(eventList)?.[0] ?? "";
  check("the live region says whatever the notice says", /noticeSays/.test(liveRegion), true);
  check("and is no longer gated on the skeleton's own condition", /awaitingHistory/.test(liveRegion), false);
  // One visible line since both arms sit above the rows (Q3.423); it and the live region share one string.
  check(
    "the visible line reads the same string as the live region",
    (eventList.match(/\{noticeSays\}/g) ?? []).length >= 1,
    true,
  );
}

process.stdout.write("\na person's message, exactly as they sent it\n");
{
  // Drawn, never parsed: `1)` stays text rather than a list marker nobody can select, `**x**` stays asterisks (Q3.646).
  const bubble = stripComments(srcFile("ui/Bubble.tsx"));
  const drawn = /<div className="([^"]*)">\{text\}<\/div>/.exec(bubble)?.[1] ?? "";
  check("the bubble draws the text itself, as one node", drawn !== "", true);
  check(
    "keeping every space and line break, and wrapping a long token",
    ["select-text", "whitespace-pre-wrap", "wrap-anywhere"].filter((name) => !drawn.split(" ").includes(name)),
    [],
  );
  check("and hands nothing to the markdown renderer", [/from "\.\/Markdown"/.test(bubble), /<Markdown\b/.test(bubble)], [false, false]);
  check("which has no tone for a person any more", /"user"/.test(stripComments(srcFile("ui/Markdown.tsx"))), false);

  const events = stripComments(srcFile("ui/EventList.tsx"));
  check(
    "every place a person's words are drawn is that bubble",
    [
      /<UserBubble text=\{echo\.text\}/.test(events),
      /<UserBubble\s+text=\{event\.text\}/.test(events),
      /role === "user"\) return <UserBubble text=\{text\} \/>/.test(events),
    ],
    [true, true, true],
  );
  check(
    "and a typed answer to a question keeps its line breaks too",
    (events.match(/className="whitespace-pre-wrap wrap-anywhere">\{answer\.value\}/g) ?? []).length +
      (/className="whitespace-pre-wrap wrap-anywhere">\s*\{answers\.length > 1/.test(events) ? 1 : 0),
    2,
  );

  // Blank lines around a message and whitespace after it are not content; the first line's indentation is (Q3.646).
  check("an indented first line keeps its indentation", sentText("  indented\n    more"), "  indented\n    more");
  check("the blank lines around a message go", sentText("\n \t\r\n  code\n\n"), "  code");
  check("and so does whitespace after it", sentText("hello   "), "hello");
  check("but not the blank lines inside it", sentText("a\n\n\nb"), "a\n\n\nb");
  check("whitespace alone is nothing", sentText(" \n\t "), "");
  const typed = "\u201Cquoted\u201D \u00ABёлки\u00BB \"straight\" it's -- --flag \u2014 1) one\n2) two **bold** `x`";
  check("and no character is ever normalised", sentText(typed), typed);
  const composer = stripComments(srcFile("ui/Composer.tsx"));
  check("the composer sends that", [/send\(sentText\(text\), false\)/.test(composer), /send\(text\.trim\(\)/.test(composer)], [true, false]);

  // The input never rewrites a keystroke: in WebKit, smart quotes, dashes and text replacements sit behind `spellcheck` (Q3.647).
  check("the fields an agent reads opt out of both", VERBATIM_FIELD, { spellCheck: false, autoCorrect: "off" });
  const textareas = srcFiles()
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) =>
      stripComments(srcFile(file))
        .split("<textarea")
        .slice(1)
        .map((tail) => ({ file, opts: /^\s[^]*?\{\.\.\.VERBATIM_FIELD\}/.test(tail.slice(0, 120)) })),
    );
  check("every textarea there is was found", textareas.length >= 2, true);
  check("and every one of them opts out", textareas.filter((one) => !one.opts).map((one) => one.file), []);
  const card = stripComments(srcFile("ui/ElicitationCard.tsx"));
  const own = (card.match(/placeholder="Type your own answer here"/g) ?? []).length;
  // Two: one component draws every typed answer, as lines or as one line (Q3.652).
  check("every free-text answer on the ask card was found", own >= 2, true);
  check("and opts out as the composer does", (card.match(/\{\.\.\.VERBATIM_FIELD\}/g) ?? []).length, own);
}

process.stdout.write("\na /clear arriving down the socket\n");
{
  // onEvents runs the loader's cut rule; the newest marker in a batch wins.
  const ev = (seq: number): StoredEvent => ({
    seq,
    ts: seq,
    event: { type: "text", role: "agent", thought: false, text: `#${seq}` },
  });
  const cut = (seq: number): StoredEvent => ({
    seq,
    ts: seq,
    event: { type: "context_cleared", agentSessionId: `a${seq}`, previousAgentSessionId: `a${seq - 1}` },
  });

  check("a batch with no marker changes nothing", nextCut(7, [ev(8), ev(9)]), 7);
  check("an empty batch changes nothing either", nextCut(7, []), 7);
  check("a marker moves the cut", nextCut(7, [ev(8), cut(9)]), 9);
  check("the newest marker in a batch wins", nextCut(null, [cut(3), ev(4), cut(5)]), 5);
  // Last, not highest: Math.max agrees with every case above and fails this one.
  check("what the batch last said decides, rather than the largest seq in it", nextCut(9, [cut(5)]), 5);
}
