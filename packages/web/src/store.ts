import { authFailure, signedOutText, type AuthFailure } from "./account";
import { forgetAttachments } from "./attach";
import { forgetAsks } from "./ask";
import { forgetChoices } from "./choices";
import * as cp from "./cp";
import { DaemonClient } from "./daemon";
import { ApiError, isTransportFailure, meansLater } from "./http";
import type { InstanceConfig } from "./instance";
import { keyOf, machineId, refOf, sessionId, type MachineId, type SessionKey, type SessionRef } from "./ids";
import { describe, MachineConnection, type MachineState } from "./machine";
import { SessionStream, type StreamSink, type StreamStatus } from "./stream";
import {
  countsAsLive,
  hasLiveAgent,
  needsHuman,
  oldestWait,
  showsAsEnded,
  type AgentCommand,
  type AgentConfig,
  type LaggedFrame,
  type Me,
  type SessionSnapshot,
  type SessionToken,
  type StoredEvent,
} from "./wire";

/**
 * All of the client's state, and the one place that orchestrates it.
 *
 * A plain external store rather than a state library: `useSyncExternalStore` is
 * in React, this is one screen's worth of state, and a reducer would obscure the
 * only part that is actually subtle — which is `resume()`.
 *
 * The shape of the whole thing follows from one constraint: **partial
 * availability is normal.** Machines are asleep, on other networks, or behind a
 * relay that just restarted. Every operation here is therefore per machine and
 * independent, and there is no code path where one unreachable machine can blank
 * the list, stall a poll, or fail a resume for the others.
 */

/** How often to re-list sessions on a reachable machine while the tab is visible. */
const POLL_INTERVAL_MS = 4_000;
/** How often to re-probe a machine that is not answering. Slower: it is probably off. */
const OFFLINE_RETRY_MS = 15_000;
/** Live sockets, most-recently-viewed first. Twenty sockets on a phone is not a design. */
const MAX_LIVE_STREAMS = 3;
/**
 * How many conversations a tab keeps in memory at once.
 *
 * The companion to `MAX_TRANSCRIPT_BYTES`, which bounds one conversation and was
 * documented as bounding the tab. See `trimTranscripts` for why a stream is never
 * evicted and why the order is arrival rather than a true LRU.
 *
 * Twelve, against `MAX_LIVE_STREAMS` of 3: four times as many held as can be
 * streaming, so navigating back through a handful of sessions costs nothing, and
 * a tab left open all day cannot accumulate without bound.
 */
export const MAX_HELD_TRANSCRIPTS = 12;
/**
 * Bytes held per session, and **the only ceiling a tab has**.
 *
 * **There was a `MAX_TRANSCRIPT_EVENTS` here and it is deleted, not raised.** It
 * was a bound on a browser tab, so what it was trying to express is memory — and
 * an event count expresses memory only if events have a size, while theirs ranges
 * over three orders of magnitude (68 B for a text delta, 128 KiB at
 * `truncateEvent`'s own cap). At 20 000 it stood for **49 MiB** on a kimi session
 * whose tool call typed its arguments one token at a time and **2.8 MiB** on the
 * same session once those drafts were emptied: one number, two completely
 * different tabs. What it *did* was cut a 33 898-event conversation at seq 13 989,
 * hiding three of its six prompts and its own first message, on a transcript that
 * costs 4.53 MiB and 9 ms to hold whole.
 *
 * **Raising it was tried first and is the wrong shape**, which is worth writing
 * down because it is the obvious move: at 50 000 events beside a 16 MiB ceiling,
 * the *count* is still what fires first on light events — 50 000 × 140 B is 7 MiB
 * — so the truncation survives at exactly the size that must never be truncated,
 * just further out and harder to notice. Two ceilings for one resource means the
 * wrong one decides.
 *
 * Measured on this fleet: the largest conversation is **4.53 MiB across 33 898
 * events**, and the largest before its superseded drafts were emptied was
 * 79.2 MiB — the pathology this guards against, and one the daemon no longer
 * writes. 16 MiB is three and a half times the biggest real conversation, so
 * nothing anybody has reaches it, and it is still a number a phone survives.
 *
 * What is *not* bounded any more is the array's length, and therefore
 * `buildTail`'s walk, which runs on every streamed token — 9 ms at 33 898 events,
 * and about 32 ms at the ~120 000 that 16 MiB of 140-byte events would be. That is
 * the price of the deletion, it is a frame rate rather than a truncation, and it is
 * the right way round: a conversation that arrives whole and redraws slowly can be
 * read, and one that is cut cannot.
 *
 * Approximate by construction — `sizeOfEvent` is one `JSON.stringify` per event,
 * memoised on the event's identity — and approximate is the right kind of answer:
 * it decides when to stop fetching, never what to draw.
 *
 * There is deliberately **no render window under this**. A transcript used to hold
 * 1200 and draw the newest 400, with a button growing the second number — which
 * meant opening any real conversation started three or four taps from its
 * beginning. A conversation is a thing you read from the top; the only cut is the
 * one the *agent* made, at `/clear`, and it is `clearedAt` below.
 */
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/**
 * History fetched by one `loadAll`, before it stops and offers to carry on.
 *
 * A budget rather than a limit: what it stops short of is still on the daemon and
 * the transcript says so with a button that resumes exactly here. Bounded because
 * a session's log is now unbounded — opening one on a phone must not mean an
 * open-ended sequence of requests before anything settles.
 */
export const MAX_AUTO_HISTORY = 5_000;
/**
 * The server's own `EVENTS_PAGE_LIMIT`, mirrored. Asking for less is asking more
 * times.
 *
 * **500 was a round-trip count in disguise.** A window spans this many *seqs*, so
 * the number is how many sequential requests a conversation costs: 68 of them for a
 * 33 898-event session, each one a full relay round trip before the next can be
 * asked for, which is the whole of "it loads slowly and in pieces". At 5000 the
 * same session is **seven** requests.
 *
 * Raising it is safe because it was never the bound that mattered: the daemon caps
 * a page at `EVENTS_PAGE_BYTES` (768 KiB) as well, and `fillWindow` already refills a
 * byte-capped window from the last seq it received. So a light conversation now
 * arrives in one request per window and a heavy one degrades to exactly the number
 * of requests it costs today — the byte cap is what governs it, in both cases, and
 * it has not moved.
 */
export const HISTORY_PAGE = 5_000;
/**
 * The daemon's own `ATTACH_REPLAY_MAX`, mirrored — and it has to be mirrored.
 *
 * `attach` replays at most this much down the socket and reports the rest as
 * `lagged{backlog}`. So this is the largest lag a re-attach can ask the socket to
 * fill, and asking for more does not fail — it silently gets less, which is how
 * a hole opens in the middle of a transcript.
 *
 * It was read off the tab's own event ceiling — 20 000 at the time — against a
 * daemon that would only ever serve 2 000, which is the mismatch itself. That
 * ceiling is deleted now (see `MAX_TRANSCRIPT_BYTES`), which removes the number
 * this could be confused with rather than the need for it: if `server.ts` changes,
 * change this. Too small only costs a refetch; too large costs somebody's
 * conversation.
 */
export const ATTACH_REPLAY_MAX = 2_000;
/** Enough recent events to find the `tool_call` behind a pending permission. */
const PRIME_WINDOW = 60;
/**
 * Sessions asked for per machine, per poll.
 *
 * The daemon retains 200 and every row is a full snapshot, so an unbounded poll
 * every four seconds per machine is a hundred megabytes an hour on LTE for a list
 * whose interesting part is a handful of rows. With a limit the daemon answers
 * blocked-first, then live, then most-recent terminal, so what a cut drops is the
 * tail nobody is waiting on — and it says `truncated` so the prune below knows the
 * difference between "gone" and "outside the window".
 *
 * 60 rather than 20: it has to comfortably cover every blocked and live session
 * across a fleet plus recent history, because the collapsed "ended" section reads
 * from the same list.
 */
const SESSION_LIST_LIMIT = 60;

export interface Gap {
  from: number;
  to: number;
  reason: "evicted" | "slow_consumer";
}

export interface SessionRow {
  key: SessionKey;
  ref: SessionRef;
  machineName: string;
  snapshot: SessionSnapshot;
  /**
   * The daemon's clock when this row was fetched, and ours at the same instant.
   *
   * Elapsed times are `(daemonNow - raisedAt) + (Date.now() - fetchedAt)`. Using
   * the browser clock alone is wrong in the one case that matters: a phone that
   * has been asleep has a clock that drifted, and "blocked for −2 minutes" is
   * both incorrect and alarming.
   */
  daemonNow: number;
  fetchedAt: number;
  /**
   * The last controls a *running* agent published, kept across the window where
   * there is no agent to publish any. See {@link holdConfig}.
   */
  heldConfig?: AgentConfig;
  /**
   * How to render this row's paths as the person working in them would write them.
   *
   * Carried per row rather than per machine because it arrives on the same
   * response the row did, so the two cannot be out of step — and a row from a
   * daemon that does not publish it simply shows the path it was given.
   */
}

export interface Transcript {
  events: StoredEvent[];
  gaps: Gap[];
  /**
   * Roughly how many bytes `events` is, and the number the tab's ceiling is about.
   *
   * Carried rather than derived because it is read by `loadStop` on every window
   * and every poll, and deriving it means walking the whole array. Maintained
   * wherever events are added or dropped, through `sizeOfEvent`, which memoises per
   * event so no event is measured twice however many times it is counted.
   */
  heldBytes: number;
  /** The lowest seq held in memory. Below this, history is on the daemon. */
  loadedFrom: number;
  /** The lowest seq the daemon still has. Below this, it is gone for good. */
  daemonFirstSeq: number;
  /**
   * The newest `context_cleared` found while paging, or `null` for none.
   *
   * The one place a transcript is cut, and it is the agent's own cut rather than
   * a render budget: everything at or below this seq is a conversation the agent
   * has been told to forget. `loadAll` stops here, so those events are not even
   * fetched until somebody asks for them.
   *
   * The `/clear` prompt itself sits *below* the marker — `registry.ts` appends the
   * prompt and then the marker — so cutting strictly below the marker hides the
   * prompt with the conversation it ended and leaves the divider as the top row,
   * which is what says a cut happened at all.
   */
  clearedAt: number | null;
  /** Somebody asked for what is above `clearedAt`. Paging resumes to seq 1. */
  revealedBeforeClear: boolean;
  loadingHistory: boolean;
  stream: StreamStatus | null;
}

/* ------------------------------------------------------------------ *
 * The transcript's rules, as pure functions
 *
 * Out here for the same reason `commandsPlan` below is, and `keys.ts`, `tail.ts`
 * and `commands.ts` are: `webcheck` has no daemon and no DOM, so a rule that
 * lives in a method on `AppStore` is a rule nothing can assert. That is not an
 * abstract worry here. Every one of these decides where a transcript is cut or
 * joined, and getting one wrong produces a conversation that looks **contiguous
 * and is not** — which a reader cannot tell from something the agent said.
 *
 * Two of them are here because they were wrong in exactly that way, on the
 * ordinary paths rather than in corners, and the measurements are written at the
 * functions themselves.
 * ------------------------------------------------------------------ */

/**
 * Roughly what one event costs to hold, memoised on the event itself.
 *
 * `JSON.stringify` rather than the daemon's hand-rolled `estimateBytes`, because
 * this needs no agreement with anything on the wire — it decides when a tab stops
 * *fetching*, never what it draws — and because a `WeakMap` on `StoredEvent`
 * identity means every event is measured exactly once for the life of the tab.
 * `StoredEvent` is never mutated, which is what makes the identity a valid key.
 *
 * The fallback matters more than it looks: a cyclic payload would throw here, and
 * this runs on the socket's own path, so a throw would take the whole batch with it.
 */
const EVENT_SIZE = new WeakMap<StoredEvent, number>();

export function sizeOfEvent(stored: StoredEvent): number {
  const known = EVENT_SIZE.get(stored);
  if (known !== undefined) return known;
  let size: number;
  try {
    size = JSON.stringify(stored).length;
  } catch {
    // Unmeasurable, so charged something rather than nothing: a batch of these
    // must still walk the tab toward its ceiling.
    size = 512;
  }
  EVENT_SIZE.set(stored, size);
  return size;
}

/** What a batch of events adds to {@link Transcript.heldBytes}. */
export function sizeOfEvents(events: readonly StoredEvent[]): number {
  let total = 0;
  for (const stored of events) total += sizeOfEvent(stored);
  return total;
}

/**
 * Where a re-attaching socket resumes, and whether what is held survives it.
 *
 * `closeStream` deliberately keeps the transcript, so coming back to a session
 * the socket LRU evicted is instant. But attaching at the daemon's `lastSeq`
 * while holding events only up to some earlier seq draws those two runs as one
 * transcript with the middle quietly absent — and paging cannot repair it,
 * because `loadAll` only ever goes *backwards* from `loadedFrom` and the hole is
 * above it. On the screen whose whole job is deciding whether to approve a
 * command, missing agent output is a correctness failure rather than a cosmetic
 * one.
 *
 * So a lag is either replayed down the socket or the held transcript is dropped
 * and paged back in contiguously, and the boundary between those two is
 * `ATTACH_REPLAY_MAX` — **the daemon's number, not this client's.** That is the
 * defect this function exists to make assertable: the test read the *tab's* own
 * event ceiling, 20 000 at the time, so every lag between 2 000 and 20 000 took
 * the arm chosen *because* it replays exactly the hole, asked the socket to replay
 * it, and got the newest 2 000 with a `lagged{backlog}` frame for the rest. Asking
 * for more than the daemon replays does not fail; it silently gets less. There is
 * no such ceiling to read by accident any more — `MAX_TRANSCRIPT_BYTES` is not a
 * count — and `webcheck` asserts that this function names no bound but this one.
 *
 * A third answer is folded in rather than left implicit: **no held events at all
 * is a restart too.** `openSession` distinguished "no transcript" from "a
 * transcript holding nothing", and kept the second — which only ever arises from
 * `primeBlocked` writing a sixty-event window that came back empty, leaving
 * `loadedFrom` sixty seqs below a tail the socket will never send. The same hole
 * by a quieter route. There is nothing held to weigh, so there is nothing to
 * weigh it against.
 */
