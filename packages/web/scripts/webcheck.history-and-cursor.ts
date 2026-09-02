import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
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
  MAX_AUTO_HISTORY,
  MAX_HELD_TRANSCRIPTS,
  MAX_TRANSCRIPT_BYTES,
  fillWindow,
  gapPlan,
  loadStop,
  nextCut,
  reattachSince,
  type StoredEvent,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * Where a transcript is joined
 *
 * The five sections below are one subject: **a transcript that looks contiguous
 * and is not.** Every rule here decides where two runs of events are spliced
 * together, and each of them was, or could be, wrong in the same silent way — a
 * reader cannot tell a conversation with its middle removed from a conversation
 * that was always that short, and nothing on screen says which they are looking
 * at.
 *
 * Two of these shipped. The `openSession` boundary read the tab's own window
 * (20 000) instead of the daemon's replay cap (2 000), so every lag in between
 * asked the socket to replay a hole it would never fill; and `loadAll` anchored
 * `loadedFrom` on a page's *first* event while a byte-capped page keeps its
 * oldest and drops its newest, which spliced the page's last event onto the held
 * window and lost everything between. Both were reachable from an ordinary
 * session open, and neither drew a `Gap`, a marker, or anything else.
 *
 * They were unassertable because they lived in methods on `AppStore`, which this
 * driver cannot construct — there is no control plane, no daemon and no DOM. So
 * the rules are pure functions in `store.ts` now, for the reason CLAUDE.md's
 * "Next" section gives for the other fifty: it is the only form `webcheck` can
 * reach.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhere a re-attaching socket resumes\n");
{
  /*
   * The bug, stated as two numbers.
   *
   * `reattachSince` decides between replaying a lag down the socket and dropping
   * the held transcript to page it back in, and the boundary has to be the
   * *daemon's* `ATTACH_REPLAY_MAX` because that is the most `attach` will ever
   * replay. It read `MAX_TRANSCRIPT_EVENTS` instead — so a lag of, say, 5 000
   * took the arm chosen *because* it replays exactly the hole, and got the newest
   * 2 000 with a `lagged{backlog}` frame for the other 3 000. Asking for more
   * than the daemon replays does not fail. It silently gets less.
   *
   * So both numbers are pinned, and pinned as *different* numbers: the failure is
   * not either value being wrong, it is the two being conflated, and a future
   * edit that sets one from the other would pass an assertion on the value alone.
   */
  check("the replay boundary is the daemon's ATTACH_REPLAY_MAX", ATTACH_REPLAY_MAX, 2_000);
  /*
   * The other half used to be `ATTACH_REPLAY_MAX < MAX_TRANSCRIPT_EVENTS` — two
   * numbers pinned as *different* numbers, because the failure was the two being
   * conflated rather than either value being wrong.
   *
   * There is no tab event ceiling to compare against now: it was deleted rather
   * than raised (`MAX_TRANSCRIPT_BYTES` is the only one, and it is not a count). So
   * the same protection is asserted the stronger way, off the source — this
   * function may read the daemon's number and no other bound. An inequality would
   * have quietly become vacuous the day the second number went away.
   */
  const reattachBody = /export function reattachSince\([\s\S]*?\n\}/.exec(
    readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"),
  )?.[0] ?? "";
  check("and it is the only bound that function reads", /ATTACH_REPLAY_MAX/.test(reattachBody), true);
  check(
    "with no tab ceiling anywhere near it",
    /MAX_TRANSCRIPT/.test(reattachBody.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")),
    false,
  );

  // A lag of exactly the cap is the largest one the socket really will fill.
  check(
    "a lag of exactly ATTACH_REPLAY_MAX replays down the socket",
    reattachSince(1_000, 1_000 + ATTACH_REPLAY_MAX),
    { since: 1_000, keepHeld: true },
  );
  // One more than the cap is the first lag that cannot, and the transcript is
  // dropped rather than being asked for down a socket that will not send it.
  check(
    "one more than it drops what is held and restarts at the tail",
    reattachSince(1_000, 1_000 + ATTACH_REPLAY_MAX + 1),
    { since: 1_000 + ATTACH_REPLAY_MAX + 1, keepHeld: false },
  );
  // The whole span the defect lived in: any of these took the replay arm and got
  // a hole. Named separately from the boundary case because the boundary is what
  // an off-by-one moves and this is what a re-conflation moves.
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
  /*
   * The row is up to one poll old, so holding *more* than it reports is ordinary
   * rather than strange, and dropping the transcript for it would throw a
   * conversation away every four seconds.
   *
   * The number is the **held tail**, and that is the assertion rather than
   * `keepHeld` being true. This arm used to answer the row's 900 and let
   * `openSession` raise it to 901 with a `Math.max`, which meant the one function
   * `webcheck` can ask answered a seq the socket never sent — so this line pinned
   * 900 while the wire carried 901, and a revert that deleted the caller's
   * correction passed it. Seeded at 900 the socket's `seq <= lastAppliedSeq` skip
   * cannot fire for the overlap at all and `store.onEvents` appends 901 a second
   * time: the agent's last sentence drawn twice, perfectly contiguous, so the
   * hole check sees nothing. The driven section below is the same claim measured
   * at the socket.
   */
  check("holding more than the row reports keeps it too", reattachSince(901, 900), { since: 901, keepHeld: true });
  /*
   * And the rule the fold makes true, as a property rather than as one more row:
   * **whenever the transcript survives, the attach point is exactly what is
   * held.** That is the whole of what the caller's `Math.max` used to say, and
   * saying it here is what stops it being restated there. The `keepHeld: false`
   * arms are deliberately outside it — they have thrown the transcript away, so
   * there is no held tail left for the socket to be below.
   */
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

  /*
   * No held events is a restart, and the arm exists because of a quieter version
   * of the same hole: `primeBlocked` can write a transcript whose sixty-event
   * window came back empty, leaving `loadedFrom` sixty seqs below a tail the
   * socket — attaching at `daemonLast` — will never send.
   */
  check("nothing held at all restarts from the tail", reattachSince(null, 900), { since: 900, keepHeld: false });
  check("and on a session with no events yet, that is seq 0", reattachSince(null, 0), { since: 0, keepHeld: false });
}

/* ------------------------------------------------------------------ *
 * And what the socket is actually started from
 *
 * `reattachSince` answers where to **attach**, and this section is the end-to-end
 * half of that same claim: that the number it answers is the number the socket
 * asks the daemon for.
 *
 * It exists because for a while it was not. The "held ahead of the row" arm
 * answered the row's poll-stale `lastSeq` and `openSession` raised it to the held
 * tail with a `Math.max` — one rule in two places, of which the assertable one
 * was the wrong one. `reattachSince(901, 900)` was pinned at 900 while the wire
 * carried 901, so deleting the caller's correction failed nothing here at all.
 * What that correction is worth: the arm's whole argument is *the socket skips
 * `seq <= lastAppliedSeq`*, which only holds while the cursor is the **held
 * tail**. Seed the stream at the row's number instead and the skip cannot fire
 * for the overlap, `store.onEvents` concatenates with no dedup, and every event
 * between the poll-stale row and the held tail is appended a second time — the
 * agent's last sentence drawn twice, under a React key already in the list,
 * perfectly contiguous so the hole check sees nothing.
 *
 * The fold put that back inside the pure function, and the checks above pin it.
 * This is still worth driving, because "the pure function is right" and "the
 * caller uses it" are two claims and only the second is about `openSession`:
 * `AppStore` is a singleton
 * this driver already imports, its collaborator is the same duck-typed machine
 * every rotation case above uses, and the observable is the `?since=` the socket
 * asks the daemon for — which is the number that was wrong. The three maps it
 * reads are private, so the fixture is written through a cast rather than
 * through a second copy of the rule living somewhere assertable, which is the
 * drift `sessionOf` is named for.
 * ------------------------------------------------------------------ */

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

  /*
   * The stream's collaborator plus the one method the *store* calls on a
   * connection: `openSession` ends in `emit()`, and `publish()` maps `state()`
   * over every connection on the way out.
   */
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
      revealedBeforeClear: false,
      loadingHistory: false,
      stream: null,
    });
    attaches.length = 0;
    store.openSession(ref);
    const attach = await nextAttach(1);
    // `onVanished` is the public door to `forgetSession`, which stops the stream
    // and drops the row and the transcript — so the next case starts clean rather
    // than on top of this one's socket.
    store.onVanished(ref);
    return attach;
  };

  /*
   * The case. The row is one poll old and says 900; `onEvents` has already
   * appended 901. `reattachSince` answers 900 and the socket must still ask from
   * 901, because 901 is what would otherwise arrive twice.
   */
  check("a socket asks from the held tail, not from the row the poll left behind", (await openWith([899, 900, 901], 900)).since, 901);
  // The mirror, and it is why the arm is the *held tail* rather than "always the
  // newest number anybody named": when the daemon really has moved on, the replay
  // arm asks from what is held *below* the row and every one of those events is a
  // hole to be filled.
  check("and from the replay point when the daemon is the one ahead", (await openWith([690, 700], 900)).since, 700);
  // Nothing held at all is `keepHeld: false`, where there is no tail at all and
  // the row's own number is the whole answer.
  check("with nothing held it starts at the row", (await openWith([], 900)).since, 900);

  // Left behind, the injected connection would be dropped by the first real
  // `runResume` below — which is a machine list this fixture is not in.
  internals.connections.delete("m_1");
}