export function reattachSince(heldLast: number | null, daemonLast: number): { since: number; keepHeld: boolean } {
  if (heldLast === null) return { since: daemonLast, keepHeld: false };
  /*
   * Ahead of the row, which is ordinary rather than strange: the snapshot is up
   * to one poll old while `onEvents` has already moved the transcript past it,
   * and that is the ordinary state of a session that is talking.
   *
   * The answer is the **held tail**, not `daemonLast`. This arm used to return
   * the row's number and let `openSession` raise it with a `Math.max`, on the
   * argument that the overlap is free because the socket skips `seq <=
   * lastAppliedSeq` — true, but only while the cursor it is compared against is
   * what is held. Seed the stream below that and the skip cannot fire for the
   * overlap at all: `store.onEvents` concatenates with no dedup, so every event
   * between the poll-stale row and the held tail was appended a second time —
   * the agent's last sentence drawn twice, under a React key already in the
   * list, and perfectly contiguous so the hole check saw nothing.
   *
   * So the correction lives here rather than at the caller. With it outside, the
   * one exported function anybody can ask answered a number the socket never
   * sent, and `webcheck` pinned that number — the drift `sessionOf` is named
   * for, in the direction where the assertable copy is the wrong one.
   *
   * Asking from the held tail is safe in the other direction too: the daemon
   * clamps forward with `Math.min(sinceParam, stats.lastSeq)` and `hello`
   * absorbs that clamp with its own `Math.max`.
   */
  if (heldLast >= daemonLast) return { since: heldLast, keepHeld: true };
  // `read` is `WHERE seq > ?`, so this replays exactly the hole. If the daemon
  // has since pruned part of it, its `hello` reports `gap` and clamps us
  // forward, which the gap handling already covers.
  if (daemonLast - heldLast <= ATTACH_REPLAY_MAX) return { since: heldLast, keepHeld: true };
  return { since: daemonLast, keepHeld: false };
}

/** What a `lagged` frame means for the transcript: refetch it, or record a hole. */
export type GapPlan = { kind: "restart"; loadedFrom: number } | { kind: "record"; reason: Gap["reason"] };

/**
 * `backlog` is not a loss and must never be drawn as one — and must not be
 * *ignored* either, which is what the first version of this did.
 *
 * It says the **socket** declined to replay this far (`ATTACH_REPLAY_MAX` in
 * `server.ts`); every one of those events is on disk and
 * `GET /sessions/:id/events` serves them. So the answer is to go and fetch them —
 * and simply calling `loadAll` was not fetching them, because `loadAll` only ever
 * pages backwards from `loadedFrom` and this range sits *above* whatever is held.
 * `stream.ts` has by then advanced its own cursor to `to`, so its seq-continuity
 * check cannot fire either, and everything from `to + 1` was appended straight
 * onto the held events: a contiguous-looking transcript with the middle silently
 * absent, no `Gap`, no marker, and nothing anywhere saying so.
 *
 * Restarting at `to + 1` is the same choice `reattachSince` makes for a lag too
 * large to replay, for the same reason — the cost is refetching rather than a
 * hole to describe.
 *
 * The other two reasons are real losses and are recorded: `evicted` is the
 * daemon's retention having destroyed them, `slow_consumer` is this client
 * having failed to keep up, and `GapMarker` names both causes. Drawing either
 * over an intact conversation is the untrue message this split exists to
 * prevent — measured against the live database, a session reporting 3162 events
 * "not shown (beyond retention)" had every one of them still on the daemon,
 * whose own floor was thousands of seqs below.
 *
 * The record arm carries the narrowed reason rather than leaving the caller to
 * re-test it. `Gap["reason"]` has no `backlog` member, so "a backlog can never
 * be filed as a hole" stops being a rule somebody has to remember and becomes
 * the only thing that type-checks.
 */
export function gapPlan(reason: LaggedFrame["reason"], to: number): GapPlan {
  if (reason === "backlog") return { kind: "restart", loadedFrom: to + 1 };
  return { kind: "record", reason };
}

/** One window of history, filled forwards, and whether it reached what is held. */
export interface HistoryWindow {
  block: StoredEvent[];
  /**
   * The daemon's own floor, or `null` for "no page ever answered".
   *
   * Three answers rather than two, the same discipline `probeExists` and
   * `Liveness` carry on the daemon side: `0` is a real floor, and reporting
   * "could not tell" as one would have `EventList` announce that the start of
   * the conversation is gone.
   */
  firstSeq: number | null;
  /** The window reached `loadedFrom - 1`. Only then may it be prepended. */
  closed: boolean;
  /** Events actually taken, so the caller's budget is spent by what it received. */
  fetched: number;
}

/**
 * Fill `[loadedFrom - HISTORY_PAGE, loadedFrom - 1]` forwards, and say whether
 * it closed.
 *
 * A page is capped by **bytes** as well as by count (`EVENTS_PAGE_BYTES` 768 KiB
 * against `EVENTS_PAGE_LIMIT` 5000), and both event stores fill one by scanning
 * *ascending* from `since` and breaking — so a byte-capped page keeps its oldest
 * events and drops its **newest**. Anchoring `loadedFrom` on the page's first
 * event, which is what this used to do, therefore spliced the page's *last*
 * event straight onto the held window and left everything between them missing:
 * no `Gap`, no marker, and `loadedFrom` now *below* the hole, so paging never
 * returned to it. The byte cap bites first for anything but a trivial page —
 * `EVENTS_PAGE_BYTES / EVENTS_PAGE_LIMIT` is about 157 bytes an event, and one
 * `file_change` carrying content clears that on its own — so this fired on an
 * ordinary session open rather than in a corner. It was a narrower trap when the
 * page was 500 seqs against 2 MiB; both numbers have moved since, in the
 * direction that makes the byte cap the one that governs.
 *
 * So the window is filled forwards from its floor until it reaches the events
 * already held, and the caller commits it only if `closed`. Each call either
 * yields at least one usable event and moves `cursor` strictly forward, or ends
 * the window there and then — which is what stops a daemon whose floor is above
 * this window (or one that has stopped answering usefully) spinning against the
 * network.
 *
 * `budget` is spent **inside** the window rather than merely per window. A
 * byte-capped page turns one window into an unknown number of requests, so a
 * bound that only counted windows would not be a bound at all.
 */
export async function fillWindow(
  fetchPage: (since: number) => Promise<{ events: readonly StoredEvent[]; firstSeq: number }>,
  loadedFrom: number,
  budget: number,
): Promise<HistoryWindow> {
  const top = loadedFrom - 1;
  const block: StoredEvent[] = [];
  let cursor = Math.max(0, top - HISTORY_PAGE);
  let firstSeq: number | null = null;
  let fetched = 0;

  while (cursor < top && fetched < budget) {
    const page = await fetchPage(cursor);
    firstSeq = page.firstSeq;
    // `since` is exclusive and the window has a ceiling; anything outside either
    // end is the daemon answering a wider question than the one asked.
    const got = page.events.filter((stored) => stored.seq > cursor && stored.seq <= top);
    // The daemon answered and cannot go further — its floor is above this window,
    // or the caller has decided to stop. Either way there is no next `since` to
    // ask from, and asking the same one again is the spin.
    if (got.length === 0) break;
    block.push(...got);
    fetched += got.length;
    cursor = got[got.length - 1]!.seq;
  }

  return { block, firstSeq, closed: cursor >= top, fetched };
}

/** Why `loadAll` stopped paging. */
export type LoadStop = "start_of_log" | "cleared" | "held_full";

/** What `loadStop` needs to know, which is four numbers and not the events themselves. */
export interface LoadState {
  loadedFrom: number;
  /** The lowest seq the daemon still holds. Below it there is nothing to ask for. */
  daemonFirstSeq: number;
  clearedAt: number | null;
  revealedBeforeClear: boolean;
  /** How many events are held. A count, so the ceiling can be asserted without 50 000 objects. */
  heldEvents: number;
  /** Roughly how many bytes those are — the ceiling that actually decides. */
  heldBytes: number;
}

/**
 * Whether there is anything left worth fetching, asked before a window is tried.
 *
 * Three of the four ways `loadAll` stops, in the order it asks them. The fourth —
 * a window that cannot be filled — is `fillWindow`'s `closed` and is not
 * knowable until a window has been attempted, so it is asserted there rather
 * than restated here as an arm somebody would then have to keep in step.
 *
 *   - `start_of_log` — the ordinary ending, and it is **`max(1, daemonFirstSeq)`
 *     rather than 1**. See below.
 *   - `cleared` — the agent's own cut, and the bottom of what is worth showing.
 *     `revealedBeforeClear` is what carries on past it.
 *   - `held_full` — `MAX_TRANSCRIPT_BYTES`, the tab's own and **only** ceiling.
 *     Without it a terminal session — which receives no events and so never
 *     reaches `onEvents`' trim at the other end — grew on every single open, for
 *     ever. It was an event count and is deliberately no longer one; the reasoning
 *     is at the constant.
 *
 * **There was a `budget` arm and it is gone, parameter and all.** It fired at
 * `MAX_AUTO_HISTORY` and left the rest of the conversation on the daemon behind a
 * button reading "N earlier events did not load — try again" — which is this
 * client reporting its own bookkeeping as a failure, on the one screen whose job
 * is to show a conversation. That constant survives as `loadAll`'s **yield**
 * chunk, not as a stop; removing the parameter is what stops it being reintroduced
 * by accident.
 *
 * **The floor arm is the guard that makes self-healing affordable**, and it is
 * new. Nothing here read `daemonFirstSeq`, which was harmless while `loadAll` ran
 * once per open: a legacy session whose oldest surviving event is seq 6145 sits at
 * `loadedFrom === 6145` and can never reach 1, so this answered `null` for ever
 * and the loop went one fruitless request further every time it was called. With
 * `attachWanted` re-driving on every 4s poll that is a permanent request loop, on
 * exactly the sessions least able to answer it. `max(1, daemonFirstSeq)` is the
 * *same expression* `EventList` computes as `unfetched === 0` — one rule, two
 * readers — and the `max` matters because `daemonFirstSeq` is 0 for "no page has
 * answered yet", which must behave as 1 rather than as "everything is fetched".
 *
 * The order is part of the rule and not incidental. `cleared` is asked before
 * `held_full` so a cut conversation reports the cut, and `start_of_log` before
 * everything because there is nothing below it to have an opinion about.
 */
export function loadStop(held: LoadState): LoadStop | null {
  if (held.loadedFrom <= Math.max(1, held.daemonFirstSeq)) return "start_of_log";
  if (held.clearedAt !== null && !held.revealedBeforeClear) return "cleared";
  // One ceiling, and it is bytes — see `MAX_TRANSCRIPT_BYTES` for why the event
  // count that used to be beside this is deleted rather than raised.
  if (held.heldBytes >= MAX_TRANSCRIPT_BYTES) return "held_full";
  return null;
}

/** What a transcript says above its rows about not starting at its own beginning. */
export type TranscriptNotice =
  | { kind: "skeleton" }
  | { kind: "loading"; earlier: number }
  | { kind: "stalled"; earlier: number }
  /**
   * `held` rather than the constant: with two quantities able to raise this stop —
   * a byte ceiling and a count — the number in the sentence has to be what is
   * actually on screen, or it reports 50 000 events about a tab holding 6000.
   */
  | { kind: "ceiling"; held: number }
  | { kind: "floor"; destroyed: number }
  /**
   * Nothing has arrived and nothing is outstanding.
   *
   * **This is a partition over the *transcript*, not over the screen, so `empty` and
   * a working agent can be true at the same time** — and on a session you have just
   * created they routinely are, because the daemon's first rows are all in
   * `TRANSCRIPT_SILENT` while the agent is already starting. `EventList` draws the
   * empty sentence and `footSays` draws `working…` underneath it, and neither knows
   * the other exists.
   *
   * Harmless today: the two say different true things. Written down because it is
   * the seam where a seventh arm produces a *contradiction* rather than a pair —
   * the `switch` with no `default` in `noticeText` will force that arm to be
   * written, and it cannot force it to agree with the foot.
   */
  | { kind: "empty" }
  | null;

/** What {@link transcriptNotice} reads: {@link LoadState} plus what is on screen. */
export interface NoticeState extends LoadState {
  loadingHistory: boolean;
  /**
   * Rows the transcript actually draws — **not** `heldEvents`.
   *
   * The two are wildly different and the difference is why this is a parameter
   * rather than something derived here: measured on the live log, the newest 500
   * of a 1285-event session draw **one** row, and 2856 events draw 14. So "is
   * anything on screen" cannot be answered from a count of events.
   */
  rows: number;
}

/**
 * Why this conversation does not start at its beginning, as one answer.
 *
 * **Six states, one function, and the reason it exists is that they were five
 * booleans in JSX and nothing could assert that they covered the space.** They
 * did not. `awaitingHistory` required `rows.length === 0`, `showFloor` required
 * `unfetched === 0`, `atCeiling` required 20 000 held events and the reveal
 * button required a `/clear` marker — so the ordinary state of a reload,
 * *rows on screen with thousands of events still missing*, fell through every
 * one of them and drew **nothing at all**. Rendered under `react-dom/server`, the
 * markup above the rows is byte-identical for "newest 500 of 2856 held" and "all
 * 2856 held": 48 characters, the bare column `<div>`. The `role="status"` region
 * was empty in that state too, so a screen reader got the same silence.
 *
 * A conversation that begins mid-word — measured, the top row at 1000 held events
 * of `s_cdea4faa` starts `"ntract roles (guardian = timelock, …"`, the tail of a
 * phrase cut mid-word —
 * presented as a complete one is the failure `EventList`'s own floor line was
 * written against.
 *
 * The arms mirror `loadStop`'s, in its order, because the two answer the same
 * question from opposite ends: that one decides whether paging carries on, this
 * one says why it is not there yet. A state where `loadStop` says `null` (paging
 * is still willing) and this says `null` (nothing to report) is precisely the hole
 * that was here, so `webcheck` asserts the pair rather than either alone.
 *
 *   - `null` under a cut, because the reveal button is the thing to read there and
 *     `unfetched` is enormous by construction — everything above the marker.
 *   - `floor` / `empty` — paging has reached the bottom. `showFloor` used to
 *     require `!loadingHistory`; dropped, because at `unfetched === 0` the
 *     destroyed prefix is a permanent fact about the daemon that no run can
 *     change, and the arm existed only to avoid a one-frame flash.
 *   - `ceiling` before `skeleton`, so a tab that is genuinely full says so rather
 *     than showing a placeholder for events it has decided not to hold.
 *   - `loading` / `stalled` — the two new ones, and they are split because a
 *     sentence has to be true in the state it is drawn in: one run is in flight,
 *     the other has spent its schedule and is waiting for `attachWanted` on the
 *     next poll that a session list survives. Neither offers an action, for the
 *     reason the "try again" button was deleted: there is nothing for the reader
 *     to do and the client retries by itself.
 */
export function transcriptNotice(held: NoticeState): TranscriptNotice {
  if (held.clearedAt !== null && !held.revealedBeforeClear) return null;
  const destroyed = held.daemonFirstSeq > 1 ? held.daemonFirstSeq - 1 : 0;
  const unfetched = Math.max(0, held.loadedFrom - Math.max(1, held.daemonFirstSeq));
  if (unfetched === 0) {
    if (destroyed > 0) return { kind: "floor", destroyed };
    return held.rows === 0 ? { kind: "empty" } : null;
  }
  // Asked of `loadStop` rather than restated, so the sentence cannot claim a ceiling
  // the loader does not believe in — they read the same two fields and there are two
  // of them now.
  if (loadStop(held) === "held_full") return { kind: "ceiling", held: held.heldEvents };
  if (held.rows === 0) return { kind: "skeleton" };
  return held.loadingHistory ? { kind: "loading", earlier: unfetched } : { kind: "stalled", earlier: unfetched };
}

/**
 * How long to wait before asking for the same page again, or `null` to stop.
 *
 * `loadAll` used to answer this with `catch {}`: one dropped request — a radio
 * handing over, a relay blipping — left the transcript empty for the life of the
 * tab, because nothing re-drives it (`SessionView`'s effect never fires again and
 * `attachWanted` skipped any key that already had a stream). What the reader got
 * was a button asking them to do by hand what the client had simply not retried.
 *
 * **The schedule is the load-bearing half, not the classification, and the first
 * version of this had that the wrong way round.** It retried transport failures
 * only, on `[500, 2000]`, and argued the point at length: an `ApiError` is the
 * relay *answering*, so asking again gets the same answer. Measured against the
 * live database with the real store, that argument is refuted by its own
 * favourable case — the identical eight-second outage delivered as **transport**
 * failures, which the old function did retry, left a byte-identical transcript
 * (`loadedFrom=1357`, `span=[1357..2878]` of 2878). 2.5 s of schedule is shorter
 * than any outage worth surviving, so the classification only decided *which*
 * flavour of the same truncation you got.
 *
 * So both halves moved. `meansLater` admits the three answered refusals that
 * describe a route coming back on its own (see it for why `machine_over_limit`
 * and `owner_disabled` are not among them), and the schedule now covers the
 * thing it has to survive: **the daemon's own redial, which is 1 s→30 s with
 * full jitter**, so a relay recreated by a deploy answers `no_tunnel` for up to
 * half a minute. Five waits totalling 37.5 s.
 *
 * A fixed table rather than jitter, deliberately: it is pure, so `webcheck`
 * asserts it, and there is no herd to spread — at most `MAX_LIVE_STREAMS` runs
 * exist per tab, against a relay that is not being protected from three
 * requests. The 500 ms first step is *too early* for a `no_tunnel` (the daemon's
 * first redial lands around a second in) and costs one wasted request; kept
 * anyway, because a second schedule per error class is a second thing to keep in
 * step and the same step is exactly right for a radio handing over.
 *
 * **The cost is a longer latch, and that is only acceptable because it is now
 * visible.** `machine.request` burns a route re-probe plus a replayed GET
 * internally, so each attempt is up to two fetches against the 15 s request
 * timeout: six attempts against a black-holing relay is minutes with
 * `loadingHistory` held. Silently, that would be the defect this fixes wearing a
 * longer coat — `transcriptNotice`'s `loading` arm is what makes it a sentence on
 * screen instead, and the two changes are one change.
 */
export const HISTORY_RETRY_MS: readonly number[] = [500, 2_000, 5_000, 10_000, 20_000];

export function historyRetry(attempt: number, error: unknown): number | null {
  if (!isTransportFailure(error) && !meansLater(error)) return null;
  return HISTORY_RETRY_MS[attempt] ?? null;
}

/** A delay, as a promise. `0` is a macrotask, which is how `loadAll` yields. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * {@link loadStop} asked of a whole transcript, or `null` when there is none.
 *
 * Two callers inside `loadAll` — the check that runs *before* the latch and the
 * one at the top of each turn of the loop — and writing the five fields out twice
 * is how the two come to disagree about which stop applies. An absent transcript
 * answers `null` rather than a stop, because "there is nothing here yet" is the
 * state a first load starts in.
 */
function stopFor(held: Transcript | undefined): LoadStop | null {
  if (held === undefined) return null;
  return loadStop({
    loadedFrom: held.loadedFrom,
    daemonFirstSeq: held.daemonFirstSeq,
    clearedAt: held.clearedAt,
    revealedBeforeClear: held.revealedBeforeClear,
    heldEvents: held.events.length,
    heldBytes: held.heldBytes,
  });
}

/**
 * Where a batch arriving down the socket leaves the `/clear` cut.
 *
 * A `/clear` arriving live cuts the transcript the same way one found by paging
 * does — it is the same fact, and which side of the socket it came from is not
 * something the reader should be able to tell.
 *
 * Newest in the batch wins, and it clears `revealedBeforeClear` with it: having
 * asked to see what was above the *previous* cut is not a standing request to
 * see everything above every future one. Clearing again means clearing again.
 *
 * A batch with no marker changes neither field, and that is the overwhelmingly
 * ordinary case — every streamed token takes it. It is written as a walk that
 * finds nothing rather than as a branch in front of one, which is what keeps
 * "newest wins" a single rule instead of two that can disagree.
 */
export function nextCut(
  clearedAt: number | null,
  revealedBeforeClear: boolean,
  batch: readonly StoredEvent[],
): { clearedAt: number | null; revealedBeforeClear: boolean } {
  let cut = clearedAt;
  let revealed = revealedBeforeClear;
  for (const stored of batch) {
    if (stored.event.type !== "context_cleared") continue;
    cut = stored.seq;
    revealed = false;
  }
  return { clearedAt: cut, revealedBeforeClear: revealed };
}

/** What to do about a session's command list, given what is held and what the daemon says. */
export type CommandsPlan = "fetch" | "drop" | "defer" | "current";

/**
 * The command-list cache rule, as a pure function.
 *
 * Out here rather than inline in `ensureCommands` for the reason `keys.ts` and
 * `commands.ts` are out here: `webcheck` has no daemon to drive, and every one of
 * these four answers fails *silently*. Three of them were written as prose in a
 * docblock, contradicted by the code underneath, and nothing could tell.
 *
 * - `drop` — the daemon says 0 or says nothing. Both mean no agent has published,
 *   so anything held is a *dead* agent's list and is deleted rather than merely
 *   left unfetched. Returning with it intact is what kept a restarted daemon's
 *   composer offering the previous agent's commands.
 * - `defer` — a request is already out. The caller records the wanted revision and
 *   re-drives when it lands; dropping the call outright strands the client on a
 *   superseded list for ever, because the effect that calls this is keyed on the
 *   revision and will not fire again.
 * - `current` — what is held matches. `!==`, never `>`: a restart puts the number
 *   back to 0 while a client still holds 5, and 5 is the stale one.
 */
/**
 * The controls to keep across a window in which there is no agent to publish any.
 *
 * The daemon empties `agentConfig` the moment the agent goes — "the controls
 * belong to the live agent, so they go with it" — and a session restored from
 * disk starts empty for the same reason. Both are right about the *daemon*: those
 * describe what an agent will accept right now. What they leave behind on screen
 * is a composer whose whole row of controls blinks out of existence for the
 * length of a restart, which is every deploy, every auto-resume, and now every
 * time somebody changes ultracode.
 *
 * **The live agent always wins, including when it publishes nothing**, which is
 * the arm that does the work: without `hasLiveAgent` this could not tell an agent
 * that genuinely has no controls from a session that has no agent, and would pin
 * a dead set of chips on a running session for ever.
 *
 * Not recovered from the transcript's `agent_config` event, which is the tempting
 * source: that copy is pre-`snapshotConfig`, so it is undeduped and carries none
 * of the daemon's own additions. The rule here is the one the config bar already
 * lives by — state comes from the snapshot, only prose comes from the log.
 */
export function holdConfig(
  held: AgentConfig | undefined,
  session: Pick<SessionSnapshot, "status" | "agentConfig">,
): AgentConfig | undefined {
  const live = session.agentConfig;
  if ((live?.options.length ?? 0) > 0) {
    /*
     * Merged by id rather than replaced, which is the second thing this memory
     * is for. An agent drops a control when the *model* stops offering it —
     * measured: claude builds the effort list from the current model's
     * `supportedEffortLevels`, so choosing Haiku deletes the effort option
     * outright — and a strip that simply loses a button leaves the row a
     * different shape than it was a moment ago, with nothing saying why. Keeping
     * the last version of every control ever seen is what lets `drawnControls`
     * draw the slot and mark it unavailable.
     *
     * Live always wins for a control that is still there; order follows the live
     * set, so a control the agent has stopped publishing sits after the ones it
     * still does rather than holding a place in the middle.
     */
    const byId = new Map((live?.options ?? []).map((option) => [option.id, option]));
    const dropped = (held?.options ?? []).filter((option) => !byId.has(option.id));
    if (dropped.length === 0) return live;
    return { modes: live?.modes ?? null, options: [...(live?.options ?? []), ...dropped] };
  }
  if (hasLiveAgent(session.status)) return live;
  return held;
}

export function commandsPlan(
  held: number | undefined,
  revision: number | undefined,
  inFlight: boolean,
): CommandsPlan {
  if (revision === undefined || revision === 0) return "drop";
  if (held === revision) return "current";
  if (inFlight) return "defer";
  return "fetch";
}

/**
 * One session's slash commands, and how many the daemon had to cut.
 *
 * The pair travels together rather than the list alone, because `dropped` is the
 * whole reason the daemon counts instead of silently trimming — a picker offering
 * less than the agent supports, with nothing saying so, is the failure both
 * `AgentCommands` in `events.ts` and `toCommands` in `session.ts` name by hand.
 */
export interface AgentCommandList {
  commands: readonly AgentCommand[];
  dropped: number;
}

export interface AppState {
  /**
   * `"signed_out"` rather than `"needs_key"`: it names the state, and the remedy
   * is no longer a key somebody pastes.
   */
  phase: "signed_out" | "loading" | "ready";
  me: Me | null;
  machines: MachineState[];
  sessions: SessionRow[];
  /**
   * The same rows, keyed.
   *
   * `sessions` is for rendering a list; this is for answering "the row for this
   * key", which `SessionView` asks three times per render and which was three
   * linear scans over an array that holds every session from every machine.
   */
  rowsByKey: ReadonlyMap<SessionKey, SessionRow>;
  /**
   * Machines whose session list has landed at least once this page load.
   *
   * The difference between "this session is not on that daemon" and "we have not
   * asked yet", which nothing could tell apart before: `SessionView` reads
   * `rowsByKey` and, finding nothing, said the session was missing — on a cold
   * reload straight onto a session URL that is the *ordinary* first second, since
   * `bootstrap` promotes to `phase: "ready"` on the machine list and the session
   * list is three round trips further on (token, route probe, `GET /sessions`).
   *
   * A set rather than a field on `MachineState` because it is a fact about what
   * *this store* has fetched, not about the machine — `MachineConnection` would
   * have to be told, and it is the wrong owner. Dropped with the machine in
   * `dropMachine`, so a re-granted machine is unknown again rather than
   * confidently empty.
   */
  listed: ReadonlySet<MachineId>;
  transcripts: ReadonlyMap<SessionKey, Transcript>;
  /**
   * What each session's agent publishes as slash commands.
   *
   * Fetched per session rather than carried on the snapshot, and only for a
   * session somebody has opened — see `SessionSnapshot.commandsRevision`. A
   * missing entry means "not fetched", which the composer draws exactly as it
   * draws an empty list: no menu.
   *
   * `dropped` is carried through rather than discarded on arrival. The daemon
   * counts it precisely so a picker does not silently offer less than the agent
   * supports (`events.ts`'s `AgentCommands`, `session.ts`'s `toCommands`), and a
   * client that reads only `commands` makes that counter prove nothing.
   */
  commands: ReadonlyMap<SessionKey, AgentCommandList>;
  /** The control plane itself failed. Not fatal while cached tokens are alive. */
  cpError: string | null;
  /**
   * What this instance allows, or `null` while it is unknown.
   *
   * `null` is a first-class state rather than a loading placeholder: a control
   * plane rolled back past the release that added `/v1/instance` answers 404,
   * and that is **not an outage** and must not draw one. `gate.ts`'s predicates
   * each answer for `null`, and they answer it in opposite directions on
   * purpose — see `gateOffer` and `adminMayInvite`.
   */
  config: InstanceConfig | null;
  /**
   * Why the app signed you out while you were using it, or `null`.
   *
   * Split out of `cpError`, which it used to share. `cpError` is the amber
   * "running on tokens already issued" banner `Home` and `AppShell` draw; a dead
   * credential wrote a completely different sentence into the same field and the
   * gate read it back. There are three of those sentences — expired, revoked,
   * disabled — and none of them is a control-plane outage.
   *
   * Never set by a sign-in somebody *submitted*: `SignIn` holds that error itself,
   * beside the field it is about.
   */
  authError: string | null;
  resuming: boolean;
  lastResumeAt: number | null;
}

const EMPTY_TRANSCRIPT: Transcript = {
  events: [],
  gaps: [],
  heldBytes: 0,
  loadedFrom: 0,
  daemonFirstSeq: 0,
  clearedAt: null,
  revealedBeforeClear: false,
  loadingHistory: false,
  stream: null,
};

class AppStore implements StreamSink {
  private listeners = new Set<() => void>();
  private snapshot: AppState = {
    phase: cp.currentCredential() === null ? "signed_out" : "loading",
    me: null,
    machines: [],
    sessions: [],
    rowsByKey: new Map(),
    listed: new Set(),
    transcripts: new Map(),
    commands: new Map(),
    cpError: null,
    config: null,
    authError: null,
    resuming: false,
    lastResumeAt: null,
  };

  private connections = new Map<MachineId, MachineConnection>();
  private daemons = new Map<MachineId, DaemonClient>();
  /** See {@link AppState.listed}. */
  private listed = new Set<MachineId>();
  private rows = new Map<SessionKey, SessionRow>();
  private transcripts = new Map<SessionKey, Transcript>();
  /**
   * Which *life* of a transcript a history run belongs to.
   *
   * `loadingHistory` is a field on the transcript, so the two places that
   * **replace** a transcript rather than update it — `openSession`'s
   * `keepHeld: false` and `onGap`'s restart arm — reset the latch to
   * `EMPTY_TRANSCRIPT`'s `false` under a run that is parked on `fillWindow`, and
   * both then call `loadAll` on their next line. The guard reads `false`, a
   * second loop starts, and from there both loops read the same `loadedFrom`
   * before either writes one: they fetch the same window and prepend it twice.
   * Measured against this store — a `lagged{backlog}` landing while the open's
   * own `loadAll` was in flight gave 10 000 held events of which 2 500 were
   * duplicates, out of seq order.
   *
   * So a replacement bumps this, a run captures it, and a run whose generation
   * has moved abandons what it fetched instead of prepending it onto a
   * transcript that is not the one it was reading.
   */
  private transcriptGen = new Map<SessionKey, number>();
  private streams = new Map<SessionKey, SessionStream>();
  /** Most-recently-viewed last. The LRU that bounds live sockets. */
  private streamOrder: SessionKey[] = [];
  private nextProbeAt = new Map<MachineId, number>();
  /** Blocked sessions whose context has already been fetched. */
  private primed = new Set<SessionKey>();
  /**
   * The command list per session, filed under the revision it was fetched at.
   *
   * The revision is what makes this a cache rather than a one-shot: claude
   * republishes mid-session as skills are discovered, so a client that fetched
   * once and kept it for ever would be right on kimi and wrong on claude.
   */
  private commandLists = new Map<SessionKey, { revision: number; commands: AgentCommand[]; dropped: number }>();
  private commandsInFlight = new Set<SessionKey>();
  /**
   * A revision that arrived while a fetch was already out, to chase afterwards.
   *
   * The in-flight guard drops such a call, and the effect that produced it is
   * keyed on the revision — so without this the drop is permanent. Newest wins;
   * there is no queue, because only the latest list is worth having.
   */
  private commandsWanted = new Map<SessionKey, number>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private resumeInFlight: Promise<void> | null = null;
  private resumeQueued = false;
  /**
   * Bumped by every resume. Work tagged with an older epoch is discarded when it
   * returns, so a slow probe from before a network change cannot overwrite the
   * answer from after it.
   */
  private epoch = 0;