process.stdout.write("\nthe whole conversation arrives without being asked for\n");
{
  /*
   * ⭐ **Driven end to end, because the pure functions each passed while the
   * conversation stayed missing.**
   *
   * `loadStop`, `fillWindow` and `historyRetry` are asserted individually above,
   * and none of them can show the thing that was actually reported: reload a
   * session whose agent is working and the transcript holds nothing but
   * `working…`. Two separate causes, one run each here — a conversation longer
   * than the old per-run budget, and a page that fails on the way.
   *
   * `daemons` is a private map of `DaemonClient`s and this injects a duck-typed
   * stub into it, the same `internals` cast the socket fixture above already
   * uses. Only `events` is ever called on this path.
   */
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
      revealedBeforeClear: false,
      loadingHistory: false,
      stream: null,
    });
  };
  const held = (): { events: { seq: number }[]; loadedFrom: number } =>
    internals.transcripts.get(key) as { events: { seq: number }[]; loadedFrom: number };

  {
    /*
     * Seven thousand events, against a `MAX_AUTO_HISTORY` of five thousand.
     *
     * The old loop stopped dead at the budget and left the remaining two thousand
     * on the daemon behind "N earlier events did not load — try again". One call
     * has to reach seq 1 now, with no second call and nothing on screen asking
     * for one; the constant survives only as the point at which the loop yields
     * the main thread.
     */
    const stub = daemonHolding(7_000);
    internals.daemons.set("m_2", stub);
    seed(7_000);
    await store.loadAll(ref);
    check("a conversation past the old budget loads in one call", held().loadedFrom, 1);
    check("and every event of it is there, in one run", spanOf(held().events), "1..7000");
    // Expressed in the constant, not in the arithmetic it happened to produce: this
    // said "fourteen pages of five hundred" and the page moved.
    check("in one request per window", stub.asked(), Math.ceil(7_000 / HISTORY_PAGE));
  }

  {
    /*
     * A page dropped mid-run — a radio handing over, a relay blipping.
     *
     * This used to be terminal: `catch {}` swallowed it, `SessionView`'s effect
     * never fires again for the same session, and `attachWanted` skipped any key
     * that already had a stream. The transcript stayed empty for the life of the
     * tab and the reader was offered a button. `historyRetry` waits 500ms and
     * asks the same `since` again, so the block `fillWindow` had already
     * accumulated is kept and the window resumes rather than restarting.
     */
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
  /*
   * ⭐ **`MAX_TRANSCRIPT_BYTES` is documented as "the tab's own and **only**
   * ceiling", and it was per session.** Nothing evicted a transcript, so a tab
   * that visited N conversations retained N of them, each entitled to 16 MiB, on
   * a phone. The byte ceiling bounds one conversation; `MAX_HELD_TRANSCRIPTS`
   * bounds how many are held, and only the two together are what that sentence
   * claimed.
   *
   * The property that makes eviction safe is asserted first and matters most: a
   * session with a live stream is never dropped, so the conversation on screen
   * and the ones still arriving cannot be what goes.
   */
  const { store } = await import("../src/store.js");
  const internals = store as unknown as {
    transcripts: Map<string, unknown>;
    streams: Map<string, unknown>;
    replaceTranscript: (key: string, next: unknown) => void;
    streamOrder: string[];
  };
  // The store is a singleton shared with every other block in this file, so this
  // one seeds under its own prefix and clears up after itself.
  const before = new Set(internals.transcripts.keys());

  const seed = (key: string): void =>
    internals.replaceTranscript(key, {
      events: [],
      gaps: [],
      heldBytes: 0,
      loadedFrom: 1,
      daemonFirstSeq: null,
      clearedAt: null,
      revealedBeforeClear: false,
      loadingHistory: false,
      unfetched: 0,
    });

  // One session pinned as streaming, well before the cap is reached, so the
  // eviction below has to walk past it rather than merely not reach it.
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
  /*
   * ⚠ **The guard against a vacuous pass, which was itself vacuous.** It asserted
   * `has("m/s39")` — and `m/s39` is the last `seed()`, so it is the `just` argument
   * of the very `trimTranscripts` call under test, which skips it unconditionally
   * (`if (key === just || …) continue`). True by construction whatever the eviction
   * policy does, including one that threw everything else away.
   *
   * `m/s38` is the nearest key with no such protection, and `m/s0` is the oldest
   * arrival. The pair is what pins the *policy* rather than the bound: newest kept,
   * oldest gone. Asserting only the first would pass for a store that evicted
   * nothing; only the second, for one that evicted everything.
   */
  check("while the most recently arrived at is still there", internals.transcripts.has("m/s38"), true);
  check("and the one arrived at longest ago is what went", internals.transcripts.has("m/s0"), false);

  for (const key of [...internals.transcripts.keys()]) if (!before.has(key)) internals.transcripts.delete(key);
  internals.streams.delete("m/keep");
  internals.streamOrder.splice(internals.streamOrder.indexOf("m/keep"), 1);
}