  /* ---------------------------------------------------------------- *
   * React glue
   * ---------------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.snapshot;

  /*
   * Three cached derivations, invalidated by what actually changed.
   *
   * `emit` used to rebuild all three unconditionally, and it is called once per
   * streamed event: a single text delta from one session on one machine therefore
   * rebuilt the machine list, materialised every session row from every machine
   * (retention is 200 per machine), and cloned the whole transcripts Map. During a
   * talking turn that is tens of times a second on a phone, and because each
   * rebuild produced fresh array identities, every consumer downstream was
   * invalidated whether or not its own data had moved.
   *
   * `null` means "rebuild on next read". `emit()` still invalidates everything, so
   * every existing caller keeps its exact semantics; the hot paths call
   * `emitTranscripts()` instead, which is the only thing they actually change.
   */
  private machinesCache: MachineState[] | null = null;
  private sessionsCache: SessionRow[] | null = null;
  private rowsByKeyCache: ReadonlyMap<SessionKey, SessionRow> | null = null;
  private listedCache: ReadonlySet<MachineId> | null = null;
  private transcriptsCache: ReadonlyMap<SessionKey, Transcript> | null = null;
  private commandsCache: ReadonlyMap<SessionKey, AgentCommandList> | null = null;

  /** Everything may have changed. The safe default, and what most callers want. */
  private emit(): void {
    this.machinesCache = null;
    this.sessionsCache = null;
    this.rowsByKeyCache = null;
    this.listedCache = null;
    this.transcriptsCache = null;
    this.commandsCache = null;
    this.publish();
  }

  /**
   * Only a transcript changed — no machine, no session row.
   *
   * This is the per-event path. Keeping the machine and session arrays at their
   * existing identities is the whole point: `Home`'s memoised derivations and the
   * machine list then do not recompute when a session nobody is looking at emits a
   * line of text.
   */
  private emitTranscripts(): void {
    this.transcriptsCache = null;
    this.publish();
  }

  private publish(): void {
    this.machinesCache ??= [...this.connections.values()].map((c) => c.state());
    this.sessionsCache ??= [...this.rows.values()];
    this.rowsByKeyCache ??= new Map(this.rows);
    this.listedCache ??= new Set(this.listed);
    this.transcriptsCache ??= new Map(this.transcripts);
    this.commandsCache ??= new Map(
      [...this.commandLists].map(([key, entry]) => [key, { commands: entry.commands, dropped: entry.dropped }] as const),
    );
    this.snapshot = {
      ...this.snapshot,
      machines: this.machinesCache,
      sessions: this.sessionsCache,
      rowsByKey: this.rowsByKeyCache,
      listed: this.listedCache,
      transcripts: this.transcriptsCache,
      commands: this.commandsCache,
    };
    for (const listener of this.listeners) listener();
  }

  private patch(fields: Partial<AppState>): void {
    this.snapshot = { ...this.snapshot, ...fields };
    this.emit();
  }

  /* ---------------------------------------------------------------- *
   * Bootstrap
   * ---------------------------------------------------------------- */

  async bootstrap(): Promise<void> {
    /*
     * **Above the credential check, and that placement is the whole of it.**
     *
     * The early return below is exactly the path that leads to `SignIn`, so a
     * `loadConfig` underneath it would never run for the one screen that needs
     * it — the signed-out screen decides whether to offer "Create an account"
     * and "Forgot password?" from this. This is the single most likely line in
     * the file to be tidied into the wrong place, which is why it is asserted
     * behaviourally rather than only commented.
     *
     * Fire-and-forget: nothing here waits on it, and the screen renders its
     * links from `null` until it lands.
     */
    void this.loadConfig();

    if (cp.currentCredential() === null) {
      this.patch({ phase: "signed_out" });
      return;
    }
    this.patch({ phase: "loading", cpError: null });

    try {
      const [me, machines] = await Promise.all([
        cp.me(),
        /*
         * **Tolerant of the wall, and only of the wall.**
         *
         * An account that owes a password change is refused every route below
         * THE SECOND LINE, and this listing is one of them. Left to reject, the
         * `Promise.all` sends the whole bootstrap into the catch below, which
         * keeps `phase: "loading"` and sets `cpError` — so somebody who simply
         * has to choose a password sees a spinner and an outage banner instead
         * of the screen that fixes it.
         *
         * Keyed on the code and never the status, `authFailure`'s rule: a bare
         * `403 forbidden` is `requireAdmin`'s and is a genuine failure here.
         *
         * Sequencing `me` first would also work and is worse: it puts a second
         * round trip on the cold-start path, which `runResume` explicitly argues
         * against.
         */
        cp.machines().catch((error: unknown) => {
          if (ApiError.isApiError(error) && error.code === "password_change_required") return [];
          throw error;
        }),
      ]);
      for (const record of machines) {
        const id = machineId(record.id);
        const existing = this.connections.get(id);
        if (existing) {
          existing.update(record);
        } else {
          this.connections.set(id, new MachineConnection(record, () => this.emit()));
        }
      }
      // Machines whose grant was revoked while we were running.
      for (const id of [...this.connections.keys()]) {
        if (!machines.some((m) => m.id === id)) this.dropMachine(id);
      }
      for (const [id, connection] of this.connections) {
        if (!this.daemons.has(id)) this.daemons.set(id, new DaemonClient(connection));
      }
      this.patch({ phase: "ready", me, cpError: null, authError: null });
    } catch (error) {
      /*
       * `cpFetch` has already cleared the credential and called `signedOut` for a
       * failure that means one — this is the *arrival* of that same rejection, and
       * all it has to do is stop.
       *
       * It used to be `status === 401 || status === 403`, here, and that test was
       * correct only because the browser never called an admin route. It does now:
       * `requireAdmin` answers `403 forbidden` to every non-admin, so under the old
       * test opening the Users section would have signed a non-admin out of the
       * whole app. `authFailure` keys on the code for exactly that reason.
       */
      if (authFailure(error) !== null) return;
      /*
       * The control plane is unreachable. If we already know about machines and
       * hold valid tokens for them, that is a degraded state, not a dead app —
       * every daemon and every agent is still running and still reachable.
       *
       * `connections.size > 0` belongs to *this* arm and must not be read as the
       * general rule for what a usable app is. It is what can be salvaged from a
       * fetch that **failed**: with no registry there is nothing to show and
       * nothing to say about it. `runResume`'s promotion is the opposite case —
       * the fetch resolved — so it asks only whether we are still on the spinner,
       * and an empty registry there is an answer rather than an absence. The two
       * were once the same expression, and that is what left a machineless
       * account loading for ever.
       */
      this.patch({
        phase: this.connections.size > 0 ? "ready" : "loading",
        cpError: describe(error),
      });
    }

    this.startPolling();
    await this.resume("bootstrap");
  }

  private dropMachine(id: MachineId): void {
    for (const [key, row] of this.rows) {
      if (row.ref.machineId === id) {
        this.forgetSession(key);
      }
    }
    this.connections.delete(id);
    this.daemons.delete(id);
    // Unknown again rather than confidently empty: a machine that comes back is
    // one nothing has listed yet, and saying otherwise would put "that session is
    // not on this daemon" on screen for the whole of its first poll.
    this.listed.delete(id);
    this.nextProbeAt.delete(id);
  }

  /**
   * What this instance allows, for the screen that has no credential yet.
   *
   * **The catch is bare and that is load-bearing.** A control plane rolled back
   * past the release that added `/v1/instance` answers 404, which `readJson`
   * turns into an `ApiError`. That is not an outage: drawing `cpError` for it
   * would put an alarming banner on a working sign-in screen. `config` stays
   * `null`, which every predicate that reads it answers for.
   */
  private async loadConfig(): Promise<void> {
    try {
      this.patch({ config: await cp.instanceConfig() });
    } catch {
      // See above. An older control plane is not a failure to report.
    }
  }

  /**
   * Re-read the instance configuration now, because an admin just changed it.
   *
   * **This is the caller the gate on `runResume` claims exists.** That gate skips
   * the refresh unless `config === null`, justified by "when an admin changes it
   * the Server settings screen patches `config` from its own authoritative
   * answer" — and no such patch was ever written. `ServerSection` kept the answer
   * in component state, so configuring SMTP left `state.config.email` false until
   * a full page reload, and `adminMayInvite` — which fails closed — went on
   * hiding the address field on Settings → Users. The admin configures mail and
   * the product carries on saying it has none.
   *
   * A re-read rather than a projection of what the settings screen holds: that
   * screen's answer is the *admin* shape (`{settings, mail, registration}`) and
   * this is the *public* one, so mapping between them here would put the
   * precedence rule in a second place. One extra request, only when somebody
   * presses Save on the one screen that can change it.
   */
  async refreshConfig(): Promise<void> {
    await this.loadConfig();
  }

  /**
   * Sign in. Rejects rather than reporting — `SignIn` shows its own error, beside
   * the field it is about.
   */
  async login(name: string, password: string): Promise<void> {
    const me = await cp.login(name, password);
    this.patch({ me, authError: null });
    await this.bootstrap();
  }

  /**
   * Adopt a session the server minted on a gate screen — a confirmation, a
   * reset, or an invitation.
   *
   * **It drops every connection first**, and that is `handleSignedOut`'s reason
   * rather than tidiness: this is reachable from `phase: "ready"`, so the tab may
   * already be showing somebody else's fleet, and each of those connections holds
   * a token minted from a credential that is about to stop being the one in use.
   * Without the drop the previous person's machines paint for a frame and their
   * sockets keep talking.
   *
   * `login` has the same latent hole and is safe only because `SignIn` is
   * reachable only from `phase: "signed_out"`, which `handleSignedOut` reaches
   * only after dropping them. Nothing but that ordering enforces it.
   */
  async adoptSession(token: SessionToken): Promise<void> {
    this.stopPolling();
    for (const id of [...this.connections.keys()]) this.dropMachine(id);
    cp.setSession(token.token);
    this.patch({ me: token.user, authError: null });
    await this.bootstrap();
  }

  /*
   * `useApiKey` lived here and is deleted with the field that fed it.
   *
   * The sign-in screen no longer takes an `rk_`, so this had no caller — and a
   * callerless export describing a capability the product does not have is the
   * exact situation `myKeys`/`revokeMyKey` were in before this change, and the
   * reason they were finally wired up rather than left.
   *
   * **What is kept is the reading half**: `pickStored` and `readStoredCredential`
   * still adopt a stored `rk_`, because a tab that was open before this deploy is
   * holding one and a deploy must not sign the fleet out. `callerAuth` takes it
   * unchanged, and `cpctl` is the way in for an account that has only a key.
   */

  /**
   * Re-read `/v1/me`, and nothing else.
   *
   * **The one request its callers actually wanted.** Settings → Account called
   * `resume("password-changed")` to pick up `hasPassword` after setting a first
   * password — and `runResume` re-lists *machines*; `cp.me()` is called from
   * `bootstrap` alone. So the flag never moved: the form stayed in its
   * first-time shape with no current-password box, and the next submit answered
   * `400 currentPassword is required` about a field that was not on screen. It
   * also spent a full per-machine wake — token refresh, route re-probe, session
   * re-list, socket reconnect — for one boolean, which is not what that
   * method's "one request" comment meant.
   *
   * A transport failure is swallowed: `me` is already held and stale-by-one-field
   * beats blanking the account screen. A failure that means the credential is
   * finished has already signed this tab out inside `cpFetch`, so there is
   * nothing left here to decide.
   */
  async refreshMe(): Promise<void> {
    try {
      const me = await cp.me();
      this.patch({ me });
    } catch {
      // See above. Deliberately empty: every outcome worth acting on has been
      // acted on before this catch is reached.
    }
  }

  /**
   * The fleet changed **and** what this account is allowed changed.
   *
   * Two facts, one call, because `runResume` re-lists machines and refreshes
   * `me` only on a `loading → ready` promotion — so adding or retiring a machine
   * moved `machineCount`, which is the number the limit is enforced against, and
   * nothing re-read it. The visible symptom is the add form still drawn on the
   * screen that just consumed the last slot: a control that is not true in the
   * state it is drawn in.
   *
   * A named method rather than two calls at each site, because there will be a
   * third mutation site one day and a name is what the next author reaches for —
   * and because it makes "no creation path goes through `resume` alone" a thing
   * `webcheck` can read off the file.
   */
  async machinesChanged(reason: string): Promise<void> {
    await Promise.all([this.resume(reason), this.refreshMe()]);
  }

  /**
   * The app signed you out without being asked. Registered on `cp.onSignedOut`.
   *
   * Connections are dropped rather than left behind: signing back in *as somebody
   * else* in the same tab would otherwise paint the previous user's fleet for a
   * frame, and every one of them holds a token minted from a credential that is
   * now gone.
   */
  handleSignedOut(failure: AuthFailure): void {
    this.stopPolling();
    for (const id of [...this.connections.keys()]) this.dropMachine(id);
    this.patch({ phase: "signed_out", me: null, cpError: null, authError: signedOutText(failure) });
  }