process.stdout.write("\nwhat a lagged frame means for the transcript\n");
{
  /*
   * The single most consequential assertion in this file's history sections.
   *
   * The daemon has three lagged reasons and only two of them are losses.
   * `backlog` is `attach` declining to replay past `ATTACH_REPLAY_MAX` — those
   * events are on disk and `GET /sessions/:id/events` serves them — so drawing it
   * as a hole is a client reporting its own decision as data loss. Measured
   * against the live database: a session reporting 3162 events "not shown (beyond
   * retention)" had every one of them still on the daemon, whose own floor was
   * thousands of seqs below.
   *
   * The opposite regression is just as quiet: answering `backlog` by recording
   * nothing and paging *backwards* leaves the range above the held window
   * unfetched for ever, which is the contiguous-looking transcript with the
   * middle absent. So the arm has to be neither "record" nor "ignore" but
   * "restart at the far side".
   */
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
  /*
   * The second shipped bug, and it fired on ordinary session open.
   *
   * `GET /sessions/:id/events` is capped by **bytes** as well as by count
   * (`EVENTS_PAGE_BYTES` 768 KiB against `EVENTS_PAGE_LIMIT` 5000, and the bytes
   * are what bite — they are also what keeps a page inside one relay stream
   * window, Q6.104), and both event
   * stores fill a page by scanning *ascending* from `since` and breaking — so a
   * byte-capped page keeps its oldest events and drops its **newest**. The loader
   * anchored `loadedFrom` on the page's first event, which spliced the page's
   * *last* event straight onto the held window: no `Gap`, no marker, and
   * `loadedFrom` now below the hole so paging never came back for it.
   *
   * Driven with a stub rather than the daemon, which is the only way this is
   * assertable at all — the shape being tested is "the page was shorter than the
   * limit for a reason that is not the end of history", and a real daemon
   * produces that only with a `file_change` big enough to clear 2 MiB.
   */
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
  /**
   * A block as one string, so a hole in it is *named* rather than being a
   * five-thousand-element diff nobody reads. This is the whole property under
   * test: one unbroken run, or `"broken at 5020→5002"`, which is the bug.
   */
  const spanOf = (block: readonly StoredEvent[]): string => {
    if (block.length === 0) return "empty";
    for (let i = 1; i < block.length; i += 1) {
      const prev = block[i - 1]!.seq;
      const here = block[i]!.seq;
      if (here !== prev + 1) return `broken at ${prev}→${here}`;
    }
    return `${block[0]!.seq}..${block[block.length - 1]!.seq}`;
  };

  /*
   * The window under test throughout, **derived from `HISTORY_PAGE` rather than
   * written out**.
   *
   * It was `1_001` against a page of 500, so every expectation below said `501` or
   * `1000` — and raising the page to 5000 broke seven of them at once while every
   * property they assert still held. A fixture that has to be re-typed when a
   * constant moves is a fixture that will be re-typed *wrongly*.
   *
   * Two pages up, so the window has a real floor above 1 (`HISTORY_PAGE + 1`) and
   * the last seq it has to reach is `HISTORY_PAGE * 2`.
   */
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
    /*
     * The byte-capped page: asked for 500, answered with the oldest 20.
     *
     * Two things have to hold and they are separate claims. One page must not
     * *close* the window — that is what makes committing it a hole — and asking
     * forward from the last seq received must eventually close it with a block
     * that is contiguous both internally and with `loadedFrom`.
     */
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
    // The bug's exact signature: with `loadedFrom` anchored on the page's first
    // event, this read `windowFloor + 20` against a held window starting at
    // `loadedFrom` — the rest of it gone, drawn as nothing at all.
    check("contiguous with the held window, which is the property that failed", all.block.at(-1)!.seq + 1, loadedFrom);
    check(
      "in one request per capped page, each from the last seq it received",
      [asked.length, asked[0], asked.at(-1)],
      [HISTORY_PAGE / 20, HISTORY_PAGE, windowTop - 20],
    );
  }

  {
    /*
     * A daemon that answers with nothing usable — its floor is above this window,
     * or the session went away under us. There is no next `since` to ask from, so
     * the window ends rather than asking the same question again.
     *
     * The stub would answer this way for ever. Its escape at 50 is deliberate and
     * is what makes this a red line rather than a hung driver: without the break
     * the loop is infinite, and a driver that hangs reports nothing at all.
     */
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
    // The floor still comes back: it is the honest thing to draw when the start of
    // a conversation really is gone, and it is the one useful fact such an answer
    // carries.
    check("the floor it reported is still worth keeping", window.firstSeq, 900);
  }

  {
    /*
     * The budget is spent **inside** the window, not per window.
     *
     * A byte-capped page turns one window into an unknown number of requests, so
     * a budget that only counted windows would not be a bound at all — three
     * pages of 20 against a budget of 60 is the whole of it, and the fourth
     * request must not happen even though the window is nowhere near closed.
     */
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
    // No budget at all asks nothing, and says so with `null` rather than with a
    // floor of 0 — which `EventList` would draw as the start of the conversation
    // being gone. The same three-answer discipline as `probeExists`.
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
    /*
     * ⭐ **A budget of one page always closes a window, and `loadAll` passes
     * exactly that.**
     *
     * This is the property the whole "no more `try again` button" change rests on.
     * A window spans exactly `HISTORY_PAGE` seqs — `fillWindow` starts its cursor
     * at `max(0, top - HISTORY_PAGE)` and filters to `> cursor && <= top` — so it
     * can never yield more than that many events, whatever the daemon's 2 MiB byte
     * cap does to the page sizes. The budget therefore cannot be the thing that
     * ends a window, and `!closed` is left meaning only what it is documented to
     * mean: the daemon cannot go further back.
     *
     * It used to be `MAX_AUTO_HISTORY - fetched`, and every 5000th event that
     * expression went to zero *mid-window* — so the block was discarded whole by
     * `loadAll`'s `!closed` arm, the run paid for a page it threw away, and the
     * loss was reported to the reader as a button. Both stubs are asserted because
     * the byte-capped one is the case that made the old expression bite.
     */
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
  /*
   * Three of the four ways `loadAll` ends, in the order it asks them. The fourth
   * is a window that would not close, which is `fillWindow`'s `closed` and is
   * asserted in the section above — it cannot be known until a window has been
   * attempted, so restating it here would be a second copy of a rule that already
   * has one.
   *
   * The order is asserted rather than assumed, because it is the part that
   * decides what the reader is told: a log that has reached its floor and reports
   * anything else keeps asking for events nobody has.
   *
   * **There was a `budget` arm here and it is gone, along with the parameter.**
   * It fired at `MAX_AUTO_HISTORY` and left the rest of the conversation behind a
   * "N earlier events did not load — try again" button, i.e. this client
   * reporting its own bookkeeping to the reader as a failure. That constant is
   * `loadAll`'s yield chunk now and nothing else.
   */
  const st = (over: {
    loadedFrom?: number;
    daemonFirstSeq?: number;
    clearedAt?: number | null;
    revealedBeforeClear?: boolean;
    heldEvents?: number;
    heldBytes?: number;
  }): {
    loadedFrom: number;
    daemonFirstSeq: number;
    clearedAt: number | null;
    revealedBeforeClear: boolean;
    heldEvents: number;
    heldBytes: number;
  } => ({
    loadedFrom: 500,
    daemonFirstSeq: 0,
    clearedAt: null as number | null,
    revealedBeforeClear: false,
    heldEvents: 10,
    heldBytes: 1_000,
    ...over,
  });

  check("an ordinary window carries on", loadStop(st({})), null);
  check("the start of the log ends it", loadStop(st({ loadedFrom: 1 })), "start_of_log");
  check("the agent's own cut ends it", loadStop(st({ clearedAt: 400 })), "cleared");
  check(
    "unless somebody asked to see past it",
    loadStop(st({ clearedAt: 400, revealedBeforeClear: true })),
    null,
  );
  /*
   * ⭐ **The daemon's own floor, which is what makes the 4s re-drive affordable.**
   *
   * Nothing here read `daemonFirstSeq` before. That was harmless while `loadAll`
   * ran once per open — a legacy session whose oldest surviving event is seq 6145
   * simply spent one fruitless request each time — and it is a permanent request
   * loop now that `attachWanted` calls this on every poll: `loadedFrom` can never
   * reach 1, so without this arm the answer is `null` for ever, on exactly the
   * sessions that can least afford to be asked.
   *
   * `max(1, …)` and not the bare field: `daemonFirstSeq` is 0 for "no page has
   * answered yet", and read literally that says the whole log is already in hand.
   */
  check("the daemon's floor is the start of the log too", loadStop(st({ loadedFrom: 6145, daemonFirstSeq: 6145 })), "start_of_log");
  check("one event above it carries on", loadStop(st({ loadedFrom: 6146, daemonFirstSeq: 6145 })), null);
  check("and an unknown floor behaves as seq 1, not as done", [
    loadStop(st({ loadedFrom: 1, daemonFirstSeq: 0 })),
    loadStop(st({ loadedFrom: 2, daemonFirstSeq: 0 })),
  ], ["start_of_log", null]);
  /*
   * ⭐ **The tab's own ceiling, and it is bytes — the event count beside it is
   * deleted rather than raised.**
   *
   * Without a ceiling at all, a *terminal* session — which receives no events, so
   * never reaches the trim `onEvents` does at the other end — grows on every single
   * open, for ever. With **two**, the wrong one decides: 50 000 events beside
   * 16 MiB fires at 7 MiB on 140-byte events, which is the truncation that was
   * reported, moved further out and made harder to notice. So there is one, and the
   * assertion below is that a count alone — however large — never ends a run.
   */
  check("the tab's own ceiling ends it", loadStop(st({ heldBytes: MAX_TRANSCRIPT_BYTES })), "held_full");
  check("one byte short of that does not", loadStop(st({ heldBytes: MAX_TRANSCRIPT_BYTES - 1 })), null);
  check(
    "and no number of events ends it by itself",
    loadStop(st({ heldEvents: 500_000, heldBytes: 4.53 * 1024 * 1024 })),
    null,
  );

  // Order, where two answers are true at once.
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
    /*
     * ⭐ **A conversation holding the newest 500 of 2856 events was drawn exactly as
     * a complete one, and nothing here could tell.**
     *
     * Five booleans in `EventList`'s body decided what went above the rows, and the
     * ordinary state of a reload fell through every one: `awaitingHistory` wanted
     * `rows.length === 0`, `showFloor` wanted `unfetched === 0`, `atCeiling` wanted
     * 20 000 held events, the reveal button wanted a `/clear` marker and "No events
     * yet." wanted no rows. Rendered under `react-dom/server`, the markup above the
     * rows was byte-identical for "newest 500 held, still paging", "newest 500 held,
     * run gave up" and "all 2856 held" — 48 characters, the bare column `<div>` —
     * and the `role="status"` region was the empty string in all three.
     *
     * So the rule is one function and the property below is the assertion that was
     * missing, not any single arm of it: **while there is history outstanding and no
     * cut in force, the transcript must say something.** Everything else here is a
     * consequence.
     */
    const { transcriptNotice } = await import("../src/store.js");
    const ns = (over: {
      loadedFrom?: number;
      daemonFirstSeq?: number;
      clearedAt?: number | null;
      revealedBeforeClear?: boolean;
      loadingHistory?: boolean;
      heldEvents?: number;
      heldBytes?: number;
      rows?: number;
    }): Parameters<typeof transcriptNotice>[0] => ({
      loadedFrom: 1_357,
      daemonFirstSeq: 1,
      clearedAt: null as number | null,
      revealedBeforeClear: false,
      loadingHistory: false,
      heldEvents: 1_500,
      heldBytes: 200_000,
      rows: 9,
      ...over,
    });

    /*
     * The state the bug report described, measured off the live database: 2856
     * events on the daemon, the newest 1500 held, `loadedFrom` frozen at 1357 by a
     * page that failed. Both halves — a run still going, and a run that gave up.
     */
    check("a run still paging says it is loading, with the count", transcriptNotice(ns({ loadingHistory: true })), {
      kind: "loading",
      earlier: 1_356,
    });
    check("a run that gave up says it has not arrived, and that it retries", transcriptNotice(ns({})), {
      kind: "stalled",
      earlier: 1_356,
    });

    // The four that were already drawn, unchanged.
    check("nothing arrived yet is the skeleton", transcriptNotice(ns({ rows: 0 })), { kind: "skeleton" });
    check(
      "the tab's own ceiling outranks both, because that is why paging stopped",
      transcriptNotice(ns({ heldEvents: 120_000, heldBytes: MAX_TRANSCRIPT_BYTES, loadingHistory: true })),
      { kind: "ceiling", held: 120_000 },
    );
    /*
     * ⭐ **The ceiling is bytes and there is no second one.**
     *
     * 20 000 events meant 49 MiB for a session whose tool call typed its arguments
     * one token at a time and 2.8 MiB for the same session with those drafts
     * emptied — one number standing for two completely different tabs, and what it
     * did in practice was cut a 33 898-event conversation at seq 13 989. So the stop
     * is bytes, nothing else is a stop, and the sentence names **what is held**
     * rather than a constant — with two quantities able to raise it, a fixed number
     * would be a claim about the wrong one.
     */
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
      "and a cut says nothing, because the reveal button is the thing to read",
      transcriptNotice(ns({ clearedAt: 900 })),
      null,
    );

    /*
     * ⭐ **The property, over every combination.** `null` is only ever allowed for
     * two reasons — a cut in force, or nothing left to fetch — and the second is the
     * *same expression* `loadStop` calls `start_of_log`. Anything else answering
     * `null` is a transcript that begins mid-word with nothing saying why, which is
     * what was reported.
     */
    let silent = 0;
    let states = 0;
    for (const loadedFrom of [1, 2, 357, 1_357, 6_145]) {
      for (const daemonFirstSeq of [0, 1, 6_145]) {
        for (const clearedAt of [null, 900]) {
          for (const revealedBeforeClear of [false, true]) {
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
                    revealedBeforeClear,
                    loadingHistory,
                    heldEvents,
                    heldBytes,
                    rows,
                  });
                  states += 1;
                  const answer = transcriptNotice(state);
                  const cutInForce = clearedAt !== null && !revealedBeforeClear;
                  const outstanding = loadedFrom > Math.max(1, daemonFirstSeq);
                  if (answer === null && !cutInForce && outstanding) silent += 1;
                  // The mirror of it: a `null` must be *justifiable*, never merely
                  // absent — so the only other way to answer nothing is a whole
                  // conversation on screen.
                  if (answer === null && !cutInForce && !outstanding && rows === 0) silent += 1;
                }
              }
            }
          }
        }
      }
    }
    // The count rides the assertion so a shrunk grid cannot pass by covering less.
    check("no state with history outstanding is drawn silently", { states, silent }, { states: 720, silent: 0 });

    /*
     * And the pair with `loadStop`, which is the invariant in one line: a run that
     * is still willing to fetch (`loadStop` answers `null`) is a transcript that
     * owes the reader a sentence. The two functions read the same five fields and
     * are two hundred lines apart, which is exactly how they would drift.
     */
    const willing = ns({ loadingHistory: false });
    check("while paging is willing, something is always said", [
      loadStop(willing) === null,
      transcriptNotice(willing) !== null,
    ], [true, true]);
  }
}