  /**
   * Sign out, server-side first, then reload.
   *
   * This method existed since this file was written and was never called —
   * Settings did `cp.clearApiKey()` and `window.location.href = "/"` instead. The
   * reload argument in that comment survives and is why the in-memory unwind here
   * is *deleted* rather than fixed: every machine's token, route memo and socket
   * was derived from this credential, unwinding them individually is a longer list
   * than it looks, and the reload path is exercised on every page load while the
   * unwind never ran once.
   *
   * What is new is the order. `DELETE /v1/me/sessions/current` has to land before
   * the navigation, or the session stays valid on the control plane for its whole
   * lifetime and the only thing that changed is that this tab forgot it. Its
   * failure is swallowed inside `cp.logout`: a control plane that is down must not
   * be able to trap somebody in an app they are trying to leave.
   *
   * **One harmless race, named so nobody fixes it.** Signing out of a session
   * that has *already* expired makes `cpFetch` answer `401 session_expired`,
   * which fires the signed-out handler — so `handleSignedOut` runs mid-logout,
   * drops every connection and patches `authError` with "Your session expired".
   * That state is then discarded a line later by the reload, which is the whole
   * point of reloading. Nothing needs to suppress it: the two paths agree about
   * the outcome and disagree only about how much work they do to reach it.
   */
  async signOut(): Promise<void> {
    await cp.logout();
    window.location.href = "/";
  }

  /* ---------------------------------------------------------------- *
   * The resume path
   * ---------------------------------------------------------------- */

  /**
   * Wake up: refresh tokens, re-probe routes, re-list sessions, reconnect sockets.
   *
   * Four steps for N machines, and every one of them can fail. This is the single
   * place they happen, deliberately — the alternative is retry logic in a dozen
   * hooks, where the ordering between "the token is stale" and "the socket is
   * dead" is decided by whichever effect happens to fire first.
   *
   * Machines run concurrently and independently. `allSettled`, never a barrier:
   * a machine that is switched off must not delay the one that is not.
   */
  async resume(reason: string): Promise<void> {
    if (this.resumeInFlight !== null) {
      // Coalesce. A phone unlocking fires visibilitychange, pageshow and online
      // within a few milliseconds of each other, and running the sequence three
      // times over would mint three tokens per machine to no purpose.
      this.resumeQueued = true;
      return this.resumeInFlight;
    }

    const run = this.runResume(reason).finally(() => {
      this.resumeInFlight = null;
      if (this.resumeQueued) {
        this.resumeQueued = false;
        void this.resume("coalesced");
      }
    });
    this.resumeInFlight = run;
    return run;
  }

  private async runResume(reason: string): Promise<void> {
    const epoch = ++this.epoch;
    this.patch({ resuming: true });

    /*
     * The registry may have changed while we were asleep — a machine added, a
     * grant revoked. Best-effort: its failure must not stop the rest.
     *
     * Skipped on the bootstrap call, which has just fetched it. Two sequential
     * `GET /v1/machines` on every cold start put a wasted round trip on the
     * critical path before the first session list could render, because the
     * per-machine work below is gated behind this.
     */
    if (cp.currentCredential() !== null && reason !== "bootstrap") {
      try {
        const machines = await cp.machines();
        if (epoch === this.epoch) {
          for (const record of machines) {
            const id = machineId(record.id);
            const existing = this.connections.get(id);
            if (existing) existing.update(record);
            else {
              const created = new MachineConnection(record, () => this.emit());
              this.connections.set(id, created);
              this.daemons.set(id, new DaemonClient(created));
            }
          }
          for (const id of [...this.connections.keys()]) {
            if (!machines.some((m) => m.id === id)) this.dropMachine(id);
          }
          /*
           * And leave the loading screen, which nothing else here could.
           *
           * `phase` is written by `bootstrap` alone, and `bootstrap` runs once at
           * page load. So a tab opened while the control plane was down recovered
           * everything else on this path — connections, daemons, tokens, the
           * session poll — and went on rendering `App`'s bare spinner for ever,
           * with the `cpError` this same patch clears so it no longer even said
           * why. The only escape was a manual reload, and no wake trigger helped:
           * `resume.ts` lands here too.
           *
           * Promoted on the listing having **succeeded**, not on it having
           * returned rows — which is `bootstrap`'s *success* arm and deliberately
           * not its *catch* arm. Those answer different questions: the catch is
           * weighing what is salvageable from a fetch that failed, and machines
           * already in hand is the salvage. Here the fetch resolved, so the
           * registry is known, and an account that legitimately owns none has a
           * perfectly usable app — Settings → Machines is the screen it is
           * supposed to be looking at.
           *
           * Read as one rule with the catch, `connections.size > 0` stranded
           * exactly the account most likely to need this: a fresh sign-in, or one
           * whose machines were all revoked, whose tab happened to load while the
           * control plane was down. It stayed on `App`'s bare spinner for ever,
           * without even the `cpError` this same patch clears to say why, and the
           * one screen that would have fixed it was behind the spinner. Worse than
           * a stalemate, because `tick`'s retry gate is `connections.size === 0 &&
           * phase === "loading"`: with the phase pinned there and no machines, the
           * escape hatch became a `GET /v1/machines` every four seconds for ever,
           * which is the poll that gate's own comment exists to prevent.
           *
           * Only ever *upwards* from `loading`, so a tab that was signed out while
           * this request was in flight is not dragged back into the fleet. `me` is
           * then refreshed rather than left null: `bootstrap`'s catch already
           * reaches "ready with no `me`" and `visibleSections` fails closed on it,
           * so promoting without asking would quietly cost an admin the Users
           * section until they reloaded.
           */
          const promote = this.snapshot.phase === "loading";
          this.patch(promote ? { cpError: null, phase: "ready" } : { cpError: null });
          if (promote) void this.refreshMe();
          /*
           * And the instance config, **only if it is still unknown**.
           *
           * A tab that woke on the `cp-retry` path may never have had a working
           * `/v1/instance`. Re-reading it every wake would be a poll nobody
           * asked for: this is instance configuration, not telemetry, and when
           * an admin changes it the Server settings screen patches `config`
           * from its own authoritative answer.
           */
          if (this.snapshot.config === null) void this.loadConfig();
        }
      } catch (error) {
        // Cached tokens may well still be valid. Keep going.
        this.patch({ cpError: describe(error) });
      }
    }

    await Promise.allSettled(
      [...this.connections.values()].map((connection) => this.resumeMachine(connection, epoch)),
    );

    if (epoch === this.epoch) this.patch({ resuming: false, lastResumeAt: Date.now() });
  }

  private async resumeMachine(connection: MachineConnection, epoch: number): Promise<void> {
    const id = connection.id;

    // 1. A token, refreshed if it is near expiry. A control-plane outage with a
    //    still-valid cached token is survivable and `ensureToken` says so.
    try {
      await connection.ensureToken();
    } catch {
      // Recorded on the machine's own state; the other machines are unaffected.
      return;
    }
    if (epoch !== this.epoch) return;

    // 2. Re-probe. What we last believed about reachability was true of a network
    //    we may have left, and only a transport-level fact can invalidate it —
    //    which a sleep is.
    connection.forgetRoute();
    const route = await connection.resolveRoute();
    if (epoch !== this.epoch) return;
    if (route === null) {
      this.nextProbeAt.set(id, Date.now() + OFFLINE_RETRY_MS);
      return;
    }

    // 3. Re-list. This is what corrects the blocked indicator without replaying
    //    a single event.
    await this.refreshMachineSessions(connection, epoch);
    if (epoch !== this.epoch) return;

    // 4. Reconnect every live stream on this machine, from its own cursor.
    for (const stream of this.streams.values()) {
      if (stream.ref.machineId === id) stream.reconnect();
    }
  }

  /* ---------------------------------------------------------------- *
   * Polling
   * ---------------------------------------------------------------- */