process.stdout.write("\na page that fails is retried long enough for a daemon to redial\n");
{
  /*
   * ⭐ **`loadAll` answered a failed page with `catch {}`, and nothing re-drove it.**
   *
   * One dropped request — a radio handing over, a relay blipping — left the
   * transcript empty for the life of the tab, because `SessionView`'s effect never
   * fires again for the same session and `attachWanted` skipped any key that
   * already had a stream. What the reader was offered instead was a button asking
   * them to do by hand what the client had given up on.
   *
   * ⭐⭐ **And then the schedule was the defect rather than the classification.**
   * This block used to assert `[500, 2000]` for a transport failure and `null` for
   * every `ApiError`, on the argument that an answered refusal repeats. Measured
   * against the live database with the real store, an eight-second relay outage
   * delivered as *transport* failures — the flavour that schedule did retry — left
   * a byte-identical truncated transcript (`loadedFrom=1357` of 2878). 2.5s cannot
   * survive a daemon redialling on its own 1s→30s full-jitter backoff, which is
   * exactly what recreating the relay container costs.
   *
   * The schedule is asserted here rather than driven, so 37.5s of real waits do not
   * go anywhere near the driver's wall clock.
   */
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

  /*
   * **The budget is what the number is for**, so it is asserted as one rather than
   * left implicit in a list: the daemon's reconnect backoff tops out at 30s, and a
   * schedule that stops before then hands the reader a truncated conversation for
   * the difference.
   */
  check(
    "and the whole schedule outlasts the daemon's 30s reconnect cap",
    HISTORY_RETRY_MS.reduce((sum, ms) => sum + ms, 0) >= 30_000,
    true,
  );

  /*
   * **Three refusals mean *later*, and the other kind still ends the run.** The
   * split is `meansLater`, out in `http.ts` beside `meansMachineGone` because
   * `no_tunnel` belongs to both and that has to be sayable in one place: stop
   * believing this route, *and* ask again in a moment. What must never be retried
   * is a state only somebody else can change — an admin lowering a machine limit or
   * banning an owner — because that is a request loop with `loadingHistory` latched
   * across it.
   */
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

  /*
   * The predicate itself, in both directions: a transport failure is not an
   * *answer*, so it must not come back through this arm as well — `historyRetry`
   * asks `isTransportFailure` first and the two must not overlap into a single
   * schedule by accident.
   */
  check("meansLater is about answers only", [meansLater(dropped), meansLater(null), meansLater("nope")], [
    false,
    false,
    false,
  ]);
}

process.stdout.write("\na session with no row yet is loading, not missing\n");
{
  /*
   * ⭐ **The screen said a live session did not exist, on the ordinary path.**
   *
   * `SessionView` reads `rowsByKey`, and with nothing there it drew either "That
   * session is not on this daemon." or "<name> is not reachable right now." —
   * both of which are claims it cannot support during a cold reload. `bootstrap`
   * promotes to `phase: "ready"` on the *machine* list, so the view mounts three
   * round trips before the session list exists (mint a token, drop the route memo
   * and re-probe it — itself bounded at 1.5s — then `GET /sessions`), and
   * `resumeMachine` forgets the route first, so `reach` is `unknown` or
   * `probing` for most of that window.
   *
   * The whole matrix, because the interesting cell is one of six: a machine that
   * is plainly online and has simply never been asked.
   */
  const { missingRowReason } = await import("../src/machine.js");

  check("no machine at all is the grant being gone", [
    missingRowReason(null, false),
    missingRowReason(null, true),
  ], ["no_machine", "no_machine"]);
  // Before any probe has answered, and while one is in flight. Nothing is known
  // about the session either way, so neither may be reported as an absence.
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
  /*
   * The cell that was the bug. `online` says the *daemon* answered a health probe;
   * it says nothing about whether anybody has asked it for a session list, and
   * only the second question licenses "that session is not here".
   */
  check("online but never listed is still loading", missingRowReason("online", false), "loading");
  check("online and listed is the only absence anybody may report", missingRowReason("online", true), "not_here");
}