  /**
   * One poll round, on demand.
   *
   * The cheap half of `resume()`: it re-lists sessions on machines that are
   * already reachable and does nothing else. No control-plane round trip, no
   * token minting, no route re-probe, no socket churn, and no `resuming` flag —
   * so it does not flash a spinner or rebuild anything that has not moved.
   *
   * This exists because coming back to a tab was running the *full* sequence.
   * A tab you switched away from for four seconds has not lost its tokens, its
   * routes or its sockets, and re-deriving all of them made the whole interface
   * visibly reload every time — see `resume.ts`.
   */
  poll(): Promise<void> {
    return this.tick();
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * One poll round.
   *
   * The aggregate list — including which sessions are blocked — comes from here
   * rather than from sockets. A WebSocket per session across every machine would
   * be dozens of sockets on a phone; `GET /sessions` is one request per machine
   * and `blocked` is derived server-side on every read, so the list is correct
   * without replaying anything.
   */
  private async tick(): Promise<void> {
    const epoch = this.epoch;

    /*
     * A control plane that was unreachable at startup gets retried here.
     *
     * The loading screen says "Retrying", and until this existed nothing did: the
     * only code that re-read the registry was `resume()`, which fires on waking,
     * not on a timer. So a phone that opened the app while the control plane was
     * down sat on a spinner claiming to retry until the user happened to background
     * the tab or change networks. The poll is already running, and the machine list
     * is the one thing missing, so this is where it belongs.
     *
     * Gated on holding no machines at all — with any machine known, the per-machine
     * loop below is the retry, and re-listing the registry every four seconds for
     * ever would be a poll nobody asked for.
     */
    if (this.connections.size === 0 && this.snapshot.phase === "loading") {
      // Through `resume`, not `runResume`, so it coalesces with a wake that lands
      // in the same tick rather than racing it and minting twice.
      await this.resume("cp-retry");
      return;
    }

    await Promise.allSettled(
      [...this.connections.values()].map(async (connection) => {
        const state = connection.state();
        if (state.reach === "offline") {
          const due = this.nextProbeAt.get(connection.id) ?? 0;
          if (Date.now() < due) return;
          this.nextProbeAt.set(connection.id, Date.now() + OFFLINE_RETRY_MS);
          connection.forgetRoute();
          const route = await connection.resolveRoute();
          if (route === null) return;
          // It came back on its own. Reattach anything that was streaming on it.
          for (const stream of this.streams.values()) {
            if (stream.ref.machineId === connection.id) stream.reconnect();
          }
        }
        await this.refreshMachineSessions(connection, epoch);
      }),
    );
  }

  private async refreshMachineSessions(connection: MachineConnection, epoch: number): Promise<void> {
    const daemon = this.daemons.get(connection.id);
    if (daemon === undefined) return;

    let listed;
    try {
      listed = await daemon.listSessions(SESSION_LIST_LIMIT);
    } catch (error) {
      if (!ApiError.isApiError(error)) {
        // Transport: the machine went away. `request` has already marked it.
        this.emit();
      }
      return;
    }
    if (epoch !== this.epoch) return;
    /*
     * This machine has now answered a session list, so "no row for that key" is a
     * statement about the daemon rather than about how far this page load has
     * got. `SessionView` is the only reader — see `missingRowReason`.
     */
    this.listed.add(connection.id);

    const name = connection.state().name;
    const fetchedAt = Date.now();
    const seen = new Set<SessionKey>();

    for (const snapshot of listed.sessions) {
      const ref = refOf(connection.id, sessionId(snapshot.id));
      const key = keyOf(ref);
      seen.add(key);
      this.rows.set(key, {
        key,
        ref,
        machineName: name,
        snapshot,
        daemonNow: listed.now,
        fetchedAt,
        heldConfig: holdConfig(this.rows.get(key)?.heldConfig, snapshot),
        });
    }

    /*
     * Sessions this daemon no longer lists.
     *
     * Only when the answer was the *whole* list. With `truncated` the rows beyond
     * the window are absent because they were not asked for, not because they are
     * gone — pruning on that would close the socket and discard the transcript of
     * whatever the user is looking at the moment their fleet grows past the limit.
     *
     * An older daemon sends neither field; `!== true` reads that as "not
     * truncated", which is correct because such a daemon also ignored the limit
     * and really did return everything.
     */
    if (listed.truncated !== true) {
      for (const key of this.rows.keys()) {
        const row = this.rows.get(key);
        if (row !== undefined && row.ref.machineId === connection.id && !seen.has(key)) {
          this.forgetSession(key);
        }
      }
    }

    this.emit();

    this.attachWanted(connection.id);

    for (const snapshot of listed.sessions) {
      if (needsHuman(snapshot)) {
        void this.primeBlocked(refOf(connection.id, sessionId(snapshot.id)), snapshot);
      }
    }
  }

  /**
   * Open the sockets that were asked for before their session list existed.
   *
   * The other half of `openSession`'s refusal. Somebody reloading straight onto a
   * session URL asks for that stream while `refreshMachineSessions` is still in
   * flight; `openSession` records the key on `streamOrder` and declines rather
   * than attaching at `since=0`. This is what finishes the job, and it is the only
   * thing that does — the view's effect is keyed on the machine and session ids,
   * which never change, so it never fires again.
   *
   * Here rather than in `resumeMachine` because this is the one place `rows` is
   * filled, and *both* paths that fill it — the wake sequence and the four-second
   * poll — run through it. So a machine that was asleep when you opened the tab is
   * covered by the same line, with no second rule about which path attaches.
   *
   * `rows.get(key)` is checked again rather than assumed: the list that just
   * landed may not contain this session at all (it is bounded at
   * `SESSION_LIST_LIMIT`), and attaching without a row is the exact thing being
   * avoided.
   *
   * Nothing about the socket budget changes. `streamOrder` holds at most
   * `MAX_LIVE_STREAMS` keys and `openSession` still evicts past it, so this can
   * only restore a stream the LRU already wanted open.
   *
   * **It resumes history as well as sockets, and that is what makes a short
   * transcript heal itself.** `loadAll` gives up when its retries are spent, and
   * nothing used to call it again: the view's effect never re-fires and the loop
   * above skipped every key that already had a stream, so one request dropped
   * during a reload left the conversation empty for the life of the tab, with a
   * button asking the reader to do by hand what the client had abandoned. Calling
   * it here puts the recovery on the same schedule as everything else — this runs
   * only after a session list came back, so a machine that is down is never asked,
   * and it comes back on the poll that follows the machine doing so.
   *
   * It is free when there is nothing to do: `loadAll` asks `loadStop` *before* it
   * takes the latch, so a fully-paged, cut, or ceiling-full transcript costs one
   * map read and emits nothing. Three sockets at most, so three loops at most.
   */
  private attachWanted(id: MachineId): void {
    // Over a copy: `openSession` rewrites `streamOrder` on every call.
    for (const key of [...this.streamOrder]) {
      const row = this.rows.get(key);
      if (row === undefined || row.ref.machineId !== id) continue;
      // `openSession` calls `loadAll` itself, so the two arms do not compound.
      if (this.streams.has(key)) void this.loadAll(row.ref);
      else this.openSession(row.ref);
    }
  }

  /**
   * Fetch just enough history to name the command a blocked session is waiting on.
   *
   * The permission itself carries only a title, so the command has to be joined
   * from the `tool_call` event — and without this the list would show that title
   * alone until the session was opened, which is one tap too late for the screen
   * whose entire job is "what needs me".
   *
   * One small page, once per blocked session. Blocked sessions are few by
   * definition, so this is a handful of requests at most, and it doubles as a
   * warm transcript when the session is opened.
   */
  private async primeBlocked(ref: SessionRef, snapshot: SessionSnapshot): Promise<void> {
    const key = keyOf(ref);
    if (this.transcripts.has(key) || this.primed.has(key)) return;
    const daemon = this.daemons.get(ref.machineId);
    if (daemon === undefined) return;
    this.primed.add(key);

    const since = Math.max(0, snapshot.lastSeq - PRIME_WINDOW);
    try {
      const page = await daemon.events(ref.sessionId, since, PRIME_WINDOW);
      if (this.transcripts.has(key)) return;
      /*
       * ⚠ **Through `replaceTranscript`, because this is the path that creates most
       * transcripts and it used to write the map directly.** `MAX_HELD_TRANSCRIPTS`
       * is applied in `trimTranscripts`, which only `replaceTranscript` calls — so
       * with a bare `this.transcripts.set` here the cap was never consulted on the
       * one path that runs for *every blocked session on every four-second poll*.
       * The map grew to the blocked-session count and the new bound's own docblock
       * ("a tab left open all day cannot accumulate without bound") was false on
       * exactly the path that accumulates.
       */
      this.replaceTranscript(key, {
        ...EMPTY_TRANSCRIPT,
        events: page.events,
        heldBytes: sizeOfEvents(page.events),
        loadedFrom: page.events[0]?.seq ?? since + 1,
        daemonFirstSeq: page.firstSeq,
      });
      this.emit();
    } catch {
      // Not fatal in the slightest: the card falls back to the title, which is
      // what it would have shown anyway. Allow a later attempt.
      this.primed.delete(key);
    }
  }

  /**
   * Fetch this session's slash commands, if what we hold is not current.
   *
   * Called from the composer on the open session and nowhere else. The list is
   * off the snapshot precisely so it is not paid for sixty times a poll, and
   * fetching it for every row here would put that cost straight back.
   *
   * The comparison is `!==` and not `>`. A daemon restart puts the revision back
   * to 0 while this client still holds 5, and the honest response is to drop what
   * we have: the agent that published it is gone. `0` and `undefined` both mean
   * the agent has never published — so that branch **deletes** rather than merely
   * declining to fetch. Returning with the entry intact was the whole rule stated
   * and then not done: after a daemon restart the composer went on offering the
   * previous agent's list, which is exactly the outcome this paragraph claims to
   * prevent.
   *
   * The in-flight guard drops a call rather than queueing it, so the revision it
   * was dropped for has to be remembered — see `commandsWanted`. Without that, a
   * bump from 5 to 6 during the fetch for 5 is lost for good: the effect that
   * calls this is keyed on the revision, so it never runs again, and on an agent
   * that never republishes (kimi) the client holds a superseded list for ever.
   */
  ensureCommands(ref: SessionRef, revision: number | undefined): void {
    const key = keyOf(ref);
    const plan = commandsPlan(this.commandLists.get(key)?.revision, revision, this.commandsInFlight.has(key));
    if (plan === "current") return;
    if (plan === "drop") {
      if (this.commandLists.delete(key)) this.emit();
      this.commandsWanted.delete(key);
      return;
    }
    if (plan === "defer") {
      // Not queued, just recorded: the newest wanted revision is the only one
      // worth chasing, and `finally` re-drives from it. The `undefined` arm is
      // unreachable — `commandsPlan` answers `drop` for it — and is written out
      // because the compiler cannot see that through the return value.
      if (revision !== undefined) this.commandsWanted.set(key, revision);
      return;
    }
    const daemon = this.daemons.get(ref.machineId);
    if (daemon === undefined) return;
    this.commandsInFlight.add(key);
    this.commandsWanted.delete(key);

    void daemon
      .commands(ref.sessionId)
      .then((page) => {
        // Nothing is filed against a session that has since been forgotten.
        // `forgetSession` deletes these maps, and a request already in the air
        // would otherwise resurrect the entry with nothing left to remove it.
        if (!this.rows.has(key)) return;
        // The daemon's own revision, not the one we asked at: the list may have
        // moved while this was in flight, and filing it under the stale number
        // would leave the next check believing it is current.
        this.commandLists.set(key, { revision: page.revision, commands: page.commands, dropped: page.dropped });
        this.emit();
      })
      .catch(() => {
        // Not fatal: the menu simply does not open, which is what it would do
        // anyway with nothing to show. Allow a later attempt.
      })
      .finally(() => {
        this.commandsInFlight.delete(key);
        const wanted = this.commandsWanted.get(key);
        if (wanted === undefined) return;
        this.commandsWanted.delete(key);
        if (this.commandLists.get(key)?.revision !== wanted) this.ensureCommands(ref, wanted);
      });
  }

  /* ---------------------------------------------------------------- *
   * Streams
   * ---------------------------------------------------------------- */

  /**
   * Attach to a session, evicting the least recently viewed if we are at the cap.
   *
   * Attaching at `snapshot.lastSeq` rather than 0: the transcript is filled by
   * paging backwards on demand, so opening a session with ten thousand events
   * behind it costs one small page rather than the entire log arriving in a
   * single synchronous block.
   *
   * Which is why **a stream is never opened without the row that says where to
   * attach.** `lastSeq` comes from the session list, and the list arrives after
   * the machines do: `bootstrap()` sets `phase: "ready"` as soon as it has
   * connections, `SessionView` mounts on that, and its effect ran while
   * `refreshMachineSessions` was still in flight. With no row the cursor fell
   * back to `0` — measured 2026-08-01 against a stub daemon, a hard reload
   * straight onto a session URL opened its socket with `since=0` where the same
   * session reached by tapping it opened with `since=3`. `since=0` asks the
   * daemon to replay the entire log, which `StreamConnection.attach` queues in
   * one synchronous block against a bound sized for exactly that not to happen —
   * so every reload on a phone paid for the whole transcript twice over.
   *
   * Returning here costs nothing visible: with no row `SessionView` is drawing
   * "that session is not on this daemon" anyway, because it reads the same map.
   * The intent is already recorded — `streamOrder` above is written before this —
   * and `attachWanted` opens it the moment the list lands.
   */
  openSession(ref: SessionRef): void {
    const key = keyOf(ref);
    this.streamOrder = [...this.streamOrder.filter((k) => k !== key), key];

    if (!this.streams.has(key)) {
      const connection = this.connections.get(ref.machineId);
      if (connection === undefined) return;
      const row = this.rows.get(key);
      if (row === undefined) return;
      /*
       * Re-opening a session the socket LRU evicted must not silently skip what
       * it missed — see `reattachSince`, which is the whole of that rule and is
       * out there so `webcheck` can pin its boundary against the daemon's own
       * `ATTACH_REPLAY_MAX` rather than against this client's window.
       *
       * **The dropped branch used to invent a gap, and it was the source of a
       * message that was simply untrue.** When the daemon had moved further than
       * we hold, this recorded `{from: heldLast + 1, to: daemonLast, reason:
       * "evicted"}` — which `EventList` drew as "N events not shown (beyond
       * retention)". Nothing had been evicted; the client had declined to fetch
       * them and then reported its own decision as data loss, in the one tone
       * reserved for a conversation that really does have a hole in it. So
       * `keepHeld: false` drops what is held and `loadAll` pages the history back
       * in contiguously: the cost is refetching, and a real gap is now only ever
       * one the *daemon* reports in `lagged`.
       */
      const { since, keepHeld } = reattachSince(
        this.transcripts.get(key)?.events.at(-1)?.seq ?? null,
        row.snapshot.lastSeq,
      );
      if (!keepHeld) this.replaceTranscript(key, { ...EMPTY_TRANSCRIPT, loadedFrom: since + 1, gaps: [] });

      /*
       * `since` is the attach point, whole, with nothing added here.
       *
       * It used to be `Math.max(since, heldLast)`, because `reattachSince`'s
       * "held ahead of the row" arm answered the row's poll-stale number and the
       * caller was where that got raised to the held tail. Two copies of one
       * rule, and the wrong one was the assertable one: `webcheck` could only ask
       * the pure function, which answered a seq the socket never sent. The
       * correction is inside the function now — see the arm — so this line stays
       * a use rather than becoming a second decision.
       */
      const stream = new SessionStream(ref, connection, this, since);
      this.streams.set(key, stream);
      stream.start();
    }

    /*
     * **Outside the branch above, so history resumes on every open.**
     *
     * It used to sit inside `if (!this.streams.has(key))`, which meant the one and
     * only attempt to load a conversation happened when its socket was created. A
     * run that stopped short — a failed page, a transcript dropped mid-flight, the
     * per-run budget — left the session permanently short of its own history, and
     * the only way back was an LRU eviction that happened to close the socket.
     *
     * `loadAll` is a no-op when there is nothing to fetch (`loadStop` answers
     * `start_of_log` before any request) and a no-op while one is already running,
     * so the ordinary case costs nothing and the broken case heals itself the next
     * time somebody opens the session.
     *
     * Not awaited: the tail is on screen immediately and the rest fills in above it.
     */
    void this.loadAll(ref);

    while (this.streamOrder.length > MAX_LIVE_STREAMS) {
      const evict = this.streamOrder.shift();
      if (evict !== undefined && evict !== key) this.closeStream(evict);
    }
    this.emit();
  }

  private closeStream(key: SessionKey): void {
    const stream = this.streams.get(key);
    if (stream === undefined) return;
    stream.stop();
    this.streams.delete(key);
    this.streamOrder = this.streamOrder.filter((k) => k !== key);
  }

  /* ---------------------------------------------------------------- *
   * StreamSink
   * ---------------------------------------------------------------- */

  onEvents(ref: SessionRef, events: StoredEvent[]): void {
    const key = keyOf(ref);
    const current = this.transcripts.get(key) ?? EMPTY_TRANSCRIPT;
    let merged = [...current.events, ...events];
    let loadedFrom = current.loadedFrom;
    let heldBytes = current.heldBytes + sizeOfEvents(events);
    if (heldBytes > MAX_TRANSCRIPT_BYTES) {
      /*
       * Drop the oldest until it fits, and remember where the memory window now
       * starts so the loader can page them back rather than pretending they never
       * were.
       *
       * **By bytes, walking from the oldest, because the ceiling is bytes.** It used
       * to slice a fixed number of events off the front, which is one `slice` — this
       * is a loop, and it is still cheap for the two reasons that matter: it only
       * runs at all once a tab is genuinely full, and it walks only as far as it has
       * to (one event's worth per arriving event, in the steady state). `sizeOfEvent`
       * is memoised on identity, so every step is a map read.
       *
       * Subtracting what *left* rather than re-measuring what stayed is the same
       * discipline: this is the socket's own path, and re-measuring a hundred
       * thousand events per arriving token is tens of milliseconds a token.
       *
       * `keep` cannot run past the end: `heldBytes` counts exactly what `merged`
       * holds, so it reaches the ceiling before the array does. The bound on the
       * loop is written anyway, because a drift between those two would otherwise
       * be an empty transcript rather than a wrong number.
       */
      let keep = 0;
      while (keep < merged.length && heldBytes > MAX_TRANSCRIPT_BYTES) {
        heldBytes -= sizeOfEvent(merged[keep]!);
        keep += 1;
      }
      merged = merged.slice(keep);
      loadedFrom = merged[0]?.seq ?? loadedFrom;
    }
    if (current.events.length === 0 && merged.length > 0) {
      loadedFrom = Math.min(loadedFrom, merged[0]?.seq ?? loadedFrom);
    }

    // A `/clear` arriving live cuts the transcript the same way one found by
    // paging does, and `nextCut` is that rule — out of here so `webcheck` can
    // assert it, since which side of the socket a cut came from is precisely what
    // the reader must not be able to tell.
    const cut = nextCut(current.clearedAt, current.revealedBeforeClear, events);

    this.transcripts.set(key, { ...current, events: merged, heldBytes, loadedFrom, ...cut });
    // Transcript only. This is the per-event path — the one that runs tens of
    // times a second during a turn — and it touches no machine and no session row.
    this.emitTranscripts();
  }

  onSnapshot(ref: SessionRef, session: SessionSnapshot): void {
    const key = keyOf(ref);
    const existing = this.rows.get(key);
    this.rows.set(key, {
      key,
      ref,
      machineName: existing?.machineName ?? this.connections.get(ref.machineId)?.state().name ?? "",
      snapshot: session,
      heldConfig: holdConfig(existing?.heldConfig, session),
      // A snapshot frame carries no clock, so anchor to ours. It is only used for
      // elapsed times, and it is correct at this instant by construction.
      daemonNow: Date.now(),
      fetchedAt: Date.now(),
      // Kept from the row the poll built. A snapshot frame does not carry the
      // mapping, and dropping it here would make every path on the open session
      // flip back to its host form the moment the agent said anything.
    });
    const transcript = this.transcripts.get(key);
    if (transcript !== undefined) {
      this.transcripts.set(key, { ...transcript, daemonFirstSeq: session.firstSeq });
    }
    this.emit();
  }

  onGap(ref: SessionRef, from: number, to: number, reason: LaggedFrame["reason"]): void {
    if (to < from) return;
    const key = keyOf(ref);
    const current = this.transcripts.get(key) ?? EMPTY_TRANSCRIPT;

    /*
     * Which of the daemon's three lagged reasons is a loss, and which is only a
     * refusal to replay, is `gapPlan` — out of here so `webcheck` can assert all
     * three, since a regression restores the false "N events not shown (beyond
     * retention)" banner over a conversation that is perfectly intact.
     *
     * The comment that used to be here said the skipped range "sits immediately
     * below `loadedFrom` by construction", which is true only for a fresh attach
     * onto an empty transcript. Re-attaching with events already held is the
     * ordinary case — `SessionStream.reconnect` re-opens at `lastAppliedSeq` with
     * no clamp — so any wake after more than `ATTACH_REPLAY_MAX` events lands here
     * holding a transcript that ends far below `from`, which is why the answer is
     * to restart at the far side rather than to page backwards from where we are.
     */
    const plan = gapPlan(reason, to);
    if (plan.kind === "restart") {
      this.replaceTranscript(key, { ...EMPTY_TRANSCRIPT, loadedFrom: plan.loadedFrom });
      this.emitTranscripts();
      void this.loadAll(ref);
      return;
    }

    if (current.gaps.some((gap) => gap.from === from && gap.to === to)) return;
    this.transcripts.set(key, { ...current, gaps: [...current.gaps, { from, to, reason: plan.reason }] });
    this.emitTranscripts();
  }

  onStatus(ref: SessionRef, status: StreamStatus): void {
    const key = keyOf(ref);
    const current = this.transcripts.get(key) ?? EMPTY_TRANSCRIPT;
    this.transcripts.set(key, { ...current, stream: status });
    this.emitTranscripts();
  }

  onVanished(ref: SessionRef): void {
    this.forgetSession(keyOf(ref));
    this.emit();
  }

  /**
   * Drop every trace of one session.
   *
   * A helper rather than three copies, because there were three copies and all
   * three had drifted the same way: each deleted `rows` and `transcripts` and none
   * of them touched `primed`. That set only ever grew, and — worse than the memory
   * — a session whose transcript had been dropped could never be re-primed, so a
   * re-blocked session showed its bare title with no command under it for ever.
   *
   * Anything else added per session belongs here too. That is the point of it.
   */
  private forgetSession(key: SessionKey): void {
    this.closeStream(key);
    this.rows.delete(key);
    this.replaceTranscript(key, null);
    this.primed.delete(key);
    /*
     * ⚠ **`transcriptGen` is deliberately NOT deleted here, and it is the one
     * per-session map that must not be.** It was, briefly, on the reasoning that a
     * session which is gone has no page in flight — but the three guards that read
     * it (`(this.transcriptGen.get(key) ?? 0) !== gen`) exist precisely because
     * `forgetSession` *cannot* cancel an awaited page. Deleting the entry makes the
     * counter restart at 0, so a key that comes back — a session re-listed after a
     * poll, the same id on a re-created worktree — reissues generation 1, and a page
     * captured at generation 1 in that key's previous life matches the guard and is
     * committed into the new transcript. Monotonic for the life of the tab is the
     * property; the map holds a string and a number per session ever touched, which
     * is the cheaper half of that trade by a wide margin.
     */
    this.commandLists.delete(key);
    this.commandsInFlight.delete(key);
    this.commandsWanted.delete(key);
    // Not just bookkeeping: this **aborts uploads still in flight**. `onVanished`
    // reaches here, and a session the daemon says is gone must stop having 25 MiB
    // pushed at it over somebody's uplink.
    forgetAttachments(key);
    forgetAsks(key);
    // Anything optimistically drawn for a session that is gone. Every entry is
    // also released when its own request settles, so this is about the window in
    // between rather than about a leak.
    forgetChoices(key);
  }

  /* ---------------------------------------------------------------- *
   * History
   * ---------------------------------------------------------------- */

  /**
   * Page backwards until there is nothing left worth having.
   *
   * `since` is exclusive and the server answers ascending, so reaching *older*
   * events means asking from a point before the window we hold. The page is
   * capped at 5000 events or 768 KiB, whichever comes first — so a short page is not
   * the end of history and the next request has to key off the last seq received.
   *
   * **A loop, and that is the change.** It used to fetch exactly one page, and
   * `openSession` called it exactly once, so opening a session left you holding
   * the last 200 events with a button under them. Anything longer than a morning's
   * work therefore started several taps from its own beginning, and the 4774-event
   * session on this machine started twenty-four. A conversation is read from the
   * top; it should arrive that way.
   *
   * **Five ways it stops**, and the count is worth keeping here because an earlier
   * version of this docblock said "three" and omitted the only one of them that is
   * a budget — which is the one a reader comes here to find, since it is what makes
   * the "did not load" button appear on a long conversation. Four of them are
   * `loadStop`, in the order it asks them; the fifth is a window that could not be
   * filled, which is `fillWindow`'s `closed` and cannot be known until one has been
   * tried. Both are documented at those functions rather than restated here, so
   * there is one copy of each rule and `webcheck` reaches it.
   *
   * Started with `void` from `openSession` *after* the socket, so the tail is on
   * screen while this runs and the history fills in above it.
   */
  /**
   * Page the conversation in, and **keep it in** — this is what makes a transcript
   * always loaded rather than usually loaded.
   *
   * Idempotent and cheap: with nothing left to fetch, `loadStop` answers
   * `start_of_log` before a single request goes out. So the right thing to do
   * with it is call it whenever there is any reason to think history might be
   * short, which is what `openSession` now does unconditionally.
   */
  async loadAll(ref: SessionRef): Promise<void> {
    const key = keyOf(ref);
    if (this.transcripts.get(key)?.loadingHistory === true) return;
    const daemon = this.daemons.get(ref.machineId);
    if (daemon === undefined) return;
    /*
     * **Asked before the latch is set, and that is what makes the 4s re-drive
     * free.** `attachWanted` calls this for every open session on every poll, so
     * the fully-paged case has to cost one map read and emit nothing — setting
     * `loadingHistory` and clearing it again would be two `emitTranscripts()`, i.e.
     * two full-transcript re-renders per open session, for ever.
     */
    if (stopFor(this.transcripts.get(key)) !== null) return;
    /** The life of the transcript this run belongs to — see `transcriptGen`. */
    const gen = this.transcriptGen.get(key) ?? 0;

    this.setTranscript(key, (held) => ({ ...held, loadingHistory: true }));
    this.emitTranscripts();

    /*
     * **A yield point, not a budget** — see `loadStop`, which no longer has an arm
     * for this. `MAX_AUTO_HISTORY` used to stop the run and leave the rest of the
     * conversation behind a button; now it is how often the loop hands the main
     * thread back. What is being paced is not the network (every window already
     * awaits a round trip) but `emitTranscripts()` re-rendering a transcript that
     * has just grown by 500 rows. Keeping the constant as the chunk means every
     * session under it behaves exactly as it did before this change.
     */
    let fetched = 0;
    let lastYield = 0;
    try {
      for (;;) {
        const current = this.transcripts.get(key);
        if (current === undefined) return;
        // Three of the four ways this stops, in one place so the order is a rule
        // rather than a sequence of `break`s — see `loadStop`. The fourth is the
        // window below not closing.
        if (stopFor(current) !== null) break;

        /*
         * One window, filled forwards and closed completely before anything is
         * prepended — see `fillWindow` for why the page's *first* event is not
         * where `loadedFrom` may be anchored. Named `filled` rather than `window`
         * because this module runs in a browser, where that is a global.
         *
         * **The budget is `HISTORY_PAGE`, which makes it non-binding by
         * construction, and that is the point.** A window spans exactly
         * `HISTORY_PAGE` seqs (`fillWindow` starts its cursor at
         * `max(0, top - HISTORY_PAGE)` and filters to `> cursor && <= top`), so it
         * can never yield more than that many events however the daemon's 768 KiB
         * byte cap chops the pages up — which means this budget can never be the
         * thing that ends a window. It used to be `MAX_AUTO_HISTORY - fetched`,
         * and every 5000th event that expression went to zero *mid-window*: the
         * block was then discarded whole by the `!closed` arm below, so the run
         * paid for a page it threw away and reported the loss as a button. What is
         * left of `!closed` is the one thing it was always documented to mean —
         * the daemon cannot go further back.
         */
        const filled = await fillWindow(
          async (since) => {
            for (let attempt = 0; ; attempt += 1) {
              try {
                const page = await daemon.events(ref.sessionId, since, HISTORY_PAGE);
                /*
                 * The session was closed or forgotten while this page was in
                 * flight.
                 *
                 * Answering with nothing rather than throwing: `fillWindow` reads
                 * an empty answer as "there is no next `since` to ask from" and
                 * ends the window, and the `latest === undefined` check below then
                 * returns without committing anything. So a transcript nobody
                 * holds stops being paged after exactly one more in-flight
                 * request, which is what the check inside the old inline loop
                 * bought, with no second way out of a loop that lives in another
                 * module now.
                 */
                if (this.transcripts.get(key) === undefined) return { events: [], firstSeq: page.firstSeq };
                return page;
              } catch (error) {
                /*
                 * **The retry is here rather than around `fillWindow`, and the
                 * difference is a whole window's work.** `fillWindow` holds the
                 * block it has accumulated and the cursor it has reached in local
                 * state; retrying from out there would throw both away and refill
                 * the window from its floor. Retrying the one request that failed
                 * resumes at the `since` it was already asking from.
                 *
                 * On exhaustion this **rethrows**, and must: answering with an
                 * empty page instead would let `fillWindow` end the window
                 * normally and write `page.firstSeq` into `daemonFirstSeq` — a
                 * floor from a request that never succeeded, which `loadStop`
                 * would then read as `start_of_log` and stop paging this session
                 * for good.
                 */
                const wait = historyRetry(attempt, error);
                if (wait === null) throw error;
                await sleep(wait);
                // Woken into a different life: the transcript was replaced while
                // this was waiting, so the page it is about belongs to a
                // conversation nobody is holding. Same test the loop makes after
                // every window, for the same reason.
                if ((this.transcriptGen.get(key) ?? 0) !== gen) throw error;
              }
            }
          },
          current.loadedFrom,
          HISTORY_PAGE,
        );
        fetched += filled.fetched;

        const latest = this.transcripts.get(key);
        if (latest === undefined) return;
        // The transcript was thrown away and started again while this window was
        // in flight — the block belongs to the previous life and prepending it
        // would splice two conversations together. Whoever replaced it has its
        // own run; this one is done.
        if ((this.transcriptGen.get(key) ?? 0) !== gen) return;
        /*
         * The window could not be closed — prepending a half-filled one is the
         * hole `fillWindow` exists to prevent, so the fetch is discarded and
         * `loadedFrom` stays put.
         *
         * With the budget non-binding (see above) this now has exactly one cause:
         * a page came back with nothing usable, i.e. the daemon's own floor is
         * above this window. That is a real end rather than a pause, and the
         * `daemonFirstSeq` written here is what tells `loadStop` so — the next
         * re-drive reads `loadedFrom <= max(1, daemonFirstSeq)` and returns before
         * asking for anything. `EventList` draws the same fact as the legacy
         * "the start of this conversation is gone" line.
         */
        if (!filled.closed) {
          // `??`: `null` is "no page answered", which must not be written down as
          // a floor of zero — `EventList` reads that as the start of the
          // conversation being gone.
          this.setTranscript(key, (held) => ({ ...held, daemonFirstSeq: filled.firstSeq ?? held.daemonFirstSeq }));
          this.emitTranscripts();
          break;
        }
        const block = filled.block;

        // Newest first, so a session cleared twice stops at the most recent cut.
        // Only what this window brought is searched: an older marker already found
        // is the one we are stopped at, and one below it is two conversations ago.
        let cleared = latest.clearedAt;
        if (!latest.revealedBeforeClear) {
          for (let i = block.length - 1; i >= 0; i -= 1) {
            const stored = block[i];
            if (stored?.event.type === "context_cleared") {
              cleared = stored.seq;
              break;
            }
          }
        }

        this.transcripts.set(key, {
          ...latest,
          events: [...block, ...latest.events],
          heldBytes: latest.heldBytes + sizeOfEvents(block),
          loadedFrom: block[0]!.seq,
          daemonFirstSeq: filled.firstSeq ?? latest.daemonFirstSeq,
          clearedAt: cleared,
        });
        this.emitTranscripts();

        /*
         * Hand the main thread back every `MAX_AUTO_HISTORY` events.
         *
         * `setTimeout` and deliberately not `requestIdleCallback`: `webcheck`
         * drives this module under `tsx` in node, where that global does not
         * exist, and Safari only shipped it in 17.4. A zero-delay macrotask is
         * enough — it lets a paint and a queued touch event in between chunks,
         * which is all this is for.
         */
        if (fetched - lastYield >= MAX_AUTO_HISTORY) {
          lastYield = fetched;
          await sleep(0);
        }
      }
    } catch {
      /*
       * Whatever landed before the failure is kept and drawn, and the run is over
       * — `historyRetry` has already spent its schedule on anything transient, so
       * reaching here means either the daemon answered a refusal or the network
       * did not come back inside it.
       *
       * **This used to be the end of the story**, and that was the defect: nothing
       * re-drove `loadAll`, so one dropped request left the conversation empty for
       * the life of the tab and the reader was offered a button to do by hand what
       * the client had simply given up on. `attachWanted` calls this again on the
       * next poll that a session list survives.
       */
    } finally {
      /*
       * **`finally`, and this was three plain statements after the `catch`.**
       *
       * `loadingHistory` is a latch that makes the next call a no-op, and the
       * loop above returns early in two places — a transcript dropped while a
       * page was in flight, at lines that read `if (current === undefined)
       * return`. A `return` inside the `try` skipped straight past the reset, so
       * the latch stuck **on, permanently**: every later `loadAll` for that
       * session returned at its first line, for the life of the tab, and the
       * conversation never loaded again. Its only symptom is an empty transcript
       * that will not fill, which is exactly what was reported — a session of
       * 1989 events drawing "No events yet." beside an approval whose tool call
       * it therefore could not find either.
       *
       * Nothing else in this file resets it, so there is no second way out.
       *
       * Guarded on the generation for the mirror of the reason the check above
       * is: past a replacement the latch on the *new* transcript belongs to the
       * run that replacement started, and clearing it here would let a third
       * loop in behind this one.
       */
      if ((this.transcriptGen.get(key) ?? 0) === gen) {
        this.setTranscript(key, (held) => ({ ...held, loadingHistory: false }));
        this.emitTranscripts();
      }
    }
  }

  /**
   * Show what the agent was told to forget, and go and fetch it.
   *
   * The one control left in the transcript, and the only thing that ever grows it
   * by hand. Everything else arrives on its own.
   */
  revealBeforeClear(ref: SessionRef): void {
    const key = keyOf(ref);
    const current = this.transcripts.get(key);
    if (current === undefined || current.revealedBeforeClear) return;
    this.transcripts.set(key, { ...current, revealedBeforeClear: true });
    this.emitTranscripts();
    void this.loadAll(ref);
  }

  /** Read-modify-write on a transcript that may have been dropped under us. */
  private setTranscript(key: SessionKey, update: (held: Transcript) => Transcript): void {
    const held = this.transcripts.get(key);
    if (held === undefined) return;
    this.transcripts.set(key, update(held));
  }

  /**
   * Throw a transcript away and start another, which is not the same act as
   * updating one — see `transcriptGen`. Every site that discards what is held
   * goes through here, so an in-flight `loadAll` cannot prepend a block it
   * fetched for the previous life onto the new one.
   */
  private replaceTranscript(key: SessionKey, next: Transcript | null): void {
    this.transcriptGen.set(key, (this.transcriptGen.get(key) ?? 0) + 1);
    if (next === null) this.transcripts.delete(key);
    else {
      this.transcripts.set(key, next);
      this.trimTranscripts(key);
    }
  }

  /**
   * Keep the number of *retained* conversations bounded.
   *
   * ⚠ **`MAX_TRANSCRIPT_BYTES` is documented as "the tab's only ceiling" and it
   * is not one — it is per session.** Nothing ever dropped a transcript, so
   * opening N conversations in one tab retained N of them, each entitled to 16
   * MiB, on a device the whole product is aimed at. The byte ceiling bounds how
   * much of *one* conversation is held; this bounds how many are held at once,
   * and the two together are what the sentence claimed.
   *
   * **A stream is never evicted, and that is what makes this safe.** Anything in
   * `streamOrder` is open or recently open — at most `MAX_LIVE_STREAMS` of them —
   * so the conversation on screen and the ones still arriving cannot be the ones
   * dropped. What goes is the tail of somewhere you navigated through, and it
   * costs a re-fetch on the way back, which is the same cost a cold open already
   * pays.
   *
   * Eviction order is insertion order over `transcripts`, which is a `Map` and
   * therefore ordered by first write. That is "least recently *arrived at*"
   * rather than a true LRU, and it is deliberate: a true LRU needs a read hook
   * the store does not have, and would buy nothing here because the only entries
   * eligible at all are ones with no live stream.
   *
   * The cap is generous on purpose. This is a leak bound, not a memory budget:
   * the number that matters is that it is finite.
   */
  private trimTranscripts(just: SessionKey): void {
    if (this.transcripts.size <= MAX_HELD_TRANSCRIPTS) return;
    const live = new Set(this.streamOrder);
    for (const key of [...this.transcripts.keys()]) {
      if (this.transcripts.size <= MAX_HELD_TRANSCRIPTS) return;
      if (key === just || live.has(key) || this.streams.has(key)) continue;
      // Not `replaceTranscript`: that calls back into here, and the generation
      // bump is wanted so a page still in flight for this key is discarded.
      this.transcriptGen.set(key, (this.transcriptGen.get(key) ?? 0) + 1);
      this.transcripts.delete(key);
      /*
       * ⚠ **`primed` goes with it, and forgetting that is a bug this file has
       * already had once.** `primeBlocked` opens with `if (this.transcripts.has(key)
       * || this.primed.has(key)) return;`, so a key dropped from one set and left in
       * the other can never be primed again — the blocked row keeps its bare title
       * with no command under it, for the life of the tab. `forgetSession`'s docblock
       * is where that was written down the first time; this is the second route to
       * the same state, and eviction order makes it the *likely* one, since a primed
       * window is written on the first `refreshMachineSessions` and this Map evicts
       * in insertion order.
       */
      this.primed.delete(key);
    }
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  daemonFor(id: MachineId): DaemonClient | undefined {
    return this.daemons.get(id);
  }

  /** Fold an action's returned snapshot straight into the list, so the UI moves now. */
  applySnapshot(ref: SessionRef, session: SessionSnapshot): void {
    this.onSnapshot(ref, session);
  }

}

export const store = new AppStore();

/*
 * The one way `cp.ts` reaches back into the store.
 *
 * Registered here rather than in the constructor because `cp.ts` is imported *by*
 * this module — the dependency runs one way and always has — so the handler has to
 * be installed from outside the class, after both modules exist. What it carries
 * is the only thing `cp.ts` knows that the store cannot work out for itself: that
 * a request came back saying this credential is finished.
 */
cp.onSignedOut((failure) => store.handleSignedOut(failure));

/** Sessions needing a human, oldest wait first, across every machine. */
/**
 * The three lists `Home` renders, plus the per-machine session counts.
 *
 * Derived in **one pass over `state.sessions`** and memoised on its identity.
 * Every part of that matters:
 *
 *   - Three separate exported selectors meant three full filters and three sorts
 *     per render, and `Home` called all of them unmemoised, so a streamed text
 *     delta re-derived the whole fleet.
 *   - The blocked comparator called `Math.min(...spread)` from *inside* the sort,
 *     so the key was recomputed O(n log n) times instead of once — and spreading a
 *     pending-permission array into `Math.min` is also how a very long one would
 *     blow the argument limit.
 *   - The machine counts were `sessions.filter(...)` nested inside
 *     `machines.map(...)`, which is O(machines × sessions).
 *
 * Memoised on `state.sessions` by identity, which is exactly right now that
 * `emit` only replaces that array when a row actually changed: a transcript event
 * leaves it alone and this whole derivation is skipped.
 */
export interface SessionLists {
  blocked: SessionRow[];
  active: SessionRow[];
  ended: SessionRow[];
  /**
   * Sessions **still alive** per machine, not sessions ever created.
   *
   * It counted every row, so a machine whose only two sessions had both ended
   * hours ago read "2 sess" beside a green dot — which says the machine is busy
   * when nothing is running on it at all. Terminal rows are still in the list and
   * still reachable under the Ended filter; they are simply not what "how much is
   * happening here" means.
   *
   * A session the daemon is bringing back after a restart *is* counted, which is
   * `countsAsLive` rather than `!isTerminal`: from the reader's seat it is one of
   * their live conversations that happens to be a few seconds from having an
   * agent again, and dropping it out of the count for the length of a deploy
   * would make the fleet look emptier than it is at exactly the moment somebody
   * checks on it. A *stalled* one is not counted — nothing is running, and that
   * is the point of it being a separate question from which list it lands in.
   */
  countByMachine: ReadonlyMap<MachineId, number>;
}

let listsFor: SessionRow[] | null = null;
let listsCache: SessionLists | null = null;

export function sessionLists(state: AppState): SessionLists {
  if (listsFor === state.sessions && listsCache !== null) return listsCache;

  const blocked: { row: SessionRow; oldest: number }[] = [];
  const active: SessionRow[] = [];
  const ended: SessionRow[] = [];
  const countByMachine = new Map<MachineId, number>();

  for (const row of state.sessions) {
    if (countsAsLive(row.snapshot)) {
      countByMachine.set(row.ref.machineId, (countByMachine.get(row.ref.machineId) ?? 0) + 1);
    }

    // **This is the single line that carries questions into the whole fleet
    // view.** `machineSubline`, the collapsed-section `blockedCount` and the "an
    // approval cannot be hidden" property all read `blockedCount`, which reads
    // `sessionGroups`, which reads this — so they need no edit of their own. That
    // is the argument for the predicate rather than a happy accident.
    if (needsHuman(row.snapshot)) {
      // Still computed once per row rather than once per comparison, and still a
      // fold rather than a spread, so the number waiting cannot matter.
      blocked.push({ row, oldest: oldestWait(row.snapshot) });
    } else if (showsAsEnded(row.snapshot)) {
      // `showsAsEnded` and not `isTerminal`: a session the daemon ended is not
      // one *anybody* ended, so it stays in Active — where `recentFirst` puts it
      // near the top, which is where a conversation interrupted a minute ago
      // belongs. Ended means somebody decided it was over.
      ended.push(row);
    } else {
      active.push(row);
    }
  }

  blocked.sort((a, b) => a.oldest - b.oldest);
  const recentFirst = (a: SessionRow, b: SessionRow): number =>
    (b.snapshot.lastEventAt ?? b.snapshot.createdAt) - (a.snapshot.lastEventAt ?? a.snapshot.createdAt);
  active.sort(recentFirst);
  ended.sort(recentFirst);

  listsCache = { blocked: blocked.map((entry) => entry.row), active, ended, countByMachine };
  listsFor = state.sessions;
  return listsCache;
}

/** One machine's own sessions, in the order its section draws them. */
export interface MachineGroup {
  id: MachineId;
  name: string;
  reach: MachineState["reach"];
  offlineReason: MachineState["offlineReason"];
  route: MachineState["route"];
  tokenDegraded: boolean;
  /**
   * Past its owner's machine limit.
   *
   * On the group rather than only on `MachineState` because this is the one
   * place the rail can say *why* a selected machine has no sessions to list —
   * "no sessions here yet" is false for a machine that has plenty and cannot be
   * reached to enumerate them.
   */
  overLimit: boolean;
  /**
   * Its owner has been banned.
   *
   * Carried beside `overLimit` rather than folded into it, for the reason the
   * two codes are separate everywhere else in this app: the **remedies differ**,
   * so a rail that named the limit for a banned owner's machine would send the
   * reader to retire hardware that retiring will not bring back.
   *
   * It arrived a release late, and the gap was exactly the false claim
   * `overLimit` was put here to stop: `machine.ts`'s `switchedOff()` refuses a
   * token for *both* reasons, so a banned owner's machine cannot list its
   * sessions either — and with only `overLimit` on the group the rail fell
   * through to "No sessions here yet." over a machine holding a dozen
   * conversations.
   */
  ownerDisabled: boolean;
  /**
   * Blocked first, then most-recent first.
   *
   * Pinned rows **are** here, and are also in `pinned`. They used to be only in
   * `pinned`, which made `liveCount` below disagree with what the section drew:
   * that count comes from `countByMachine`, which never knew about pinning, so a
   * machine whose one live session was pinned read "1 live" over an empty body.
   */
  active: SessionRow[];
  ended: SessionRow[];
  /** Sessions still alive here — the same quantity `countByMachine` reports. */
  liveCount: number;
  /**
   * How many rows under this header are waiting on a human.
   *
   * The header renders it, and that is what makes grouping safe. Blocked sessions
   * are no longer lifted into a zone of their own, so without a count on the
   * header a collapsed section could hide an approval — which is the one failure
   * this screen exists to prevent.
   */
  blockedCount: number;
}

export interface SessionGroups {
  /**
   * Pinned sessions, across the whole fleet, as one group above the machines.
   *
   * Gathered here rather than sorted to the top of each section: a pin is somebody
   * saying "this one, wherever it lives", and scattering them one per section
   * makes that list something you have to reassemble by eye.
   *
   * **A copy, not a move.** Every row here is also under its own machine in
   * `groups` (or in `orphans`). Pinning is a second way to reach a session, not a
   * relocation — see `place` in `sessionGroups`.
   */
  pinned: SessionRow[];
  groups: MachineGroup[];
  /** Rows whose machine is no longer granted. Visible, because losing one silently is worse. */
  orphans: SessionRow[];
}

let groupsForSessions: SessionRow[] | null = null;
let groupsForMachines: MachineState[] | null = null;
let groupsCache: SessionGroups | null = null;

/**
 * The fleet as a pinned group above one section per machine.
 *
 * **Blocked sessions stay in their machine's section**, marked, rather than being
 * lifted into a separate zone as they were. `CLAUDE.md` said sessions from every
 * machine land in one list with blocked ones first regardless of machine, and that
 * is now expressed differently rather than abandoned: blocked rows sort first
 * *inside* their section, they carry a marker on the row, and every section header
 * carries `blockedCount` — so a collapsed machine still says out loud that
 * something under it is waiting. The property that matters is "an approval cannot
 * be hidden", and a badge on a closed section keeps it.
 *
 * Built on `sessionLists` rather than replacing it: that function's shape is
 * pinned by `webcheck`, and this is additive.
 *
 * Memoised on the identity of **both** `sessions` and `machines`, since a group
 * carries machine state too. `emitTranscripts` replaces neither, so a streamed
 * event still costs nothing — the same property `sessionLists` defends.
 *
 * **Groups are ordered by name, always — never by reachability.** `reach` flickers,
 * and a list that reorders itself while a thumb is already travelling toward a row
 * is the one failure this app cannot have.
 */
export function sessionGroups(state: AppState): SessionGroups {
  if (groupsForSessions === state.sessions && groupsForMachines === state.machines && groupsCache !== null) {
    return groupsCache;
  }

  const lists = sessionLists(state);
  const byId = new Map<MachineId, MachineGroup>();

  // Every granted machine gets a section, including one with no sessions at all —
  // that is what gives it a "new session here" button, and what lets the old
  // bottom-of-the-page `Machines` list be deleted rather than merely moved.
  for (const machine of state.machines) {
    byId.set(machine.id, {
      id: machine.id,
      name: machine.name,
      reach: machine.reach,
      offlineReason: machine.offlineReason,
      route: machine.route,
      tokenDegraded: machine.tokenDegraded,
      overLimit: machine.overLimit,
      ownerDisabled: machine.ownerDisabled,
      active: [],
      ended: [],
      liveCount: lists.countByMachine.get(machine.id) ?? 0,
      blockedCount: 0,
    });
  }

  const pinned: SessionRow[] = [];
  const orphans: SessionRow[] = [];
  /**
   * The group this row was filed under, or `null` if it has no machine here.
   *
   * **Pinning copies rather than moves**, and the difference is the whole of it.
   * A pinned row used to be lifted out — pushed to `pinned` and then early
   * returned, so it vanished from its own machine's section. That reads as a
   * shortcut removing the thing it is a shortcut to: pin the session you are
   * working in and it disappears from the list you have been finding it in all
   * day, which is a strange price for a bookmark.
   *
   * So a pinned row is in both places, and the two lists mean different things —
   * `pinned` is "wherever it lives, here it is", the section is "what is on this
   * machine". The one consequence to hold onto is that `visibleRows` in
   * `groups.ts` must deduplicate: `keyboard.ts` finds the current row by key, and
   * two entries for one session would make `j` teleport rather than step.
   */
  const place = (row: SessionRow, into: "active" | "ended"): MachineGroup | null => {
    if (row.snapshot.pinned === true) pinned.push(row);
    const group = byId.get(row.ref.machineId);
    if (group === undefined) {
      // Only genuinely homeless rows are here now. A pinned row whose machine is
      // still granted is filed below *as well as* being in `pinned`; one whose
      // machine is gone is in `pinned` and in `orphans`, which is the same two
      // truths and neither of them silently dropped.
      orphans.push(row);
      return null;
    }
    group[into].push(row);
    return group;
  };

  // Blocked first so they lead their section, then everything else live, then the
  // terminal rows. `sessionLists` has already sorted each of the three.
  for (const row of lists.blocked) {
    /*
     * Counted off what `place` *did*, and that is now simply the ordinary answer
     * rather than a correction.
     *
     * It used to be load-bearing: a pinned row was not under its machine's header,
     * so incrementing from `byId.get(row.ref.machineId)` made the header read
     * "1 waiting" over a section containing no waiting row. Now that pinning
     * copies, the row *is* under the header and the count is right — the same
     * line, for the opposite reason. It stays keyed on the return value because
     * an orphan still has no header to count on.
     */
    const filed = place(row, "active");
    if (filed !== null) filed.blockedCount += 1;
  }
  for (const row of lists.active) place(row, "active");
  for (const row of lists.ended) place(row, "ended");

  const groups = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));

  groupsCache = { pinned, groups, orphans };
  groupsForSessions = state.sessions;
  groupsForMachines = state.machines;
  return groupsCache;
}

/**
 * Milliseconds since a daemon-clock timestamp.
 *
 * Anchored to the daemon's own clock at fetch time and extended by our own
 * elapsed time since. A phone that slept has a clock that may have jumped; this
 * is wrong by at most the age of the row, rather than by the drift.
 *
 * `now` is a parameter with a default rather than a bare `Date.now()` so that
 * `webcheck` can pin it: the whole point of the arithmetic is that the two clocks
 * disagree, and a function that reads one of them internally can only be asserted
 * against itself.
 */
export function elapsedSince(row: SessionRow, at: number, now: number = Date.now()): number {
  return row.daemonNow - at + (now - row.fetchedAt);
}