process.stdout.write("\nhistory loads itself, and nothing asks the reader to retry\n");
{
  /*
   * ⭐ **Read off disk, because what was deleted is the assertion.**
   *
   * Three separate mechanisms had to line up for a reloaded session to draw its
   * conversation, and each of them is invisible to a pure function: a button that
   * must not come back, a window budget that must stay non-binding, and the one
   * line that re-drives a run which gave up. The `gateOffer`/`showsGateLink`
   * lesson applies exactly — a rule asserted only where it is *stated* is a rule
   * that gets re-derived somewhere else and lost.
   */
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const eventList = strip(readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8"));
  const sessionView = strip(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
  const storeSrc = strip(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));

  check("the transcript offers no retry", /did not load/.test(eventList), false);
  check("and carries no prop for one", /onLoadEarlier/.test(eventList), false);
  check("nor does the view pass one", /onLoadEarlier/.test(sessionView), false);

  /*
   * The two sentences that must survive the deletion, and they survive for
   * opposite reasons. One is a loss no amount of fetching undoes; the other is
   * the agent's own cut, which is a thing the reader chose and can unchoose.
   */
  check("real retention loss still says so", /the start of this conversation is gone/.test(eventList), true);
  check("and the agent's own cut is still offered back", /from before \/clear/.test(eventList), true);

  // The skeleton is what replaced the empty screen; without it the reader is back
  // to a lone `working…` over a conversation that has not arrived.
  check("a conversation still arriving is drawn as one", /<TranscriptSkeleton \/>/.test(eventList), true);
  check("and so is a session whose row has not landed", /<TranscriptSkeleton \/>/.test(sessionView), true);

  /*
   * The window budget. `MAX_AUTO_HISTORY - fetched` is the precise expression
   * that made a chunk boundary discard a page it had already paid for; naming it
   * is a lower-fragility check than trying to describe the call.
   */
  check("a window is never given a budget that can cut it short", /MAX_AUTO_HISTORY - fetched/.test(storeSrc), false);
  check("and no stop is spelled `budget` any more", /return "budget"/.test(storeSrc), false);

  /*
   * The self-healing line, which nothing else in this file can see. `attachWanted`
   * is called from `refreshMachineSessions` — the one place `rows` is filled, and
   * reached by both the 4s poll and the wake sequence — so this is what turns a
   * run that spent its retries into one that resumes on its own.
   */
  const attachWanted = /private attachWanted\(id: MachineId\): void \{[\s\S]*?\n  \}/.exec(storeSrc)?.[0] ?? "";
  check("an open session's history is re-driven on every list", /loadAll/.test(attachWanted), true);

  /*
   * ⭐ **The notice is one rule with one voice, and both halves are source-level.**
   *
   * `transcriptNotice` is asserted as a pure function above; what cannot be reached
   * from there is whether this file *asks* it, or quietly re-derives the same
   * arithmetic into a fifth boolean — which is the shape the defect had. Five
   * separate gates, individually plausible, together leaving the ordinary state of
   * a reload with nothing drawn at all.
   */
  check("the transcript asks for its notice rather than deriving one", /transcriptNotice\(\{/.test(eventList), true);
  check("and computes no `unfetched` of its own", /unfetched\s*=/.test(eventList), false);
  check("nor keeps the booleans it replaced", /showFloor|atCeiling|awaitingHistory/.test(eventList), false);

  /*
   * The pair. The live region was gated on the skeleton's own `rows.length === 0`,
   * so in the state the notice exists for it read the empty string — the truncation
   * was inaudible as well as invisible. One value feeds the visible line and the
   * region, so they cannot part company again; pinned by source text because
   * `webcheck` has no DOM and this is a JSX prop.
   */
  const liveRegion = /role="status"[\s\S]{0,200}?<\/p>/.exec(eventList)?.[0] ?? "";
  check("the live region says whatever the notice says", /noticeSays/.test(liveRegion), true);
  check("and is no longer gated on the skeleton's own condition", /awaitingHistory/.test(liveRegion), false);
  /*
   * `>= 1` and it was `>= 2`, which counted a structure rather than the property.
   *
   * There were two visible copies while `loading` and `stalled` were drawn at the
   * foot and `floor`/`ceiling` at the head; both arms are above the rows again
   * (Q3.423), so there is one visible `<p>` and the count fell with it. What has to
   * hold is unchanged and is the pair *visible line ↔ live region*, asserted here
   * and one check above: neither may go back to a literal of its own, which is the
   * drift that left the region silent in the one state the line exists for.
   */
  check(
    "the visible line reads the same string as the live region",
    (eventList.match(/\{noticeSays\}/g) ?? []).length >= 1,
    true,
  );
}

process.stdout.write("\na /clear arriving down the socket\n");
{
  /*
   * The cut is the same fact whether it was found by paging or arrived live, and
   * which side of the socket it came from is precisely what the reader must not
   * be able to tell. So `onEvents` runs the same rule the loader does.
   *
   * Newest in the batch wins, and it takes `revealedBeforeClear` with it: having
   * asked to see what was above the *previous* cut is not a standing request to
   * see everything above every future one. Clearing again means clearing again —
   * and the failure of not resetting it is the worst kind, since it silently
   * shows a conversation somebody has just asked the agent to forget.
   */
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

  check("a batch with no marker changes nothing", nextCut(7, true, [ev(8), ev(9)]), {
    clearedAt: 7,
    revealedBeforeClear: true,
  });
  check("an empty batch changes nothing either", nextCut(7, true, []), { clearedAt: 7, revealedBeforeClear: true });
  check("a marker moves the cut and takes the reveal with it", nextCut(7, true, [ev(8), cut(9)]), {
    clearedAt: 9,
    revealedBeforeClear: false,
  });
  // Two in one batch is not exotic: a batch is whatever the socket delivered
  // since the last frame, and a wake after two `/clear`s delivers both.
  check("the newest marker in a batch wins", nextCut(null, false, [cut(3), ev(4), cut(5)]), {
    clearedAt: 5,
    revealedBeforeClear: false,
  });
  /*
   * Last, not highest. A live batch cannot in practice carry a marker below the
   * cut already held — but the rule CLAUDE.md states is "whichever came last
   * decides", and `Math.max` is the plausible wrong shape that agrees with every
   * case above and disagrees with this one. Written down so the two cannot be
   * confused for each other by somebody tidying.
   */
  check("what the batch last said decides, rather than the largest seq in it", nextCut(9, false, [cut(5)]), {
    clearedAt: 5,
    revealedBeforeClear: false,
  });
}
