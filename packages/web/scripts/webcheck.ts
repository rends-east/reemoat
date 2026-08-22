#!/usr/bin/env node
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
// Type-only, so it is erased outright rather than being a static import running
// ahead of the `window` stub below. The history cases need real `StoredEvent`s:
// `fillWindow` filters and orders them, and a fixture cast to `never` would let
// a shape it cannot actually accept through.
import type { StoredEvent } from "../src/wire.js";

/**
 * The regression driver for the browser client.
 *
 * Fourth of its kind: `harness.ts` covers the session paths, `authcheck.ts` the
 * auth paths, `relaycheck.ts` the relay, and this one `packages/web`. Before it
 * existed the web client's entire safety net was `tsc --noEmit`, which is to say
 * that the four rules it is actually built on — the cursor, the rotation, the
 * route memo and the replay — were protected by nothing at all. Every one of them
 * fails *silently*: a duplicated or dropped event in a transcript looks like
 * something the agent said.
 *
 * Two things make this drivable at all:
 *
 *   - `window` is stubbed before the imports, so the modules that read it at load
 *     time (`machine.ts` computes `ROUTE_MODE` from the URL) can be imported under
 *     `tsx` with no DOM. That is why the imports below are dynamic.
 *   - `SessionStream` takes its machine as a collaborator, so a duck-typed stand-in
 *     replaces the token minting and route probing without a control plane. The
 *     socket, by contrast, is a **real** WebSocket against a real loopback server:
 *     the rotation overlap is a race between two live sockets and stubbing it away
 *     would remove the only thing worth testing.
 *
 * Run it after touching anything in `packages/web/src`:
 *   pnpm webcheck
 */

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        ${detail}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * A DOM, to the extent these modules need one
 * ------------------------------------------------------------------ */

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>)["window"] = {
  location: { href: "http://127.0.0.1/", protocol: "http:" },
  localStorage: {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => void storage.set(key, value),
    removeItem: (key: string): void => void storage.delete(key),
  },
};

/*
 * A `document`, deliberately **without** `startViewTransition`.
 *
 * `router.ts`'s `announce` reads it to decide whether a navigation can be
 * animated, so a driver that drives `navigate()` needs one — and this stub found
 * that the hard way: closing a sheet became a move that *has* a direction, the
 * short-circuit that had been hiding the read stopped short-circuiting, and a
 * routing check three screens away failed with `document is not defined`.
 *
 * Absent rather than faked, and that is the assertion in disguise: this is an
 * engine that has never heard of view transitions, so every navigation here takes
 * the plain path. What it pins is that the plain path still works — that the
 * animation is an enhancement over a router that routes without it.
 */
(globalThis as Record<string, unknown>)["document"] = {
  documentElement: { dataset: {} as Record<string, string> },
};

// Dynamic, so the stub above is in place before any module body runs.
const { SessionStream } = await import("../src/stream.js");
const { askedQuestion, drawableOptions, essentialContext, formatLocation, hasInput, optionLabel, permissionButtons, permissionContext, permissionHeadline, detailContext, readInput, withheldDetail } = await import(
  "../src/permission.js"
);
const { changeCounts, diffLines } = await import("../src/diff.js");
const {
  ATTACH_REPLAY_MAX,
  HISTORY_PAGE,
  MAX_AUTO_HISTORY,
  // Imported rather than written out as `12`. The bound was restated here as a
  // literal, which makes the assertion one-sided: lowering the cap to 1 still
  // passed, and raising it failed with a message naming no constant.
  MAX_HELD_TRANSCRIPTS,
  MAX_TRANSCRIPT_BYTES,
  commandsPlan,
  elapsedSince,
  holdConfig,
  fillWindow,
  gapPlan,
  loadStop,
  nextCut,
  reattachSince,
  sessionGroups,
  sessionLists,
} = await import("../src/store.js");
const {
  currentView,
  folderNames,
  folderPathOf,
  allRows,
  foldersOf,
  machineSubline,
  machineTabs,
  matchesQuery,
  rowSubpath,
  selectMachine,
  selectedMachineIn,
  setQuery,
  sublineWarns,
  toggleFolder,
  visibleRows,
  waitingFloor,
} = await import("../src/ui/groups.js");
const { sessionLabel } = await import("../src/ui/bits.js");
const { openableHref } = await import("../src/ui/links.js");
const {
  chipParts,
  chipReserve,
  chipValue,
  configProse,
  contextHint,
  contextPercent,
  drawnControls,
  labelFor,
  pieLabel,
  pieTone,
  shortCount,
  showsCaption,
  unavailableHint,
  restartsAgent,
  choiceRefusal,
  slotFor,
  splitOptions,
  withChoice,
} = await import("../src/ui/agentConfig.js");
const { canCancelTurn, cancelInFlight, hasLiveAgent, isTerminal, showsWorking } = await import("../src/wire.js");
const {
  TRANSCRIPT_SILENT,
  buildTail,
  mergeUpdates,
  placeNodes,
  resolveTool,
  opensToAnything,
  permissionDecisions,
  refused,
  restatesInput,
  runSummary,
  foldRuns,
  detailWorthDrawing,
  clipTitle,
  headlineWorthDrawing,
  TITLE_CHARS,
  TITLE_OVERFLOW_MIN,
  SUMMARY_CHARS,
  sameNode,
  showsInTranscript,
  stripFence,
  supersedes,
  toolSummary,
  outstandingTasks,
  stillRunning,
  isDelegation,
  MAX_CHILDREN,
} = await import("../src/ui/tail.js");
const {
  composerPlaceholder,
  focusWorthKeeping,
  markKeyNav,
  shouldFocusComposer,
  shouldReleaseComposer,
  takeKeyNav,
} = await import(
  "../src/ui/composing.js"
);
type Stream = InstanceType<typeof SessionStream>;

/* ------------------------------------------------------------------ *
 * A daemon-shaped WebSocket server
 *
 * Speaks only the frames `stream.ts` reads. Each connection records the `since`
 * it was opened with, which is what the rotation cases assert against.
 * ------------------------------------------------------------------ */

interface Attach {
  since: number;
  send: (frame: unknown) => void;
  close: (code: number, reason: string) => void;
  /**
   * An abrupt drop, which is what a network change actually looks like.
   *
   * `1006` cannot be *sent* — it is reserved for "the connection went away without
   * a close frame" — so a dead network has to be simulated by killing the socket,
   * not by closing it politely with that code.
   */
  terminate: () => void;
  /**
   * This socket is no longer open, from the *server's* side of it.
   *
   * Not "the client closed it" on its own — `close()` and `terminate()` above set
   * it too — but on a socket this side never touched, that is exactly what it
   * means, and it is the only way to see the difference between a client that
   * released an abandoned socket and one that left it attached to the daemon.
   */
  closed: boolean;
}

const attaches: Attach[] = [];
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });

/*
 * A `workspace`, because the fixture never had one.
 *
 * Every row below was built from a legacy `cwd` and no `workspace` at all, which
 * was harmless while nothing read it — and stops being harmless the moment
 * `folderPathOf` does. Fixed here rather than by writing `?.` into `groups.ts`:
 * optional chaining there would silently file every real session under the
 * fallback bucket and nothing would ever fail.
 */
const workspaceAt = (cwd: string, repoRoot: string | null = null) => ({
  mode: repoRoot === null ? "plain" : "worktree",
  root: cwd,
  requestedCwd: cwd,
  git: repoRoot === null ? null : { repoRoot, commonDir: `${repoRoot}/.git`, branch: "main", createdBranch: null, baseCommit: null },
  plainReason: repoRoot === null ? "not_requested" : null,
  createdAt: 0,
});

const snapshot = {
  id: "s_1",
  agent: "kimi",
  cwd: "/tmp",
  workspace: workspaceAt("/tmp"),
  status: "running",
  pendingPermissions: [],
  firstSeq: 1,
  lastSeq: 0,
  dropped: 0,
  createdAt: 0,
  lastEventAt: null,
  exit: null,
};

wss.on("connection", (socket: ServerSocket, request) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const since = Number(url.searchParams.get("since") ?? "0");
  const send = (frame: unknown): void => socket.send(JSON.stringify(frame));
  const attach: Attach = {
    since,
    send,
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    closed: false,
  };
  socket.on("close", () => void (attach.closed = true));
  attaches.push(attach);
});

await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
const port = (wss.address() as AddressInfo).port;

/** A `hello`, as the daemon sends it: always first, and it carries the snapshot. */
function hello(attach: Attach, since: number, gap = false): void {
  attach.send({
    type: "hello",
    instanceId: "i_1",
    session: snapshot,
    firstSeq: 1,
    lastSeq: since,
    since,
    gap,
  });
}

function events(attach: Attach, from: number, to: number): void {
  const batch = [];
  for (let seq = from; seq <= to; seq += 1) {
    batch.push({ seq, ts: seq, event: { type: "text", role: "assistant", thought: false, text: `#${seq} ` } });
  }
  attach.send({ type: "events", events: batch });
}

/* ------------------------------------------------------------------ *
 * A machine, to the extent `SessionStream` needs one
 * ------------------------------------------------------------------ */

let forgotten = 0;
let tokenExpiresAt: number | null = null;

const machine = {
  id: "m_1",
  ensureToken: async (): Promise<string> => "t_ok",
  // `{base}` alone: `Route` lost its `kind` with the direct path, and a stub that
  // kept the old shape would be the last place the deleted vocabulary survived.
  resolveRoute: async (): Promise<{ base: string }> => ({ base: `http://127.0.0.1:${port}` }),
  currentRoute: (): { base: string } => ({ base: `http://127.0.0.1:${port}` }),
  forgetRoute: (): void => void (forgotten += 1),
  tokenExpiresAt: (): number | null => tokenExpiresAt,
  streamUrl: (session: string, since: number): string =>
    `ws://127.0.0.1:${port}/sessions/${session}/stream?since=${since}&token=t_ok`,
};

/** Everything the sink was told, in order, so gaps and duplicates are both visible. */
function recorder() {
  const seqs: number[] = [];
  const gaps: { from: number; to: number }[] = [];
  let vanished = 0;
  return {
    seqs,
    gaps,
    get vanished(): number {
      return vanished;
    },
    sink: {
      onEvents: (_ref: unknown, batch: { seq: number }[]): void => {
        for (const stored of batch) seqs.push(stored.seq);
      },
      onSnapshot: (): void => {},
      onGap: (_ref: unknown, from: number, to: number): void => void gaps.push({ from, to }),
      onStatus: (): void => {},
      onVanished: (): void => void (vanished += 1),
    },
  };
}

function newStream(sink: unknown, since: number): Stream {
  // Duck-typed on purpose: constructing a real `MachineConnection` would pull in
  // the control plane, and the collaborator is exactly the seam that makes this
  // testable without one.
  return new SessionStream(
    { machineId: machine.id, sessionId: "s_1" } as never,
    machine as never,
    sink as never,
    since,
  );
}

async function nextAttach(count: number): Promise<Attach> {
  for (let i = 0; i < 200; i += 1) {
    if (attaches.length >= count) return attaches[count - 1]!;
    await sleep(10);
  }
  throw new Error(`attach ${count} never arrived`);
}

/**
 * `nextAttach`, for the cases where a socket that never arrives is the *answer*.
 *
 * A throw would be right for a fixture that cannot proceed and wrong for an
 * assertion whose whole subject is "does the client still open one" — the
 * orphaned-rotation case below fails by opening nothing, and a driver that
 * threw there would take every section after it down with the crash-truncation
 * failure CLAUDE.md records rather than printing one FAIL.
 */
async function attachWithin(count: number, ms: number): Promise<Attach | null> {
  for (let i = 0; i * 10 < ms; i += 1) {
    if (attaches.length >= count) return attaches[count - 1]!;
    await sleep(10);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The cursor across a rotation
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe cursor across a rotation\n");
{
  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  stream.start();

  const first = await nextAttach(1);
  check("the first socket attaches from the cursor it was given", first.since, 0);
  hello(first, 0);
  events(first, 1, 5);
  await sleep(50);
  check("events arrive once", rec.seqs, [1, 2, 3, 4, 5]);
  check("and the cursor follows them", stream.cursor, 5);

  /*
   * The rotation, with the old socket still talking.
   *
   * This is the case that was broken. The replacement captures `since` when it is
   * *opened* — 5 here — and the old socket stays live during the handshake, so by
   * the time the replacement's `hello` lands the cursor has moved to 8. Assigning
   * `frame.since` unconditionally rewound it to 5 and the replacement's backlog
   * then replayed 6, 7 and 8 straight past the `seq <= cursor` filter, appending
   * every one of them a second time. The hole check could not catch it either: a
   * replay from a rewound cursor is perfectly contiguous.
   */
  (stream as unknown as { rotate: () => Promise<void> }).rotate();
  const second = await nextAttach(2);
  check("the replacement attaches from the live cursor", second.since, 5);

  events(first, 6, 8);
  await sleep(30);
  check("the old socket keeps delivering during the handshake", stream.cursor, 8);

  hello(second, 5);
  events(second, 6, 10);
  await sleep(50);

  check("nothing is delivered twice across the rotation", rec.seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  check("and the cursor never went backwards", stream.cursor, 10);
  report("no gap was invented", rec.gaps.length === 0, `${rec.gaps.length} gap(s)`);
  stream.stop();
}

/* ------------------------------------------------------------------ *
 * A rotation the primary died underneath
 *
 * The rotation above is the happy path; this is the one that switched
 * make-before-break off for the life of the tab, silently.
 *
 * `successor` is cleared in exactly three places — `teardown()`, the `hello` that
 * promotes it, and its own `onclose` — and the last two sit behind
 * `if (generation !== this.generation)`. So a primary dying *during* a handshake
 * (a phone handing over Wi-Fi→LTE sends RST, and the successor's open is a full
 * relay round trip) went `onclose` → `handleClose` → `retryLater` → `connect()`,
 * and the generation bump there silenced the orphan's `onclose` for ever. The
 * field stayed non-null, every later `rotate()` returned at its first line, and
 * from then on the session took the token expiry as a **4401 close** every five
 * minutes instead of a rotation — while the orphaned socket stayed attached to
 * the daemon holding a `StreamConnection`.
 *
 * Both halves are visible from the server end, which is why this is driven
 * through real sockets rather than by reading a private field: the orphan is
 * closed by somebody this side never asked, and a rotation after the recovery
 * opens a fourth socket that the broken version never opens at all.
 * ------------------------------------------------------------------ */

process.stdout.write("\na rotation the primary died underneath\n");
{
  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  const rotate = (): void => void (stream as unknown as { rotate: () => Promise<void> }).rotate();
  stream.start();

  const first = await nextAttach(1);
  hello(first, 0);
  events(first, 1, 3);
  await sleep(40);

  // A rotation that gets as far as opening its replacement and no further: no
  // `hello`, so `successor` is still the field's live value.
  rotate();
  const orphan = await nextAttach(2);

  // And now the primary goes, which is the whole scenario. `handleClose` on a
  // 1006 re-probes and retries, so a third socket is due within one backoff
  // (500ms, jittered up to 1.2×) whether or not the successor was released.
  first.terminate();
  const third = await attachWithin(3, 3_000);
  report("the stream still comes back", third !== null, `${attaches.length} socket(s) opened`);
  if (third !== null) {
    hello(third, 3);
    await sleep(40);
    report("and the orphaned replacement was closed rather than left attached", orphan.closed, `closed: ${orphan.closed}`);

    /*
     * The consequence, and the assertion that actually fails on a revert: with
     * `successor` still pointing at the abandoned socket, `rotate()` returns at
     * its first line and nothing is ever opened again.
     */
    rotate();
    const fourth = await attachWithin(4, 1_000);
    report(
      "a later rotation still happens, so the successor slot was given back",
      fourth !== null,
      `${attaches.length} socket(s) opened`,
    );
    check("and it asks from the live cursor", fourth?.since, 3);
  }
  stream.stop();
}

/* ------------------------------------------------------------------ *
 * Replay across a reconnect
 * ------------------------------------------------------------------ */

process.stdout.write("\nreplay across a reconnect\n");
{
  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  stream.start();

  const first = await nextAttach(1);
  hello(first, 0);
  events(first, 1, 3);
  await sleep(50);

  // A network change, not an expiry: the route is implicated, so the memo goes.
  const before = forgotten;
  first.terminate();
  await sleep(60);
  report("a transport close drops the route memo", forgotten > before, `forgetRoute called ${forgotten - before}×`);

  const second = await nextAttach(2);
  check("and reconnects from the cursor, not from zero", second.since, 3);
  hello(second, 3);
  // `read` is `WHERE seq > ?`, so the daemon replays strictly after the cursor.
  events(second, 4, 6);
  await sleep(50);
  check("no event is repeated and none is skipped", rec.seqs, [1, 2, 3, 4, 5, 6]);
  stream.stop();
}

/* ------------------------------------------------------------------ *
 * Which answered request means the machine is gone
 *
 * The sibling of the close-code table below, for the HTTP path, and the rule is
 * the same one pointed the other way: a *code* decides, never a status. There is
 * no direct path any more, so `503 no_tunnel` from the relay is the only way a
 * client learns a daemon is not there — and the daemon answers its own `503
 * unresponsive` when a browse path sits on a network mount that has stopped
 * replying. Keying on the status would take a perfectly reachable machine
 * offline because one directory did not answer.
 *
 * Asserted here as a pure function, because that is what it is: the rule lives
 * in `meansMachineGone` so that one table decides it for every caller. What each
 * caller then *does* with the answer is the section below, which drives a real
 * `MachineConnection` over a stubbed `fetch` — this docblock used to say such a
 * thing could not be constructed here, and that stopped being true once the
 * control-plane client became stubbable.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich answered request means the machine is gone\n");
{
  const { ApiError, meansMachineGone, meansRestartRefused } = await import("../src/http.js");
  const err = (status: number, code: string): unknown => new ApiError(status, code, `${code}`);

  check("the relay saying there is no tunnel does", meansMachineGone(err(503, "no_tunnel")), true);
  /*
   * **And so does the relay refusing a machine past its owner's limit**, which
   * is the highest-risk seam the machine limit added to this client.
   * `machine.ts` calls `forgetRoute()` on exactly what this function admits, so
   * a code missing from it is a route memo that is never dropped — a suspended
   * machine drawn as `online` while every single request against it fails, with
   * nothing on screen to correct it.
   */
  check("and the relay refusing one over the machine limit", meansMachineGone(err(403, "machine_over_limit")), true);
  check("and one whose owner is banned", meansMachineGone(err(403, "owner_disabled")), true);

  /*
   * ⭐ **The one code the config strip swallows, and the ratchet that stops it
   * becoming `catch {}`.**
   *
   * `applyConfigChange` no longer toasts `turn_in_flight`, because the choice row
   * says the sentence before the tap. Every other refusal on that route is a fact
   * the client could not have known, and must still reach the bottom of the
   * screen. Keyed on the CODE and never the status: `409` is also
   * `session_busy` and `session_not_ready`, both of which stay loud. Q3.429.
   */
  check("the restart refusal is the one the row already answered", meansRestartRefused(err(409, "turn_in_flight")), true);
  check(
    "and every other config refusal still reaches the screen",
    [
      meansRestartRefused(err(409, "session_busy")),
      meansRestartRefused(err(409, "session_not_ready")),
      meansRestartRefused(err(409, "session_terminal")),
      meansRestartRefused(err(502, "agent_config_failed")),
      meansRestartRefused(err(400, "invalid_config_value")),
      meansRestartRefused(new TypeError("fetch failed")),
    ],
    [false, false, false, false, false, false],
  );
  {
    /*
     * The catch must stay a *narrowing* rather than a swallow: exactly one
     * suppression, and the toast still written twice in that file — once for an
     * unreachable machine, once for everything the daemon refused.
     */
    const bar = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    check("the strip still raises a toast, twice", (bar.match(/toast\(/g) ?? []).length, 2);
    check("and suppresses exactly one code", (bar.match(/meansRestartRefused\(/g) ?? []).length, 1);
    /*
     * The hand-mirrored literals this client cannot import, pinned against the
     * daemon's own source — the ⚠ standing at `CATEGORY_RESERVE` for the *name*,
     * now closed, plus the two values `restartsAgent` keys on.
     */
    const registrySrc = readFileSync(new URL("../../../src/registry.ts", import.meta.url), "utf8");
    check("the mirrored ultracode value is the daemon's", /ULTRACODE_CHOICE = "ultracode"/.test(registrySrc), true);
    check("and the name the chip reserves width for", /name: "Ultracode"/.test(registrySrc), true);
  }
  /*
   * The near-miss, pinned in both directions: `user_disabled` is about the
   * *caller* and is handled by signing out, not by forgetting a route. Getting
   * these two the wrong way round would either sign a grantee out of the app or
   * leave a banned owner's machine drawn as reachable for ever.
   */
  check("but the caller being banned is not a fact about a route", meansMachineGone(err(403, "user_disabled")), false);
  // The one that matters: same status, opposite meaning. This is the daemon
  // talking, on a machine that is plainly reachable.
  check("the daemon saying a path is unresponsive does not", meansMachineGone(err(503, "unresponsive")), false);
  check("nor does an expired token", meansMachineGone(err(401, "token_expired")), false);
  check("nor does an unknown session", meansMachineGone(err(404, "session_not_found")), false);
  // A transport failure is not an answer at all; `request` handles it on the
  // other branch, and reading it here would double-count.
  check("nor does a transport failure", meansMachineGone(new TypeError("fetch failed")), false);
}

/* ------------------------------------------------------------------ *
 * A machine that moved to another relay
 *
 * With one relay `relayUrl` is a constant and none of this can happen. With two
 * it moves whenever a daemon redials, because the shared name fronts both and
 * `relayUrlFor` answers with whichever relay actually holds the tunnel.
 *
 * `forgetRoute` drops the *route memo* and keeps the token, and `relayUrl` is
 * only ever assigned inside `mint()`. So the documented recovery — drop the
 * belief, re-probe — re-probed the relay that had just said it does not hold
 * this machine, deterministically, every 15s, until the token happened to need
 * renewing: up to `300s - TOKEN_RENEW_MARGIN_MS`, i.e. 210 seconds of a machine
 * drawn offline whose daemon is fine. A wake repaired it, so a phone recovered
 * on tab focus and a desktop left alone did not.
 *
 * Driven against a real `MachineConnection` over a stubbed `fetch`, because the
 * defect is in the *sequence* — mint, probe, answer, re-probe — and every pure
 * function involved was already correct.
 * ------------------------------------------------------------------ */

process.stdout.write("\na machine that moved to another relay\n");
{
  const cp = await import("../src/cp.js");
  const { MachineConnection } = await import("../src/machine.js");
  const { ApiError } = await import("../src/http.js");

  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** What the control plane would answer for this machine right now. */
  let routedTo = "https://r1.example";
  /** Which relay is actually holding the tunnel. The other one answers 503. */
  let holdsTunnel = "https://r1.example";
  /** Set to make the daemon side fail at the transport rather than answer. */
  let transportDown = false;
  const mints: string[] = [];
  const daemonCalls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      mints.push(routedTo);
      const now = Date.now();
      return json({
        token: `jws-${mints.length}`,
        expiresAt: now + 300_000,
        serverTime: now,
        machine: { relayUrl: routedTo, relayOnline: true },
      });
    }
    daemonCalls.push(url);
    if (transportDown) throw new TypeError("fetch failed");
    if (!url.startsWith(holdsTunnel)) {
      return json({ error: { code: "no_tunnel", message: "no tunnel for this machine" } }, 503);
    }
    return json(url.endsWith("/health") ? { ok: true } : { sessions: [] });
  }) as typeof fetch;

  cp.setSession("rs_relaymove");
  const connection = new MachineConnection(
    {
      id: "m_move",
      name: "laptop",
      relayUrl: "https://r1.example",
      relayOnline: true,
      enrolled: true,
      owned: true,
      scopes: [],
    } as never,
    () => {},
  );

  const settled = await connection.resolveRoute();
  check("it settles on the relay the control plane named", settled?.base, "https://r1.example");
  check("having minted exactly once to learn that", mints.length, 1);

  /*
   * The daemon redials — a deploy, a lid, a network change — and lands on the
   * other relay. Nothing tells the browser; the row it holds is now wrong.
   */
  routedTo = "https://r2.example";
  holdsTunnel = "https://r2.example";

  const refused = await connection.request("/sessions").then(
    () => "resolved",
    (error: unknown) => (ApiError.isApiError(error) ? error.code : String(error)),
  );
  check("the next request is refused by the relay it still believes in", refused, "no_tunnel");

  /*
   * The repair, and it is deliberately not awaited by the request that triggered
   * it — `refetchRoute` fires into the background so the caller still throws the
   * error it actually failed with.
   */
  await sleep(30);
  report(
    "which re-asks the control plane where the machine is",
    mints.length === 2,
    `mints: ${JSON.stringify(mints)}`,
  );
  check("so the held route moves with it", connection.state().relayUrl, "https://r2.example");

  const moved = await connection.resolveRoute();
  check("and the next resolve lands on the relay that holds the tunnel", moved?.base, "https://r2.example");
  report(
    "with no probe ever aimed at the wrong relay twice",
    daemonCalls.filter((url) => url.startsWith("https://r1.example")).length === 2,
    `r1: ${JSON.stringify(daemonCalls.filter((url) => url.startsWith("https://r1.example")))}`,
  );

  /*
   * **The other half, which is why this is not inside `forgetRoute`.** That is
   * called on every transport failure too, and a phone on flaky LTE would then
   * mint a token per dropped request — against the one service whose outage this
   * client is built to survive. A transport failure says nothing about *where*
   * the machine is, so it must re-probe and not re-ask.
   */
  const before = mints.length;
  transportDown = true;
  await connection.request("/sessions").then(
    () => undefined,
    () => undefined,
  );
  check("but a dropped request re-probes without re-asking", mints.length, before);
  check("and still gives up the route memo", connection.state().route, null);

  globalThis.fetch = realFetch;
  cp.clearSession();
}

/* ------------------------------------------------------------------ *
 * What a failed call puts on screen
 *
 * `ApiError.isApiError(cause) ? cause.message : String(cause)` was written out
 * **23 times** across `packages/web/src` — every toast, every inline form error,
 * every settings panel. One expression that many times is one expression nobody
 * can change, and a call site that forgets the first half prints `[object
 * Object]` where a control plane had written a sentence.
 *
 * Two arms, and the second is a *faithful extraction* rather than an improvement:
 * `String(cause)` yields `"TypeError: Failed to fetch"` for a dead network, which
 * is exactly what those 23 sites already showed. Pinned in both directions, so
 * that changing what people read on 23 screens has to be a deliberate edit here
 * rather than a side effect of tidying `errorText`.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a failed call puts on screen\n");
{
  const { ApiError, errorText } = await import("../src/http.js");

  // The answered arm: the service's own sentence, and *only* that. Deliberately
  // not `machine.ts`'s `describe`, which prefixes the code (`no_tunnel: …`) —
  // right for the machine banner, jargon in front of a form field.
  check(
    "an answered failure reads as the service wrote it",
    errorText(new ApiError(409, "machine_exists", "you already have a machine called that")),
    "you already have a machine called that",
  );
  check("and the code is not smuggled into it", errorText(new ApiError(503, "no_tunnel", "no daemon")), "no daemon");

  // The unanswered arm. `String(error)` rather than `error.message`, because that
  // is what the 23 sites did and a bare "Failed to fetch" says less.
  check("a dead network keeps its own words", errorText(new TypeError("Failed to fetch")), "TypeError: Failed to fetch");
  check("an abort says so", errorText(new DOMException("The operation was aborted.", "TimeoutError")), "TimeoutError: The operation was aborted.");
  // Nothing thrown here is guaranteed to be an `Error`: a `catch (cause: unknown)`
  // takes whatever was thrown, and the point of the arm is that all of it renders.
  check("a thrown string renders", errorText("boom"), "boom");
  check("so does a thrown object", errorText({ nope: true }), "[object Object]");
  check("and nothing at all still says something", [errorText(null), errorText(undefined)], ["null", "undefined"]);
}

/* ------------------------------------------------------------------ *
 * Reading a body without a Response
 *
 * `parseBody` was extracted out of `readJson` so an upload can share it.
 * `XMLHttpRequest` is the only transport that reports upload progress — `fetch`
 * reports none and a streamed request body is Chromium-only — and it hands back
 * a status and a `responseText` rather than a `Response`. Without the extraction
 * the rules below would have been *copied* there.
 *
 * The one worth protecting is the `409` carrying a success-shaped body: the
 * daemon answers a repeated permission that way because the answer really did
 * land. A second copy that drifts reports a successful approval as a failure.
 * ------------------------------------------------------------------ */

process.stdout.write("\nreading a body without a Response\n");
{
  const { ApiError, parseBody } = await import("../src/http.js");
  const caught = (fn: () => unknown): InstanceType<typeof ApiError> | null => {
    try {
      fn();
      return null;
    } catch (error) {
      return ApiError.isApiError(error) ? error : null;
    }
  };

  check("a 2xx parses to its body", parseBody(200, "OK", '{"a":1}'), { a: 1 });
  check("an empty 2xx is null rather than a throw", parseBody(202, "Accepted", ""), null);

  // The rule the whole extraction exists to keep in one place.
  const repeat = caught(() => parseBody(409, "", '{"recorded":true,"repeat":true,"outcome":"selected"}'));
  check("a 409 with a success-shaped body still throws", repeat !== null, true);
  check("and keeps the whole body, so the caller can see it landed", repeat?.body, {
    recorded: true,
    repeat: true,
    outcome: "selected",
  });
  check("with no envelope, the code falls back to the status", repeat?.code, "http_409");

  const envelope = caught(() =>
    parseBody(404, "", '{"error":{"code":"session_not_found","message":"no such session","detail":{"id":"x"}}}'),
  );
  check("an envelope maps to code", envelope?.code, "session_not_found");
  check("to message", envelope?.message, "no such session");
  check("and to detail", envelope?.detail, { id: "x" });

  // A captive portal answers HTML. "unexpected end of JSON input" as the reason
  // a prompt failed is useless, so the body's own first characters are shown.
  check("a 2xx of HTML parses to null rather than throwing", parseBody(200, "OK", "<html>x</html>"), null);
  const html = caught(() => parseBody(502, "Bad Gateway", "<html>captive portal</html>"));
  check("HTML on a 502 becomes the message", html?.message, "<html>captive portal</html>");
  check("and the status becomes the code", html?.code, "http_502");
  const bare = caught(() => parseBody(500, "Internal Server Error", ""));
  check("an empty error body falls back to the status text", bare?.message, "Internal Server Error");
}

/* ------------------------------------------------------------------ *
 * What content type a body gets
 *
 * `MachineConnection.request` used to write `application/json` for *any* body,
 * which was true of every caller and would have silently corrupted the first one
 * that was not. An upload sends a `Blob`. Keyed on what the body is rather than
 * on a header argument, because `request` spreads `init` over its own `headers`
 * and therefore discards a caller-supplied header object — a good property worth
 * keeping rather than opening up for one route.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat content type a body gets\n");
{
  const { contentTypeFor } = await import("../src/http.js");

  // Every existing call site in `daemon.ts` passes `JSON.stringify(...)`, so
  // this is the assertion that the extraction changed nothing for them.
  check("a string is json", contentTypeFor(JSON.stringify({ text: "hi" })), "application/json");
  check("a blob is bytes", contentTypeFor(new Blob([new Uint8Array([1, 2])])), "application/octet-stream");
  check("so is an array buffer", contentTypeFor(new ArrayBuffer(4)), "application/octet-stream");
  check("and a typed array", contentTypeFor(new Uint8Array([1])), "application/octet-stream");
  // No header at all, which is what a GET must send — not an empty string.
  check("no body means no header", contentTypeFor(undefined), null);
  check("and neither does an explicit null", contentTypeFor(null), null);
}

/* ------------------------------------------------------------------ *
 * How long an upload is given
 *
 * A wall clock alone is the wrong instrument: a slow-but-progressing upload is
 * not a failure, and a large file over a phone uplink is many minutes rather than
 * the 15s an ordinary request gets. The stall budget is the primary bound and the
 * hard cap is only a backstop against a connection that trickles for ever.
 * ------------------------------------------------------------------ */

process.stdout.write("\nhow long an upload is given\n");
{
  const { uploadDeadlines } = await import("../src/machine.js");
  const { MAX_UPLOAD_BYTES } = await import("../src/wire.js");
  const MiB = 1024 * 1024;

  // A one-byte upload must not be *more* fragile than an ordinary request.
  check("a tiny upload gets at least what any request gets", uploadDeadlines(1).hardMs >= 15_000, true);
  /*
   * ⚠ **This pair asserted 300s and pinned the defect rather than the rule.**
   * It read "the cap does not exceed the token lifetime" and "25 MiB reaches the
   * cap" — so the cap was reached by the *largest file the daemon accepted*,
   * which is precisely the state in which the formula has stopped governing and a
   * progressing upload is cut off by arithmetic it never reaches the end of.
   *
   * The property, stated so it cannot be satisfied by a coincidence: at
   * `MAX_UPLOAD_BYTES` the scaled budget is still under the ceiling, so every
   * size this daemon will take is bounded by the assumed floor rather than by the
   * cap. The cap is what stops a nonsense `size` becoming a day.
   */
  check(
    "the largest file this daemon takes is still governed by the formula",
    uploadDeadlines(MAX_UPLOAD_BYTES).hardMs < uploadDeadlines(1024 * MiB).hardMs,
    true,
  );
  check("and the ceiling is what bounds anything past it", uploadDeadlines(1024 * MiB).hardMs, 45 * 60_000);
  check(
    "so 100 MiB gets a budget matched to the floor it assumes",
    uploadDeadlines(MAX_UPLOAD_BYTES).hardMs,
    20_000 + Math.ceil((100 * MiB) / 50),
  );

  // Monotone, so a larger file is never given less time than a smaller one.
  let monotone = true;
  let previous = 0;
  for (const bytes of [0, 1, 64 * 1024, MiB, 5 * MiB, 25 * MiB, 100 * MiB]) {
    const { hardMs } = uploadDeadlines(bytes);
    if (hardMs < previous) monotone = false;
    previous = hardMs;
  }
  check("and the cap never shrinks as the file grows", monotone, true);

  // The stall budget is about the link, not the payload, so it does not scale.
  check("the stall budget is independent of size", uploadDeadlines(MiB).stallMs, uploadDeadlines(100 * MiB).stallMs);
  // A negative would come from a bad `size`; it must not produce a shorter cap
  // than the floor.
  check("a nonsense size still gets the floor", uploadDeadlines(-1).hardMs >= 15_000, true);
}

/* ------------------------------------------------------------------ *
 * The close-code table
 *
 * The rule both clients share: the memo is dropped on a close the route is
 * implicated in, and **never** on the daemon answering. A 4401 is a scheduled
 * re-authentication and a 4003 is the daemon shouting that we are too slow — in
 * both cases it plainly answered, so re-probing the route would be wrong.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe close-code table\n");
{
  for (const [code, label, shouldForget] of [
    [4401, "an expiry close", false],
    [4003, "a slow-consumer close", false],
    [1011, "an internal-error close", true],
  ] as const) {
    attaches.length = 0;
    const rec = recorder();
    const stream = newStream(rec.sink, 0);
    stream.start();
    const attach = await nextAttach(1);
    hello(attach, 0);
    await sleep(30);

    const before = forgotten;
    attach.close(code, "bye");
    await sleep(80);
    check(`${label} ${shouldForget ? "drops" : "keeps"} the route memo`, forgotten > before, shouldForget);
    stream.stop();
  }

  attaches.length = 0;
  const rec = recorder();
  const stream = newStream(rec.sink, 0);
  stream.start();
  const attach = await nextAttach(1);
  hello(attach, 0);
  await sleep(30);
  attach.close(4404, "no such session");
  await sleep(80);
  check("a 4404 reports the session as gone", rec.vanished, 1);
  stream.stop();
}

/* ------------------------------------------------------------------ *
 * What is actually being approved
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe permission card's context\n");
{
  const base = { permissionId: "p1", toolCallId: null, title: "Running", options: [], raisedAt: 0 };

  // Measured against kimi: the command arrives as an ACP *text* content block and
  // `rawInput` is null. Treating text blocks as decoration produced an approve
  // button above an empty box every single time for the one agent that asks.
  const fromText = permissionContext(
    { ...base, rawInput: null, content: [{ type: "content", content: { type: "text", text: "echo hello" } }] } as never,
    [],
  );
  check("a command in a text block is found", fromText.text, ["echo hello"]);
  check("and the card is not reported empty", fromText.unavailable, false);

  const truncatedInput = permissionContext(
    { ...base, rawInput: { truncated: true, bytes: 9000 }, content: null } as never,
    [],
  );
  check("a truncated rawInput is reported as truncated", truncatedInput.truncated, true);

  /*
   * `content` is clamped by the same `clampBlob` as `rawInput`, so it can be the
   * stand-in too — and it is the diff case, the one most likely to exceed 8 KiB.
   * Only `rawInput` was checked, so this fell through to "the tool call is no
   * longer in the log", which is a false explanation for a payload that existed.
   */
  const truncatedContent = permissionContext(
    { ...base, rawInput: null, content: { truncated: true, bytes: 9000 } } as never,
    [],
  );
  check("a truncated content is too", truncatedContent.truncated, true);
  check("and does not claim the tool call is missing", truncatedContent.unavailable, false);

  // Truncation must not hide the rest: the text block is where the command lives.
  const both = permissionContext(
    {
      ...base,
      rawInput: { truncated: true, bytes: 9000 },
      content: [{ type: "content", content: { type: "text", text: "rm -rf /tmp/x" } }],
    } as never,
    [],
  );
  check("a truncated rawInput still surfaces the command text", both.text, ["rm -rf /tmp/x"]);

  const nothing = permissionContext({ ...base, rawInput: null, content: null } as never, []);
  check("genuinely nothing is reported as unavailable", nothing.unavailable, true);

  /* ---- what a Write is actually about to do ---- */

  /*
   * **Verbatim from this daemon's database**, session `s_435ad130` seqs 1988–1989.
   * The permission carries one sentence and nothing else; the file being written
   * is on the tool call's *update*, as a JSON string inside a text block. So the
   * card drew "Write" over "Requesting approval to Writing tictactoe.py" and the
   * thing being approved appeared nowhere at all.
   */
  const writeEvents = [
    { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "tc_w", title: "Write", kind: "edit", status: "pending", rawInput: null, locations: [] } },
    {
      seq: 2,
      at: 0,
      event: {
        type: "tool_call_update",
        toolCallId: "tc_w",
        title: null,
        status: "in_progress",
        rawInput: null,
        locations: [],
        content: [JSON.stringify({ path: "tictactoe.py", content: "line1\nline2\nline3" })],
      },
    },
  ];
  const write = permissionContext(
    {
      ...base,
      toolCallId: "tc_w",
      title: "Write",
      rawInput: null,
      content: [{ type: "content", content: { type: "text", text: "Requesting approval to Writing tictactoe.py" } }],
    } as never,
    writeEvents as never,
  );
  check("the file being written is recovered from the call's update", write.body, "line1\nline2\nline3");
  check("and so is the path it is going to", write.target, "tictactoe.py");
  /*
   * **A sentence that names the target says nothing the heading does not.** kimi
   * announces a write as "Requesting approval to Writing tictactoe.py"; the
   * heading is "Allow Kimi to write tictactoe.py?" and the path is in the box
   * under it. The same filter that drops a sentence repeating the *command*, one
   * field over.
   */
  check("the sentence repeating the target is dropped", write.text, []);
  check("and the target itself is still there to be drawn", write.target, "tictactoe.py");

  /*
   * **A sentence that already contains the command says nothing beside it.**
   * kimi's prose is "Requesting approval to Running: <the whole command>", so the
   * card drew the command twice — wrapped in a sentence and again on its own, both
   * monospace, both the width of the card.
   */
  const kimiBash = permissionContext(
    {
      ...base,
      title: "Bash",
      rawInput: { command: "printf '1\\n5\\n' | python3 tictactoe.py" },
      content: [
        {
          type: "content",
          content: { type: "text", text: "Requesting approval to Running: printf '1\\n5\\n' | python3 tictactoe.py" },
        },
      ],
    } as never,
    [],
  );
  check("the command survives", kimiBash.command, "printf '1\\n5\\n' | python3 tictactoe.py");
  check("and the sentence repeating it does not", kimiBash.text, []);
  check(
    "a description that mentions neither is untouched",
    permissionContext(
      {
        ...base,
        rawInput: { command: "rm x" },
        content: [{ type: "content", content: { type: "text", text: "tidying up x" } }],
      } as never,
      [],
    ).text,
    ["tidying up x"],
  );
  check("and it is not mistaken for arguments", write.rawInput, null);

  /*
   * The headline. `pending.title` on that request is the bare word `Write`, so the
   * card said the tool's name twice and named the file only in the small print.
   */
  /*
   * **The heading asks what is being asked**, which `pending.title` — `Bash`,
   * `Write` — is a category rather than a request. Every part of the sentence
   * comes from somewhere real: the agent's own id, ACP's `ToolKind`, and the
   * agent's own `description` or the path it named.
   */
  check(
    "a write with a path reads as a request",
    permissionHeadline("kimi", "Write", write),
    // **`write` from an `edit` kind.** ACP has one word for both and they are not
    // the same act: this payload carries a whole `body` and no diff, so the file
    // is being written rather than patched.
    "Allow Kimi to write tictactoe.py?",
  );
  /*
   * **The heading is the last segment; the box below it is the whole path.** Two
   * different strings rather than one repeated — a heading has to fit on a line
   * and the thing being approved has to be exact.
   */
  check(
    "a long path is the file's name in the heading",
    permissionHeadline("claude", "Write", {
      ...write,
      kind: "edit",
      target: "/Users/dev/projects/some long folder name/permission-test.txt",
    }),
    "Allow Claude to write permission-test.txt?",
  );
  check(
    "and the whole of it survives on the card",
    essentialContext({ ...write, target: "/Users/dev/projects/some long folder name/permission-test.txt" }).target,
    "/Users/dev/projects/some long folder name/permission-test.txt",
  );
  check(
    "a URL keeps its host, because the last segment is not the point there",
    permissionHeadline("claude", "Fetch", { ...write, kind: "fetch", target: "https://example.com/a/b" }),
    "Allow Claude to fetch https://example.com/a/b?",
  );

  /*
   * **A codex approval, exactly as one arrived**, and the third measured shape of
   * the same request.
   *
   * Taken 2026-08-07 from a real session through the daemon: codex sends the
   * command on `rawInput` (where kimi sends it as a text block), sends **no
   * `title`**, and sends no `kind` the snapshot keeps — so `title` falls back to
   * `toolCall.toolCallId` and the card is handed a bare uuid as its heading.
   *
   * That is the assertion. Every other agent's title is a word (`Bash`, `Write`,
   * `Terminal`), so nothing before this exercised a title that is *not* fit to
   * show anybody, and the two rules that rescue it — a verb inferred from
   * `command` when `kind` is null, and the generic object when there is no target
   * — are precisely the ones that would look redundant to a later reader.
   */
  const codexExec = permissionContext(
    {
      ...base,
      title: "exec-b34af4d4-869e-478f-9762-9255ac71f84b",
      // Quoted twice on purpose: codex runs `/bin/zsh -lc "<this>"` and puts the
      // inner string here, quotes included. Reported as sent — trimming them would
      // be this client editing a command before somebody approves it.
      rawInput: { command: `"curl -sS -o /dev/null -w '%{http_code}' https://example.com"`, cwd: "/w/s_x" },
      content: null,
    } as never,
    [],
  );
  check("codex puts the command on rawInput, where it is found", codexExec.command, `"curl -sS -o /dev/null -w '%{http_code}' https://example.com"`);
  check("and sends no kind with the request", codexExec.kind, null);
  check(
    "so the verb comes from there being a command at all",
    permissionHeadline("codex", "exec-b34af4d4-869e-478f-9762-9255ac71f84b", codexExec),
    "Allow Codex to run this command?",
  );
  /*
   * **The uuid must not reach the heading**, which is the whole point of the case.
   * A card headed `exec-b34af4d4-…` asks somebody to approve a command while
   * showing them an identifier for it.
   */
  check("and the tool call id never surfaces as a heading", permissionHeadline("codex", "exec-b34af4d4-869e-478f-9762-9255ac71f84b", codexExec).includes("exec-b34af4d4"), false);
  /*
   * Four options, and **two of them are `allow_always`** — codex offers "Allow for
   * Session" beside "Allow Commands Starting With `curl …`", an execpolicy
   * amendment. Nothing before this had a duplicate kind, and the button layout
   * keys on kind: the count is what proves neither is dropped and that the
   * primary is still the narrowest grant on offer.
   */
  const codexOptions = [
    { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for Session", kind: "allow_always" },
    { optionId: "accept_execpolicy_amendment", name: "Allow Commands Starting With `curl -sS`", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ];
  const codexButtons = permissionButtons(codexOptions as never);
  check("and the narrowest grant is still the default", codexButtons.primaryId, "allow_once");
  check("with the refusal leading", codexButtons.order[0]?.optionId, "reject_once");
  /*
   * **A duplicate kind is why every label here is the agent's own.** `optionLabel`
   * replaces a name with our word only when the kind identifies the option; two
   * `allow_always` options would both become "Always allow", which is the one
   * rendering that must never happen — the scope is the whole difference between
   * them.
   *
   * Asked against the **full** set, which is what the card passes: one of the two
   * is no longer drawn, but it was still sent, so the kind is still ambiguous and
   * the survivor must keep the name that distinguishes it.
   */
  check(
    "with two of a kind, no label is replaced by our word for it",
    codexButtons.order.map((o: { optionId: string }) => optionLabel(codexOptions as never, o as never)),
    ["Reject", "Allow for Session", "Allow Once"],
  );

  /*
   * The option that broke the row, and the three narrowings on removing it.
   *
   * The button row carries meaning by *position* — refusal alone on the left,
   * reversible approval filled on the right — because the colour these buttons
   * used to have was removed. A label that cannot fit a button wraps the row into
   * an arrangement where that rule says nothing while still looking deliberate.
   * Measured: codex's scoped grant embeds a command path, so it is unbounded by
   * construction, and the row became `Reject` + `Allow for Session`, the grant
   * alone, and the primary orphaned below.
   *
   * **By length, never by id.** Nothing knows the string
   * `accept_execpolicy_amendment`; recognising an option by its id or wording is
   * the guessing this codebase refuses everywhere, and it would miss the next
   * agent to word one differently.
   */
  check(
    "the label that cannot fit a button is not drawn",
    permissionButtons(codexOptions as never).order.map((o: { optionId: string }) => o.optionId),
    ["reject_once", "allow_always", "allow_once"],
  );
  check("and the row is three buttons again, refusal leading", permissionButtons(codexOptions as never).leading, 1);
  check("with the reversible approval still primary", permissionButtons(codexOptions as never).primaryId, "allow_once");
  /*
   * **A refusal is never dropped**, whatever it is called and however long. It is
   * the one option whose absence could be read as "there was no way to say no".
   */
  const longRefusal = [
    { optionId: "a", name: "Yes", kind: "allow_once" },
    { optionId: "b", name: "No, and stop asking me about this particular command for ever", kind: "reject_always" },
  ];
  check(
    "a refusal is kept however long its label",
    drawableOptions(longRefusal as never).map((o: { optionId: string }) => o.optionId),
    ["a", "b"],
  );
  /*
   * The same rule where deleting it would actually show, which the case above
   * does not.
   *
   * Nothing is dropped unless a *same-kind* sibling survives it, so a lone
   * over-long refusal is kept by that rule alone and the `startsWith("reject")`
   * guard could be deleted with every fixture still green. Two refusals of one
   * kind is the shape that needs the guard, and no agent has been measured
   * sending it — which is the point: the guard is what says a refusal is never
   * traded away, rather than happening not to be.
   */
  const twoRefusals = [
    { optionId: "a", name: "Yes", kind: "allow_once" },
    { optionId: "b", name: "No", kind: "reject_once" },
    { optionId: "c", name: "No, and never ask about /Users/u/reemoat/src again", kind: "reject_once" },
  ];
  check(
    "and a refusal is not traded away for a shorter refusal",
    drawableOptions(twoRefusals as never).map((o: { optionId: string }) => o.optionId),
    ["a", "b", "c"],
  );
  /*
   * **Never the last approval.** Dropping down to refusal-only would leave a card
   * that cannot be answered, so an over-long label is drawn badly instead — a
   * rendering problem being the smaller of the two.
   */
  const onlyLong = [
    { optionId: "a", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "b", name: "No", kind: "reject_once" },
  ];
  check(
    "the only way to approve survives even when it does not fit",
    drawableOptions(onlyLong as never).map((o: { optionId: string }) => o.optionId),
    ["a", "b"],
  );
  // The shapes every other agent sends are untouched — nothing is removed from an
  // ordinary approval.
  check(
    "claude's three are all drawn",
    drawableOptions([
      { optionId: "a", name: "Yes", kind: "allow_once" },
      { optionId: "b", name: "Yes, and don't ask again", kind: "allow_always" },
      { optionId: "c", name: "No", kind: "reject_once" },
    ] as never).length,
    3,
  );
  check(
    "and kimi's three, whose longest is 24 characters",
    drawableOptions([
      { optionId: "a", name: "Approve", kind: "allow_once" },
      { optionId: "b", name: "Approve for this session", kind: "allow_always" },
      { optionId: "c", name: "Reject", kind: "reject_once" },
    ] as never).length,
    3,
  );
  /*
   * **claude's scoped grant, which is the shape a length-only filter took.**
   *
   * This is the fixture 200 lines below at `scoped`, where it pins `optionLabel`
   * keeping the globs — and it was never passed to `drawableOptions`, so the
   * driver asserted a label for a button the card had stopped drawing. Written as
   * "drop everything that does not fit", the 64-character `allow_always` went and
   * the card offered Deny and Allow once: a standing grant unreachable from a
   * phone, on the one request where the scope *is* the decision.
   *
   * It survives because it is the only `allow_always` on the card. codex's
   * amendment is dropped because "Allow for Session" is not.
   */
  const claudeScoped = [
    { optionId: "s1", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "s2", name: "Allow", kind: "allow_once" },
    { optionId: "s3", name: "Reject", kind: "reject_once" },
  ];
  check(
    "a scope with no shorter sibling is drawn badly rather than dropped",
    drawableOptions(claudeScoped as never).map((o: { optionId: string }) => o.optionId),
    ["s1", "s2", "s3"],
  );
  /*
   * **The mirror, and the one that decides what the filled button means.**
   *
   * Everything above is about losing the *broad* grant. Length alone is
   * symmetrical, so an agent wording `allow_once` past the ceiling lost the
   * narrow one instead — and `primaryId` is the last approval in the row, so the
   * filled right-hand button became the permanent grant. `AskCard`'s whole
   * left/right rule is "the reversible approval filled on the right"; that is the
   * one thing this function must not be able to break.
   */
  const longAllowOnce = [
    { optionId: "r", name: "Deny", kind: "reject_once" },
    { optionId: "once", name: "Allow once for /Users/u/reemoat/src", kind: "allow_once" },
    { optionId: "always", name: "Approve", kind: "allow_always" },
  ];
  check(
    "the narrow grant is never traded for the permanent one",
    drawableOptions(longAllowOnce as never).map((o: { optionId: string }) => o.optionId),
    ["r", "once", "always"],
  );
  check(
    "so the filled button is still the reversible approval",
    permissionButtons(longAllowOnce as never).primaryId,
    "once",
  );
  /*
   * **Answers are not scopes, and they reach this function.**
   *
   * kimi's `AskUserQuestion` arrives as a `session/request_permission` whose
   * answers are `allow_once` options named by the model. `askedQuestion` returns
   * null when `rawInput` was truncated at the 8 KiB pending-permission cap or the
   * transcript has not paged in yet — the window `PermissionCard`'s `loadAll`
   * exists to close — and the card then falls back to `layout: "buttons"`.
   * Filtering there deleted two of the four answers, each a sentence and none of
   * them a narrower version of another.
   *
   * More than one `allow_once` is the test `askedQuestion` itself makes for "this
   * is a question", reused here rather than invented.
   */
  const kimiAnswers = [
    { optionId: "a1", name: "Use SQLite", kind: "allow_once" },
    { optionId: "a2", name: "Use Postgres with a connection pool", kind: "allow_once" },
    { optionId: "a3", name: "Keep everything in memory for now", kind: "allow_once" },
    { optionId: "a4", name: "Let me describe something else", kind: "allow_once" },
    { optionId: "skip", name: "Skip", kind: "reject_once" },
  ];
  check(
    "a question that fell back to buttons keeps every answer the model wrote",
    drawableOptions(kimiAnswers as never).map((o: { optionId: string }) => o.optionId),
    ["a1", "a2", "a3", "a4", "skip"],
  );
  check(
    "and with no kind at all, a body is still enough to say what happens",
    permissionHeadline("kimi", "Write", { ...write, kind: null }),
    "Allow Kimi to write tictactoe.py?",
  );
  check(
    "a hunk is an edit, though — the same kind, the other act",
    permissionHeadline("kimi", "Edit", {
      ...write,
      body: null,
      diffs: [{ type: "file_change", path: "a.ts", oldText: "a", newText: "b", source: "diff", toolCallId: null }],
    } as never),
    "Allow Kimi to edit tictactoe.py?",
  );
  check(
    "and the tool's own description wins over the path",
    permissionHeadline("claude", "Bash", {
      ...write,
      kind: "execute",
      command: "./words.py birthday",
      summary: "Run analogy, odd-one-out and neighbours demos",
    }),
    "Allow Claude to run Run analogy, odd-one-out and neighbours demos?",
  );
  check(
    "a command with neither still says the whole truth",
    permissionHeadline("kimi", "Bash", { ...write, kind: "execute", target: null, body: null, command: "printf x" }),
    "Allow Kimi to run this command?",
  );
  /*
   * The fallback, and it is the old behaviour: with no verb to be had — an
   * unknown `kind`, nothing executable, no body — the sentence would be invented
   * rather than derived, so the tool's name plus its target stands instead.
   */
  check(
    "an unknown kind falls back to the tool and what it touches",
    permissionHeadline("kimi", "Read", { ...write, kind: null, body: null, target: "/tmp/x.png" }),
    "Read /tmp/x.png",
  );
  check(
    "and a title that already names the target does not say it twice",
    permissionHeadline("kimi", "Read /tmp/x.png", { ...write, kind: null, body: null, target: "/tmp/x.png" }),
    "Read /tmp/x.png",
  );

  /* ---- where each decision button goes ---- */

  /*
   * **This reverses a documented rule and the reversal is the assertion.** The
   * agent's own order was kept untouched on the grounds that choosing which answer
   * sits nearest the thumb is an opinion in front of a safety decision. True of a
   * stacked list where every row looks alike; false of a row of buttons, where
   * kimi's order — approve, approve-always, reject — puts the refusal under the
   * thumb and the two approvals a thumb-width away from it.
   */
  const kimiOrder = [
    { optionId: "a", name: "Approve once", kind: "allow_once" },
    { optionId: "b", name: "Approve for this session", kind: "allow_always" },
    { optionId: "c", name: "Reject", kind: "reject_once" },
  ];
  const laid = permissionButtons(kimiOrder as never);
  check("a refusal goes first and the reversible approval last", laid.order.map((o) => o.optionId), ["c", "b", "a"]);
  check("with the refusal alone on the left of the gap", laid.leading, 1);
  check("and allow-once filled, because it is the one that can be taken back", laid.primaryId, "a");

  /*
   * claude's plan-mode request: three `allow_always`, one `allow_once`, one
   * refusal. Only `allow_once` is deliberately moved, so the three keep the order
   * the agent gave them.
   */
  const planOrder = [
    { optionId: "p1", name: "Yes, and bypass permissions", kind: "allow_always" },
    { optionId: "p2", name: 'Yes, and use "auto" mode', kind: "allow_always" },
    { optionId: "p3", name: "Yes, and auto-accept edits", kind: "allow_always" },
    { optionId: "p4", name: "Yes, and manually approve edits", kind: "allow_once" },
    { optionId: "p5", name: "No, keep planning", kind: "reject_once" },
  ];
  check(
    "everything else keeps the place the agent gave it",
    permissionButtons(planOrder as never).order.map((o) => o.optionId),
    ["p5", "p1", "p2", "p3", "p4"],
  );

  check(
    "an unknown kind is an approval rather than a guess",
    permissionButtons([{ optionId: "x", name: "?", kind: "something_new" }] as never),
    { order: [{ optionId: "x", name: "?", kind: "something_new" }], leading: 0, primaryId: "x" },
  );
  check(
    "and a request with nothing to approve has no primary",
    permissionButtons([{ optionId: "n", name: "No", kind: "reject_once" }] as never).primaryId,
    null,
  );
  check("no options at all is not a crash", permissionButtons([]), { order: [], leading: 0, primaryId: null });

  /* ---- what a decision button says ---- */

  /*
   * **The kind's word, but only when the kind is unambiguous.** kimi words
   * `allow_always` as "Approve for this session"; claude words it as "Always
   * Allow Read(//tmp/x/**)". One concept, two vocabularies, and the kind is
   * already deciding this button's position and its fill.
   */
  check(
    "kimi's three become the words the kind already carries",
    kimiOrder.map((o) => optionLabel(kimiOrder as never, o as never)),
    ["Allow once", "Always allow", "Deny"],
  );

  /*
   * **And claude's plan-mode request is why it is conditional.** Three
   * `allow_always` options, identical in kind, told apart only by their names —
   * renaming would draw three identical buttons for three different permanent
   * grants. All-or-nothing per request, so a row is never half the agent's words
   * and half ours.
   */
  check(
    "a repeated kind keeps every name in the request, not just its own",
    planOrder.map((o) => optionLabel(planOrder as never, o as never)),
    [
      "Yes, and bypass permissions",
      'Yes, and use "auto" mode',
      "Yes, and auto-accept edits",
      "Yes, and manually approve edits",
      "No, keep planning",
    ],
  );

  /*
   * **A name that already says what the kind says is carrying something extra.**
   * claude words a scoped grant as `Always Allow Read(//tmp/svgout/**)`, and
   * replacing that with "Always allow" turns a path-scoped standing approval into
   * an unconditional-looking one — the globs are the only thing saying what is
   * being permanently granted.
   */
  const scoped = [
    { optionId: "s1", name: "Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", kind: "allow_always" },
    { optionId: "s2", name: "Allow", kind: "allow_once" },
    { optionId: "s3", name: "Reject", kind: "reject_once" },
  ];
  check(
    "a scoped grant keeps its scope",
    scoped.map((o) => optionLabel(scoped as never, o as never)),
    ["Always Allow Read(//tmp/svgout/**), Read(//private/tmp/svgout/**)", "Allow once", "Deny"],
  );

  check(
    "an unknown kind is left alone, because there is no better version of it",
    optionLabel(
      [{ optionId: "x", name: "Do the thing", kind: "something_new" }] as never,
      { optionId: "x", name: "Do the thing", kind: "something_new" } as never,
    ),
    "Do the thing",
  );

  /*
   * Collapsed, the file outranks the sentence announcing it — they were the only
   * two things on the card and one of them was the headline again.
   */
  const writeEssential = essentialContext(write);
  /*
   * **A file is behind `details`; a command is not.** Both are "what the tool is
   * about to do" and they are not the same kind of thing: a command is one line
   * and *is* the decision, so hiding it would mean approving a shell line you have
   * to press something to read. A file is two hundred lines whose first twelve are
   * a docstring, and shown collapsed it pushes the buttons off a phone to say
   * nothing.
   */
  check("collapsed, the file is not shown at all", writeEssential.body, null);
  check("and expanding is what reveals the file", write.body, "line1\nline2\nline3");
  const shortBash = permissionContext({ ...base, rawInput: { command: "echo hi" }, content: null } as never, []);
  check("a command is the other way round — collapsed keeps it", essentialContext(shortBash).command, "echo hi");

  /*
   * **`details` is offered only where something was withheld**, and this gate has
   * now been wrong in both directions: first a general "is anything clipped",
   * which hid the control for a request the card could not explain at all; then
   * unconditional, which put a disclosure under every one-line `Bash` promising
   * bookkeeping. A file and a diff are what somebody may not be ready to read. A
   * command is one line, it is the decision, and it is already on screen.
   */
  check("a one-line command withholds nothing, so there is no disclosure", withheldDetail(shortBash), false);

  /*
   * **The two halves are a partition**, which is what lets the button sit between
   * them instead of underneath what it reveals. Nothing is clipped and then
   * un-clipped, so nothing is drawn twice.
   */
  check(
    "what is always shown, and what expanding adds, do not overlap",
    [essentialContext(write).body, essentialContext(write).text, detailContext(write).text, detailContext(write).body],
    [null, [], [], "line1\nline2\nline3"],
  );
  check(
    "and a long command is no longer clipped, because the box already bounds it",
    essentialContext(permissionContext({ ...base, rawInput: { command: "a\nb\nc\nd\ne" }, content: null } as never, [])).command,
    "a\nb\nc\nd\ne",
  );
  check("a file about to be written is withheld", withheldDetail(write), true);
  check(
    "and so is a diff about to be applied",
    withheldDetail(
      permissionContext(
        { ...base, rawInput: null, content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }] } as never,
        [],
      ),
    ),
    true,
  );
  check("collapsed, that diff is not drawn either", essentialContext(
    permissionContext(
      { ...base, rawInput: null, content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }] } as never,
      [],
    ),
  ).diffs.length, 0);
  check(
    "a long command withholds nothing either — it is shown whole",
    withheldDetail(
      permissionContext({ ...base, rawInput: { command: "a\nb\nc\nd\ne" }, content: null } as never, []),
    ),
    false,
  );

  /*
   * With the digest gone, `unavailable` is no longer a reason to offer the
   * disclosure — there would be nothing behind it. The four things
   * `detailContext` carries are the only reasons left.
   */
  check(
    "a request nothing can explain has nothing to disclose either",
    withheldDetail(permissionContext({ ...base, rawInput: null, content: null } as never, [])),
    false,
  );

  /*
   * The parse is a *shape* and not a name: prose that merely begins with a brace
   * stays prose, and a text block that is a JSON object is arguments.
   */
  const braceProse = permissionContext(
    { ...base, rawInput: null, content: [{ type: "content", content: { type: "text", text: "{this is not json" } }] } as never,
    [],
  );
  check("prose that starts with a brace is still prose", braceProse.text, ["{this is not json"]);
  const jsonProse = permissionContext(
    { ...base, rawInput: null, content: [{ type: "content", content: { type: "text", text: JSON.stringify({ command: "echo hi" }) } }] } as never,
    [],
  );
  check("a JSON text block is read as the tool's arguments", jsonProse.command, "echo hi");

  /*
   * **claude's plan mode sends the plan twice**, and the card drew it twice.
   * Measured against s_f07c0791 seq 47/48: `rawInput` is `{plan, planFilePath}`
   * and the content block's text is byte-for-byte `rawInput.plan` — 5175
   * characters of markdown. `plan` is in no `BODY_FIELD`, so `pretty` survived
   * and `details` held the whole document twice, the second copy with every
   * newline escaped.
   *
   * Fields are dropped rather than the blob, so `planFilePath` — the only thing
   * in there the prose does *not* say — survives.
   */
  const plan = "# Plan\n\nDo the thing.";
  const planned = permissionContext(
    {
      ...base,
      title: "Ready to code?",
      rawInput: { plan, planFilePath: "/Users/x/.claude/plans/p.md" },
      content: [{ type: "content", content: { type: "text", text: plan } }],
    } as never,
    [],
  );
  check("the readable copy of the plan stays", planned.text, [plan]);
  check("the escaped copy of it does not", planned.rawInput?.includes("# Plan"), false);
  check("and the one field the prose never said survives", planned.rawInput, '{\n  "planFilePath": "/Users/x/.claude/plans/p.md"\n}');
  check(
    "a blob whose every field is echoed becomes nothing at all",
    permissionContext(
      { ...base, rawInput: { plan }, content: [{ type: "content", content: { type: "text", text: plan } }] } as never,
      [],
    ).rawInput,
    null,
  );
  check(
    "and a blob that echoes nothing is untouched",
    permissionContext({ ...base, rawInput: { abc: "x" }, content: null } as never, []).rawInput,
    '{\n  "abc": "x"\n}',
  );
  check("and is not also shown as prose", jsonProse.text, []);

  /* ---- a permission that is really a question ---- */

  /*
   * **The shape is verbatim from this daemon's own database**, session
   * `s_435ad130`, seqs 733–929: the `tool_call` and 195 of its updates carry
   * `rawInput: null`, the arguments appear once on the last update before the
   * request, and the request itself carries no `rawInput` at all. So the join has
   * to reach the updates or there is nothing to read — which is how this returned
   * nothing on the first attempt. Only the *wording* is stand-in: one header, one
   * question and four options each carrying a label and a description, which is
   * every field the join and the identity match below read.
   *
   * What it is asserting is that kimi's `AskUserQuestion` renders as the same
   * card claude's does: the question as the title, the answers as neutral rows
   * carrying their own descriptions, and Skip as a footer action.
   */
  const askInput = {
    questions: [
      {
        header: "Rules",
        question: "Which house rule should we add to our tic-tac-toe?",
        options: [
          { label: "Battlefield", description: "You may move into any square" },
          { label: "On the clock", description: "Five seconds per move" },
          { label: "Knockout", description: "The winner takes the square" },
          { label: "No rules", description: "Classic" },
        ],
      },
    ],
  };
  const askPending = {
    permissionId: "perm-1-f50",
    toolCallId: "5:tool_rk3",
    title: "AskUserQuestion",
    raisedAt: 0,
    rawInput: null,
    content: null,
    options: [
      { optionId: "q0_opt_0", name: "Battlefield", kind: "allow_once" },
      { optionId: "q0_opt_1", name: "On the clock", kind: "allow_once" },
      { optionId: "q0_opt_2", name: "Knockout", kind: "allow_once" },
      { optionId: "q0_opt_3", name: "No rules", kind: "allow_once" },
      { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
    ],
  };
  const askEvents = [
    { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "5:tool_rk3", title: "Asking user questions", kind: "other", status: "pending", rawInput: null, locations: [], content: [] } },
    { seq: 2, at: 0, event: { type: "tool_call_update", toolCallId: "5:tool_rk3", title: null, status: "in_progress", rawInput: askInput, locations: [], content: [] } },
  ];

  /*
   * Through the real `permissionContext`, because the gate this now carries reads
   * it: a request that authorizes a concrete action — a command, a file body, a
   * diff, a set of locations — is never a question, whatever its payload says
   * about itself.
   */
  const asking = (pending: unknown, events: unknown): ReturnType<typeof askedQuestion> =>
    askedQuestion(pending as never, events as never, permissionContext(pending as never, events as never));

  const asked = asking(askPending, askEvents);
  check("a question's wording is recovered from the tool call's updates", asked?.question, "Which house rule should we add to our tic-tac-toe?");
  check(
    "and every answer keeps its own description, joined by identity",
    asked?.answers.map((a) => [a.optionId, a.label, a.description]),
    [
      ["q0_opt_0", "Battlefield", "You may move into any square"],
      ["q0_opt_1", "On the clock", "Five seconds per move"],
      ["q0_opt_2", "Knockout", "The winner takes the square"],
      ["q0_opt_3", "No rules", "Classic"],
    ],
  );
  check("the reject option is the skip, by kind and not by its name", asked?.skip, { optionId: "q0_skip", name: "Skip" });

  /*
   * The gate is the enum, not the title. Every real approval this daemon has
   * recorded offers exactly one `allow_once`; both questions offer four. Two
   * options that both say `allow_once` are indistinguishable *as permissions*, so
   * the name is carrying the meaning and it is a choice.
   */
  const oneAllow = {
    ...askPending,
    title: "AskUserQuestion",
    options: [
      { optionId: "a", name: "Battlefield", kind: "allow_once" },
      { optionId: "b", name: "On the clock", kind: "allow_always" },
      { optionId: "c", name: "no", kind: "reject_once" },
    ],
  };
  check("one allow_once is an approval however it is titled", asking(oneAllow, askEvents), null);
  check(
    "and a real approval with a command is untouched",
    asking(
      { ...base, rawInput: { command: "rm -rf /tmp/x" }, options: [{ optionId: "y", name: "Yes", kind: "allow_once" }, { optionId: "n", name: "No", kind: "reject_once" }] },
      [],
    ),
    null,
  );

  // Nothing keys on the title, so a differently-worded agent works identically.
  check(
    "the title is never read — renaming the tool changes nothing",
    asking({ ...askPending, title: "let us talk" }, askEvents)?.question,
    "Which house rule should we add to our tic-tac-toe?",
  );

  /*
   * Every failure falls back to the approval rendering rather than to a partial
   * question, because an answer we could not match is an answer whose description
   * would land on the wrong row.
   */
  check(
    "an option that matches no label abandons the whole question",
    asking(
      { ...askPending, options: [...askPending.options.slice(0, 3), { optionId: "q0_opt_3", name: "Something else", kind: "allow_once" }, askPending.options[4]] },
      askEvents,
    ),
    null,
  );
  check(
    "an 8 KiB stand-in is not a question",
    asking({ ...askPending, rawInput: { truncated: true, bytes: 9000 } }, []),
    null,
  );
  check("and neither is a tool input of some other shape", asking(askPending, [
    { seq: 1, at: 0, event: { type: "tool_call", toolCallId: "5:tool_rk3", title: "x", kind: "other", status: "pending", rawInput: { command: "ls" }, locations: [], content: [] } },
  ]), null);
  check("two reject options is a shape nobody has measured", asking(
    { ...askPending, options: [...askPending.options, { optionId: "q0_skip2", name: "Never", kind: "reject_always" }] },
    askEvents,
  ), null);

  /*
   * **The hole this gate closes, driven with the payload that opens it.**
   *
   * Four innocuous `allow_once` options and a tool input carrying a `questions`
   * array — but the request is also authorizing `rm -rf /`. Without the gate the
   * card titled itself "Which colour?", drew the four as neutral answers and
   * *hid the command*, so tapping an answer sent an approval for a destructive
   * call the person never saw. The card's whole reason to exist is that they do.
   */
  const disguised = {
    ...askPending,
    title: "Bash",
    rawInput: {
      command: "rm -rf /",
      questions: [
        {
          question: "Which colour?",
          options: [
            { label: "Battlefield", description: null },
            { label: "On the clock", description: null },
            { label: "Knockout", description: null },
            { label: "No rules", description: null },
          ],
        },
      ],
    },
  };
  check("a request that authorizes a command is never a question", asking(disguised, []), null);
  check(
    "and the command it authorizes is on the card, not hidden behind one",
    permissionContext(disguised as never, []).command,
    "rm -rf /",
  );

  /*
   * The reported bug, at this — the *other* — of its two render sites.
   *
   * `{}` is not `null`, so it fell through to `JSON.stringify` and the card drew
   * the two characters `{}` above the approve buttons. `EventList` had its own
   * copy of the same function with the same hole, which is why the fix went into
   * `readInput` and there is now only one copy.
   */
  const emptyObject = permissionContext({ ...base, rawInput: {}, content: null } as never, []);
  check("an empty rawInput object is nothing, not `{}`", emptyObject.unavailable, true);

  // What a read or an edit actually carries. Before this the card showed approve
  // buttons above an empty box for exactly the requests where "which file" *is*
  // the question being asked.
  const edit = permissionContext({ ...base, rawInput: { file_path: "/home/proj/notes.txt" }, content: null } as never, []);
  check("a file-shaped argument is surfaced as the target", edit.target, "/home/proj/notes.txt");
  check("and the card is not empty", edit.unavailable, false);
}

/* ------------------------------------------------------------------ *
 * The diff a person is about to approve
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe diff, before and after the fact\n");
{
  /*
   * `diffLines` is drawn twice over: above the Allow button when a permission
   * carries an edit, and inside a transcript row once the edit has happened. It
   * replaced `lineDiff`, which served only the first — and the reason it had to is
   * in the third case below.
   *
   * Getting it wrong does not throw and does not look broken: it draws a plausible
   * diff of the wrong lines, under a button that then executes the real edit.
   *
   * What the input *is* differs per agent, which is why these cases look unrelated.
   * claude's `Edit` sends the model's `old_string`/`new_string`, a fragment with no
   * context. codex sends whole files on both sides, for add, update and delete
   * alike. kimi sends a fragment and then the whole file again through a second
   * channel.
   */
  const shape = (diff: { hunks: readonly { lines: readonly { kind: string; text: string }[] }[] }): string[][] =>
    diff.hunks.map((hunk) =>
      hunk.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`),
    );

  const created = diffLines(null, "first\nsecond");
  check("a created file is all additions", [created.added, created.removed], [2, 0]);
  check("drawn as one hunk", shape(created), [["+first", "+second"]]);
  check("numbered on the new side alone", created.hunks[0]?.lines.map((l) => [l.oldNo, l.newNo]), [
    [null, 1],
    [null, 2],
  ]);
  // `wholeFile` is a claim about a *replacement*, and there was no old file here —
  // drawing "the whole file changed" over a file that did not exist would be a
  // warning about something that cannot happen.
  check("and is not a whole-file replacement", created.wholeFile, false);

  const edited = diffLines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  check("a one-line edit is one line either side", [edited.added, edited.removed], [1, 1]);
  check("with the lines either side of it for context", shape(edited), [
    [" a", " b", "-c", "+X", " d", " e"],
  ]);
  check("numbered in both files", edited.hunks[0]?.lines.map((l) => [l.oldNo, l.newNo]), [
    [1, 1],
    [2, 2],
    [3, null],
    [null, 3],
    [4, 4],
    [5, 5],
  ]);
  check("and it is not a whole-file replacement either", edited.wholeFile, false);

  /*
   * **The case the trim-only version could not answer, and the reason it was
   * replaced.** codex reports an edit as the whole file on both sides, so two
   * changed regions share the file's beginning, its end *and* everything between
   * them — a common prefix and suffix alone therefore report the entire middle as
   * rewritten, which for a two-character change in a 200-line file is a diff nobody
   * can read. The LCS behind the trim is what splits it into two hunks with the
   * untouched lines dropped.
   */
  const twice = diffLines(
    "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14",
    "1\n2\nX\n4\n5\n6\n7\n8\n9\n10\n11\nY\n13\n14",
  );
  check("two changed regions are two hunks", shape(twice), [
    [" 1", " 2", "-3", "+X", " 4", " 5"],
    [" 10", " 11", "-12", "+Y", " 13", " 14"],
  ]);
  check("counted across both", [twice.added, twice.removed], [2, 2]);
  check("and the eight untouched lines between them are not drawn", twice.wholeFile, false);

  // Reachable: `file_change` arrives twice for one kimi edit, and a re-write of
  // identical content is a real thing an agent does. No hunk at all is the honest
  // rendering; inventing one line of each would be a lie about what was approved.
  const same = diffLines("a\nb", "a\nb");
  check("identical text has nothing to draw", [same.hunks.length, same.added, same.removed], [0, 0, 0]);

  const replaced = diffLines("a\nb", "x\ny");
  check("nothing lining up is a whole-file replacement", replaced.wholeFile, true);
  check("and every line is shown on both sides", shape(replaced), [["-a", "-b", "+x", "+y"]]);

  /*
   * A deleted file is `newText: ""` — measured, that is what codex sends — and `""`
   * has to be **no lines** rather than one empty one, or a delete reads as "N lines
   * replaced by one blank line": `+1` for an act that added nothing.
   */
  const deleted = diffLines("a\nb\nc", "");
  check("a deleted file adds nothing", [deleted.added, deleted.removed], [0, 3]);

  // A trailing newline terminates the last line rather than starting an empty one,
  // so appending a line is `+1 −0` and not `+2 −1`.
  const appended = diffLines("a\n", "a\nb\n");
  check("a trailing newline is not a line", [appended.added, appended.removed], [1, 0]);

  /*
   * The clip, which is the one thing here that must not silently shorten.
   *
   * A card on a phone cannot draw an 800-line hunk, and a body that just *stops* at
   * 60 lines reads as the whole change — which is the number a person is approving.
   * So the count above it stays true and `omitted` is what says the body is short.
   */
  const long = diffLines(null, Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n"));
  check("an over-long diff is clipped", long.hunks[0]?.lines.length, 60);
  check("and says how much it is not showing", long.omitted, 10);
  check("while the count stays the true one", [long.added, long.removed], [70, 0]);

  /*
   * The line numbers a fragment gets, which are the only ones available at all:
   * measured in the log, a claude `Edit`'s own `locations[0].line` is the hunk's
   * `newStart`, and the fragment carries nothing else.
   */
  const placed = diffLines("c", "X", 24);
  check("a fragment is numbered from where it sits", placed.hunks[0]?.lines.map((l) => l.newNo ?? l.oldNo), [24, 24]);

  /*
   * **The refusal, and it is the one that matters most.** A `file_change` over the
   * 128 KiB per-event cap has each side clipped to half of it, so both are cut at
   * the same offset and the common suffix is destroyed — a diff over them reports the
   * untouched tail of the file as rewritten. `unavailable` is how "cannot say" stops
   * being drawn as "nothing changed", and `changeCounts` answers `null` rather than
   * zero for the reason the worktree counts do: a caller writing `?? 0` would report
   * the largest edit in the log as an empty one.
   */
  const cut = diffLines("old…[truncated 40 bytes]", "new…[truncated 12 bytes]");
  check("a truncated event has no diff", [cut.unavailable, cut.hunks.length, cut.added], ["truncated", 0, 0]);
  check(
    "and no counts either",
    changeCounts({
      type: "file_change",
      path: "/w/a.ts",
      oldText: "old…[truncated 40 bytes]",
      newText: "new…[truncated 12 bytes]",
      source: "diff",
      toolCallId: null,
    } as never),
    null,
  );

  /*
   * The word-level marks, drawn only where a removal is **paired** with an addition.
   * An inserted line is not a modified one, so it carries no marks at all — marking
   * the whole of it would say the opposite of what happened.
   */
  const word = diffLines("const timeout = 30;", "const timeout = 90;");
  check(
    "a rewritten line marks only what changed inside it",
    word.hunks[0]?.lines.map((l) => l.marks),
    [
      [[16, 17]],
      [[16, 17]],
    ],
  );
  check("an inserted line is marked nowhere", created.hunks[0]?.lines.map((l) => l.marks), [null, null]);

  /*
   * The bound, and that crossing it **degrades rather than hangs** — which is the
   * failure mode that matters, since this runs inside a `useMemo` on a transcript
   * that rebuilds on every streamed token. 700 lines a side is 490 000 cells against
   * a budget of 250 000.
   */
  const wall = (salt: string): string => Array.from({ length: 700 }, (_, i) => `${salt} ${i}`).join("\n");
  const huge = diffLines(wall("a"), wall("b"));
  check("past the cell budget it is one replacement", [huge.wholeFile, huge.added, huge.removed], [true, 700, 700]);
  // And the ordinary large case stays cheap, because the trim runs first: two 2000
  // line files differing by one line never reach the table at all.
  const nearly = diffLines(wall("a"), wall("a").replace("a 400", "CHANGED"));
  check("while one changed line in a large file is still one hunk", [nearly.hunks.length, nearly.added], [1, 1]);

  /*
   * Memoised on the event, which is what makes it safe for `buildTail` to ask on
   * every token. The same object back is the observable form of that.
   */
  const event = {
    type: "file_change",
    path: "/w/a.ts",
    oldText: "a\nb",
    newText: "a\nB",
    source: "diff",
    toolCallId: null,
  } as never;
  check("counts are computed once per event", changeCounts(event) === changeCounts(event), true);
  check("and they are the right ones", changeCounts(event), { added: 1, removed: 1 });
}

process.stdout.write("\nwhere a tool call happened\n");
{
  // Two branches, one format, and neither was reached even indirectly: this driver
  // contained no occurrence of `locations` at all. A line number of `null` is the
  // common case (a tool naming a file, not a position in it), and rendering it as
  // `a.ts:null` is exactly the sort of thing that ships.
  check("a location with no line is just the path", formatLocation({ path: "a.ts", line: null }), "a.ts");
  check("and one with a line carries it", formatLocation({ path: "a.ts", line: 12 }), "a.ts:12");
}

/* ------------------------------------------------------------------ *
 * What a tool row says without being opened
 * ------------------------------------------------------------------ */

process.stdout.write("\ntool arguments\n");
{
  /*
   * `readInput` is the single guess at an undocumented shape, shared by the
   * permission card and the transcript. The reported symptom — "clicking a tool
   * shows just {}" — was this function's emptiness hole seen through the second
   * of those two.
   */
  for (const [name, value] of [
    ["an empty object", {}],
    ["an empty array", []],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    const got = readInput(value);
    check(`${name} yields no detail at all`, [got.command, got.target, got.pretty, got.truncated], [null, null, null, false]);
  }

  // A command reads as a command. Rendering `{"command": "ls -la"}` and calling it
  // an explanation is most of what made the old row useless.
  check("a command is lifted out of the JSON", readInput({ command: "ls -la" }).command, "ls -la");
  check("and the JSON is not shown beside it", readInput({ command: "ls -la" }).pretty, null);
  check("a bare string is a command", readInput("git status").command, "git status");
  check("trimmed", readInput("  git status  ").command, "git status");

  // The daemon's stand-in. Reporting this as "no arguments" would be a lie about a
  // command that exists and was cut for size.
  const cut = readInput({ truncated: true, bytes: 9000 });
  check("the truncation stand-in is reported as truncated", [cut.truncated, cut.command], [true, null]);

  // A non-empty object with nothing recognisable still shows its arguments.
  check("an unrecognised shape falls back to JSON", readInput({ depth: 3 }).pretty, '{\n  "depth": 3\n}');

  // Rendering a transcript must not be able to throw. A cycle is the easy way to
  // make `JSON.stringify` fail; a throwing `toJSON` is the other.
  const cyclic: Record<string, unknown> = { name: "x" };
  cyclic["self"] = cyclic;
  check("a cyclic value is no detail rather than an exception", readInput(cyclic).pretty, null);
  check("and a throwing toJSON is too", readInput({ toJSON() { throw new Error("no"); } }).pretty, null);

  /*
   * `hasInput` is what decides whether a *later* update's arguments replace the
   * call's own, and it is the reason the tool cards went blank.
   *
   * Measured 2026-07-31 against claude 0.63.0: a `tool_call` arrives with
   * `rawInput: {}` and the command turns up on a `tool_call_update` afterwards. An
   * empty object is not null, so `event.rawInput ?? update.rawInput` keeps the
   * empty one and the command is never shown at all. The rule has to be "is there
   * anything here", and it has to be the same rule the rendering uses — hence one
   * function rather than a second emptiness test.
   */
  check("an empty object has no input", hasInput({}), false);
  check("nor does null", hasInput(null), false);
  check("nor whitespace", hasInput("  "), false);
  check("a command does", hasInput({ command: "ls" }), true);
  check("a path does", hasInput({ file_path: "/a" }), true);
  check("and so does the truncation stand-in", hasInput({ truncated: true, bytes: 9000 }), true);
  // The whole point, stated as the comparison the render makes.
  report(
    "so a later update's arguments win over an empty call",
    !hasInput({}) && hasInput({ command: "echo hi" }),
    "tool_call {} → tool_call_update {command}",
  );
}

/* ------------------------------------------------------------------ *
 * The home screen's ordering
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe session lists\n");
{
  const row = (id: string, over: Record<string, unknown>) => ({
    key: `m/${id}`,
    ref: { machineId: "m", sessionId: id },
    machineName: "m",
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });

  const sessions = [
    row("a", { status: "running", lastEventAt: 10 }),
    row("b", { status: "exited", exit: { reason: "stopped" }, lastEventAt: 20 }),
    row("c", { status: "blocked", pendingPermissions: [{ raisedAt: 500 }, { raisedAt: 100 }] }),
    row("d", { status: "blocked", pendingPermissions: [{ raisedAt: 50 }] }),
    row("e", { status: "running", lastEventAt: 30 }),
    /*
     * Placed here, immediately beside `b`, so the two are read together: same
     * `status: "exited"`, opposite outcome, and the *reason* is the only thing
     * separating them. This is the row a `status`-keyed implementation gets
     * wrong, and it is the one an ordinary deploy actually produces — a graceful
     * restart writes `daemon_shutdown`, not `daemon_restarted`.
     */
    row("f", {
      status: "exited",
      exit: { reason: "daemon_shutdown" },
      agentSessionId: "a_f",
      lastEventAt: 25,
    }),
    // The daemon tried and gave up. Active, because somebody has to act — but
    // not counted, because nothing is running.
    row("g", {
      status: "interrupted",
      exit: { reason: "daemon_restarted" },
      agentSessionId: "a_g",
      resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "no" }, at: 0 },
      lastEventAt: 5,
    }),
  ];
  const state = { sessions, machines: [] } as never;
  const lists = sessionLists(state);

  // Blocked first, oldest wait first: the point of the whole screen.
  check("blocked sessions sort by their oldest pending permission", lists.blocked.map((r) => r.snapshot.id), ["d", "c"]);
  check("active sessions sort most-recent first", lists.active.map((r) => r.snapshot.id), ["e", "f", "a", "g"]);
  // `b` alone. `f` ended in exactly the same *status* and is not here, which is
  // the whole point: nobody ended it, so calling it ended would be answering a
  // question the reader did not ask.
  check("only a session somebody ended is filed as ended", lists.ended.map((r) => r.snapshot.id), ["b"]);
  check("and a blocked session is never also counted active", lists.active.length + lists.blocked.length, 6);
  /*
   * Five: the four that were live plus `f`, which is a live conversation a few
   * seconds from having an agent again. Not `b` (somebody ended it) and not `g`
   * (the daemon gave up, so nothing is running) — that second exclusion is why
   * `countsAsLive` is a separate question from which list a row lands in.
   */
  check("the machine count is live sessions, not every session", lists.countByMachine.get("m" as never), 5);
  check("and ended rows are still in the list, just not counted", lists.ended.length, 1);

  // Memoised on the array's identity, which is what makes a streamed event free.
  report("the derivation is memoised by identity", sessionLists(state) === lists, "same object returned");

  check("isTerminal agrees with the split", [isTerminal("running"), isTerminal("exited")], [false, true]);
}

/* ------------------------------------------------------------------ *
 * Enter-to-send
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe composer's send key\n");
{
  const { shouldSend, isTypingInto, isBareKey } = await import("../src/keys.js");

  check("a bare Enter sends", shouldSend({ key: "Enter" }), true);
  check("Shift+Enter is a new line", shouldSend({ key: "Enter", shiftKey: true }), false);
  check("and so is any other modifier", [
    shouldSend({ key: "Enter", metaKey: true }),
    shouldSend({ key: "Enter", ctrlKey: true }),
    shouldSend({ key: "Enter", altKey: true }),
  ], [false, false, false]);
  check("an ordinary letter does nothing", shouldSend({ key: "a" }), false);

  /*
   * The one that is not obvious, and the reason this is a pure function at all.
   *
   * With a Russian, Chinese, Japanese or Korean input method, Enter *commits the
   * candidate being typed* — the text is not in the box yet. A naive
   * `key === "Enter"` sends a half-finished word and swallows the keystroke that
   * was meant to finish it, on every message, for everyone using one of those
   * layouts. There is no way to notice this from a Latin keyboard, which is
   * exactly why it needs an assertion rather than a look.
   */
  check("Enter while an IME is composing does not send", shouldSend({ key: "Enter", isComposing: true }), false);

  // The guard that makes bare-letter shortcuts possible: without it, `j` typed
  // into the composer navigates to another session mid-sentence.
  check("a textarea counts as typing", isTypingInto({ tagName: "TEXTAREA" }), true);
  check("as does an input", isTypingInto({ tagName: "INPUT" }), true);
  check("and a contenteditable", isTypingInto({ tagName: "DIV", isContentEditable: true }), true);
  check("a plain div does not", isTypingInto({ tagName: "DIV" }), false);
  check("and neither does nothing at all", isTypingInto(null), false);
  check("a modifier disqualifies a bare shortcut", isBareKey({ key: "j", metaKey: true }), false);

  /*
   * The digits on the ask card.
   *
   * The number beside each answer used to be decoration under a comment calling
   * it "the number a keyboard would reach for". Wiring it makes the guards
   * load-bearing rather than tidy: the composer sits directly under that card and
   * takes the caret on its own, so a digit that ignored `isTypingInto` would
   * approve whatever the agent was asking with the first character of a message.
   */
  const { optionShortcut } = await import("../src/keys.js");

  check("a digit picks the answer with that number", optionShortcut({ key: "3" }, null, 4), 2);
  check("counting from one, so 1 is the first", optionShortcut({ key: "1" }, null, 4), 0);
  check("past the end it picks nothing", optionShortcut({ key: "5" }, null, 4), null);
  check("and there is no option zero", optionShortcut({ key: "0" }, null, 4), null);
  check("a digit typed into the composer is a digit", optionShortcut({ key: "3" }, { tagName: "TEXTAREA" }, 4), null);
  check("as is one typed into a form field on the card itself", optionShortcut({ key: "3" }, { tagName: "INPUT" }, 4), null);
  check(
    "and every chord is left alone — Shift+1 is a character somebody typed",
    [
      optionShortcut({ key: "3", metaKey: true }, null, 4),
      optionShortcut({ key: "3", ctrlKey: true }, null, 4),
      optionShortcut({ key: "3", altKey: true }, null, 4),
      optionShortcut({ key: "1", shiftKey: true }, null, 4),
      optionShortcut({ key: "3", isComposing: true }, null, 4),
    ],
    [null, null, null, null, null],
  );
  check("a card with no answers has no shortcuts", optionShortcut({ key: "1" }, null, 0), null);
  check("a letter is not a shortcut here", optionShortcut({ key: "j" }, null, 4), null);

  const { completionKey } = await import("../src/keys.js");

  check("the menu walks on the arrows", [completionKey({ key: "ArrowDown" }), completionKey({ key: "ArrowUp" })], ["next", "prev"]);
  check("Enter and Tab both choose", [completionKey({ key: "Enter" }), completionKey({ key: "Tab" })], ["choose", "choose"]);
  check("Escape dismisses", completionKey({ key: "Escape" }), "dismiss");
  check("an ordinary letter is left to the textarea", completionKey({ key: "a" }), null);

  /*
   * The same IME defect, arriving through a new door.
   *
   * Enter commits an input-method candidate, so a menu that read it as a
   * selection would insert a command instead of finishing a word — identical in
   * shape and invisibility to the send bug above, and not prevented by that one:
   * this function runs *first*, so it has to carry its own guard.
   */
  check("Enter while an IME is composing chooses nothing", completionKey({ key: "Enter", isComposing: true }), null);
  // Shift+Enter stays a newline and Shift+Tab stays focus-backwards, whether or
  // not a suggestion list happens to be on screen.
  check("and a shifted Enter or Tab is left alone", [
    completionKey({ key: "Enter", shiftKey: true }),
    completionKey({ key: "Tab", shiftKey: true }),
  ], [null, null]);

  /*
   * The collision, asserted *as* a collision.
   *
   * Enter is the one key both functions claim, which is why the order inside
   * `Composer`'s handler is load-bearing rather than incidental — and it is
   * load-bearing for exactly one key, which is the half that keeps it safe.
   */
  check("Enter is the one key both claim", [shouldSend({ key: "Enter" }), completionKey({ key: "Enter" })], [true, "choose"]);
  check("and the menu's other keys never send", [
    shouldSend({ key: "ArrowDown" }),
    shouldSend({ key: "ArrowUp" }),
    shouldSend({ key: "Tab" }),
    shouldSend({ key: "Escape" }),
  ], [false, false, false, false]);

  /*
   * And the *resolution*, which is the half that was claimed and not asserted.
   *
   * The two checks above establish that a collision exists; they stay green with
   * the composer's two blocks in either order, and reversing them sends a
   * half-typed message instead of completing a command. `composerKey` is that
   * ordering moved somewhere it can be pinned.
   */
  const { composerKey } = await import("../src/keys.js");

  check("with the menu open, Enter completes", composerKey({ key: "Enter" }, true, true), "choose");
  check("with it closed, Enter sends", composerKey({ key: "Enter" }, false, true), "send");
  check("the arrows only mean anything to the menu", [
    composerKey({ key: "ArrowDown" }, true, true),
    composerKey({ key: "ArrowDown" }, false, true),
  ], ["next", null]);
  check("and Escape likewise", [
    composerKey({ key: "Escape" }, true, true),
    composerKey({ key: "Escape" }, false, true),
  ], ["dismiss", null]);
  // The IME guard survives the merge in both directions, which is the thing that
  // would otherwise quietly move house rather than be fixed.
  check("an IME candidate neither completes nor sends", [
    composerKey({ key: "Enter", isComposing: true }, true, true),
    composerKey({ key: "Enter", isComposing: true }, false, true),
  ], [null, null]);
  // Shift+Enter is a newline whether or not a suggestion list happens to be up.
  check("a shifted Enter is left to the textarea, menu or no menu", [
    composerKey({ key: "Enter", shiftKey: true }, true, true),
    composerKey({ key: "Enter", shiftKey: true }, false, true),
  ], [null, null]);

  /*
   * ⭐ **The soft keyboard, which is the whole of the mobile rule.**
   *
   * A phone has no Shift+Enter, so with Enter sending there was no way to type a
   * newline at all and the composer grew a `↵` button beside the box to do it —
   * one that appended to the *end* of the draft whatever the caret was doing.
   * `enterSends` replaces the button: false hands the keystroke back to the
   * textarea, which breaks the line at the caret like any other character.
   *
   * The menu is asserted **against** the pointer rather than beside it, because
   * that is the pair that can be got wrong in a way nothing else notices: typing
   * `/model` on a phone and pressing Return has to choose the command, and a
   * naive `if (!enterSends) return null` at the top of the function would insert a
   * line break into the draft instead and leave the menu open over it.
   */
  check("on a soft keyboard Enter is a newline rather than a send", composerKey({ key: "Enter" }, false, false), null);
  check("but the menu still takes it there", composerKey({ key: "Enter" }, true, false), "choose");
  check("and so do the keys the menu owns", [
    composerKey({ key: "ArrowDown" }, true, false),
    composerKey({ key: "Escape" }, true, false),
  ], ["next", "dismiss"]);

  /*
   * Both halves of that rule live in `Composer.tsx` and neither is reachable from
   * a pure function: the pointer read is a `matchMedia` at the keystroke, and the
   * hint is an attribute. Read off disk, in the `gateOffer`/`showsGateLink` style
   * — the button being deleted is the *point*, so its absence is the assertion.
   */
  {
    const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
    check("the newline button is gone", /CornerDownLeft/.test(composer), false);
    // Unconditional, because a virtual keyboard is the only thing that reads it —
    // so there is no pointer question here and nothing that can go stale.
    check("and the soft Return key is drawn as one", /enterKeyHint="enter"/.test(composer), true);
    // The leading `!` is what distinguishes this from `shouldFocusComposer`'s own
    // read one screenful up, which passes the same query the other way round.
    check(
      "the pointer is read at the keystroke and negated into `enterSends`",
      /!window\.matchMedia\("\(pointer: coarse\)"\)\.matches/.test(composer),
      true,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The agent's controls
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe agent config bar reads categories, not ids\n");
{
  /*
   * Not a render test — there is no DOM here — but the thing that would actually
   * break is not the markup, it is the assumption that a control can be found by
   * its id. Claude publishes reasoning effort as `effort` with values
   * `default|low|…|max`; kimi publishes the same concept as `thinking` with
   * values `off|…`. The two share nothing but `category`, so this asserts that a
   * lookup by category finds both and a lookup by id finds one.
   */
  const claude = [
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "default", choices: [] },
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "opus", choices: [] },
    { id: "effort", name: "Effort", description: null, category: "thought_level", kind: "select", value: "high", choices: [] },
  ];
  const kimi = [
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "k2", choices: [] },
    { id: "thinking", name: "Thinking", description: null, category: "thought_level", kind: "select", value: "off", choices: [] },
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "yolo", choices: [] },
  ];

  const byCategory = (options: typeof claude, category: string) =>
    options.find((option) => option.category === category)?.value ?? null;

  check("effort is found on claude by category", byCategory(claude, "thought_level"), "high");
  check("and on kimi, whose id is different", byCategory(kimi, "thought_level"), "off");
  check(
    "a lookup by claude's id finds nothing on kimi",
    kimi.find((option) => option.id === "effort") ?? null,
    null,
  );
  check("mode is found on both", [byCategory(claude, "mode"), byCategory(kimi, "mode")], ["default", "yolo"]);

  /*
   * And the *label*, which is the same disagreement one layer further out.
   *
   * Finding the control by category was never enough on its own: measured
   * 2026-08-04 against the live agents, claude calls it `Effort` and kimi calls
   * the identical control `Thinking` (`category: "thought_level"`, choices
   * Low/High/Max). So the strip said one word and the `/` menu — which already
   * synthesizes this control as `/effort` on both agents, off the same category —
   * said another, one tap apart.
   *
   * Narrow on purpose. `model` and `mode` are the same word on both agents, so
   * there is nothing to reconcile and the agent's own name stands; an unknown
   * category has no second opinion at all. Overriding a name we have no better
   * version of is how a client starts inventing vocabulary.
   */
  const effortOf = (options: typeof claude) =>
    labelFor(options.find((o) => o.category === "thought_level") as never);
  check("the effort control is called the same thing on both agents", [effortOf(claude), effortOf(kimi)], [
    "Effort",
    "Effort",
  ]);
  check("a control the agents already agree about keeps its own name", [
    labelFor(claude[1] as never),
    labelFor(kimi[2] as never),
  ], ["Model", "Mode"]);
  check(
    "and so does one nobody has a second word for",
    labelFor({ category: "unheard_of", name: "Whatever" }),
    "Whatever",
  );

  /*
   * Which chips say their own name, and which are identified without it.
   *
   * This replaced a `hidden sm:inline`, i.e. a width question answered with a
   * breakpoint: the caption vanished on a phone for the controls that needed it
   * and came back on a desktop for the ones that did not. The two silent ones are
   * silent because they are identified twice over — an icon, and a value that is
   * a proper noun. An unknown category is the case that decides the rule's shape:
   * it has no icon, so a chip with no caption would be a bare value with nothing
   * saying what it is, in the popover where there is no position to read it by.
   */
  check(
    "model and effort say only their value",
    [showsCaption({ category: "model" }), showsCaption({ category: "thought_level" })],
    [false, false],
  );
  check("mode keeps its name, because Manual answers nothing on its own", showsCaption({ category: "mode" }), true);
  check(
    "and so does a category we draw no icon for",
    [showsCaption({ category: "unheard_of" }), showsCaption({ category: null })],
    [true, true],
  );

  /*
   * And the width that stops moving.
   *
   * The right-hand cluster is right-aligned, so a chip that grows drags
   * everything left of it: picking `Max` after `Adaptive` moved the model chip by
   * five characters, every time. The reserve is every label the chip could show,
   * rendered invisibly in one grid cell — so the column is sized by the real font
   * rather than by a `length` guess, and `Adaptive` is in the list because that is
   * what `choiceOverride` renames `default` to.
   */
  const effortOption = {
    id: "effort",
    name: "Effort",
    description: null,
    category: "thought_level",
    kind: "select",
    value: "default",
    choices: [
      { value: "default", name: "Default", description: null, group: null },
      { value: "low", name: "Low", description: null, group: null },
      { value: "max", name: "Max", description: null, group: null },
    ],
  };
  /*
   * **The reserved width depends on the category and on nothing else.**
   *
   * It was the widest of *the agent's own* labels, which made claude's effort
   * chip wider than kimi's: the same strip was a different shape depending on
   * which session was open, so moving between two sessions moved every button.
   * Asserted as an independence property rather than by listing the values —
   * the same option shape under two agents' choice lists, and the same answer.
   */
  const asChoices = (values: string[]) =>
    values.map((value) => ({ value, name: value, description: null, group: null }));
  check(
    "the three controls on the strip hold a width open",
    ["mode", "model", "thought_level"].map((category) =>
      chipReserve({ category } as never),
    ),
    [
      ["Accept Edits", "—"],
      ["GPT-5.6-Luna", "—"],
      ["Adaptive", "Ultracode", "—"],
    ],
  );
  check(
    "and it is the same width whatever the agent offers, which is the point",
    [
      chipReserve({ ...effortOption, choices: asChoices(["default", "low", "max"]) } as never),
      chipReserve({ ...effortOption, id: "thinking", choices: asChoices(["off", "high"]) } as never),
      chipReserve({ ...effortOption, id: "reasoning_effort", choices: [] } as never),
    ],
    [
      ["Adaptive", "Ultracode", "—"],
      ["Adaptive", "Ultracode", "—"],
      ["Adaptive", "Ultracode", "—"],
    ],
  );
  {
    /*
     * ⭐ **The reserved string and the drawn string are the same bytes, which is the
     * whole of "Ultracode fits".**
     *
     * A reservation is honest only because the browser renders it: the sizer and the
     * value are one grid cell in the same font, so the column is exactly as wide as
     * whichever candidate is widest — and the value, being `sm:absolute sm:inset-0`,
     * can only ellipsise inside it. So a reserve that is *nearly* the drawn string
     * buys nothing: `Ultracode` was cut to `Ultrac…` while `Adaptive` sat in the
     * list, on the one control this client invents a row for.
     *
     * ⚠ Asserted by **identity against `chipValue`**, never against a literal here.
     * The name lives at `src/registry.ts`'s `withUltracode` and `packages/web`
     * cannot import from `src/`, so `CATEGORY_RESERVE` holds a hand-mirrored copy
     * and nothing across that boundary checks the two agree — `daemoncheck` pins
     * `ULTRACODE_CHOICE`, which is the *value*. This is the near half of that guard:
     * it cannot see the daemon rename the choice, but it does catch the reserve
     * drifting from whatever this client actually draws.
     */
    const ultracode = {
      ...effortOption,
      value: "ultracode",
      choices: [
        ...effortOption.choices,
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    } as never;
    // `true` is `available`: the second argument is what decides between the real
    // value and `UNAVAILABLE_VALUE`, and omitting it silently asserts the placeholder.
    const drawn = chipParts(ultracode, true).value;
    check("the effort chip draws the daemon's own name for the row it adds", drawn, "Ultracode");
    check(
      "and the width it holds open is reserved for that exact string",
      (chipReserve(ultracode) ?? []).includes(drawn),
      true,
    );
    // The other half of the pair: the reserve is per *category*, so an agent that
    // never sees this row holds the same width. Otherwise the strip would be a
    // different shape on claude than on kimi, and every button beside it would move
    // when somebody switched session.
    check(
      "on every agent, including the two that can never draw it",
      chipReserve({ ...effortOption, id: "thinking" } as never),
      chipReserve(ultracode),
    );
  }

  check(
    "a category drawn in the overflow column holds nothing open, having nothing beside it",
    [chipReserve({ category: "unheard_of" } as never), chipReserve({ category: null } as never)],
    [null, null],
  );
  /*
   * The value somebody just chose is the value they see.
   *
   * A chip drew the value it was *leaving* for the whole round trip — pick Low and
   * it read "Adaptive" with a spinner, then Low — which is a loading state about a
   * decision already made. Drawn at once and put back if the daemon refuses, the
   * same trade the composer makes with a message it is still sending.
   */
  const asked = (entries: [string, string | boolean][]) => new Map(entries);
  check(
    "the chosen value replaces the one being left",
    withChoice(effortOption as never, asked([["effort", "low"]])).value,
    "low",
  );
  check(
    "and the chip reads it immediately",
    chipValue(withChoice(effortOption as never, asked([["effort", "low"]]))),
    "Low",
  );
  check(
    "a change to another control leaves this one alone, object for object",
    withChoice(effortOption as never, asked([["model", "opus"]])) === effortOption,
    true,
  );
  check("and so does nothing in flight", withChoice(effortOption as never, null) === effortOption, true);
  check(
    "choosing the value it already has changes nothing either",
    withChoice(effortOption as never, asked([["effort", "default"]])) === effortOption,
    true,
  );
  check(
    "a toggle takes its boolean the same way",
    withChoice({ ...effortOption, kind: "boolean", value: false, choices: [] } as never, asked([["effort", true]]))
      .value,
    true,
  );
  check(
    "two controls can be in flight at once, because the two doors do not fence each other",
    [
      withChoice(effortOption as never, asked([["effort", "max"], ["mode", "plan"]])).value,
      withChoice({ ...effortOption, id: "mode", value: "default" } as never, asked([["effort", "max"], ["mode", "plan"]]))
        .value,
    ],
    ["max", "plan"],
  );

  /*
   * The mechanism under it, and the ordering rule that keeps two taps honest.
   */
  {
    const { beginChoice, endChoice, choicesFor, forgetChoices } = await import("../src/choices.js");
    const key = "m_1/s_1" as never;
    const first = beginChoice(key, "effort", "low");
    check("a recorded choice is what the session is holding", [...(choicesFor(key) ?? new Map())], [["effort", "low"]]);
    const second = beginChoice(key, "effort", "max");
    endChoice(first);
    check(
      "an earlier answer does not release a later choice",
      [...(choicesFor(key) ?? new Map())],
      [["effort", "max"]],
    );
    endChoice(second);
    check("and the last one releases it", choicesFor(key), null);

    beginChoice(key, "effort", "low");
    beginChoice("m_1/s_2" as never, "effort", "high");
    forgetChoices(key);
    check("a session going away takes only its own", [
      choicesFor(key),
      [...(choicesFor("m_1/s_2" as never) ?? new Map())],
    ], [null, [["effort", "high"]]]);
    forgetChoices("m_1/s_2" as never);
  }

  /*
   * **The assertion that would have caught the defect**, and it has to be a
   * call-site one: every pure check above passed while the bug was live on
   * screen. There are two doors into `applyConfigChange` — the chip and the
   * composer's `/effort` menu — and the optimistic override lived in the bar's
   * own `useState`, so the second door drew the daemon's value for the whole
   * round trip. The rule is that recording belongs to the *dispatcher*: the map
   * is written in exactly one place, and no component may write it.
   */
  {
    const strip = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const composerSrc = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const count = (text: string, needle: string) => text.split(needle).length - 1;

    // Once each, and both before the component: `applyConfigChange` is declared
    // above `export function AgentConfigBar`, so this pins them inside the
    // dispatcher rather than merely inside the file.
    const dispatcher = strip.slice(0, strip.indexOf("export function AgentConfigBar"));
    check(
      "the choice is recorded and released in the dispatcher, once each",
      [count(strip, "beginChoice("), count(strip, "endChoice("), count(dispatcher, "beginChoice("), count(dispatcher, "endChoice(")],
      [1, 1, 1, 1],
    );
    check(
      "and the other door records nothing of its own",
      [count(composerSrc, "beginChoice"), count(composerSrc, "endChoice")],
      [0, 0],
    );
    // Not trivially true: the property is only worth anything while a second
    // caller exists to be covered by it.
    check("while still being a second caller", count(composerSrc, "applyConfigChange(") >= 1, true);
    check(
      "and the daemon is still asked in exactly one place",
      count(strip, "setConfig(") + count(composerSrc, "setConfig("),
      1,
    );
  }

  /*
   * A control whose choices have gone still holds its width. That is the same
   * sentence as the one about a category, read at the moment it matters most:
   * an agent that has stopped offering a control is exactly when the chip must
   * not resize.
   */
  check(
    "a control with nothing left to choose still holds its width",
    [
      chipReserve({ ...effortOption, choices: [] } as never),
      chipReserve({ ...effortOption, kind: "boolean", value: true, choices: [] } as never),
    ],
    [
      ["Adaptive", "Ultracode", "—"],
      ["Adaptive", "Ultracode", "—"],
    ],
  );

  /*
   * Slot assignment, which is the same rule one layer up.
   *
   * `Fast mode` leaves the visible strip because it is `category: "model_config"`
   * and that category is not in the table — not because anybody matched the string
   * "fast". The distinction is the whole invariant: an id-keyed rule would hide
   * one agent's controls and show the other's.
   */
  const fast = { id: "fast", name: "Fast mode", description: null, category: "model_config", kind: "boolean", value: true, choices: [] };
  const odd = { id: "x", name: "Odd", description: null, category: "something_new", kind: "select", value: "a", choices: [] };
  const uncategorised = { id: "y", name: "Uncategorised", description: null, category: null, kind: "select", value: "b", choices: [] };

  const slots = splitOptions([...claude, fast, odd, uncategorised] as never);
  check("mode goes left", slots.left.map((o: { id: string }) => o.id), ["mode"]);
  check("model and effort go right, in reading order", slots.right.map((o: { id: string }) => o.id), ["model", "effort"]);
  // `Fast mode` is not demoted, it is *hidden* — a product decision about a known
  // category, asked for by name. With it gone the `…` button it was the sole
  // content of disappears too, which was the actual complaint.
  check("model_config is hidden outright", slots.hidden.map((o: { id: string }) => o.id), ["fast"]);
  // Unknown categories are still demoted rather than dropped: ACP says a category
  // must not be required for correctness, so a control nobody has heard of keeps a
  // way to be reached, and the `…` button reappears the moment one exists.
  check("but an unknown category is still reachable", slots.overflow.map((o: { id: string }) => o.id).sort(), ["x", "y"]);

  // `slotFor` directly, because `splitOptions` can only show where a control
  // *landed* and the rule is about `category` alone. Keyed on the category and
  // never on the id: claude calls reasoning effort `effort` and kimi calls it
  // `thinking`, so an id-keyed table draws one agent's controls and none of the
  // other's.
  check("the slot comes from the category", slotFor({ category: "mode" }), "left");
  check("model and effort share the right-hand slot", [slotFor({ category: "model" }), slotFor({ category: "thought_level" })], ["right", "right"]);
  // Hidden is a decision about a control we know; overflow is what we do with one
  // we do not. They must not collapse into each other.
  check("a known category we hide is hidden", slotFor({ category: "model_config" }), "hidden");
  check("an unknown one is demoted, not dropped", slotFor({ category: "something_new" }), "overflow");
  check("and so is a control with no category at all", slotFor({ category: null }), "overflow");

  // Demoted, never dropped: ACP says a category must not be required for
  // correctness, so an agent using one nobody has heard of stays fully operable.
  //
  // **`nested` is in this sum, and leaving it out is the failure the sum exists to
  // catch.** A slot missing from the count makes every option in it invisible to
  // the one assertion that says nothing is lost — which is how a control silently
  // stops existing while the check stays green.
  const total =
    slots.left.length + slots.right.length + slots.overflow.length + slots.hidden.length + slots.nested.length;
  check("every option lands in exactly one slot, and none is lost", total, 6);
  check("kimi's controls split the same way", splitOptions(kimi as never).right.map((o: { id: string }) => o.id), ["model", "thinking"]);

  /*
   * Codex, and the rule that the strip must not change shape between agents.
   *
   * Measured 2026-08-07, codex publishes five controls, and one of them —
   * `collaboration_mode`, its Default/Plan switch — is a category no other agent
   * has. Demoted as an unknown it would put a `…` button on the strip for codex
   * sessions and no other, so every other button moves along the row the moment
   * you switch session. It is `nested` instead: drawn as a second menu inside the
   * mode control, which already exists on every agent.
   */
  const codex = [
    { id: "mode", name: "Mode", description: null, category: "mode", kind: "select", value: "agent", choices: [] },
    { id: "collaboration_mode", name: "Collaboration mode", description: null, category: "collaboration_mode", kind: "select", value: "default", choices: [] },
    { id: "model", name: "Model", description: null, category: "model", kind: "select", value: "gpt-5.6-sol", choices: [] },
    { id: "reasoning_effort", name: "Reasoning effort", description: null, category: "thought_level", kind: "select", value: "low", choices: [] },
    { id: "fast-mode", name: "Fast mode", description: null, category: "model_config", kind: "boolean", value: false, choices: [] },
  ];
  const codexSlots = splitOptions(codex as never);
  check("codex's plan switch nests rather than demoting", slotFor({ category: "collaboration_mode" }), "nested");
  check("so it is drawn inside the mode menu", codexSlots.nested.map((o: { id: string }) => o.id), ["collaboration_mode"]);
  /*
   * **The assertion the whole change is for.** Codex must leave the strip the
   * same shape claude leaves it: mode on the left, model and effort on the right,
   * and *nothing* behind a `…` — because the `…` is the button that appears for
   * one agent and not another.
   */
  check("and the strip carries no overflow button for codex", codexSlots.overflow, []);
  check("while the visible chips are the ones every agent has", [
    codexSlots.left.map((o: { id: string }) => o.id),
    codexSlots.right.map((o: { id: string }) => o.id),
  ], [["mode"], ["model", "reasoning_effort"]]);

  /*
   * A nested control with no host is demoted, never dropped.
   *
   * `nested` names a place *inside* another control's menu, so it only exists if
   * that control is on the strip. Both ways of not having one are the same
   * outcome: no mode control at all, and a mode control that is a toggle and
   * therefore has no menu to nest into.
   */
  check(
    "with no mode control, the nested one falls back to overflow",
    splitOptions([codex[1]] as never).overflow.map((o: { id: string }) => o.id),
    ["collaboration_mode"],
  );
  const toggleHost = { id: "mode", name: "Mode", description: null, category: "mode", kind: "boolean", value: true, choices: [] };
  check(
    "and a toggle is not a host, because a toggle has no menu",
    splitOptions([toggleHost, codex[1]] as never).overflow.map((o: { id: string }) => o.id),
    ["collaboration_mode"],
  );
  /*
   * **And the mirror, which the host test does not cover.**
   *
   * A boolean *host* is refused because a toggle has no menu to nest into. A
   * boolean in the *nested* slot is the same fact read from the other end: it
   * carries no `choices`, so `ChoiceSection` would draw a divider and a heading
   * with no rows under them, and `toEntries` skips booleans as well — so the
   * control would have no second way to be reached and would silently cease to
   * exist. Overflow is where it went before `nested` existed, drawn as a working
   * Toggle, and it is where it goes again.
   *
   * Asserted with a real host present, so nothing else could be doing the
   * demotion: `mode` is a select here and `collaboration_mode` still leaves the
   * nested slot.
   */
  const booleanNested = [
    codex[0],
    { id: "collaboration_mode", name: "Plan", description: null, category: "collaboration_mode", kind: "boolean", value: false, choices: [] },
  ];
  const booleanSlots = splitOptions(booleanNested as never);
  check(
    "a boolean cannot be nested either, because it has no choices to draw",
    [
      booleanSlots.nested.map((o: { id: string }) => o.id),
      booleanSlots.overflow.map((o: { id: string }) => o.id),
    ],
    [[], ["collaboration_mode"]],
  );
  check(
    "and its host is still on the strip, so nothing else demoted it",
    booleanSlots.left.map((o: { id: string }) => o.id),
    ["mode"],
  );
  // The partition still holds with a member moved between slots.
  check(
    "and nothing is lost moving it",
    booleanSlots.left.length +
      booleanSlots.right.length +
      booleanSlots.overflow.length +
      booleanSlots.hidden.length +
      booleanSlots.nested.length,
    2,
  );
}

/* ------------------------------------------------------------------ *
 * Widget roles, kept rather than merely drawn
 * ------------------------------------------------------------------ */

process.stdout.write("\narrow keys inside a menu that claims to be one\n");
{
  /*
   * ⚠ **The roles were drawn and never implemented, and nothing here noticed.**
   *
   * `bits.tsx` renders `role="menu"`, and `role="listbox"` with `role="option"`
   * plus `aria-selected` on every row. A grep for `ArrowDown` across the whole of
   * `packages/web` returned exactly one hit, in the composer's own slash menu — so
   * a screen reader announced "listbox, 8 options" and then not one arrow key
   * moved anything. That is the same class of defect as an unmeasured contrast
   * ratio, and this file was already asserting those.
   *
   * Split in two on purpose: reading the key is one question and where focus lands
   * is another, and only the second has a wrap in it.
   */
  const { listNavKey, nextOptionIndex } = await import("../src/keys.js");

  check("the list walks on the arrows", [listNavKey({ key: "ArrowDown" }), listNavKey({ key: "ArrowUp" })], [
    "next",
    "prev",
  ]);
  check("and jumps on Home and End", [listNavKey({ key: "Home" }), listNavKey({ key: "End" })], ["first", "last"]);

  /*
   * **Escape is the omission that matters.** `overlay.ts` is the single arbiter —
   * it holds the LIFO layer stack and the one capture-phase listener, and
   * `decisionShortcutsEnabled` reads that stack to decide whether a bare digit may
   * resolve a permission. A second component answering Escape is the exact shape
   * that arbiter replaced, so this must keep returning `null` and let the key
   * travel to where it is owned.
   */
  check("Escape belongs to the overlay arbiter and is not claimed here", listNavKey({ key: "Escape" }), null);
  // Every row in both widgets is a real `<button>`, which activates on both
  // without help. Claiming them would re-implement the platform, slightly wrong.
  check("Enter and Space are left to the button", [listNavKey({ key: "Enter" }), listNavKey({ key: " " })], [null, null]);
  check("an ordinary letter means nothing to a list", listNavKey({ key: "j" }), null);
  // An arrow mid-composition is how an IME walks its own candidate list.
  check("and an arrow while an IME is composing is the IME's", listNavKey({ key: "ArrowDown", isComposing: true }), null);
  check("as is any chord", [
    listNavKey({ key: "ArrowDown", metaKey: true }),
    listNavKey({ key: "ArrowUp", ctrlKey: true }),
    listNavKey({ key: "Home", altKey: true }),
  ], [null, null, null]);

  /*
   * **-1 is "nothing has focus yet"**, which is the state every panel opens in
   * before its effect runs. From nowhere, Down takes the first row and Up the last,
   * so a keyboard arriving at a fresh menu gets the near end either way rather than
   * landing on row two.
   */
  check("from nowhere, Down takes the first row", nextOptionIndex("next", -1, 4), 0);
  check("and Up takes the last", nextOptionIndex("prev", -1, 4), 3);
  check("otherwise it steps", [nextOptionIndex("next", 1, 4), nextOptionIndex("prev", 2, 4)], [2, 1]);

  /*
   * The wrap, which is the whole reason this is a function rather than `+1`. It is
   * the convention for a popup of bounded length, and it removes the dead key: on a
   * four-row menu with focus on the last row, an unwrapped Down does nothing and
   * tells the reader nothing about why.
   */
  check("the end wraps to the start", nextOptionIndex("next", 3, 4), 0);
  check("and the start wraps to the end", nextOptionIndex("prev", 0, 4), 3);
  check("Home and End ignore where focus was", [nextOptionIndex("first", 2, 4), nextOptionIndex("last", 2, 4)], [0, 3]);

  // So a caller cannot focus index 0 of nothing.
  check("an empty list has nowhere to go", [
    nextOptionIndex("next", -1, 0),
    nextOptionIndex("first", -1, 0),
  ], [null, null]);
  check("and no key at all goes nowhere", nextOptionIndex(null, 1, 4), null);

  /*
   * The wiring, as source text, because `webcheck` has no DOM and a handler that
   * is never attached is indistinguishable from one that is.
   *
   * **On the panel and never on `window`** is the property worth pinning. This app
   * has exactly two global keydown listeners on purpose — `overlay.ts`'s Escape
   * arbiter and `AskCard`'s digit shortcuts — and each had to reason about the
   * other. A third would have had to reason about both.
   */
  const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  /*
   * Comments out first, and that is not tidiness — it is the failure this block
   * hit on its first run. Both counts below were written against the raw file and
   * both came back one too high, because the docblocks explaining these very rules
   * quote the strings being counted: the prose says `tabIndex={-1}` and it says
   * `.focus()`. Every source-text assertion in this file that reads code rather
   * than copy has to do this, and the ones further down already do.
   */
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const bitsSrc = strip(bitsRaw);
  check("both panels take the keys", (bitsSrc.match(/onKeyDown=\{onKeyDown\}/g) ?? []).length, 2);
  check("and neither reaches for a global listener", /window\.addEventListener\("keydown"/.test(bitsSrc), false);

  /*
   * **The panel holds focus itself, and that is what keeps the widget alive.**
   *
   * The handler is element-scoped, so focus leaving the rows is the same thing as
   * the widget going dead: a focused row can unmount under the 4s poll
   * (`NewSession`'s machine list, a conditional row in `UsersSection`), the browser
   * drops focus to `<body>`, and from there no arrow key can reach the handler to
   * get back in. It is also the only way a panel whose rows are a caller's prose —
   * `ProfileMenu`'s `HelpButton` — takes focus at all, rather than announcing
   * `role="menu"` and answering nothing.
   *
   * Pinned as source text because it is a JSX attribute and this driver has no DOM.
   */
  check("and both can hold focus themselves", (bitsSrc.match(/tabIndex=\{-1\}/g) ?? []).length, 2);

  /*
   * **Neither `focus()` may scroll an ancestor.** Both popups are `absolute`
   * children of a box routinely inside `SHEET_BODY`, and the outside-`pointerdown`
   * that closes a panel is also what the start of a touch scroll looks like — so an
   * unguarded restore scrolls the sheet back to the trigger, fighting the scroll the
   * reader just began. Every `focus()` in this file's list code carries
   * `preventScroll`, and revealing a row is `revealWithin`, which moves the panel
   * and nothing above it.
   */
  const listCode = strip(bitsRaw.slice(bitsRaw.indexOf("function focusableRows"), bitsRaw.indexOf("A panel anchored to")));
  check("the list's focus calls never scroll the page", [
    // Three that move focus for the reader: opening, restoring, and each arrow.
    (listCode.match(/\.focus\(\{ preventScroll: true \}\)/g) ?? []).length,
    // …and exactly one that does not, which is the body fallback `Sheet` also
    // makes: there is nothing to reveal and nowhere to scroll to.
    (listCode.match(/\.focus\(\)/g) ?? []).length,
    (listCode.match(/document\.body\.focus\(\)/g) ?? []).length,
  ], [3, 1, 1]);
  // `Sheet` solved the disappearing trigger first; this mirrors it rather than
  // inventing a second answer.
  check("and a trigger that did not survive falls back like Sheet's", /back\.isConnected/.test(listCode), true);
}

process.stdout.write("\nthe decision surfaces, at the platform tap minimum\n");
{
  /*
   * **Every pressable thing on a card where the agent is waiting on a human is
   * 44px**, and this is asserted on those three files rather than on the whole UI
   * for a reason worth stating: a blanket rule would be false. Measured across
   * `src/ui`, 40 of 57 class strings carrying `tap` or `press` do not reach 44px,
   * and most of them are right not to — `SignIn`'s `tap ${LINK}` is a link inside a
   * sentence, `AgentsPanel`'s are `<summary>` elements in running text, and the
   * machine tabs are deliberately 32px pills in a strip you drag sideways. A check
   * needing a 40-entry exception list is a list, not a check.
   *
   * What makes these three different is consequence. A mis-tap here answers the
   * agent: it approves a command, refuses one, or submits a form into the model's
   * context. `AskCard`'s own docblock already argues the standard — *"44px, like
   * every other target in this app… It was `min-h-9`, i.e. 36px, on the one row in
   * this UI where a mis-tap approves something"* — and the standard was then
   * violated on the same card's header controls (26px, 2px apart) and on
   * `ElicitationCard`'s answer rows (40px) and `PermissionCard`'s detail disclosure
   * (18px), all of which this check found. A convention plus a docblock is not a
   * mechanism; this is the mechanism.
   *
   * `size="lg"` is absent from the pattern deliberately: an `IconButton` carries no
   * `tap` in the caller's markup, because the primitive adds its own — so a control
   * routed through the primitive is not scanned here at all. **That is an exemption
   * rather than coverage**, and the sweep below is what makes it one; the sentence
   * that used to sit here said the primitive's own 44px entry covered them, which
   * is false for its *default* size and therefore for a third of its call sites.
   * Only hand-rolled class strings reach the scan in this loop.
   */
  const DECISION_CARDS = ["AskCard.tsx", "PermissionCard.tsx", "ElicitationCard.tsx"];
  // `min-h-14` is a taller row, `MENU_ROW` and `TAP_GROW_Y` are the two shared
  // constants that reach 44 by themselves.
  const REACHES_44 = /min-h-11|min-h-14|\bh-11\b|MENU_ROW|TAP_GROW_Y/;
  // Both spellings of the attribute. The template-literal arm stops at the first
  // backtick, which holds because every interpolation on these cards is a ternary
  // over double-quoted strings.
  const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`)/g;

  const short: string[] = [];
  let scanned = 0;
  for (const file of DECISION_CARDS) {
    const src = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    for (const match of src.matchAll(CLASS_ATTR)) {
      const classes = match[1] ?? match[2] ?? "";
      if (!/\btap\b|\bpress\b/.test(classes)) continue;
      scanned += 1;
      if (!REACHES_44.test(classes)) short.push(`${file}: ${classes.slice(0, 60)}`);
    }
  }

  // A pattern that matches nothing would pass this section silently, which is the
  // failure mode of every source-text assertion in this file.
  check("the scan actually found the controls", scanned >= 6, true);
  check("nothing a person taps to answer an agent is under 44px", short, []);

  /*
   * ⚠ **And the other half of the exemption above, which was written down as a
   * premise and never checked.**
   *
   * `bits.tsx`'s `ICON_BUTTON_SIZE` has four entries and only three of them
   * reach the platform minimum: `sm` is 24px of ink with `after:-inset-2.5`
   * around it (24 + 20 = 44), `chip` is 32px with `TAP_GROW_Y`, and `lg` is
   * `h-11`, which is the 44px itself. `md` is `h-9 w-9` — 36px, with no growth
   * mechanism of any kind — and `md` is the **default**. So "routed through the
   * primitive" was never the same thing as "44px", and a call site that simply
   * omits the prop is 36px wherever it is drawn.
   *
   * Swept over the whole of `src/ui` rather than over the three decision cards,
   * because the primitive is the whole UI's answer to this question and the
   * controls that omit the prop are not on those cards at all.
   *
   * A size handed down as a *prop* (`size={size}`) is reported too and that is
   * deliberate: a source sweep cannot resolve it, and the component holding it
   * has a default of its own that has to be read to know what it draws.
   */
  const ICON_BUTTON_44 = /size="(?:sm|chip|lg)"/;
  const iconButtons: string[] = [];
  const undersized: string[] = [];
  const sweepIconButtons = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        sweepIconButtons(child);
        continue;
      }
      if (!/\.tsx$/.test(entry.name)) continue;
      // Comments out first, for the reason every source-text pin here gives: the
      // docblocks around these call sites quote `md` and quote the sizes.
      const text = readFileSync(child, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const call of text.matchAll(/<IconButton\b[\s\S]*?\/>/g)) {
        const where = `${entry.name}: ${call[0].replace(/\s+/g, " ").slice(0, 72)}`;
        iconButtons.push(where);
        if (!ICON_BUTTON_44.test(call[0])) undersized.push(where);
      }
    }
  };
  sweepIconButtons(new URL("../src/ui/", import.meta.url));
  check("the sweep found the primitive's call sites", iconButtons.length >= 8, true);

  /*
   * Drawn at the 36px `md` default, known, and not yet decided.
   *
   * This list exists because the exemption above was narrowed and told the truth
   * for the first time. The old sweep skipped every `IconButton` call site on the
   * stated grounds that "a control routed through the primitive is covered by the
   * primitive's own 44px entry" — and that premise is false: of the four entries in
   * `ICON_BUTTON_SIZE`, `sm` reaches 44 through `after:-inset-2.5`, `chip` through
   * `TAP_GROW_Y` and `lg` by being `h-11`, while `md` is `h-9 w-9` with no growth
   * mechanism at all. `md` is also the default, so omitting the prop is how you get
   * the one size that does not reach the floor.
   *
   * These four are recorded rather than fixed because fixing them is a decision
   * about the interface and not about this driver. Neither remedy is free. Growing
   * the target symmetrically is what `chip`'s own docblock warns against — at
   * `gap-1.5` a 4px-a-side `::after` puts one control's target over its neighbour's
   * *face* — and growing the box changes what is drawn. So the size stays and the
   * debt is written down.
   *
   * **The list may only shrink**, which is the whole point and is asserted twice
   * below: a new undersized call site fails, and a fixed one fails until its line
   * here is deleted. Same shape as `docscheck`'s `CITED_BUT_UNRESOLVED`, for the
   * same reason — a known defect that nothing asserts is a defect nobody finds
   * again.
   */
  const ICON_BUTTON_KNOWN_36 = new Set([
    "Header.tsx:ChevronLeft:Back to sessions", // the phone's only way back to the session list
    "SessionMenu.tsx:MoreVertical:Session actions", // the kebab; this file's own `size` default is `md` too
    "Sheet.tsx:X:Close", // the ✕ that Sheet.tsx's own docblock calls "the accessible way out"
    "AgentsPanel.tsx:X:<expr>", // removing a saved credential, and destructive
  ]);
  /*
   * The key carries the label, and the count is asserted beside the set.
   *
   * Keyed on `file:icon` alone this ratchet had a hole, found by mutation rather
   * than by reading: a *second* undersized `X` in `Sheet.tsx` answers to the same
   * key as the known one and was absorbed silently, so the check that exists to
   * catch a new one passed while a new one was on screen. The label discriminates
   * the literal cases; the count closes the rest, including a second control whose
   * label is an expression and therefore keys as `<expr>` like its neighbour.
   */
  const keyOf = (where: string): string => {
    const file = where.slice(0, where.indexOf(":"));
    const icon = /icon=\{(\w+)\}/.exec(where)?.[1] ?? "?";
    const label = /label="([^"]*)"/.exec(where)?.[1] ?? "<expr>";
    return `${file}:${icon}:${label}`;
  };
  check(
    "no NEW control is drawn at the 36px default",
    undersized.filter((where) => !ICON_BUTTON_KNOWN_36.has(keyOf(where))),
    [],
  );
  check(
    "and every one still on the known list is still undersized (delete the line when you fix one)",
    [...ICON_BUTTON_KNOWN_36].filter((key) => !undersized.some((where) => keyOf(where) === key)),
    [],
  );
  check("and there are exactly as many as the list names", undersized.length, ICON_BUTTON_KNOWN_36.size);
}

/* ------------------------------------------------------------------ *
 * Slash commands
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe composer's command menu\n");
{
  const { slashQuery, buildCommands, filterCommands, completion, configChoices, typeableName, commandScope, typedConfigCommand } =
    await import("../src/ui/commands.js");

  /*
   * The name a synthesized command gets, and the case bug it had.
   *
   * Lowercasing turned claude's real mode `acceptEdits` into `acceptedits` —
   * neither what the agent calls it nor anything a person would read back. Case
   * was never needed for typeability (nothing here is a shell) and `rankOf` folds
   * it anyway, which is why the last assertion here matters as much as the first.
   */
  check("an agent's own camelCase survives", typeableName("acceptEdits"), "acceptEdits");
  check("and so does the longest real one", typeableName("bypassPermissions"), "bypassPermissions");
  check("what could not be typed as one token is replaced", typeableName("something new!"), "something-new");
  check("separators never dangle", typeableName("  --weird--  "), "weird");
  check("and a name with nothing left is no name at all", typeableName("!!!"), null);

  /*
   * Parsing, and the rule is deliberately narrower than every editor's.
   *
   * The `/` must be at index 0 of the whole message. Kimi's adapter runs
   * `startsWith("/")` against the leading text block whole and claude's CLI parses
   * a command only at the start of a message — so a `/` anywhere else is not a
   * command on either agent, and this app's composer is full of paths that would
   * otherwise open a menu mid-sentence.
   */
  check("a bare slash opens an empty query", slashQuery("/", 1), { start: 0, query: "" });
  check("and typing filters it", slashQuery("/mo", 3), { start: 0, query: "mo" });
  check("the caret decides how much is the query", slashQuery("/model", 3), { start: 0, query: "mo" });
  check("a path is not a command", slashQuery("cd /usr", 7), null);
  check("nor is a slash after a newline", slashQuery("hi\n/model", 9), null);
  check("nor one after a space", slashQuery(" /model", 7), null);
  check("a space ends the name, and the menu with it", slashQuery("/model ", 7), null);
  check("as does an argument", slashQuery("/model sonnet", 13), null);
  check("empty text has no query", slashQuery("", 0), null);
  check("and a caret before the slash has none either", slashQuery("/mo", 0), null);

  // Conservation: `start` always points at the slash, so the token can be spliced
  // back out of the text it came from. A parser that returned an offset nobody
  // could reconstruct from would corrupt the draft on every completion.
  const reconstruct = (text: string, caret: number): string | null => {
    const found = slashQuery(text, caret);
    return found === null ? null : text.slice(found.start, found.start + 1 + found.query.length);
  };
  check("the query round-trips out of the text", reconstruct("/model", 4), "/mod");

  /*
   * Building the list — and this is the assertion the whole feature rests on.
   *
   * Kimi publishes none of model, effort or mode as a command, and neither agent
   * publishes `/mode`. They exist because they are synthesized from the controls
   * by *category*, which is the only thing claude's `effort` and kimi's
   * `thinking` have in common. If this ever regresses to an id-keyed table it
   * fails silently on exactly one agent.
   *
   * The fixture carries a real choice because a control with none is no longer a
   * command — see "a control with nothing to choose between", below.
   */
  const option = (id: string, category: string | null, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    description: null,
    category,
    kind: "select",
    value: id,
    // Named after the option so a mode fixture's lone choice collides with the
    // `/mode` command already taken and expands to nothing — which keeps these
    // assertions about the three synthesized controls and not about the mode
    // shortcuts, which have their own section below.
    choices: [{ value: id, name: id, description: null, group: null }],
    ...over,
  });

  const claudeConfig = { modes: null, options: [option("mode", "mode"), option("model", "model"), option("effort", "thought_level")] };
  const kimiConfig = { modes: null, options: [option("mode", "mode"), option("model", "model"), option("thinking", "thought_level")] };
  // Kimi's real published list, measured: six builtins, and not one of them is a
  // model, an effort or a mode.
  const kimiCommands = [
    { name: "compact", description: "Compact the conversation context", hint: "<optional instructions>" },
    { name: "status", description: "Show current session status", hint: null },
    { name: "usage", description: "Show session token usage", hint: null },
    { name: "mcp", description: "Show MCP server status", hint: null },
    { name: "tasks", description: "List background tasks", hint: null },
    { name: "help", description: "Show available ACP commands", hint: null },
  ];

  const onKimi = buildCommands(kimiCommands as never, kimiConfig as never);
  check(
    "kimi gets /model, /effort and /mode though it publishes none of them",
    onKimi.filter((e) => e.kind === "config").map((e) => e.name),
    ["mode", "model", "effort"],
  );
  check(
    "and claude gets the same three from differently-named ids",
    buildCommands([] as never, claudeConfig as never).map((e) => e.name),
    ["mode", "model", "effort"],
  );
  /*
   * The row is called `effort` and it *describes itself* as Effort, on the agent
   * whose own word is `Thinking`.
   *
   * The two halves used to disagree by one tap: the command name came from
   * `CATEGORY_COMMAND` (ours, because an id is not portable) and the description
   * fell back to `option.name` (the agent's). Measured 2026-08-04, kimi's control
   * is `id: "thinking"`, `name: "Thinking"` — so the menu offered `/effort`
   * described as "Thinking", and the chip it opens said "Thinking" too. This is
   * the assertion that keeps the one concept to one word.
   */
  const kimiEffort = onKimi.find((e) => e.name === "effort");
  check("and on kimi the effort row does not describe itself as Thinking", kimiEffort?.description, "Effort");
  check("kimi's own commands keep the agent's order", onKimi.filter((e) => e.kind === "prompt").map((e) => e.name), [
    "compact",
    "status",
    "usage",
    "mcp",
    "tasks",
    "help",
  ]);

  // `model_config` is hidden from the strip by product decision; a slash command
  // would let it back in through the side door. An unknown category still gets an
  // entry, because demoting is not dropping.
  const odd = buildCommands([] as never, {
    modes: null,
    options: [option("fast", "model_config"), option("something new!", "unheard_of")],
  } as never);
  check("a hidden category gets no command", odd.map((e) => e.name), ["something-new"]);

  /*
   * The collision rule. Neither agent publishes `/model` today, but claude's list
   * is the CLI's own minus a denylist that contains neither `model` nor `effort`,
   * so this can go live with any CLI release — and when it does, sending `/model`
   * as text is a dead end, because ACP has no interactive picker to answer with.
   */
  const shadowed = buildCommands(
    [{ name: "model", description: "Change the model", hint: null }, { name: "compact", description: "Compact", hint: null }] as never,
    claudeConfig as never,
  );
  check("a control shadows an identically-named command", shadowed.filter((e) => e.name === "model").map((e) => e.kind), ["config"]);
  check("and the shadowed one is dropped, never offered twice", shadowed.map((e) => e.name), ["mode", "model", "effort", "compact"]);

  /*
   * Each mode as its own command, which is what makes `/plan` mean something.
   *
   * Measured 2026-08-03, claude publishes six modes and **no `plan` command** —
   * so `/plan` exists only because the choices are lifted to the top level, and
   * nothing here knows the word: an agent with different modes gets different
   * commands from the same rule.
   */
  const withModes = {
    modes: null,
    options: [
      option("mode", "mode", {
        value: "default",
        choices: [
          { value: "default", name: "Manual", description: "Standard behavior", group: null },
          { value: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution", group: null },
          { value: "acceptEdits", name: "Accept Edits", description: null, group: null },
        ],
      }),
    ],
  };
  const modal = buildCommands([] as never, withModes as never);
  check("every mode becomes a command of its own", modal.map((e) => e.name), [
    "mode",
    "default",
    "plan",
    "acceptEdits",
  ]);
  /*
   * `/default` and not `/manual`, which was built and taken back out.
   *
   * The name is the agent's id, always. That is what makes these portable — both
   * agents call this mode `default` underneath — and it is what somebody who knows
   * the agent will reach for. What "default" fails to *say* is answered by the
   * description under the row rather than by this client deciding the command is
   * called something else; see `choiceOverride`.
   */
  check(
    "named by the agent's id, which is what a person types",
    modal.find((e) => e.name === "default")?.value,
    "default",
  );
  // One tap, not two: a mode carries the value it applies, so choosing it never
  // opens a second stage. That is the field the composer branches on.
  check("a mode carries the value it applies", modal.find((e) => e.name === "plan")?.value, "plan");
  check("while the control itself opens its choices", modal.find((e) => e.name === "mode")?.value, null);
  check(
    "and it explains itself with the agent's own sentence",
    modal.find((e) => e.name === "plan")?.description,
    "Planning mode, no actual tool execution",
  );
  // The name is the floor when the agent gives no sentence — never an invented one.
  check(
    "falling back to the choice's name",
    modal.find((e) => e.name === "acceptEdits")?.description,
    "Accept Edits",
  );

  /*
   * And here the collision rule runs the *other* way, deliberately. `/model`
   * shadows a published command because sending it as text is a dead end; a mode
   * shortcut is a convenience, and a command somebody actually installed is more
   * specific intent than one we synthesized.
   */
  const contested = buildCommands(
    [{ name: "plan", description: "Write an implementation plan", hint: null }] as never,
    withModes as never,
  );
  /*
   * **Typing a control has to do what choosing it does**, and until this existed
   * it did the opposite: the name went to the agent as text.
   *
   * Measured against claude — `/plan I want to build…` was delivered as a prompt and
   * came back "/plan isn't available in this environment". A mode change spent as
   * a whole turn, on the one surface whose names are ours *precisely* so they are
   * portable and typeable. The menu applies these on selection and sends nothing;
   * Enter has to reach the same place.
   *
   * Two shapes, split by `value`: a mode carries one and is therefore a change,
   * with anything after the name being the message to send once it lands; the
   * three controls carry none and are a question, so they open their choice list
   * and there is nothing to send.
   */
  const typedMode = typedConfigCommand("/plan", modal as never);
  check("a typed mode shortcut is recognised", typedMode?.entry.name, "plan");
  check("and carries the value it will apply", typedMode?.entry.value, "plan");
  check("with nothing left to send", typedMode?.rest, "");

  // The reported case: the mode *and* a prompt in one message.
  const withPrompt = typedConfigCommand("/plan I want to build a tg bot", modal as never);
  check("an argument after the name survives as the message", withPrompt?.rest, "I want to build a tg bot");
  check("and the mode is still what gets applied", withPrompt?.entry.value, "plan");

  // A control rather than a change: nothing to send, so `rest` is not a message
  // and the caller opens the choice list instead.
  check("a control with no value is recognised too", typedConfigCommand("/mode", modal as never)?.entry.value, null);

  /*
   * The refusals, which are the half that keeps this from eating ordinary
   * messages. The `startsWith("/")` rule is `slashQuery`'s, for its reasons: a
   * slash is a command only at index 0, and this composer is full of paths.
   */
  check("a slash mid-message is not a command", typedConfigCommand("see /plan for details", modal as never), null);
  check("nor is a path", typedConfigCommand("/usr/bin/env", modal as never), null);
  check("an unknown name is left to the agent", typedConfigCommand("/compact", modal as never), null);
  // A published `prompt` command is the agent's own and is sent as typed — that
  // is the only way ACP has to invoke one at all.
  const published = buildCommands(
    [{ name: "review", description: "Review the diff", hint: null }] as never,
    withModes as never,
  );
  check("a published command is never intercepted", typedConfigCommand("/review the auth code", published as never), null);

  check(
    "a published command keeps its name against a mode shortcut",
    contested.find((e) => e.name === "plan")?.kind,
    "prompt",
  );
  check("and the name is still offered exactly once", contested.filter((e) => e.name === "plan").length, 1);

  // Modes only. A model list expanded this way would put `/opus[1m]` in the menu,
  // and effort's five values mean nothing standing on their own.
  const modelly = buildCommands([] as never, {
    modes: null,
    options: [option("model", "model", { choices: [{ value: "opus[1m]", name: "Opus", description: null, group: null }] })],
  } as never);
  check("no other category is expanded into its values", modelly.map((e) => e.name), ["model"]);

  /*
   * Built-ins before installed skills, and where that fact is read from.
   *
   * ACP's `AvailableCommand` is `{name, description, input}` — there is nowhere
   * to put a scope, so claude puts it on the end of the description. Parsing
   * prose is not nice; what makes it acceptable is the direction it fails in.
   */
  check("claude's scope suffix is read", commandScope("Router for the gstack suite. (gstack) (user)"), "user");
  check("project scope too", commandScope("Something. (project)"), "project");
  // The load-bearing half: anything else is "no information", which sorts with
  // the built-ins — so kimi, which says nothing of the sort, keeps its own order
  // exactly, and a claude that reworded this degrades to that rather than to a
  // wrong answer. The cost of being wrong is menu order, never behaviour.
  check("and anything else is simply unknown", commandScope("Compact the conversation context"), null);
  check("a bare word in parentheses is not a scope", commandScope("Does a thing (somehow)"), null);

  const mixed = buildCommands(
    [
      { name: "aaa-installed", description: "A skill. (gstack) (user)", hint: null },
      { name: "zzz-builtin", description: "Compact the conversation", hint: null },
      { name: "mmm-project", description: "Local one. (project)", hint: null },
      { name: "bbb-builtin", description: "Show status", hint: null },
    ] as never,
    undefined,
  );
  check("built-ins come first, and the agent's order decides inside each tier", mixed.map((e) => e.name), [
    "zzz-builtin",
    "bbb-builtin",
    "aaa-installed",
    "mmm-project",
  ]);
  // Stable, not merely sorted: `zzz` before `bbb` proves nothing alphabetised it.
  check("nothing is alphabetised", mixed[0]?.name, "zzz-builtin");

  /*
   * Commands the adapter hides but which measurably work.
   *
   * claude filters eight names before sending, so no client can offer them
   * however it is written — but that is about advertising, not capability.
   * Measured 2026-08-03: seed a codeword, send `/clear`, ask for it back, get
   * `NO MEMORY`. One entry, restored because it was driven, not guessed at.
   */
  const restored = buildCommands([{ name: "help", description: "Help", hint: null }] as never, undefined, undefined, "claude");
  // Appended, never prepended — and the order is the assertion. `rankOf` breaks
  // ties by build index, so prepending made `/clear` (irreversible agent amnesia)
  // outrank `/compact` and `/context` for the query `c`, which is the most
  // natural prefix in claude's entire list.
  check("a hidden built-in the agent still accepts is restored", restored.map((e) => e.name), ["help", "clear"]);
  check(
    "and it says what it costs, since nothing else can",
    restored.find((e) => e.name === "clear")?.description.includes("transcript above stays"),
    true,
  );
  const cQuery = filterCommands(
    buildCommands(
      [
        { name: "compact", description: "Compact the conversation", hint: null },
        { name: "context", description: "Show context", hint: null },
      ] as never,
      undefined,
      undefined,
      "claude",
    ),
    "c",
  );
  check("and it does not outrank the reversible commands it shares a prefix with", cQuery.map((e) => e.name), [
    "compact",
    "context",
    "clear",
  ]);
  // Per agent, never global: kimi's adapter has its own six builtins and no such
  // denylist, so inventing a command for it would be inventing one outright.
  check("kimi is offered nothing it did not publish", buildCommands([] as never, undefined, undefined, "kimi"), []);
  check("and an unknown agent likewise", buildCommands([] as never, undefined, undefined, "nobody"), []);
  // A restored command is as real as a published one, so it claims its name.
  check(
    "a restored name is defended against a mode shortcut",
    buildCommands([] as never, {
      modes: null,
      options: [option("mode", "mode", { choices: [{ value: "clear", name: "Clear", description: null, group: null }] })],
    } as never, undefined, "claude").filter((e) => e.name === "clear").map((e) => e.kind),
    ["prompt"],
  );

  // Conservation, both directions: no name appears twice, and the discriminant and
  // its payload cannot drift apart.
  check("every name is unique", new Set(onKimi.map((e) => e.name)).size, onKimi.length);
  check(
    "a config entry always carries its option and a prompt entry never does",
    onKimi.every((e) => (e.kind === "config") === (e.option !== null)),
    true,
  );
  // A value without an option would be a change the composer cannot apply.
  check(
    "and a value never travels without the option it belongs to",
    [...modal, ...contested, ...onKimi].every((e) => e.value === null || e.option !== null),
    true,
  );
  // An older daemon sends no config at all, and both sources can be empty. Neither
  // may throw, and empty must stay empty so the menu can never open onto nothing.
  check("an older daemon still gets the agent's commands", buildCommands(kimiCommands as never, undefined).length, 6);
  check("and with nothing at all there is nothing to show", buildCommands([] as never, undefined), []);

  /*
   * Ranking. Prefix-first and never fuzzy: a subsequence match over an unfamiliar
   * sixty-item list is unpredictable, and being guessable is the only property a
   * typeahead actually has to have.
   */
  check("an empty query is the identity, order and all", filterCommands(onKimi, ""), onKimi);
  // The tiers, in one query: `usage` matches as a name prefix, `status` only as a
  // substring inside its name, and `mcp` only through its description ("…server
  // status"). All three are matches; the order is the whole point.
  check("a name prefix, then a substring, then a description", filterCommands(onKimi, "us").map((e) => e.name), [
    "usage",
    "status",
    "mcp",
  ]);
  check("case does not matter", filterCommands(onKimi, "COMP").map((e) => e.name), ["compact"]);
  check(
    "a name prefix outranks a description match",
    filterCommands(onKimi, "mo").map((e) => e.name),
    ["mode", "model"],
  );
  // Claude renames every MCP command to `mcp:name`, and nobody types the prefix.
  check(
    "a segment prefix finds an mcp command",
    filterCommands(buildCommands([{ name: "mcp:github", description: "GitHub", hint: null }] as never, undefined), "github").map((e) => e.name),
    ["mcp:github"],
  );
  // A one-letter substring matches nearly every sentence, which would quietly turn
  // the filtered list back into the unfiltered one.
  // `v` appears in no name here and in one description ("Show MCP server status").
  check("one character never matches a description", filterCommands(onKimi, "v").map((e) => e.name), []);
  check("but two do", filterCommands(onKimi, "token").map((e) => e.name), ["usage"]);
  check(
    "nothing is invented and nothing is copied",
    filterCommands(onKimi, "s").every((entry) => onKimi.includes(entry)),
    true,
  );

  /*
   * Completion. The hint is shown and never inserted — `<optional custom
   * summarization instructions>` is a real one, and putting it in the box would
   * send those words to the model as if somebody had typed them.
   */
  const compact = onKimi.find((e) => e.name === "compact");
  check("choosing a command leaves it ready for arguments", completion("/comp", { start: 0, query: "comp" }, compact as never), {
    text: "/compact ",
    caret: 9,
  });
  const help = onKimi.find((e) => e.name === "help");
  check(
    "a command with a hint completes identically, because the hint is never inserted",
    completion("/he", { start: 0, query: "he" }, help as never).text,
    "/help ",
  );
  const model = onKimi.find((e) => e.name === "model");
  check("choosing a control clears the token instead", completion("/model", { start: 0, query: "model" }, model as never), {
    text: "",
    caret: 0,
  });

  /*
   * The two composed, which is the pair that was never composed and the bug that
   * hid in the gap.
   *
   * `slashQuery` deliberately allows a caret *inside* the token — asserted above
   * as "the caret decides how much is the query" — while every `completion` case
   * here passed a query whose length happened to equal the whole token. So the
   * arithmetic that sliced at the caret rather than at the token end looked right
   * and was not: the rest of the name survived as an argument. Reached by
   * arrowing left, or by tapping back to fix a typo; neither closes the menu.
   *
   * Driven through `slashQuery` rather than with a hand-written query, because a
   * hand-written one is how the two stayed apart.
   */
  const at = (text: string, caret: number, entry: unknown) =>
    completion(text, slashQuery(text, caret) as never, entry as never);
  check("a caret inside the name still completes the whole name", at("/compact", 4, compact), {
    text: "/compact ",
    caret: 9,
  });
  check("and the tail of the name is not left behind as an argument", at("/compact", 1, compact).text, "/compact ");
  check("a real argument past the caret survives", at("/compact now please", 3, compact).text, "/compact now please");
  // The silent half: a control clears the token, and "the token" is the whole
  // token. This left `del` sitting in an otherwise empty box.
  check("a control mid-token clears all of it", at("/model", 3, model), { text: "", caret: 0 });
  check("and keeps what genuinely followed it", at("/model sonnet", 3, model).text, "sonnet");

  /*
   * The second stage's labels, which must agree with the chip's. Claude's effort
   * `default` is the value where the agent's own name says nothing and the true
   * answer had to be read out of the CLI — so it is read through `adaptiveLabel`
   * here rather than beside it.
   */
  const effort = option("effort", "thought_level", {
    choices: [
      { value: "default", name: "Default", description: null, group: null },
      { value: "high", name: "High", description: "Think hard", group: null },
    ],
  });
  check("the menu names adaptive effort the way the chip does", configChoices(effort as never).map((row) => row.label), [
    "Adaptive",
    "High",
  ]);
  check(
    "and explains it where there is room",
    configChoices(effort as never)[0]?.description,
    "The model decides how much to think, per turn",
  );

  /*
   * The other `default`, where the answer is a caption rather than a rename — and
   * the asymmetry with the effort case above is the whole point of the fixture.
   *
   * Measured 2026-08-06, the two agents name one identical mode id differently:
   *
   *   claude  value "default"  name "Manual"   description null
   *   kimi    value "default"  name "Default"  description "Manual approvals; …"
   *
   * Renaming both to `Manual` was built first and taken back out. The premise is
   * weaker here than at `thought_level`: kimi *did* say what its mode means, in a
   * sentence, so the name is not the only thing there is — and a client that
   * renames what an agent calls something is a client inventing vocabulary. So the
   * name stands on both and only the sentence is supplied.
   *
   * Both fixtures, because a rule here is silently correct on whichever agent the
   * author happened to be running.
   */
  const claudeMode = option("mode", "mode", {
    value: "default",
    choices: [{ value: "default", name: "Manual", description: null, group: null }],
  });
  const kimiMode = option("mode", "mode", {
    value: "default",
    choices: [
      { value: "default", name: "Default", description: "Manual approvals; tools execute normally.", group: null },
    ],
  });
  check("kimi goes on calling its mode what it calls it", configChoices(kimiMode as never).map((row) => row.label), ["Default"]);
  check("and so does claude", configChoices(claudeMode as never).map((row) => row.label), ["Manual"]);
  check(
    "kimi's own sentence is the one shown",
    configChoices(kimiMode as never)[0]?.description,
    "Manual approvals; tools execute normally.",
  );
  check(
    "while claude's silence is filled in rather than left blank",
    configChoices(claudeMode as never)[0]?.description,
    "The agent asks before running each tool",
  );

  /*
   * The prose fallback, which is the arm that matters in a live session and the
   * arm nothing reached.
   *
   * `snapshotConfig` keeps only the *selected* choice's description, so every
   * other choice's sentence can arrive only from the transcript. Both callers
   * take a `prose` map for that, and every case above passed `undefined` — so the
   * two arms under test were the two a real session mostly does not take.
   */
  const proseFor = configProse([
    {
      seq: 1,
      at: 0,
      event: {
        type: "agent_config",
        modes: null,
        options: [
          {
            id: "mode",
            name: "mode",
            description: "How the agent asks",
            category: "mode",
            kind: "select",
            value: "plan",
            choices: [
              { value: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution", group: null },
              { value: "auto", name: "Auto", description: null, group: null },
            ],
          },
        ],
      },
    },
  ] as never);
  const bare = option("mode", "mode", {
    value: "plan",
    choices: [
      { value: "plan", name: "Plan Mode", description: null, group: null },
      { value: "auto", name: "Auto", description: null, group: null },
    ],
  });
  check(
    "a choice with no description of its own is explained from the transcript",
    configChoices(bare as never, proseFor.get("mode")).map((row) => row.description),
    ["Planning mode, no actual tool execution", null],
  );
  // And a mode *shortcut* takes the same road: `/plan` should say what plan mode
  // is, not repeat its own name back.
  check(
    "and so does the mode shortcut built from it",
    buildCommands([] as never, { modes: null, options: [bare] } as never, proseFor).find((e) => e.name === "plan")
      ?.description,
    "Planning mode, no actual tool execution",
  );
  check(
    "with the choice's own sentence still winning where it has one",
    buildCommands(
      [] as never,
      {
        modes: null,
        options: [
          option("mode", "mode", {
            value: "plan",
            choices: [{ value: "plan", name: "Plan Mode", description: "Its own words", group: null }],
          }),
        ],
      } as never,
      proseFor,
    ).find((e) => e.name === "plan")?.description,
    "Its own words",
  );

  /*
   * A control with nothing to choose between is not a command.
   *
   * `kind: "boolean"` carries no choices at all, and a select can arrive empty.
   * Either used to produce a row whose second stage was a list of length zero —
   * so choosing it cleared the whole draft and then rendered nothing, because the
   * menu only opens onto a non-empty list. A dead end that ate what you typed.
   */
  check(
    "a boolean control is not offered as a command",
    buildCommands([] as never, {
      modes: null,
      options: [option("verbose", "output", { kind: "boolean", value: false, choices: [] })],
    } as never),
    [],
  );
  check(
    "nor is a select with nothing in it",
    buildCommands([] as never, {
      modes: null,
      options: [option("model", "model", { choices: [] })],
    } as never),
    [],
  );
}

/* ------------------------------------------------------------------ *
 * The command list's cache rule
 *
 * Four answers, all of them silent when wrong, and three of them were written
 * down as prose in a docblock while the code underneath did something else. Out
 * of `ensureCommands` as a pure function for exactly that reason — there is no
 * daemon here to drive, and a rule nothing can assert is a rule that drifts.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhen to refetch the agent's commands\n");
{
  check("nothing held and the agent has published: fetch", commandsPlan(undefined, 3, false), "fetch");
  check("what is held is what the daemon says: leave it", commandsPlan(3, 3, false), "current");
  check("the daemon has moved on: fetch again", commandsPlan(3, 4, false), "fetch");

  /*
   * `!==` and never `>`. A daemon restart puts the revision back to 0 while a
   * client still holds 5, and 5 is the *stale* one — the agent that published it
   * is gone. So this drops rather than declining to fetch, which is the whole
   * rule that was stated in two docblocks and implemented in neither: the
   * composer went on offering a dead agent's hundred commands.
   */
  check("a restarted daemon's zero drops what is held", commandsPlan(5, 0, false), "drop");
  check("and so does an older daemon that sends nothing at all", commandsPlan(5, undefined, false), "drop");
  check("with nothing held, dropping is still the answer", commandsPlan(undefined, 0, false), "drop");

  /*
   * A revision that arrives mid-flight is deferred, not discarded. The effect
   * that calls this is keyed on the revision, so a dropped call never comes
   * back — and on kimi, which never republishes, the client would hold a
   * superseded list for the life of the tab.
   */
  check("a bump during a fetch is remembered", commandsPlan(undefined, 6, true), "defer");
  check("and so is one that arrives while a stale list is held", commandsPlan(5, 6, true), "defer");
  // Except when there is nothing to chase: an in-flight request for the revision
  // we already hold needs no follow-up.
  check("but a fetch in flight for what is held is not", commandsPlan(6, 6, true), "current");
  // Dropping outranks everything, including a request in the air.
  check("and a drop is not deferred behind one either", commandsPlan(5, 0, true), "drop");
}

/* ------------------------------------------------------------------ *
 * The fleet, grouped — and the one rule that makes grouping safe
 * ------------------------------------------------------------------ */

process.stdout.write("\nmachine groups\n");
{
  const row = (id: string, machine: string, over: Record<string, unknown>) => ({
    key: `${machine}/${id}`,
    ref: { machineId: machine, sessionId: id },
    machineName: machine,
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });
  const machineOf = (id: string, name: string) => ({
    id,
    name,
    reach: "online",
    offlineReason: null,
    route: null,
    tokenDegraded: false,
    scopes: [],
  });

  const rows = [
    row("blocked", "m_b", { status: "blocked", pendingPermissions: [{ raisedAt: 5, title: "Edit" }] }),
    row("live", "m_a", { status: "running", lastEventAt: 20 }),
    row("pinned", "m_a", { status: "running", lastEventAt: 1, pinned: true }),
    row("done", "m_a", { status: "exited", exit: { reason: "stopped" }, lastEventAt: 30 }),
  ];
  const machines = [machineOf("m_b", "beta"), machineOf("m_a", "alpha"), machineOf("m_c", "gamma")];
  const state = { sessions: rows, machines } as never;

  const groups = sessionGroups(state);

  /*
   * THE rule, restated for the structure that replaced the needs-you zone.
   *
   * Blocked sessions now live inside their machine's section rather than in a flat
   * zone above it, which is what was asked for — so the property that an approval
   * cannot be hidden has to be carried by something else. That something is
   * `blockedCount` on the header: a *collapsed* section still says how many rows
   * under it are waiting. Without it, closing a machine would swallow an approval,
   * which is the one failure this screen exists to prevent.
   */
  const beta = groups.groups.find((g: { id: string }) => g.id === "m_b")!;
  check("a blocked row sits in its own machine's section", beta.active.map((r: { key: string }) => r.key), ["m_b/blocked"]);
  check("and the header counts it, so collapsing cannot hide it", beta.blockedCount, 1);
  const alpha = groups.groups.find((g: { id: string }) => g.id === "m_a")!;
  check("a machine with nothing waiting counts zero", alpha.blockedCount, 0);

  /*
   * Pinned is its own group above the machines — a pin means "this one, wherever
   * it lives", and one scattered per section is a list you reassemble by eye —
   * and it is a **move**, which reverses what this pair asserted for a while.
   *
   * ⚠ It copied, on the argument that lifting the row out made the session you
   * were working in disappear from the list you had been finding it in all day.
   * The reversal is not a change of taste: both groups are on the **same screen
   * at the same time**, a few hundred pixels apart, so the copy was not a second
   * place to find it, it was the same row drawn twice — and a bookmark whose job
   * is "this one, not the other forty" was drawing itself as two of the forty.
   * What the copy said that the pin did not — where the session works — is on the
   * row itself now, via `showPath`.
   */
  check("a pinned row is in the pinned group", groups.pinned.map((r: { key: string }) => r.key), ["m_a/pinned"]);
  check("and is no longer under its own machine", alpha.active.map((r: { key: string }) => r.key), ["m_a/live"]);

  // Ordered by name, never by reachability: `reach` flickers, and a list that
  // reorders itself under a travelling thumb is the failure this app cannot have.
  check("sections are ordered by name", groups.groups.map((g: { name: string }) => g.name), ["alpha", "beta", "gamma"]);
  check("a machine with no sessions still gets one", groups.groups.find((g: { id: string }) => g.id === "m_c") !== undefined, true);

  // Memoised on both arrays, and `emitTranscripts` replaces neither — so a
  // streamed token must not re-derive the whole fleet.
  check("the derivation is memoised by identity", sessionGroups(state) === groups, true);
  check("and a transcript-only change does not invalidate it", sessionGroups({ ...(state as object), transcripts: new Map() } as never) === groups, true);

  const orphaned = sessionGroups({ sessions: [row("lost", "m_gone", {})], machines: [] } as never);
  check("a row with no granted machine becomes an orphan", orphaned.orphans.length, 1);

  /*
   * Pinned *and* blocked, which is the combination the two rules above meet on —
   * and the assertion that inverted when pinning stopped moving rows.
   *
   * `blockedCount` means "rows under this header that are waiting", and it is
   * counted off where `place` actually filed the row rather than off the row's
   * machine id. That used to be a correction: a pinned row was not under its
   * header, so counting it made a machine read "1 waiting" with nothing waiting
   * inside it. Now the row *is* under the header, so the same line gives the
   * ordinary answer — one waiting, one row to find when you open it.
   *
   * The direction that would be safe if this were wrong is the over-count, since
   * it cannot hide an approval; a header contradicting its own contents in either
   * direction is what teaches people to stop believing the count.
   *
   * Below the memoisation checks above, deliberately: `sessionGroups` memoises in
   * module state, so an extra call placed before them replaces the cache and makes
   * the identity assertions fail on a change that is only in this driver.
   */
  const pinnedBlocked = sessionGroups({
    sessions: [
      row("pb", "m_a", { status: "blocked", pendingPermissions: [{ raisedAt: 5, title: "Edit" }], pinned: true }),
    ],
    machines: [machineOf("m_a", "alpha")],
  } as never);
  check("a pinned blocked row is in the pinned group", pinnedBlocked.pinned.map((r: { key: string }) => r.key), ["m_a/pb"]);
  check("and not under its own machine", pinnedBlocked.groups[0]!.active.map((r: { key: string }) => r.key), []);
  /*
   * **And its machine's header does not count it, which is the half worth
   * arguing.**
   *
   * A header's "N waiting" is a promise about the rows *under that header*, and
   * this row is not one of them — a folder saying "1 waiting" that opens onto
   * nothing waiting is how people learn to stop believing the number, which is
   * strictly worse than the number being smaller. Nothing is hidden by it: the
   * pinned group is above the folders on the same screen, `waitingFloor` counts
   * by subtracting what the view draws from everything blocked, and it draws
   * `pinnedFor` — asserted as a superset property over every filter, tab and
   * needle a few blocks down rather than trusted to this comment.
   */
  check("and its machine's header does not promise a row it will not draw", pinnedBlocked.groups[0]!.blockedCount, 0);
  /*
   * And the caret visits it once.
   *
   * `keyboard.ts` locates the current row with `findIndex(key === currentKey)`,
   * which answers with the *first* match — so while a row was drawn twice, `j`
   * from the machine-section copy resolved to the pinned copy's index and jumped
   * across the whole list. Nothing produces a duplicate today; the dedup in
   * `visibleRows` stays, and so does this, because what they defend against is a
   * *future* group that copies rather than the one that used to.
   */
  check("and the render order names it once", visibleRows(pinnedBlocked, currentView(pinnedBlocked)).map((r: { key: string }) => r.key), ["m_a/pb"]);
}

process.stdout.write("\nwhat is actually on screen\n");
{
  const row = (id: string, machine: string, over: Record<string, unknown> = {}) => ({
    key: `${machine}/${id}`,
    ref: { machineId: machine, sessionId: id },
    machineName: machine,
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });
  const machineOf = (id: string, name: string) => ({ id, name, reach: "online", offlineReason: null, route: null, tokenDegraded: false, scopes: [] });

  const rows = [
      row("blocked", "m_a", { status: "blocked", pendingPermissions: [{ raisedAt: 1, title: "Edit" }], workspace: workspaceAt("/home/u/api") }),
      row("live", "m_a", { status: "running", workspace: workspaceAt("/home/u/api/packages/web", "/home/u/api") }),
      row("kept", "m_b", { status: "running", pinned: true, workspace: workspaceAt("/home/u/web") }),
      row("other", "m_b", { status: "running", workspace: workspaceAt("/home/u/web") }),
      // A terminal row, and the fixture had none — so every `ended` assertion below
      // was true of a list that could not have contained anything, and `rowsOf`
      // returning `group.active` for the ended filter would have passed just as
      // green. One row is the difference between an assertion and a tautology.
      row("done", "m_b", { status: "exited", exit: { reason: "stopped" }, workspace: workspaceAt("/home/u/web") }),
  ];
  const state = { sessions: rows, machines: [machineOf("m_a", "alpha"), machineOf("m_b", "beta")] } as never;
  const groups = sessionGroups(state);
  const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key);

  /*
   * Which machine's chats are on screen, resolved against what exists.
   *
   * The remembered id is never overwritten by the fallback, so a grant revoked and
   * restored puts you back where you were — and the fallback itself is first *by
   * name*, never by activity, because activity flickers on the four-second poll
   * and a default tab that moves while you look at it is the same failure as a
   * list reordering under a thumb.
   */
  check("with nothing remembered, the first machine by name", selectedMachineIn(groups), "m_a");
  check("the tab bar is store order and adds no sort of its own", machineTabs(groups, currentView(groups)).map((t) => t.id), ["m_a", "m_b"]);
  check("and a tab carries the count its rows would", machineTabs(groups, currentView(groups)).map((t) => t.blockedCount), [1, 0]);

  /*
   * Folders. The key is the repo root where there is one, so a session started
   * three levels inside a repository files under the project a human recognises
   * rather than under `packages/web`.
   */
  check("a plain session files under its own directory", folderPathOf(rows[0] as never), "/home/u/api");
  check("and one inside a repo files under the repo", folderPathOf(rows[1] as never), "/home/u/api");
  check("so one folder holds both", foldersOf(groups, currentView(groups)).map((f) => f.name), ["api"]);
  check("and the row says only what the folder does not", rowSubpath(rows[1] as never, "/home/u/api"), "packages/web");
  check("while the folder's own row says nothing extra", rowSubpath(rows[0] as never, "/home/u/api"), null);

  /*
   * A basename until it collides, then the shortest suffix that separates them.
   * Two rows both reading "api" is the failure this exists to prevent.
   */
  check("unique basenames stay one word", folderNames(["/home/u/api", "/home/u/web"]), ["api", "web"]);
  check("a collision widens only the paths that clash", folderNames(["/home/a/api", "/home/b/api", "/home/a/web"]), ["a/api", "b/api", "web"]);
  check("and widening stops when one side runs out of path", folderNames(["/api", "/home/u/api"]), ["api", "u/api"]);
  check("the filesystem root is named for itself", folderNames(["/"]), ["/"]);

  /*
   * The render order. Pinned is cross-fleet and leads; then the selected
   * machine's folders; then orphans. `m_b/kept` is drawn under Pinned *and* under
   * its own folder when `m_b` is selected, and named once either way.
   */
  check("pinned leads, then the selected machine's folders", keys(visibleRows(groups, currentView(groups))), [
    "m_b/kept",
    "m_a/blocked",
    "m_a/live",
  ]);
  check("and blocked leads its folder", foldersOf(groups, currentView(groups))[0]?.rows[0]?.key, "m_a/blocked");
  check("which the folder header says even when shut", foldersOf(groups, currentView(groups))[0]?.blockedCount, 1);

  /*
   * **The hole the tab bar opened, and the thing that closes it.**
   *
   * With `m_b` selected, the blocked session on `m_a` has no row anywhere — its
   * folder is not drawn and its tab can be scrolled off the end of the bar. It has
   * to appear anyway, and it does, above everything else.
   */
  selectMachine("m_b" as never);
  check("selecting the other machine draws its folders", foldersOf(groups, currentView(groups)).map((f) => f.name), ["web"]);
  // `m_b/done` is absent because the default filter is `"active"` — the list is
  // "only the chats that are still going". It is reachable through the filter
  // control, which is the trade the default's own docblock in `groups.ts` states,
  // and the *next* assertion is the one that matters: a blocked row is lifted
  // whatever the filter says.
  check("and the session waiting on the machine you left is lifted to the top", keys(visibleRows(groups, currentView(groups))), [
    "m_a/blocked",
    "m_b/kept",
    "m_b/other",
  ]);
  check("the floor holds exactly that row", keys(waitingFloor(groups, currentView(groups))), ["m_a/blocked"]);
  // Nothing is lifted twice: with its own machine selected it has a folder, so the
  // floor is empty rather than duplicating it.
  selectMachine("m_a" as never);
  check("and nothing is lifted while its own machine is selected", keys(waitingFloor(groups, currentView(groups))), []);

  /*
   * Collapse is per folder, keyed per machine, and a needle overrides it — you
   * search, find three matches, and they must not be inside a folder you shut
   * last month.
   */
  const folder = foldersOf(groups, currentView(groups))[0]!;
  toggleFolder(folder.id);
  check("collapsing a folder removes exactly its rows", keys(visibleRows(groups, currentView(groups))), ["m_b/kept"]);
  check("a pinned row survives any collapse", keys(visibleRows(groups, currentView(groups))).includes("m_b/kept"), true);
  // "blocked" would match nothing: the raw session id is deliberately not
  // searched, so a needle has to name something visible on the row.
  setQuery("api");
  check("but a search opens it again", keys(visibleRows(groups, currentView(groups))), ["m_a/blocked", "m_a/live"]);
  setQuery("");
  toggleFolder(folder.id);
  check("expanding restores it", visibleRows(groups, currentView(groups)).length, 3);

  /*
   * The needle. `sessionLabel` first, which is the exact defect that got the last
   * search box deleted: it matched the machine, the agent, the cwd and the raw
   * session id, and not the one string a person actually reads on the row.
   */
  const titled = row("t", "m_a", { title: "Ship the relay", workspace: workspaceAt("/home/u/api") }) as never;
  check("the title is matched", matchesQuery(titled, "relay"), true);
  check("case does not matter", matchesQuery(titled, "SHIP"), true);
  check("so is the directory", matchesQuery(titled, "/home/u"), true);
  check("and the agent", matchesQuery(titled, "kimi"), true);
  // Not the machine: the needle only ever filters the selected machine's list, so
  // a machine-name match would answer with an empty list and read as broken.
  check("the machine is not", matchesQuery(titled, "m_a"), false);
  check("an empty needle keeps everything", matchesQuery(titled, "   "), true);

  /*
   * The filters still slice, and the default is `"active"` — the list is the
   * chats that are still going.
   *
   * That default went `"active"` → `"all"` → `"active"` again, and the round trip
   * is worth stating because the middle step was not a preference. This filter is
   * the **only** route to an ended session anywhere in the app, and for one
   * revision the control that reaches it was drawn as an inert placeholder; with
   * a dead control, `"active"` puts every finished conversation permanently out
   * of reach. `ChatSearch` wires the icon now, so the narrow default is safe
   * again — and if the control is ever reverted to a placeholder this assertion
   * and `groups.ts`'s initialiser go back to `"all"` together.
   */
  const view = currentView(groups);
  check("the default is the chats that are still going", view.filter, "active");
  selectMachine("m_b" as never);
  /*
   * The floor ignores the filter deliberately, so a blocked session rides above
   * the Ended slice rather than being sliced out of it: a filter is something you
   * asked for, and being asked for an approval is not something you can ask to
   * stop. `m_a/blocked` is therefore first here, and its absence would be the bug.
   */
  check("the ended filter shows terminal rows, and still anything waiting", keys(visibleRows(groups, { ...currentView(groups), filter: "ended" })), ["m_a/blocked", "m_b/done"]);
  check("and active shows the live ones", keys(visibleRows(groups, { ...currentView(groups), filter: "active" })), ["m_a/blocked", "m_b/kept", "m_b/other"]);

  /*
   * **The property, over the whole cross-product.**
   *
   * Every row in the fleet that is waiting on a human is somewhere in the render
   * order — under every filter, whichever tab is selected, and whatever has been
   * typed into the search box. This is the direct successor to "an approval cannot
   * be hidden", restated for a list that now shows one machine at a time, and it is
   * asserted as a superset rather than as a list so that a new section or a new
   * filter cannot open a gap in it by accident.
   *
   * **`all` is in the machine list, and it is not a formality.** The All tab is a
   * whole second way of building the render order — a flat cross-fleet list with no
   * folders, and one that deliberately *excludes* pinned rows so a session is not
   * drawn twice — so it is exactly the kind of new section this property exists to
   * catch. The view comes from `currentView` rather than a literal, which is what
   * makes the assertion about the code the rail runs instead of about a shape
   * assembled here that happens to resemble it.
   */
  const everyBlocked = rows
    .filter((r) => ((r.snapshot as { pendingPermissions?: unknown[] }).pendingPermissions?.length ?? 0) > 0)
    .map((r) => r.key);
  const filters = ["active", "ended", "all"] as const;
  const machines = ["m_a", "m_b", "all"] as const;
  const needles = ["", "web", "zzz-matches-nothing"];
  let holes: string[] = [];
  for (const f of filters) {
    for (const m of machines) {
      selectMachine(m as never);
      for (const q of needles) {
        setQuery(q);
        const shown = new Set(keys(visibleRows(groups, { ...currentView(groups), filter: f })));
        for (const key of everyBlocked) {
          if (!shown.has(key)) holes.push(`${f}/${m}/"${q}" hides ${key}`);
        }
      }
    }
  }
  setQuery("");
  check("no filter, tab or search can hide a session waiting on you", holes, []);

  /*
   * What All *is*, stated directly, because the superset property above only says
   * that nothing is lost — it would pass just as well if All drew every row twice.
   */
  selectMachine("all" as never);
  {
    const view = currentView(groups);
    check("All selects no machine in particular", view.machine, null);
    check("and says so", view.all, true);
    check("it draws no folders", foldersOf(groups, view).length, 0);
    // Pinned is excluded from the flat list: with no folders there is no second
    // place for the row to be, so the two copies would be the same row twice in
    // one list with nothing between them explaining why.
    check("the flat list leaves out what is pinned", keys(allRows(groups, view)).includes("m_b/kept"), false);
    check("and holds the rest of the fleet, newest first", keys(allRows(groups, { ...view, filter: "all" })), [
      "m_a/blocked",
      "m_a/live",
      "m_b/other",
      "m_b/done",
    ]);
    // Nothing is unreachable under All, so the band that exists because one
    // machine is on screen at a time has nothing to lift.
    check("and nothing has to be lifted, because nothing is elsewhere", waitingFloor(groups, view).length, 0);
  }
  selectMachine("m_a" as never);
  setQuery("");

  /*
   * Orphans obey the filter too, and they did not.
   *
   * They were appended raw, so an ended orphan appeared under Active and a live
   * one was missing from Ended. That is worse than a cosmetic slip because this
   * function *is* the render order `keyboard.ts` walks: `j` would land on a row
   * the rail was not drawing. Rows whose machine is no longer granted are rare,
   * which is exactly why nobody would think to doubt them.
   */
  const withOrphans = sessionGroups({
    sessions: [
      row("gone-live", "m_x", { status: "running" }),
      row("gone-done", "m_x", { status: "exited", exit: { reason: "stopped" } }),
    ],
    machines: [],
  } as never);
  const orphanView = (filter: "active" | "ended" | "all") => ({ filter, machine: null, all: false, query: "" });
  check("an ended orphan is not in the active slice", keys(visibleRows(withOrphans, orphanView("active"))), ["m_x/gone-live"]);
  check("and a live orphan is not in the ended slice", keys(visibleRows(withOrphans, orphanView("ended"))), ["m_x/gone-done"]);
  check("both are there unfiltered", visibleRows(withOrphans, orphanView("all")).length, 2);
}

/* ------------------------------------------------------------------ *
 * The one list the rail draws and the caret walks
 *
 * The section above asserts that `visibleRows` filters orphans. That was already
 * true and it was not enough: `SessionBrowser` went on mapping `groups.orphans`
 * raw, so "No longer granted" drew rows the single source of render order
 * excludes — and `keyboard.ts` locates the caret with
 * `findIndex(row.key === currentKey)`, which answers `-1` for a row only the JSX
 * knows about, so `j` from an orphan jumped to the top of the fleet. Under the
 * Ended filter the same section drew live rows.
 *
 * So the claim here is not "orphans are filtered" — it is that **one function
 * answers for both readers**. `orphansFor` is that function, exported beside
 * `pinnedFor` for exactly this reason, and both halves of the coupling are
 * asserted below: the behaviour, and the fact that the component reaches for it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe orphan section, drawn and walked from one list\n");
{
  const { matching, orphansFor } = await import("../src/ui/groups.js");

  const row = (id: string, machine: string, over: Record<string, unknown> = {}) => ({
    key: `${machine}/${id}`,
    ref: { machineId: machine, sessionId: id },
    machineName: machine,
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });

  // No machines at all, so every row is an orphan: a grant revoked while the tab
  // was open leaves exactly this state, which is why the group exists.
  const groups = sessionGroups({
    sessions: [
      row("live", "m_gone", { status: "running" }),
      row("done", "m_gone", { status: "exited", exit: { reason: "stopped" } }),
      // Interrupted is the one the Ended filter must *not* collect — the daemon
      // ended it and is bringing it back — and it is the row most likely to be
      // mis-bucketed by a second, hand-written copy of the rule.
      row("back", "m_gone", { status: "exited", exit: { reason: "daemon_restarted" } }),
    ],
    machines: [],
  } as never);

  check("the helper exists to be shared", typeof orphansFor, "function");
  // Blocked, then live, then terminal — the order `place` files them in, which is
  // `sessionLists`' own. Unfiltered means every row, in that order, and not the
  // order they were handed to `sessionGroups`.
  check("unfiltered it is the whole group", orphansFor(groups, "all").map((r) => r.key), [
    "m_gone/live",
    "m_gone/back",
    "m_gone/done",
  ]);
  check("Active keeps the one the daemon is bringing back", orphansFor(groups, "active").map((r) => r.key), [
    "m_gone/live",
    "m_gone/back",
  ]);
  check("and Ended is only what somebody ended", orphansFor(groups, "ended").map((r) => r.key), ["m_gone/done"]);

  /*
   * The coupling itself, asserted as an equality rather than as two lists that
   * happen to agree today: whatever `orphansFor` returns is exactly the orphan
   * tail of the render order, on every filter. Reverting `visibleRows` to push
   * `groups.orphans` raw fails the Active and Ended arms here.
   */
  check(
    "the render order carries that same list, on every filter",
    (["all", "active", "ended"] as const).map((filter) =>
      visibleRows(groups, { filter, machine: null, all: false, query: "" })
        .map((r: { key: string }) => r.key)
        .join(","),
    ),
    (["all", "active", "ended"] as const).map((filter) => orphansFor(groups, filter).map((r) => r.key).join(",")),
  );

  /*
   * And the half that lives in JSX, read off disk.
   *
   * A component cannot be rendered here — there is no DOM and no React — but the
   * question this fix turns on is not what the rail *paints*, it is **which array
   * it reads**, and that is a fact about the source. The same argument the cpctl
   * extraction at the foot of this file makes: comparing behaviour where that is
   * possible, and the one line that decides it where it is not. Reverting
   * `SessionBrowser` to `groups.orphans` fails the second of these.
   */
  const browser = readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8");
  check("the rail's orphan section goes through the helper", /\borphansFor\(groups, filter\)/.test(browser), true);
  check("and never reaches past it to the raw group", /groups\.orphans/.test(browser), false);
  check("the rail's pinned section goes through the helper too", /\bpinnedFor\(groups, filter\)/.test(browser), true);
  check("and never reaches past that one either", /groups\.pinned/.test(browser), false);

  /*
   * **And both go through the needle, which the assertions above cannot see.**
   *
   * Everything above pins the *filter* half and was written when the filter was
   * the only axis. The search box is a second one, and it reopened the identical
   * hole: `visibleRows` pushes `matching(pinnedFor(…), query)` while the rail drew
   * the raw slice, so four letters typed into the box painted rows that the
   * caret's own list did not contain — `findIndex` answering `-1`, `j` jumping to
   * the top of the fleet. The arms above all run `query: ""`, where `matching`
   * early-returns, so every one of them passes either way.
   *
   * Two halves for the same reason as the pair above: the render order compared
   * against the helpers under a needle that actually excludes something, and the
   * one line of JSX that decides which array is painted.
   */
  const needled = { filter: "all", machine: null, all: false, query: "web" } as const;
  check(
    "under a needle the render order still carries exactly the helper's rows",
    visibleRows(groups, needled)
      .map((r: { key: string }) => r.key)
      .filter((key: string) => orphansFor(groups, "all").some((r) => r.key === key))
      .join(","),
    matching(orphansFor(groups, "all"), "web")
      .map((r) => r.key)
      .join(","),
  );
  check(
    "and the rail applies it at both call sites",
    [/matching\(pinnedFor\(groups, filter\), view\.query\)/.test(browser), /matching\(orphansFor\(groups, filter\), view\.query\)/.test(browser)],
    [true, true],
  );
}

/* ------------------------------------------------------------------ *
 * What a session is called
 * ------------------------------------------------------------------ */

process.stdout.write("\nsession labels\n");
{
  const labelOf = (title: unknown) =>
    sessionLabel({
      snapshot: { title, workspace: { requestedCwd: "/home/u/work/proj" } },
    } as never);

  check("a name wins", labelOf("Fix the reconnect"), "Fix the reconnect");
  // `undefined` is an older daemon and `null` is "nobody has named it". Both mean
  // the same thing to a reader, so both fall back rather than being told apart.
  check("an unnamed session falls back to its path", labelOf(null), "…/work/proj");
  check("and so does one from a daemon that has no titles", labelOf(undefined), "…/work/proj");
  // A whitespace-only title would otherwise render as a blank row, which is worse
  // than a path — hence trimmed rather than merely null-checked.
  check("a whitespace-only name falls back too", labelOf("   "), "…/work/proj");
  check("the result is always a plain string", typeof labelOf("x"), "string");
}

/* ------------------------------------------------------------------ *
 * The context readout
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe context window\n");
{
  /*
   * Three answers, not two — the same discipline as `Liveness` and `loggedIn`.
   * "Cannot tell" is a distinct answer here: kimi may never send `usage_update`
   * and a restored session has no live agent to ask, so it is a common state.
   * What the readout *does* with it is a separate rule — see `pieTone` below,
   * which draws it in the quietest colour there is rather than as a hole. It used
   * to render as nothing at all, and the hole moved the chips beside it every
   * time an agent started or stopped reporting.
   */
  check("no usage at all is cannot-tell", contextPercent(null), null);
  check("and an older daemon's absent field is the same answer", contextPercent(undefined), null);
  // The one value nothing may divide by. The daemon stores 0 for "the agent
  // reported occupancy but not a window", precisely so this is checkable.
  check("a zero-size window is cannot-tell, not a division", contextPercent({ used: 0, size: 0, cost: null }), null);
  check("a real reading is a whole percent", contextPercent({ used: 190_000, size: 200_000, cost: null }), 95);
  check("rounded, since that is what is drawn", contextPercent({ used: 1234, size: 200_000, cost: null }), 1);
  // Possible across a model switch that shrinks the window. An arc past its own
  // circumference draws as garbage; reading "full" is at least true.
  check("over-full clamps rather than overrunning the arc", contextPercent({ used: 300_000, size: 200_000, cost: null }), 100);
  check("and a nonsense number is cannot-tell", contextPercent({ used: Number.NaN, size: 200_000, cost: null }), null);

  check("token counts are short enough for a chip", [shortCount(940), shortCount(124_000), shortCount(1_250_000)], ["940", "124k", "1.3M"]);
  /*
   * The boundary the unit is chosen at, which was chosen from the *raw* value
   * while the rounding happened after — so a number just under a million rounded
   * up and out of the arm that had already been picked, printing `1000k`.
   *
   * Both sides asserted, because a fix that only moves the boundary would pass
   * one of them: 999,949 must stay in `k`.
   */
  check(
    "and rounding cannot carry a number out of its own unit",
    [shortCount(999_949), shortCount(999_999), shortCount(1_000_000)],
    ["999.9k", "1M", "1M"],
  );
  // The real one, since this is what a codex window is.
  check("a codex context window reads as itself", shortCount(258_400), "258.4k");

  /*
   * The readout is a ring in the strip and a number only inside the popover it
   * opens, so nothing here is a width rule any more — a ring is one width at
   * every percentage. What is left is what the popover *says*.
   */
  check("a reading is the percent and a sign", [pieLabel(0), pieLabel(36), pieLabel(100)], ["0%", "36%", "100%"]);
  // Decided rather than fallen into: an unmeasured window reads `0%` and is told
  // apart by its tone and by the popover's own words, never by the glyph.
  check("cannot-tell reads as zero", pieLabel(null), "0%");
  check("but is not toned like a measurement", pieTone(null), "unknown");
  /*
   * And it says *why*, because the honest answer is agent-specific and the
   * generic one misleads. Measured: `usage_update` is in kimi 0.29.2's bundle
   * once, in the vendored protocol schema, with no site that sends it — so on
   * kimi the readout is empty for the life of every session and "has not said
   * yet" is a promise of a number that is never coming.
   */
  check("kimi is named, because it never reports and never will", contextHint("kimi"), "kimi does not report this — send /usage to ask it");
  // Pointed at the command kimi actually publishes, so the advice is something
  // the `/` menu already offers rather than something invented here.
  check("and pointed at a command that exists", contextHint("kimi").includes("/usage"), true);
  // Anything else gets the neutral form: claude does report, so reaching this at
  // all means a session with no live agent, where no command would help.
  check("every other agent gets the neutral answer", contextHint("claude"), "the agent has not reported this");
  /*
   * Codex belongs in that arm by measurement, not by falling off the end of a
   * ternary.
   *
   * Measured 2026-08-07 against codex-acp 1.1.9: a single prompt produced two
   * `usage_update` notifications carrying `{used: 16730, size: 258400}`. So the
   * number does arrive, "has not reported this" really does mean *yet*, and
   * naming codex the way kimi is named would be the misleading answer here.
   *
   * Asserted because the two agents that do not report and the one that does are
   * indistinguishable from this function's shape — every one of them takes the
   * `else`, and only kimi's is a decision.
   */
  check("codex is in it because it does report, not by default", contextHint("codex"), "the agent has not reported this");
  check("a comfortable window is not a warning", [pieTone(0), pieTone(74)], ["ok", "ok"]);
  check("three quarters is where it starts warning", pieTone(75), "warn");
  check(
    "ninety is where it stops warning and starts shouting",
    [pieTone(89), pieTone(90)],
    ["warn", "critical"],
  );
  check("and full is the loudest it gets", pieTone(100), "critical");
}

/* ------------------------------------------------------------------ *
 * Where "Default" gets its meaning back
 * ------------------------------------------------------------------ */

process.stdout.write("\nconfig prose, recovered from the transcript\n");
{
  /*
   * `snapshotConfig` in `registry.ts` nulls every description before a snapshot
   * goes out — a model list with prose is the large part of a record returned for
   * sixty sessions every four seconds. Its comment ends "The descriptions are
   * still in the transcript for anything that wants them", and this is that thing.
   *
   * It matters because both agents publish a choice named `Default`, which alone
   * says nothing. It is a real value, not a placeholder, so it must not be deleted
   * — what it needs is the description that says which model it resolves to.
   */
  const configEvent = (value: string, description: string) => ({
    seq: 1,
    ts: 0,
    event: {
      type: "agent_config",
      modes: null,
      options: [
        {
          id: "model",
          name: "Model",
          description: "AI model to use",
          category: "model",
          kind: "select",
          value,
          choices: [{ value: "default", name: "Default", description, group: null }],
        },
      ],
    },
  });

  const prose = configProse([configEvent("default", "Opus 5 for most of your limit, then Sonnet 5")] as never);
  check("the choice's description survives in the log", prose.get("model")?.choices.get("default"), "Opus 5 for most of your limit, then Sonnet 5");
  check("and the option's own prose too", prose.get("model")?.description, "AI model to use");

  // Several `agent_config` events accumulate as a session switches model; only the
  // newest describes what is on offer now.
  const newest = configProse([
    configEvent("default", "stale"),
    { ...configEvent("default", "current"), seq: 2 },
  ] as never);
  check("the newest event wins", newest.get("model")?.choices.get("default"), "current");

  // Paged out of the window, or truncated by the per-event cap. Degrade to no
  // description — never to a guess, and never to an exception.
  check("an empty transcript yields nothing rather than throwing", configProse([]).size, 0);
  check("and a transcript with no config event is the same", configProse([{ seq: 1, ts: 0, event: { type: "prompt", text: "hi" } }] as never).size, 0);
}

/* ------------------------------------------------------------------ *
 * What a control's chip actually says
 * ------------------------------------------------------------------ */

process.stdout.write("\nchip labels\n");
{
  /*
   * The literal payloads claude 0.63.0 publishes, copied from a live session.
   *
   * The complaint this answers is "the model says Default and that tells me
   * nothing" — and it is correct: on a session that has never picked a model, the
   * choice's *name* is `Default (recommended)` and only its description says which
   * model that is. The daemon keeps the selected choice's description on the
   * snapshot for exactly this, and the head of it is the concrete answer.
   */
  const opt = (over: Record<string, unknown>) =>
    ({ id: "x", name: "X", description: null, kind: "select", ...over }) as never;

  const modelDefault = opt({
    category: "model",
    value: "default",
    choices: [
      { value: "default", name: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", group: null },
      { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null },
    ],
  });
  // The context length is dropped: it is a property of the *choice*, spelled out
  // in the menu row and its description, and on a chip it is three words competing
  // with the one that matters.
  check("a default model names the model, not the word Default", chipValue(modelDefault), "Opus 5");

  const modelPicked = opt({
    category: "model",
    value: "sonnet",
    choices: [{ value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null }],
  });
  check("and a picked one names it too", chipValue(modelPicked), "Sonnet 5");
  check(
    "a qualifier like \"with 1M context\" is left to the menu",
    chipValue(opt({
      category: "model",
      value: "o",
      choices: [{ value: "o", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null }],
    })),
    "Opus 5",
  );

  // Narrowed to `model` deliberately: for mode the name is the good label and the
  // description is a sentence. Applying the rule everywhere makes every other chip
  // worse in order to fix one.
  const mode = opt({
    category: "mode",
    value: "acceptEdits",
    choices: [{ value: "acceptEdits", name: "Accept Edits", description: "Edits apply without asking", group: null }],
  });
  check("mode keeps its short name over its long sentence", chipValue(mode), "Accept Edits");

  /*
   * A mode named `Default` keeps that name, which is the opposite of what happens
   * to effort's `Default` two checks down — and the difference is whether the
   * agent said anything else about it.
   *
   * Effort has nothing underneath: claude publishes `description: null` for every
   * level, so the name is the only thing there is and it conveys nothing. kimi's
   * mode carries a whole sentence ("Manual approvals; tools execute normally."),
   * so the fix for "Default says nothing" is to show that sentence, not to decide
   * the agent is wrong about the name of its own mode. The caption half is
   * asserted beside `configChoices` in the commands section.
   */
  check(
    "a mode named Default keeps the name the agent gave it",
    chipValue(opt({
      category: "mode",
      value: "default",
      choices: [
        { value: "default", name: "Default", description: "Manual approvals; tools execute normally.", group: null },
      ],
    })),
    "Default",
  );
  check(
    "and one the other agent named differently keeps that",
    chipValue(opt({
      category: "mode",
      value: "default",
      choices: [{ value: "default", name: "Manual", description: null, group: null }],
    })),
    "Manual",
  );

  // Claude's effort choices carry no descriptions at all, so nothing can be
  // resolved and nothing is invented — the agent's own name is used.
  const effort = opt({
    category: "thought_level",
    value: "default",
    choices: [{ value: "default", name: "Default", description: null, group: null }],
  });
  /*
   * Not "Default" — established from claude's own CLI rather than guessed, because
   * the ACP payload carries nothing: `/effort`'s parser maps the unset case to
   * `{value: void 0}` (no effort parameter is sent at all) and the model's
   * behaviour with none sent is "Adaptive thinking on by default (omitting
   * `thinking` runs adaptive)". So the value is the model choosing per turn.
   */
  check("claude's default effort is named for what it is", chipValue(effort), "Adaptive");
  // Narrow on purpose. Kimi's equivalent is `off`, which means something else
  // entirely, and a level that was explicitly picked is already concrete.
  const kimiThinking = opt({
    category: "thought_level",
    value: "off",
    choices: [{ value: "off", name: "Off", description: null, group: null }],
  });
  check("but kimi's own value keeps its own name", chipValue(kimiThinking), "Off");
  const picked = opt({
    category: "thought_level",
    value: "high",
    choices: [{ value: "high", name: "High", description: null, group: null }],
  });
  check("and an explicitly picked level is untouched", chipValue(picked), "High");

  // Degradation, in the two ways it can happen: an older daemon that strips every
  // description, and a description with no separator that is a whole sentence.
  const stripped = opt({
    category: "model",
    value: "default",
    choices: [{ value: "default", name: "Default (recommended)", description: null, group: null }],
  });
  check("a stripped description degrades to the name", chipValue(stripped), "Default (recommended)");
  const wordy = opt({
    category: "model",
    value: "d",
    choices: [{ value: "d", name: "D", description: "a description with no separator that runs on far too long to be a label", group: null }],
  });
  check("and so does prose too long to be a label", chipValue(wordy), "D");
  /*
   * **A description with no separator is not mined at all**, however short.
   *
   * The length guard alone let this through and the chip was wrong on a live
   * agent: codex publishes `gpt-5.6-sol` as name "GPT-5.6-Sol" with description
   * "Latest frontier agentic coding model." — 37 characters, under any ceiling
   * anybody would pick — so the chip read "Latest frontier agentic cod…" while the
   * model's actual name sat unused one field away.
   *
   * The rule this restores is the one the function was written for: mining a
   * description is a *rescue* for claude's "Default (recommended)", and an agent
   * whose name is already the model has nothing to rescue. The head before a `·`
   * is a model name because something follows it; with no separator there is no
   * head, only a sentence.
   */
  const codexModel = opt({
    category: "model",
    value: "gpt-5.6-sol",
    choices: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol", description: "Latest frontier agentic coding model.", group: null }],
  });
  check("a short sentence is still a sentence, not a model name", chipValue(codexModel), "GPT-5.6-Sol");
  // And the claude shape it exists for is untouched: separator present, head kept.
  check("while a description that does separate still names the model", chipValue(modelDefault), "Opus 5");
}

/* ------------------------------------------------------------------ *
 * How long a row has been waiting
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe age of a row, across two clocks\n");
{
  /*
   * The timestamps on a snapshot are the *daemon's* clock, and the phone's is a
   * different one — a device that has slept, or has simply never been right, can
   * be minutes out either way. So the age of a row is anchored to the daemon's own
   * clock at fetch time and extended by our own elapsed time since, which is wrong
   * by at most the age of the row rather than by the whole drift.
   *
   * This is asserted rather than looked at because both wrong answers are
   * plausible on screen: a naive `Date.now() - at` reads "waiting for 0s" on a
   * phone that is behind, and a *negative* duration on one that is ahead — under
   * "blocked", which is the row somebody is deciding whether to walk over to.
   */
  const row = { daemonNow: 11_000, fetchedAt: 1_000 } as never;
  // The daemon said 11_000 when our own clock said 1_000, so it is 10s ahead. The
  // permission was raised at daemon-time 9_000, i.e. 2s before the fetch, and we
  // are asking 3s after it.
  check("an age is measured in the daemon's clock and extended in ours", elapsedSince(row, 9_000, 4_000), 5_000);
  check("and does not drift when only our own clock moves on", elapsedSince(row, 9_000, 64_000), 65_000);
  // The failure this shape exists to prevent, stated as the arithmetic somebody
  // would otherwise write.
  report(
    "while subtracting from our own clock would report a negative age",
    4_000 - 9_000 < 0,
    "daemon 10s ahead → -5s waiting",
  );
  check("a row fetched and read at the same instant is as old as the daemon said", elapsedSince(row, 11_000, 1_000), 0);
}

/* ------------------------------------------------------------------ *
 * The login poll cursor
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe login transcript cursor\n");
{
  /*
   * The wizard polls `GET /agent-auth/login/:id?since=<cursor>` and appends
   * whatever comes back, so the arithmetic has to hold across a buffer that
   * drops its front. `dropped` is bytes discarded; `cursor` is the total ever
   * produced. A client that appended `chunk` while advancing by `chunk.length`
   * instead of assigning `page.cursor` would silently desynchronize the moment
   * anything was dropped, and a login transcript is exactly where a lost line is
   * the one with the code in it.
   */
  /*
   * A **model** of the daemon's arithmetic, and labelled as one.
   *
   * This used to read as though it guarded the server, which it never could: it
   * is a transcription of `readFrom` in `src/agentauth.ts`, and a transcription
   * stays green when the original is deleted. The daemon side is asserted against
   * the real function in `pnpm daemoncheck`, which can import it — this package
   * cannot, for the same module-resolution reason `wire.ts` is hand-mirrored.
   *
   * What *this* section is for is the client's own rule, which is genuinely
   * client-side: a client must assign `page.cursor` rather than advance by
   * `chunk.length`, or it desynchronizes the moment anything is dropped. The model
   * exists to generate the pages that rule is exercised against.
   */
  const read = (buffer: string, dropped: number, since: number) => {
    const from = Math.max(since, dropped);
    return { chunk: buffer.slice(from - dropped), cursor: dropped + buffer.length, gap: since < dropped };
  };

  check("a fresh read returns everything", read("open https://x", 0, 0).chunk, "open https://x");
  check("and reports the cursor as the total produced", read("open https://x", 0, 0).cursor, 14);
  check("a second read from that cursor returns nothing new", read("open https://x", 0, 14).chunk, "");
  // After the cap trims the front, an old cursor is behind the window.
  check("a cursor behind the discarded prefix is a gap", read("tail", 100, 40).gap, true);
  check("and reads from the start of what is left", read("tail", 100, 40).chunk, "tail");
  check("a cursor inside the window is not a gap", read("tail", 100, 102).gap, false);
  check("and reads only what follows it", read("tail", 100, 102).chunk, "il");
}

/* ------------------------------------------------------------------ *
 * One tool call is five events
 * ------------------------------------------------------------------ */

/**
 * Every row a reader can reach, with folded runs opened out.
 *
 * `buildTail` collapses a run of consecutive tool rows into one `group`, so a bare
 * `rows.map(r => r.key)` stopped describing what is *drawn* and started describing
 * how it is packaged. The assertions below are about the cut, the gaps and the
 * parenting — none of them is about folding, and each keeps its original claim by
 * reading through a group rather than being rewritten around one.
 *
 * Folding gets its own section, further down, where the packaging is the subject.
 */
type BuiltRows = Parameters<typeof foldRuns>[0];
const drawn = (rows: BuiltRows): string[] =>
  rows.flatMap((row) => (row.kind === "group" ? row.children.map((child) => child.key) : [row.key]));

process.stdout.write("\nthe tail is built backwards\n");
{
  let seq = 0;
  const txt = (text: string, role = "agent", thought = false): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event: { type: "text", role, thought, text } }) as never;
  const call = (id: string): never =>
    ({
      seq: (seq += 1),
      ts: seq * 1000,
      event: { type: "tool_call", toolCallId: id, title: id, kind: "other", status: "pending", locations: [], rawInput: null, parentToolCallId: null },
    }) as never;

  {
    seq = 0;
    const tail = buildTail([txt("he"), txt("llo"), txt(" there")], []);
    check("consecutive chunks with the same role are one run", tail.rows.length, 1);
    check("joined in document order", (tail.rows[0] as { text: string }).text, "hello there");
    // Keyed by the last, a streaming message remounts on every arriving token —
    // which shuts any card the reader had opened inside it.
    check("and keyed by its first event, not its last", tail.rows[0]?.key, "t1");
  }

  {
    seq = 0;
    const tail = buildTail([txt("mine", "user"), txt("theirs", "agent")], []);
    check("a change of role starts a new run", tail.rows.map((r) => r.key), ["t1", "t2"]);
  }

  /*
   * An image the tool returned reaches the card — driven from a real event
   * through `buildTail`, not handed straight to `mergeUpdates`.
   *
   * That distinction is the whole point of this case. `mergeUpdates` was asserted
   * and passed while nothing rendered, because `buildTail` **rebuilds** each
   * update field by field and simply did not name `images` — so the merge was
   * correct about a record that never carried the data. A test that starts below
   * the construction site cannot see a construction site that drops a field.
   */
  {
    seq = 0;
    const shot = { uploadId: "a_1", name: "image-a1.png", mime: "image/png", bytes: 4096 };
    const withImage = (id: string): never =>
      ({
        seq: (seq += 1),
        ts: seq * 1000,
        event: {
          type: "tool_call_update",
          toolCallId: id,
          title: null,
          status: "completed",
          locations: [],
          rawInput: null,
          content: null,
          images: [shot],
          parentToolCallId: null,
        },
      }) as never;
    const tail = buildTail([call("c1"), withImage("c1")], []);
    const node = tail.rows[0] as { kind: string; images: readonly unknown[] };
    check("a tool card is what comes out", node.kind, "tool");
    check("and it carries the image the tool returned", node.images, [shot]);
  }

  {
    // An older daemon sends no such field and dropped the bytes entirely. It must
    // read as "no images", never as undefined reaching the renderer.
    seq = 0;
    const bare = (id: string): never =>
      ({
        seq: (seq += 1),
        ts: seq * 1000,
        event: { type: "tool_call_update", toolCallId: id, title: null, status: "completed", locations: [], rawInput: null, content: ["done"], parentToolCallId: null },
      }) as never;
    const tail = buildTail([call("c2"), bare("c2")], []);
    check("a daemon that sends none yields an empty list", (tail.rows[0] as { images: readonly unknown[] }).images, []);
  }

  {
    /*
     * A thought is dropped outright — see `showsInTranscript`. It used to draw a
     * collapsed `thinking …` card, several per turn, between the messages
     * somebody is actually reading; what it was there to say is the one
     * `working…` row at the foot of the transcript.
     */
    seq = 0;
    const tail = buildTail([txt("thinking", "agent", true), txt("saying", "agent", false)], []);
    check("a thought draws nothing at all", tail.rows.map((r) => r.key), ["t2"]);
    // Optional, unlike most of the `rows[0]` reads in this file, because the
    // regression the line above exists to catch is exactly the one that empties
    // `rows` — and a throw here would take the four new sections below it with
    // it, which is the crash-truncation failure CLAUDE.md records at length.
    check("and the speech beside it is untouched", (tail.rows[0] as { text?: string } | undefined)?.text, "saying");
  }

  {
    /*
     * The reason a dropped thought still *flushes* the run. Parts are joined with
     * no separator, so merging the speech either side of it would produce
     * "before.after" — a sentence run into the next one, which is worse than the
     * card that was removed.
     */
    seq = 0;
    const tail = buildTail(
      [txt("before.", "agent", false), txt("reasoning", "agent", true), txt("after.", "agent", false)],
      [],
    );
    check("speech either side of a thought stays two runs", tail.rows.map((r) => r.key), ["t1", "t3"]);
    check(
      "rather than being run together",
      tail.rows.map((r) => (r as { text: string }).text),
      ["before.", "after."],
    );
  }

  {
    /*
     * The order *inside* a run, which is a `push` and one `reverse()` in `flush`
     * rather than an `unshift` per chunk.
     *
     * That is a performance change with a correctness edge: the walk is
     * backwards, so deleting the `reverse()` renders every agent message
     * backwards — silently, and looking exactly like something the agent said.
     * Nothing about the row count or the keys moves, so the assertions above
     * would all stay green.
     *
     * Four chunks rather than two, because a two-chunk run reversed is still a
     * two-chunk run and only the text tells them apart; and then the same claim
     * on *each side of a dropped thought*, because that is the one path where a
     * run is flushed mid-walk and the surviving fixture had a single chunk on
     * either side — which cannot see an ordering at all.
     */
    seq = 0;
    check(
      "a four-chunk run joins in document order",
      (buildTail([txt("one "), txt("two "), txt("three "), txt("four")], []).rows[0] as { text: string }).text,
      "one two three four",
    );

    seq = 0;
    const split = buildTail(
      [txt("a1 "), txt("a2 "), txt("mm", "agent", true), txt("b1 "), txt("b2")],
      [],
    );
    check(
      "and so does each side of a thought that flushed it",
      split.rows.map((r) => (r as { text: string }).text),
      ["a1 a2 ", "b1 b2"],
    );
  }

  {
    // And a dropped thought draws nothing at all, which is the same claim the
    // suppressed events make one section down.
    seq = 0;
    const tail = buildTail([txt("t1", "agent", true), txt("t2", "agent", true), txt("a"), txt("b", "user")], []);
    check("a thought draws no row", tail.rows.map((r) => r.key), ["t3", "t4"]);
  }

  /*
   * The cut, which is what a render budget used to be.
   *
   * `buildTail`'s third argument was "how many nodes to draw" and is now "the
   * lowest seq to draw" — the seq of the newest `context_cleared`, because the
   * only boundary in a transcript that means anything to a reader is the one the
   * agent was told to make. Everything at or above it is drawn, however much
   * there is.
   *
   * These cases carry over from the budget with the numbers reinterpreted, and
   * they are worth keeping *because* they carry over: `hidden` counting events
   * rather than rows is the same claim under either rule, and it is the one that
   * decides whether the button's number matches what a tap reveals.
   */
  {
    seq = 0;
    const tail = buildTail([txt("a"), txt("b"), txt("c")], [], 2);
    // A run is built from the events at or above the cut and no others. It cannot
    // straddle the boundary in practice — the `context_cleared` marker sitting on
    // it is not text, so it flushes the run — but a cut landing mid-run must still
    // produce a whole run from what survives rather than an empty one.
    check("a run is built from everything at or above the cut", (tail.rows[0] as { text: string }).text, "bc");
    check("and what is below it is counted", tail.hidden, 1);
  }

  {
    seq = 0;
    const tail = buildTail([call("a"), call("b"), call("c")], [], 2);
    check("only what is at or above the cut is drawn", drawn(tail.rows), ["e2", "e3"]);

    // Three text events below the cut would coalesce to *one* row, so this is the
    // fixture that can tell the two definitions apart — the tool-call one above
    // cannot, since there one excluded event is also exactly one row.
    seq = 0;
    check(
      "and `hidden` counts events, not rows",
      buildTail([txt("a"), txt("b"), txt("c"), call("d")], [], 4).hidden,
      3,
    );
  }

  {
    seq = 0;
    check("with no cut nothing is hidden at all", buildTail([call("a"), call("b")], []).hidden, 0);
  }

  {
    seq = 0;
    const events = [call("a"), call("b"), call("c")];
    const tail = buildTail(events, [{ from: 3, to: 4, reason: "evicted" } as never]);
    check(
      "a gap inside the window sorts just before the event it precedes",
      drawn(tail.rows),
      ["e1", "e2", "g3", "e3"],
    );
  }

  {
    // One below the cut belongs to the conversation that was cleared; reporting a
    // hole in a transcript nobody is being shown is noise about something that is
    // not on screen.
    seq = 0;
    const tail = buildTail(
      [call("a"), call("b"), call("c"), call("d")],
      [{ from: 2, to: 2, reason: "evicted" } as never],
      3,
    );
    check("and one below it is not drawn", drawn(tail.rows), ["e3", "e4"]);
  }
}

process.stdout.write("\none tool call is five events\n");
{
  // The table in CLAUDE.md's gotchas, which nothing asserted until `tail.ts`
  // existed to be asserted. Measured 2026-07-31 against claude 0.63.0: a single
  // `echo` produces a call plus four updates, and every field a person wants is
  // on a different one of them.
  const upd = (
    over: Partial<Parameters<typeof mergeUpdates>[0][number]>,
  ): Parameters<typeof mergeUpdates>[0][number] => ({
    ts: 0,
    status: null,
    title: null,
    rawInput: null,
    locations: [],
    content: null,
    ...over,
  });

  const merged = mergeUpdates([
    upd({ ts: 1, title: "echo hi-there", rawInput: { command: "echo hi-there" } }),
    upd({ ts: 2, title: "echo hi-there", rawInput: { command: "echo hi-there", description: "Echo" }, content: ["Echo hi-there"] }),
    upd({ ts: 3 }),
    upd({ ts: 4, status: "completed", content: ["```console\nhi-there\n```"] }),
  ]);

  const call = { title: "Terminal", kind: "execute" as const, status: "pending" as const, rawInput: {}, locations: [] };
  const drawn = resolveTool(call, merged);

  // Keeping only the newest update loses the command *and* the description.
  check("the update's title beats the call's", drawn.title, "echo hi-there");
  // Preferring the call's own arguments gets `{}` for ever, because an empty
  // object is not null.
  check("and a later update's arguments beat an empty call's", drawn.rawInput, {
    command: "echo hi-there",
    description: "Echo",
  });
  // Keeping only the first update loses the output. "Every content block" is no
  // longer the rule — a block that is a draft of the next, or the arguments
  // restated, is dropped; see the streaming case below. What survives is every
  // block that says something of its own, in document order.
  check("each content block that says something of its own is kept, in order", drawn.output, [
    "Echo hi-there",
    "```console\nhi-there\n```",
  ]);
  check("the newest status wins", drawn.status, "completed");
  check(
    "a call with no updates at all is drawn from itself",
    resolveTool({ ...call, title: "Terminal", rawInput: { command: "x" } }, null).title,
    "Terminal",
  );

  /*
   * ⭐ **An agent that refines its arguments rather than filling them in once.**
   *
   * Measured 2026-08-13, from the daemon's own log — codex's web search, verbatim.
   * The `tool_call` arrives with the shape below: four keys, so `hasInput` is
   * true, so the old rule ("the call wins whenever it has anything") kept it and
   * threw away the update that put the query *in* it. The card drew `"query": ""`
   * under a title reading `Web search: red mullet…` — because `title` is
   * newest-wins one line above and the arguments were not.
   *
   * The empty-call case above still has to hold at the same time: claude sends
   * `{}` there, so a plain `??` picks the empty object and no command ever
   * appears. Both directions, or this is a fix that swaps which agent is broken.
   */
  const refined = resolveTool(
    { ...call, title: "Web search", rawInput: { type: "webSearch", id: "exec-2810", query: "", action: null } },
    mergeUpdates([
      upd({ ts: 1, status: "completed", title: "Web search: red mullet", rawInput: { type: "webSearch", id: "exec-2810", query: "red mullet", action: null } }),
    ]),
  );
  check("a refined set of arguments beats the call's own placeholders", refined.rawInput, {
    type: "webSearch",
    id: "exec-2810",
    query: "red mullet",
    action: null,
  });
  // The pair that was visibly inconsistent on screen: same record, same rule.
  check("so the arguments and the title agree", refined.title, "Web search: red mullet");

  /*
   * ⭐ **And then it opened to the string it was already showing.**
   *
   * `query` is in `COMMAND_FIELDS`, so `toolSummary` answers the *same string* as
   * both `summary` and `detail` — which is true of every tool whose arguments
   * yield a command, not of web search in particular. That call carries no content
   * block at all, no locations and no children, so `detail !== null` was the only
   * thing making it openable, and what it opened to was the 66 characters the row
   * had already drawn in full. Worse than nothing: the agent's `title` lists all
   * three of its queries, while `rawInput.query` is codex's own truncated copy of
   * the first, so the body said strictly less than the heading.
   *
   * The clip is what keeps the useful case, and it is a number this file owns
   * rather than a CSS ellipsis nothing can ask about.
   */
  const shortQuery = "red mullet fish Mullus barbatus description distribution feeding ...";
  check("a card that would open to the row's own text does not open", opensToAnything({
    detail: shortQuery,
    headline: shortQuery,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 0,
  }), false);
  // The same shape, past the clip: the row shows 120 characters and the body has
  // more to give, so the disclosure is worth having.
  const longCommand = "x".repeat(SUMMARY_CHARS + 1);
  check("but one the row had to cut short does", opensToAnything({
    detail: longCommand,
    headline: longCommand,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 0,
  }), true);
  check("and so does anything the row is not showing at all", [
    // A subagent's row carries a duration where the detail is the command.
    opensToAnything({ detail: "npm test", headline: "1.2s", outputBlocks: 0, locations: 0, children: 0, changes: 0, titleClipped: false }),
    // Output, locations and children are each a reason on their own, whatever the
    // arguments say — this is the arm that keeps a finished `Bash` openable.
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 1, locations: 0, children: 0, changes: 0, titleClipped: false }),
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 0, locations: 1, children: 0, changes: 0, titleClipped: false }),
    opensToAnything({ detail: shortQuery, headline: shortQuery, outputBlocks: 0, locations: 0, children: 1, changes: 0, titleClipped: false }),
  ], [true, true, true, true]);
  /*
   * ⭐ **And a `Write` opens on its change alone, which is the term that had to be
   * added rather than inferred.**
   *
   * `readInput` suppresses the pretty-printed arguments the moment it finds a body
   * field — `content`, `new_string`, `text` — so for the two tools that actually
   * change a file, `detail` is `null`. With no locations either, every other term
   * here is zero, so the card whose whole point is the file it just wrote was the
   * one card in the transcript that could not be opened, and the diff had nowhere
   * to go.
   */
  check("a call that changed a file opens on that alone", opensToAnything({
    detail: null,
    headline: null,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 1,
  }), true);
  check("a call with nothing at all stays shut", opensToAnything({
    detail: null,
    headline: null,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    titleClipped: false,
    changes: 0,
  }), false);
  /*
   * ⭐ **The same rule the body has to ask, which is why it is a function.**
   *
   * A card openable for its *output* still drew the arguments underneath a row that
   * was already showing them — one command, twice, one line apart. Invisible while a
   * card had a frame around both; obvious the moment it did not. So the chevron and
   * the block ask one predicate rather than two expressions that agreed by accident.
   */
  /*
   * ⭐ **Web search opens again, and the term that brings it back is the title.**
   *
   * Its title is the list of queries codex ran — measured at ~100 characters — while
   * `rawInput.query` is codex's truncated copy of the *first* one. So every other term
   * was zero and the card correctly refused to open, onto a body that would have said
   * less than the row. Clipping the title in **code** rather than in CSS is what makes
   * "was anything cut off" answerable at all, which is the same reason `SUMMARY_CHARS`
   * lives in `tail.ts`; the body then opens to the whole of it.
   */
  const queries =
    "Web search: red mullet fish Mullus barbatus description distribution feeding, Mullus barbatus FAO species fact sheet, red mullet Black Sea official source";
  check("a title too long for its row is clipped, and says so", [
    clipTitle(queries).clipped,
    clipTitle(queries).text.length,
    clipTitle("Bash").clipped,
    clipTitle("Bash").text,
  ], [true, TITLE_CHARS + 1, false, "Bash"]);
  /*
   * **A flat threshold was wrong and the log is what said so.** Every drawn title in
   * the database: median 41, max 161, tail 82 · 82 · 87 · 148 · 161. Clipping at 80
   * alone cut three of them by 2 to 7 characters — a whole extra line to reveal a word
   * — so the cut has to be worth the line, and `TITLE_OVERFLOW_MIN` is what makes it
   * fire on the two real payloads and none of the near misses.
   */
  check("a near miss is left whole rather than costing a line", [
    clipTitle("x".repeat(TITLE_CHARS + 1)).clipped,
    clipTitle("x".repeat(TITLE_CHARS + TITLE_OVERFLOW_MIN)).clipped,
    clipTitle("x".repeat(TITLE_CHARS + TITLE_OVERFLOW_MIN + 1)).clipped,
  ], [false, false, true]);

  /*
   * ⭐ **The value beside the title, and the three shapes in which it is an echo.**
   *
   * Exact equality was the rule, from codex naming a `Bash` call after its command. The
   * log has two more where the strings differ and the second copy is still worth
   * nothing: a `Read file '<path>'` beside the bare path, and a web search beside
   * codex's **truncated** copy of its first query — which carries a literal ` ...`, so a
   * containment test on the whole string fails. Hence a prefix.
   *
   * The strings below keep the shape of the ones measured in `~/.reemoat/reemoat.db`,
   * with the home directory genericised: what matters is that the title wraps the
   * path in `Read file '…'` rather than which path it was.
   */
  const readTitle = "Read file '/Users/u/.codex/skills/.system/openai-docs/SKILL.md'";
  const readPath = "/Users/u/.codex/skills/.system/openai-docs/SKILL.md";
  const truncatedQuery = "red mullet fish Mullus barbatus description distribution feeding ...";
  check("an echo of the title is not drawn beside it", [
    headlineWorthDrawing(readTitle, readPath),
    headlineWorthDrawing(queries, truncatedQuery),
    headlineWorthDrawing("node /a/b/c.mjs", "node /a/b/c.mjs"),
    headlineWorthDrawing("Bash", null),
  ], [false, false, false, false]);
  check("and a headline that says something new is", [
    headlineWorthDrawing("Bash", "npm test"),
    headlineWorthDrawing("Edit", "/w/a.ts"),
    headlineWorthDrawing("Task", "1.2s"),
  ], [true, true, true]);
  check("and that alone makes the card open", opensToAnything({
    detail: null,
    headline: null,
    outputBlocks: 0,
    locations: 0,
    children: 0,
    changes: 0,
    titleClipped: true,
  }), true);

  check("the arguments are not drawn when the row has already said them", [
    detailWorthDrawing(shortQuery, shortQuery),
    detailWorthDrawing(longCommand, longCommand),
    detailWorthDrawing("npm test", "1.2s"),
    detailWorthDrawing(null, null),
  ], [false, true, true, false]);

  // Measured 2026-08-01: 4/10 and 5/14 of a child's updates omit the parent even
  // though its call carried one. Read as "top level", half of every subagent's
  // steps scatter back into the transcript, intermittently.
  check(
    "an update that omits the parent does not erase one that named it",
    mergeUpdates([
      upd({ ts: 1, parentToolCallId: "toolu_parent" }),
      upd({ ts: 2, parentToolCallId: null }),
    ]).parentToolCallId,
    "toolu_parent",
  );

  /*
   * ⭐ **The model types its arguments into the output channel, one token at a
   * time, and "every content block concatenated" drew all of them.**
   *
   * Measured against the daemon's own database on 2026-08-13. One `Write` call:
   * a `tool_call`, then **715 updates** whose single content block grew from `{`
   * to the finished input JSON, then the same JSON once more beside the
   * `rawInput` it belongs to, then the one line that is actually a result. The
   * card drew 717 blocks. Across every session on that machine those superseded
   * blocks are 15.4% of all events and **55.8% of all bytes**, and folding every
   * call in the database through this function takes 2332 content blocks to 68.
   *
   * The shape below is that call, shortened. Both rules are needed and they catch
   * different things: `supersedes` cannot see the compact restatement (it is not
   * an extension of the pretty-printed one), and `restatesInput` cannot run
   * inside the fold (the pretty-printed copy arrives *before* the `rawInput` it
   * restates).
   */
  const streamed = mergeUpdates([
    upd({ ts: 1, content: ["{"] }),
    upd({ ts: 2, content: ['{"path": "a.py"'] }),
    upd({ ts: 3, content: ['{"path": "a.py", "content": "x"}'] }),
    upd({ ts: 4, title: "Writing a.py", rawInput: { path: "a.py", content: "x" }, content: ['{"path":"a.py","content":"x"}'] }),
    upd({ ts: 5, status: "completed", content: ["Wrote 1 byte to a.py"] }),
  ]);
  check("a streamed call draws its result and nothing else", streamed.content, ["Wrote 1 byte to a.py"]);
  check("and still knows what it was called with", streamed.rawInput, { path: "a.py", content: "x" });

  /*
   * The two rules, each on its own, because the failure of either is invisible in
   * the composite above — it would simply draw one extra copy of the arguments.
   */
  check("a block that extends the last supersedes it", supersedes('{"a": 1', "{"), true);
  check("one that merely repeats it does not", supersedes("{", "{"), false);
  check("nor does an unrelated one", supersedes("Wrote 1 byte", "{"), false);
  /*
   * A **strict** extension only. A tool that prints the same line twice has
   * printed it twice, and collapsing that would be this client editing output
   * rather than declining to draw a draft of it.
   */
  check("so an exact repeat is left standing", mergeUpdates([
    upd({ ts: 1, content: ["same"] }),
    upd({ ts: 2, content: ["same"] }),
  ]).content, ["same", "same"]);

  check("the arguments, compact, are not a result", restatesInput('{"a":1}', { a: 1 }), true);
  // The one the byte test misses, and the reason this parses rather than compares.
  check("nor are they pretty-printed", restatesInput('{"a": 1}', { a: 1 }), true);
  check("a different object is a result", restatesInput('{"a":2}', { a: 1 }), false);
  check("and so is anything that is not JSON", restatesInput("Wrote 1 byte to a.py", { a: 1 }), false);
  /*
   * The guard that keeps `JSON.parse` off every tool result ever produced:
   * `buildTail` re-folds every call on every streamed event, so a block that does
   * not even begin the way the serialization begins must cost nothing.
   */
  check("a call with no arguments restates nothing", restatesInput("{}", null), false);
}

/* ------------------------------------------------------------------ *
 * A subagent's work, under the tool call that started it
 * ------------------------------------------------------------------ */

process.stdout.write("\na subagent's work, under the tool call that started it\n");
{
  let seq = 0;
  const ev = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const toolCall = (id: string, title: string, parent: string | null = null): never =>
    ev({ type: "tool_call", toolCallId: id, title, kind: "other", status: "pending", locations: [], rawInput: null, parentToolCallId: parent });
  const done = (id: string, parent: string | null = null): never =>
    ev({ type: "tool_call_update", toolCallId: id, title: null, status: "completed", locations: [], rawInput: null, content: null, parentToolCallId: parent });
  const failed = (id: string, parent: string | null = null): never =>
    ev({ type: "tool_call_update", toolCallId: id, title: "boom", status: "failed", locations: [], rawInput: null, content: null, parentToolCallId: parent });

  {
    seq = 0;
    const tail = buildTail(
      [toolCall("task", "Explore the auth code"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")],
      [],
    );
    check("a child is placed under its parent and not in the transcript", tail.rows.map((r) => r.key), ["e1"]);
    const task = tail.rows[0] as { children: { key: string }[]; steps: number; latest: string | null };
    // Placed by a backwards walk, a subagent would read bottom-up and every step
    // would lie about what followed what.
    check("children keep document order under their parent", task.children.map((c) => c.key), ["e2", "e3"]);
    check("steps counts them", task.steps, 2);
    check("and the newest is what a running header shows", task.latest, "read");
  }

  {
    /*
     * ⭐ **What the conversation is waiting on, which the snapshot cannot say.**
     *
     * `showsWorking` reads `session.turn`, and `turn` is cleared the moment the turn
     * ends — while the delegations somebody is waiting on are events in the log and
     * outlive it. That gap is where a conversation reads as finished while the agent
     * is still going, which is the defect this line exists for.
     *
     * ⚠ `pending` has to count. Measured on a live log, a Task spawn arrives
     * `pending` and goes straight to `completed` 13–14 seconds later with no
     * `in_progress` update in between — so a predicate keyed on `in_progress` alone
     * answers 0 for the entire life of every delegation there is.
     */
    seq = 0;
    const running = buildTail([toolCall("task", "Explore the auth code"), toolCall("c1", "grep", "task")], []);
    const waiting = outstandingTasks(running.rows);
    check("a spawn nobody has finished is what we are waiting for", waiting.map((t) => t.title), ["Explore the auth code"]);
    check("and it carries what it last did, for the opened list", [waiting[0]?.steps, waiting[0]?.latest], [1, "grep"]);

    seq = 0;
    const finished = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), done("task")],
      [],
    );
    check("a spawn that reported finishing is not", outstandingTasks(finished.rows).length, 0);

    /*
     * Counted, therefore not descended into. Nested delegation is measured to be
     * flat — every call comes back parented to the outermost spawn — so "a task
     * inside a task" is one thing you are waiting on, and `2 tasks` has to mean two.
     */
    seq = 0;
    const nested = buildTail(
      [toolCall("outer", "Outer"), toolCall("inner", "Inner", "outer"), toolCall("leaf", "leaf", "inner")],
      [],
    );
    check("a delegation inside a delegation is one thing to wait for", outstandingTasks(nested.rows).length, 1);

    // An ordinary tool call is not a task, however long it runs: this line says
    // "waiting for N tasks", and a `grep` is not one.
    seq = 0;
    const plain = buildTail([toolCall("a", "grep")], []);
    check("an ordinary call is not a task", outstandingTasks(plain.rows).length, 0);

    // The two predicates the fold and this count now share, which is what keeps them
    // structurally disjoint — a delegation never folds into a group.
    const node = (over: Record<string, unknown>) =>
      ({ kind: "tool", status: "completed", subagent: false, steps: 0, ...over }) as never;
    check("still-running is pending or in_progress and nothing else", [
      stillRunning(node({ status: "pending" })),
      stillRunning(node({ status: "in_progress" })),
      stillRunning(node({ status: "completed" })),
      stillRunning(node({ status: "failed" })),
    ], [true, true, false, false]);
    check("a delegation is one the agent declared, or one that started work", [
      isDelegation(node({ subagent: true })),
      isDelegation(node({ steps: 3 })),
      isDelegation(node({})),
    ], [true, true, false]);

    /*
     * A finished delegation is descended into, which is the one rule of the four
     * whose deletion the assertions above all survive: `outer` completing while
     * `inner` runs answers 1 either way, because the *outer* one is what the other
     * fixtures count. It needs a child that is itself a delegation.
     */
    seq = 0;
    /*
     * `subagent: true` rather than a child of its own, because `MAX_DEPTH` is 2:
     * a grandchild is re-pointed onto the outermost spawn, so an inner call cannot
     * earn `steps > 0` and the agent's own flag is the only way to say this one is
     * a delegation. Which is the case that matters anyway — claude drops the flag
     * on the spawn's completing update, so an inner spawn declaring itself is
     * exactly the shape here.
     */
    const sub = (id: string, title: string, parent: string): never =>
      ev({ type: "tool_call", toolCallId: id, title, kind: "other", status: "pending", locations: [], rawInput: null, parentToolCallId: parent, subagent: true });
    const stale = buildTail(
      [toolCall("outer", "Outer"), sub("inner", "Inner", "outer"), toolCall("leaf", "grep", "outer"), done("outer")],
      [],
    );
    check(
      "a child still running under a parent that reported finishing is still a wait",
      outstandingTasks(stale.rows).map((t) => t.title),
      ["Inner"],
    );
  }

  {
    /*
     * ⭐ **A delegation a dead agent left `pending`, which is permanent and which
     * no fact about `status` can see.**
     *
     * `mayStillReport` excludes the terminal statuses on the ground that an
     * interrupted turn is never re-sent — true, and it closes only the arm that
     * resolves itself. Auto-resume takes the session back *out* of terminal: it
     * returns `idle`, holding the same conversation and the same rows, so every
     * clause of that predicate reads true again and the foot drew `waiting for 1
     * task` with a pulsing dot for the rest of the session's life, on every
     * session that was mid-delegation when `deploy.sh` ran, surviving reloads
     * because it is derived from a log that persists.
     *
     * `taskFloor` is the half that can see it, and it is a fact about the
     * transcript: below the newest `session_started` is a different agent process.
     */
    seq = 0;
    // Only `type` is read — `session_started` draws nothing (`TRANSCRIPT_SILENT`),
    // and the floor is the one thing anything asks it.
    const started = (): never => ev({ type: "session_started" });
    const restarted = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), started()],
      [],
    );
    check("a restart puts a floor under the transcript", restarted.taskFloor, 3);
    check(
      "and a spawn the previous agent left running is not still a wait",
      outstandingTasks(restarted.rows, restarted.taskFloor).length,
      0,
    );
    // The half that would have hidden the defect: without the floor it is still 1,
    // which is what shipped and what a reader saw for ever.
    check("which is exactly what the ungated walk answers", outstandingTasks(restarted.rows).length, 1);

    // The same session going on to delegate again: the new spawn is above the
    // floor, so a restart does not silence the line for good either.
    seq = 0;
    const after = buildTail(
      [toolCall("old", "Old"), started(), toolCall("new", "New"), toolCall("c1", "grep", "new")],
      [],
    );
    check(
      "a spawn the new agent started is a wait again",
      outstandingTasks(after.rows, after.taskFloor).map((t) => t.title),
      ["New"],
    );

    /*
     * A cancelled turn is the other marker, and the split is on the stop reason
     * rather than on a list of bad ones: `end_turn` is the *only* reason that
     * means the turn finished rather than was abandoned, and a turn finishing
     * while its delegations carry on is the whole state this line draws.
     */
    const ended = (reason: string): never => ev({ type: "turn_end", stopReason: reason, usage: null });
    // A step, so the spawn is a delegation at all: `isDelegation` is the agent's
    // own flag *or* `steps > 0`, and a childless untagged call is neither.
    const spawn = (): never[] => [toolCall("task", "Explore"), toolCall("c1", "grep", "task")];
    seq = 0;
    const cancelled = buildTail([...spawn(), ended("cancelled")], []);
    check(
      "a cancelled turn abandons what it started",
      outstandingTasks(cancelled.rows, cancelled.taskFloor).length,
      0,
    );
    seq = 0;
    const finishedTurn = buildTail([...spawn(), ended("end_turn")], []);
    check("a turn that simply ended does not", finishedTurn.taskFloor, 0);
    check(
      "so its delegation is still outstanding, which is the point of the line",
      outstandingTasks(finishedTurn.rows, finishedTurn.taskFloor).length,
      1,
    );
    // Unknown reasons cut, deliberately: a wrong cut costs a line nobody sees and
    // a wrong keep costs the permanent false one above.
    seq = 0;
    const unknown = buildTail([...spawn(), ended("max_tokens")], []);
    check("and a reason this client has never heard of cuts", unknown.taskFloor > 0, true);
  }

  {
    /*
     * The snapshot half, which had no assertion at all. Both exclusions are states
     * in which a spawn can never complete, and the pair with `isTerminal` is the
     * one worth pinning: `stopping` is deliberately **not** terminal, so a
     * predicate written as `!isTerminal(...)` alone would draw the line over a
     * session somebody is stopping — which is `canCancelTurn`'s lesson one field
     * over.
     */
    const { mayStillReport } = await import("../src/wire.js");
    const snap = (status: string): never => ({ status, turn: null }) as never;
    check("a turn that ended can still be reported on", mayStillReport(snap("idle")), true);
    check("so can one still running", mayStillReport(snap("running")), true);
    // Deliberate: the ask card is an `absolute` region over the composer and does
    // not collide with the foot, and suppressing would blink the line out and back
    // on every approval.
    check("and a blocked one, deliberately", mayStillReport(snap("blocked")), true);
    check(
      "an ended session is not waiting for anything",
      ["exited", "failed", "interrupted"].map((status) => mayStillReport(snap(status))),
      [false, false, false],
    );
    check("nor is one being stopped", mayStillReport(snap("stopping")), false);
    check("which isTerminal does not say, which is why it is its own clause", isTerminal("stopping"), false);
  }

  {
    /*
     * The foot of the transcript, both renderings from one call.
     *
     * `noticeText`'s lesson applied before it can be re-learned: the visible line and
     * the `role="status"` region were once written separately and gated differently,
     * and the region fell silent in exactly the state the line existed for. A pair
     * from one function cannot disagree.
     */
    const { footSays } = await import("../src/ui/EventList.js");
    check("an idle conversation with nothing outstanding says nothing", footSays(false, 0), null);
    check("a running turn says so", footSays(true, 0), { line: "working…", spoken: "agent is working" });
    check("a turn that ended with work outstanding still speaks", footSays(false, 1), {
      line: "waiting for 1 task",
      spoken: "waiting for 1 task",
    });
    check("and it counts in the plural", footSays(false, 3)?.line, "waiting for 3 tasks");
    check("both facts share one line", footSays(true, 2), {
      line: "working… · waiting for 2 tasks",
      spoken: "agent is working, waiting for 2 tasks",
    });
  }

  {
    // A subagent spawned before a `/clear` and still running after it: the parent
    // card is below the cut, so its steps have nothing to nest under and stay
    // where they are. Revealing what is above re-collects them on the next render,
    // so the degradation is temporary by construction.
    seq = 0;
    const events = [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")];
    const tail = buildTail(events, [], 2);
    check("a parent below the cut leaves its children where they were", drawn(tail.rows), ["e2", "e3"]);
    check("and says how many events are below it", tail.hidden, 1);
  }

  {
    // Unbounded indent on a 390px screen is not a thing to discover in
    // production. Claude cannot reach this today; see MAX_DEPTH.
    seq = 0;
    const tail = buildTail(
      [toolCall("a", "outer"), toolCall("b", "inner", "a"), toolCall("c", "deepest", "b")],
      [],
    );
    const outer = tail.rows[0] as { children: { key: string; children: { key: string }[] }[] };
    check("a grandchild is flattened into its grandparent, never a third indent", outer.children.map((c) => c.key), ["e2", "e3"]);
    check("and the middle child keeps none of its own", outer.children[0]?.children.length, 0);
  }

  {
    // Without the cap a long subagent eats the whole render budget before the
    // walk reaches its parent, and the card naming the work is what disappears.
    seq = 0;
    const events = [toolCall("task", "Explore")];
    for (let i = 0; i < MAX_CHILDREN + 12; i += 1) events.push(toolCall(`c${i}`, `step ${i}`, "task"));
    const tail = buildTail(events, []);
    const task = tail.rows[0] as {
      children: { title: string }[];
      steps: number;
      omitted: number;
      latest: string | null;
    };
    // Identity, not arity. Asserting only the length passes whichever end the cap
    // keeps, and it did: `placeNodes` runs forwards over `collected.reverse()`, so
    // the naive `if (full) skip` kept `step 0`…`step 39` under a label saying the
    // opposite, with `omitted` counting the twelve newest.
    check(
      "only the newest forty steps are kept",
      [task.children[0]?.title, task.children.at(-1)?.title],
      ["step 12", "step 51"],
    );
    check("the count still says how many there were", task.steps, MAX_CHILDREN + 12);
    check("and how many are not shown", task.omitted, 12);
    // The second symptom of the same bug, and the one a person sees: the running
    // header reads `latest`, so keeping the oldest froze it at step 39 for the
    // whole remaining life of every long subagent.
    check("the header still names the step it is on", task.latest, "step 51");
  }

  {
    seq = 0;
    const tail = buildTail([toolCall("task", "Explore"), toolCall("c1", "grep", "task"), done("c1", "task")], []);
    const task = tail.rows[0] as { children: { key: string }[]; steps: number };
    check("a completed step folds into its own card, not a second row", task.children.map((c) => c.key), ["e2"]);
    check("and an update is not counted as another step", task.steps, 1);
  }

  {
    /*
     * The flag survives to the node, and an update never takes it away.
     *
     * Measured 2026-08-01: claude stamps `subagent: true` on the spawn and drops
     * it from that same call's *completing* update. Folded last-wins, the icon
     * would go from robot to brain at the end of every subagent — so the flag is
     * read from the `tool_call` only, and this is what says so. The other half of
     * the same defect is what prompted it: a spawn whose delegate made no tool
     * call has no children, and rendered as a `think` card.
     */
    seq = 0;
    const spawn = (id: string, title: string): never =>
      ev({ type: "tool_call", toolCallId: id, title, kind: "think", status: "pending", locations: [], rawInput: null, parentToolCallId: null, subagent: true });
    const tail = buildTail([spawn("task", "Play rock paper scissors"), done("task")], []);
    const task = tail.rows[0] as { subagent: boolean; steps: number };
    check("a declared spawn is one even with no step to show for it", task.subagent, true);
    check("and it still counts no steps it did not have", task.steps, 0);
    check(
      "a call nobody declared is not one",
      (buildTail([toolCall("a", "grep")], []).rows[0] as { subagent: boolean }).subagent,
      false,
    );
  }

  {
    // Kimi filters subagent events at the source, so no call ever has a child.
    // A UI that grew an empty affordance there would advertise a feature that
    // agent does not have. This is the assertion that guards the whole feature.
    seq = 0;
    const flat = buildTail([toolCall("a", "grep"), toolCall("b", "read"), toolCall("c", "bash")], []);
    check("with no parent link anywhere, the tail is exactly what it was", drawn(flat.rows), ["e1", "e2", "e3"]);
    check(
      "and nothing claims a child",
      flat.rows.flatMap((r) => (r.kind === "group" ? r.children : [r])).every((r) => (r as { children?: unknown[] }).children?.length === 0),
      true,
    );
  }

  /*
   * `placeNodes`' precondition, stated by its own docstring and until now only
   * ever reached through `buildTail`.
   *
   * It takes document order and does not sort — "asserted rather than defended
   * with a sort" is the claim, and this is the assertion. Handed a child before
   * its parent, it must leave that child at the top level rather than quietly
   * repairing the order, because repairing it here would hide a `buildTail` that
   * had stopped reversing.
   */
  {
    const bare = (id: string, parent: string | null, at: number): never =>
      ({
        kind: "tool", key: `e${at}`, seq: at, toolCallId: id, parentId: parent,
        title: id, toolKind: "other", status: "pending", rawInput: null, locations: [],
        output: null, images: [], changes: [], children: [], steps: 0, omitted: 0, latest: null, elapsedMs: null,
      }) as never;

    check(
      "in document order a child nests",
      placeNodes([bare("p", null, 1), bare("k", "p", 2)]).map((n) => n.key),
      ["e1"],
    );
    check(
      "and out of it the child stays where it is, rather than being sorted into place",
      placeNodes([bare("k", "p", 2), bare("p", null, 1)]).map((n) => n.key),
      ["e2", "e1"],
    );
  }

  /*
   * A lineage an agent should not have sent.
   *
   * `parentToolCallId` is verbatim agent-chosen `_meta` and the daemon normalizes
   * only self-reference, so these are inputs a client will be handed rather than
   * inputs it can rule out. Both cases below ran forever before the visited sets
   * went in — inside `EventList`'s `useMemo`, so an unrecoverable tab, and one
   * that came back on every reload because the events are on disk.
   *
   * These assertions can only fail by hanging, which is worth stating: a
   * regression here does not print `FAIL`, it stops `pnpm webcheck` dead.
   */
  {
    seq = 0;
    const cycle = buildTail([toolCall("a", "alpha", "b"), toolCall("b", "beta", "a")], []);
    check("two calls that parent each other still terminate", cycle.rows.length, 1);

    seq = 0;
    // The other half: `byId.set` rebinding an id mid-pass is what let two live
    // entries point at each other while both sat at the clamp's exit depth.
    const reused = buildTail(
      [
        toolCall("r", "root"),
        toolCall("a", "a", "r"),
        toolCall("b", "b", "a"),
        toolCall("a", "a again", "b"),
        toolCall("c", "c", "a"),
      ],
      [],
    );
    check("and so does a repeated toolCallId", reused.rows.length > 0, true);

    seq = 0;
    check(
      "a call naming itself as its parent is top level, not a child of itself",
      buildTail([toolCall("solo", "solo", "solo")], []).rows.map((r) => r.key),
      ["e1"],
    );
  }

  /*
   * The failed-update paths, in both directions.
   *
   * `nodeFor` builds an `UpdateNode` only for a *failed* update, so every case
   * above using `done()` leaves `placeNodes`' fold branch untouched — the whole
   * `update` node type was uncovered in both directions until here.
   */
  {
    seq = 0;
    const folded = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), failed("c1", "task")],
      [],
    );
    const parent = folded.rows[0] as { children: { key: string }[] };
    check(
      "a failed step draws inside its own card, never as a second row",
      [folded.rows.map((r) => r.key), parent.children.map((c) => c.key)],
      [["e1"], ["e2"]],
    );

    seq = 0;
    // The orphan: a step that failed after a `/clear`, whose own `tool_call` is
    // below the cut. This row is the only thing saying something broke up there.
    // Cut at 3 and not 2 — at 2 the failing call itself is still collected, so the
    // fold above is what fires and the standalone row is correctly suppressed.
    // Only when the `tool_call` is genuinely out of reach does this row exist.
    const orphan = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), failed("c1", "task")],
      [],
      3,
    );
    check(
      "a failure whose own call fell below the cut survives on its own",
      orphan.rows.map((r) => [r.key, (r as { title?: string | null }).title]),
      [["uc1:3", "boom"]],
    );
  }

  /*
   * How long it took, and which event's clock said so.
   *
   * Timing from the newest update read the clock of an event that said nothing —
   * the five-events table has two whose every field is null — so a duration grew
   * with traffic rather than with the call, and widening the window with "show
   * more" changed a *finished* call's number.
   */
  {
    seq = 0;
    const finished = buildTail(
      [toolCall("t", "grep"), done("t"), ev({ type: "text", role: "agent", thought: false, text: "x" })],
      [],
    );
    check(
      "a finished call reports call-to-completion",
      (finished.rows[0] as { elapsedMs: number | null }).elapsedMs,
      1000,
    );

    seq = 0;
    const trailing = buildTail(
      [
        toolCall("t", "grep"),
        done("t"),
        ev({ type: "tool_call_update", toolCallId: "t", title: null, status: null, locations: [], rawInput: null, content: null, parentToolCallId: null }),
      ],
      [],
    );
    check(
      "and a later update that says nothing does not inflate it",
      (trailing.rows[0] as { elapsedMs: number | null }).elapsedMs,
      1000,
    );

    seq = 0;
    check(
      "a call still running reports nothing rather than a ticking number",
      (buildTail([toolCall("t", "grep")], []).rows[0] as { elapsedMs: number | null }).elapsedMs,
      null,
    );
  }

  /*
   * A reused id does not let two calls claim one update.
   *
   * The `updates` map is keyed by `toolCallId` alone, so without consume-and-
   * delete *every* call answering to that id merged the same list and the two
   * cards drew identical titles, status and output. The walk is backwards, so
   * the claimant is the nearest call preceding the update, which is the only
   * defensible owner.
   */
  {
    seq = 0;
    const reused = buildTail(
      [
        toolCall("dup", "first"),
        toolCall("dup", "second"),
        ev({ type: "tool_call_update", toolCallId: "dup", title: "what the update said", status: "completed", locations: [], rawInput: null, content: ["one"], parentToolCallId: null }),
      ],
      [],
    );
    check(
      "an update is claimed once, by the call it followed",
      reused.rows
        .flatMap((r) => (r.kind === "group" ? r.children : [r]))
        .map((r) => (r as { title?: string }).title),
      ["first", "what the update said"],
    );
  }

  /* ---------------------------------------------------------------- *
   * The memo comparator
   *
   * `buildTail` builds fresh node objects every time it runs, and it runs on every
   * streamed token — so `React.memo`'s own shallow compare, which asks whether the
   * `node` prop is the same object, answers "no" for every row every time. That is
   * what `sameNode` replaces, and it is the whole reason drawing an unbounded
   * transcript is affordable: an appended event should re-render the row it
   * appended, not the fifteen hundred above it.
   *
   * Both directions matter and they fail differently. Answering `false` when
   * nothing changed is merely slow — the old behaviour, restored. Answering `true`
   * when something *did* change leaves a stale row on screen for ever, with
   * nothing anywhere to say so, which is exactly the class of defect a driver with
   * no DOM can still catch.
   * ---------------------------------------------------------------- */
  {
    const txt = (text: string): never =>
      ev({ type: "text", role: "agent", thought: false, text });

    // The tool call *first*, so a chunk arriving after it does not renumber it —
    // which is what an appended event actually looks like. Ordered the other way
    // this fixture would report the card as changed for the trivial reason that
    // its seq moved, and would be asserting nothing about the comparator.
    seq = 0;
    const before = buildTail([toolCall("t", "grep"), txt("hel")], []);
    seq = 0;
    const same = buildTail([toolCall("t", "grep"), txt("hel")], []);
    check(
      "two builds over the same events compare equal, node for node",
      before.rows.every((node, i) => sameNode(node, same.rows[i]!)),
      true,
    );
    // Which is the point: the objects themselves are new every time, so the
    // default shallow compare would have skipped nothing at all.
    check("even though none of them is the same object", before.rows[0] === same.rows[0], false);

    seq = 0;
    const grown = buildTail([toolCall("t", "grep"), txt("hel"), txt("lo")], []);
    // A streamed chunk extends the run it belongs to, so that row must re-render
    // and the card above it must not.
    check("a run that gained a chunk is not equal", sameNode(before.rows[1]!, grown.rows[1]!), false);
    check("while the untouched row beside it is", sameNode(before.rows[0]!, grown.rows[0]!), true);

    seq = 0;
    const completed = buildTail(
      [
        toolCall("t", "grep"),
        txt("hel"),
        ev({ type: "tool_call_update", toolCallId: "t", title: null, status: "completed", locations: [], rawInput: null, content: ["out"], parentToolCallId: null }),
      ],
      [],
    );
    check("a card whose status or output moved is not equal", sameNode(before.rows[0]!, completed.rows[0]!), false);

    // Children are compared too, or a subagent's card would freeze at whatever its
    // steps looked like the first time it was drawn — the one place a stale row
    // would be least visible, since the card is collapsed.
    seq = 0;
    const oneStep = buildTail([toolCall("task", "Explore"), toolCall("c1", "grep", "task")], []);
    seq = 0;
    const twoSteps = buildTail(
      [toolCall("task", "Explore"), toolCall("c1", "grep", "task"), toolCall("c2", "read", "task")],
      [],
    );
    check("a subagent that gained a step is not equal", sameNode(oneStep.rows[0]!, twoSteps.rows[0]!), false);
  }
}

/* ------------------------------------------------------------------ *
 * A turn's worth of machinery, as one line
 *
 * The transcript's question is *does anything anywhere need me*, and a run of tool
 * calls is not an answer to it. Measured across every session on the development
 * machine, by running `foldRuns` itself rather than estimating over raw events: **16
 * runs, 9 of them a single call, 7 folded** (sizes 2,3,3,3,3,4,11), taking 111 drawn
 * rows to 89. So what folding saves is height rather than rows — a card is several
 * rows tall per call — and what it must never save height on is a decision somebody
 * made.
 * ------------------------------------------------------------------ */

process.stdout.write("\na run of tool calls, folded into one row\n");
{
  let seq = 0;
  const ev = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const toolCall = (
    id: string,
    title: string,
    kind = "other",
    status = "completed",
    rawInput: unknown = null,
  ): never =>
    ev({ type: "tool_call", toolCallId: id, title, kind, status, locations: [], rawInput, parentToolCallId: null });
  const say = (text: string): never => ev({ type: "text", role: "agent", thought: false, text });
  const changed = (
    path: string,
    oldText: string | null,
    newText: string,
    toolCallId: string | null = null,
    source = "diff",
  ): never => ev({ type: "file_change", path, oldText, newText, source, toolCallId });
  const keys = (rows: BuiltRows): string[] => rows.map((r) => r.key);
  // Read out of the union rather than cast to `never` like the *inputs* in this file:
  // these assertions read fields off a group, so the type has to survive.
  type Group = Extract<BuiltRows[number], { kind: "group" }>;
  const group = (rows: BuiltRows, at = 0): Group => rows[at] as Group;

  {
    /*
     * Two calls between two messages are one row, and the messages either side are
     * untouched — the `flush()` boundaries `buildTail` puts around a `tool_call` are
     * what separated them before folding existed, and folding runs after all of that
     * on the finished rows.
     */
    seq = 0;
    const tail = buildTail([say("before"), toolCall("a", "grep"), toolCall("b", "ls"), say("after")], []);
    check("a run of two is one row between the two messages", keys(tail.rows), ["t1", "r2", "t4"]);
    check("holding both calls, with their own keys", drawn(tail.rows), ["t1", "e2", "e3", "t4"]);
  }

  {
    /*
     * ⭐ **A run of one is never wrapped**, which is what keeps a lone tool call
     * splitting a message into `before`/`[tool]`/`after` exactly as it did. 9 of the
     * 16 runs measured are single calls, so a wrapper there would add a disclosure
     * whose body is one row — the same "worse than no disclosure" `opensToAnything`
     * refuses one level down.
     */
    seq = 0;
    const tail = buildTail([say("before "), toolCall("a", "grep"), say("after")], []);
    check("a single call is left as it was", keys(tail.rows), ["t1", "e2", "t3"]);
  }

  {
    /*
     * ⭐ **The rule this feature must not break, and the shape of it was reversed
     * once.**
     *
     * The first version was "no permission ever folds", and it cost more than it
     * bought: measured on a real codex session, one approval in the middle of four
     * calls split them into a group, a bare row and a lone card — because a run of one
     * is never wrapped. So an **approval** folds in, in document order, and the
     * collapsed row counts it; a **refusal** never does, because that row is the only
     * record that somebody said no.
     *
     * The verdict comes from `permissionDecisions`, never from `outcome`, and these
     * fixtures carry the `permission_request` for that reason: `outcome: "selected"`
     * means an option was chosen and every `reject_*` option produces it too.
     */
    const request = (id: string, call: string, kinds: Record<string, string>): never =>
      ev({
        type: "permission_request",
        permissionId: id,
        toolCallId: call,
        title: "Bash",
        options: Object.entries(kinds).map(([optionId, kind]) => ({ optionId, name: optionId, kind })),
        decision: null,
      });
    const answer = (id: string, call: string, optionId: string): never =>
      ev({ type: "permission_resolved", permissionId: id, toolCallId: call, title: "Bash", outcome: "selected", optionId, by: "client" });

    seq = 0;
    const allowed = buildTail(
      [
        toolCall("a", "grep"),
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "allow_once"),
        toolCall("b", "bash"),
      ],
      [],
      0,
      permissionDecisions([
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "allow_once"),
      ] as never),
    );
    check("an approval folds into the run it authorised", keys(allowed.rows), ["r1"]);
    check("counted on the collapsed row rather than hidden", group(allowed.rows).approved, 1);
    // In document order, where it happened — the request row is merged away by the
    // answer, as it always was, so three children rather than four.
    check("and its children keep their order", drawn(allowed.rows), ["e1", "e3", "e4"]);

    seq = 0;
    const denied = buildTail(
      [
        toolCall("a", "grep"),
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "reject_once"),
        toolCall("b", "bash"),
        toolCall("c", "bash"),
      ],
      [],
      0,
      permissionDecisions([
        request("p1", "b", { allow_once: "allow_once", reject_once: "reject_once" }),
        answer("p1", "b", "reject_once"),
      ] as never),
    );
    check("a refusal is never folded away", keys(denied.rows), ["e1", "e3", "r4"]);

    /*
     * The two ways the verdict can be unknown, and both fall through to "not
     * foldable" — so the failure mode is a visible row rather than a hidden refusal.
     * The second is what a driver calling `buildTail` with three arguments gets.
     */
    seq = 0;
    const unmatched = buildTail(
      [toolCall("a", "grep"), answer("p1", "b", "some_option_the_request_never_offered"), toolCall("b", "bash")],
      [],
      0,
      new Map(),
    );
    check("an answer nothing can classify keeps its row", keys(unmatched.rows), ["e1", "e2", "e3"]);
    seq = 0;
    const noMap = buildTail(
      [
        toolCall("a", "grep"),
        request("p1", "b", { allow_once: "allow_once" }),
        answer("p1", "b", "allow_once"),
        toolCall("b", "bash"),
      ],
      [],
    );
    check("and with no verdicts passed at all, nothing folds", keys(noMap.rows), ["e1", "e3", "e4"]);

    /*
     * A run of approvals and nothing else is not a run: there is no work for them to
     * be folded into, and a group there would draw a sentence with no clause in it.
     */
    seq = 0;
    const onlyAnswers = buildTail(
      [
        request("p1", "x", { allow_once: "allow_once" }),
        answer("p1", "x", "allow_once"),
        request("p2", "y", { allow_once: "allow_once" }),
        answer("p2", "y", "allow_once"),
      ],
      [],
      0,
      permissionDecisions([
        request("p1", "x", { allow_once: "allow_once" }),
        answer("p1", "x", "allow_once"),
        request("p2", "y", { allow_once: "allow_once" }),
        answer("p2", "y", "allow_once"),
      ] as never),
    );
    check("approvals with no work to fold into stay rows", keys(onlyAnswers.rows), ["e2", "e4"]);
  }

  {
    // Every other row that is not machinery breaks a run for the same reason: it is
    // something a person reads, not a step the agent took.
    seq = 0;
    const plan = buildTail([toolCall("a", "grep"), ev({ type: "plan", entries: [] }), toolCall("b", "ls")], []);
    check("a plan breaks a run", keys(plan.rows), ["e1", "e2", "e3"]);
    seq = 0;
    const gap = buildTail([toolCall("a", "grep"), toolCall("b", "ls"), toolCall("c", "bash")], [
      { from: 3, to: 4, reason: "evicted" } as never,
    ]);
    check("and so does a hole in the conversation", keys(gap.rows), ["r1", "g3", "e3"]);
  }

  {
    /*
     * A subagent is not folded: its card is already a summary of N steps with its own
     * tree inside, so putting it behind a sentence about it would hide the one row in
     * the transcript that says a delegation happened.
     */
    seq = 0;
    const tail = buildTail(
      [
        toolCall("task", "Explore"),
        ev({ type: "tool_call", toolCallId: "c1", title: "grep", kind: "other", status: "completed", locations: [], rawInput: null, parentToolCallId: "task" }),
        toolCall("b", "ls"),
      ],
      [],
    );
    check("a subagent stands on its own", keys(tail.rows), ["e1", "e3"]);
  }

  {
    /*
     * What a folded run knows about itself. Neither fact opens it any more — see the
     * source-text assertion below — but both are still drawn on the collapsed row,
     * which is where they have to be correct.
     *
     * `live` inks the hollow pulse and `failed` the count, and they are computed the
     * same way they always were: `live` is a disjunction over the run's tool children,
     * `failed` a tally of them.
     */
    seq = 0;
    const live = buildTail([toolCall("a", "grep", "other", "completed"), toolCall("b", "ls", "other", "in_progress")], []);
    check("a run with something still running is live", [group(live.rows).live, group(live.rows).failed], [true, 0]);
    seq = 0;
    const broke = buildTail([toolCall("a", "grep"), toolCall("b", "ls", "other", "failed")], []);
    check("and one that failed says how many", [group(broke.rows).live, group(broke.rows).failed], [false, 1]);
    seq = 0;
    const settled = buildTail([toolCall("a", "grep"), toolCall("b", "ls")], []);
    check("a finished run is neither", [group(settled.rows).live, group(settled.rows).failed], [false, 0]);

    /*
     * ⭐ **Nothing opens a folded run but a tap, and this is a source-text assertion
     * because the rule is one line of JSX.**
     *
     * Two facts have been tried in that slot and both were reported as bugs, which is
     * why the assertion is now on the constant rather than on whichever fact is
     * currently allowed. `failed > 0` came first: `override` is component state and
     * dies on reload while a failure is permanent, so a group somebody deliberately
     * collapsed came back open on every refresh for ever. `node.live` replaced it and
     * failed the other way — the newest run drew expanded until the agent stopped
     * calling tools, so the machinery a reader had folded away unfolded itself on
     * every turn, and the row whose height nobody chose was the one at the foot of
     * the page.
     *
     * Pinned on the derived expression itself rather than on a rendering, since
     * `webcheck` has no DOM.
     */
    const listSrc = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const derived = /const open = override \?\? ([^;]+);/.exec(listSrc)?.[1] ?? "(not found)";
    check("a folded run starts collapsed, whatever it is doing", derived, "false");

    /*
     * And the other half of that change, which is what keeps `live` from becoming a
     * field three assertions above describe and nothing renders — the `sessionOf`
     * failure, in the direction this repo names it for. It is spent on the collapsed
     * row's pulse now; if that goes, those three assertions go with it.
     */
    check("and liveness still inks the row it no longer opens", /node\.live/.test(listSrc), true);
  }

  {
    /*
     * The sentence, which is mechanical for a measured reason: the words a model
     * writes about its own work reach us as `rawInput.description`, on 13 of 1132
     * updates in the log — practically every claude `Bash` call and not one edit. Two
     * grammars in one transcript, differing by agent, is worse than one that is
     * always the same.
     *
     * Built from ACP's `kind` and never from a title or an id, which is the rule the
     * rest of this client follows for every control it draws.
     */
    seq = 0;
    const two = buildTail([toolCall("a", "Bash", "execute"), toolCall("b", "Bash", "execute")], []);
    check("two commands", runSummary(group(two.rows).tally), "Ran 2 commands");

    seq = 0;
    const mixed = buildTail(
      [
        toolCall("a", "Bash", "execute"),
        toolCall("b", "Bash", "execute"),
        toolCall("w", "Write", "edit"),
        changed("/w/README.md", "old\nlines\nhere", "new\nlines\nhere\nand\nmore", "w"),
      ],
      [],
    );
    check(
      "a mixed run names the file and counts the commands",
      runSummary(group(mixed.rows).tally),
      "Ran 2 commands, edited README.md",
    );
    // The clauses are in the order their kind first appeared, and the counts are what
    // the row draws `+N −M` from — the events themselves, so there is one source for
    // them and it is the one the card rows use.
    check("with the run's own changes on the tally", group(mixed.rows).tally.changes.length, 1);

    seq = 0;
    const created = buildTail(
      [toolCall("w", "Write", "edit"), changed("/w/bot.py", null, "a\nb\nc", "w"), toolCall("r", "Bash", "execute")],
      [],
    );
    check(
      "a file with no old side was created, not edited",
      runSummary(group(created.rows).tally),
      "Created bot.py, ran a command",
    );

    seq = 0;
    const many = buildTail(
      [
        toolCall("w", "Write", "edit"),
        changed("/w/a.ts", null, "a", "w"),
        changed("/w/b.ts", null, "b", "w"),
        toolCall("v", "Write", "edit"),
        changed("/w/c.ts", null, "c", "v"),
      ],
      [],
    );
    // Counted per **file**, not per call: the clause names a file, so the number
    // beside it has to be a number of files or a `MultiEdit` reads as one change.
    check("three files created by two calls is three", runSummary(group(many.rows).tally), "Created 3 files");

    seq = 0;
    const reads = buildTail(
      [
        toolCall("a", "Read", "read", "completed", { file_path: "/w/one.ts" }),
        toolCall("b", "Read", "read", "completed", { file_path: "/w/two.ts" }),
        toolCall("c", "Read", "read", "completed", { file_path: "/w/three.ts" }),
      ],
      [],
    );
    check("three files read", runSummary(group(reads.rows).tally), "Read 3 files");
    seq = 0;
    const oneRead = buildTail(
      [
        toolCall("a", "Read", "read", "completed", { file_path: "/w/one.ts" }),
        toolCall("b", "Bash", "execute"),
      ],
      [],
    );
    check("but one file gets named", runSummary(group(oneRead.rows).tally), "Read one.ts, ran a command");

    /*
     * ⭐ **Both of these were found by running the grammar over the real log**, and
     * neither is symmetry for its own sake.
     *
     * `ToolSearch` arrives as `kind: "other"` with `rawInput.query =
     * "select:AskUserQuestion"`, and naming an unknown kind by its *summary* put that
     * string straight into a sentence: "Ran 2 commands, select:AskUserQuestion". An
     * argument is not a name — for a kind nobody here knows, the only thing that reads
     * as one is what the agent called the tool.
     *
     * And a nameless single call produced **"used 1 tools"**, which reads as a broken
     * product rather than a missing plural.
     */
    seq = 0;
    const unknown = buildTail(
      [
        toolCall("a", "Bash", "execute"),
        toolCall("b", "Bash", "execute"),
        toolCall("t", "ToolSearch", "other", "completed", { query: "select:AskUserQuestion" }),
      ],
      [],
    );
    check("an unknown kind is named by its tool, never by its arguments", runSummary(group(unknown.rows).tally), "Ran 2 commands, used ToolSearch");
    seq = 0;
    const nameless = buildTail(
      [toolCall("a", "Bash", "execute"), toolCall("b", "x".repeat(60), "other")],
      [],
    );
    check("and one it cannot name can still count to one", runSummary(group(nameless.rows).tally), "Ran a command, used a tool");

    /*
     * ⭐ **Every clause needs three arms, and four of them shipped with two.**
     *
     * `used 1 tools` was caught by running the grammar over the log; the same shape
     * survived in `create`, `edit`, `read` and `search`, where `count === 1` with a
     * name too long to draw fell through to the plural. For **search** that is the
     * ordinary case rather than an edge one: the query measured in the log is
     * `'context window|context size|tokens|token limit|1m|1,000,000'`, well past
     * `CLAUSE_NAME_CHARS`, so a real session said "ran 1 searches".
     */
    const long = "x".repeat(60);
    seq = 0;
    const oneLongSearch = buildTail(
      [toolCall("s", "Search", "search", "completed", { query: long }), toolCall("b", "Bash", "execute")],
      [],
    );
    check("one search it cannot name", runSummary(group(oneLongSearch.rows).tally), "Searched, ran a command");
    seq = 0;
    const oneLongFile = buildTail(
      [
        toolCall("w", "Write", "edit"),
        changed(`/w/${long}.ts`, null, "a", "w"),
        toolCall("b", "Bash", "execute"),
      ],
      [],
    );
    check("one created file it cannot name", runSummary(group(oneLongFile.rows).tally), "Created a file, ran a command");
    seq = 0;
    const oneLongRead = buildTail(
      [
        toolCall("r", "Read", "read", "completed", { file_path: `/w/${long}.ts` }),
        toolCall("b", "Bash", "execute"),
      ],
      [],
    );
    check("one read file it cannot name", runSummary(group(oneLongRead.rows).tally), "Read a file, ran a command");
  }

  {
    /*
     * ⭐ **A change is drawn by the card that made it, and the second copy of it is
     * dropped.**
     *
     * Measured against kimi (Q6.12): one edit produces two `file_change` events —
     * `source: "diff"` carrying the tool call's id, then `source: "fs_write"` with
     * `toolCallId: null`. The first is folded into the card. The second has no call to
     * fold into and would stand underneath it as the same edit again.
     *
     * ⚠ **The two halves do not carry the same text, and a fixture that fed them the
     * same text passed while the product was broken.** The `diff` copy is the
     * *fragment* the model typed (Q7.29: `"two"` → `"TWO CHANGED"`), while
     * `onWriteTextFile` reads the file and sends the **whole** of it either side. So
     * the match is on the path — a content signature could never fire, and with a
     * diff drawn from each the result was worse than the two bare paths this
     * replaced: one edit reported twice with two different `+N −M`. The fixture below
     * is kimi's real shape for that reason.
     */
    seq = 0;
    const pair = buildTail(
      [
        toolCall("w", "Edit", "edit"),
        changed("/w/notes.txt", "two", "TWO CHANGED", "w", "diff"),
        changed("/w/notes.txt", "one\ntwo\nthree", "one\nTWO CHANGED\nthree", null, "fs_write"),
      ],
      [],
    );
    check("one edit reported twice is one row", keys(pair.rows), ["e1"]);
    check(
      "and the card is the one that holds it",
      (pair.rows[0] as Extract<BuiltRows[number], { kind: "tool" }>).changes.length,
      1,
    );

    /*
     * One credit per absorbed edit, not "this path is dealt with for ever". A second
     * write to a file edited earlier is a different act, and its row is the only
     * trace of it.
     */
    seq = 0;
    const later = buildTail(
      [
        toolCall("w", "Edit", "edit"),
        changed("/w/notes.txt", "two", "TWO CHANGED", "w", "diff"),
        changed("/w/notes.txt", "a", "b", null, "fs_write"),
        changed("/w/notes.txt", "b", "c", null, "fs_write"),
      ],
      [],
    );
    // Through `drawn`, because the card and the surviving change are both machinery
    // and therefore fold together — which is the point being made two sections up.
    check("a second write to the same file keeps its row", drawn(later.rows), ["e1", "c4"]);

    seq = 0;
    const twice = buildTail(
      [
        changed("/w/a.txt", "x", "y", null, "fs_write"),
        changed("/w/a.txt", "x", "y", null, "fs_write"),
      ],
      [],
    );
    check("and with no diff half at all, nothing is suppressed", drawn(twice.rows), ["c1", "c2"]);

    // A change whose call is outside the window keeps its own row — that row is the
    // only thing saying the file was touched at all.
    seq = 0;
    const orphan = buildTail([changed("/w/a.txt", null, "hello", "gone")], []);
    check("a change with no call on screen stands alone", keys(orphan.rows), ["c1"]);
  }

  {
    /*
     * The comparator, in both directions, for the two node kinds this change added.
     * A `sameNode` that wrongly answers `true` leaves a stale row on screen for ever
     * with nothing anywhere to say so — which is why it is exported at all.
     */
    seq = 0;
    const first = buildTail([toolCall("a", "grep"), toolCall("b", "ls")], []);
    seq = 0;
    const again = buildTail([toolCall("a", "grep"), toolCall("b", "ls")], []);
    check("two builds of one run compare equal", sameNode(first.rows[0]!, again.rows[0]!), true);
    seq = 0;
    const grew = buildTail([toolCall("a", "grep"), toolCall("b", "ls"), toolCall("c", "bash")], []);
    check("a run that gained a call does not", sameNode(first.rows[0]!, grew.rows[0]!), false);
    seq = 0;
    const finished = buildTail([toolCall("a", "grep"), toolCall("b", "ls", "other", "in_progress")], []);
    check("nor does one whose last call is still running", sameNode(first.rows[0]!, finished.rows[0]!), false);

    /*
     * A change compares by the **identity of the event that produced it**, which is
     * the same rule an `event` node has and rests on the same fact: a `StoredEvent`
     * is never mutated, so two rebuilds over one log see the same object — and the
     * diff drawn from it is memoised against that identity too. So this is driven
     * over one array twice, which is what `buildTail` actually does on every token;
     * two equivalent-but-separate fixtures would be asserting a field-by-field
     * comparison that deliberately is not there.
     */
    seq = 0;
    const log = [changed("/w/a.txt", null, "hello", "gone")];
    check("two builds of one change compare equal", sameNode(buildTail(log, []).rows[0]!, buildTail(log, []).rows[0]!), true);
    seq = 0;
    const other = buildTail([changed("/w/a.txt", null, "goodbye", "gone")], []);
    check("and a different one does not", sameNode(buildTail(log, []).rows[0]!, other.rows[0]!), false);
  }

  {
    /*
     * ⭐ **A permission codex did not name, named.**
     *
     * Measured 2026-08-13 in the log (`s_d43bae82`): codex sends a permission with no
     * title, so the daemon's `title = toolCall.title ?? toolCallId` falls through to
     * the id and the transcript's only record of an approval read
     * `✓ exec-55382d16-8647-4b5e-a87c-32c95b8ed2e8`. `permissionHeadline` rescues the
     * *card*; nothing rescued the row.
     *
     * The join is on the id the agent itself supplied, and the trigger is the exact
     * equality the daemon's fallback leaves behind — it names no vendor and no
     * pattern. Resolved after the walk, because a permission is met **before** the
     * `tool_call` that names it.
     */
    seq = 0;
    const unnamed = buildTail(
      [
        toolCall("exec-5538", "node fetch-codex-manual.mjs", "execute", "completed"),
        ev({ type: "permission_resolved", permissionId: "perm-1", toolCallId: "exec-5538", title: "exec-5538", outcome: "selected", optionId: "allow_once", by: "client" }),
      ],
      [],
    );
    check(
      "a permission titled with its own call id takes the call's name",
      (unnamed.rows.at(-1) as Extract<BuiltRows[number], { kind: "event" }>).heading,
      "node fetch-codex-manual.mjs",
    );

    // And a title worth keeping is kept — which is every claude and kimi permission.
    seq = 0;
    const named = buildTail(
      [
        toolCall("t1", "Bash", "execute", "completed"),
        ev({ type: "permission_resolved", permissionId: "perm-2", toolCallId: "t1", title: "Bash", outcome: "selected", optionId: "allow_once", by: "client" }),
      ],
      [],
    );
    check(
      "and one the daemon named is left alone",
      (named.rows.at(-1) as Extract<BuiltRows[number], { kind: "event" }>).heading,
      null,
    );

    /*
     * The naming can only borrow a *name*. A call the agent also failed to name
     * carries its own id as its title, and lending that to the permission would
     * swap one uuid for the same uuid while claiming it had been resolved.
     */
    seq = 0;
    const bothUnnamed = buildTail(
      [
        toolCall("exec-9", "exec-9", "execute", "completed"),
        ev({ type: "permission_resolved", permissionId: "perm-3", toolCallId: "exec-9", title: "exec-9", outcome: "selected", optionId: "allow_once", by: "client" }),
      ],
      [],
    );
    check(
      "a call with no name of its own lends nothing",
      (bothUnnamed.rows.at(-1) as Extract<BuiltRows[number], { kind: "event" }>).heading,
      null,
    );
  }

  {
    // `foldRuns` is pure and exported, so the shape can be driven without a log at
    // all — which is what lets the empty and single-row cases be stated.
    check("nothing folds to nothing", foldRuns([]), []);
    check(
      "and a row that is not machinery is passed straight through",
      keys(foldRuns([{ kind: "gap", key: "g1", seq: 1, parentId: null, gap: { from: 1, to: 2, reason: "evicted" } } as never])),
      ["g1"],
    );
  }
}

/* ------------------------------------------------------------------ *
 * What the transcript refuses to draw
 *
 * Every type below had **no fixture at all** before this block existed, which is
 * why the rules were extracted into `showsInTranscript` rather than left as arms
 * of a `switch` nothing could reach.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the transcript refuses to draw\n");
{
  let seq = 0;
  const ev = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const prompt = (text: string): never => ev({ type: "prompt", text, attachments: [] });
  const status = (value: string): never => ev({ type: "status", status: value, exit: null });
  const workspace = (...warnings: { code: string; message: string }[]): never =>
    ev({
      type: "workspace",
      mode: "worktree",
      root: "/w",
      requestedCwd: "/p",
      branch: "b",
      baseCommit: "c",
      plainReason: null,
      warnings,
    });
  const turnEnd = (stopReason: string): never => ev({ type: "turn_end", stopReason, usage: null });
  const asked = (permissionId: string | null): never =>
    ev({
      type: "permission_request",
      permissionId,
      toolCallId: null,
      title: "run rm -rf",
      options: [],
      decision: null,
    });
  const answered = (permissionId: string): never =>
    ev({
      type: "permission_resolved",
      permissionId,
      toolCallId: null,
      title: "run rm -rf",
      outcome: "selected",
      optionId: "allow",
      by: "client",
    });

  const drawn = (event: Record<string, unknown>): boolean => showsInTranscript(event as never);

  check(
    "chrome that is always on screen draws no row",
    ["status", "workspace", "agent_config", "session_started", "agent_log", "other"].map((type) =>
      drawn({ type }),
    ),
    [false, false, false, false, false, false],
  );
  check(
    "and everything somebody came to read still does",
    [
      "prompt",
      "file_change",
      // Answers `true` from the event alone; whether it is *merged away* is
      // `nodeFor`'s separate question, driven four cases below. Listed so the
      // three groups here cover all seventeen `SessionEvent` members rather
      // than sixteen, which is what makes the union claim below literal.
      "permission_request",
      "permission_resolved",
      "plan",
      "context_cleared",
      "error",
    ].map((type) => drawn({ type })),
    [true, true, true, true, true, true, true],
  );
  // The divider that landed after every single agent reply, saying only that the
  // paragraph you had just finished reading had finished.
  check("an ordinary turn ending is not news", drawn({ type: "turn_end", stopReason: "end_turn" }), false);
  check(
    "but a turn that did not finish is",
    ["max_tokens", "refusal", "cancelled"].map((reason) => drawn({ type: "turn_end", stopReason: reason })),
    [true, true, true],
  );
  // Handled by their own node kinds long before this is reached; answered honestly
  // anyway, so this reads as a statement about the union rather than the leftovers.
  check(
    "the three with their own node kinds are not silent",
    ["text", "tool_call", "tool_call_update"].map((type) => drawn({ type })),
    [true, true, true],
  );

  /*
   * Driven through `buildTail` as well as through the predicate, because a
   * predicate passing while nothing actually changed is the failure this file
   * already records elsewhere.
   */
  {
    seq = 0;
    const tail = buildTail([status("idle"), workspace(), prompt("hello"), turnEnd("end_turn")], []);
    check("only the prompt survives a turn's worth of chrome", tail.rows.map((r) => r.key), ["e3"]);
  }

  {
    seq = 0;
    const tail = buildTail([status("starting"), status("idle"), prompt("a"), prompt("b")], [], 3);
    check("a suppressed event draws no row above the cut either", tail.rows.map((r) => r.key), ["e3", "e4"]);
    /*
     * And `hidden` counts what it has always counted: **events**, not rows, which
     * the cut block above pins from the other side. So the two status events below
     * the cut are counted as hidden even though showing them would draw nothing.
     *
     * Recorded rather than fixed, and it matters less than it did: `hidden` is now
     * only ever read for the one control offering back a cleared conversation, and
     * a real one has plenty of real content in it. The alternative is a second walk
     * over everything below the cut on every render to make a number marginally
     * more honest.
     */
    check("while `hidden` goes on counting events rather than rows", tail.hidden, 2);
  }

  {
    /*
     * The row stays cut, and now nothing else draws it either.
     *
     * This block used to assert that cutting the transcript row did not cut the
     * *warning*, because `SessionView`'s banner read the events directly and was
     * the only thing keeping `dirty_source` on screen. The banner was deleted on
     * request, so the second half of that pair has nothing left to hold and
     * `latestWorkspaceWarnings` went with it. What is still worth pinning is the
     * half that survives: a `workspace` event earns no row, so re-adding a reader
     * for these warnings is a decision somebody makes rather than something that
     * falls out of the transcript by itself.
     */
    seq = 0;
    const events = [
      workspace({ code: "dirty_source", message: "uncommitted work is not in this session" }),
    ];
    check("a workspace event draws no row", buildTail(events, []).rows.length, 0);
    // By name, not by side effect: the row count above is 0 for anything that
    // fails to parse too, so the set membership is what says this is a decision.
    check("because the type is suppressed by name", TRANSCRIPT_SILENT.has("workspace"), true);
  }

  {
    // The merge. Through the daemon a parked request keeps `decision: null` for its
    // whole life, so a rule reading that field would have got this exactly backwards.
    seq = 0;
    const settled = buildTail([asked("p1"), answered("p1")], []);
    check("a request whose answer follows is drawn once, by the answer", settled.rows.map((r) => r.key), ["e2"]);
  }

  {
    // A daemon restart with an approval in flight: no `permission_resolved` is
    // synthesized on restore, so this row is the only trace of it.
    seq = 0;
    const lost = buildTail([asked("p1"), prompt("still there?")], []);
    check("a request nothing ever answered keeps its row", lost.rows.map((r) => r.key), ["e1", "e2"]);
  }

  {
    seq = 0;
    const two = buildTail([asked("p1"), asked("p2"), answered("p2")], []);
    check("the merge is by id and not by adjacency", two.rows.map((r) => r.key), ["e1", "e3"]);
  }

  {
    // A bare `Session` answers inline and emits no resolution at all.
    seq = 0;
    check("a request with no id is never merged away", buildTail([asked(null)], []).rows.length, 1);
  }

  /*
   * What the surviving row says the answer *was*.
   *
   * `outcome: "selected"` means an option was chosen, not that permission was
   * granted — every `reject_*` option produces it too. Since the request row is
   * now merged away, a renderer keyed on `outcome` drew a check mark against a
   * refused command and that was the only surviving record of it.
   */
  {
    const withOptions = (permissionId: string): never =>
      ev({
        type: "permission_request",
        permissionId,
        toolCallId: null,
        title: "run rm -rf",
        options: [
          { optionId: "o-yes", name: "Allow", kind: "allow_once" },
          { optionId: "o-no", name: "Deny", kind: "reject_once" },
        ],
        decision: null,
      });
    const answeredWith = (permissionId: string, optionId: string | null): never =>
      ev({
        type: "permission_resolved",
        permissionId,
        toolCallId: null,
        title: "run rm -rf",
        outcome: optionId === null ? "cancelled" : "selected",
        optionId,
        by: "client",
      });

    seq = 0;
    const denied = permissionDecisions([withOptions("p1"), answeredWith("p1", "o-no")]);
    check("a denial is recorded as a refusal", denied.get("p1"), "reject_once");
    check("and reads as refused", refused(denied.get("p1")), true);

    seq = 0;
    const allowed = permissionDecisions([withOptions("p2"), answeredWith("p2", "o-yes")]);
    check("an approval is not", [allowed.get("p2"), refused(allowed.get("p2"))], ["allow_once", false]);

    // The id is the agent's, so it is joined by identity and never pattern-matched.
    // An option the request never offered is "cannot tell", which draws as neither.
    seq = 0;
    const strange = permissionDecisions([withOptions("p3"), answeredWith("p3", "o-elsewhere")]);
    check("an option the request never offered is unknown", strange.has("p3"), false);
    check("and unknown is never treated as a refusal", refused(strange.get("p3")), false);

    // A cancellation carries no option at all, and is handled by `outcome`.
    seq = 0;
    check(
      "a cancelled request records no option",
      permissionDecisions([withOptions("p4"), answeredWith("p4", null)]).has("p4"),
      false,
    );

    // The request can sit above the render window while its answer is on screen,
    // which is why this walks the loaded events rather than the drawn rows.
    seq = 0;
    check(
      "a resolution with no request in the window is unknown rather than approved",
      refused(permissionDecisions([answeredWith("p5", "o-no")]).get("p5")),
      false,
    );
  }
}

/* ------------------------------------------------------------------ *
 * An event nobody draws does not break the message
 *
 * The section above says which events draw no row. This one says what that
 * absence costs the run around them, and the two answers are different — which
 * is the whole reason `buildTail`'s flush is keyed on `TRANSCRIPT_SILENT` rather
 * than on `showsInTranscript`, and the reason a single fixture cannot cover it.
 *
 * `flush()` is what puts a boundary between two agent messages. For a
 * `tool_call`, a `context_cleared` or a `turn_end: end_turn` that boundary is
 * real — something happened between them, and for the turn end the message after
 * it belongs to a different turn. For `agent_log` and `other` it is not: the row
 * costs no slot and appears nowhere, so cutting the run there split one streamed
 * message into two independently parsed `<Markdown>` blocks with nothing on
 * screen to explain the break. Both types genuinely interleave with `text` inside
 * one turn — an `agent_log` is a line the agent wrote to stderr, and codex emits
 * `session_info_update` (an `other`) about five times a turn.
 *
 * Parts join with **no separator**, so the visible cost is a word cut in half
 * across two paragraphs — `"here is the pl"` then `"an:"` — and, on a fenced code
 * block whose chunks straddle one, an unterminated fence followed by a stray
 * paragraph. The trap is the mirror of that: a dropped **thought** must go on
 * flushing, or the last sentence before the reasoning block runs into the first
 * word after it. That half is asserted in "the tail is built backwards"; this
 * section is the other half, and each would pass with the other's rule installed.
 * ------------------------------------------------------------------ */

process.stdout.write("\nan event nobody draws does not break the message\n");
{
  let seq = 0;
  const at = (event: Record<string, unknown>): never =>
    ({ seq: (seq += 1), ts: seq * 1000, event }) as never;
  const say = (text: string): never => at({ type: "text", role: "agent", thought: false, text });
  const log = (line: string): never => at({ type: "agent_log", line });
  // codex's ~5-a-turn thread status, which falls into `onUpdate`'s `default:` arm
  // on the daemon and arrives here as an `other`.
  const other = (): never => at({ type: "other", sessionUpdate: "session_info_update", raw: null });
  const status = (value: string): never => at({ type: "status", status: value, exit: null });
  const turnEnd = (stopReason: string): never => at({ type: "turn_end", stopReason, usage: null });
  const call = (id: string): never =>
    at({
      type: "tool_call",
      toolCallId: id,
      title: id,
      kind: "other",
      status: "pending",
      locations: [],
      rawInput: null,
      parentToolCallId: null,
    });

  const texts = (events: readonly never[]): string[] =>
    buildTail(events, []).rows.map((row) => (row as { text?: string }).text ?? `[${row.kind}]`);

  {
    // The measured shape: an agent writing to stderr mid-sentence. Reverting the
    // flush to unconditional gives ["here is the pl", "an:"] — two paragraphs, no
    // row between them, and nothing on screen to say why the word broke.
    seq = 0;
    check(
      "an agent_log between two chunks does not split the sentence",
      texts([say("here is the pl"), log("[debug] tool resolved"), say("an:")]),
      ["here is the plan:"],
    );
    seq = 0;
    check("and it draws no row of its own", buildTail([say("a"), log("x"), say("b")], []).rows.length, 1);
  }

  {
    /*
     * codex's own case, and the one that fires several times per turn. A fenced
     * block is the fixture rather than a plain sentence because it is the visible
     * worst case: split here, the first half renders as an unterminated fence.
     */
    seq = 0;
    check(
      "nor does codex's session_info_update",
      texts([say("```ts\nconst a = 1;\n"), other(), say("```")]),
      ["```ts\nconst a = 1;\n```"],
    );
  }

  {
    // Every member of the set, not just the two that happen today: a `status` or
    // a `workspace` landing mid-turn has exactly the same claim on the run.
    seq = 0;
    check("a status line does not either", texts([say("one "), status("running"), say("two")]), ["one two"]);
  }

  {
    /*
     * The run keeps the **older** event's key, which is the risk this change
     * carries and is worth pinning rather than discovering: two nodes became one,
     * so the key of the surviving row is the first chunk's seq. Anything keyed on
     * the newer half would remount the message on every arriving token, which is
     * what shuts a card the reader had opened inside it.
     */
    seq = 0;
    check(
      "the merged run is one row, keyed by its first event",
      buildTail([say("a"), log("x"), say("b")], []).rows.map((row) => row.key),
      ["t1"],
    );
  }

  {
    /*
     * The boundaries that are real, and this is the half that fails if the flush
     * is keyed on `showsInTranscript` instead of on the set. `turn_end: end_turn`
     * draws no row *and* is a boundary — the message after it is a different
     * turn's — so the two rules disagree on exactly this fixture and only here.
     */
    seq = 0;
    check(
      "a turn ending still separates two turns",
      texts([say("first turn."), turnEnd("end_turn"), say("second turn.")]),
      ["first turn.", "second turn."],
    );
    seq = 0;
    check(
      "and a tool call still separates what it sits between",
      texts([say("before "), call("c1"), say("after")]),
      ["before ", "[tool]", "after"],
    );
  }

  {
    // Two silent events in a row, which is the ordinary case rather than a corner
    // — codex sends several a turn — and a rule that flushed on the second would
    // still look right on a single-event fixture.
    seq = 0;
    check(
      "a burst of them is still one message",
      texts([say("a"), log("x"), other(), log("y"), say("b")]),
      ["ab"],
    );
  }
}

process.stdout.write("\nwhat a machine's header says on its trailing edge\n");
{
  const group = (over: Record<string, unknown>): never =>
    ({ blockedCount: 0, reach: "online", tokenDegraded: false, liveCount: 0, ...over }) as never;

  check("nothing happening reads idle", machineSubline(group({})).kind, "idle");
  check("live sessions are counted", machineSubline(group({ liveCount: 5 })), { kind: "live", count: 5 });
  check("an unreachable machine says so", machineSubline(group({ reach: "offline" })).kind, "offline");
  check("a cached token says so", machineSubline(group({ tokenDegraded: true })).kind, "degraded");

  /*
   * The precedence, which is the whole reason this is a function. "5 live" must
   * not be the sentence that hides a session waiting on a human — a collapsed
   * section showing it is the one failure this screen exists to prevent.
   */
  check(
    "waiting beats a live count",
    machineSubline(group({ blockedCount: 2, liveCount: 5 })),
    { kind: "blocked", count: 2 },
  );
  // Deliberate: the header's own `Dot` still carries reachability, so nothing is
  // lost by this, and a hidden approval would be.
  check(
    "and beats an unreachable machine, whose dot still says offline",
    machineSubline(group({ blockedCount: 1, reach: "offline" })).kind,
    "blocked",
  );
  check(
    "a machine you cannot reach outranks which token was used to try",
    machineSubline(group({ reach: "offline", tokenDegraded: true })).kind,
    "offline",
  );
  check(
    "and a cached token outranks the ordinary count",
    machineSubline(group({ tokenDegraded: true, liveCount: 3 })).kind,
    "degraded",
  );

  // The two that earn the header's one warn colour.
  check(
    "only waiting and a cached token are warn-toned",
    (["blocked", "offline", "degraded", "idle", "live"] as const).map((kind) =>
      sublineWarns({ kind, count: 1 } as never),
    ),
    [true, false, true, false, false],
  );
}

process.stdout.write("\nwhose focus is worth keeping\n");
{
  const el = (over: Record<string, unknown>): unknown => ({
    tagName: "BUTTON",
    getAttribute: () => null,
    ...over,
  });

  /*
   * The clause that made autofocus dead on Chromium at `lg`: a session row is a
   * `<button>`, Chromium focuses buttons on click, and the old test was "anything
   * is focused at all". Confirmed not working in practice before it was narrowed.
   */
  check("a row button that merely took a click is not worth keeping", focusWorthKeeping(el({})), false);
  check("nor is nothing at all", [focusWorthKeeping(null), focusWorthKeeping(undefined)], [false, false]);
  check(
    "a text field somebody is typing in is",
    ["INPUT", "TEXTAREA", "SELECT"].map((tagName) => focusWorthKeeping(el({ tagName }))),
    [true, true, true],
  );
  check("so is a contenteditable", focusWorthKeeping(el({ isContentEditable: true })), true);
  // An *open* disclosure only. A collapsed one reads `"false"` and is a plain
  // button again, which is the distinction that keeps row buttons falling through.
  check(
    "an open menu is, and a closed one is not",
    [
      focusWorthKeeping(el({ getAttribute: (n: string) => (n === "aria-expanded" ? "true" : null) })),
      focusWorthKeeping(el({ getAttribute: (n: string) => (n === "aria-expanded" ? "false" : null) })),
    ],
    [true, false],
  );
}

/* ------------------------------------------------------------------ *
 * Who is working, what the box says, and who gets the caret
 * ------------------------------------------------------------------ */

process.stdout.write("\nwho is working, and what the box says\n");
{
  const session = (over: Record<string, unknown>): never =>
    ({
      status: "running",
      turn: 1,
      pendingPermissions: [],
      exit: null,
      agentSessionId: "a",
      resume: null,
      ...over,
    }) as never;

  check("a turn with nothing waiting on you is working", showsWorking(session({})), true);
  check("no turn is not", showsWorking(session({ turn: null })), false);
  // Raised mid-turn, so `turn` is still set while the agent is in fact waiting —
  // and the permission card two rows down says the opposite at full size.
  check(
    "a pending permission is not working, it is waiting for you",
    showsWorking(session({ status: "blocked", pendingPermissions: [{ permissionId: "p" }] })),
    false,
  );
  // `turn` is cleared in a `finally` a daemon that dies mid-turn never reaches.
  check(
    "and a session that ended mid-turn does not blink for ever",
    ["exited", "failed", "interrupted"].map((status) => showsWorking(session({ status }))),
    [false, false, false],
  );

  /*
   * The Stop control's own predicate, and the one difference from `showsWorking`
   * that matters: a session parked on a question is exactly where somebody most
   * wants out, and the daemon takes a cancel there — sweeping whatever is
   * parked — so a control drawn on `showsWorking` alone would be missing from the
   * state it exists for. Everything else the two agree about, which is what makes
   * the blocked row the whole assertion.
   */
  check("there is a turn to stop while the agent works", canCancelTurn(session({})), true);
  check(
    "and while it waits on you, which is where showsWorking says no",
    [
      canCancelTurn(session({ status: "blocked", pendingPermissions: [{ permissionId: "p" }] })),
      showsWorking(session({ status: "blocked", pendingPermissions: [{ permissionId: "p" }] })),
    ],
    [true, false],
  );
  check("nothing to stop with no turn", canCancelTurn(session({ turn: null })), false);
  check(
    "and nothing to stop on a session that has ended",
    ["exited", "failed", "interrupted"].map((status) => canCancelTurn(session({ status }))),
    [false, false, false],
  );
  /*
   * The one `isTerminal` does not cover, and it is not a moment: `turn` is
   * cleared in `pump`'s `finally`, which cannot run until the prompt generator
   * unwinds inside `dispose()` — a 5s cancel grace and a 2s close later. So a
   * session somebody stopped mid-turn carries `{status: "stopping", turn: 5}` for
   * seconds, the daemon refuses a cancel on it (`terminal || stopRequested`), and
   * a predicate reading `isTerminal` alone armed Stop across all of it onto a
   * guaranteed 409 and a red toast.
   */
  check("nor on one somebody is already stopping", canCancelTurn(session({ status: "stopping" })), false);
  check("which isTerminal does not say", isTerminal("stopping"), false);

  /*
   * Whether somebody has already asked. Read off the daemon's snapshot rather
   * than held in the tab, because the turn routinely outlives the request that
   * asked for it — an agent notices a cancel when it next looks up — and a button
   * that re-armed on the answer would invite a second tap at every stop.
   */
  check("nobody has asked yet", cancelInFlight(session({})), false);
  check("somebody has", cancelInFlight(session({ cancelRequestedAt: 1 })), true);
  /*
   * The migration, and it is the whole of it: an older daemon does not send the
   * field, and `undefined` has to read as "that daemon cannot say" rather than as
   * a cancel nobody asked for.
   */
  check("an older daemon that cannot say reads as no cancel", cancelInFlight(session({ cancelRequestedAt: undefined })), false);
  /*
   * Cleared with the turn on the daemon's side, so the pair cannot disagree —
   * asserted here because a client trusting `cancelRequestedAt` alone would draw
   * a permanently disabled Stop on an idle session.
   */
  check(
    "and a stale marker with no turn is not a cancel in flight",
    cancelInFlight(session({ turn: null, cancelRequestedAt: 1 })),
    false,
  );

  const say = (over: Record<string, boolean>): string =>
    composerPlaceholder({ blocked: false, reconnecting: false, working: false, ...over });
  check("an idle box asks for a message", say({}), "message…");
  check("a working one says so", say({ working: true }), "agent is working…");
  // Wins over `working`: it is the rarer fact, and the one explaining the spinner.
  check(
    "an in-flight send during a restart explains the wait",
    say({ working: true, reconnecting: true }),
    "reconnecting the agent…",
  );
  // Wins over both: nothing typed here moves until the card above is answered.
  check(
    "and a blocked one points at the request above",
    say({ working: true, reconnecting: true, blocked: true }),
    "answer the request above first",
  );
}

process.stdout.write("\nwho gets the caret on a session switch\n");
{
  const ask = (over: Record<string, boolean>): boolean =>
    shouldFocusComposer({
      hasBox: true,
      pointerCoarse: false,
      focusHeldElsewhere: false,
      blocked: false,
      fromKeyboardNav: false,
      ...over,
    });

  /*
   * **The missing half.** Declining to *take* the caret does nothing about one
   * taken a moment earlier: on a desktop the composer focuses itself when a
   * session opens, and a request that parks after that finds it already holding
   * focus — so `isTypingInto` switches every shortcut on the card off and the
   * numbers beside the answers do nothing.
   */
  check(
    "a parked request hands the caret back",
    shouldReleaseComposer({ blocked: true, focused: true, draftEmpty: true }),
    true,
  );
  check(
    "but never out from under a half-written message",
    shouldReleaseComposer({ blocked: true, focused: true, draftEmpty: false }),
    false,
  );
  check(
    "and there is nothing to hand back when nothing holds it",
    [
      shouldReleaseComposer({ blocked: true, focused: false, draftEmpty: true }),
      shouldReleaseComposer({ blocked: false, focused: true, draftEmpty: true }),
    ],
    [false, false],
  );

  check("a desktop switch onto a live session takes it", ask({}), true);
  // Each of these is a way it is *wrong*, so each is asserted on its own.
  check("an ended session has no box to focus", ask({ hasBox: false }), false);
  check("a phone would raise the keyboard over half the screen", ask({ pointerCoarse: true }), false);
  check("something that already has focus keeps it", ask({ focusHeldElsewhere: true }), false);
  check("a blocked session points at the request instead", ask({ blocked: true }), false);
  // The one that is not obvious: `isTypingInto` switches every bare shortcut off
  // once the composer has focus, so autofocusing after `j` breaks the next `j`.
  check("and `j`/`k` keep working for the next hop", ask({ fromKeyboardNav: true }), false);

  check("the flag starts down", takeKeyNav(), false);
  markKeyNav();
  check("the keyboard layer can raise it", takeKeyNav(), true);
  check("and reading it puts it down, so it cannot suppress the next switch", takeKeyNav(), false);
}

/* ------------------------------------------------------------------ *
 * The two helpers the extraction moved, and nothing asserted
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a collapsed row says, and what a fence hides\n");
{
  // Tool output is rendered in a `<pre>` rather than through the markdown
  // renderer — deliberately, since it is untrusted text from a repository — so an
  // unstripped fence reaches a person as three literal backticks.
  check("a fence wrapping the whole block is removed", stripFence("```console\nhi-there\n```"), "hi-there");
  check("a lone fence line is not a wrapper", stripFence("```"), "```");
  check(
    "and a fence in the middle is part of what the tool printed",
    stripFence("before\n```\ninner\n```"),
    "before\n```\ninner\n```",
  );
  check("text with no fence at all is untouched", stripFence("plain\noutput"), "plain\noutput");

  check(
    "a command is what a collapsed row says",
    toolSummary({ command: "ls -la" }, []),
    { summary: "ls -la", detail: "ls -la" },
  );
  check(
    "and with no arguments it falls back to the first location",
    toolSummary(null, [{ path: "/home/proj/notes.txt", line: 3 }]).summary,
    formatLocation({ path: "/home/proj/notes.txt", line: 3 }),
  );
  check("with neither, it says nothing rather than `{}`", toolSummary({}, []), {
    summary: null,
    detail: null,
  });

  /*
   * **The row shortens a path and never a command**, and the second half is the one
   * worth pinning.
   *
   * Reported off a phone: every session works inside one directory, so a `Read` row
   * drew that directory again on every line and `truncate` then removed the end —
   * the part that says which file. The three sites this was fixed at first
   * (`ChangeRow`, the `locations` list, the diff header) all missed *this* one,
   * which is where a reader actually looks, so the sentence "paths are relative now"
   * was true and useless.
   *
   * The refusal is the safety half. `COMMAND_FIELDS` is the string the agent ran;
   * rewriting it would draw a command that was never executed, which is the same
   * judgement `PermissionCard` makes when it renders one through a raw `<pre>`.
   */
  // The real `relFor`, not a stand-in: the rule under test is what a reader sees,
  // and a hand-written relativiser here could agree with the assertion while
  // disagreeing with `SessionView`, which wires this exact function in.
  const { relativeTo: relTo } = await import("../src/paths.js");
  const under = (root: string) => (path: string) => relTo(root, path);
  const ROOT = "/Users/me/proj";

  check(
    "a path under the workspace loses the prefix everything shares",
    toolSummary({ file_path: `${ROOT}/src/ui/EventList.tsx` }, [], under(ROOT)).summary,
    "src/ui/EventList.tsx",
  );
  check(
    "and so does the location it falls back to",
    toolSummary(null, [{ path: `${ROOT}/notes.txt`, line: 3 }], under(ROOT)).summary,
    "notes.txt:3",
  );
  /*
   * ⚠ The one that must never change. `ls -la /Users/me/proj/src` is what ran, and a
   * row reading `ls -la src` is a row describing a command nobody issued.
   */
  check(
    "a command is drawn as it ran, prefix and all",
    toolSummary({ command: `ls -la ${ROOT}/src` }, [{ path: `${ROOT}/src`, line: null }], under(ROOT)).summary,
    `ls -la ${ROOT}/src`,
  );
  // `TARGET_FIELDS` holds `url` and `uri` beside the path names and needs no special
  // case: nothing outside the root is relative to it, so it falls through unchanged.
  check(
    "a URL is not a path and is left alone",
    toolSummary({ url: "https://example.com/a/b" }, [], under(ROOT)).summary,
    "https://example.com/a/b",
  );
  check(
    "and a file outside the workspace keeps the prefix that locates it",
    toolSummary({ file_path: "/etc/hosts" }, [], under(ROOT)).summary,
    "/etc/hosts",
  );
  // The default answers `null` for everything, so the two callers that have no
  // `FileAccess` — `nameOfTool` among them — get exactly what they got before.
  check(
    "with no relativiser at all, nothing moves",
    toolSummary({ file_path: `${ROOT}/src/a.ts` }, []).summary,
    `${ROOT}/src/a.ts`,
  );

  /*
   * ⚠ **And the call site, because everything above passes without it.**
   *
   * The default third argument answers `null` for everything, which is what makes
   * the two callers with no `FileAccess` safe — and it is also what makes dropping
   * the argument at the one call site that *has* one completely silent. Measured:
   * with the relativiser deleted from `EventList`, every assertion above stayed
   * green and the row went back to drawing `/Users/rends/remoslop_agent…`, which is
   * the screenshot this whole change came from.
   *
   * That is the same shape as the defect itself. Three sites were fixed by reading
   * the code and this fourth was missed, so a pure-function check that cannot see
   * call sites would have certified the fix and shipped the bug. `webcheck` already
   * reads files off disk for exactly this class — see the notice, the fold and the
   * palette gate — and this joins them.
   */
  const eventList = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check("the row asks for a relative path", /toolSummary\([^;]*relFor/.test(eventList), true);
  check("and never takes the two-argument form", /toolSummary\(rawInput, locations\)/.test(eventList), false);
}

/* ------------------------------------------------------------------ *
 * Which files the composer will take
 *
 * Two client-side limits and nothing else. The per-session byte budget is the
 * daemon's, deliberately: this client cannot know it across a reload, so a
 * half-tracked copy would be wrong more often than useful and the daemon's own
 * refusal is what a chip shows instead.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich files the composer will take\n");
{
  const { admitFiles } = await import("../src/attach.js");
  const { MAX_UPLOAD_BYTES } = await import("../src/wire.js");

  // `File` needs a DOM; a plain object with the two fields the rule reads is the
  // honest stand-in in a driver that stubs `window` and nothing else.
  const file = (name: string, size: number): File => ({ name, size }) as File;
  const chip = (state: string, uploadId: string | null = null): never =>
    ({ state, uploadId }) as never;

  const ten = Array.from({ length: 10 }, (_, i) => chip("ready", `u_${i}`));
  // The boundary, not the middle: ten is the limit, so the eleventh is refused
  // while the first ten are not.
  const eleventh = admitFiles(ten, [file("k.txt", 10)]);
  check("the eleventh file is refused", eleventh.accepted.length, 0);
  check("and says why", eleventh.refused[0]?.reason, "too_many");
  check("the tenth is not", admitFiles(ten.slice(0, 9), [file("j.txt", 10)]).accepted.length, 1);

  check("exactly the cap is accepted", admitFiles([], [file("a.bin", MAX_UPLOAD_BYTES)]).accepted.length, 1);
  const over = admitFiles([], [file("a.bin", MAX_UPLOAD_BYTES + 1)]);
  check("one byte more is not", over.accepted.length, 0);
  check("and says why", over.refused[0]?.reason, "too_large");
  // A directory dropped on a picker arrives as a zero-byte entry.
  check("an empty file is refused", admitFiles([], [file("d", 0)]).refused[0]?.reason, "empty");

  // A picker handing back twelve when there is room for three must attach three
  // and say so, not refuse all twelve and make somebody pick again.
  const straddle = admitFiles(ten.slice(0, 8), [file("a", 1), file("b", 1), file("c", 1), file("d", 1)]);
  check("a batch over the limit accepts a prefix", straddle.accepted.map((f) => f.name), ["a", "b"]);
  check("and names the rest", straddle.refused.map((f) => f.file.name), ["c", "d"]);

  // The rule that would otherwise be decided differently in two places: a failed
  // chip is not going to be sent, so it must not hold a slot.
  const failed = Array.from({ length: 10 }, () => chip("failed"));
  check("a failed chip does not occupy a slot", admitFiles(failed, [file("a", 1)]).accepted.length, 1);
  check("an uploading one does", admitFiles(Array.from({ length: 10 }, () => chip("uploading")), [file("a", 1)]).accepted.length, 0);
}

/* ------------------------------------------------------------------ *
 * A file attached while the send was in flight
 *
 * `send` empties the chip list optimistically and `restoreAttachments` puts it
 * back when the daemon refuses — and that restore used to be an **assignment**,
 * which is only correct if nothing can be attached in between. Nothing stops it:
 * `onPaste`, `onDrop` and the paperclip all stay live, and `POST
 * /sessions/:id/prompt` is on the 90s slow-route budget, so the window is up to
 * a minute and a half wide.
 *
 * What an assignment cost is worse than a lost chip. The upload behind it keeps
 * streaming to completion against the daemon's per-session 100 files / 100 MiB,
 * and the entry carried the `cancel` closure — so `removeAttachment` and
 * `forgetAttachments` have nothing left to abort with, and there is no chip on
 * screen to press anyway. The person then retries the send and it goes without
 * the screenshot they attached, with nothing anywhere saying so.
 *
 * Driven through the module's own state rather than a copy of it: the map, its
 * version counter and the merge are the subject, and `restoreAttachments` is
 * exported precisely so this is assertable without a composer.
 * ------------------------------------------------------------------ */

process.stdout.write("\na file attached while the send was in flight\n");
{
  const { addAttachments, attachmentsFor, forgetAttachments, restoreAttachments } = await import("../src/attach.js");

  const key = "m_1/s_1" as never;
  // Only the fields the merge reads. `File` needs a DOM, and the rule under test
  // never touches it — same stand-in the admission cases one section up use.
  const chip = (localId: string, state = "ready"): never => ({ localId, state, uploadId: `u_${localId}` }) as never;
  const ids = (): string[] => attachmentsFor(key).map((item) => item.localId);

  {
    // The failure exactly: two chips are cleared by the optimistic send, a third
    // is pasted while the prompt is in flight, and the refusal restores. Under
    // the assignment this answered ["a","b"] — `c` gone from the map with its
    // upload still running and its `cancel` unreachable.
    forgetAttachments(key);
    addAttachments(key, [chip("c")]);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("a chip attached mid-send survives the restore", ids(), ["a", "b", "c"]);
  }

  {
    // Restored first, because they were attached first and that is the order the
    // refused message had them in — the one the retry has to reproduce.
    forgetAttachments(key);
    addAttachments(key, [chip("late")]);
    restoreAttachments(key, [chip("early")]);
    check("and the restored ones lead, in their own order", ids(), ["early", "late"]);
  }

  {
    // The ordinary path, where nothing was attached in between: a plain restore.
    // Asserted so the merge cannot be read as changing what the common case does.
    forgetAttachments(key);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("with nothing live it is the list as it was", ids(), ["a", "b"]);
  }

  {
    /*
     * Deduplicated by `localId`. Two restores can genuinely overlap — a refusal
     * arriving while a previous refusal's restore is on screen — and without this
     * one file is drawn twice under the same React key, which is the one shape a
     * list must never take.
     */
    forgetAttachments(key);
    addAttachments(key, [chip("a"), chip("c")]);
    restoreAttachments(key, [chip("a"), chip("b")]);
    check("a file already back is not drawn twice", ids(), ["a", "b", "c"]);
  }

  {
    // An empty restore is not a clear. `send` calls this with whatever it captured,
    // and a text-only message captured nothing — which must not delete a file
    // attached since.
    forgetAttachments(key);
    addAttachments(key, [chip("a")]);
    restoreAttachments(key, []);
    check("restoring nothing leaves what is there", ids(), ["a"]);
  }

  // Module state, shared with every later section that imports this file. Left as
  // it was found.
  forgetAttachments(key);
  check("and the fixture leaves nothing behind", attachmentsFor(key).length, 0);
}

/* ------------------------------------------------------------------ *
 * Which of the composer's writes may land late
 *
 * At `lg` a session switch does **not** remount `Composer`, so `text`, `echo`,
 * `busy`, `applying` and `dismissed` are one shared instance while `drafts` and
 * `attach.ts` are keyed. Everything that resolves after an await therefore has to
 * be split: the keyed halves are correct from anywhere, the shared ones belong to
 * whichever session is actually on screen. `onScreen()` is that question.
 *
 * Three callbacks in `Composer.tsx` need that split — `send`'s two continuations,
 * `applyValue`'s `.then`, and the one-tap callback `choose` hands it — and the
 * first got its guards while the two a few lines above it did not. `applyValue`'s
 * `.then` closed a **different** session's `/` menu when a config change landed
 * (`closeMenu` sets `dismissed`), and `choose`'s one-tap branch wrote A's
 * completion into B's visible box through `update` and then moved B's caret to
 * A's offset — after which an Enter aimed at retrying A's gesture sent A's text
 * to B's agent, since `submit` reads the live render's `sessionRef`. Both run
 * behind `POST /sessions/:id/config` on the 90s slow route, which is long enough
 * for a person to move.
 *
 * And the fourth site is the opposite defect: `send` is reachable from **both**
 * doors, and asking `onScreen()` on the synchronous one made the ordinary Send
 * depend on the `[key]` effect having flushed. In that window the message goes to
 * the daemon while the box is left full, no echo is drawn and no spinner lights —
 * "it did not send", and a duplicate. So `send` takes `late` explicitly, required
 * with no default for the reason `LaunchOptions.fileIo` is: a new call site has
 * to decide, and deleting the argument is a type error rather than a silent one.
 *
 * Read off disk, because a component cannot be rendered here — no DOM and no
 * React — and none of this is a value a pure function returns. It is the same
 * argument the `SessionBrowser` extraction above makes and the `cpctl` one at the
 * foot of this file: compare behaviour where that is possible, and pin the one
 * line that decides it where it is not. Comments are stripped first, so what is
 * measured is code rather than the prose explaining it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich of the composer's writes may land late\n");
{
  const composer = readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8");
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  /** The source between an opening anchor and the next `end`, code only. */
  const region = (from: string, end: string): string => {
    const at = composer.indexOf(from);
    if (at < 0) return "";
    const to = composer.indexOf(end, at + from.length);
    return code(composer.slice(at, to < 0 ? composer.length : to));
  };

  /*
   * `send`'s two doors, named at the call sites rather than inferred inside it.
   * A default would make the deferred door the silent one, which is the direction
   * that loses a message into another session's box.
   */
  check(
    "send is told whether it is arriving late",
    /const send = \(body: string, late: boolean\): void =>/.test(composer),
    true,
  );
  check("the keystroke door says it is not", /send\(text\.trim\(\), false\)/.test(composer), true);
  check("and the config-round-trip door says it is", /send\(rest, true\)/.test(composer), true);
  /*
   * The short-circuit is the assertion, not merely the guard: with a bare
   * `if (onScreen())` the synchronous door asks a question answered from an
   * effect, and `onScreen`'s own docblock — "only ever asked after an await" —
   * becomes a claim about call sites that nothing holds.
   */
  check(
    "so the shared instance is written unconditionally on the synchronous one",
    /if \(!late \|\| onScreen\(\)\) \{/.test(composer),
    true,
  );

  /*
   * `applyValue`'s own late writes. `setApplying` is the spinner on a control
   * strip and `closeMenu` sets `dismissed`, and both belong to the session the
   * change was dispatched against.
   */
  const apply = region("const applyValue = ", "const choose = ");
  check("a config change that lands late asks whose composer this is", /onScreen\(\)/.test(apply), true);
  check("before it clears the control's spinner", /if \(present\) setApplying\(null\)/.test(apply), true);
  check("and before it closes a menu", /if \(ok && present\) closeMenu\(\)/.test(apply), true);
  /*
   * `onDone` is called either way. Its own body decides what a late answer means
   * — every one of them is keyed — and skipping it would drop the draft edit the
   * one-tap path defers, i.e. lose the completion rather than misplace it.
   */
  check("the deferred callback still runs whatever the answer is", /^\s*onDone\?\.\(ok\);/m.test(apply), true);

  /*
   * `choose`'s one-tap branch, which is the sibling the prompt-path fix missed.
   * Asserted by *order* rather than by the presence of a string: `update` and
   * `pendingCaret` both have to sit behind the test, and an edit that reinstated
   * either above it would still contain both tokens.
   */
  const oneTap = region("applyValue(entry.option, entry.value, (ok) => {", "\n      return;");
  const guardAt = oneTap.indexOf("onScreen()");
  check("the one-tap completion asks before writing the box", guardAt >= 0, true);
  report(
    "and both shared writes sit behind that test",
    guardAt >= 0 &&
      guardAt < oneTap.indexOf("update(next.text)") &&
      guardAt < oneTap.indexOf("pendingCaret.current = next.caret"),
    `guard at ${guardAt}, update at ${oneTap.indexOf("update(next.text)")}, caret at ${oneTap.indexOf("pendingCaret.current = next.caret")}`,
  );
  /*
   * The keyed half is unconditional, and that is the whole point of splitting
   * rather than simply dropping the write: the completion belongs to the session
   * it was typed in, so it goes into that session's draft and is waiting there
   * when somebody comes back. `pendingCaret` is a position *in the box*, so it
   * has no keyed half and correctly has none here.
   */
  check("while the draft is still written for the session it was typed in", /drafts\.set\(key, next\.text\)/.test(oneTap), true);
  check("and cleared rather than left stale when the completion is empty", /drafts\.delete\(key\)/.test(oneTap), true);

  /*
   * **A late-write gate is only half a rule, and the other half is the reset.**
   *
   * Everything above pins that a shared flag is not written by a request that
   * arrived after a session switch. What none of it says is that the flag is
   * *cleared* on that switch — and for `busy` both halves have always existed,
   * with the effect's own comment explaining why the second is needed. `stopping`
   * arrived with the gate and without the reset, and the ending is worse than
   * `busy`'s because nothing can recover it: while it is set the send slot draws
   * a "Stopping" spinner instead of the Stop button, so no tap can reach
   * `cancelTurn`, whose own `if (stopping) return` refuses anyway — the one path
   * to the `finally` that would release it. Every session opened in that tab
   * afterwards showed a spinner where Send belongs.
   *
   * Asserted as the *pair*, on the effect's own region, so a future shared flag
   * given one and not the other fails here rather than on somebody's phone.
   */
  const onSwitch = region("liveKey.current = key;", "}, [key]);");
  for (const [what, token] of [
    ["a send", "setBusy(false)"],
    ["a control change", "setApplying(null)"],
    ["a cancel", "setStopping(false)"],
  ] as const) {
    check(`switching session forgets ${what} dispatched against the last one`, onSwitch.includes(token), true);
  }
}

/* ------------------------------------------------------------------ *
 * What a nameless file gets called
 *
 * The case this exists for is Ctrl+V of a screenshot, which is how an image is
 * attached on a desktop. Most browsers hand back `image.png`, but not all and
 * not from every source — and the daemon refuses an empty name with `400
 * invalid_name`, so without this the commonest desktop path would fail with an
 * opaque error.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a nameless file gets called\n");
{
  const { pastedName } = await import("../src/attach.js");
  // 2026-08-04T09:15:30Z, fixed so the assertion is about the shape.
  const at = Date.UTC(2026, 7, 4, 9, 15, 30);

  // A name the browser gave us always wins. Nothing is invented over it.
  check("a real name is kept", pastedName("shot.png", "image/png", at), "shot.png");
  check("even an odd one", pastedName("Screen Shot 2026.png", "image/png", at), "Screen Shot 2026.png");
  check("whitespace around it is not a name", pastedName("   ", "image/png", at), "pasted-20260804-091530.png");

  check("a nameless png", pastedName("", "image/png", at), "pasted-20260804-091530.png");
  // Spelled rather than derived: the subtype would give `.jpeg`.
  check("a jpeg gets the extension people expect", pastedName("", "image/jpeg", at), "pasted-20260804-091530.jpg");
  check("a subtype with a suffix is not one", pastedName("", "image/svg+xml", at), "pasted-20260804-091530.svg");
  // Derived, and right far more often than a table would be.
  check("an unlisted type takes its subtype", pastedName("", "application/pdf", at), "pasted-20260804-091530.pdf");
  check("a parameter on the type is ignored", pastedName("", "text/csv; charset=utf-8", at), "pasted-20260804-091530.csv");
  // Nothing usable to derive from still has to produce a storable name, because
  // the alternative is the 400 this function exists to avoid.
  check("no type at all still gets a name", pastedName("", "", at), "pasted-20260804-091530.bin");
  check("and neither does a malformed one", pastedName("", "not-a-mime", at), "pasted-20260804-091530.bin");

  // The name it produces has to survive the daemon's own sanitizer, which
  // refuses control characters and path separators. This is the assertion that
  // ties the two ends together.
  const generated = pastedName("", "image/png", at);
  check("what it generates is a single safe segment", /^[A-Za-z0-9._-]+$/.test(generated), true);
}

/* ------------------------------------------------------------------ *
 * What may be drawn inline, and what may only be saved
 *
 * Two of these three rules are security decisions. `image/svg+xml` is absent
 * from the allowlist on purpose: SVG is a document format that can carry
 * `<script>`, and the only thing between that and this origin is `<img>`
 * disabling scripting for it — a promise about engine behaviour rather than
 * about our code. Four raster types cost nothing and do not depend on it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat may be drawn inline\n");
{
  const { previewable, MAX_PREVIEW_BYTES } = await import("../src/preview.js");

  check("a png draws", previewable("image/png", 1024), true);
  check("a jpeg draws", previewable("image/jpeg", 1024), true);
  check("a gif draws", previewable("image/gif", 1024), true);
  check("a webp draws", previewable("image/webp", 1024), true);
  // The assertion that earns the allowlist. It still downloads; it never renders.
  check("an svg never draws", previewable("image/svg+xml", 1024), false);
  check("nor does a pdf", previewable("application/pdf", 1024), false);
  check("nor does text", previewable("text/plain", 1024), false);
  // Not `image/*`, which would admit svg and whatever the registry grows next.
  check("nor an unknown image type", previewable("image/avif", 1024), false);

  check("a parameter on the type is ignored", previewable("image/png; charset=binary", 1024), true);
  check("and case is", previewable("IMAGE/PNG", 1024), true);

  // The budget: these bytes are pulled automatically, through the relay, onto a
  // phone, for something somebody may only be scrolling past.
  check("exactly at the cap still draws", previewable("image/png", MAX_PREVIEW_BYTES), true);
  check("one byte over does not", previewable("image/png", MAX_PREVIEW_BYTES + 1), false);
  // An unknown size is precisely the one that must not be fetched, so it is
  // refused rather than treated as small.
  check("a zero size does not", previewable("image/png", 0), false);
  check("nor does a nonsense one", previewable("image/png", Number.NaN), false);
  // A workspace file has no declared type at all — the daemon never echoes one.
  check("and neither does a file with no type", previewable(null, 1024), false);
}

/* ------------------------------------------------------------------ *
 * What is sent with a prompt
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat is sent with a prompt\n");
{
  const { sendableAttachments } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null = null): never => ({ state, uploadId }) as never;

  check("ready chips are sent, in order", sendableAttachments([chip("ready", "u_2"), chip("ready", "u_1")]).ids, [
    "u_2",
    "u_1",
  ]);
  // Blocked is a *visible* refusal: sending now would send the message without
  // the file somebody attached to it.
  check("an upload in flight blocks", sendableAttachments([chip("uploading")]).blocked, true);
  // And a failed one does not, or there would be no way out but removing it.
  check("a failed one does not", sendableAttachments([chip("failed")]).blocked, false);
  check("and is not sent", sendableAttachments([chip("ready", "u_1"), chip("failed")]).ids, ["u_1"]);
  // The impossible state, refused rather than trusted: it would send an empty
  // list under a message that says it has files.
  check("ready with no id never reaches the wire", sendableAttachments([chip("ready", null)]).ids, []);
}

/* ------------------------------------------------------------------ *
 * Whether a message can be sent at all
 *
 * Text **or** files. A message that is only a screenshot is an ordinary thing to
 * send, and the composer refused it for a while because the only guard was on the
 * text — the daemon refused it too, before it had even looked at `attachments`.
 * Both sides changed together, and this is the client's half.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhether a message can be sent at all\n");
{
  const { canSend } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null = null): never => ({ state, uploadId }) as never;

  check("text alone sends", canSend("hello", []), true);
  check("a file alone sends", canSend("", [chip("ready", "u_1")]), true);
  check("both send", canSend("look", [chip("ready", "u_1")]), true);
  check("neither does not", canSend("", []), false);
  // Whitespace is not a message, and never was.
  check("nor does whitespace alone", canSend("   \n ", []), false);

  // `blocked` outranks everything: for a files-only message, sending mid-upload
  // would deliver nothing at all.
  check("an upload in flight holds the send", canSend("hello", [chip("uploading")]), false);
  check("even with a ready file beside it", canSend("", [chip("ready", "u_1"), chip("uploading")]), false);
  // A failed chip is not going to finish, so it must not hold Send hostage —
  // there would be no way out but removing it.
  /*
   * The turn, and it is here because the composer was offering a send the daemon
   * could only refuse. `ManagedSession.prompt` answers `busy` while a turn is
   * open — a parked question keeps one open — so every message typed then came
   * back `409 turn_in_flight` as a red toast, under a button whose own tooltip
   * claimed it queued. Nothing queues anywhere in this system.
   */
  check("a turn in flight refuses the send", canSend("hello", [], true), false);
  check("and so does a parked question, which is the same open turn", canSend("hello", [chip("ready", "u_1")], true), false);
  check("with no turn it is the rule it always was", canSend("hello", [], false), true);
  check("and the argument defaults to off, so nothing else had to change", canSend("hello", []), true);

  check("a failed chip does not", canSend("hello", [chip("failed")]), true);
  // But it is not a message either.
  check("and cannot be the whole message", canSend("", [chip("failed")]), false);
}

/* ------------------------------------------------------------------ *
 * A path inside the workspace, and one outside it
 *
 * `file_change` and `FileLocation` carry absolute, agent-chosen paths; the
 * download route takes one relative to the workspace root. A location that does
 * not convert draws no button at all — this repo's own paperclip rule, one
 * screen over.
 * ------------------------------------------------------------------ */

process.stdout.write("\na path inside the workspace, and one outside it\n");
{
  const { downloadablePath, filenameFor, formatBytes, relativeTo } = await import("../src/paths.js");

  check("an ordinary path", relativeTo("/w", "/w/a/b.ts"), "a/b.ts");
  check("a trailing slash on the root is the same answer", relativeTo("/w/", "/w/a.ts"), "a.ts");
  // The assertion that earns the function: a bare `startsWith` says "a".
  check("a prefix is not a boundary", relativeTo("/w", "/workspace/a"), null);
  check("the root itself is not a file", relativeTo("/w", "/w"), null);
  check("nor is a directory under it", relativeTo("/w", "/w/sub/"), null);
  check("a path elsewhere converts to nothing", relativeTo("/w", "/etc/passwd"), null);
  check("and neither does one that climbs out", relativeTo("/w", "/w/../etc/passwd"), null);
  check("an already-relative path passes through", relativeTo("/w", "a.ts"), "a.ts");
  check("unless it climbs", relativeTo("/w", "../a"), null);
  check("or contains a dot segment", relativeTo("/w", "a/./b"), null);

  // Forced rather than chosen: the daemon sends no `access-control-expose-headers`,
  // so `content-disposition` is unreadable cross-origin and the name has to come
  // from the path we asked for.
  check("the name is the last segment", filenameFor("a/b/c.png"), "c.png");
  check("a bare name is itself", filenameFor("c.png"), "c.png");
  check("a directory has none", filenameFor("a/"), null);
  check("and neither does nothing", filenameFor(""), null);

  /*
   * Which inline code spans in agent prose become a download.
   *
   * The measured claim this rests on: across every session in one real database,
   * agent prose held 55 path-shaped strings and 4 were inside their session's
   * workspace — one session printed 39 and would show nothing. It is the
   * containment test, not a guess at intent, that keeps the transcript quiet.
   */
  const touched = new Set(["/w/out.png", "/w/sub/a.svg", "/elsewhere/x.png"]);
  check("a file the session made", downloadablePath("/w/out.png", "/w", touched), "out.png");
  check("nested", downloadablePath("/w/sub/a.svg", "/w", touched), "sub/a.svg");
  // Relative spans are resolved against the root before being compared, because
  // what the daemon reported is absolute.
  check("a relative span resolves first", downloadablePath("sub/a.svg", "/w", touched), "sub/a.svg");

  // The filter that does the work: mentioned, but not ours.
  check("a path outside the workspace is not offered", downloadablePath("/elsewhere/x.png", "/w", touched), null);
  // The second filter: inside the workspace, but this session never touched it.
  check("nor is one the session never touched", downloadablePath("/w/never.png", "/w", touched), null);

  // Inline code holds commands far more often than filenames, and whitespace
  // removes almost all of them in one rule.
  check("a command is not a path", downloadablePath("git commit -m x", "/w", touched), null);
  check("nor is prose with a slash", downloadablePath("and/or something", "/w", touched), null);
  // A bare filename counts, because `touched` is what decides — requiring a slash
  // was standing in for "looks like a path" and rejected the shorter reference an
  // agent naturally makes to a file it just named in full.
  check("a bare filename in the set counts", downloadablePath("out.png", "/w", touched), "out.png");
  check("a bare word that is not is refused", downloadablePath("npm", "/w", touched), null);
  check("nor is an empty span", downloadablePath("", "/w", touched), null);
  // The span is agent-chosen, so the traversal case is refused by `relativeTo`
  // even when somebody puts it in the touched set.
  check("and a climb out is refused", downloadablePath("/w/../etc/passwd", "/w", new Set(["/w/../etc/passwd"])), null);

  check("bytes read as bytes", formatBytes(512), "512 B");
  check("and scale", formatBytes(2048), "2.0 KB");
  // Binary divisors with decimal labels, which is the convention `paths.ts` picked
  // and which is why the per-file cap reads as a round number rather than as 105.
  check("to something a chip can hold", formatBytes(100 * 1024 * 1024), "100 MB");
}

/* ------------------------------------------------------------------ *
 * A session the daemon ended, and how it is presented
 * ------------------------------------------------------------------ */

process.stdout.write("\nsessions the daemon interrupted\n");
{
  const {
    AGENT_LIVE_STATUSES,
    DAEMON_EXIT_REASONS,
    FINAL_EXIT_REASONS,
    TERMINAL_STATUSES,
    countsAsLive,
    endedWithDaemon,
    resumeStalled,
    showsAsEnded,
    waitingForDaemon,
  } = await import("../src/wire.js");
  type ExitReason = Parameters<typeof endedWithDaemon>[0] extends { reason: infer R } | null | undefined
    ? R
    : never;

  const REASONS = [
    "stopped",
    "agent_exited",
    "start_failed",
    "start_timeout",
    "daemon_shutdown",
    "agent_kill_failed",
    "daemon_restarted",
    "config_changed",
    "agent_signed_out",
  ] as const;

  /*
   * The other two shapes the extraction below pins, listed here for the same
   * reason `REASONS` is: written out once, so the compiler ties them to the
   * *client's* unions (`isTerminal`/`hasLiveAgent` take a `SessionStatus`,
   * `gapPlan` takes a `LaggedFrame["reason"]`) while the checks tie the same
   * list to the daemon's source. Neither half is worth anything alone.
   */
  const STATUSES = ["starting", "idle", "running", "blocked", "stopping", "exited", "failed", "interrupted"] as const;
  const LAG_REASONS = ["evicted", "slow_consumer", "backlog"] as const;

  /*
   * The mirror against the thing it mirrors, read off disk.
   *
   * `wire.ts` is the daemon's vocabulary copied by hand — it cannot import
   * `src/events.ts`, for the module-resolution reason that file's own header
   * gives — and the copy is only worth having while it *is* the copy. It was not,
   * for exactly one release: `config_changed` was added to the daemon's
   * `DAEMON_EXIT_REASONS` and not to the client's, so a session the daemon was
   * restarting on purpose fell out of `waitingForDaemon` into `showsAsEnded`,
   * which takes the composer off the screen — the one outcome that partition
   * exists to make impossible for a conversation that is coming back. Every
   * assertion in this section passed throughout, because they all read the same
   * wrong copy.
   *
   * Both halves are compared: the union, so a reason cannot be added on one side
   * only, and the list, so it cannot be classified differently on the two sides.
   *
   * ⭐ **And `ExitReason` was never the only thing worth pinning** — it was only
   * the thing that had already broken. `wire.ts` carries ~109 exports and is
   * edited in most of the commits that touch this package, and the two checks
   * above were the whole of the cross-package coverage. The blocks below are the
   * same technique aimed at the shapes whose drift is silent and expensive: the
   * status union every list, dot and control keys on; the two arrays that
   * classify it; and the `lagged` reason, where confusing `backlog` with a real
   * loss draws a hole over an intact conversation.
   */
  {
    const daemon = readFileSync(new URL("../../../src/events.ts", import.meta.url), "utf8");
    const union = daemon.slice(daemon.indexOf("export type ExitReason ="));
    const members = [...union.slice(0, union.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("every exit reason the daemon can write is in the client's union", members.sort(), [...REASONS].sort());

    const listed = daemon.slice(daemon.indexOf("export const DAEMON_EXIT_REASONS"));
    const daemonSide = [...listed.slice(0, listed.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("and the two sides agree on which of them mean the daemon went away", daemonSide.sort(), [
      ...DAEMON_EXIT_REASONS,
    ].sort());

    /*
     * And the complement, which is what `endedWithDaemon` actually tests.
     *
     * The predicate is `!FINAL_EXIT_REASONS.includes(...)` rather than
     * `DAEMON_EXIT_REASONS.includes(...)`, so that a reason from a newer daemon —
     * one this tab has never heard of — reads as "coming back" instead of taking
     * the composer off the screen. That inversion is only safe while the two
     * lists genuinely partition the daemon's union: a member missing from *both*
     * would now be silently treated as a daemon restart, where before it was
     * silently treated as ended. So the partition is asserted rather than assumed,
     * in both directions.
     */
    check(
      "the two exit-reason lists partition the daemon's union",
      [...DAEMON_EXIT_REASONS, ...FINAL_EXIT_REASONS].sort(),
      [...members].sort(),
    );
    check(
      "and nothing is in both",
      DAEMON_EXIT_REASONS.filter((reason) => FINAL_EXIT_REASONS.includes(reason)),
      [],
    );
    /*
     * The runtime property the partition exists for, stated directly: a reason
     * invented after this build keeps the composer on screen.
     */
    check(
      "an exit reason from a newer daemon reads as coming back, not as ended",
      endedWithDaemon({ reason: "something_invented_later" as ExitReason }),
      true,
    );

    /*
     * `SessionStatus`, read the same way but off a **stripped** copy, which the
     * two above do not need and this one does. `interrupted`'s docblock contains
     * a semicolon — *"`{@link endedWithDaemon}` is the one rule now; `exit.reason`
     * still says which of the two happened"* — so slicing the raw text to the
     * first `;` stops inside the explanation and drops the member it explains.
     * Measured on this check's first run: seven members where there are eight,
     * and the one missing was `interrupted`, which is the status this whole
     * section is about.
     */
    const daemonCode = daemon.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const statusUnion = daemonCode.slice(daemonCode.indexOf("export type SessionStatus ="));
    const statusMembers = [...statusUnion.slice(0, statusUnion.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    check("every status the daemon derives is in the client's union", statusMembers.sort(), [...STATUSES].sort());

    /*
     * The two classification arrays over that union. There is no daemon-side
     * copy of them — the daemon derives `status` and says nothing about which of
     * them are terminal or have an agent on the other end — so what is asserted
     * is that they are subsets of the union just read off `events.ts`, and that
     * the three of them **partition** it.
     *
     * The subset half is what catches a member invented on the client; the
     * partition half is what catches a status added on the *daemon*, which
     * otherwise lands in neither array in silence and draws as a row with no
     * controls and no ended treatment either.
     */
    check(
      "and TERMINAL_STATUSES holds exactly the ones isTerminal answers for",
      STATUSES.filter((status) => isTerminal(status)).sort(),
      [...TERMINAL_STATUSES].sort(),
    );
    check(
      "and AGENT_LIVE_STATUSES exactly the ones hasLiveAgent answers for",
      STATUSES.filter((status) => hasLiveAgent(status)).sort(),
      [...AGENT_LIVE_STATUSES].sort(),
    );
    check(
      "and the only statuses that are neither are the two transitional ones",
      STATUSES.filter((status) => isTerminal(status) === hasLiveAgent(status)).sort(),
      ["starting", "stopping"],
    );
  }

  /*
   * `LaggedFrame["reason"]`, whose daemon side is in `server.ts` rather than
   * `events.ts` and is written in two places — which is the whole reason it is
   * read in two. The attach path builds its two frames with the reason as a
   * literal; `collapse` takes its reason as an argument, so the only place those
   * words are written down is its signature.
   *
   * Comments are stripped first because one of them quotes `reason: "backlog"`
   * while explaining the split, and a pin that reads the explanation instead of
   * the code survives deleting the code.
   *
   * What it costs to be wrong here is the failure `gapPlan`'s docblock records:
   * a `backlog` filed as a loss draws "N events not shown (beyond retention)"
   * over a conversation that is entirely intact.
   */
  {
    const server = readFileSync(new URL("../../../src/server.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const written = [...server.matchAll(/type: "lagged",[\s\S]{0,240}?reason: "([a-z_]+)"/g)].map((m) => m[1]);
    const signature = "private collapse(reason:";
    const sig = server.includes(signature) ? server.slice(server.indexOf(signature)) : "";
    const argued = [...sig.slice(0, sig.indexOf(")")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    // Both anchors asserted, so a rename fails naming the writer that moved
    // rather than passing on an empty sweep.
    check("the daemon still writes lagged reasons as literals", written.length > 0, true);
    check("and still names the rest in collapse's own signature", argued.length > 0, true);
    check(
      "every reason the daemon can lag with is in the client's union",
      [...new Set([...written, ...argued])].sort(),
      [...LAG_REASONS].sort(),
    );
    // The other half, and it is the compiler's: `gapPlan` takes the client's
    // union, so a reason the client does not have fails `tsc` on this line.
    check(
      "and the client plans for each of them",
      LAG_REASONS.map((reason) => gapPlan(reason, 4_000).kind),
      ["record", "record", "restart"],
    );
  }

  check("a daemon shutdown is the daemon going away", endedWithDaemon({ reason: "daemon_shutdown" }), true);
  check("and so is a crash", endedWithDaemon({ reason: "daemon_restarted" }), true);
  check("a stop is not", endedWithDaemon({ reason: "stopped" }), false);
  check("nor is an agent quitting by itself", endedWithDaemon({ reason: "agent_exited" }), false);
  check("nor a failed start", [endedWithDaemon({ reason: "start_failed" }), endedWithDaemon({ reason: "start_timeout" })], [false, false]);
  check("nor an ambiguous legacy kill", endedWithDaemon({ reason: "agent_kill_failed" }), false);
  check("and a live session has no exit to ask about", [endedWithDaemon(null), endedWithDaemon(undefined)], [false, false]);
  /*
   * Exhaustiveness, which the daemon gets from a `default`-less switch and this
   * mirror cannot: `DAEMON_EXIT_REASONS` is a plain array here, so a reason
   * added to the union would otherwise be classified `false` in silence. This
   * fails the driver instead.
   */
  check(
    "every reason in the union is accounted for",
    REASONS.filter((reason) => endedWithDaemon({ reason })).sort(),
    [...DAEMON_EXIT_REASONS].sort(),
  );

  const sessionOf = (over: Record<string, unknown>) => ({ ...snapshot, ...over }) as never;

  /*
   * The partition. Three predicates decide what a terminal row looks like, and
   * they are only correct *together*: exactly one must hold for any terminal
   * session and none for a live one. Asserted as a property over the whole
   * matrix rather than case by case, because the way this breaks is a new state
   * falling into two buckets at once — visible as a row that is both in Active
   * and in Ended, which no individual case would catch.
   */
  const matrix: Record<string, unknown>[] = [];
  for (const status of ["running", "idle", "exited", "failed", "interrupted"]) {
    for (const reason of REASONS) {
      for (const agentSessionId of ["a_1", null]) {
        for (const state of [undefined, "waiting", "running", "failed"]) {
          matrix.push({
            status,
            agentSessionId,
            exit: status === "running" || status === "idle" ? null : { reason },
            resume: state === undefined ? undefined : { state, attempts: 1, error: null, at: 0 },
          });
        }
      }
    }
  }
  const broken = matrix.filter((over) => {
    const session = sessionOf(over);
    const hits = [waitingForDaemon(session), resumeStalled(session), showsAsEnded(session)].filter(Boolean).length;
    return (over["status"] === "running" || over["status"] === "idle") ? hits !== 0 : hits !== 1;
  });
  check("exactly one presentation holds for every terminal session", broken.length, 0);

  // The row a deploy actually produces, pinned on its own — a `status`-keyed
  // implementation reads this as `exited` and draws "nothing is happening" over
  // a conversation that is coming back.
  const deployed = sessionOf({ status: "exited", exit: { reason: "daemon_shutdown" }, agentSessionId: "a_1" });
  check("a graceful restart is waiting, not ended", [waitingForDaemon(deployed), showsAsEnded(deployed)], [true, false]);
  check("and it still counts as live", countsAsLive(deployed), true);

  const givenUp = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "x" }, at: 0 },
  });
  check("one the daemon gave up on is stalled", [resumeStalled(givenUp), showsAsEnded(givenUp)], [true, false]);
  check("and stops counting as live", countsAsLive(givenUp), false);

  // Absence must read as "waiting", never "failed". An older daemon sends no
  // field and resumes nothing, so the inverse default would put a red banner on
  // every ended session in the fleet.
  const older = sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: "a_1" });
  check("no resume field yet reads as waiting", [waitingForDaemon(older), resumeStalled(older)], [true, false]);

  // Nothing to reattach to is stalled rather than ended: the daemon still went
  // away underneath somebody, and "ended" would be answering a question they
  // did not ask.
  const nothingToResume = sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: null });
  check("and nothing to reattach to is stalled, not ended", resumeStalled(nothingToResume), true);

  /* ---- how long a machine has been away ---- */

  /*
   * ⚠ **"Offline" was one word for a lid that closed a minute ago and a host that
   * died last week.** Presence is deleted on disconnect — that is what makes it
   * presence — so nothing outlived it, and the first question anybody has about a
   * machine that is not answering had no answer anywhere in the product.
   *
   * The three silences are the whole of this function and they are three
   * different facts, which is why they are asserted apart rather than as "returns
   * null sometimes".
   */
  const { lastSeenText } = await import("../src/wire.js");
  const now = 1_800_000_000_000;

  // A control plane that predates the field. Saying "never seen" here would be a
  // claim about a fleet that is working fine.
  check("an older control plane says nothing", lastSeenText(undefined, now), null);
  // Nothing has ever recorded a tunnel. The row already says "waiting for the
  // daemon to dial in", which is the same fact with a remedy attached.
  check("and a machine that never dialled in says nothing either", lastSeenText(null, now), null);
  // Under two minutes is a machine somebody is watching drop; "0 min ago" is a
  // number pretending to be information, and the poll interval is the same size.
  check("nor does one that went away seconds ago", lastSeenText(now - 4_000, now), null);

  check("minutes are minutes", lastSeenText(now - 20 * 60_000, now), "last seen 20 min ago");
  check("hours are hours", lastSeenText(now - 5 * 3_600_000, now), "last seen 5 h ago");
  check("and a machine that has been gone for days says so", lastSeenText(now - 9 * 86_400_000, now), "last seen 9 days ago");
  /*
   * The boundary in both directions, because a coarsening function is exactly
   * where an off-by-one produces "last seen 90 min ago" beside "last seen 2 h
   * ago" for two seconds apart.
   */
  check(
    "each step hands over cleanly",
    [lastSeenText(now - 5_399_000, now), lastSeenText(now - 5_401_000, now)],
    ["last seen 90 min ago", "last seen 2 h ago"],
  );
  // A clock that ran backwards — a phone whose time was corrected — must not
  // produce a negative age.
  check("and a future stamp is not a negative age", lastSeenText(now + 60_000, now), null);
}

process.stdout.write("\nwhat an interrupted session says\n");
{
  const { resumeFailureText, resumeRetryable, sessionNotice, statusTone } = await import("../src/ui/bits.js");
  const sessionOf = (over: Record<string, unknown>) => ({ ...snapshot, ...over }) as never;

  const stopped = sessionOf({
    status: "exited",
    exit: { reason: "stopped", detail: null, agentConfirmedDead: true },
  });
  const deployed = sessionOf({ status: "exited", exit: { reason: "daemon_shutdown" }, agentSessionId: "a_1" });
  const stalled = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: { state: "failed", attempts: 3, error: { code: "agent_auth_required", message: "x" }, at: 0 },
  });

  const { exitText } = await import("../src/ui/bits.js");
  /*
   * **Every reason this line can reach has a sentence, and the fallback is the
   * proof rather than the safety net.**
   *
   * `exitText`'s unknown arm draws `ended: <reason>`, which is what the whole line
   * used to be — so asserting that no reason *reachable here* falls to that arm is
   * the same assertion as "there are no raw enums left on this screen", stated as
   * a property instead of five strings. `agent_signed_out` and the three daemon
   * reasons are excluded because `sessionNotice` answers them above this line and
   * they cannot arrive at it; the exclusion is asserted one screen down, by the
   * two checks that they say something else entirely.
   *
   * Against the fallback's exact shape and **not** `includes(reason)`, which was
   * the first attempt and is a worse test than no test: `stopped` reads "you
   * stopped this conversation", so the identifier is a substring of a perfectly
   * good sentence. What is wrong is a reason printed *as* its identifier, and
   * that is one string comparison.
   */
  const reachable = ["stopped", "agent_exited", "start_failed", "start_timeout", "agent_kill_failed"] as const;
  check(
    "every exit reason a person can be shown has a sentence of its own",
    reachable.filter((reason) => exitText(reason) === `ended: ${reason}`),
    [],
  );
  check("a session somebody stopped says who did it", sessionNotice(stopped, "kimi", "box")?.text, "you stopped this conversation");
  /*
   * The copy rule, asserted as a rule rather than as a string: a session the
   * daemon interrupted must say neither "ended" nor any raw `ExitReason` token.
   * Those are daemon plumbing, and "ended: daemon_shutdown" is a sentence about
   * our own internals printed at somebody who redeployed their own machine.
   */
  const waitingText = sessionNotice(deployed, "kimi", "box")?.text ?? "";
  check("an interrupted one never says ended", waitingText.includes("ended"), false);
  check("nor names an exit reason", /daemon_shutdown|daemon_restarted/.test(waitingText), false);
  check("it says what is actually happening", waitingText, "the daemon restarted — reconnecting the agent");
  check("and offers no button, because nobody needs to press one", sessionNotice(deployed, "kimi", "box")?.action, null);

  const stalledNotice = sessionNotice(stalled, "kimi", "box");
  check("a stalled one is warn-toned", stalledNotice?.tone, "warn");
  check("says what the daemon said", stalledNotice?.text, "could not reconnect the agent — kimi is not signed in on box");
  /*
   * ⚠ **And offers the sign-in, not the retry, for this one code.** The fixture is
   * `agent_auth_required`, which means the daemon spawned the CLI, asked it to
   * reopen the conversation and was refused — so "not signed in" here is measured
   * rather than remembered, and it is the one place in this app that has earned
   * the right to say it. Retrying is still what every other failure offers, which
   * the pair below pins.
   */
  check("and offers the sign-in it has actually verified", stalledNotice?.action, "sign_in");
  const stalledOther = sessionOf({
    status: "interrupted",
    exit: { reason: "daemon_restarted" },
    agentSessionId: "a_1",
    resume: { state: "failed", attempts: 3, error: { code: "agent_start_timeout", message: "x" }, at: 0 },
  });
  check("while any other failure still offers the retry", sessionNotice(stalledOther, "kimi", "box")?.action, "reconnect");
  check("a live session says nothing at all", sessionNotice(sessionOf({ status: "running", exit: null }), "kimi", "box"), null);

  /*
   * **A failed authentication explains itself in the transcript, with the remedy.**
   *
   * ⚠ **It said "nobody is signed in to claude on box. Sign in and this
   * conversation comes back", and both halves could be false at once.** This row
   * is a record of something that happened, and nothing re-checks it — the
   * daemon's own login probe is live and three seconds fresh and is not consulted
   * anywhere near here. An OAuth token that expired mid-conversation and was then
   * refreshed by the CLI itself left this asserting the opposite of the truth. The
   * promise was not kept either: `reloadCredentials` is the only thing that
   * reverses the reason and all its callers are in-app credential *writes*, so the
   * Sign in button went to a screen where you already were.
   *
   * The sentence is about the past now, which is the only thing the row knows, and
   * the action is the one that has always worked and was never offered:
   * `POST /sessions/:id/resume` is ungated by `autoResumable`.
   */
  const signedOut = sessionOf({
    status: "exited",
    exit: { reason: "agent_signed_out", detail: null, at: 1, agentConfirmedDead: true },
  });
  const out = sessionNotice(signedOut, "claude", "box");
  check("it names the agent and the machine", out?.text, "claude could not authenticate on box, so this conversation stopped.");
  check("never as an internal reason", /agent_signed_out|ended:/.test(out?.text ?? ""), false);
  /*
   * **And it claims nothing about right now.** The row cannot know, so the words
   * that would need checking must not appear: no "nobody is signed in", and no
   * promise about what happens next.
   */
  check(
    "and it asserts nothing about the present",
    /signed in|comes back/.test(out?.text ?? ""),
    false,
  );
  check("and it offers the reconnect, which is the one that works", out?.action, "reconnect");
  /*
   * One field, so the two remedies cannot both be claimed. Two booleans could,
   * and the screen would draw two buttons for one problem.
   */
  const view = stripComments(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
  check("the view draws it as a route to that machine's agent", /settingsPath\("machines", row\.ref\.machineId, row\.snapshot\.agent\)/.test(view), true);
  check("and the two buttons are mutually exclusive by construction", /notice\.retry/.test(view), false);

  const composer = stripComments(readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8"));
  /*
   * ⚠ **A refusal always says so, which reverses an exception that had rotted
   * twice over.** It suppressed the toast for `agent_signed_out` — a code the
   * daemon had stopped sending, so the branch was dead and this check was green
   * on a *literal* rather than on the behaviour. And the reason it existed
   * (Q7.102: the screen already changed, so a toast is the same news twice)
   * expired when the composer became unconditional: a refused send now restores
   * the text and changes nothing else, so without a toast it is silent.
   */
  check("a refused send is never silent", /catch\(\(cause: unknown\)[\s\S]*?toast\("error", errorText\(cause\)\);/.test(composer), true);
  check("with no code carved out of it", /cause\.code === "(agent_signed_out|session_terminal)"/.test(composer), false);
  check("while still putting the message back", /restoreAttachments\(key, sent\);/.test(composer), true);

  // `agentConfirmedDead: false` is worth saying about a session somebody
  // stopped — it is the difference between "stopped" and "probably orphaned" —
  // and is noise after a routine deploy, about a process being replaced anyway.
  const orphaned = sessionOf({
    status: "exited",
    exit: { reason: "stopped", detail: null, agentConfirmedDead: false },
  });
  check("an unconfirmed kill is reported when somebody stopped it", sessionNotice(orphaned, "kimi", "box")?.text, "you stopped this conversation (agent not confirmed dead)");

  check("a stopped session's dot is dim", statusTone(stopped), "ended");
  // The pair that matters: same `status`, opposite tone, decided by the reason.
  check("an interrupted one's is not", statusTone(deployed), "waiting");
  check("a hard restart reads the same as a graceful one", statusTone(sessionOf({ status: "interrupted", exit: { reason: "daemon_restarted" }, agentSessionId: "a_1" })), "waiting");
  check("and one nobody is coming for is loud", statusTone(stalled), "stalled");
  check("a live session keeps its own tone", [
    statusTone(sessionOf({ status: "running", exit: null })),
    statusTone(sessionOf({ status: "blocked", exit: null })),
  ], ["running", "blocked"]);
  check("and a starting one has its own, which is neither", statusTone(sessionOf({ status: "starting", exit: null })), "starting");

  /*
   * The loud blink is spent exactly once, on work actually happening.
   *
   * `TONE_DOT`'s own comments say so twice, and `starting` wore it anyway — so an
   * agent being restarted for a settings change announced, for about a second,
   * that an idle session was working. Read off disk because the table is module
   * -private and the rule is about the table rather than about any one entry.
   *
   * It used to hold a second occurrence too — `WorkingDot` reused
   * `TONE_DOT.running` — and does not any more: the transcript's working row is
   * `WorkingMark` in `ui/Mark.tsx`, the product's own three bars with a keyframe of
   * their own. This assertion is unaffected and is worth **more** now, since the
   * blink has one user rather than two and a stray `animate-blink` would be
   * correspondingly easier to add unnoticed.
   */
  {
    const bits = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
    const table = bits.slice(bits.indexOf("const TONE_DOT"));
    const blinking = [...table.slice(0, table.indexOf("\n};")).matchAll(/^\s{2}([a-z]+):.*animate-blink/gm)].map(
      (match) => match[1],
    );
    check("only one tone blinks, and it is the one that means work", blinking, ["running"]);
  }

  check("a missing conversation cannot be retried", resumeRetryable("no_agent_session_id"), false);
  check("nor can an agent that does not support it", resumeRetryable("resume_unsupported"), false);
  // The daemon has already decided never to try this one again, and a button
  // that spawns an agent to hear the same answer would be drawing that decision
  // as a promise.
  check("nor one whose conversation the agent lost", resumeRetryable("agent_forgot_session"), false);
  // Says whose memory failed, and — the half a reader actually fears for — that
  // what they can still read is not going anywhere.
  check(
    "and that says the transcript survived",
    resumeFailureText("agent_forgot_session", "", "claude", "box").includes("intact"),
    true,
  );
  // Fails open, per `wire.ts`'s rule for this whole mirror: a client behind the
  // daemon passes its words through and offers the action, rather than refusing
  // something that may well work.
  check("an unknown code falls open", resumeRetryable("something_new"), true);
  check("and shows the daemon's own words", resumeFailureText("something_new", "the disk is on fire", "kimi", "box"), "the disk is on fire");
  check("a folder that is gone is still retryable, because it can be put back", resumeRetryable("workspace_missing"), true);
}

process.stdout.write("\nthe routes that spawn a process\n");
{
  const { slowRoute } = await import("../src/machine.js");
  const { configBarShows } = await import("../src/ui/agentConfig.js");

  /*
   * The table `machine.ts` spends a page describing and nothing checked. Its
   * failure mode is not a slow screen: a client deadline below the daemon's own
   * is a *transport* failure, which drops the route memo and renders a perfectly
   * healthy machine "not reachable" over the thing somebody just did.
   */
  check("creating a session is slow", slowRoute("POST", "/sessions"), true);
  check("resuming one is slow", slowRoute("POST", "/sessions/s_1/resume"), true);
  check("changing a control is slow", slowRoute("POST", "/sessions/s_1/config"), true);
  check("the login probe is slow", [slowRoute("GET", "/agents"), slowRoute("GET", "/agent-auth/x")], [true, true]);
  // The new one, and unconditional: sending a message to an interrupted session
  // resumes it first, and `request` sees only a method and a path — a deadline
  // that depended on session state would be state leaking into the transport.
  check("and so is a prompt, now that it may resume first", slowRoute("POST", "/sessions/s_1/prompt"), true);
  check("reading events is not", slowRoute("GET", "/sessions/s_1/events"), false);
  check("nor is answering a permission", slowRoute("POST", "/sessions/s_1/permissions/p_1"), false);
  check("nor is listing sessions", slowRoute("GET", "/sessions"), false);
  /*
   * The one route that talks to a running agent and is deliberately *not* here.
   * It answers without waiting for the agent to agree — the daemon bounds its own
   * wait an order of magnitude under the default budget — so 90 seconds would be
   * a deadline for a control nobody would still be looking at. Asserted because
   * "we thought about it and said no" and "we forgot" are the same code.
   */
  check("and stopping a turn is not, because it does not wait for the agent", slowRoute("POST", "/sessions/s_1/cancel"), false);

  /*
   * The control strip's early return, extracted because its third clause is the
   * half that fails on exactly one agent — and the case it fails on stopped
   * being rare the moment the composer began surviving a restart.
   */
  check("a restored session still draws its bar, for the paperclip", configBarShows(0, null, true), true);
  check("and without one there is nothing to draw", configBarShows(0, null, false), false);
  check("a context readout alone is enough", configBarShows(0, 42, false), true);
  check("and so is a single control", configBarShows(1, null, false), true);

  /*
   * The controls do not blink out of existence while the agent is away.
   *
   * The daemon drops `agentConfig` the moment the agent dies — deliberately, and
   * documented — which left the strip blank for the whole of every restart: a
   * deploy, an auto-resume, and now every ultracode change. The client keeps the
   * last set a *running* agent published and draws it refused.
   *
   * `hasLiveAgent` is what makes the memory safe rather than sticky: an agent
   * that is up and publishes nothing clears it, so a session with genuinely no
   * controls cannot end up wearing a dead one's for ever.
   */
  const config = (ids: string[]) => ({
    modes: null,
    options: ids.map((id) => ({
      id,
      name: id,
      description: null,
      category: id,
      kind: "select" as const,
      value: "a",
      choices: [{ value: "a", name: "A", description: null, group: null }],
    })),
  });
  const live = config(["mode", "model"]);

  /*
   * The predicate underneath both, and the exclusion that carries the weight:
   * `stopping` is not a live agent. `doStop` fans a snapshot out both before and
   * after it empties the config, so a `stopping` frame with no controls is
   * ordinary — and counting it as "the agent says it has none" would throw the
   * memory away on the exact path this exists for.
   */
  check(
    "an agent exists in exactly three statuses",
    (["starting", "idle", "running", "blocked", "stopping", "exited", "failed", "interrupted"] as const).filter(
      (status) => hasLiveAgent(status),
    ),
    ["idle", "running", "blocked"],
  );

  check("a running agent's controls are what is held", holdConfig(undefined, { status: "idle", agentConfig: live }), live);
  check(
    "an emptied config on a session the daemon is bringing back keeps them",
    holdConfig(live as never, { status: "interrupted", agentConfig: { modes: null, options: [] } }),
    live,
  );
  check(
    "and so does the window while it starts again",
    holdConfig(live as never, { status: "starting", agentConfig: { modes: null, options: [] } }),
    live,
  );
  check(
    "and the one where it is being torn down, which fans out an emptied snapshot",
    holdConfig(live as never, { status: "stopping", agentConfig: { modes: null, options: [] } }),
    live,
  );
  check(
    "but a live agent that publishes nothing clears the memory",
    holdConfig(live as never, { status: "idle", agentConfig: { modes: null, options: [] } }),
    { modes: null, options: [] },
  );
  check(
    "and an older daemon that sends no config at all on a live session clears it too",
    holdConfig(live as never, { status: "idle", agentConfig: undefined }),
    undefined,
  );

  /*
   * And what the strip draws from the pair. The property is that `stale` is true
   * **iff** what is on screen did not come from the daemon's current answer — so
   * a bar that is not marked stale is never drawing a memory.
   */
  const drawnFrom = (status: string, options: string[] | null, held: string[] | null) =>
    drawnControls(
      { status, agentConfig: options === null ? undefined : config(options) } as never,
      held === null ? undefined : (config(held) as never),
    );
  /*
   * A live agent's own answer is what every *value* comes from; the memory only
   * ever adds slots the agent has stopped offering, and says which those are.
   * The two are drawn together and are never confused: `stale` is about the
   * session, `unavailable` is about one control.
   */
  check(
    "a live agent's controls come from the daemon",
    [
      drawnFrom("idle", ["mode"], ["mode"]).options.map((o: { id: string }) => o.id),
      drawnFrom("idle", ["mode"], ["mode"]).stale,
    ],
    [["mode"], false],
  );
  check(
    "and one it has dropped is added after them, marked",
    [
      drawnFrom("idle", ["mode"], ["old"]).options.map((o: { id: string }) => o.id),
      [...drawnFrom("idle", ["mode"], ["old"]).unavailable],
    ],
    [["mode", "old"], ["old"]],
  );
  check(
    "a live agent with nothing to offer draws nothing, and is not stale",
    [drawnFrom("idle", [], ["old"]).options.length, drawnFrom("idle", [], ["old"]).stale],
    [0, false],
  );
  check(
    "an absent agent draws the memory, and says so",
    [
      drawnFrom("interrupted", [], ["mode", "model"]).options.map((o: { id: string }) => o.id),
      drawnFrom("interrupted", [], ["mode", "model"]).stale,
    ],
    [["mode", "model"], true],
  );
  check(
    "an absent agent with nothing remembered draws nothing rather than claiming staleness",
    [drawnFrom("exited", [], null).options.length, drawnFrom("exited", [], null).stale],
    [0, false],
  );
  /*
   * The sequence that is the bug, walked end to end: a restart is a live frame,
   * then an emptied `interrupted` one, then an emptied `starting` one. The strip
   * must draw the same controls at every step and must never fall to the state
   * where `configBarShows` has only the paperclip to keep it alive.
   */
  {
    let held = holdConfig(undefined, { status: "idle", agentConfig: live });
    const drawn: { ids: string[]; stale: boolean; shows: boolean }[] = [];
    for (const status of ["interrupted", "starting", "idle"] as const) {
      const snapshot = {
        status,
        agentConfig: status === "idle" ? live : { modes: null, options: [] },
      };
      held = holdConfig(held, snapshot as never);
      const step = drawnControls(snapshot as never, held);
      drawn.push({
        ids: step.options.map((option) => option.id),
        stale: step.stale,
        shows: configBarShows(step.options.length, null, true),
      });
    }
    check("across a whole restart the same controls stay on screen", drawn, [
      { ids: ["mode", "model"], stale: true, shows: true },
      { ids: ["mode", "model"], stale: true, shows: true },
      { ids: ["mode", "model"], stale: false, shows: true },
    ]);
  }

  /*
   * **A control never leaves the strip**, which is the rule the model gate broke.
   *
   * All three agents build the effort list from the *currently selected model's*
   * own levels and drop the control when there are none — so choosing Haiku
   * deleted the effort chip outright, moving every button beside it and saying
   * nothing about where it went. The memory keeps the slot; the live set decides
   * what can still be used.
   */
  {
    const both = config(["mode", "model", "effort"]);
    const withoutEffort = config(["mode", "model"]);
    let kept = holdConfig(undefined, { status: "idle", agentConfig: both } as never);
    kept = holdConfig(kept, { status: "idle", agentConfig: withoutEffort } as never);
    const drawn = drawnControls({ status: "idle", agentConfig: withoutEffort } as never, kept);
    check(
      "a control the model dropped keeps its slot",
      drawn.options.map((option) => option.id),
      ["mode", "model", "effort"],
    );
    check("and is marked as having nothing to choose", [...drawn.unavailable], ["effort"]);
    check("while the session itself is not stale — there is an agent", drawn.stale, false);

    // And back: a model that offers it again takes the slot back as a live one.
    const returned = holdConfig(kept, { status: "idle", agentConfig: both } as never);
    const after = drawnControls({ status: "idle", agentConfig: both } as never, returned);
    check(
      "and a model that offers it again makes it live",
      [after.options.map((option) => option.id), [...after.unavailable]],
      [["mode", "model", "effort"], []],
    );

    /*
     * The one thing this must not do: report a control missing when there is
     * simply no agent. That is `stale`, a different sentence with a different
     * refusal behind it.
     */
    const away = drawnControls(
      { status: "interrupted", agentConfig: { modes: null, options: [] } } as never,
      kept,
    );
    check("a session with no agent reports nothing unavailable", [away.stale, [...away.unavailable]], [true, []]);

    check(
      "the hint names the kind of control it is about",
      [unavailableHint({ category: "thought_level" }), unavailableHint({ category: "mode" })],
      [
        "The model in use offers no levels here. Another model may.",
        "The agent is not offering this control at the moment.",
      ],
    );

    /* ---------------------------------------------------------------- *
     * A choice that restarts the agent says so on its own row
     *
     * ⭐ The bottom-of-viewport toast was the ONLY thing that told anybody why
     * choosing ultracode mid-turn did nothing — and it is a panel over the
     * composer's input, raised after the tap for a refusal the client could have
     * predicted. The row answers first now, and `applyConfigChange` suppresses
     * exactly that one code. These pin the pair: if `restartsAgent` narrows, the
     * refusal goes silent instead of loud. Q3.429.
     * ---------------------------------------------------------------- */
    // Typed off the function under test, so this fixture cannot drift from the
    // shape `restartsAgent` actually reads without failing here first.
    type EffortOption = Parameters<typeof restartsAgent>[0];
    const effort = (value: string): EffortOption => ({
      id: "effort",
      name: "Effort",
      description: null,
      category: "thought_level",
      kind: "select",
      value,
      choices: [
        { value: "default", name: "Default", description: null, group: null },
        { value: "xhigh", name: "Xhigh", description: null, group: null },
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    });

    check(
      "entering ultracode restarts, and so does leaving it",
      [
        restartsAgent(effort("default"), "ultracode"),
        restartsAgent(effort("ultracode"), "default"),
      ],
      [true, true],
    );
    // Not a restart: the value is not moving across the ultracode boundary.
    check(
      "moving between ordinary levels does not",
      [restartsAgent(effort("default"), "xhigh"), restartsAgent(effort("ultracode"), "ultracode")],
      [false, false],
    );
    /*
     * The two capability clauses. The daemon appends the row only to a control it
     * found by `thought_level` and only where the agent already offered `xhigh`,
     * so a list missing either is one it never touched — and a false positive here
     * would swallow a tap the daemon would have accepted.
     */
    const noXhigh = {
      ...effort("default"),
      choices: [
        { value: "default", name: "Default", description: null, group: null },
        { value: "ultracode", name: "Ultracode", description: null, group: null },
      ],
    };
    check("a list the daemon never appended to is not a restart", restartsAgent(noXhigh, "ultracode"), false);
    check(
      "and neither is another category",
      restartsAgent({ ...effort("default"), category: "mode" }, "ultracode"),
      false,
    );

    check(
      "the row says why, and only while the turn is running",
      [
        choiceRefusal(effort("default"), "ultracode", true),
        choiceRefusal(effort("default"), "ultracode", false),
        choiceRefusal(effort("default"), "xhigh", true),
      ],
      [
        "Restarts the agent, so not while this turn is running — wait for it, or Stop.",
        null,
        null,
      ],
    );

    /*
     * **And the chip does not change width when it happens** — the assertion the
     * first version of this slot lacked. It drew the control's name where the
     * live chip deliberately does not, so choosing Haiku widened the effort chip
     * by a word and a gap and shoved the whole right-hand cluster sideways, which
     * is the one thing this strip must never do.
     *
     * The property is structural: everything that decides a chip's width — the
     * caption and the reserve — is the same in both states, so the only thing
     * that changes is the string inside a box already sized for it. Over every
     * category, because the next control to be dropped will not be this one.
     */
    const shape = {
      id: "one",
      name: "One",
      description: null,
      kind: "select" as const,
      value: "default",
      choices: [
        { value: "default", name: "Default", description: null, group: null },
        { value: "max", name: "Max", description: null, group: null },
      ],
    };
    for (const category of ["mode", "model", "thought_level", "model_config", "unheard_of"]) {
      const one = { ...shape, category } as never;
      const shown = chipParts(one, true);
      const gone = chipParts(one, false);
      check(`a ${category} chip keeps its caption when the agent stops offering it`, gone.caption, shown.caption);
      check(`and reserves exactly the same width`, gone.reserve, shown.reserve);
      check(`while its value says there is nothing to choose`, gone.value, "—");
    }
    check(
      "and that placeholder is inside the width the chip reserved",
      chipParts({ ...shape, category: "thought_level" } as never, false).reserve?.includes("—"),
      true,
    );

    /*
     * **The reserve is a width, not a floor**, and the only thing that says so is
     * a class: a grid column is as wide as the widest thing in it, so while the
     * value sat in flow beside the sizers, a value longer than all of them
     * widened the chip. `GPT-5.6-Luna` is one character more than the string this
     * list was measured from, and that was enough for two codex sessions to draw
     * two different strips. Taking the value out of flow is what makes the column
     * exactly the reserve.
     *
     * Read off disk because there is no DOM here and the rule is one word in a
     * class string — the kind of thing a tidy-up deletes without noticing, and
     * every pure assertion above stays green when it does.
     */
    const bar = readFileSync(new URL("../src/ui/AgentConfigBar.tsx", import.meta.url), "utf8");
    const inner = bar.slice(bar.indexOf("function chipInner"), bar.indexOf("function Absent"));
    check("the sizers only hold the width open where there is room for it", inner.includes("hidden col-start-1 row-start-1 whitespace-pre sm:block"), true);
    check("and the value cannot widen the column it sits in", inner.includes("sm:absolute sm:inset-0"), true);
  }

  /*
   * The context readout is deliberately **not** held. "A dead agent's window
   * occupancy is not a fact about anything" — the ring keeps its slot and says
   * "cannot tell", which is true, and `drawnControls` has nowhere to put a usage
   * even if somebody wanted to.
   */
  check("nothing about usage rides the controls", Object.keys(drawnFrom("interrupted", [], ["mode"])).sort(), [
    "options",
    "stale",
    "unavailable",
  ]);
}

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

/* ------------------------------------------------------------------ *
 * The question an agent asked
 * ------------------------------------------------------------------ */

/**
 * The form, the answer, and the predicate that carries both into the fleet view.
 *
 * Every rule here fails *silently* in a direction nobody notices from the outside:
 * a zero sent for a field somebody left blank, an empty string that reads as an
 * answer, a Submit button enabled onto a 400, a session that is both waiting and
 * working. That is what earns them a place in this file rather than in the JSX.
 */
process.stdout.write("\nthe question an agent asked\n");
{
  const { MAX_ANSWER_CHARS } = await import("../src/wire.js");
  const { askTitle, elicitationForm, elicitationAnswer, fieldValue } = await import(
    "../src/elicitation.js"
  );
  const { humanRequests, needsHuman, waitingCount, oldestWait, showsWorking } = await import(
    "../src/wire.js"
  );
  const { elicitationOutcome } = await import("../src/ui/tail.js");
  const { answerAlreadyLanded } = await import("../src/http.js");
  const { ApiError } = await import("../src/http.js");

  const pendingOf = (message: string, fieldCount: number): any => ({
    elicitationId: "elic-1-abc",
    toolCallId: "tc_1",
    message,
    fieldCount,
    raisedAt: 1_000,
  });

  /* ---- A: the measured AskUserQuestion shape, N=1 ---- */

  const askFields: any[] = [
    {
      key: "question_0",
      kind: "string",
      title: "Framework",
      description: null,
      required: false,
      options: [
        { value: "React", label: "React", description: "Already in package.json" },
        { value: "Svelte", label: "Svelte", description: null },
      ],
      min: null,
      max: null,
      format: null,
      default: null,
    },
    {
      key: "question_0_custom",
      kind: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
      required: false,
      options: null,
      min: null,
      max: null,
      format: null,
      default: null,
    },
  ];
  const ask = elicitationForm(pendingOf("Which framework should I use?", 2), askFields);

  check("the prompt is the agent's own message", ask.message, "Which framework should I use?");
  check(
    "a titled select becomes option rows and the Other box a text field",
    ask.fields.map((field) => [field.key, field.kind.k, field.label]),
    [
      ["question_0", "select", "Framework"],
      ["question_0_custom", "text", "Other"],
    ],
  );
  // The adapter's explanation of its own box is dropped once the box sits under
  // the choices it belongs to — the layout says it. A loose text field keeps it.
  check("a follow-up box loses the sentence the grouping makes redundant", ask.steps[0]?.fields[1]?.hint, null);
  check("but the flat field list is untouched", ask.fields[1]?.hint !== null, true);
  // An unbounded string is one line: the commonest one in practice is the
  // adapter's own "Other" box, and a textarea there would be three rows of
  // nothing on a phone.
  check(
    "an unbounded string field is a single line",
    ask.fields[1]?.kind.k === "text" && ask.fields[1].kind.multiline,
    false,
  );

  /*
   * **The assertion that pins the culture rule.** Rename the adapter's own field
   * keys and assert an identical form comes out. Anything that ever greps for
   * `question_` or `_custom` fails here.
   */
  const renamed = elicitationForm(
    pendingOf("Which framework should I use?", 2),
    askFields.map((field, index) => ({ ...field, key: index === 0 ? "a" : "b" })),
  );
  check(
    "nothing is keyed on the adapter's field names",
    JSON.stringify(renamed.fields.map(({ key, ...rest }) => rest)),
    JSON.stringify(ask.fields.map(({ key, ...rest }) => rest)),
  );

  /*
   * With one question the agent's `message` *is* the question, so it is drawn.
   * With several it is a preamble — "Please answer the following questions." —
   * and each question carries its own text, so drawing it costs a line of
   * boilerplate above questions that already speak for themselves.
   *
   * Decided structurally and never by matching that sentence. The two fixtures
   * below are the measured shapes for N=1 and N=2.
   */
  check("one question keeps the agent's message, because it is the question", ask.showsPrompt, true);
  /*
   * The other half of that, and the half that is silently wrong on one agent if
   * the three sources are read in the wrong order. With one question the title is
   * the *message* — reading the field's `title` first would put the short chip
   * label "Framework" at the top of the card and drop the sentence somebody has
   * to answer.
   */
  check("and the card is titled with it, not with the field's chip label", askTitle(ask, 0), "Which framework should I use?");
  {
    const twoQuestions: any[] = [
      { ...askFields[0], key: "q0", description: "Which framework?" },
      { ...askFields[1], key: "q0c" },
      { ...askFields[0], key: "q1", title: "TTL", description: "Which TTL?" },
      { ...askFields[1], key: "q1c" },
    ];
    const many = elicitationForm(pendingOf("Please answer the following questions.", 4), twoQuestions);
    check("several drop it, because each question carries its own text", many.showsPrompt, false);
    // The free-text box always has a description of its own, so it must not be
    // what answers "do the questions speak for themselves".
    check("and the Other boxes do not count as questions", many.fields.length, 4);
    check(
      "so each step is titled with its own question, not with the preamble",
      [askTitle(many, 0), askTitle(many, 1)],
      ["Which framework?", "Which TTL?"],
    );
  }
  check(
    "a form with no choices at all keeps it, since nothing else says what is wanted",
    elicitationForm(pendingOf("What should I name it?", 1), [
      { key: "name", kind: "string", title: "Name", description: null, required: true, options: null, min: null, max: null, format: null, default: null },
    ] as any).showsPrompt,
    true,
  );

  /*
   * Grouping, which is what makes stepping possible at all.
   *
   * Three questions arrive as six fields; without a notion of "one question"
   * that is six screens, half of them a bare text box with no idea what it is
   * for. The rule is presentational only — both fields keep their own key and
   * both are sent independently — which is why it was worth taking after being
   * refused once.
   */
  check("a choice and its free-text box are one question", ask.steps.length, 1);
  check("and both fields are still there, each with its own key", ask.steps[0]?.fields.map((f) => f.key), [
    "question_0",
    "question_0_custom",
  ]);
  {
    const three: any[] = [];
    for (let i = 0; i < 3; i += 1) {
      three.push({ ...askFields[0], key: `q${i}`, description: `Question ${i}?` });
      three.push({ ...askFields[1], key: `q${i}c` });
    }
    const stepped = elicitationForm(pendingOf("Please answer the following questions.", 6), three);
    check("three questions are three steps, not six", stepped.steps.length, 3);
  }
  // A required text field is a question of its own, and so is a second loose one:
  // only an *optional* box directly after a choice is a follow-up.
  check(
    "loose text fields are not swallowed by the question above them",
    elicitationForm(pendingOf("x", 3), [
      { key: "a", kind: "string", title: "A", description: null, required: false, options: [{ value: "1", label: "1", description: null }], min: null, max: null, format: null, default: null },
      { key: "b", kind: "string", title: "B", description: null, required: true, options: null, min: null, max: null, format: null, default: null },
      { key: "c", kind: "string", title: "C", description: null, required: false, options: null, min: null, max: null, format: null, default: null },
    ] as any).steps.map((step) => step.fields.map((f) => f.key)),
    [["a"], ["b"], ["c"]],
  );

  /* ---- B: a generic MCP-shaped form ---- */

  const mcpFields: any[] = [
    { key: "name", kind: "string", title: "Name", description: null, required: true, options: null, min: 3, max: 20, format: null, default: null },
    { key: "port", kind: "integer", title: "Port", description: null, required: true, options: null, min: 1024, max: 65535, format: null, default: 8080 },
    { key: "ratio", kind: "number", title: "Ratio", description: null, required: false, options: null, min: 0, max: 1, format: null, default: null },
    { key: "tls", kind: "boolean", title: "TLS", description: null, required: false, options: null, min: null, max: null, format: null, default: true },
    {
      key: "regions",
      kind: "multi_select",
      title: "Regions",
      description: null,
      required: false,
      options: [
        { value: "us", label: "us", description: null },
        { value: "eu", label: "eu", description: null },
      ],
      min: 1,
      max: 2,
      format: null,
      default: null,
    },
    { key: "notes", kind: "string", title: "Notes", description: null, required: false, options: null, min: null, max: 4000, format: null, default: null },
  ];
  const mcp = elicitationForm(pendingOf("Configure the service.", 6), mcpFields);
  check(
    "a long maxLength is what makes a field multiline",
    mcp.fields.find((f) => f.key === "notes")?.kind.k === "text" &&
      (mcp.fields.find((f) => f.key === "notes")!.kind as any).multiline,
    true,
  );

  /*
   * The third arm of `askTitle`, and it exists because a whole MCP form was
   * titled with one generic sentence five times over.
   *
   * These fields carry a `title` and no `description`, so there is no question to
   * read off the step and the message is a preamble rather than the question —
   * and `regions` is a multi-select, so its own options become the card's
   * unlabelled rows and the word "Regions" appeared nowhere on screen.
   */
  check(
    "a multi-step form with no descriptions is titled per field",
    mcp.steps.map((_, index) => askTitle(mcp, index)),
    ["Name", "Port", "Ratio", "TLS", "Regions"],
  );
  check("and its last step is the choice with its Notes box folded in", mcp.steps.at(-1)?.fields.map((f) => f.key), [
    "regions",
    "notes",
  ]);

  /*
   * The anchor case, and it pins three separate rules at once: an agent's default
   * is *sent* (the control is showing it, so it is the answer), an untouched
   * optional field is *omitted*, and a missing required one blocks Submit.
   */
  const empty = elicitationAnswer(mcp, {});
  check("an untouched form sends the defaults and omits the rest", empty.content, {
    port: 8080,
    tls: true,
  });
  check("and names the required field nobody filled in", empty.problems.map((p) => [p.key, p.code]), [
    ["name", "required"],
  ]);
  check("so it cannot be submitted", empty.canSubmit, false);

  /*
   * `Number("")` and `Number(" ")` are both `0`. A parse-first implementation
   * silently sends a zero nobody typed into a blank optional number field, which
   * is exactly the shape of bug this file exists for.
   */
  for (const blank of ["", "   "]) {
    check(
      `a blank number is not zero (${JSON.stringify(blank)})`,
      "ratio" in elicitationAnswer(mcp, { name: "ok", ratio: blank }).content,
      false,
    );
  }
  check(
    "false is an answer, not an absence",
    elicitationAnswer(mcp, { name: "ok", tls: false }).content.tls,
    false,
  );
  check(
    "a deliberately emptied multi-select is sent, not dropped",
    elicitationAnswer(mcp, { name: "okay", regions: [] }).problems.map((p) => p.code),
    ["too_few"],
  );
  check(
    "text is trimmed on the way out",
    elicitationAnswer(mcp, { name: "  okay  " }).content.name,
    "okay",
  );

  const codeFor = (draft: Record<string, any>): string[] =>
    elicitationAnswer(mcp, { name: "okay", ...draft }).problems.map((p) => p.code);
  check("a short string", elicitationAnswer(mcp, { name: "ab" }).problems.map((p) => p.code), ["too_short"]);
  /*
   * **The daemon's own ceiling, which the client did not have.** `registry.ts`
   * refuses any string answer over `MAX_ELICITATION_ANSWER_CHARS` (2048) *before*
   * it looks at the field's own `maxLength` — and the field the adapter is most
   * likely to leave unbounded is its free-text "Other" box. So `canSubmit` said
   * yes and the POST came back `400`, which is the one thing this file's docblock
   * says cannot happen because the value enabling the button is the value sent.
   */
  check(
    "an answer past the daemon's ceiling is refused here, not by the route",
    elicitationAnswer(mcp, { name: "okay", notes: "x".repeat(MAX_ANSWER_CHARS + 1) }).problems.map((p) => p.code),
    ["too_long"],
  );
  check(
    "and one exactly at it goes",
    elicitationAnswer(mcp, { name: "okay", notes: "x".repeat(MAX_ANSWER_CHARS) }).canSubmit,
    true,
  );
  check("a fractional integer", codeFor({ port: "1.5" }), ["not_an_integer"]);
  check("a number below its minimum", codeFor({ port: "80" }), ["below_min"]);
  check("a number above its maximum", codeFor({ ratio: "2" }), ["above_max"]);
  check("something that is not a number at all", codeFor({ ratio: "abc" }), ["not_a_number"]);
  // Deduping happens *before* the count is checked, so three taps on two distinct
  // options is two choices rather than one over the cap.
  check("the cap counts distinct choices, not taps", codeFor({ regions: ["us", "eu", "us"] }), []);
  check(
    "a choice the form never offered",
    codeFor({ regions: ["mars"] }),
    ["not_an_option"],
  );
  // Deduped keeping first order, so two identical taps are one choice rather than
  // a repeated label reaching the agent.
  check(
    "duplicates collapse rather than failing",
    elicitationAnswer(mcp, { name: "ok", regions: ["us", "us"] }).content.regions,
    ["us"],
  );

  check(
    "what a control shows is the draft, else the agent's default",
    [fieldValue(mcp.fields[1]!, {}), fieldValue(mcp.fields[1]!, { port: "9999" })],
    ["8080", "9999"],
  );

  /* ---- C: an empty form is answerable ---- */

  const confirm = elicitationForm(pendingOf("Proceed?", 0), []);
  const confirmed = elicitationAnswer(confirm, {});
  check("a form with no fields can still be accepted", [confirmed.canSubmit, confirmed.content], [true, {}]);

  /*
   * **The agent chooses the field names, and one of them is a landmine.**
   * `__proto__` is a legal JSON Schema property; on a plain `{}`,
   * `content[key] = value` sets the *prototype* rather than an own property, so
   * the answer vanished while `canSubmit` still said `true` — a form the card
   * called valid, an empty body on the wire, and a `400` from the daemon for a
   * form somebody filled in correctly.
   */
  {
    const proto = elicitationForm(pendingOf("Pick one", 1), [
      { key: "__proto__", kind: "string", title: "T", description: null, required: true,
        options: [{ value: "a", label: "a", description: null }],
        min: null, max: null, format: null, default: null },
    ] as any);
    // A *computed* key, because `{__proto__: "a"}` in a literal is the
    // prototype-setter syntax and creates no own property — the draft that
    // reaches this in the app is built by `setDraftField`, which assigns.
    const answered = elicitationAnswer(proto, { ["__proto__"]: "a" } as any);
    check("an answer to a __proto__ field survives to the body", JSON.stringify(answered.content), '{"__proto__":"a"}');
    check("and it is not reported answerable while being dropped", answered.canSubmit, true);
  }

  /* ---- D: the predicate set, as a partition ---- */

  const sessionOf = (over: Record<string, unknown>): any => ({
    ...snapshot,
    turn: null,
    status: "idle",
    pendingPermissions: [],
    ...over,
  });

  const permission = { permissionId: "p1", toolCallId: null, title: "Terminal", options: [], raisedAt: 10, rawInput: null, content: null };
  const question = { elicitationId: "e1", toolCallId: null, message: "Which?", fieldCount: 1, raisedAt: 5 };

  const matrix = [
    sessionOf({}),
    sessionOf({ turn: 1, status: "running" }),
    sessionOf({ status: "blocked", turn: 1, pendingPermissions: [permission] }),
    sessionOf({ status: "blocked", turn: 1, pendingElicitations: [question] }),
    sessionOf({ status: "blocked", turn: 1, pendingPermissions: [permission], pendingElicitations: [question] }),
    sessionOf({ pendingElicitations: [] }),
    sessionOf({ status: "exited", exit: { reason: "stopped", at: 0, detail: null } }),
  ];

  const broken = matrix.filter(
    (session) =>
      needsHuman(session) !== waitingCount(session) > 0 ||
      waitingCount(session) !== humanRequests(session).length ||
      // The clause that matters: a form is parked mid-turn, so `turn` stays set.
      // Without it the transcript blinks "working…" over a question nobody has
      // answered.
      (needsHuman(session) && showsWorking(session)),
  );
  check("the predicates are a partition", broken.length, 0);

  check(
    "an older daemon's missing array behaves exactly as an empty one",
    [needsHuman(sessionOf({})), needsHuman(sessionOf({ pendingElicitations: [] }))],
    [false, false],
  );
  check("nothing waiting is an infinite wait, so Math.min needs no null check", oldestWait(sessionOf({})), Infinity);
  /*
   * Oldest first, and a permission does not lead by being the older feature. The
   * question here was raised at 5 and the approval at 10.
   */
  check(
    "the longest wait leads, whatever kind it is",
    humanRequests(matrix[4]!).map((request) => request.kind),
    ["elicitation", "permission"],
  );
  check("and a row draws one string without branching on the kind", humanRequests(matrix[4]!)[0]?.title, "Which?");

  /* ---- E: the transcript ---- */

  const resolvedOf = (over: Record<string, unknown>): any => ({
    type: "elicitation_resolved",
    elicitationId: "e1",
    toolCallId: null,
    message: "Which?",
    action: "accept",
    answers: null,
    by: "client",
    ...over,
  });

  check(
    "the three verbs",
    [
      elicitationOutcome(resolvedOf({ action: "accept" })).verb,
      elicitationOutcome(resolvedOf({ action: "decline" })).verb,
      elicitationOutcome(resolvedOf({ action: "cancel" })).verb,
    ],
    // `skipped` is the adapter's own word, so the row and the model say the same
    // thing about what happened.
    ["answered", "skipped", "cancelled"],
  );
  check(
    "one answer needs no label — the question is the row above it",
    elicitationOutcome(resolvedOf({ answers: [{ key: "q", label: "Framework", value: "React" }] })).summary,
    "React",
  );
  check(
    "several are labelled and joined with this app's own separator",
    elicitationOutcome(
      resolvedOf({
        answers: [
          { key: "a", label: "Framework", value: "React" },
          { key: "b", label: "TTL", value: "5m" },
        ],
      }),
    ).summary,
    "Framework: React · TTL: 5m",
  );

  /* ---- the tool call a question came through ---- */

  {
    const { buildTail } = await import("../src/ui/tail.js");
    const ev = (seq: number, event: unknown): any => ({ seq, ts: seq, event });
    const tail = buildTail(
      [
        ev(1, { type: "tool_call", toolCallId: "tc1", title: "Asking for your input", kind: "other", status: "completed", locations: [], rawInput: null }),
        ev(2, { type: "elicitation_request", elicitationId: "e1", toolCallId: "tc1", message: "Which?" }),
        ev(3, { type: "elicitation_resolved", elicitationId: "e1", toolCallId: "tc1", message: "Which?", action: "accept", answers: [{ key: "q", label: "Q", value: "A" }], by: "client" }),
      ],
      [],
      0,
    );
    // The card that carried the question is drawn by the question, never beside
    // it — joined on the id the agent supplied, never on the tool's name.
    check(
      "the tool call a question came through is not drawn twice",
      tail.rows.map((row: any) => row.kind),
      ["event"],
    );
    // An ordinary tool call is untouched, which is what makes the rule a join
    // rather than a filter on anything that looks like a question.
    const plain = buildTail(
      [ev(1, { type: "tool_call", toolCallId: "tc9", title: "Terminal", kind: "execute", status: "completed", locations: [], rawInput: null })],
      [],
      0,
    );
    check("and an ordinary tool call still is", plain.rows.map((row: any) => row.kind), ["tool"]);
  }

  /* ---- F: the 409 that is really a success ---- */

  const errorOf = (status: number, body: unknown, code = "http_409"): unknown =>
    new ApiError(status, code, "nope", null, body);
  check(
    "a 409 is success when it says the answer already landed",
    [
      answerAlreadyLanded(errorOf(409, { repeat: true }), "elicitation_expired"),
      answerAlreadyLanded(errorOf(409, { error: {} }, "elicitation_expired"), "elicitation_expired"),
      answerAlreadyLanded(errorOf(409, { error: {} }), "elicitation_expired"),
      answerAlreadyLanded(errorOf(500, { repeat: true }), "elicitation_expired"),
    ],
    [true, true, false, false],
  );
}

/* ------------------------------------------------------------------ *
 * Where a link in agent output is allowed to go
 * ------------------------------------------------------------------ */
{
  process.stdout.write("\nwhere a link in agent output is allowed to go\n");

  /*
   * The case this exists for, measured on a live session.
   *
   * codex finished with "Done: created the file about_me.txt with this text.", and
   * the filename came through as a markdown link. react-markdown passes a
   * relative href through **on purpose** — its `defaultUrlTransform` returns early
   * when there is no protocol — which is right for a document sitting beside the
   * files it links, and wrong here: this page is served by the control plane, so
   * the anchor pointed at `https://<control-plane>/about_me.txt`, the SPA fallback
   * answered it with `index.html`, and tapping a filename opened a second copy of
   * the app.
   */
  check("a bare filename is not a link", openableHref("about_me.txt"), null);
  check("nor a relative path", openableHref("./src/index.ts"), null);
  /*
   * **An absolute path is the one most likely to look safe**, because it is
   * absolute — and it is a path on the *agent's* machine, so against this origin
   * it is just another SPA route.
   */
  check("nor an absolute path, which is a path and not a URL", openableHref("/Users/u/reemoat_agents/about_me.txt"), null);
  check("nor a file:// URI, which no browser here will open", openableHref("file:///etc/passwd"), null);
  // A fragment has nothing to jump to in this transcript, and empty means "the
  // page you are on" — `href=""` navigates, which is why `null` is the answer
  // rather than a stripped attribute.
  check("nor a bare fragment", openableHref("#section"), null);
  check("nor an empty or absent one", [openableHref(""), openableHref("   "), openableHref(undefined)], [null, null, null]);

  // What is kept: the links an agent cites that a phone can actually open.
  check("but https survives", openableHref("https://example.com/a/b?c=1#d"), "https://example.com/a/b?c=1#d");
  check("and http", openableHref("http://example.com"), "http://example.com");
  check("and mailto, the one non-web scheme every device has", openableHref("mailto:x@example.com"), "mailto:x@example.com");
  // Parsed rather than prefix-matched, so case and padding cannot smuggle one
  // past — `new URL` is what decides what the browser would do.
  check("a scheme is read the way a browser reads it", openableHref("HtTpS://example.com/"), "HtTpS://example.com/");
  check("and surrounding whitespace does not hide one", openableHref("  https://example.com/  "), "https://example.com/");
  /*
   * Not an XSS fix, and saying so keeps somebody from deleting the real guard.
   * `javascript:` never reaches this function — react-markdown's own transform
   * empties it first — but this refuses it too, so the two do not have to be
   * reasoned about together.
   */
  check("a script scheme is refused here as well as upstream", [openableHref("javascript:alert(1)"), openableHref("data:text/html,<script>")], [null, null]);

  /*
   * ⚠ **`openableHref` guards the anchor and nothing guarded the image**, which
   * is the worse of the two: a link needs a tap and an `<img>` does not.
   *
   * `COMPONENTS` overrides `a` precisely because agent output is untrusted text
   * quoting an untrusted repository. It overrode no `img`, so `![](https://…)`
   * fell through to react-markdown's default `<img src>` — whose transform allows
   * `https:` — and the browser fetched a host the agent chose, on render, with no
   * interaction, from the origin holding `reemoat.credential`. Everything the
   * agent wanted to say went out in the query string. Prompt injection in a
   * README, an issue body or a fetched page is the whole delivery mechanism, and
   * there is no CSP anywhere in this app to catch it.
   *
   * Read off disk in the style of the `SessionBrowser.tsx` and `SignIn.tsx`
   * assertions, because what has to be true is a fact about the *component map*
   * — a pure function cannot be asked whether a key exists in an object literal
   * two files away, and the defect was precisely an absent key.
   */
  const markdown = readFileSync(new URL("../src/ui/Markdown.tsx", import.meta.url), "utf8");
  const componentMap = markdown.slice(markdown.indexOf("const COMPONENTS"), markdown.indexOf("\n};", markdown.indexOf("const COMPONENTS")));
  check("the markdown component map overrides img at all", /^\s{2,}img:/m.test(componentMap), true);
  /*
   * And does not hand the agent's URL back to the browser. Asserted as the
   * absence of an `src=` binding rather than the presence of a particular
   * rendering, so a future click-to-load affordance is free to arrive — what may
   * not arrive is anything the browser fetches without being asked.
   */
  const imgArm = componentMap.slice(componentMap.indexOf("img:"), componentMap.indexOf("blockquote:"));
  check("and never binds it to an src the browser would follow", /\bsrc=\{/.test(imgArm), false);
  // The anchor is still an anchor, so this cannot pass by the map having been
  // emptied — which is the failure mode a "does not contain" assertion invites.
  check("while the anchor is still drawn as one", /<a\s+href=\{target\}/.test(componentMap), true);
}

/* ------------------------------------------------------------------ *
 * When a failed control-plane call ends the session
 *
 * **This is the section that exists because of one line.** `store.bootstrap`'s
 * catch used to be `error.status === 401 || error.status === 403`, and it cleared
 * the stored credential. That was harmless only because the browser never called
 * an admin route — and `requireAdmin` on the control plane answers
 * `403 forbidden` to every non-admin, so the moment there is a Users section,
 * opening it would sign a non-admin out of the entire app.
 *
 * The rule is `meansMachineGone`'s, one file over: decide on the **code**, never
 * the status. Asserted here rather than reasoned about, because the failure is
 * invisible to `typecheck` and to every other driver, and its symptom — being
 * thrown back to a sign-in screen mid-turn — arrives on somebody's phone.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhen a failed call ends the session\n");
{
  const { ApiError } = await import("../src/http.js");
  const { authFailure, signedOutText, signInError, signInReady } = await import("../src/account.js");
  const err = (status: number, code: string): unknown => new ApiError(status, code, code);

  check("an unknown session token ends it", authFailure(err(401, "invalid_api_key")), "credentials");
  check("a revoked one does too", authFailure(err(401, "session_revoked")), "credentials");
  check("an expired one says so separately", authFailure(err(401, "session_expired")), "expired");
  check("an unrecognised 401 still ends it", authFailure(err(401, "http_401")), "credentials");
  /*
   * **But a 401 about the request body does not**, and this one shipped as a bug
   * that no offline assertion could have caught — every check above asks about a
   * *credential*, and `invalid_password` is about a field.
   *
   * `POST /v1/me/password` answers it when the current-password box is wrong. The
   * session carrying that request is fine, and it is the only thing standing
   * between the person and the screen they are on. Measured in a browser: mistyping
   * your own password returned you to the sign-in screen, and
   * `changePasswordError`'s "That is not your current password." was unreachable
   * because the session had already been cleared.
   */
  check("but a wrong current password does NOT", authFailure(err(401, "invalid_password")), null);
  check("nor does a refused sign-in", authFailure(err(401, "invalid_login")), null);
  check("a disabled user ends it", authFailure(err(403, "user_disabled")), "disabled");
  check("but a plain 403 does NOT", authFailure(err(403, "forbidden")), null);
  check("nor does any other route-level refusal", authFailure(err(403, "no_scopes")), null);
  check("nor a 404", authFailure(err(404, "machine_not_found")), null);
  check("nor a 500", authFailure(err(500, "boom")), null);
  check("and a transport failure never does", authFailure(new TypeError("Failed to fetch")), null);
  /*
   * **`api_key_revoked` is newly reachable, and reached from a device that is not
   * yours.** `revoked_at` was a column nothing could write, so a key was immortal
   * and `callerAuth`'s arm for it was dead code. There are three writers now —
   * `DELETE /v1/me/keys/:keyId`, its admin twin, and the sweep inside
   * `POST /v1/admin/users/:id/password` — so an admin resetting somebody's
   * password is now a thing that ends this tab, with neither of them touching it.
   *
   * It answers `"credentials"` rather than a fourth `AuthFailure` member on
   * purpose: the union names what the person has to **do**, and the remedy is the
   * sign-in screen, the same one a stolen session leads to.
   */
  check("a revoked API key ends it", authFailure(err(401, "api_key_revoked")), "credentials");
  check("so does no credential at all", authFailure(err(401, "missing_api_key")), "credentials");

  /*
   * **Every code the control plane can answer**, walked in one pass, because the
   * routes this client reaches roughly doubled this round and a per-code `check`
   * is a list somebody adds a route to without noticing. The table is the whole
   * error surface of `app.ts`; what it pins is the shape rather than the entries —
   * six codes end a session, and every one of the other sixteen leaves the
   * credential alone.
   *
   * `machine_revoked`, `key_not_found` and `overloaded` are the ones that make
   * this worth walking: all three are new, all three are refusals about a *thing*
   * rather than about a credential, and under the old `status === 401 || status
   * === 403` test the first of them signed somebody out for pressing Retire twice.
   */
  const SURFACE: ReadonlyArray<readonly [status: number, code: string]> = [
    [400, "bad_request"],
    [401, "api_key_revoked"],
    [401, "invalid_api_key"],
    [401, "invalid_login"],
    [401, "invalid_password"],
    [401, "missing_api_key"],
    [401, "session_expired"],
    [401, "session_revoked"],
    [403, "forbidden"],
    [403, "machine_over_limit"],
    [403, "machine_revoked"],
    [403, "no_scopes"],
    /*
     * **These two are one character apart in meaning and must never share a
     * fate.** `user_disabled` is "you are banned" and ends the session;
     * `owner_disabled` is "the owner of the machine you just touched is banned",
     * which says nothing whatever about the caller — and a grantee signed out of
     * the whole app for opening somebody else's suspended machine would be the
     * worst refusal in this table. The walk below is what holds them apart.
     */
    [403, "owner_disabled"],
    [403, "user_disabled"],
    [404, "key_not_found"],
    [404, "machine_not_found"],
    [404, "not_found"],
    [404, "user_not_found"],
    [409, "machine_exists"],
    [409, "machine_limit"],
    [409, "user_exists"],
    [400, "weak_password"],
    [429, "too_many_attempts"],
    [503, "overloaded"],
  ];
  check(
    "six codes end a session, and no more",
    SURFACE.filter(([status, code]) => authFailure(err(status, code)) !== null).map(([, code]) => code),
    ["api_key_revoked", "invalid_api_key", "missing_api_key", "session_expired", "session_revoked", "user_disabled"],
  );
  check(
    "and each of those says which kind of ending it is",
    SURFACE.map(([status, code]) => authFailure(err(status, code))).filter((f) => f !== null),
    ["credentials", "credentials", "credentials", "expired", "credentials", "disabled"],
  );
  // The three the brief for this section exists for, restated as one line so that
  // deleting any of them is a visible deletion rather than a table edit.
  check(
    "the three that must never sign anybody out",
    [
      authFailure(err(401, "invalid_password")),
      authFailure(err(403, "forbidden")),
      authFailure(new TypeError("Failed to fetch")),
    ],
    [null, null, null],
  );

  check(
    "each ending says something different",
    new Set(["credentials", "disabled", "expired"].map((f) => signedOutText(f as never))).size,
    3,
  );

  check("a wrong password and an unknown name read the same", signInError(err(401, "invalid_login")), signInError(err(401, "invalid_login")));
  check("a disabled account is told apart", signInError(err(403, "user_disabled")) !== signInError(err(401, "invalid_login")), true);
  check("a throttle says to wait", /wait/i.test(signInError(err(429, "too_many_attempts"))), true);
  check(
    "a dead network says it is not your password",
    /not your password/i.test(signInError(new TypeError("Failed to fetch"))),
    true,
  );

  check("Sign in needs both fields", [signInReady("", ""), signInReady("ada", ""), signInReady("", "pw")], [false, false, false]);
  check("a name of spaces is not a name", signInReady("   ", "hunter2hunter2"), false);
  check("and both present is enough", signInReady("ada", "x"), true);
  // Deliberately not the password policy: tightening it later must not disable the
  // only button that leads to the screen where somebody could comply.
  check("signing in does not enforce the password rules", signInReady("ada", "short"), true);
}

/* ------------------------------------------------------------------ *
 * How long the throttle actually said to wait
 *
 * **The number was computed twice on the server and read nowhere here.**
 * `tooManyAttempts` sends `Retry-After` *and* `detail.retryAfterSeconds`,
 * precisely so a client can wait rather than retry into the block — and both
 * halves were thrown away, while somebody facing a fifteen-minute lockout was
 * told to "wait a moment". Coming back in thirty seconds is then advice that
 * makes the wait *longer*, because a refusal during a block doubles it.
 *
 * The **body** is what is read, and it has to be: `parseBody` takes a status, a
 * status text and a string, never a `Response`, so no header can reach an
 * `ApiError` at all. That is why the server says it twice and why only one of the
 * two was ever reachable from a browser. Asserted here because the wrong number
 * and no number look identical in a screenshot.
 * ------------------------------------------------------------------ */

process.stdout.write("\nhow long the throttle said to wait\n");
{
  const { ApiError } = await import("../src/http.js");
  const { changePasswordError, retryAfter, signInError, tooManyAttemptsText, waitText } = await import(
    "../src/account.js"
  );
  const throttled = (detail: unknown): unknown =>
    new ApiError(429, "too_many_attempts", "too many attempts", detail);

  // The throttle's own steps: 5 failures buys 30s, doubling to a 15 min ceiling.
  // Both ends of that range, because the wording changes unit in the middle.
  check("a short block is said in seconds", tooManyAttemptsText(throttled({ retryAfterSeconds: 30 })), "Too many attempts. Wait 30 seconds and try again.");
  check("a long one is said in minutes", tooManyAttemptsText(throttled({ retryAfterSeconds: 900 })), "Too many attempts. Wait 15 minutes and try again.");
  check("and one second is not one seconds", waitText(1), "1 second");
  check("nor is one minute one minutes", waitText(60), "1 minute");
  /*
   * Rounded **up**, never down, and in two places. `retryAfter` ceils the
   * server's seconds and `waitText` ceils the minutes, because telling somebody
   * to come back before the block lifts sends them into a refusal that then
   * extends it.
   */
  check("a fractional second rounds up", retryAfter(throttled({ retryAfterSeconds: 30.2 })), 31);
  check("and 61 seconds is two minutes, not one", waitText(61), "2 minutes");
  check("59 seconds stays in seconds", waitText(59), "59 seconds");

  /*
   * **A missing detail degrades to the old sentence rather than to a wrong
   * number.** An older control plane sends no `detail` at all, and "wait 0
   * seconds" or "wait NaN minutes" are both worse than saying nothing precise.
   * Every shape that is not a positive finite number takes that path.
   */
  check("no detail at all falls back", tooManyAttemptsText(throttled(null)), "Too many attempts. Wait a moment and try again.");
  check("so does a detail without the field", tooManyAttemptsText(throttled({})), "Too many attempts. Wait a moment and try again.");
  check(
    "and so does every unusable value",
    [
      retryAfter(throttled({ retryAfterSeconds: 0 })),
      retryAfter(throttled({ retryAfterSeconds: -5 })),
      retryAfter(throttled({ retryAfterSeconds: "30" })),
      retryAfter(throttled({ retryAfterSeconds: Number.NaN })),
      retryAfter(throttled({ retryAfterSeconds: Number.POSITIVE_INFINITY })),
      retryAfter(new TypeError("Failed to fetch")),
    ],
    [null, null, null, null, null, null],
  );

  /*
   * One sentence for two forms, because it is one refusal from one throttle.
   * `/v1/login` keys on the submitted name plus the caller's address;
   * `passwordChangeKey` keys on the user id — different key spaces on the same
   * counter, and a person who meets both should not have to notice that they were
   * worded differently.
   */
  check(
    "the sign-in form and the password form say the same thing",
    signInError(throttled({ retryAfterSeconds: 120 })),
    changePasswordError(throttled({ retryAfterSeconds: 120 })),
  );
  check("and it carries the number", signInError(throttled({ retryAfterSeconds: 120 })), "Too many attempts. Wait 2 minutes and try again.");
}

/* ------------------------------------------------------------------ *
 * The credential this origin holds
 *
 * The first assertions `cp.ts` has ever had, despite it being loaded by this
 * driver since the day it was written — `store.js` imports it, and its
 * import-time read of `localStorage` is what the stub at the top of this file has
 * been keeping alive.
 *
 * That import already happened, against an empty store, before this section runs.
 * Which is exactly why the migration rule is `pickStored` — a pure function —
 * rather than something a driver seeds storage for and re-imports.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe credential this origin holds\n");
{
  const cp = await import("../src/cp.js");

  check("nothing stored is nobody signed in", cp.pickStored(null, null), null);
  check("an empty string is not a credential", cp.pickStored("", ""), null);
  check(
    "a session token is used as one",
    cp.pickStored("rs_abc", null),
    { value: "rs_abc", kind: "session", migrated: false },
  );
  /*
   * The line that stops a deploy signing the fleet out. An `rk_` key written by
   * the previous build is still a valid bearer — `callerAuth` takes either — so
   * it is adopted under the new name rather than ignored.
   */
  check(
    "a key the old build left still signs you in",
    cp.pickStored(null, "rk_old"),
    { value: "rk_old", kind: "api_key", migrated: true },
  );
  check(
    "and the new name wins when both are there",
    cp.pickStored("rs_new", "rk_old"),
    { value: "rs_new", kind: "session", migrated: false },
  );
  // An empty *fresh* name is not a credential either, so the legacy one is still
  // adopted: `localStorage.setItem(k, "")` and a missing key must not be told
  // apart, because a half-written value is the shape a killed tab leaves.
  check(
    "an empty fresh name does not shadow the old one",
    cp.pickStored("", "rk_old"),
    { value: "rk_old", kind: "api_key", migrated: true },
  );
  /*
   * The migration is about the *name*, never the value: a session token written
   * under the old name is adopted as a session, not mislabelled an API key.
   * Reachable twice over: the release that introduced sessions wrote them under
   * `remoslop.apiKey`, and every release before the product rename wrote them
   * under `remoslop.credential`.
   */
  check(
    "a session token under the old name is still a session",
    cp.pickStored(null, "rs_old"),
    { value: "rs_old", kind: "session", migrated: true },
  );
  check("the two kinds are told apart by their prefix", [cp.credentialKind("rk_x"), cp.credentialKind("rs_x")], ["api_key", "session"]);
  /*
   * The prefix test is `startsWith("rk_")` and everything else is a session,
   * which is the honest reading: `keyPrefix` on the control plane is the only
   * side that assigns them, and a value this client cannot classify is far more
   * likely to be a token it has not heard of than a key.
   */
  check("and anything unrecognised is treated as a session", cp.credentialKind("xx_x"), "session");

  // Both kinds are sent identically. Nothing downstream may start caring which.
  check(
    "both kinds are sent the same way",
    [cp.authHeader({ value: "rs_x", kind: "session" }), cp.authHeader({ value: "rk_x", kind: "api_key" })],
    [{ authorization: "Bearer rs_x" }, { authorization: "Bearer rk_x" }],
  );
  check("and no credential is no header", cp.authHeader(null), null);

  cp.setSession("rs_live");
  check("a session is written under the new name", storage.get("reemoat.credential"), "rs_live");
  check("and never under either old one", [storage.has("remoslop.credential"), storage.has("remoslop.apiKey")], [false, false]);
  check("and is readable back", cp.currentCredential(), { value: "rs_live", kind: "session" });
  cp.clearSession();
  check("clearing removes it rather than blanking it", storage.has("reemoat.credential"), false);
  check("and forgets it in memory too", cp.currentCredential(), null);
  /*
   * **A rename must not sign anybody out**, and the two old names are swept
   * rather than left behind — otherwise the next `readStoredCredential` adopts a
   * stale token from a tab that was signed out on purpose.
   */
  storage.set("remoslop.credential", "rs_from_before_the_rename");
  cp.setSession("rs_after");
  check("and adopting the pre-rename name clears it", storage.has("remoslop.credential"), false);
  cp.clearSession();
  storage.set("remoslop.apiKey", "rk_older_still");
  cp.clearSession();
  check("signing out sweeps every legacy name", storage.has("remoslop.apiKey"), false);
}

/* ------------------------------------------------------------------ *
 * Whose refusal a 401 actually is
 *
 * `cpFetch` is the one place a dead credential is noticed, and it used to attach
 * that refusal to whatever was current when it *landed* rather than to what the
 * request carried. `CP_TIMEOUT_MS` is ten seconds, which is ten seconds of window
 * in which the credential can be replaced: a slow `GET /v1/me` sent with an
 * expiring token, a wake that notices first, a sign-in that succeeds, and then
 * the old request finally answering `401 session_expired` — which cleared the
 * **new** token from memory and from `localStorage` and dropped the tab back to
 * the gate about a session that was perfectly good and that, no `DELETE
 * /v1/me/sessions/current` having been sent, then lingered for its full thirty
 * days.
 *
 * Driven through the real `cpFetch` against a stubbed `fetch` that answers when
 * this driver says so, because the whole subject is *when* the answer arrives
 * relative to the swap. Both directions are asserted: a refusal of the credential
 * still held must go on signing the tab out, or this fix would have replaced one
 * silent failure with a worse one.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhose refusal a 401 actually is\n");
{
  const cp = await import("../src/cp.js");
  const { store } = await import("../src/store.js");

  const realFetch = globalThis.fetch;
  /** Resolved by the case, so the answer lands exactly where it is wanted. */
  let answer: ((response: Response) => void) | null = null;
  globalThis.fetch = ((): Promise<Response> =>
    new Promise<Response>((resolve) => {
      answer = resolve;
    })) as typeof fetch;

  const refusal = (code: string): Response =>
    new Response(JSON.stringify({ error: { code, message: "your session expired" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  /*
   * Answering goes through a function on purpose. `answer` is assigned inside
   * the `fetch` stub's promise executor, and TypeScript's flow analysis does not
   * follow an assignment made in a nested closure: inside this block it still
   * believes the initializer, narrows the variable to `null`, and types the call
   * `never` (TS2349). Read from another function scope it is the declared type
   * again — and the throw is worth having anyway, since a case that answers with
   * no request in flight is asserting against the wrong `fetch`.
   */
  const respond = (response: Response): void => {
    if (!answer) throw new Error("no request was in flight to answer");
    answer(response);
  };

  let signedOut = 0;
  cp.onSignedOut(() => void (signedOut += 1));

  // The window: sent under one credential, answered after another has replaced it.
  cp.setSession("rs_stale");
  const late = cp.me().catch((error: unknown) => error);
  await sleep(20);
  cp.setSession("rs_fresh");
  respond(refusal("session_expired"));
  const caught = await late;

  check("a 401 for a superseded credential does not clear the current one", cp.currentCredential()?.value, "rs_fresh");
  check("nor the copy in storage", storage.get("reemoat.credential"), "rs_fresh");
  report("and does not return the tab to the gate", signedOut === 0, `signedOut fired ${signedOut}×`);
  /*
   * Still a rejection, and that is deliberate rather than incidental: the call
   * failed and its caller shows its own error. What is swallowed is only the
   * *signal*, never the failure.
   */
  check("the caller is still told the call failed", (caught as { code?: string }).code, "session_expired");

  // The other direction, which is the capability this must not have cost: the
  // credential that was refused is the one still held, so the tab does go.
  const now = cp.me().catch(() => null);
  await sleep(20);
  respond(refusal("session_revoked"));
  await now;
  check("a 401 for the credential still held clears it", cp.currentCredential(), null);
  report("and signs the tab out", signedOut === 1, `signedOut fired ${signedOut}×`);

  // Put the store's own handler back — it is registered once, from `store.ts`'s
  // module body, and this section replaced it.
  cp.onSignedOut((failure) => store.handleSignedOut(failure));
  globalThis.fetch = realFetch;
  cp.clearSession();
}

/* ------------------------------------------------------------------ *
 * Leaving the loading screen without a reload
 *
 * `phase` was written by `bootstrap` and `handleSignedOut` and by nothing else,
 * and `bootstrap` runs once, at page load. So a tab opened while the control
 * plane was down rebuilt *everything* on the retry path — connections, daemons,
 * tokens, the session poll — and went on rendering `App`'s bare spinner for ever,
 * under a `cpError` the same patch had just cleared so it no longer even said
 * why. The only way out was a manual reload, on a phone, and no wake trigger
 * helped: `resume.ts` lands in the same function.
 *
 * Driven through `bootstrap` and `resume` against a stubbed `fetch`, because the
 * claim is about a *sequence* — down, then up — and only a sequence can tell the
 * promotion apart from `bootstrap` having simply succeeded.
 *
 * **The registry that answers with nothing in it is the case, not a corner.** The
 * first version of this promoted on `connections.size > 0`, mirroring
 * `bootstrap`'s *catch* arm rather than its success arm, and so could not fire
 * for an account that owns no machines — a fresh sign-in, or one whose machines
 * were all revoked, which is precisely who is stuck and precisely who the app
 * would send to Settings → Machines if it would only render. It is worse than a
 * stalemate: `tick`'s retry gate is `connections.size === 0 && phase ===
 * "loading"`, so the phase pinned there turns the escape hatch into a
 * `GET /v1/machines` every four seconds for ever, under a spinner whose `cpError`
 * the same patch has just cleared. So the zero-machine step below asserts `ready`
 * and the gate's own inputs, and a revert to `size > 0` fails on both.
 *
 * `me` is asserted too, since promoting without re-reading it is how an admin
 * silently loses the Users section (`visibleSections` fails closed on a null
 * `me`) until they reload.
 * ------------------------------------------------------------------ */

process.stdout.write("\nleaving the loading screen without a reload\n");
{
  const cp = await import("../src/cp.js");
  const { store } = await import("../src/store.js");

  const realFetch = globalThis.fetch;
  /** What this control plane answers, by path. `null` is "unreachable". */
  let routes: (path: string) => unknown = () => null;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const body = routes(String(input));
    if (body === null) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const record = {
    id: "m_cp",
    name: "laptop",
    relayUrl: "wss://cp.example/relay",
    relayOnline: true,
    enrolled: true,
    owned: true,
    scopes: [],
  };
  const internals = store as unknown as { stopPolling(): void; connections: Map<string, unknown> };

  cp.setSession("rs_boot");
  await store.bootstrap();
  // The poll would otherwise fire its own `cp-retry` mid-section — `tick` calls
  // exactly the path under test. Stopped here so each step below is the one this
  // driver asked for.
  internals.stopPolling();
  check("a control plane that is down leaves the app loading", store.getSnapshot().phase, "loading");
  report("and says so", store.getSnapshot().cpError !== null, `cpError: ${String(store.getSnapshot().cpError)}`);

  /*
   * It answers again, with **nothing in it** — the account that owns no machines,
   * which is the one this escape exists for. The listing succeeded, so the
   * registry is known and the app is usable; that it is empty is an answer rather
   * than an absence, and Settings → Machines is the screen it is supposed to be
   * showing.
   */
  const me = { id: "u_1", name: "ada", isAdmin: true, via: "session", hasPassword: true };
  routes = (path) => (path === "/v1/machines" ? { machines: [] } : path === "/v1/me" ? me : null);
  await store.resume("cp-retry");
  check("a registry that answers with nothing in it still leaves the loading screen", store.getSnapshot().phase, "ready");
  check("and the outage banner is cleared", store.getSnapshot().cpError, null);
  /*
   * The second cost of the old rule, asserted as the gate's own inputs rather
   * than by waiting four seconds for the poll it would have fired. `tick` retries
   * on `connections.size === 0 && phase === "loading"`, both of which were true
   * for ever under `size > 0`, so the escape hatch became a request every four
   * seconds — the poll that gate's comment exists to prevent — with a bare
   * spinner on screen the whole time.
   */
  report(
    "so the four-second cp-retry stops firing, with no machine to make it stop",
    internals.connections.size === 0 && store.getSnapshot().phase !== "loading",
    `connections: ${internals.connections.size}, phase: ${store.getSnapshot().phase}`,
  );
  // `refreshMe` is fired beside the promotion and not awaited by it, so this is
  // the one assertion here that has to wait for a request rather than for a call.
  await sleep(30);
  check("and `me` is re-read rather than left null", store.getSnapshot().me?.name, "ada");
  report(
    "which is what keeps an admin's own sections visible",
    store.getSnapshot().me?.isAdmin === true,
    `me: ${JSON.stringify(store.getSnapshot().me)}`,
  );

  /*
   * And a registry with a machine in it is connected as it always was — the
   * promotion is a phase change and not a replacement for the per-machine work,
   * which is the half a reader of the fix above might assume it had folded in.
   */
  routes = (path) => (path === "/v1/machines" ? { machines: [record] } : path === "/v1/me" ? me : null);
  await store.resume("cp-retry");
  check("a machine arriving later is still connected", internals.connections.has("m_cp"), true);
  check("and the phase does not move back", store.getSnapshot().phase, "ready");

  internals.stopPolling();
  internals.connections.delete("m_cp");
  globalThis.fetch = realFetch;
  cp.clearSession();
}

/* ------------------------------------------------------------------ *
 * The password rules, mirrored from the control plane
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe password rules\n");
{
  const { PASSWORD_MIN, PASSWORD_MAX, passwordProblem, passwordProblemText, changePasswordError } = await import(
    "../src/account.js"
  );
  const { ApiError } = await import("../src/http.js");

  check("too short is refused", passwordProblem("old-password", "short", "short"), "too_short");
  check("too long is refused", passwordProblem("old-password", "x".repeat(300), "x".repeat(300)), "too_long");
  check("a mismatch is caught", passwordProblem("old-password", "a-fine-password", "a-fine-passwerd"), "mismatch");
  check("so is typing the old one twice", passwordProblem("a-fine-password", "a-fine-password", "a-fine-password"), "unchanged");
  check("and a good one passes", passwordProblem("old-password", "a-fine-password", "a-fine-password"), null);
  // Length before mismatch: it has to be fixed either way, and reporting the
  // mismatch first sends somebody to re-type a password that is too short anyway.
  check("length is reported before a mismatch", passwordProblem("old", "abc", "abd"), "too_short");
  check("the minimum is pinned, because it is a mirror", PASSWORD_MIN, 12);

  /*
   * **And the mirror is compared to the thing it mirrors**, which is the half
   * the line above cannot do: it is a *third* copy of the number, so all three
   * agree exactly as long as nobody touches the side that enforces anything.
   * Raise `password.ts` to 14 and every driver in this repo stays green while
   * every form still says "At least 12 characters", `canSubmit` still enables
   * the button, and the submission lands on a `400 weak_password` the client had
   * already promised was fine — the same shape as `canSend` disagreeing with the
   * prompt route.
   *
   * Nothing else can span it. `packages/web` is type-checked by its own config
   * and `src/` may not import the control plane at all, so the only thing that
   * crosses the boundary is reading the other side off disk — `enrollmentLines`'
   * technique, one size smaller: a regex rather than a function body, because
   * these are two bare literals.
   */
  const policy = readFileSync(new URL("../../control-plane/src/password.ts", import.meta.url), "utf8");
  const serverBound = (name: string): number => {
    const found = new RegExp(`^export const ${name} = (\\d+);$`, "m").exec(policy)?.[1];
    /*
     * Loud rather than `NaN`. The day that constant becomes an expression or
     * moves file this says which name went missing, instead of failing as a
     * comparison against a number nobody wrote.
     */
    if (found === undefined) throw new Error(`password.ts no longer exports ${name} as a bare numeric literal`);
    return Number(found);
  };
  check("the client's minimum is the server's", PASSWORD_MIN, serverBound("PASSWORD_MIN_LENGTH"));
  check("and so is its maximum", PASSWORD_MAX, serverBound("PASSWORD_MAX_LENGTH"));

  check("every problem says something", new Set((["too_short", "too_long", "mismatch", "unchanged"] as const).map(passwordProblemText)).size, 4);

  check(
    "a wrong current password is named",
    changePasswordError(new ApiError(401, "invalid_password", "x")),
    "That is not your current password.",
  );
  // The server's own sentence, not a repeat of the client's stale number: this arm
  // is only reachable once the mirror above has drifted.
  check(
    "a server-side policy refusal passes its own message through",
    changePasswordError(new ApiError(400, "weak_password", "password must be at least 16 characters")),
    "password must be at least 16 characters",
  );
}

/* ------------------------------------------------------------------ *
 * The one measurement in a text field's chrome
 *
 * Almost nothing the settings screens gained this round is reachable from here:
 * the two-step delete's row order, the `sm:` stacking on a user row and the
 * reserved control slot are all JSX props, and the sentence stating each lives
 * beside the prop. This is the exception, and it is here because it is a
 * **number that was measured** rather than a class somebody preferred.
 *
 * `SignIn` and the password form under Settings → Account are the same control
 * one screen apart and had already drifted — `py-3` against `py-2`. `index.css`
 * forces `font-size: max(16px, 1em)` on every input under a coarse pointer (the
 * rule that stops iOS zooming the page on focus), so at a 16px face those are
 * roughly 47px and 39px tall: the *same field* on either side of the 44px tap
 * minimum depending on which screen you reached it from.
 *
 * **That was pinned as `py-3` and is pinned as `min-h` now**, because padding only
 * ever reached 44px by multiplying with a line-height that lives in the type
 * scale — a rendered height that no file stated and that nothing could assert
 * without a DOM. Two controls meant to line up then differed by 10px, and the
 * class that was supposed to fix it never applied at all: Tailwind emits every
 * utility at equal specificity, `.py-3` is emitted after `.py-2`, so
 * `` `${FIELD} py-2` `` silently kept the taller box.
 *
 * What this cannot assert is the cascade or the call sites — there is no DOM here
 * and no CSS — so it pins the numbers, and the *absence* of the padding a caller
 * would try to beat.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe one measurement in a text field's chrome\n");
{
  const { FIELD } = await import("../src/ui/bits.js");

  check("the field states a resting height", FIELD.includes("min-h-9"), true);
  check("and the floor that clears 44px under a thumb", FIELD.includes("[@media(pointer:coarse)]:min-h-11"), true);
  // The height is not padding any more, and that is the property: with no `py-*`
  // in the string there is nothing for a caller's own to lose an argument to.
  check("with no vertical padding at all", /\bpy-\d/.test(FIELD), false);
  // Layout is deliberately absent: width, margin and `block` legitimately differ
  // between a full-width form field and a `flex-1` one beside a Button, and
  // folding one caller's layout in here is how the next caller writes a fourth
  // copy to get out of it.
  check(
    "and it carries no layout for a caller to fight",
    ["w-full", "mt-", "flex-1", "block", "max-w-"].filter((token) => FIELD.includes(token)),
    [],
  );
}

/* ------------------------------------------------------------------ *
 * Which device a session signed in from
 *
 * Every assertion here is a claim about a string this code will never be handed
 * during development — nobody signs in from Windows on the machine this is
 * written on, and the whole point of the list is that it describes the sessions
 * that are *not* yours. So this driver is the only thing that ever exercises the
 * table, and the ordering it pins is the entire correctness argument: these
 * agents are subsets of each other on purpose, because a browser claims its
 * predecessors so that sniffing written before it existed keeps working.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich device a session signed in from\n");
{
  const { agentWasRecorded, describeAgent, deviceLine } = await import("../src/device.js");

  // Real agents, copied rather than composed, because a hand-written one would be
  // built from the same assumption the parser is.
  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const SAFARI_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const SAFARI_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const CHROME_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";
  const EDGE_WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
  const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
  const CHROME_ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

  check("Chrome on a Mac", describeAgent(CHROME_MAC), "Chrome on macOS");
  check("Safari on a Mac", describeAgent(SAFARI_MAC), "Safari on macOS");
  check("Safari on a phone", describeAgent(SAFARI_IPHONE), "Safari on iPhone");
  /*
   * The four that the ordering exists for, and each was a wrong answer with the
   * table in any other order.
   *
   * Chrome's agent ends `Chrome/141 Safari/537.36`, so testing `Safari` first
   * calls every desktop browser Safari. Edge's is Chrome's plus `Edg/141`. On iOS
   * every browser is WebKit and only the name differs, so without `CriOS` every
   * iPhone in the list reads "Safari". And Android's agent begins `Linux;
   * Android`, so `Linux` last is what stops a phone reading as a desktop.
   */
  check("Chrome is not reported as Safari", describeAgent(CHROME_MAC)?.startsWith("Chrome"), true);
  check("Edge is not reported as Chrome", describeAgent(EDGE_WINDOWS), "Edge on Windows");
  check("Chrome on iOS is not reported as Safari", describeAgent(CHROME_IPHONE), "Chrome on iPhone");
  check("Android is not reported as Linux", describeAgent(CHROME_ANDROID), "Chrome on Android");
  check("Firefox on a desktop Linux", describeAgent(FIREFOX_LINUX), "Firefox on Linux");

  /*
   * **The ordering property itself, rather than seven agents that happen to
   * exercise it.**
   *
   * Every pair below is two needles that a real agent carries *at once*, which is
   * what makes the table's order the whole correctness argument: `firstMatch`
   * returns on the first `includes`, so a table sorted any other way answers the
   * broader name. The strings are synthetic and minimal on purpose — a copied
   * agent proves one vendor's current string, this proves the rule, and the rule
   * is what a new entry inserted in the wrong place breaks.
   *
   * `Linux` last is the one with a phone behind it: Android's agent begins
   * `Mozilla/5.0 (Linux; Android 14; …)`, so `Linux` above it calls every Android
   * device a desktop. `Chromium` above `Chrome` is the mirror — Chromium's agent
   * carries `Chromium/141.0.0.0 Chrome/141.0.0.0` — and both are invisible to
   * anybody developing on a Mac.
   */
  const PAIRS: ReadonlyArray<readonly [ua: string, want: string]> = [
    ["Chrome/1 Safari/2", "Chrome"],
    ["Chrome/1 Safari/2 Edg/3", "Edge"],
    ["Chromium/1 Chrome/1 Safari/2", "Chromium"],
    ["Chrome/1 Safari/2 OPR/3", "Opera"],
    ["SamsungBrowser/1 Chrome/1 Safari/2", "Samsung Internet"],
    ["CriOS/1 Safari/2", "Chrome"],
    ["FxiOS/1 Safari/2", "Firefox"],
    ["EdgiOS/1 Safari/2", "Edge"],
    ["OPiOS/1 Safari/2", "Opera"],
    ["Linux; Android 14", "Android"],
    ["X11; CrOS x86_64", "ChromeOS"],
  ];
  check(
    "every needle that contains another resolves to the more specific one",
    PAIRS.map(([ua]) => describeAgent(ua)),
    PAIRS.map(([, want]) => want),
  );

  // A half-answer beats none: `curl` has no platform, and an unknown browser on a
  // known platform still narrows it for the person reading.
  check("a platform with no known browser still says the platform", describeAgent("Mozilla/5.0 (Windows NT 10.0)"), "Windows");
  check("nothing recognised is null, never a guess", describeAgent("SomeBot/1.0"), null);
  check("an absent agent is null", describeAgent(null), null);
  check("so is one that predates the table", describeAgent(undefined), null);
  check("and so is an empty string", describeAgent("   "), null);

  /*
   * Every row is named, including your own.
   *
   * This used to take a `current` flag and answer "This device", which cost the
   * browser its place on the row somebody looks at first — an account with one
   * session then showed no browser anywhere, and the feature read as unbuilt.
   * Which row you are on is drawn as a badge instead, because it is the one thing
   * on the row that is certain.
   */
  check("your own row is named too", deviceLine(CHROME_MAC), "Chrome on macOS");

  /*
   * **The two fallbacks are different sentences, and collapsing them was a real
   * complaint.** Both used to read "Unrecognised device", and the first question
   * anybody asked on seeing it was *what does that mean — did it fail?* It had
   * not: those rows predate the table that records an agent at all, and nothing
   * was ever handed to the parser.
   *
   * They have different remedies, which is the test for whether one word can
   * serve both. Nothing recorded: sign in again and it will be. Something
   * recorded that we cannot read: that row is as identified as it will ever get.
   */
  check("a session that recorded nothing says so", deviceLine(null), "Signed in before this was recorded");
  check("and so does one whose field is empty", deviceLine("  "), "Signed in before this was recorded");
  check("an agent we cannot read is a different sentence", deviceLine("SomeBot/1.0"), "Unrecognised browser");
  check("nothing recorded is not 'recorded'", agentWasRecorded(null), false);
  check("nor is an empty string", agentWasRecorded("   "), false);
  check("an unreadable agent still counts as recorded", agentWasRecorded("SomeBot/1.0"), true);
  // Neither fallback may be empty: a blank cell where the other rows have words
  // reads as a rendering fault rather than as an absence.
  report(
    "every row says something",
    [null, undefined, "  ", "SomeBot/1.0", CHROME_MAC].every((ua) => deviceLine(ua).length > 0),
    "5 shapes",
  );
}

/* ------------------------------------------------------------------ *
 * A login transcript, read as steps
 *
 * `ui/login.ts` turns pty bytes into "open this page", "read this code" and a
 * recognised failure. It is a **reading, not a protocol** — nothing here is
 * negotiated with any agent, and a vendor may reword any of it in a release —
 * so the load-bearing case is the last one in this section: when nothing is
 * recognised the view is all-null, `transcriptIsTheAnswer` says so, and the card
 * shows the raw output. That is what makes the worst case equal to the screen
 * this replaced rather than worse than it.
 * ------------------------------------------------------------------ */

process.stdout.write("\na login transcript, read as steps\n");
{
  const {
    extractCode,
    extractFailure,
    extractUrls,
    readLoginTranscript,
    transcriptIsTheAnswer,
    loginOutcome,
    rawTranscriptIsOpen,
  } = await import("../src/ui/login.js");

  /*
   * The one failure string that is measured rather than guessed.
   *
   * On macOS the login wizard does not run for any agent: BSD `script` reads its
   * own stdin's termios to copy onto the pty it is allocating, and it is handed a
   * pipe. What somebody saw was this line in a `<pre>`, with nothing connecting
   * it to "paste a token instead".
   */
  const TCGETATTR = "script: tcgetattr/ioctl: Operation not supported on socket\n";
  check("the macOS pty failure is recognised", extractFailure(TCGETATTR) !== null, true);
  check(
    "and it is drawn as a failure once the process is gone",
    readLoginTranscript(TCGETATTR, true, true).phase,
    "failed",
  );
  /*
   * **A failure while the flow is still running is not `failed`.** These programs
   * print warnings and retry, and a card that gave up on the first alarming line
   * would abandon a login that was about to work.
   */
  check(
    "but not while the flow is still alive",
    readLoginTranscript(TCGETATTR, false, true).phase,
    "starting",
  );
  check(
    "and the sentence is carried either way",
    readLoginTranscript(TCGETATTR, false, true).message !== null,
    true,
  );

  // Deduplicated because these flows *redraw*: a spinner repaints its line and
  // the same authorize URL is printed a dozen times.
  check(
    "a redrawn URL is offered once",
    extractUrls("go to https://example.com/device\r  go to https://example.com/device\n"),
    ["https://example.com/device"],
  );

  check("a code introduced by its own word", extractCode("Then enter the code: WDJB-MJHT"), "WDJB-MJHT");
  /*
   * **The newest code, from the same end the URL is read from.**
   *
   * These flows reprint on expiry. `extractUrls().at(-1)` always moved to the
   * fresh page while a non-global `exec` here stayed on the first code, so the
   * card showed a live page beside a dead code — the one pairing that cannot
   * work. Both ends have to agree.
   */
  const reprinted =
    "Open https://example.com/a and enter the code: AAAA-1111\n" +
    "That code expired.\n" +
    "Open https://example.com/b and enter the code: BBBB-2222\n";
  check("a reprinted flow offers the newest code", extractCode(reprinted), "BBBB-2222");
  check("beside the newest page", readLoginTranscript(reprinted, false, false).url, "https://example.com/b");
  /*
   * And the transient word that used to be in `FAILURES` is not: the table is
   * matched against the *whole* transcript, so an entry about something the flow
   * recovers from is a claim about the past stated in the present — here, a
   * finished login drawn as failed in red beside a badge reading "signed in".
   */
  check("an expiry it recovered from is not a failure", extractFailure(reprinted), null);
  check("so the finished run reads as done", readLoginTranscript(reprinted, true, false).phase, "done");
  check("a bare hyphenated code", extractCode("  ABCD-1234  \n"), "ABCD-1234");
  check("an unhyphenated one needs the word", extractCode("Your code is 4827193\n"), null);
  // The bare pattern matches anything hyphenated and shouty, and these flows
  // print several such words that are not codes.
  check("and a word that merely looks like one is not", extractCode("charset UTF-8\n"), null);

  /*
   * `done` and `needsInput` come from outside because neither is in the bytes:
   * the first is the daemon saying the process exited, the second is a fact about
   * the agent's flow read off the daemon's own table. That split is what makes
   * "draw an input box" not a guess.
   */
  const device = "Open https://example.com/device and enter the code: WDJB-MJHT\n";
  check(
    "a device flow waits rather than asking",
    readLoginTranscript(device, false, false).phase,
    "waiting",
  );
  check(
    "the same bytes with an input box are an action",
    readLoginTranscript(device, false, true).phase,
    "acting",
  );
  check("and an exited flow with nothing wrong is done", readLoginTranscript(device, true, false).phase, "done");

  /*
   * The fallback, and the reason the parser is allowed to be a guess at all.
   * `transcriptIsTheAnswer` is the predicate the card opens its `<details>` on,
   * asserted here rather than restated at the call site.
   */
  const unrecognised = "Contacting the authorization server, please stand by.\n";
  const view = readLoginTranscript(unrecognised, false, false);
  check(
    "an unrecognised transcript yields nothing",
    [view.url, view.code, view.message],
    [null, null, null],
  );
  check("so the raw output is the answer", transcriptIsTheAnswer(view), true);
  check("and the card is still honest about being alive", view.phase, "starting");
  check(
    "while a recognised one is not the answer",
    transcriptIsTheAnswer(readLoginTranscript(device, false, false)),
    false,
  );

  /* ---------------------------------------------------------------- *
   * A spent code is not an instruction
   *
   * ⭐ **The reported defect, and it was pinned by nothing.** A device code and a
   * sign-in link are things to DO; once the process has exited there is nothing
   * to open and nothing to type. The bytes still hold both — no device flow ever
   * prints that a code was consumed, and `extractCode` reads the newest match on
   * purpose — so a finished login left a dead link and a spent code on screen
   * under a badge already reading "signed in". Q3.430.
   * ---------------------------------------------------------------- */
  {
    const finished = readLoginTranscript(device, true, false);
    check("an exited flow offers no page and no code", [finished.url, finished.code], [null, null]);
    check("and is still recognised as finished", finished.phase, "done");
    // The failure branch had the same defect: a recognised failure printed in red
    // above a code that still looked live.
    const brokenAfterCode = `${device}\nscript: tcgetattr/ioctl: Operation not supported on socket\n`;
    const failed = readLoginTranscript(brokenAfterCode, true, false);
    check("a failed flow offers neither either", [failed.url, failed.code, failed.phase], [null, null, "failed"]);
    /*
     * ⚠ **The trap in the fix above.** `transcriptIsTheAnswer` is "nothing was
     * recognised", and nulling two fields on exit makes every finished run
     * satisfy it — so without its phase guard, every login that WORKED would
     * spring the raw pty pane open under its own success message.
     */
    check("a finished run is never its own transcript's answer", transcriptIsTheAnswer(finished), false);
    check("and neither is a failed one", transcriptIsTheAnswer(failed), false);
  }

  /* ---------------------------------------------------------------- *
   * What the card may claim once the process has exited
   *
   * `done` says a pty child ended: the exit status is deliberately unread, and
   * `FAILURES` has no success counterpart. The re-probe is the only oracle, and
   * the card used to duck it entirely — "Finished. The status above says whether
   * it worked." — while the badge above was still drawing the pre-login listing,
   * which is "not signed in" by construction. Q3.430.
   * ---------------------------------------------------------------- */
  check("a check in flight outranks everything", loginOutcome(true, true, true), "checking");
  check("a check that could not be made is not a verdict", loginOutcome(false, true, true), "unreachable");
  check(
    "and otherwise the probe's own three answers survive",
    [loginOutcome(false, false, true), loginOutcome(false, false, false), loginOutcome(false, false, null)],
    ["signedIn", "notSignedIn", "cannotTell"],
  );
  // An older daemon sends no field at all; "cannot tell" is the honest reading.
  check("an absent answer is cannot-tell", loginOutcome(false, false, undefined), "cannotTell");
  {
    const finished = readLoginTranscript(device, true, false);
    const broken = readLoginTranscript(`${device}\ncommand not found\n`, true, false);
    check(
      "the terminal opens only where the card has run out of things to say",
      [
        rawTranscriptIsOpen(finished, "signedIn"),
        rawTranscriptIsOpen(finished, "notSignedIn"),
        rawTranscriptIsOpen(finished, "checking"),
        rawTranscriptIsOpen(finished, "cannotTell"),
        rawTranscriptIsOpen(finished, "unreachable"),
      ],
      [false, false, false, true, true],
    );
    // A recognised failure already says what to do; the terminal adds nothing.
    check("never under a failure that named itself", rawTranscriptIsOpen(broken, "cannotTell"), false);
    check(
      "and the live rule is unchanged",
      rawTranscriptIsOpen(readLoginTranscript(unrecognised, false, false), null),
      true,
    );
  }
}

/* ------------------------------------------------------------------ *
 * What one agent's card says
 *
 * ⭐ **No driver reads `AgentsPanel.tsx` at all**, so every rule this card lives
 * by was a rule nothing protected — which is how a wall of adapter-vs-CLI prose
 * shipped to a non-technical reader, and how a stored key became unremovable.
 * The sentences are data in `ui/agentCard.ts` for exactly that reason. Q3.431.
 * ------------------------------------------------------------------ */
process.stdout.write("\nwhat one agent's card says\n");
{
  const {
    agentLabel,
    agentStance,
    tokenBlockFor,
    stanceLine,
    credentialCaveat,
    credentialLabel,
    CREDENTIAL_LABELS,
    storedChip,
    signOutSentence,
    dividerWord,
    multiSlotLine,
  } = await import("../src/ui/agentCard.js");

  check(
    "an agent is named, not its package",
    [agentLabel("claude"), agentLabel("kimi"), agentLabel("codex")],
    ["Claude", "Kimi", "Codex"],
  );
  // A fourth agent from a newer daemon still renders — as its id, never blank.
  check("an unknown agent still has a name", agentLabel("newthing"), "newthing");

  /*
   * The two axes are **not** one boolean. `available` is the adapter;
   * `login.supported` is `script` plus the agent's own CLI, a different binary.
   * Reading them as one is what drew a Sign-in button that could not act.
   */
  check(
    "the stance is a total partition",
    [
      agentStance(false, true),
      agentStance(true, true),
      agentStance(true, false),
      agentStance(true, null),
    ],
    ["not_installed", "signed_in", "signed_out", "unchecked"],
  );

  /*
   * ⭐ **A stored key is never hidden, in any stance.** This is the property the
   * shipped `stored > 0` guard fixed for one state, asserted here over the whole
   * grid: a pasted `KIMI_API_KEY` is by itself enough to make kimi report signed
   * in, and the block that hid then contained the only caller of
   * `clearCredential` in this package.
   */
  const stances = ["not_installed", "signed_in", "signed_out", "unchecked"] as const;
  check(
    "a saved key is never hidden, whatever the stance",
    stances.map((stance) => tokenBlockFor(stance, 1) === "hidden"),
    [false, false, false, false],
  );
  check(
    "and nothing is typeable where nothing could help",
    stances.map((stance) => tokenBlockFor(stance, 0)),
    ["hidden", "hidden", "editable", "editable"],
  );

  /* The two commonest states say nothing at all: the badge says it and the
     control below does something about it. */
  check(
    "the card is silent where a sentence could only repeat the badge",
    [stanceLine("codex", "signed_in", true), stanceLine("codex", "signed_out", true)],
    [null, null],
  );
  check("and speaks where there is no way in", stanceLine("codex", "signed_out", false) !== null, true);

  /*
   * ⭐ **Codex's caveat is the one measurement that survives the cull** (Q2.200):
   * with `CODEX_API_KEY` set and no real login, the adapter still answers
   * `session/new` with -32000. It must not overclaim either — the key IS merged
   * last at spawn and does reach codex's own API calls.
   */
  const codexCaveat = credentialCaveat("codex", true) ?? "";
  check("codex warns that a key alone is not enough", codexCaveat.length > 0, true);
  check("and does not overclaim that it does nothing", /does nothing|ignored|useless/i.test(codexCaveat), false);
  check("claude needs no caveat", credentialCaveat("claude", true), null);

  /*
   * The jargon floor. Every sentence this card can produce, against the
   * vocabulary the deleted wall was made of. A reader who has never seen an env
   * var must not meet one here.
   */
  const JARGON =
    /\bPATH\b|_KEY|_TOKEN|session\/new|-32000|~\/|\.json\b|daemon|adapter|CLI\b|stdin|env\b|API key from the|npm |pnpm /;
  const sentences: string[] = [];
  for (const id of ["claude", "kimi", "codex"]) {
    for (const stance of stances) {
      for (const can of [true, false]) {
        const line = stanceLine(id, stance, can);
        if (line !== null) sentences.push(line);
      }
    }
    const caveat = credentialCaveat(id, true);
    if (caveat !== null) sentences.push(caveat);
    sentences.push(signOutSentence(id, 0), signOutSentence(id, 1));
    for (const stance of stances) sentences.push(storedChip(id, stance));
    const multi = multiSlotLine(id, 2);
    if (multi !== null) sentences.push(multi);
  }
  check(
    "nothing the card can say is written for a developer",
    sentences.filter((line) => JARGON.test(line)),
    [],
  );

  /*
   * The credential labels, cross-checked against the daemon's own `envNames` read
   * as text — a fifth credential added there must be named here or a person meets
   * a raw variable again.
   */
  const agentsSrc = readFileSync(new URL("../../../src/acp/agents.ts", import.meta.url), "utf8");
  const declared = [...agentsSrc.matchAll(/envNames: \[([^\]]*)\]/g)]
    .flatMap((match) => [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((inner) => inner[1] ?? ""));
  check("the daemon declares credentials at all", declared.length > 0, true);
  /*
   * ⚠ **Against the table, never against `credentialLabel`'s answer.** This read
   * `credentialLabel(envName).name === envName` and **could not fail**: the
   * fallback lowercases, replaces underscores and capitalises, so no
   * SCREAMING_SNAKE_CASE name is ever returned unchanged — with or without an
   * entry. Measured: `ANTHROPIC_API_KEY` → `Anthropic api key`, and the same for
   * an invented fifth. So the one thing this exists to catch, a credential added
   * to `src/acp/agents.ts` and not named here, passed loudest.
   *
   * Membership is the property the sentence above already claims. The fallback
   * stays — it is what a *newer daemon* gets, and it is deliberately not what
   * this driver accepts.
   */
  check(
    "and every one of them is named in the table rather than auto-humanised",
    declared.filter((envName) => !(envName in CREDENTIAL_LABELS)),
    [],
  );
  // And the fallback itself, pinned once — both because it is what a *newer*
  // daemon's fifth credential gets, and because it is the reason the check above
  // had to be rewritten: it never echoes its input, so equality against `envName`
  // was a filter that could only ever be empty.
  check(
    "an unknown credential is humanised rather than shown raw",
    credentialLabel("SOME_NEW_API_KEY").name,
    "Some new api key",
  );

  /* An "or" is only drawn when there is something on both sides of it. */
  check(
    "the divider says what it separates",
    [dividerWord(true, "editable"), dividerWord(false, "editable"), dividerWord(true, "stored_only"), dividerWord(true, "hidden")],
    ["or", "Sign in with a key instead", "Saved keys", null],
  );
  check("claude is the only agent told it has a choice", multiSlotLine("claude", 1), null);
}

/* ------------------------------------------------------------------ *
 * Which settings screen a URL names, and who may see it
 *
 * Imports `settings.ts` and **not** `router.ts`, and the reason is mechanical:
 * `router.ts` parses `window.location.pathname` and installs a `popstate`
 * listener in its module body, and the stub at the top of this file has neither.
 * Adding `pathname` to it is the tempting wrong answer — it would also install a
 * live history listener into a driver.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich settings screen a URL names\n");
{
  const {
    SECTION_SPECS,
    parseSettingsRoute,
    parseSettingsSection,
    pluginSettingsPath,
    settingsPath,
    sectionAllowed,
    visibleSections,
    settingsUp,
    settingsPaneTitle,
    settingsUpLabel,
  } = await import("../src/settings.js");

  check("no segment is the index", parseSettingsSection(undefined), null);
  check("a known one is itself", parseSettingsSection("machines"), "machines");
  // A stale bookmark lands somewhere real rather than on nothing.
  check("an unknown one is the index", parseSettingsSection("nonsense"), null);
  /*
   * The Agents section was deleted when agent settings moved inside a machine,
   * so its own URL is now exactly such a bookmark. Pinned because "it falls to
   * the index" is a decision — the alternative was redirecting to Machines,
   * which would have to guess *which* machine.
   */
  check("the deleted Agents section is one of them", parseSettingsSection("agents"), null);
  check("and the case a URL arrives in does not decide", parseSettingsSection("Account"), null);
  check("the index path", settingsPath(), "/settings");
  check("a section path", settingsPath("account"), "/settings/account");
  check(
    "every section round-trips through its own path",
    SECTION_SPECS.map((spec) => parseSettingsSection(settingsPath(spec.id).split("/")[2])),
    SECTION_SPECS.map((spec) => spec.id),
  );

  /* ---------------------------------------------------------------- *
   * The depths under `machines`
   *
   * Agent settings live inside a machine, and plugins do too — for the same
   * argument, stated on `MachineAgentsSection`: what is configured belongs to
   * one daemon's database and one host's disk, so a fleet-wide screen would
   * open with a machine dropdown, which is a screen asking a question its own
   * copy answers. Everything about those segments is here rather than in
   * `router.ts` precisely so it can be asserted — that file cannot be imported
   * at all, for the reason this section's own header gives.
   *
   * `agent` and `plugin` are **never both set**, and that is asserted below
   * rather than expressed in the type: a discriminated union would make every
   * consumer narrow before it could read the section, for a rule with exactly
   * one producer.
   * ---------------------------------------------------------------- */

  const seg = (path: string): string[] => path.split("/").filter((part) => part.length > 0).slice(1);

  // The machine's own screen, which this function could not express at all until
  // `/agents` moved out of the base and onto the agent. Q3.432.
  check("a machine path", settingsPath("machines", "m_1" as never), "/settings/machines/m_1");
  check(
    "an agent path",
    settingsPath("machines", "m_1" as never, "codex"),
    "/settings/machines/m_1/agents/codex",
  );
  check(
    "a machine path round-trips",
    parseSettingsRoute(seg(settingsPath("machines", "m_1" as never))),
    { section: "machines", machineId: "m_1", agent: null, plugin: null },
  );
  check(
    "an agent path round-trips",
    parseSettingsRoute(seg(settingsPath("machines", "m_1" as never, "kimi"))),
    { section: "machines", machineId: "m_1", agent: "kimi", plugin: null },
  );
  // Three refusals, each falling *up* to the nearest real screen rather than to
  // a 404 — `parseSettingsSection`'s posture, one level down.
  check(
    "an unknown agent falls back to the chooser",
    parseSettingsRoute(["machines", "m_1", "agents", "gemini"]).agent,
    null,
  );
  check(
    "and the machine survives that",
    parseSettingsRoute(["machines", "m_1", "agents", "gemini"]).machineId,
    "m_1",
  );
  check(
    "a segment that is not `agents` drops to the machine",
    parseSettingsRoute(["machines", "m_1", "sessions", "kimi"]),
    { section: "machines", machineId: "m_1", agent: null, plugin: null },
  );
  check(
    "a machine id under another section is ignored",
    parseSettingsRoute(["account", "m_1", "agents", "kimi"]),
    { section: "account", machineId: null, agent: null, plugin: null },
  );
  /*
   * The decoder is threaded in rather than applied inside, so the one place that
   * knows a segment may not decode stays the one place. Asserted with a decoder
   * that throws exactly as `decodeURIComponent` does, since that is the whole
   * reason `router.ts` wraps it.
   */
  check(
    "the caller's decoder is what runs",
    parseSettingsRoute(["machines", "m%201", "agents"], decodeURIComponent).machineId,
    "m 1",
  );

  check("one plugin's path", pluginSettingsPath("m_1" as never, "board"), "/settings/machines/m_1/plugins/board");
  check(
    "one plugin's path round-trips",
    parseSettingsRoute(seg(pluginSettingsPath("m_1" as never, "board"))),
    { section: "machines", machineId: "m_1", agent: null, plugin: "board" },
  );
  /*
   * A bare `…/plugins` falls to the machine, which is the screen the list is
   * drawn on — the same answer `…/agents` gives, and the reason there is no
   * builder for either list: the machine's path is the list's path.
   */
  check(
    "a bare plugins segment is the machine",
    parseSettingsRoute(["machines", "m_1", "plugins"]),
    { section: "machines", machineId: "m_1", agent: null, plugin: null },
  );
  /*
   * A plugin id is **not** validated against a known set, unlike an agent id, and
   * this is the assertion that says so on purpose. An agent id is handed to
   * `PUT /agent-auth/:agent`, which refuses an unknown one — so an unvalidated id
   * would draw a screen whose every control 400s. The set of plugin ids is
   * whatever is installed on that daemon, which this client cannot know before it
   * has asked, so an unknown one reaches the screen and the screen says it is not
   * installed.
   */
  check(
    "an unknown plugin id survives the parse",
    parseSettingsRoute(["machines", "m_1", "plugins", "not-installed"]).plugin,
    "not-installed",
  );
  check(
    "a plugin id is decoded like every other segment",
    parseSettingsRoute(["machines", "m_1", "plugins", "a%20b"], decodeURIComponent).plugin,
    "a b",
  );
  /*
   * The rule the type deliberately does not express, asserted over every shape
   * this parser can produce rather than over the two that would break it today.
   */
  check(
    "agent and plugin are never both set",
    [
      ["machines", "m_1", "agents", "kimi"],
      ["machines", "m_1", "plugins", "board"],
      ["machines", "m_1", "plugins"],
      ["machines", "m_1"],
      ["machines", "m_1", "sessions", "x"],
      ["account", "m_1", "plugins", "board"],
    ]
      .map((segments) => parseSettingsRoute(segments))
      .filter((route) => route.agent !== null && route.plugin !== null),
    [],
  );
  /*
   * One plugin and one agent walk to the same place, because both lists are drawn
   * on it. Asserted as a *pair* rather than twice, so the day one of them grows a
   * list depth of its own the other is visibly the odd one out.
   */
  check(
    "a plugin and an agent both go up to their machine",
    [
      settingsUp({ section: "machines", machineId: "m_1" as never, agent: null, plugin: "board" }),
      settingsUp({ section: "machines", machineId: "m_1" as never, agent: "kimi", plugin: null }),
    ],
    [
      { path: "/settings/machines/m_1", withinNav: false },
      { path: "/settings/machines/m_1", withinNav: false },
    ],
  );

  const plain = { id: "u_1", name: "ada", isAdmin: false };
  const admin = { id: "u_2", name: "root", isAdmin: true };
  check("a plain user sees two sections", visibleSections(plain).map((s) => s.id), ["machines", "account"]);
  check("an admin sees four", visibleSections(admin).map((s) => s.id), ["machines", "account", "server", "users"]);
  /*
   * `me` really is null while `phase` is "ready": `bootstrap`'s catch keeps that
   * phase when the control plane is unreachable but machines are already known,
   * and never sets `me`. So this fails closed rather than optimistically.
   */
  check("and somebody we could not identify sees two", visibleSections(null).map((s) => s.id), ["machines", "account"]);
  check("a typed URL is not a tap", [sectionAllowed("users", null), sectionAllowed("users", plain), sectionAllowed("users", admin)], [false, false, true]);
  check("nothing else fails closed on a missing `me`", sectionAllowed("account", null), true);
  /*
   * The rule rather than the current four rows, so that a *fifth* section marked
   * `adminOnly` is covered the day it is added: nothing an unidentified or
   * non-admin caller is offered may carry the flag. This is what stops the app
   * offering a screen whose every request answers 403 — a different job from the
   * guard, which is `requireAdmin` on the control plane and stays there.
   */
  check(
    "no admin-only section is ever offered to a non-admin",
    [visibleSections(null), visibleSections(plain)].map((list) => list.filter((spec) => spec.adminOnly).length),
    [0, 0],
  );
  check(
    "and every section an admin sees is reachable by URL",
    visibleSections(admin).map((spec) => sectionAllowed(spec.id, admin)),
    // Counted from the list rather than written out, so adding a section cannot
    // make this pass by having been updated to the wrong length.
    visibleSections(admin).map(() => true),
  );
  /*
   * `sectionAllowed` is `visibleSections` asked a second way and must not drift
   * into a second rule: every section, both callers, all three identities.
   */
  check(
    "the list and the URL guard agree on every section",
    SECTION_SPECS.every((spec) =>
      [null, plain, admin].every(
        (me) => sectionAllowed(spec.id, me) === visibleSections(me).some((s) => s.id === spec.id),
      ),
    ),
    true,
  );

  /*
   * One level up, and whether the control for it is redundant.
   *
   * This was an expression inside `Settings.tsx` and is a function here for the
   * reason this whole file exists: it decides where a control on screen takes
   * you, and a component is a place `webcheck` cannot reach.
   */
  const up = (segments: readonly (string | undefined)[]) => settingsUp(parseSettingsRoute(segments));
  check("the index has nowhere to go", up([]), null);
  check("a section goes to the index", up(["account"]), { path: "/settings", withinNav: true });
  check("and so does Machines", up(["machines"]), { path: "/settings", withinNav: true });
  /*
   * `withinNav` is the half that stops a redundant control: at `sm` and above the
   * section list is drawn beside the section, so at `/settings/account` the parent
   * is already a row on screen and a chevron pointing at it says nothing new. The
   * agent depths are the opposite — the nav has no row for either, so the chevron
   * is the only way back at every width.
   */
  check("a machine's agents go up to Machines, at every width", up(["machines", "m_1", "agents"]), {
    path: "/settings/machines",
    withinNav: false,
  });
  // Up from an agent is the machine's own screen — which is where its agents are
  // listed, so the chooser did not go anywhere, it stopped being a screen of its own.
  check("and one agent goes up to its machine", up(["machines", "m_1", "agents", "claude"]), {
    path: "/settings/machines/m_1",
    withinNav: false,
  });
  /*
   * The composition invariant, which is the one that would actually bite: a back
   * chevron may never point at a URL that falls through to home. Asserted over
   * every reachable shape rather than the four above, so a fifth depth cannot
   * arrive without answering it.
   */
  const reachable: readonly (readonly (string | undefined)[])[] = [
    ["account"],
    ["users"],
    ["machines"],
    ["machines", "m_1"],
    ["machines", "m_1", "agents"],
    ["machines", "m_1", "agents", "claude"],
  ];
  check(
    "every parent a chevron names is itself a real settings screen",
    reachable.every((segments) => {
      const parent = settingsUp(parseSettingsRoute(segments));
      if (parent === null) return false;
      const parts = parent.path.split("/").filter((part) => part.length > 0);
      return parts[0] === "settings" && parseSettingsRoute(parts.slice(1)).section !== undefined;
    }),
    true,
  );

  /* ---------------------------------------------------------------- *
   * Which element names a settings screen
   *
   * ⭐ A sheet's head is a child of its panel, so at `sm` and above it spans the
   * 224px section rail *as well as* the pane. Measured at 1280px: the head's text
   * box starts 40px in, so `mac · agents` was drawn across a rail whose rows read
   * Machines / Account / Server settings / Users — a title describing one pane and
   * covering two. The name moved into the pane; the head names the pop-up. Q3.427.
   * ---------------------------------------------------------------- */
  const pane = (segments: readonly (string | undefined)[]): string | null =>
    settingsPaneTitle(parseSettingsRoute(segments));
  check("the index has no pane heading", pane([]), null);
  check(
    "a section names itself in the pane",
    [pane(["machines"]), pane(["account"]), pane(["server"]), pane(["users"])],
    ["Machines", "Account", "Server settings", "Users"],
  );
  /*
   * **Every machine depth is titled by what the screen is**, never by which
   * machine it is about and never by the agent. The head used to draw
   * `route.agent` raw — a lower-case URL segment in `text-lg font-semibold` above
   * a row reading "Claude (claude-agent-acp)" — and then drew the machine's name,
   * which put the same word in the heading, the rename field under it and the
   * Retire button. The name lives where it is editable and where it is destroyed.
   * Q3.433.
   */
  check(
    "every machine depth is titled by what the screen is",
    [
      pane(["machines", "m_1"]),
      pane(["machines", "m_1", "agents"]),
      pane(["machines", "m_1", "agents", "claude"]),
    ],
    ["Machine settings", "Machine settings", "Machine settings"],
  );
  /*
   * ⭐ And it is a **constant**: nothing in the pop-up's chrome is a function of
   * which machine you opened, which is why `settingsPaneTitle` no longer takes a
   * name at all. A signature that still accepted one would leave the door open to
   * a heading that disagrees with the body it sits over.
   */
  check("and takes no machine name to say it", settingsPaneTitle.length, 1);
  /*
   * A machine revoked in another tab is gone from `state.machines` while its URL
   * is still on screen — and the heading is unaffected now, which is the point of
   * it being a constant: the screen keeps its name while its subject disappears,
   * and `MachineSection` draws the tombstone underneath.
   */
  /*
   * **The pairing, over every reachable shape plus the index** rather than over
   * the six literals above: a heading and a way up arrive together, so a seventh
   * depth cannot land with a chevron over an unnamed screen, or with a name and no
   * way back.
   */
  const everyShape: readonly (readonly (string | undefined)[])[] = [...reachable, []];
  check(
    "a heading and a way up arrive together",
    everyShape.map((segments) => settingsPaneTitle(parseSettingsRoute(segments)) === null),
    everyShape.map((segments) => settingsUp(parseSettingsRoute(segments)) === null),
  );
  /*
   * The breakpoint half is a class string and nothing pure can see it, so it is
   * read off disk — the idiom this file already uses for `Settings.tsx` one block
   * down. Two facts: the head carries the pop-up's name, and the pane's heading is
   * withdrawn exactly where the rail draws the row.
   */
  const settingsTsxSrc = stripComments(
    readFileSync(new URL("../src/ui/settings/Settings.tsx", import.meta.url), "utf8"),
  );
  check("the head is the pop-up's name, not the screen's", /<Sheet title="Settings"/.test(settingsTsxSrc), true);
  check(
    "and the pane's heading is withdrawn where the rail draws the row",
    /withinNav\s*\?\s*"sm:hidden"\s*:\s*""/.test(settingsTsxSrc),
    true,
  );

  /*
   * ⭐ **`Sheet.tsx` was read by no driver at all**, which is how a tag change on a
   * two-caller primitive — and the property this whole answer rests on — stayed
   * unfalsifiable. `aria-labelledby` is `labelledBy ?? headingId`, so exactly one
   * element may carry that id, and it may never be one CSS can hide: a name
   * computed from a `display:none` subtree is no name at all, so a dialog whose
   * labelling heading is `sm:hidden` has no accessible name at that width.
   */
  const sheetSrc = stripComments(readFileSync(new URL("../src/ui/Sheet.tsx", import.meta.url), "utf8"));
  check("a sheet's title is the panel's name, one rank above the pane's", /<h1 id=\{headingId\}/.test(sheetSrc), true);
  check("and exactly one element is what the dialog is named by", (sheetSrc.match(/id=\{headingId\}/g) ?? []).length, 1);
  check("and nothing hides it at a width", /id=\{headingId\}[^>]*(sm:)?hidden/.test(sheetSrc), false);

  /* ---------------------------------------------------------------- *
   * The way back sits on the screen it leaves
   *
   * ⭐ **Nothing asserted that the chevron existed at all** — neither the reserved
   * slot nor the `up` prop had a check, which is exactly why deleting both fails
   * no existing assertion. Without this pair a half-finished move leaves two
   * chevrons or none, with every other assertion green. Q3.432.
   * ---------------------------------------------------------------- */
  check("the pane draws the way back", /ChevronLeft/.test(settingsTsxSrc), true);
  check("and the head no longer does", /ChevronLeft/.test(sheetSrc), false);
  check("nor reserves room for one", /inline-flex w-3 shrink-0/.test(sheetSrc), false);
  /*
   * The label names the destination rather than saying "Back" — `Header`'s rule,
   * and the whole difference between this control and the history button it must
   * never become. Derived from the parent's own name, so a label naming a screen
   * the path does not resolve to is not expressible.
   */
  check(
    "the chevron says where it goes",
    [
      settingsUpLabel(parseSettingsRoute(["account"])),
      settingsUpLabel(parseSettingsRoute(["machines", "m_1"])),
      settingsUpLabel(parseSettingsRoute(["machines", "m_1", "agents", "claude"])),
    ],
    ["Settings", "Machines", "Machine settings"],
  );
  check("and says nothing at the index", settingsUpLabel(parseSettingsRoute([])), null);
  /*
   * The pairing that keeps a screen from losing its only way back: the row is
   * gated on `up` ALONE, with the title narrowing only the heading inside it.
   */
  check(
    "the row is gated on the way up, not on the name",
    /\{up !== null && \(/.test(settingsTsxSrc),
    true,
  );
}

/** Source with comments removed, so a rule quoted in prose cannot satisfy a regex. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/* ------------------------------------------------------------------ *
 * Who owns Escape, and what paints above what
 *
 * `overlay.ts` is importable here — and has to stay that way — because its
 * `window.addEventListener` lives inside `push()` rather than in the module body.
 * That is the same constraint `settings.ts` states about itself: a decision this
 * file cannot reach is a decision nothing asserts, and the first maintenance edit
 * that hoists that listener would silently un-assert everything below.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwho owns Escape, and what paints above what\n");
{
  const { LAYER, decisionShortcutsEnabled, escapeAction, isOverlayPath, layerRank, shortcutsEnabled } = await import(
    "../src/ui/overlay.js"
  );
  const { SECTION_SPECS, settingsPath } = await import("../src/settings.js");

  const ask = { id: 1, kind: "ask" } as const;
  const menu = { id: 2, kind: "menu" } as const;
  const sheet = { id: 3, kind: "sheet" } as const;

  check("nothing open, nothing claimed", escapeAction([], false), { dismiss: null, stop: false });
  /*
   * Typing beats every layer, and this one rule is what four components used to
   * each defend with their own comment: Escape in the composer belongs to the
   * command menu, in `AskCard`'s "Other" box to the box, in `RenameField` to the
   * rename, in `DirectoryPicker`'s new-folder field to that form.
   */
  check("typing beats an open card", escapeAction([ask], true), { dismiss: null, stop: false });
  check("and beats an open sheet", escapeAction([sheet, menu], true), { dismiss: null, stop: false });

  check("one layer owns it", escapeAction([ask], false).dismiss, ask.id);
  check("a menu over a card takes it first", escapeAction([ask, menu], false).dismiss, menu.id);
  check("a menu inside a sheet, likewise", escapeAction([sheet, menu], false).dismiss, menu.id);
  /*
   * The case the old arrangement got wrong: a sheet opens over a session that has
   * an expanded question parked on it. Escape must close the sheet and leave the
   * card alone — before this, it folded a card nobody could see.
   */
  check("a sheet over a card takes it", escapeAction([ask, sheet], false).dismiss, sheet.id);

  /*
   * The contract, over every stack rather than the six above, because the failure
   * being replaced was exactly a component that stopped propagation *before*
   * deciding whether it would act — which ended the dispatch for everybody and
   * cancelled an agent's tool call while leaving the menu wide open.
   */
  const stacks = [[], [ask], [menu], [sheet], [ask, menu], [sheet, menu], [ask, sheet], [ask, menu, sheet]];
  check(
    "it stops the keystroke exactly when it acts on it",
    stacks.every((stack) =>
      [true, false].every((typing) => {
        const action = escapeAction(stack, typing);
        return action.stop === (action.dismiss !== null);
      }),
    ),
    true,
  );

  /*
   * `inert` does not block a `window` keydown, so without this guard `j`/`k`
   * navigate the list *behind* an open sheet — changing what is underneath while
   * it cannot be seen.
   *
   * Only a sheet blocks. A menu deliberately does not, which is a documented
   * non-change: a bare `j` with a `Dropdown` open navigates today and this layer
   * is not the place to decide otherwise.
   */
  check(
    "bare letters survive a menu and a card, and not a sheet",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [sheet, menu]].map(shortcutsEnabled),
    [true, true, true, true, false, false, false],
  );

  /*
   * **Deciding is not navigating, which is why there are two predicates.**
   *
   * `j` under an open `Dropdown` moves a caret and the worst case is looking at
   * the wrong row — a documented non-change. `2` under an open `Dropdown`
   * *approves a command*. `AskCard` gated its numbered answers on the rule above,
   * so with a session menu or the config bar's `…` popover open over a parked
   * question, a keystroke aimed at the menu resolved the permission underneath
   * it.
   *
   * `[ask]` answering `true` is the case that matters and the one an obvious
   * implementation gets backwards: the card registers itself with
   * `useDismissible("ask", …)` whenever it is open, so `layers.length === 0` —
   * which reads as the stricter, safer rule — is exactly the state in which there
   * is no card to answer, and would have disabled the shortcuts permanently while
   * passing every reading of the code.
   */
  check(
    "a numbered answer survives only the card's own layer",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [ask, menu, sheet]].map(decisionShortcutsEnabled),
    [true, true, false, false, false, false, false],
  );

  /*
   * **And every listener that could act on one actually asks.**
   *
   * The case above is the rule; this is obedience to it, and the two were apart
   * long enough for the gap to be a live defect. `shortcutsEnabled([ask, sheet])`
   * has always answered `false` — the exact stack this names — while `AskCard`
   * registered its own capture-phase `window` keydown for the digit shortcuts and
   * never asked. `keyboard.ts` asked, so the harmless listener was covered and the
   * one that *resolves a permission* was not: with a session parked on an approval
   * behind an open settings sheet, a bare `1` reached `option.onPick()`. `inert` on
   * `#root` does not stop a `window` keydown — the predicate's own docblock says
   * so — and `Sheet` focuses a `tabIndex={-1}` div, which `isTypingInto` answers
   * false for, so nothing else in the chain refused it either.
   *
   * Source text rather than a call, in the style of the `SessionBrowser.tsx` and
   * `Composer.tsx` pins above: there is no DOM here to dispatch a key into, and
   * what has to hold is a property of *every* such listener rather than of the two
   * that exist today. `overlay.ts` is the one exemption, because it is the arbiter
   * being consulted rather than a caller of it.
   */
  const uiRoot = new URL("../src/", import.meta.url);
  const keyListeners: string[] = [];
  const sweep = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) sweep(child);
      else if (/\.tsx?$/.test(entry.name) && entry.name !== "overlay.ts") {
        const text = readFileSync(child, "utf8");
        if (text.includes('window.addEventListener("keydown"')) {
          /*
           * **Either predicate counts, and there are two on purpose.**
           * `shortcutsEnabled` is about *navigating* and blocks only a sheet;
           * `decisionShortcutsEnabled` is about *deciding* and blocks a menu as
           * well. What this sweep is for is that a `window` keydown asks the
           * arbiter at all — which one it asks is the caller's judgement, and
           * `AskCard` is the reason the second exists.
           */
          const guarded =
            text.includes("shortcutsEnabled(currentLayers())") ||
            text.includes("decisionShortcutsEnabled(currentLayers())");
          keyListeners.push(`${entry.name}${guarded ? "" : " (UNGUARDED)"}`);
        }
      }
    }
  };
  sweep(uiRoot);
  check(
    "every window keydown listener outside the arbiter consults it",
    keyListeners.filter((name) => name.includes("UNGUARDED")),
    [],
  );
  check("and there are listeners to have checked", keyListeners.length > 0, true);

  /*
   * The ordering, in the one place that holds it. This is why `LAYER` is full
   * class strings rather than numbers in five files — Tailwind cannot see a
   * computed `z-${n}`, and an order spread across the things it orders is one
   * nothing can assert.
   */
  const names = ["header", "menu", "overlay", "toast"] as const;
  const ranks = names.map(layerRank);
  check("the layers are named in ascending order", ranks, [30, 40, 50, 60]);
  check(
    "and each is strictly above the last",
    ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? 0)),
    true,
  );
  check("a toast outranks the sheet it reports a failure from", layerRank("toast") > layerRank("overlay"), true);
  check("every layer is a class Tailwind can see", names.map((name) => /^z-\d+$/.test(LAYER[name])), [
    true,
    true,
    true,
    true,
  ]);

  /*
   * **The sheet's box, as two class strings, because both defects it had were
   * invisible to every driver here.**
   *
   * A pop-up that scrolls and a pop-up that holds still are the two things every
   * sheet in this app must do, and neither is expressible in a type. They were
   * both broken at once and nothing failed: `typecheck` sees strings, `web:build`
   * emits whatever Tailwind recognises, and there is no DOM in this process to
   * measure a panel in. So they are pinned the same way the retired colour tokens
   * are — by reading the source of truth, which for these is the constant itself.
   *
   * `SHEET_BODY` must be a **flex column**. Both callers write `min-h-0 flex-1`
   * on their top child, and in a block container those two properties do nothing:
   * every inner scroller sized to its own content, got no scroll range, and then
   * its `overscroll-contain` stopped the wheel from chaining to the one box that
   * could move. The measured symptom was that no pop-up in the app scrolled at
   * all. `min-h-0` on the body itself is the other half — without it the body
   * refuses to shrink below its content and the panel's own height stops bounding
   * anything.
   *
   * `SHEET_PANEL` must carry a **definite** height and no `max-h-`. With a
   * ceiling alone the panel was content-sized: measured at 155px, 475px and 492px
   * for two, twelve and eighty lines of body, so walking the settings list
   * resized the dialog under a pointer already aimed at the next row.
   */
  const { SHEET_BODY, SHEET_PANEL } = await import("../src/ui/bits.js");
  const bodyClasses = SHEET_BODY.split(/\s+/);
  check(
    "a sheet's body is a flex column, so its children's flex-1 means something",
    ["flex", "flex-col", "min-h-0", "flex-1"].map((name) => bodyClasses.includes(name)),
    [true, true, true, true],
  );
  check("and it is the fallback scroller", bodyClasses.includes("overflow-y-auto"), true);
  /*
   * **And it paints its own ground, because it is the thing that slides.**
   *
   * This box carries the `view-transition-name` a section change moves, and being
   * named lifts it out of the panel's snapshot — so with the fill left to the
   * panel, both of its snapshots were transparent images of nothing but glyphs.
   * Measured mid-slide at 390px: the leaving list's rows and the arriving
   * section's fields were both fully legible, one drawn over the other. The
   * animation was correct throughout; a pane that arrives has to *cover* the one
   * it replaces, and that is a property of the element rather than of a keyframe.
   * Same colour as the panel behind it, so nothing at rest changes.
   */
  check("and it paints its own ground, so a slide covers what it replaces", bodyClasses.includes("bg-surface"), true);
  check("a sheet's height is definite at both widths", /(^|\s)h-\[/.test(SHEET_PANEL) && /\ssm:h-\[/.test(SHEET_PANEL), true);
  check("and never a ceiling it can shrink under", /(^|\s)(sm:)?max-h-/.test(SHEET_PANEL), false);

  check(
    "the overlay paths",
    ["/settings", "/settings/account", "/settings/machines/m_1/agents/claude", "/new", "/new/m_1"].map(
      isOverlayPath,
    ),
    [true, true, true, true, true],
  );
  check(
    "and the screens that are not overlays",
    ["/", "/m/m_1/s/s_1"].map(isOverlayPath),
    [false, false],
  );
  // Whole segments, not a prefix: a future `/settingsomething` is not settings.
  check("a longer first segment is not one of them", isOverlayPath("/settingsomething"), false);

  /*
   * The cross-file pin. Adding a settings section must not be able to create a
   * route the shell does not know to draw as an overlay — which would render it as
   * a bare screen with no ✕ and nothing behind it.
   *
   * `newPath` cannot be reached the same way (it lives in `router.ts`, which this
   * file cannot import), so the `/new` forms above are literals. Said out loud
   * rather than left looking symmetric.
   */
  check(
    "every settings section is an overlay path",
    SECTION_SPECS.every((spec) => isOverlayPath(settingsPath(spec.id))),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * Nothing names a colour that no longer exists
 *
 * **Tailwind v4 does not error on an unknown token.** `bg-warn` with no
 * `--color-warn` in `@theme` emits no rule whatsoever — no background, no build
 * warning, no type error — which was measured on the commit that introduced this
 * palette by building a deliberate `bg-nonexistent` and watching it pass.
 *
 * So the seven names retired when the palette went monochrome cannot be caught by
 * `typecheck` or by `web:build`; a missed call site just loses its fill and looks
 * like a rendering bug months later. This is the gate, in the same source-text
 * style as the two assertions that read `SessionBrowser.tsx` and `Composer.tsx`.
 * ------------------------------------------------------------------ */

process.stdout.write("\nnothing names a colour that no longer exists\n");
{
  /*
   * `add` and `del` were on this list and have come off it.
   *
   * They were retired with the other four when the palette went monochrome, and
   * they are back with real values because a diff is the one thing here that is
   * *content* rather than a control: `danger`'s "never a fill, never more than one
   * in a view" is a rule about identifying a control, and a changed line is neither.
   * What keeps that from being a licence is measured at the tokens themselves — the
   * fill is tinted and the text is not — and enforced below, where their presence is
   * now asserted exactly as the others' absence is.
   */
  const RETIRED = ["accent", "accent-ink", "warn", "ok"];
  const LIVE = ["add", "add-ink", "del", "del-ink"];
  const root = new URL("../src/", import.meta.url);
  const files: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(child);
      else if (/\.(tsx?|css)$/.test(entry.name)) files.push(child.pathname);
    }
  };
  walk(root);

  /*
   * The property side, not the whole word: `bg-added` and `text-okay` are not
   * these tokens, and `--color-danger` survives and must not be caught.
   */
  const pattern = new RegExp(
    `\\b(?:text|bg|border|ring|from|to|fill|stroke|decoration|outline|shadow|divide|accent)-(?:${RETIRED.join("|")})\\b`,
  );
  /*
   * Comments are stripped, and that is the opposite decision from the
   * `groups.orphans` assertion two sections up — deliberately, because the two
   * are asking different questions.
   *
   * That one bans a *name* outright: reaching past the helper is wrong however it
   * is spelled, and a comment naming the field is a reader one step from writing
   * it. This one is about a class the browser will try to apply, and this
   * codebase keeps its history in its docblocks — `bits.tsx` explains why
   * `focus:border-accent` was deleted, `Markdown.tsx` says what a link used to
   * be, and `index.css` names `bg-warn` in the very paragraph explaining the
   * hazard this check exists for. Failing on those would mean deleting the record
   * of why the check is here.
   */
  const stripped = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const offenders = files
    .filter((file) => pattern.test(stripped(readFileSync(file, "utf8"))))
    .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length));

  report(
    "no utility class names a retired colour",
    offenders.length === 0,
    offenders.length === 0 ? `${files.length} files` : offenders.join(", "),
  );
  // And the tokens really are gone, so the gate above is asserting something.
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check(
    "and the tokens themselves are gone from @theme",
    RETIRED.filter((name) => new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  /*
   * The same property from the other side, and it is the half this gate was missing.
   *
   * The hazard is a utility whose token does not exist — the background silently
   * never paints — so banning dead names only covers the case where the *name*
   * arrives last. Deleting `--color-add` while `bg-add` stayed in `DiffView` is the
   * same failure with the two halves swapped, and nothing would have caught it:
   * `typecheck` sees a string, `web:build` emits no rule, and a diff quietly loses
   * the only thing that says which lines were removed.
   */
  check(
    "and the live ones are really declared",
    LIVE.filter((name) => !new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  // The one non-neutral value that stayed, and the reason it is the only one.
  check("the one exception survives", /--color-danger:\s*#7e362b/.test(css), true);

  /*
   * **A pointer over anything pressable, and the rule is layered.**
   *
   * Tailwind v3's preflight set it and v4 dropped it, so every button in this
   * app drew the ordinary arrow — invisible on a phone, and on a desktop the
   * only cue an unfilled button has left, since with the accent gone a control
   * is drawn in the colour of what it sits on.
   *
   * Both halves are asserted because each fails silently on its own: without
   * `:disabled` the arrow stops distinguishing a control that will not act, and
   * **unlayered it would beat every utility regardless of specificity** — the
   * trap the focus-ring docblock in this same file was written for — making
   * `cursor-default` a dead class wherever somebody needs one.
   */
  const cursorRule = /@layer base \{[\s\S]*?cursor: pointer;[\s\S]*?\}/.exec(css)?.[0] ?? "";
  check("a pressable thing shows a pointer", cursorRule.length > 0, true);
  check("and a disabled one does not", /button:not\(:disabled\)/.test(cursorRule), true);

  /*
   * ⭐ **One way to copy, because the browser API is missing on the deployment
   * this is read from.**
   *
   * `navigator.clipboard` is defined **only in a secure context**, and the control
   * plane is routinely served over plain http on a LAN address — measured on the
   * running stack: `isSecureContext` false, `navigator.clipboard` undefined,
   * `document.execCommand("copy")` true. So a direct call is not a call that
   * sometimes fails; it is a control that never works there, and the three that
   * existed each carried their own `catch` explaining the silence away.
   *
   * The remedy is one module with a fallback, and the thing that keeps it one is
   * this: the API may be named in `ui/clipboard.ts` and nowhere else under
   * `packages/web/src`. Comments are stripped for the reason the palette gate one
   * paragraph up gives — the docblocks here explain what was wrong, and failing on
   * the record of it would delete the record.
   *
   * The reverse half matters as much and is asserted with it: the fallback must
   * still be in that file. A `copyText` that quietly became a bare
   * `navigator.clipboard` call again passes the first check and fails this one.
   */
  const clipboardFile = "src/ui/clipboard.ts";
  const usesClipboardApi = files
    .filter((file) => /navigator\.clipboard/.test(stripped(readFileSync(file, "utf8"))))
    .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length));
  check("the clipboard API is named in one file", usesClipboardApi, [clipboardFile]);
  const clipboardSrc = readFileSync(new URL("../src/ui/clipboard.ts", import.meta.url), "utf8");
  check(
    "and that file still carries the insecure-origin fallback",
    /execCommand\("copy"\)/.test(clipboardSrc),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * A URL that will not decode
 *
 * `parse` runs in `router.ts`'s **module body** — `let current =
 * parse(window.location.pathname)` — so a segment `decodeURIComponent` refuses
 * threw during module evaluation and took the whole ES module graph with it. The
 * control plane's SPA fallback served `index.html` correctly, the bundle loaded,
 * and `#root` stayed empty: a blank white page, no error, no console, on a phone,
 * that a reload cannot fix. One truncated link pasted out of a chat app, or a
 * stray `%` typed into the bar, is the whole input.
 *
 * **The import *is* the assertion**, which is why this section is shaped unlike
 * every other one here. There is nothing to hand a fixture to: `parse` is module
 * -private and `useRoute` is a hook, so the parsed *value* cannot be read from a
 * driver with no React — and it does not need to be, because the failure was
 * never a wrong route, it was no application at all. So `window.location.pathname`
 * is set to the malformed path **before** the dynamic import, and the module
 * either evaluates or it does not. Reverting `decodeSegment` to a bare
 * `decodeURIComponent` fails the first check here with the `URIError` itself.
 *
 * The second half is the same claim on the path a tap takes rather than a load:
 * `navigate` re-parses synchronously through `announce`, so a link carrying a
 * malformed id throws out of the click handler with the app already mounted.
 * ------------------------------------------------------------------ */

process.stdout.write("\na URL that will not decode\n");
{
  /*
   * Three more members on the stub, added here rather than at the top: this is
   * the only module that reads any of them, and `pathname` in particular has to
   * carry a *specific* value at import time, which is a property of this section
   * rather than of the fixture every other one shares.
   *
   * `pushState` writes the path back onto the stub, because that is the part of
   * the browser `navigate` relies on: it pushes and then re-parses whatever
   * `window.location.pathname` now says.
   */
  const stub = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;
  const loc = stub["location"] as Record<string, unknown>;
  const go = (path: string): void => void (loc["pathname"] = path);
  stub["addEventListener"] = (): void => {};
  stub["history"] = {
    pushState: (_state: unknown, _title: string, path: string): void => go(path),
    replaceState: (_state: unknown, _title: string, path: string): void => go(path),
  };

  // A lone trailing `%` — `decodeURIComponent("s_1%")` is "URI malformed" — in the
  // session half of a real session URL, which is the shape a truncated paste has.
  go("/m/m_1/s/s_1%");

  let router: typeof import("../src/router.js") | null = null;
  let loadError: string | null = null;
  try {
    router = await import("../src/router.js");
  } catch (cause) {
    loadError = String(cause);
  }
  // Reported rather than checked so the rest of the section is reachable when it
  // fails — a throw here would take the enrollment section below with it, which is
  // the crash-truncation failure this file avoids elsewhere by the same means.
  report(
    "the app still evaluates under a path that will not decode",
    loadError === null,
    loadError ?? "imported with window.location.pathname = /m/m_1/s/s_1%",
  );

  if (router !== null) {
    const { navigate, newPath, parsePath, sessionPath } = router;
    const threw = (path: string): string | null => {
      try {
        navigate(path);
        return null;
      } catch (cause) {
        return String(cause);
      }
    };

    check("and a tap on one does not throw out of the handler", threw("/m/m_1/s/s_1%"), null);
    // The machine half, the `/new` route and a bare segment, because each is a
    // separate `decodeSegment` call site and one left bare is one blank page.
    check("nor does a machine id that will not decode", threw("/m/m_1%/s/s_1"), null);
    check("nor does /new with one", threw("/new/m_1%"), null);
    /*
     * The shape a truncated paste really has, as opposed to a lone `%`: an escape
     * that begins and does not finish. `decodeURIComponent("%E0%A4%A")` throws for
     * the same reason and looks nothing like a typo, which is why it is here — a
     * fixture chosen only from the "obvious" `%` would let a half-fixed decode
     * through. (A lone `%` in a segment nothing decodes — `/%`, which is home —
     * never reached the failure at all, so it is not a fixture.)
     */
    check("nor does an escape that begins and does not finish", threw("/m/%E0%A4%A/s/x"), null);

    /*
     * And nothing a link in this app produces goes near any of that: both path
     * builders encode, so the decode is always the inverse of an encode. Asserted
     * with a `%` in the id itself — the value that would round-trip *wrongly* if
     * either side were dropped, rather than merely throw.
     */
    check("what this app builds is encoded", sessionPath({ machineId: "m_1%", sessionId: "s_1%" } as never), "/m/m_1%25/s/s_1%25");
    check("and so is a new-session link", newPath("m_1%" as never), "/new/m_1%25");
  /*
   * The folder rides the path as **one** segment, so a POSIX path cannot split
   * into several however deep it is — which is the whole reason it is not a query
   * string: `parse` reads `pathname` and nothing else.
   */
  check(
    "a folder rides the new-session link as one segment",
    newPath("m_1" as never, "/home/u/api"),
    "/new/m_1/%2Fhome%2Fu%2Fapi",
  );
  check("and comes back whole", (parsePath("/new/m_1/%2Fhome%2Fu%2Fapi") as { cwd: string | null }).cwd, "/home/u/api");
  check("with no folder it is null rather than empty", (parsePath("/new/m_1") as { cwd: string | null }).cwd, null);
  check("and a folder needs a machine to belong to", newPath(undefined, "/home/u/api"), "/new");
    check("which parses without incident", threw(sessionPath({ machineId: "m_1%", sessionId: "s_1%" } as never)), null);
  }
}

/* ------------------------------------------------------------------ *
 * The three lines a daemon is started with
 *
 * Pinned as a literal, because this is text somebody pastes into a shell on
 * another machine and the code inside it is single-use: a wrong variable name
 * fails at daemon startup talking about enrollment rather than about a typo here,
 * and the code is spent either way.
 *
 * **Both values are single-quoted, and that is a hazard rather than a tidy-up.**
 * `controlPlaneUrl` is `publicUrl(c)` on the control plane —
 * `new URL(c.req.url).origin` — so it comes from the request's own `Host` header,
 * which anybody who can reach the service writes. Measured 2026-08-08 through a
 * real `node:http` server: a `Host` of ``a`id`b``, `a$(id)b`, `a'b` and `a;id`
 * all reach `URL.origin` intact, and sourcing the unquoted line then *executes*
 * it — measured, ``export REEMOAT_CONTROL_PLANE=http://a`touch PWNED`b`` created
 * the file and left the variable reading `http://ab`, so the person pasting sees
 * a plausible URL and nothing else. `deploy/lib.sh`'s `sq` has applied this rule
 * to the env file since the `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` incident; the
 * paste is the same text arriving by hand into the same shell.
 *
 * `packages/control-plane/scripts/cpctl.ts` prints the same three lines from its
 * own copy. Two ways to start a machine that print different things is how one of
 * them quietly stops working — and both docblocks used to claim they were kept
 * byte-identical while **nothing anywhere compared them**. That is what the second
 * half of this section is: cpctl's own body, run.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe three lines a daemon is started with\n");
{
  const { enrollmentLines, enrollmentExpiryText } = await import("../src/enrollment.js");

  check(
    "exactly what cpctl prints",
    enrollmentLines("https://cp.example", "ec_abc"),
    "export REEMOAT_AUTH=signed\nexport REEMOAT_CONTROL_PLANE='https://cp.example'\nexport REEMOAT_ENROLL_CODE='ec_abc'",
  );
  // `REEMOAT_AUTH=signed` is ours and constant, so it is the one line with
  // nothing to quote. Quoting it too would be harmless and is not done, which is
  // worth pinning so nobody "fixes" the asymmetry into a rule about all three.
  check("the constant line carries no quotes", enrollmentLines("https://cp", "ec").split("\n")[0], "export REEMOAT_AUTH=signed");

  /*
   * The four `Host` shapes measured through `URL.origin`, each of which is shell
   * *source* when unquoted. Nothing here asserts the shell's behaviour — that was
   * measured outside this driver — only that every one of them comes out as data.
   */
  const urlLine = (url: string): string | undefined => enrollmentLines(url, "ec_x").split("\n")[1];
  check("a backtick is data", urlLine("http://a`id`b"), "export REEMOAT_CONTROL_PLANE='http://a`id`b'");
  check("so is a command substitution", urlLine("http://a$(id)b"), "export REEMOAT_CONTROL_PLANE='http://a$(id)b'");
  check("so is a semicolon", urlLine("http://a;id"), "export REEMOAT_CONTROL_PLANE='http://a;id'");
  check("and so is an ampersand", urlLine("http://a&id"), "export REEMOAT_CONTROL_PLANE='http://a&id'");
  /*
   * The arm that could be mistaken for defensive, and is not: an apostrophe
   * survives `URL.origin` as measured, so without `'\''` the quoting could be
   * closed and stepped straight out of — which is the whole attack rather than a
   * corner of it.
   */
  check(
    "an apostrophe cannot close the quoting",
    urlLine("http://a'b"),
    "export REEMOAT_CONTROL_PLANE='http://a'\\''b'",
  );
  // The code is minted by the control plane and is not caller-influenced, so this
  // half is belt rather than braces — and it is applied anyway, because a rule
  // that holds for one of two adjacent values is a rule somebody deletes.
  check(
    "the code is quoted by the same rule",
    enrollmentLines("https://cp", "ec_a'b").split("\n")[2],
    "export REEMOAT_ENROLL_CODE='ec_a'\\''b'",
  );

  /**
   * `cpctl`'s own `enrollmentLines`, made callable.
   *
   * It cannot be imported: that file is a CLI whose module body reads
   * `process.argv` and dispatches, it lives in another package, and the function
   * is not exported. So its **source** is read and its **body** is run, which is
   * the only form of this check that compares behaviour rather than a
   * transcription of it.
   *
   * One transformation, and it is narrow on purpose: `: string` is the entire
   * TypeScript content of that body (a local arrow's parameter and return type).
   * If the function grows an annotation this does not know about, the result
   * fails to parse and this driver throws — loudly, which is the failure mode to
   * want, rather than silently comparing something else.
   *
   * `BASE_URL` is a free variable there (`controlPlaneUrl || BASE_URL`), so it is
   * passed in as a third parameter. That fallback is the only permitted
   * difference between the two copies and is asserted below rather than assumed.
   */
  const callable = (source: string): ((url: string, code: string, baseUrl: string) => string) => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith("function enrollmentLines("));
    if (start < 0) throw new Error("cpctl.ts no longer declares enrollmentLines at the top level");
    // A top-level declaration in that file ends at a bare `}` in column 0, which
    // is why this does not have to count braces through template literals.
    const end = lines.indexOf("}", start);
    if (end < 0) throw new Error("cpctl.ts's enrollmentLines has no closing brace in column 0");
    const body = lines.slice(start + 1, end).join("\n").replaceAll(": string", "");
    return new Function("controlPlaneUrl", "code", "BASE_URL", body) as (
      url: string,
      code: string,
      baseUrl: string,
    ) => string;
  };

  const cpctl = callable(
    readFileSync(new URL("../../control-plane/scripts/cpctl.ts", import.meta.url), "utf8"),
  );
  for (const [url, code] of [
    ["https://cp.example", "ec_abc"],
    ["http://a`id`b", "ec_x"],
    ["http://a$(id)b", "ec_x"],
    ["http://a'b", "ec_a'b"],
    ["http://a;id", "ec_$(id)"],
  ] as const) {
    check(`cpctl agrees on ${JSON.stringify(url)}`, cpctl(url, code, "https://unused"), enrollmentLines(url, code));
  }
  /*
   * The one divergence, asserted so that it stays the only one. `cpctl` falls back
   * to its own `REEMOAT_CP_URL` when the response carried no URL; the browser
   * copy has no equivalent and needs none, because the page is served by the
   * control plane it is talking to.
   */
  check(
    "cpctl's only divergence is its BASE_URL fallback",
    cpctl("", "ec_x", "https://fallback"),
    enrollmentLines("https://fallback", "ec_x"),
  );

  /*
   * The extraction's **failure mode**, which is the one thing about this check
   * that a reader of `enrollment.ts` is now told to rely on.
   *
   * That docblock used to claim nothing anywhere compared the two copies, which
   * was false in the direction that costs the guard: a contributor tightening the
   * shell quoting would have concluded there was no cross-file check and either
   * edited one copy or deleted this whole block as dead scaffolding. It now says
   * what is actually enforced *and* what the coupling rests on — a top-level
   * `function enrollmentLines(` read to the next bare `}` in column 0 — and
   * promises that renaming or nesting it makes this driver **throw** rather than
   * quietly skip the comparison.
   *
   * A comment cannot be asserted, and this is not an attempt to assert one: it is
   * the property the corrected comment now promises, driven against `callable`
   * itself. A rewrite of the extractor that silently skipped instead — the
   * plausible "improvement", since a throw in a driver looks like a bug — would
   * leave the two copies free to diverge with this section still printing `ok`,
   * and fails here instead.
   */
  const extractionFails = (source: string): boolean => {
    try {
      callable(source);
      return false;
    } catch {
      // The throw is the answer; its message is `callable`'s own and is not pinned
      // here, because what matters is loud rather than which words.
      return true;
    }
  };
  check("a renamed function is not silently skipped", extractionFails("function enrollLines(a, b) {\n  return a;\n}\n"), true);
  check("nor is a nested one", extractionFails("const x = {\n  function enrollmentLines(a, b) {\n    return a;\n  }\n}\n"), true);
  check(
    "nor is one whose closing brace never reaches column 0",
    extractionFails("function enrollmentLines(a, b) {\n  return a;\n  }\n"),
    true,
  );
  /*
   * An annotation *inside* the body that the strip does not know about is a
   * `SyntaxError` out of `new Function` — the same loudness by another route, and
   * the reason the docblock names the one transformation (`: string`, the local
   * arrow's parameter and return type) rather than leaving it to be discovered.
   * The signature line itself is discarded with the braces, which is why this
   * fixture puts the annotation on a local.
   */
  check(
    "and neither is an annotation this cannot strip",
    extractionFails("function enrollmentLines(a, b) {\n  const q = (v: URL) => String(v);\n  return q(a);\n}\n"),
    true,
  );
  // And the shape it does accept, so the three above are refusals rather than a
  // helper that refuses everything.
  check(
    "while the shape cpctl actually has is extracted",
    extractionFails("function enrollmentLines(controlPlaneUrl: string, code: string): string {\n  return controlPlaneUrl;\n}\n"),
    false,
  );

  const now = 1_700_000_000_000;
  check("time left is said in minutes", enrollmentExpiryText(now + 58 * 60_000, now), "expires in 58m");
  check("and in hours when there are some", enrollmentExpiryText(now + 61 * 60_000, now), "expires in 1h 1m");
  check("a spent code says so", enrollmentExpiryText(now - 1, now), "expired");
}

/* ------------------------------------------------------------------ *
 * How wide the rail is
 *
 * `clampRailWidth` is the only place a width is bounded and there are four ways
 * in — the drag, the two keyboard steps, the stored value and the reset — so the
 * interesting cases are the ones no pointer produces: a hand-edited
 * `localStorage` entry, and the `NaN` that `Number.parseInt` answers for it.
 *
 * The shell is asserted the way the retired colours and the `orphansFor` coupling
 * are, by reading source text: what has to hold is that the width reaches the DOM
 * as a **custom property** rather than as a React `style` prop. That is not a
 * preference — `store` publishes on a four-second poll and on every streamed
 * event, so a width React owns is a width that snaps back to the start of the drag
 * every time one lands, and the bug would only ever appear on a session that was
 * talking.
 * ------------------------------------------------------------------ */

process.stdout.write("\nhow wide the rail is\n");
{
  const { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, clampRailWidth } = await import("../src/ui/rail.js");

  check("the bounds leave a usable range and the default is inside it", [RAIL_MIN < RAIL_DEFAULT, RAIL_DEFAULT < RAIL_MAX], [
    true,
    true,
  ]);
  check("the default is the width this shipped at", RAIL_DEFAULT, 312);

  check("a width inside the bounds is kept", clampRailWidth(360), 360);
  check("too narrow is refused rather than allowed", clampRailWidth(10), RAIL_MIN);
  check("and so is too wide", clampRailWidth(4000), RAIL_MAX);
  check("the bounds are inclusive", [clampRailWidth(RAIL_MIN), clampRailWidth(RAIL_MAX)], [RAIL_MIN, RAIL_MAX]);
  check("a fractional pointer position is rounded", clampRailWidth(360.6), 361);

  /*
   * The three a pointer cannot produce. `Number.parseInt("wide", 10)` is `NaN`,
   * and `NaN` compared against a bound is `false` in *both* directions — so a bare
   * `Math.min`/`Math.max` pair passes it through untouched and the rail mounts at
   * `NaN` pixels, which computes to zero width and no visible rail at all.
   */
  check("a hand-edited storage value cannot produce a rail of NaN", clampRailWidth(Number.NaN), RAIL_DEFAULT);
  check("nor can an infinity", [clampRailWidth(Infinity), clampRailWidth(-Infinity)], [RAIL_DEFAULT, RAIL_DEFAULT]);

  /*
   * **The two halves a source-text pin cannot see, and both are load-bearing.**
   *
   * Everything above asserts the clamp and the wiring, and every one of them stays
   * green with the body of `setRailWidth` reduced to `width = next`. That is not a
   * hypothetical: it leaves a rail that still *drags* — the handle writes the
   * custom property itself — while the width silently stops surviving a reload and
   * the keyboard and the double-click reset stop doing anything at all, because
   * both of those reach the DOM only through the subscriber that re-runs
   * `AppShell`'s effect. A feature broken in three places with seven drivers green
   * is the shape this repo calls a property the code appears to have and nothing
   * enforces, so it is asserted behaviourally rather than by reading the file.
   */
  const { railWidth, setRailWidth, subscribeRail } = await import("../src/ui/rail.js");

  let notified = 0;
  const unsubscribe = subscribeRail(() => void (notified += 1));

  setRailWidth(RAIL_DEFAULT + 40);
  check("a committed width is readable back", railWidth(), RAIL_DEFAULT + 40);
  check("and every subscriber is told", notified, 1);
  check(
    "and it is written where a reload will find it",
    storage.get("reemoat.railWidth"),
    String(RAIL_DEFAULT + 40),
  );

  // Idempotent: the drag commits on every `pointerup`, including the ones that
  // moved nothing, and a fan-out per no-op would re-render the shell for nothing.
  setRailWidth(RAIL_DEFAULT + 40);
  check("committing the same width again tells nobody", notified, 1);

  // Out of range still commits — clamped — rather than being dropped, which is
  // what makes a drag that runs off the edge settle at the bound instead of
  // snapping back to where it started.
  setRailWidth(9999);
  check("a width past the bound commits the bound", railWidth(), RAIL_MAX);
  check("and that is a change, so it is announced", notified, 2);

  unsubscribe();
  setRailWidth(RAIL_DEFAULT);
  check("and an unsubscribed listener stops hearing", notified, 2);
  check("while the value still moved", railWidth(), RAIL_DEFAULT);

  const shell = readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8");
  check(
    "the width reaches the rail as a custom property, not a React style prop",
    /lg:w-\[var\(--rail-w\)\]/.test(shell),
    true,
  );
  check("and nothing sets an inline width on the aside", /<aside[^>]*style=/.test(shell), false);
  check("the drag writes that property directly", /setProperty\("--rail-w"/.test(shell), true);
  check(
    "the handle is bounded by the same helper the store is",
    /clampRailWidth\(origin\.width \+ event\.clientX - origin\.x\)/.test(shell),
    true,
  );
  /*
   * Capture rather than `window` listeners, and this is the half that is invisible
   * to every other check here: released outside the browser window, an uncaptured
   * pointer delivers no `pointerup` to the document at all, so the strip stays
   * armed and the next click anywhere resizes the rail.
   */
  check("the drag captures its pointer", /setPointerCapture\(event\.pointerId\)/.test(shell), true);
  check("and adds no window listener to leak", /window\.addEventListener\("pointer/.test(shell), false);

  /*
   * **The handle paints above the two sticky bars, and both halves of that are
   * reversible by an edit that looks like tidying.**
   *
   * `Header` is `sticky` at `LAYER.header` and `Composer` is `sticky` in the same
   * pane. A positioned element with `z-auto` loses to one with `z-30`, so the grab
   * strip has to carry `LAYER.header` *and* come after `<main>` — equal z-index,
   * later sibling. Move `<RailHandle />` back between the panes, or drop the layer
   * class, and the top and bottom of a full-height divider go dead while every
   * driver here stays green and the app looks entirely normal.
   */
  check("the handle is on the z-order table rather than a literal", /\$\{LAYER\.header\}/.test(shell), true);
  /*
   * Both operands are checked against `>= 0` first: rename either and `indexOf`
   * answers -1, and `n > -1` is *true* for every real position, so an unguarded
   * comparison passes with the ordering it pins no longer expressible.
   */
  const railHandle = shell.indexOf("<RailHandle />");
  const contentPane = shell.indexOf("<main ");
  check("the handle is still rendered by the shell", railHandle >= 0, true);
  check("and there is still a content pane for it to follow", contentPane >= 0, true);
  check(
    "and comes after the content pane, which is what breaks the tie",
    railHandle >= 0 && contentPane >= 0 && railHandle > contentPane,
    true,
  );
  check("it is anchored on the rail's own width", /left: "var\(--rail-w\)"/.test(shell), true);

  /*
   * `index.css` has to carry the default too. The effect that syncs the stored
   * width runs *after* first paint, so without a declared value the rail mounts at
   * whatever `w-[var(--rail-w)]` falls back to — which is nothing — and jumps a
   * frame later on every reload.
   */
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  /*
   * **Derived from `RAIL_DEFAULT`, not a second literal**, which is the whole point
   * of the check rather than a nicety. It was written `/--rail-w:\s*19\.5rem/` and
   * passed beside `check(RAIL_DEFAULT, 312)` — two numbers pinned independently,
   * with nothing asserting they are the same number, and they were not: `19.5rem`
   * is 312px only at a 16px root, nothing in this app sets one, and `AppShell`
   * writes px unconditionally. So a reader on Chrome's "Large" got a 78px snap on
   * every load, of exactly the kind the CSS declaration exists to prevent, with
   * both assertions green. Same move `pincheck` makes for an agent version written
   * down in two files.
   */
  check(
    "and CSS declares the same number in the same unit, so the first paint is not a jump",
    new RegExp(`--rail-w:\\s*${RAIL_DEFAULT}px`).test(css),
    true,
  );
  check("and nothing declares it in a unit that depends on the reader's font size", /--rail-w:\s*[\d.]+r?em/.test(css), false);
  check(
    "the handle is in the one focus rule rather than styling its own",
    /\[role="separator"\]\[tabindex\]/.test(css),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * The screens somebody reaches before there is a credential
 *
 * `gate.ts` rather than `router.ts`, for the reason the settings block above
 * gives: that module reads `window.location` and installs a `popstate` listener
 * in its body, and this driver has neither.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe gate: registration, confirmation and recovery\n");
{
  const {
    GATE_SCREENS,
    gateNeedsToken,
    gateNotice,
    gateOffer,
    gateNeedsSession,
    gateOutranksSession,
    gatePath,
    incompleteLinkRemedy,
    showsGateLink,
    signupScreen,
    gateUsable,
    isGatePath,
    isGateToken,
    parseGateScreen,
    readGateToken,
  } = await import("../src/gate.js");
  const { SECTION_SPECS, settingsPath } = await import("../src/settings.js");
  const { adminMayInvite, mailUsable, parseInstanceConfig, signupMode } = await import("../src/instance.js");

  /* ---- which screen a path names ---- */
  check("no segments is no gate screen", parseGateScreen([]), null);
  check("an unrelated path is none", parseGateScreen(["settings"]), null);
  check("a session path is none", parseGateScreen(["m", "m_1", "s", "s_1"]), null);
  /*
   * The disjointness case. A prefix-matching parser would eat `/new`, which is
   * an overlay route this app has had for far longer than it has had a gate.
   */
  check("and /new is none", parseGateScreen(["new"]), null);
  for (const screen of GATE_SCREENS) {
    check(`${screen} names itself`, parseGateScreen([screen]), screen);
    check(`${screen} round-trips through its path`, parseGateScreen(gatePath(screen).slice(1).split("/")), screen);
  }
  check("and the case a URL arrives in does not decide", parseGateScreen(["Reset"]), null);

  /*
   * ---- what a truncated link offers next ----
   *
   * One card served all three token screens and its button went to `/forgot`,
   * which is the wrong door for two of them. A cut-short **confirmation** link
   * belongs to somebody with no account at all, and `/forgot` answers them with
   * the deliberately blank "if that address has an account" sentence and mails
   * nothing — so the one screen whose entire job is to be a way forward was a
   * dead end. Asserted per screen rather than as "there is a button", because a
   * button pointing somewhere useless passes that.
   */
  check("a truncated sign-up link offers the sign-up form", incompleteLinkRemedy("confirm")?.path, "/register");
  check("a truncated reset link offers a new one", incompleteLinkRemedy("reset")?.path, "/forgot");
  // Nothing honest to offer: that account exists and is signed in somewhere, so
  // a reset is not what was lost. The footer's sign-in link is the answer.
  check("a truncated verify link offers nothing rather than the wrong thing", incompleteLinkRemedy("verify"), null);
  check(
    "and the screens that never carry a token have no remedy at all",
    [incompleteLinkRemedy("register"), incompleteLinkRemedy("forgot")],
    [null, null],
  );
  check("whole segments only", isGatePath("/registerish"), false);
  check("a real one is a gate path", isGatePath("/register"), true);

  /*
   * Cross-file, and the second is the one that matters: a future settings
   * section literally called `register` would silently steal a gate route, and
   * nothing else in this system would notice.
   */
  check(
    "no gate screen collides with a settings path",
    SECTION_SPECS.every((spec) => !isGatePath(settingsPath(spec.id))),
    true,
  );

  /* ---- the token, which rides the fragment ---- */
  const real = "pr_AbCdEf0123456789_-xyz";
  check("a well-formed registration token", isGateToken(real), true);
  check("and an email token", isGateToken("et_AbCdEf0123456789xyz"), true);
  check("an API key is not one", isGateToken("rk_AbCdEf0123456789xyz"), false);
  // `credentialKind` answers "session" for anything not starting `rk_`, so a
  // token that reached `setSession` would be stored as *the* credential and
  // every later request would 401 with nothing to explain it.
  check("nor is a session token", isGateToken("rs_AbCdEf0123456789xyz"), false);
  check("no dot, so the SPA fallback cannot 404 the link as an asset", isGateToken("pr_abcdefghijklmnop.png"), false);
  check("no slash, which a path split would cut", isGateToken("pr_abcdefghijklmn/op"), false);
  check("no percent, which a decode would rewrite", isGateToken("pr_abcdefghijklmn%20"), false);
  check("too short is not one", isGateToken("pr_abc"), false);
  check("empty is not one", isGateToken(""), false);

  check("the token comes out of the fragment", readGateToken(`#t=${real}`), real);
  check("with or without the hash", readGateToken(`t=${real}`), real);
  check("an empty fragment is nothing", readGateToken(""), null);
  check("a fragment naming something else is nothing", readGateToken("#other=1"), null);
  /*
   * The truncated paste, which is the case that decides this exists at all: a
   * link cut short by a chat app must produce a screen that says so, rather than
   * a request the server refuses about a token nobody typed.
   */
  check("a truncated token is nothing rather than a request", readGateToken("#t=pr_abc"), null);
  check("and rubbish in the fragment never throws", readGateToken("#%%%"), null);
  /*
   * **The order of the two steps, which every case above is blind to.**
   *
   * `readGateToken` decodes (`URLSearchParams`) and then shape-checks
   * (`isGateToken`), and the cases above pass under either order: they use raw
   * `%`, which `isGateToken` refuses and a decode rewrites, so both orders
   * answer `null` and both look right. `%2D` is the fixture that separates them
   * — it decodes to `-`, which **is** inside the token alphabet — so this is
   * `null` if the shape check ever runs first, and the token if it does not.
   *
   * It is not a hypothetical rearrangement: a mail client that percent-escapes a
   * fragment is the ordinary way one arrives, and checking first would answer
   * "this link is incomplete" about a link that is intact.
   */
  check(
    "a percent-encoded token is decoded before it is shape-checked",
    readGateToken("#t=pr_AbCdEf0123456789%2Dxyz"),
    "pr_AbCdEf0123456789-xyz",
  );

  for (const screen of GATE_SCREENS) {
    check(`${screen} usable with a token`, gateUsable(screen, real), true);
    check(
      `${screen} without one`,
      gateUsable(screen, null),
      // A token screen with no token cannot act; the other two never needed one.
      !gateNeedsToken(screen),
    );
  }
  /*
   * Asked for different reasons and currently answered the same way, so the
   * equality is pinned with the note that the day they diverge this assertion is
   * deleted deliberately rather than discovered. `sectionAllowed` vs
   * `visibleSections` has the same shape.
   */
  check(
    "needing a token and outranking a session agree, for now",
    GATE_SCREENS.every((screen) => gateNeedsToken(screen) === gateOutranksSession(screen)),
    true,
  );

  /* ---- the one screen that needs a session as well as a token ---- */

  /*
   * `/verify` spends its token below THE LINE, so a token alone cannot repoint
   * an account's reset channel — which is the point of putting it there and the
   * reason this screen has a second requirement at all.
   */
  check("exactly one screen needs a session", GATE_SCREENS.filter(gateNeedsSession), ["verify"]);
  /*
   * And it is a *token* screen. A screen needing a session and no token would be
   * one `App` draws above the sign-in form with nothing to do when it gets there,
   * which is the shape of the defect below rather than a second one.
   */
  check(
    "and it is one of the token screens",
    GATE_SCREENS.every((screen) => !gateNeedsSession(screen) || gateNeedsToken(screen)),
    true,
  );

  /*
   * **What that screen used to render, driven rather than described.**
   *
   * `VerifyEmail`'s effect fired on mount unconditionally, and `App` draws the
   * gate *above* `signed_out` — deliberately, so a mailed link beats the sign-in
   * form — so the ordinary visitor is somebody with no credential at all.
   * `cpFetch` refuses before it builds a request, and the string it refuses with
   * is the one below: an internal sentence, written so that a bug in *this
   * client* has something to say, rendered by `linkError`'s `default:` arm under
   * "That link did not work" at somebody whose link is intact and unspent.
   *
   * Asserted through the real `cp` and the real mapper, because the value of
   * this case is that it names what the branch in `Gate.tsx` exists to prevent —
   * and it stays true whatever that branch does, which is what stops it being
   * deleted along with the fix.
   */
  const cpModule = await import("../src/cp.js");
  const { linkError: gateLinkError } = await import("../src/account.js");
  const { ApiError: GateApiError } = await import("../src/http.js");
  check("no credential is held by this point in the driver", cpModule.currentCredential(), null);
  const refusedVerify = await cpModule.verifyMyEmail(real).then(
    () => null,
    (error: unknown) => error,
  );
  check(
    "a signed-out /verify never reaches the network",
    GateApiError.isApiError(refusedVerify) ? refusedVerify.code : refusedVerify,
    "missing_api_key",
  );
  check("and what it would have shown is an internal sentence", gateLinkError(refusedVerify), "not signed in");

  /* ---- what the signed-out screen offers ---- */
  // `source: null` throughout: none of the predicates below reads it, and that is
  // the assertion — the AGPL §13 offer is drawn beside these screens and decides
  // none of them. A fixture carrying a URL here would hide a future predicate
  // that started keying on it.
  const off = { registration: "off", email: false, source: null } as const;
  const offMail = { registration: "off", email: true, source: null } as const;
  const openLocal = { registration: "open", email: false, source: null } as const;
  const openMail = { registration: "open", email: true, source: null } as const;

  /* ---- the wire body actually becomes one of those ---- */

  /*
   * **The span nothing crossed**, and a live defect lived in it for a release.
   *
   * The four fixtures above are hand-written in the *client's* flat shape, and
   * every predicate below was asserted against them and passed. `relaycheck`
   * drove the live `GET /v1/instance` and asserted the *server's* nested shape,
   * and passed. The two shapes have never matched, `cp.ts` bridged them with
   * `readJson<InstanceConfig>` — an unchecked assertion the compiler cannot
   * question — and the result was a sign-in screen on an instance with
   * registration open and SMTP working that drew neither door.
   *
   * So the fixtures are no longer trusted to resemble anything. The server's own
   * object literal is lifted out of `app.ts` and run through the client's
   * parser, which is `enrollmentLines`' technique pointed at the other package:
   * two copies compared by *behaviour* rather than by a transcription of one.
   * Rename `mail.configured` on either side and this goes red.
   */
  const appSource = readFileSync(new URL("../../control-plane/src/app.ts", import.meta.url), "utf8");

  /*
   * The §13 constants are lifted the same way and for the same reason.
   *
   * They are free variables in the handler body, so they have to be supplied to
   * `new Function` — and taking them from `app.ts` rather than writing them out
   * here is what keeps this a *span* rather than a second transcription. Rename
   * `SOURCE_URL`, or drop the field from the payload, and this file goes red
   * instead of quietly asserting a shape nobody serves.
   */
  const literalIn = (name: string): string => {
    const found = new RegExp(`^const ${name} = "([^"]*)";$`, "m").exec(appSource);
    if (found === null) throw new Error(`app.ts no longer declares a top-level string const ${name}`);
    return found[1] ?? "";
  };
  const SOURCE_URL = literalIn("SOURCE_URL");
  const VERSION = literalIn("VERSION");
  const wireSource = { url: SOURCE_URL, version: VERSION };

  const instanceWireBody = (mode: { enabled: boolean; requiresEmail: boolean }, configured: boolean): unknown => {
    const source = appSource.split("\n");
    const open = source.findIndex((line) => line.startsWith('  app.get("/v1/instance"'));
    if (open < 0) throw new Error("app.ts no longer registers GET /v1/instance at the top level of its routes");
    const close = source.findIndex((line, index) => index > open && line === "  });");
    if (close < 0) throw new Error("app.ts's /v1/instance handler has no closing `});` at its own indent");
    /*
     * A `SyntaxError` out of `new Function` is the loud failure this wants: the
     * day that handler grows a type annotation or a helper call, this stops
     * rather than quietly asserting something else.
     */
    const handler = new Function(
      "registrationMode",
      "mailConfigured",
      "SOURCE_URL",
      "VERSION",
      "db",
      "c",
      source.slice(open + 1, close).join("\n"),
    );
    return handler(
      () => mode,
      () => ({ configured }),
      SOURCE_URL,
      VERSION,
      {},
      { json: (value: unknown) => value },
    ) as unknown;
  };

  check(
    "the server's own literal parses into the open-with-mail fixture",
    parseInstanceConfig(instanceWireBody({ enabled: true, requiresEmail: true }, true)),
    { ...openMail, source: wireSource },
  );
  check(
    "and into the closed-without-mail one",
    parseInstanceConfig(instanceWireBody({ enabled: false, requiresEmail: false }, false)),
    { ...off, source: wireSource },
  );
  check(
    "registration off with mail configured survives the wire too",
    parseInstanceConfig(instanceWireBody({ enabled: false, requiresEmail: false }, true)),
    { ...offMail, source: wireSource },
  );

  /*
   * A shape this client cannot read is `null` — **unknown**, which fails open —
   * and never a config with everything switched off, which is the failure this
   * parser exists to end arrived at from the other direction.
   */
  check("a body from before this release is unknown", parseInstanceConfig({}), null);
  check("so is one that is not an object at all", parseInstanceConfig("registration: open"), null);
  check("and null itself", parseInstanceConfig(null), null);
  // The exact defect: the flat shape the client's *type* claims is not what the
  // server sends, and reading it as if it were must not half-succeed.
  check("the client's own type is not a wire body", parseInstanceConfig({ registration: "open", email: true }), null);
  check(
    "a nested body missing the mail half is unknown, not mail-less",
    parseInstanceConfig({ registration: { enabled: true } }),
    null,
  );

  // Fails OPEN, the opposite of `visibleSections`: fail closed where the cost is
  // a missing screen, fail open where the cost is a locked-out person.
  check("an unknown config is reported as unknown", gateOffer("register", null), "unknown");
  check("for both doors", gateOffer("forgot", null), "unknown");
  check("registration closed", gateOffer("register", off), "closed");
  check("registration open", gateOffer("register", openLocal), "link");
  /*
   * THE cell. Registration off with mail configured is an admin-only instance
   * where people still reset their own passwords, and an implementation keyed on
   * one "self-service" boolean gets every other cell right and this one wrong.
   */
  check("recovery survives registration being closed", gateOffer("forgot", offMail), "link");
  check("no mail, no recovery", gateOffer("forgot", openLocal), "closed");

  /*
   * **Where failing open actually happens**, and the assertion that was missing.
   *
   * `gateOffer` answered `"unknown"` and every call site tested `=== "link"`, so
   * an unknown config drew *nothing* — the exact opposite of the documented
   * intent, in the one frame somebody arriving at a sign-in screen looks at. The
   * three-way answer was asserted; the two-way rule the screen actually uses was
   * not, so the gap between them was invisible.
   */
  check("an unknown config still offers to register", showsGateLink("register", null), true);
  check("and still offers recovery", showsGateLink("forgot", null), true);
  check("only a definite no hides a door", showsGateLink("register", off), false);
  check("recovery survives registration being closed, in the drawn form too", showsGateLink("forgot", offMail), true);
  check("and no mail really does hide recovery", showsGateLink("forgot", openLocal), false);

  // The property, not the prose: a door is never missing without a sentence, and
  // never explained while it is there. Through the predicate the screen uses, so
  // the two cannot disagree.
  for (const config of [null, off, offMail, openLocal, openMail]) {
    const silent = gateNotice(config) === null;
    const both = showsGateLink("register", config) && showsGateLink("forgot", config);
    check(`a missing door always has a sentence (${JSON.stringify(config)})`, silent, both);
  }
  // The frame the bug lived in: nothing known, so nothing is explained away.
  check("an unknown config says nothing at all", gateNotice(null), null);

  /* ---- what the sign-up form asks for ---- */
  check("an unknown config waits rather than guessing", signupMode(null), null);
  check("closed", signupMode(off), "closed");
  // The cell an implementation keyed on `email` alone gets wrong.
  check("closed even with mail", signupMode(offMail), "closed");
  check("open without mail takes a password only", signupMode(openLocal), "open_local");
  check("open with mail requires an address", signupMode(openMail), "open_verified");

  // Fails CLOSED, the opposite of `gateOffer`, because the cost here is that an
  // admin hands a password over by hand — the status quo, not a lockout.
  check("inviting is refused while the config is unknown", adminMayInvite(null), false);
  check("and allowed only with mail", [adminMayInvite(openMail), adminMayInvite(openLocal)], [true, false]);

  /* ---- and what the sign-up screen does while it knows nothing ---- */

  /*
   * **The state that did not exist, and the spinner that never ended.**
   *
   * `signupMode` answers `null` for an unknown config and must — this is the one
   * screen that may not guess. What was missing is *has anybody finished
   * asking*: without it `null` meant both "coming" and "there is no answer", the
   * screen drew a spinner for the union, and one failed `GET /v1/instance` left
   * it there for ever. A signed-out tab never re-reads the config —
   * `runResume`'s re-read is behind `cp.currentCredential() !== null` — and
   * `showsGateLink` fails **open**, so the sign-in screen offers "Create an
   * account" *precisely* when the config is unknown. The two rules compose into
   * a door that leads to a spinner with no footer.
   */
  check("an unread config still waits", signupScreen(null, false), "waiting");
  check("and a read that finished with nothing to show says so", signupScreen(null, true), "unavailable");

  /*
   * **`waiting` if and only if nothing is known and nothing has finished** —
   * the property rather than the two cells, because what has to hold is that no
   * *other* combination can hang. A tenth state on `InstanceConfig` cannot
   * arrive without answering this.
   */
  for (const config of [null, off, offMail, openLocal, openMail]) {
    for (const settled of [true, false]) {
      check(
        `nothing hangs but the unread config (${JSON.stringify(config)}, settled=${settled})`,
        signupScreen(config, settled) === "waiting",
        config === null && !settled,
      );
    }
  }
  /*
   * And giving up is **derived, never latched**: a config landing after the
   * screen said it could not tell supersedes it on the next render. Asserted as
   * agreement with `signupMode` under *both* flags, so a future implementation
   * that remembers having failed fails here.
   */
  for (const config of [off, offMail, openLocal, openMail]) {
    check(
      `a config that lands wins whatever the screen had settled for (${JSON.stringify(config)})`,
      [signupScreen(config, true), signupScreen(config, false)],
      [signupMode(config), signupMode(config)],
    );
  }

  /* ---- and whether an address on an account can do anything ---- */

  /*
   * Settings → Account drew the whole Email block by default, over the sentence
   * "and you can reset your own password" — the exact capability an instance
   * with no SMTP does not have, offered to the people who then have no way back
   * in at all. `PUT /v1/me/email` answers `409 mail_unconfigured` before it
   * reads the body, so every control in that block could only ever be refused.
   */
  check("no mail, so an address can do nothing", mailUsable(openLocal), false);
  check("mail, so it can", mailUsable(openMail), true);
  // Keyed on `email` alone, like `gateOffer("forgot", …)` and for the same
  // reason: an admin-only instance still recovers its own accounts.
  check("registration decides nothing about it", [mailUsable(off), mailUsable(offMail)], [false, true]);

  /*
   * **The three `null` answers side by side**, because they are one sentence
   * read in two directions — *fail closed where the cost is a missing screen,
   * fail open where the cost is a locked-out person* — and the only way to see
   * that a new predicate picked the right direction is against the two that
   * already did. Recovery and the address form both lead somebody back into an
   * account; inviting only saves an admin a copy and paste.
   */
  check(
    "an unknown config keeps both ways back and withholds the convenience",
    [showsGateLink("forgot", null), mailUsable(null), adminMayInvite(null)],
    [true, true, false],
  );
  /*
   * The machine limit's predicate joins that comparison rather than choosing its
   * direction alone. It is the same kind as the first two: `AddMachine` is the
   * **only** way to create a machine anywhere in this app, so failing closed on
   * an unreadable `me` — which `bootstrap`'s catch reaches, and a rolled-back
   * control plane reaches permanently — leaves somebody with quota and no route
   * to a machine, which is no sessions, which is no product.
   */
  check(
    "and it keeps the only door to a machine open too",
    (await import("../src/quota.js")).mayAddMachine(null),
    true,
  );

  /* ---- the order App.tsx tests all of this in ---- */

  /*
   * **Source text, because the rule is the order of four `if`s in one function
   * body** and there is nothing pure to ask. No driver read `App.tsx` at all
   * until this one, so the two orderings below were held by a docblock and by
   * nothing else — and both of them fail *silently*, as a screen that does not
   * appear rather than as an error.
   *
   * Comments are stripped first, for the reason the `Gate.tsx` and `cp.ts` pins
   * strip theirs: each branch's docblock **quotes the ordering being asserted**
   * ("Above `signed_out` because that is the state on the *first frame*"), so
   * the raw file satisfies these searches whichever way round the code is, and
   * the cheapest route back to green would be deleting the explanation.
   *
   * Every `indexOf` is checked against `>= 0` first, so a rename fails here
   * naming the string that moved rather than passing quietly on `-1 < n`.
   */
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const gateBranch = app.indexOf('route.name === "gate"');
  const signedOut = app.indexOf('phase === "signed_out"');
  const wall = app.indexOf("mustChangePassword === true");
  const shell = app.indexOf("<AppShell");
  check("App.tsx still branches on the gate route", gateBranch >= 0, true);
  check("and still has a signed-out phase for it to outrank", signedOut >= 0, true);
  check("and still has a wall in front of a temporary password", wall >= 0, true);
  check("and still renders the shell behind it", shell >= 0, true);

  /*
   * A reset link opened in a browser that has never signed in arrives with
   * `phase === "signed_out"` on the very first frame — that is not the edge
   * case, it is the *normal* one — so below that branch the reset screen is
   * unreachable in exactly the state it exists for, and what somebody clicking
   * a mailed link would get is the sign-in form asking for the password they
   * cannot remember.
   */
  check("a mailed link is drawn above the sign-in screen", gateBranch < signedOut, true);
  /*
   * And above the wall, which is the reason the wall is asserted at all:
   * somebody an admin issued a temporary password to cannot type it into a
   * "current password" box, so the mailed link is their only way out and it has
   * to beat the screen that demands the thing they lost.
   */
  check("and above the forced password change", gateBranch < wall, true);
  /*
   * The wall itself precedes the shell, and that is the other half: below
   * `<AppShell` an account holding a temporary password is handed the whole app,
   * where every route under THE LINE answers `403 password_change_required` and
   * nothing on screen says why — the four routes left reachable above that gate
   * are `GET /v1/me`, the password change and the two session deletes.
   */
  check("and the wall itself is in front of the app", wall < shell, true);

  /* ---- what the pre-credential screens may do ---- */

  /*
   * **No gate screen stores what it was mailed.**
   *
   * `credentialKind` answers "session" for anything not starting `rk_`, so a
   * `pr_`/`et_` token handed to `setSession` is written to `localStorage` as
   * *the* credential — and every later request 401s with nothing on screen to
   * explain it, on a device that may never have been signed in. `isGateToken`
   * refuses that shape above; this refuses the call.
   *
   * **And every navigation out of these screens replaces rather than pushes.**
   * These links are single-use: Back onto a URL whose fragment still holds a
   * spent token re-submits it, the server answers `token_unusable`, and the
   * screen says the link is dead about a reset that in fact worked. Counted
   * rather than matched call by call, because what has to hold is that *every*
   * one carries the argument, which a search for the good shape alone cannot
   * say.
   *
   * The **directory** is read rather than the two files named, so a third gate
   * screen is covered by arriving rather than by somebody remembering this.
   */
  const gateDir = new URL("../src/ui/gate/", import.meta.url);
  const gateScreenFiles = readdirSync(gateDir).filter((name) => /\.tsx?$/.test(name));
  check("there are gate screens to have checked", gateScreenFiles.length > 0, true);
  for (const name of gateScreenFiles) {
    const code = readFileSync(new URL(name, gateDir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    check(`${name} never stores a mailed token as the credential`, /setSession\(/.test(code), false);
    // One level of nesting is allowed for, so `navigate(gatePath(screen), true)`
    // counts as replacing rather than as a call that lost its argument.
    const calls = code.match(/navigate\(/g)?.length ?? 0;
    const replacing = code.match(/navigate\((?:[^()]|\([^()]*\))*,\s*true\)/g)?.length ?? 0;
    check(`${name} replaces on all ${calls} of its navigations`, replacing, calls);
  }

  /* ---- and no card is a wait with no way off it ---- */

  /*
   * **Every `GateCard` holding a spinner carries a footer.**
   *
   * The rule generalises the defect rather than restating it: `/register` drew a
   * bare centred `Spinner` in a card with no footer while it waited for
   * `GET /v1/instance`, and one failed read made that the whole screen, for ever,
   * on a tab that never asks again. A card somebody can only *wait* on is the one
   * card that must always say how to leave, whether the wait is a second or
   * permanent — and stated that way it also covers `/verify`'s own spinner, which
   * is bounded by `CP_TIMEOUT_MS` and was nonetheless the same shape.
   *
   * The scan is deliberately crude: split on the opening tag, look at each card's
   * own text. It is blind to a spinner rendered by a helper, which is the price
   * of not parsing JSX — and the failure it guards is somebody deleting a
   * `footer=`, which it sees.
   */
  const gateTsx = readFileSync(new URL("../src/ui/gate/Gate.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const cards = gateTsx.split("<GateCard").slice(1).map((rest) => rest.slice(0, rest.indexOf("</GateCard>")));
  const waits = cards.filter((card) => card.includes("<Spinner"));
  // Non-vacuity: a rule about spinner cards is worth nothing on a file with none,
  // and this is exactly the shape that would be "fixed" by deleting the wait.
  check("there are cards that can only be waited on", waits.length > 0, true);
  check("and every one of them carries a way off it", waits.filter((card) => card.includes("footer=")).length, waits.length);

  /* ---- /verify: the session, and where the way in is ---- */

  /*
   * **Source text, because the rule is the order of two `if`s** — the same
   * argument the `App.tsx` block above makes, one level down. The pure half is
   * asserted at `gateNeedsSession`; this is the half that says the component
   * asks it, asks it *first*, and answers with something that keeps the token.
   *
   * Comments stripped: the branch's own docblock quotes both `not signed in` and
   * `VerifyEmail`, so the raw file satisfies every search here whichever way
   * round the code is, and the cheapest route back to green would be deleting
   * the explanation.
   */
  const asksForSession = gateTsx.indexOf("gateNeedsSession(");
  const testsSignedOut = gateTsx.indexOf('phase === "signed_out"');
  const mountsVerify = gateTsx.indexOf("<VerifyEmail");
  check("Gate.tsx asks the shared predicate rather than naming the screen again", asksForSession >= 0, true);
  check("and tests the phase that means there is no credential", testsSignedOut >= 0, true);
  check("and still mounts the screen this is about", mountsVerify >= 0, true);
  check(
    "the signed-out branch is reached before /verify can fire on mount",
    Math.max(asksForSession, testsSignedOut) < mountsVerify,
    true,
  );
  /*
   * **And the way on is the form, not a navigation.** The token is in this URL's
   * fragment and nowhere else, so anything that moves you off `/verify` moves
   * you off the link — back to a mail somebody has to find again. Rendering
   * `SignIn` here leaves the URL alone, so signing in re-renders this same
   * component with a credential and `VerifyEmail` spends the token with no
   * second tap. A card with a button to `/` passes every other check on this
   * page and loses the token.
   */
  check("and the way on is the sign-in form itself", /<SignIn\b/.test(gateTsx), true);

  /* ---- /register: the screen asks again, and asks one function ---- */

  /*
   * The terminal state is only reachable if something can finish a read, and
   * `store.refreshConfig()` is the only thing on a signed-out tab that can:
   * `loadConfig`'s catch is bare by design, so a failure is invisible to the
   * store and this screen is where it stops being a spinner.
   */
  check("the sign-up screen can ask the control plane again", /store\.refreshConfig\(/.test(gateTsx), true);
  /*
   * And it reads the five-way answer rather than the three-way one — the mistake
   * `showsGateLink` exists to record, in which a call site tested the narrower
   * function and threw the new state away.
   */
  check("and reads the screen state rather than re-deriving the mode", /signupMode\(/.test(gateTsx), false);
  check("through the function that has both inputs", /signupScreen\(/.test(gateTsx), true);

  /* ---- Settings → Account: the instance, not just the person ---- */

  /*
   * `Me` says nothing about what the instance can do, so the block promising a
   * self-service password reset had no way to know it was lying. The config is
   * handed down the same way `UsersSection` already takes it.
   */
  const settingsTsx = readFileSync(new URL("../src/ui/settings/Settings.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check("Settings hands the account screen what the instance allows", /<AccountSection[^/>]*config=/.test(settingsTsx), true);

  const accountTsx = readFileSync(new URL("../src/ui/settings/AccountSection.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const asksMailUsable = accountTsx.indexOf("mailUsable(");
  const promisesReset = accountTsx.indexOf("reset your own password");
  check("the account screen asks the shared predicate", asksMailUsable >= 0, true);
  // The `gateOffer` mistake in miniature: a call site reading the raw field is a
  // second copy of the fail-open decision, and the copy is the one that gets it
  // backwards.
  check("and never re-derives it from the config's own field", /config\?\.email|config\.email/.test(accountTsx), false);
  check("the promise about resetting your own password is still made", promisesReset >= 0, true);
  check("and it is made downstream of the check that it is true", asksMailUsable < promisesReset, true);
  /*
   * **Shown with the reason, never silently dropped.** Hiding the block would
   * pass every check above and teach nobody why they have no way back into their
   * account — so the sentence naming what is missing is itself the assertion.
   */
  check("and where it cannot be kept, the block says why", /cannot send mail/.test(accountTsx), true);
}

/* ------------------------------------------------------------------ *
 * Where a setting's value came from, and the one badge a person's row carries
 * ------------------------------------------------------------------ */

process.stdout.write("\nserver settings, and how stuck somebody is\n");
{
  const { canResetField, fieldOrigin, MAIL_BACKLOG_WARN_MS, mailTrouble, originText, secretFieldText, senderMismatch, smtpProblem } = await import(
    "../src/instance.js"
  );
  const { emailChangeNeedsProof, linkError, userState, userStateText } = await import("../src/account.js");
  const { navRows, GROUP_TITLES } = await import("../src/settings.js");
  const { ApiError } = await import("../src/http.js");

  const field = (over: Record<string, unknown>) =>
    ({ key: "smtp.host", secret: false, value: null, source: "unset", envName: "X", envSet: false, ...over }) as never;

  check("nothing anywhere", fieldOrigin(field({})), "unset");
  check("only the environment", fieldOrigin(field({ source: "environment", envSet: true })), "env");
  check("only here", fieldOrigin(field({ source: "database", value: "x" })), "stored");
  check(
    "here, over the environment",
    fieldOrigin(field({ source: "database", value: "x", envSet: true })),
    "overrides_env",
  );
  // An incoherent pair degrades rather than throwing.
  check("a source with nothing behind it", fieldOrigin(field({ source: "environment", envSet: false })), "unset");

  check("reset is offered for exactly one origin", canResetField(field({ source: "database", value: "x", envSet: true })), true);
  // Nothing to reset *to*; the act there is "clear", a different control.
  check("and not when there is nothing underneath", canResetField(field({ source: "database", value: "x" })), false);
  check("nor for an environment value", canResetField(field({ source: "environment", envSet: true })), false);
  check(
    "each origin reads differently",
    new Set((["env", "overrides_env", "stored", "unset"] as const).map(originText)).size,
    4,
  );

  /* ---- what a write-only secret says about itself ---- */

  /*
   * **The state that made the old two-part sentence contradict itself.** `set`
   * is the server answering "is there a database row", never "does a password
   * exist" — `app.ts` writes `set: resolved.source === "database"` — so a
   * password supplied by `REEMOAT_CP_SMTP_PASSWORD`, which is a documented knob
   * that `mailConfigured` reads and delivers on, arrives as
   * `set: false, envSet: true`. The screen said "No password set." and then
   * appended "from the environment", beside a Send test button it had enabled.
   */
  const secret = (over: Record<string, unknown>) =>
    ({ key: "smtp.password", secret: true, value: null, set: false, source: "unset", envName: "X", envSet: false, ...over }) as never;

  check(
    "an environment password exists, and the line says so",
    secretFieldText(secret({ source: "environment", envSet: true })),
    "A password is set in the environment.",
  );
  check("a row here says where it is", secretFieldText(secret({ set: true, source: "database" })), "A password is set here.");
  check(
    "and says which one is winning when both exist",
    secretFieldText(secret({ set: true, source: "database", envSet: true })),
    "A password is set here, overriding the environment.",
  );
  check("nothing anywhere is the only 'no'", secretFieldText(secret({})), "No password is set.");
  // A field the server did not send is unknown, and claiming "no password"
  // about it would be the same lie one step further out.
  check("an absent field says nothing at all", secretFieldText(undefined), null);

  /*
   * The property rather than the four strings: **the screen never denies a
   * password that exists on either side.** A fifth state cannot arrive without
   * answering this.
   */
  for (const set of [true, false]) {
    for (const envSet of [true, false]) {
      const source = set ? "database" : envSet ? "environment" : "unset";
      const text = secretFieldText(secret({ set, envSet, source })) ?? "";
      check(`presence is set||envSet (set=${set}, envSet=${envSet})`, !text.startsWith("No password"), set || envSet);
    }
  }

  const draft = { host: "", port: "", security: "", username: "", from: "", publicUrl: "" };
  // An empty form is "mail is off", a legal state — a form that refused to save
  // it could never turn mail off.
  check("an empty draft is not a problem", smtpProblem(draft), null);
  check("a port out of range is", smtpProblem({ ...draft, host: "h", port: "70000" }) !== null, true);
  check("port zero is", smtpProblem({ ...draft, host: "h", port: "0" }) !== null, true);
  check("587 is fine", smtpProblem({ ...draft, host: "h", port: "587" }), null);
  check("a from address with no @ is", smtpProblem({ ...draft, from: "nobody" }) !== null, true);
  check("a relative public URL is", smtpProblem({ ...draft, publicUrl: "/cp" }) !== null, true);
  check(
    "a full one is not",
    smtpProblem({ ...draft, host: "h", from: "a@b", publicUrl: "https://cp.example" }),
    null,
  );
  check("sending as somebody else is flagged", senderMismatch({ ...draft, username: "a@b", from: "c@d" }), true);
  check("and matching is not", senderMismatch({ ...draft, username: "a@b", from: "A@B" }), false);
  check("a username that is not an address says nothing", senderMismatch({ ...draft, username: "apikey", from: "c@d" }), false);

  /* ---- whether mail is arriving, which is not whether it is configured ---- */

  /*
   * The only surface in the product that can say mail is broken. Everything else
   * reports the *queue*: the server's `send()` answers whether a row was
   * inserted, and Users draws "Invitation queued for …" from it — so a provider
   * that started rejecting the sender produced a green toast and a first user who
   * never heard from us, with the failure reaching one `console.error` in a
   * container whose logs rotate.
   */
  const healthy = { pending: 0, failed: 0, oldestPendingMs: null, lastError: null, lastFailedAt: null, paused: false };
  check("a quiet queue says nothing", mailTrouble(healthy), null);
  check("and neither does something in flight", mailTrouble({ ...healthy, pending: 2, oldestPendingMs: 30_000 }), null);

  /*
   * **`undefined` is not `null`-with-a-clear-conscience.** A control plane rolled
   * back past the `delivery` object sends nothing, and inventing an all-clear
   * from absence is how a banner becomes one nobody trusts. Same answer, and the
   * reason it is the same answer is that both mean "draw nothing" — what differs
   * is what it would take to be wrong.
   */
  check("an older control plane draws no banner rather than an all-clear", mailTrouble(undefined), null);

  /*
   * Ordered by remedy rather than by severity, which is the rule the machine
   * badge already follows for a banned owner over a machine limit. Only the
   * breaker is *currently* stopping delivery.
   */
  check(
    "an open breaker outranks a count of past failures",
    mailTrouble({ ...healthy, failed: 3, paused: true })?.kind,
    "paused",
  );
  check("a failure outranks a backlog", mailTrouble({ ...healthy, failed: 1, pending: 5, oldestPendingMs: 7_200_000 })?.kind, "failed");
  check(
    "and a backlog is only reported once the retries are losing",
    [
      mailTrouble({ ...healthy, pending: 1, oldestPendingMs: MAIL_BACKLOG_WARN_MS - 1 })?.kind ?? null,
      mailTrouble({ ...healthy, pending: 1, oldestPendingMs: MAIL_BACKLOG_WARN_MS })?.kind ?? null,
    ],
    [null, "backlog"],
  );
  // One failure reads as one message, not as "1 messages".
  report(
    "and it counts in English",
    mailTrouble({ ...healthy, failed: 1 })?.text.includes("1 message has") === true,
    `${String(mailTrouble({ ...healthy, failed: 1 })?.text)}`,
  );

  /* ---- the one state badge ---- */
  const person = { disabled: false, hasPassword: true, mustChangePassword: false, emailVerified: true, email: "a@b" };
  check("an ordinary account wears nothing", userState(person, true), null);
  // The precedence case an `if (temp)` written first gets wrong.
  check(
    "disabled outranks everything",
    userState({ ...person, disabled: true, hasPassword: false, mustChangePassword: true }, true),
    "disabled",
  );
  check("no password outranks a temporary one", userState({ ...person, hasPassword: false, mustChangePassword: true }, true), "no_password");
  check("a temporary password", userState({ ...person, mustChangePassword: true }, true), "temporary_password");
  check("an unconfirmed address", userState({ ...person, emailVerified: false }, true), "unverified_email");
  // No address is not an *unverified* address — the case a bare `!verified` test
  // brands every account that simply never added one.
  check("no address at all is not unconfirmed", userState({ ...person, email: null, emailVerified: false }, true), null);
  // On an instance with no SMTP nobody has a verified address, so a badge on
  // every row would be noise.
  check("and nothing is flagged where nobody could confirm", userState({ ...person, emailVerified: false }, false), null);
  check(
    "each state reads differently",
    new Set((["disabled", "no_password", "temporary_password", "unverified_email"] as const).map(userStateText)).size,
    4,
  );

  /*
   * **Setting the address is taking the account**, so the answer does not depend
   * on what the address currently is.
   *
   * ⚠ This asserted the opposite for the state below — `emailVerified: false`
   * used to be exempt, on both sides, and the server agreed with it. That pair
   * was a full takeover from a borrowed session: repoint the address with no
   * proof, confirm it with the same session, `/v1/forgot`, `/v1/reset`, and out
   * comes a password the thief chose. Both green assertions agreed with each
   * other and with the defect. The case is kept and its expectation inverted
   * rather than deleted, because the state it names — an account with a password
   * and no confirmed address, which is what `main.ts` creates the bootstrap admin
   * as — is the one that was exposed.
   */
  check("changing a confirmed address needs proof", emailChangeNeedsProof({ emailVerified: true, hasPassword: true }), true);
  check("and so does adding the first one", emailChangeNeedsProof({ emailVerified: false, hasPassword: true }), true);
  check("as does an account that has no address at all", emailChangeNeedsProof({ hasPassword: true }), true);
  // The migration rule reappearing, and the one exemption that stays: an account
  // with no password row is proved by its API key, and demanding one it never had
  // would strand it. Not a hole — no session can exist without that row, so only
  // a key reaches this arm and a key is already full authority.
  check("nor does an account with no password", emailChangeNeedsProof({ emailVerified: true, hasPassword: false }), false);

  /*
   * Every way a link can be dead reads the same. Written as an equality rather
   * than trusted to the prose: the three are indistinguishable to anybody who
   * does not hold the token, and a future second server code must not quietly
   * split them on screen.
   */
  const dead = linkError(new ApiError(409, "token_unusable", "unknown, used or expired"));
  check("an unusable link says one thing", dead.length > 0, true);
  check("and says nothing about which of the three it was", /used|expired/.test(dead) && !/unknown token/.test(dead), true);

  /* ---- the nav, and the heading that must not float over nothing ---- */
  const plain = { id: "u_1", name: "ada", isAdmin: false };
  const admin = { id: "u_2", name: "root", isAdmin: true };

  check("a non-admin sees two rows", navRows(plain).map((row) => row.spec.id), ["machines", "account"]);
  /*
   * THE case, and it is invisible to the only people who could report it: a
   * heading computed from the static table renders "Server" above nothing for a
   * non-admin, and only an admin ever sees this nav in a correct state.
   */
  check("and no heading floats over nothing", navRows(plain).every((row) => row.heading === null), true);
  check("an unknown viewer is treated as a non-admin", navRows(null).map((row) => row.spec.id), ["machines", "account"]);
  check("an admin sees four", navRows(admin).map((row) => row.spec.id), ["machines", "account", "server", "users"]);
  check(
    "with the heading on the first row of its group only",
    navRows(admin).map((row) => row.heading),
    [null, null, "server", null],
  );
  check("and Server settings sits above Users", navRows(admin).findIndex((row) => row.spec.id === "server") < navRows(admin).findIndex((row) => row.spec.id === "users"), true);
  check("every group has a title", Object.keys(GROUP_TITLES).length >= 1, true);

  /*
   * **No field in Server settings writes itself.**
   *
   * That screen shipped with two saving mechanisms: some fields committed on
   * `onBlur` while the Save button wrote the same keys from a separate draft, and
   * an empty value in that draft means *clear* — so pressing Save deleted exactly
   * the fields that had just saved themselves, and the screen then correctly
   * reported them as not set. It reads as the form having ignored everything
   * typed into it, which is the worst possible symptom for a settings form.
   *
   * Source text, in the `<RailHandle />` idiom this file already uses, because
   * the rule is structural and no pure function can carry it: **one key, one
   * writer.** A blur-commit is how the second writer becomes invisible.
   */
  const serverSection = readFileSync(
    new URL("../src/ui/settings/ServerSection.tsx", import.meta.url),
    "utf8",
  );
  check("no settings field commits on blur", /onBlur=/.test(serverSection), false);
  /*
   * And the password's state sentence is not rebuilt in the JSX. It was two
   * expressions — an existence test on `set` and an `originText` beside it — and
   * two expressions on one line are two things that can disagree, which they
   * did: "No password set. from the environment". The rule is that this file
   * asks one function.
   */
  check(
    "the secret's state is not re-derived on the screen",
    /No password|A password is set/.test(serverSection.replace(/\/\*[\s\S]*?\*\//g, "")),
    false,
  );
  /*
   * And the sign-in screen reads the *drawn* predicate rather than the three-way
   * one — testing `=== "link"` there is what threw the fail-open away.
   */
  const signIn = readFileSync(new URL("../src/ui/SignIn.tsx", import.meta.url), "utf8");
  check("the sign-in screen does not re-derive which doors to draw", /gateOffer\(/.test(signIn), false);

  /*
   * **Both doors are drawn as links, and they are not on one line.**
   *
   * They were: two `text-muted` runs joined by a `·`, which is prose with a
   * separator in it. With the accent colour gone, the underline is the only
   * thing left that says a word moves you somewhere, so it is not optional
   * chrome — a navigation nobody can see is a navigation nobody takes. And the
   * `·` is what made recovery and sign-up read as a pair of equal options,
   * which they are not: one is about the password that just failed, the other
   * about being on the wrong screen.
   *
   * Coarse on purpose — it counts uses of the shared constant rather than
   * inspecting a layout, because the failure being pinned is somebody
   * restyling these back into plain text, not a pixel.
   */
  check("both doors wear the shared link look", signIn.split("${LINK}").length - 1, 2);

  /*
   * **The gate screens do not narrate the implementation at the reader.**
   *
   * `/confirm` is reached from a mail somebody asked for, and it read "Your
   * account does not exist yet. This is the step that creates it." That is true
   * — a pending sign-up is not a `users` row — and it is an internal fact told
   * to somebody who signed up two minutes ago, where it reads as a failure
   * report about the step they already completed. The word on the page, the
   * word on the button and the word in the mail are all "confirm" now, and this
   * pins the phrase rather than the layout because the phrase is what came
   * back. Comments stripped: the docblock explaining the fix quotes it.
   */
  const gateCode = readFileSync(new URL("../src/ui/gate/Gate.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check("no gate screen tells somebody their account does not exist", /does not exist/.test(gateCode), false);
  check("and confirming is called confirming", /Confirm account/.test(gateCode), true);
  // Comments stripped for the same reason `cp.ts`'s pin strips them: the JSX
  // comment names the separator it replaced, and a rule that punishes its own
  // explanation is a rule whose cheapest fix is deleting the explanation.
  const signInCode = signIn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("and they are not one line with a separator", /·/.test(signInCode), false);
  // `bg-fg` is the affirmative action inside a decision. A navigation is not one.
  const bits = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  const linkDecl = /export const LINK = "([^"]*)"/.exec(bits)?.[1] ?? "";
  check("a link carries an underline", /\bunderline\b/.test(linkDecl), true);
  check("and never a fill", /\bbg-/.test(linkDecl), false);

  /*
   * The instance body is **parsed**, and the cast that used to stand in for a
   * parse cannot come back. `readJson<T>` is this client's idiom everywhere and
   * is fine where a body is read field by field; it was fatal here, because the
   * server's shape and `InstanceConfig` are genuinely different and a generic
   * cannot notice. The behavioural half is asserted above against `app.ts`'s own
   * literal; this is the half that stops a future edit reintroducing the shortcut
   * and silently deleting that coverage.
   */
  const cpSource = readFileSync(new URL("../src/cp.ts", import.meta.url), "utf8");
  /*
   * Comments stripped first, and not as tidiness: the docblock on
   * `instanceConfig` **quotes the cast it replaced**, because a comment that
   * cannot name the shape of the bug is a comment nobody can act on. Testing the
   * raw file makes the explanation itself the offender, and the cheap way green
   * would then be to delete the sentence that explains why the rule exists.
   */
  const cpCode = cpSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("the instance config is never cast into its own type", /readJson<InstanceConfig>/.test(cpCode), false);
  check("it goes through the parser", /parseInstanceConfig\(/.test(cpSource), true);
  /*
   * And the Email form has exactly one call that writes the SMTP keys. `save`
   * and the per-field reset both go through `adminSaveSettings`, so the count is
   * of *writers of a draft*, not of calls: what is asserted is that no component
   * in this file owns a draft of a key another component also writes.
   */
  check(
    "and the SMTP fields are held in one draft",
    serverSection.split("useState<SmtpDraft>").length - 1,
    1,
  );

  // The property rather than the rows, so a third group cannot arrive wrong.
  for (const me of [null, plain, admin]) {
    const headings = navRows(me).map((row) => row.heading).filter((heading) => heading !== null);
    check(`a group heads at most one row (${me?.name ?? "nobody"})`, headings.length, new Set(headings).size);
  }
}

/* ------------------------------------------------------------------ *
 * The machine limit
 *
 * Three states for the copy, two for the rule, and the property that binds them:
 * a door is never missing without a sentence saying why. `gateNotice`'s own
 * shape, asserted the same way — because the defect that rule was extracted from
 * was a three-way answer whose call sites all wanted two.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe machine limit\n");
{
  const {
    HARD_MACHINE_CEILING,
    machineBadgeText,
    machineLimitChangeNotice,
    machineLimitProblem,
    machineQuota,
    machineQuotaNotice,
    mayAddMachine,
  } = await import("../src/quota.js");

  const me = (over: Record<string, unknown>): never =>
    ({ id: "u_1", name: "ada", isAdmin: false, ...over }) as never;

  /* ---- the truth table, across every state plus the two absences ---- */

  const CASES: { what: string; me: never | null; kind: string; may: boolean }[] = [
    { what: "no `me` at all", me: null, kind: "unknown", may: true },
    { what: "a control plane that predates the field", me: me({}), kind: "unknown", may: true },
    // `null` and `undefined` collapse together: one is a service with no
    // opinion, the other one that has never heard of the question, and no screen
    // does anything different about them.
    { what: "an explicit no-limit", me: me({ machineCount: 2, machineLimit: null }), kind: "unknown", may: true },
    {
      what: "room to spare",
      me: me({ machineCount: 0, machineLimit: 2, canAddMachine: true }),
      kind: "room",
      may: true,
    },
    {
      what: "one slot left",
      me: me({ machineCount: 1, machineLimit: 2, canAddMachine: true }),
      kind: "room",
      may: true,
    },
    {
      what: "exactly at the limit",
      me: me({ machineCount: 2, machineLimit: 2, canAddMachine: false }),
      kind: "full",
      may: false,
    },
    {
      what: "past it, which is what a lowering looks like",
      me: me({ machineCount: 3, machineLimit: 2, canAddMachine: false }),
      kind: "full",
      may: false,
    },
    {
      what: "a limit of zero and nothing owned",
      me: me({ machineCount: 0, machineLimit: 0, canAddMachine: false }),
      kind: "none",
      may: false,
    },
    {
      what: "a limit of zero lowered onto machines they had",
      me: me({ machineCount: 1, machineLimit: 0, canAddMachine: false }),
      kind: "none",
      may: false,
    },
  ];

  for (const one of CASES) {
    check(`${one.what}: kind`, machineQuota(one.me).kind, one.kind);
    check(`${one.what}: may add`, mayAddMachine(one.me), one.may);
  }

  /*
   * **The invariant, and the reason the notice carries no "2 of 5" line while
   * there is room** — that would break it, and a progress readout is a second
   * function's job.
   *
   * ⭐ **Over a generated cross-product rather than over `CASES`, and the
   * difference is the whole assertion.** Written as a `.map` over the table
   * above it could not fail: every entry there carries a `canAddMachine` that
   * agrees with its own two numbers, because every entry describes a shape the
   * control plane actually sends. So the property was asserted over exactly the
   * inputs on which the two functions cannot disagree — and they read different
   * fields, which is the only reason there is a property here at all.
   *
   * The counterexample was already in this file, twelve lines below, built for
   * the `canAddMachine` check and never fed to the iff:
   * `{machineCount: 0, machineLimit: 5, canAddMachine: false}` hid the door and
   * drew no sentence. `{machineCount: 5, machineLimit: 5, canAddMachine: true}`
   * was the mirror — a door *and* a sentence saying it was full.
   *
   * `null` and `undefined` are in the limit set because `machineLimit` is
   * `number | null` on the wire and a control plane rolled back past this
   * release sends neither, so both are shapes rather than paranoia.
   */
  for (const machineCount of [0, 1, 2, 3]) {
    for (const machineLimit of [undefined, null, 0, 1, 2, 5]) {
      for (const canAddMachine of [undefined, true, false]) {
        const subject = me({ machineCount, machineLimit, canAddMachine });
        report(
          `a sentence is drawn exactly where the door is not (${machineCount}/${String(machineLimit)}/${String(canAddMachine)})`,
          (machineQuotaNotice(subject) === null) === mayAddMachine(subject),
          `notice ${machineQuotaNotice(subject) === null ? "null" : "sentence"} / may ${mayAddMachine(subject)}`,
        );
      }
    }
  }

  /*
   * The server's own answer wins where there is one, because "somebody at their
   * limit is not offered a way to add more" is the control plane's rule and a
   * client re-deriving it is a second copy. Asserted with the numbers
   * deliberately disagreeing, which is the only way to see which one is read.
   */
  check(
    "`canAddMachine` decides, not the two numbers beside it",
    mayAddMachine(me({ machineCount: 0, machineLimit: 5, canAddMachine: false })),
    false,
  );

  /* ---- the four sentences ---- */

  const noticeOf = (over: Record<string, unknown>): string => machineQuotaNotice(me(over)) ?? "";
  report(
    "a fresh account on a closed instance is told who to ask",
    noticeOf({ machineCount: 0, machineLimit: 0 }).includes("Ask whoever runs this control plane"),
    noticeOf({ machineCount: 0, machineLimit: 0 }),
  );
  report(
    "and one whose machines just went dark is told they went dark",
    noticeOf({ machineCount: 2, machineLimit: 0 }).includes("stopped working"),
    noticeOf({ machineCount: 2, machineLimit: 0 }),
  );
  report(
    "at the limit, the count is in the sentence",
    noticeOf({ machineCount: 2, machineLimit: 2 }).includes("all 2 of your 2"),
    noticeOf({ machineCount: 2, machineLimit: 2 }),
  );
  report(
    "over it, one machine is singular",
    noticeOf({ machineCount: 3, machineLimit: 2 }).includes("newest one has"),
    noticeOf({ machineCount: 3, machineLimit: 2 }),
  );
  report(
    "and two are plural",
    noticeOf({ machineCount: 4, machineLimit: 2 }).includes("newest 2 have"),
    noticeOf({ machineCount: 4, machineLimit: 2 }),
  );

  /* ---- the admin's consequence line, which is also whether to confirm ---- */

  check("raising costs nothing and asks nothing", machineLimitChangeNotice("ada", 3, 5), null);
  check("nor does setting it to what it already is", machineLimitChangeNotice("ada", 3, 3), null);
  check("nor does zero when they own nothing", machineLimitChangeNotice("ada", 0, 0), null);
  report(
    "lowering onto two machines says two, and says they come back",
    (machineLimitChangeNotice("ada", 3, 1) ?? "").includes("newest 2 working") &&
      (machineLimitChangeNotice("ada", 3, 1) ?? "").includes("brings them back"),
    machineLimitChangeNotice("ada", 3, 1) ?? "(null)",
  );
  report(
    "and onto one says one",
    (machineLimitChangeNotice("ada", 2, 1) ?? "").includes("newest one working"),
    machineLimitChangeNotice("ada", 2, 1) ?? "(null)",
  );

  /* ---- the validator, shared by both screens ---- */

  check("empty is legal — it hands the value back to the default", machineLimitProblem(""), null);
  // Whitespace alone is the same as empty, which is what every field on the
  // server-settings screen already does with a blank draft: `.trim()` then
  // `clear`. Refusing it would make a stray space look like a malformed number.
  check("and so is a field holding only a space", machineLimitProblem("   "), null);
  // The one that matters: a validator written with a truthiness test refuses
  // precisely the value the whole feature is for.
  check("zero is legal", machineLimitProblem("0"), null);
  check("and so is the ceiling itself", machineLimitProblem(String(HARD_MACHINE_CEILING)), null);
  for (const bad of ["-1", "2.5", "abc", "5 machines"]) {
    report(`"${bad}" is refused`, machineLimitProblem(bad) !== null, String(machineLimitProblem(bad)));
  }
  report(
    "and one past the ceiling names it",
    (machineLimitProblem(String(HARD_MACHINE_CEILING + 1)) ?? "").includes(String(HARD_MACHINE_CEILING)),
    String(machineLimitProblem(String(HARD_MACHINE_CEILING + 1))),
  );

  /* ---- one badge, by precedence ---- */

  check("over the limit outranks not enrolled", machineBadgeText({ overLimit: true, enrolled: false }), "over the limit");
  check("and is the only badge when it applies", machineBadgeText({ overLimit: true, enrolled: true }), "over the limit");
  check("otherwise not-enrolled still draws", machineBadgeText({ overLimit: false, enrolled: false }), "not enrolled");
  check("and an ordinary machine draws nothing", machineBadgeText({ overLimit: false, enrolled: true }), null);
  /*
   * A banned owner outranks the limit, because the remedies differ and only one
   * of them works: retiring a machine does nothing for a machine whose owner is
   * banned, so naming the limit first would send the reader to the wrong act.
   */
  check(
    "a banned owner outranks the limit",
    machineBadgeText({ overLimit: true, ownerDisabled: true, enrolled: true }),
    "owner disabled",
  );
  check(
    "and an absent field degrades to not-banned",
    machineBadgeText({ overLimit: false, enrolled: true }),
    null,
  );

  /*
   * ⭐ **The client's ceiling is the server's**, read out of the control plane's
   * own source rather than transcribed. A number this screen prints in a refusal
   * has to be the number the service enforces.
   */
  const machinesTs = readFileSync(new URL("../../control-plane/src/machines.ts", import.meta.url), "utf8");
  check(
    "the mirrored ceiling is the one `machines.ts` declares",
    Number(/MAX_MACHINES_PER_USER = (\d+)/.exec(machinesTs)?.[1]),
    HARD_MACHINE_CEILING,
  );

  /*
   * ⭐ **The call sites, read off disk — the `gateOffer`/`showsGateLink` defect
   * class.**
   *
   * That rule was lost once by being *asserted* on the pure function while every
   * screen re-derived it at its own call site, and every assertion stayed green.
   * So: each affordance must ask the shared predicate, and must not mention the
   * two numbers it is computed from — and must not count `state.machines`, which
   * is a **different number** (it includes machines granted to you and owned by
   * somebody else, while the limit counts only the ones you own).
   */
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const file of ["ui/SessionBrowser.tsx", "ui/NewSession.tsx", "ui/settings/MachinesSection.tsx"]) {
    const src = strip(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
    check(`${file} asks the shared predicate`, /mayAddMachine\(/.test(src), true);
    check(`${file} never re-derives it from the fields`, /machineLimit|machineCount|canAddMachine/.test(src), false);
    check(`${file} never counts the machine list instead`, /machines\.length\s*>=?\s*[A-Za-z]/.test(src), false);
  }

  /*
   * ⭐ **One writer for the chosen folder, read off disk because the defect was
   * two of them.**
   *
   * `NewSession` holds `cwd` and `DirectoryPicker` holds `path`, and the picker
   * reports up through an effect keyed on its own `path`. So a parent write to
   * `cwd` that the picker did not make is unrecoverable by construction: `path`
   * has not changed, the report never fires again, and `Start` stays disabled
   * over a folder its own footer is naming. Three ordinary routes hit it — the
   * rail's folder `+`, the "re-check" after an inline sign-in, and any change of
   * machine.
   *
   * None of this is reachable from a pure function: it is a race between two
   * effects in one file. What *is* checkable is the shape that makes the race
   * impossible, which is three separate facts and all three were wrong at once.
   */
  {
    const src = strip(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
    // 1. The parent never writes the folder. Only the picker does.
    check("nothing but the picker clears the chosen folder", /setCwd\(null\)/.test(src), false);
    // 2. A machine change is a remount, so the picker's own `path` cannot survive
    //    into a tree it does not belong to.
    check("the picker is keyed on the machine", /<DirectoryPicker\s+key=\{selected\}/.test(src), true);
    // 3. The report is unconditional, so `cwd` mirrors `path` in both directions.
    //    Guarded on non-null it was half a rule, and the half it was missing is
    //    the one that lets the parent hold a folder the picker is not showing.
    check("and reports the absence of a folder too", /if \(path !== null\) onPick/.test(src), false);
    check("reporting it unconditionally instead", /onPick\(path\);/.test(src), true);
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/MachinesSection.tsx", import.meta.url), "utf8"));
    // The form is downstream of the check that it may be offered at all — the
    // `asksMailUsable < promisesReset` idiom one section over.
    report(
      "the add form is downstream of the check that it is offerable",
      src.indexOf("mayAddMachine(") < src.indexOf("<AddMachine"),
      `${src.indexOf("mayAddMachine(")} < ${src.indexOf("<AddMachine")}`,
    );
    /*
     * Creating and retiring a machine move `machineCount`, which is the number
     * the limit is enforced against — and `runResume` refreshes `me` only on a
     * `loading → ready` promotion. Through `resume` alone, the add form stays
     * drawn on the screen that just consumed the last slot.
     *
     * Named per act rather than banning `store.resume(` outright, because
     * renaming a machine legitimately still uses it and moves no count.
     */
    /*
     * ⭐ **A setup code is offered before enrollment and never after**, and this is
     * pinned because the row is one `&&` away from coming back as a tidy-up. The
     * route still allows a re-mint on purpose, so nothing on the server side would
     * fail; what would fail is the reading — "New setup code" on a running host is
     * a menu claiming there is a step left. The cost was measured and accepted:
     * six recovery flows, the fleet's only credential rotation among them, are
     * `cpctl enroll` now. ⚠ Retire-then-Add is not the substitute — new machine id,
     * every grant but the creator's dropped silently. Q3.428.
     *
     * ⚠ **Pinned on `mintEnrollment`, and it used to be pinned on the wording.**
     * That read `/New setup code|Replace setup code/` against *this* file, and
     * both halves were wrong: the block had moved to `MachineSection.tsx`, and
     * neither literal existed anywhere in the tree at either revision — so it was
     * a negative about a file the act had left, naming strings nothing wrote,
     * which is exactly what the note under it warns against. `mintEnrollment` is
     * the call itself. The list may still show the code that `POST /v1/machines`
     * hands back for a machine it just created — that one is by construction not
     * enrolled — but it must never mint a *second* one for a row.
     */
    check("the list never mints a code for a machine already on it", /mintEnrollment/.test(src), false);
    check("adding a machine re-reads who you are", /machinesChanged\("machine-added"\)/.test(src), true);
    /*
     * ⭐ **Retire, rename and the setup code moved onto the machine's own screen**,
     * so the regexes that pin them follow the code rather than the filename — a
     * negative left pointing at the file the act LEFT is worth nothing, which is
     * how this pair would have silently stopped covering the half that moved.
     */
    const machineSrc = strip(
      readFileSync(new URL("../src/ui/settings/MachineSection.tsx", import.meta.url), "utf8"),
    );
    check("a setup code is offered only before a machine has enrolled", /!machine\.enrolled &&/.test(machineSrc), true);
    check("retiring one re-reads who you are too", /machinesChanged\("machine-revoked"\)/.test(machineSrc), true);
    check(
      "neither goes through resume alone",
      /resume\("machine-(added|revoked)"\)/.test(src) || /resume\("machine-(added|revoked)"\)/.test(machineSrc),
      false,
    );
    // A rename moves no count, so it stays on the cheaper call.
    check("a rename still does not", /resume\("machine-renamed"\)/.test(machineSrc), true);
    /*
     * ⚠ And it must leave the screen BEFORE the store drops the machine, or the
     * person reads "That machine is not in your list any more" about the machine
     * they just retired. The only guard on a runtime ordering here. Q3.432.
     *
     * Both operands are checked against `>= 0` first, the same shape as the
     * `App.tsx` ordering pins: a rename makes `indexOf` answer -1, and `-1 < n`
     * is *true*, so an unguarded comparison stays green with the property it
     * guards gone. The two `>= 0` lines fail naming the string that moved.
     */
    const leavesScreen = machineSrc.indexOf("navigate(settingsPath(\"machines\"), true)");
    const dropsMachine = machineSrc.indexOf("machinesChanged(\"machine-revoked\")");
    check("retiring still navigates away from the machine's screen", leavesScreen >= 0, true);
    check("and still tells the store the machine is gone", dropsMachine >= 0, true);
    check(
      "and retiring leaves the screen before the machine leaves the list",
      leavesScreen >= 0 && dropsMachine >= 0 && leavesScreen < dropsMachine,
      true,
    );
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/UsersSection.tsx", import.meta.url), "utf8"));
    check("the admin panel validates with the shared rule", /machineLimitProblem\(/.test(src), true);
    check("and states the consequence before lowering", /machineLimitChangeNotice\(/.test(src), true);
    /*
     * **Whether to confirm is that function's answer**, not a `<` in the JSX.
     * Written inline it would be a rule with nothing to test and an off-by-one
     * to get wrong in a second place.
     */
    check(
      "and the decision to confirm is that function's answer",
      /consequence\s*===\s*null\s*\?/.test(src) && /consequence\s*=\s*dirty\s*\?\s*machineLimitChangeNotice\(/.test(src),
      true,
    );
    // `DangerButton`'s glyph is reserved for the irreversible, and this undoes
    // itself the moment the number goes back up.
    check("lowering is not dressed as irreversible", /DangerButton[\s\S]{0,200}Save limit/.test(src), false);
  }

  {
    const src = strip(readFileSync(new URL("../src/ui/settings/ServerSection.tsx", import.meta.url), "utf8"));
    check("the settings key is named once, not written out", /"machines\.per_user"/.test(src), false);
    report(
      "and reached through the shared constant",
      src.split("MACHINE_LIMIT_KEY").length - 1 >= 4,
      `${src.split("MACHINE_LIMIT_KEY").length - 1} uses`,
    );
    /*
     * An admin is subject to the limit they just changed, so saving one has to
     * re-read their own quota — otherwise setting the default to 0 leaves their
     * own `+` drawn for the life of the tab, onto a `409`.
     */
    check("saving a server setting re-reads the admin's own quota", /refreshMe\(\)/.test(src), true);
  }
}

/* ------------------------------------------------------------------ *
 * Importing a codebase
 *
 * Two of these are about a rule that has no runtime symptom until it is somebody
 * else's machine that breaks. The daemon's route is new, and the client shipping
 * inside the control plane's image means *new client against old daemon* is the
 * ordinary state of this fleet rather than an edge — so the shape of that answer,
 * a 404 with no error envelope, has to keep its own sentence. And `DAEMON_VERSION`
 * may not be read to predict it: rule 1 of `compatibility.md` is that a version is
 * negotiated or it is a label, and this one is a label.
 *
 * The rest are the drag-and-drop invariant nobody discovers by reading — `drop`
 * simply never fires without a `preventDefault` on `dragover` — and the promise
 * the skill text makes to the extractor. Those two drift apart silently: the skill
 * telling somebody to include `.git` would produce an archive refused whole, and
 * the only symptom is a 400 at the end of a five-minute export.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * A sign-in that is not offered
 *
 * The daemon decides — `loginBlockedReason` knows the platform and the flow's
 * shape — and the client's job is to draw the remedy rather than an empty space.
 * Before this, `canSignIn === false` rendered `null`: no button, no sentence, and
 * a credential slot with no account of why it was the only thing there.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Saving a credential while a chat is open
 *
 * A credential reaches an agent only at spawn, so a token saved mid-conversation
 * used to change nothing for the chat in front of you — the badge went green and
 * the messages went on failing to authenticate. The daemon relaunches those
 * sessions now and reports how many; this is the half that says so.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * A re-probe is not the host going away
 *
 * `resumeMachine` forgets the route on every wake — a route learned on one
 * network says nothing on another — so a healthy machine was re-probed every time
 * the tab came back. `probeRoute` published `probing` before any I/O and `online`
 * up to 1.5s later, and everything keyed on `reach` changed twice for a question
 * whose answer never changed: every machine row's dot went hollow and back, and
 * the agents panel *unmounted and remounted*, restarting `useAgentAuth` from
 * nothing — a spinner, a second `GET /agent-auth` that shells out to every CLI,
 * and any half-typed credential thrown away. Once per tab switch.
 *
 * `.claude/rules/web-shell.md` already states this rule for the rail: reachability
 * flickers, so a row may not change because of it. These screens are the two that
 * legitimately *show* reachability, and showing it is still not a reason to take
 * the content away while asking.
 * ------------------------------------------------------------------ */

process.stdout.write("\na re-probe is not the host going away\n");
{
  const { daemonReadable } = await import("../src/machine.js");
  const mach = stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"));
  const panel = stripComments(
    readFileSync(new URL("../src/ui/settings/MachineAgentsSection.tsx", import.meta.url), "utf8"),
  );

  // All four, because the interesting one is `probing` and a predicate over a
  // union is only asserted by walking it.
  check("a machine that answered is readable", daemonReadable("online"), true);
  check("and one being re-checked still is", daemonReadable("probing"), true);
  check("one that did not answer is not", daemonReadable("offline"), false);
  check("nor is one never asked", daemonReadable("unknown"), false);

  /*
   * The root fix, and the one that covers every other screen: a probe of a
   * machine already believed reachable does not publish `probing` at all.
   * `unknown` is still the value for never having asked.
   */
  check("a re-probe keeps a known-online state", /if \(this\.reach !== "online"\) this\.reach = "probing";/.test(mach), true);
  check("and does not overwrite it unconditionally", /^\s*this\.reach = "probing";$/m.test(mach), false);

  check("the agents panel asks the predicate", /!daemonReadable\(machine\.reach\)/.test(panel), true);
  check("rather than treating a measurement as an outage", /machine\.reach !== "online"/.test(panel), false);
}

process.stdout.write("\nsaving a credential while a chat is open\n");
{
  const { credentialToast } = await import("../src/ui/settings/AgentsPanel.js");

  check("one chat is singular", credentialToast(false, 1), "Saved. 1 chat is restarting to pick it up.");
  check("and several are not", credentialToast(false, 3), "Saved. 3 chats are restarting to pick it up.");
  check("removing says removed", credentialToast(true, 2), "Removed. 2 chats are restarting to pick it up.");
  check("nothing to restart keeps the old sentence", credentialToast(false, 0), "Saved. Checking whether it works…");
  /*
   * **`undefined` is not zero.** A daemon predating this omits the field, and
   * "0 chats" there would be a confident claim about behaviour it does not have —
   * the same rule `wire.ts` states for every narrowing in it.
   */
  check("and a daemon that does not say is not read as zero", credentialToast(false, undefined), "Saved. Checking whether it works…");
}

process.stdout.write("\na sign-in that is not offered\n");
{
  const panel = stripComments(readFileSync(new URL("../src/ui/settings/AgentsPanel.tsx", import.meta.url), "utf8"));
  const { stanceLine, osName } = await import("../src/ui/agentCard.js");

  /*
   * **One sentence, and it names the system.** "This machine can't run…" reads as
   * something misconfigured on your box; the truth is that the OS cannot hand a
   * background service the terminal this login needs. The refusal is returned for
   * every BSD, so the name comes from the daemon — a hardcoded "macOS" would tell
   * a FreeBSD operator something false in the one sentence meant to absolve them.
   */
  check("the sentence names the system", stanceLine("claude", "signed_out", false, "darwin"), "macOS can't run Claude's own sign-in, so a saved key is the only way in.");
  check("and a different BSD gets its own name", osName("freebsd"), "FreeBSD");
  check("while a daemon that does not say names nothing", osName(undefined), "This machine");
  check("a wizard that can run says nothing at all", stanceLine("claude", "signed_out", true, "darwin"), null);
  check("and the panel passes the platform through", /stanceLine\(agent\.id, stance, canSignIn, os\)/.test(panel), true);

  /*
   * **The command sits on the field it fills.** It was a paragraph above the
   * divider, which restated the sentence above it and then said "paste the token
   * below" with a heading and two inputs in between.
   */
  check("the command is rendered inside the credential slot", /howTo !== null && editable && <SetupTokenCommand/.test(panel), true);
  check("and only on the slot that command actually fills", /slot\.envName === "CLAUDE_CODE_OAUTH_TOKEN"/.test(panel), true);
  check("and only where the wizard cannot run", /login\.blocked === "interactive_pty"/.test(panel), true);
  check("naming the command the CLI really has", /"claude setup-token"/.test(panel), true);
  /*
   * A row of two, not a control laid over a box: the overlay took its height from
   * the field's own text and hung off the edge the moment the two disagreed.
   */
  check("the copy control is a sibling of the field, not an overlay on it", /items-stretch/.test(panel), true);
  check("so it cannot be positioned out of the box it belongs to", /SetupTokenCommand[\s\S]{0,900}absolute top-/.test(panel), false);
  check("the button is still gated on supported, not on the reason", /login\.supported && agent\.available/.test(panel), true);

  /*
   * **The key row is shorter only where there is no tap floor to miss.**
   * `FIELD`'s `py-3` exists because `index.css` forces 16px on an input under a
   * coarse pointer — iOS zooms the page otherwise — and at `py-2` the box measures
   * ~39px against 44px. Shrinking it unconditionally would have traded a tidier
   * desktop row for a target under the floor on the device this product is shaped
   * around, and nothing would have said so.
   */
  /*
   * **Two boxes that line up, held to one number rather than to arithmetic.**
   *
   * The first attempt wrote `` `${FIELD} py-2` `` and did nothing at all: Tailwind
   * emits every utility at equal specificity, `.py-3` is emitted after `.py-2`, so
   * the constant won and the field stayed 10px deeper than the command box above
   * it — with no error, and with the code and the review both saying otherwise.
   * That is the same trap `Button` documents for a size passed via `className`,
   * and it is why the short field is a constant of its own.
   */
  {
    const bits = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
    /*
     * **One height for every single-line control in the app**, and it is stated
     * rather than arrived at: `py-3` only ever reached 44px by multiplying with a
     * line-height that lives in the type scale, so the rendered height was a
     * coincidence between two files and two controls could differ by 10px with
     * nothing anywhere naming a number.
     */
    check("the field constant states its height", /export const FIELD =\s*\n?\s*"min-h-9/.test(bits), true);
    check("and carries no padding for a caller to lose to", /export const FIELD =\s*\n?\s*"[^"]*\bpy-\d/.test(bits), false);
    check("with the touch floor written down beside it", /export const FIELD =[\s\S]{0,240}\[@media\(pointer:coarse\)\]:min-h-11/.test(bits), true);
    check("and no second field constant to drift from it", /FIELD_SM/.test(bits), false);

    check("the key field uses the standard one", /\$\{FIELD\} min-w-0 flex-1 font-mono/.test(panel), true);
    /*
     * The general form of the defect, not this one instance of it: composing
     * `FIELD` with a vertical padding is always a no-op and always silent.
     */
    /*
   * The general form of the defect rather than this one instance: composing
   * `FIELD` with a vertical padding is always a no-op and always silent, so it is
   * checked across every screen that draws a field, not just this one.
   */
  {
    const withFields = readdirSync(new URL("../src/ui/settings/", import.meta.url))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(new URL(`../src/ui/settings/${f}`, import.meta.url), "utf8"));
    for (const extra of ["SignIn.tsx", "ForcedPasswordChange.tsx", "gate/Gate.tsx", "gate/GateCard.tsx"]) {
      withFields.push(readFileSync(new URL(`../src/ui/${extra}`, import.meta.url), "utf8"));
    }
    const offenders = withFields.filter((src) => /\$\{FIELD\}[^`]*\bpy-\d/.test(src)).length;
    report("no screen composes FIELD with a padding that cannot win", offenders === 0, `${withFields.length} files scanned`);
  }
    check("the command box states the same height", /flex min-h-9 items-stretch/.test(panel), true);
    check("and the same floor, so the two cannot drift", (panel.match(/\[@media\(pointer:coarse\)\]:min-h-11/g) ?? []).length >= 2, true);
  }
  // Width is the other fields', which is what it was before a wrong axis was tried.
  check("and its width is left alone", /max-w-80/.test(panel), false);

  /*
   * **The row is tightened, and Remove keeps the space it actually needs.** Its
   * `after:-inset-2.5` target reaches 10px past its own face, so at an 8px gap it
   * lands on the control to its left — the defect the old blanket `gap-3` was
   * carrying for all three children. Tightening without putting that 4px back on
   * Remove would have reintroduced it silently, on a destructive button.
   */
  /*
   * **Remove keeps the room its own target needs, and only it.** Its
   * `after:-inset-2.5` reaches 10px past its face, so at an 8px gap it lands on
   * the control to its left — which is why the row carried `gap-3` for all three
   * children. Tightening the field and Save without putting that 4px back on
   * Remove reintroduces it silently, on a destructive button.
   */
  check("the field and Save sit closer", /mt-3 flex gap-2/.test(panel), true);
  check("and Remove carries the room its own target needs", /tone="destructive"[\s\S]{0,220}className="ml-1"/.test(panel), true);
  check("with Save wide enough to hold its label", /min-w-20/.test(panel), true);
}

process.stdout.write("\nimporting a codebase\n");
{
  const src = stripComments(readFileSync(new URL("../src/ui/ImportCode.tsx", import.meta.url), "utf8"));
  const picker = stripComments(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
  const client = stripComments(readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8"));

  const { importFailure } = await import("../src/ui/ImportCode.js");
  const { ApiError } = await import("../src/http.js");
  const envelope = (status: number, code: string, detail: unknown = null): unknown =>
    new ApiError(status, code, "refused", detail, { error: { code, detail } });
  /** What `parseBody` makes of a response carrying no envelope at all. */
  const bare = (status: number): unknown =>
    new ApiError(status, `http_${status}`, "Not Found", null, null);

  check(
    "a daemon with no such route is named as old rather than shown a 404",
    importFailure(bare(404)).includes("too old"),
    true,
  );
  /*
   * **The 404 has to be asked for before the archive moves**, because it does not
   * survive one. Measured through a real relay against a daemon predating this
   * route: the same request that answers a clean 404 with an empty body came back
   * `502 tunnel_failed` after 3.4 MB of a 5 MiB upload — the daemon refuses
   * without draining the body, its end of the stream dies, and the relay reports
   * the only thing it can see. So the sentence above was unreachable in exactly
   * the case it exists for, and the ordering is what makes it reachable.
   */
  check("the route is probed before any bytes are sent", /importSupported\(\)/.test(src), true);
  check(
    "and the upload only starts once that has answered",
    src.indexOf("importSupported()") < src.indexOf("importArchive("),
    true,
  );
  check(
    "with the probe carrying no body of its own",
    /await this\.machine\.request\("\/fs\/import", \{ method: "POST" \}\)/.test(client),
    true,
  );
  // A tunnel can still die for its own reasons, so the code keeps a sentence.
  check(
    "and a stream that dies mid-upload still says something actionable",
    importFailure(envelope(502, "tunnel_failed")).includes("Try again"),
    true,
  );
  check(
    "and a 404 that *is* this system's own is not",
    importFailure(envelope(404, "not_found")).includes("too old"),
    false,
  );
  check(
    "nothing reads the daemon's version to decide that",
    /DAEMON_VERSION|daemonVersion/.test(src),
    false,
  );
  check(
    "a name collision says which name",
    importFailure(envelope(409, "import_exists", { name: "my-app" })).includes("my-app"),
    true,
  );
  check(
    "and survives a detail that is not the shape it expected",
    typeof importFailure(envelope(409, "import_exists", "nonsense")),
    "string",
  );
  for (const code of ["archive_unsafe", "unsupported_archive", "import_busy", "import_too_large"]) {
    check(`${code} draws a sentence of its own`, importFailure(envelope(400, code)) !== code, true);
  }

  /*
   * What somebody is asked to paste reads their repository and writes files, so
   * it is shown rather than described. A copy button alone asks them to take that
   * on trust, and it is the failure with no symptom: nobody reports a block of
   * text they were never offered.
   */
  check("the text being copied is rendered, not only put on the clipboard", /\{IMPORT_SKILL\}/.test(src), true);
  check("in a box that scrolls on its own", /overflow-y-auto/.test(src), true);
  check("without dragging the sheet behind it when it ends", /overscroll-contain/.test(src), true);
  check("and the control over it carries an icon rather than a word", /as=\{Copy\}/.test(src), true);
  /*
   * **Both glyphs are mounted and swapped by opacity**, never rendered one at a
   * time. A conditional would snap, and the tick going out is the half that
   * carries the meaning: it says the confirmation expired rather than that the
   * state was lost. Asserted as the pair, because rendering one of them
   * conditionally still passes any test that only looks for `Check`.
   */
  check("the tick is mounted beside it rather than swapped in", /as=\{Check\}/.test(src), true);
  check("and neither is drawn conditionally", !/\{copied \? <Icon|copied \? \(/.test(src), true);
  check("they cross-fade instead", (src.match(/transition-opacity/g) ?? []).length >= 2, true);
  /*
   * The tick reverts. It used to be permanent — set on success and never unset —
   * so a screen left open claimed a clipboard that had long since moved on.
   */
  check("and it takes itself down again", /setCopied\(false\), 1400\)/.test(src), true);
  check("with the name following it, for anybody who cannot see either glyph", /aria-label=\{copied \? "Copied" : "Copy to clipboard"\}/.test(src), true);
  /*
   * Set from the *result* this lit the tick on an origin where the clipboard is
   * absent rather than refused — which is every LAN address this app is read on.
   * See `clipboard.ts`, which exists for that measurement.
   */
  check("and it is only ever lit on a copy that worked", !/setCopied\(ok\)/.test(src), true);

  /*
   * **"Machine" is a word this screen has already spent**, and the instructions
   * may not spend it again on something else. There is a machine picker on the
   * form behind this sheet, a Machines section in settings, and an `m_…` on every
   * row — all of them meaning *an enrolled host in your fleet*, which is where an
   * import is going. The source is the opposite end, so "paste this into a coding
   * agent on that machine" read as the machine you had just selected.
   *
   * The *refusals* are deliberately not checked: those say "machine" correctly,
   * about the daemon that answered. The rule is about the instructions alone.
   */
  {
    const steps = [...src.matchAll(/\stext="([^"]*)"/g)].map((m) => m[1] ?? "");
    const intro = /<p className="text-sm text-muted">([^<]*)<\/p>/.exec(src)?.[1] ?? "";
    const lines = [intro, ...steps].filter((line) => line.length > 0);
    report(
      "the instructions never call the source a machine",
      lines.length >= 4 && lines.every((line) => !/machine/i.test(line)),
      `${lines.length} lines checked`,
    );
    check("naming the project instead, which cannot be one", /that project/.test(steps.join(" ")), true);
  }

  // Without this the browser refuses the drop and nothing fires at all — the one
  // bug in a drop target that looks like the handler was never wired.
  check("dragover preventDefaults, or drop never fires", /onDragOver=\{[\s\S]*?preventDefault\(\)/.test(src), true);
  check("and the drop target is the body rather than the box alone", /onDrop=\{/.test(src), true);

  // The folder is drawn from the daemon's answer, never from the file that was
  // sent: an import that fails must not leave a folder named on the screen.
  check("the picker is moved to the path the daemon answered", /onImported\(answer\.import\.path\)/.test(src), true);
  check("and only after it has answered", /onImported\([^)]*\)[\s\S]{0,200}\.catch/.test(src), true);

  check("the control sits in the picker beside New folder here", /Import code/.test(picker), true);
  check("and does not wear the affirmative action's fill", /Import code[\s\S]{0,200}bg-fg/.test(picker), false);
  {
    // 44px, like the sibling whose row it shares: the two swap places with the
    // create form's buttons, and a shorter row makes the panel jump.
    const control = /<button[^>]*onClick=\{\(\) => setImporting\(true\)\}[\s\S]*?>/.exec(picker)?.[0] ?? "";
    check("and clears 44px like the control beside it", /min-h-11/.test(control), true);
  }

  {
    const { IMPORT_SKILL } = await import("../src/importSkill.js");
    const { safeMemberPath } = await import("../../../src/archive.js");
    /*
     * The skill and the extractor have to agree, and `.git` is the one where
     * disagreeing is expensive: `safeMemberPath` refuses the whole archive rather
     * than trimming the member, so a skill that packed one would produce a file
     * that always fails, at the end of the slowest step.
     */
    check("the extractor refuses .git", safeMemberPath("app/.git/config").ok, false);
    check("and the skill says so rather than leaving it to be discovered", /Exclude \.git/.test(IMPORT_SKILL), true);
    check("the skill asks for one top-level folder", /\*\*one\*\* folder named after/.test(IMPORT_SKILL), true);
    check("and names a size the daemon will actually take", /under 50 MB/.test(IMPORT_SKILL), true);
    /*
     * **It names no agent and no path.** The machine on the other end is the
     * customer's, running whatever they run; a skill directory from one vendor
     * is a first step that fails before any work starts. What step one has to
     * be is a single paste that any agent can act on as it stands.
     */
    check("the skill names no vendor path", !/\.claude\//.test(IMPORT_SKILL), true);
    check("and no agent by name", !/Claude Code|Cursor|Copilot/.test(IMPORT_SKILL), true);
    check("it is runnable as pasted, with the skill file optional", /If your agent keeps skills/.test(IMPORT_SKILL), true);
  }
}

/* ------------------------------------------------------------------ *
 * The marker an ordered list was written with
 *
 * `1)` and `1.` are both CommonMark and mdast records neither — a `list` node
 * carries `ordered`, `start` and `spread`, and the character is gone. So a message
 * saying `1)` was drawn `1.`, which is the app rewriting the one text it has no
 * business rewriting.
 *
 * Driven against hand-built trees rather than a real parse, deliberately: what the
 * plugin *is* is a rule about `position.start.offset` into the source, and feeding
 * it a tree it did not parse is what makes the offsets a claim rather than a
 * coincidence. The shape it walks is asserted against the real remark in the
 * transcript's own rendering, which no offline driver can reach.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhich lists keep their delimiter\n");
{
  const { remarkListDelimiter, PAREN_LIST } = await import("../src/ui/mdlist.js");
  const classOf = (node: Record<string, unknown>): unknown =>
    (node["data"] as { hProperties?: { className?: unknown } } | undefined)?.hProperties?.className;
  const list = (offset: number, ordered = true): Record<string, unknown> => ({
    type: "list",
    ordered,
    position: { start: { offset } },
    children: [],
  });
  const run = (source: string, tree: Record<string, unknown>): Record<string, unknown> => {
    remarkListDelimiter()(tree, { value: source });
    return tree;
  };

  check("a paren list is marked", classOf(run("1) a", list(0))), [PAREN_LIST]);
  check("a dotted one is not", classOf(run("1. a", list(0))), undefined);
  check("and a bullet list is not, whatever follows it", classOf(run("- a", list(0, false))), undefined);

  // The offset points at the digit, never at the indentation before it — measured
  // against this repo's own remark-parse, and the pattern has no leading `\s*`
  // because of it. A tree whose offset lands elsewhere must mark nothing rather
  // than guess.
  check("an offset that is not on a marker marks nothing", classOf(run("  1) a", list(0))), undefined);
  check("and the real offset does", classOf(run("  1) a", list(2))), [PAREN_LIST]);

  // CommonMark's own ceiling is nine digits. Ten is not a list at all, and the
  // pattern must not match one anyway.
  check("nine digits is still a list marker", classOf(run("123456789) a", list(0))), [PAREN_LIST]);
  check("ten is not", classOf(run("1234567890) a", list(0))), undefined);

  // Nested lists are reached: the walk is over `children`, not over the root's
  // own arms, and a `1)` inside a bullet is the ordinary way people write one.
  {
    // 6 is where the `1` sits in `- x\n  1) a`, which is what remark records —
    // the digit, never the indentation before it.
    const nested = list(6);
    const root = { type: "root", children: [{ type: "listItem", children: [nested] }] };
    run("- x\n  1) a", root as never);
    check("a nested list is reached", classOf(nested), [PAREN_LIST]);
  }

  // A node with no position is what a synthesized tree looks like. It must be
  // skipped rather than read out of the source at offset 0.
  check("a node with no position is left alone", classOf(run("1) a", { type: "list", ordered: true })), undefined);
}

/* ------------------------------------------------------------------ *
 * Which way a navigation goes
 *
 * The rule behind the slide, and it lives outside `router.ts` because that file
 * reads `window.location` in its module body and cannot be imported here at all.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a navigation moves\n");
{
  const { depthOf, isSheet, navMove } = await import("../src/nav.js");
  const home = { name: "home" } as never;
  const session = { name: "session", ref: { machineId: "m", sessionId: "s" } } as never;
  const other = { name: "session", ref: { machineId: "m", sessionId: "t" } } as never;
  const gate = { name: "gate", screen: "register" } as never;
  const index = { name: "settings", section: null, machineId: null, agent: null, plugin: null } as never;
  const account = { name: "settings", section: "account", machineId: null, agent: null, plugin: null } as never;
  const users = { name: "settings", section: "users", machineId: null, agent: null, plugin: null } as never;
  const machines = { name: "settings", section: "machines", machineId: null, agent: null, plugin: null } as never;
  const oneMachine = { name: "settings", section: "machines", machineId: "m", agent: null, plugin: null } as never;
  const oneAgent = { name: "settings", section: "machines", machineId: "m", agent: "claude", plugin: null } as never;
  const onePlugin = { name: "settings", section: "machines", machineId: "m", agent: null, plugin: "board" } as never;

  check("opening a conversation pushes a screen", navMove(home, session), "push");
  check("and leaving it pops one", navMove(session, home), "pop");

  /*
   * **Inside a sheet the sheet moves, not the screen behind it.** Tapping a
   * section used to replace the panel's contents where they stood, which is the
   * teleport the horizontal slide exists to remove — one layer in from the one it
   * was first written for.
   */
  check("tapping a section pushes inside the sheet", navMove(index, account), "section-push");
  check("and Back pops inside it", navMove(account, index), "section-pop");
  check("a machine's agents are deeper still", navMove(machines, oneMachine), "section-push");
  check("and one agent deeper again", navMove(oneMachine, oneAgent), "section-push");
  check("walking back up pops each time", navMove(oneAgent, oneMachine), "section-pop");
  /*
   * Plugins are the second list under a machine and sit at the *same* depths as
   * agents, so the sheet moves the same way into and out of both. Asserted rather
   * than assumed, because `depthOf` decides it with two tests that could easily
   * have been written as one — and one of them would have made every navigation
   * into a plugin's settings `null`, i.e. a teleport.
   */
  check("a machine's plugins are the same depth as its agents", navMove(oneMachine, onePlugin), "section-push");
  check("and walking back out pops", navMove(onePlugin, oneMachine), "section-pop");
  check("switching between the two lists moves nothing", navMove(oneAgent, onePlugin), null);

  /*
   * **Closing goes down, opening does not go anywhere.** The enter is
   * `SHEET_PANEL`'s own `animate-sheet` — CSS, on mount, on every engine — so a
   * transition here as well would animate one panel twice.
   */
  check("closing a sheet takes it down", navMove(account, session), "sheet-close");
  check("from any depth", navMove(oneAgent, home), "sheet-close");
  check("but opening one is CSS's job", navMove(session, index), null);
  check("from a session or from home", navMove(home, account), null);

  /*
   * The `null` arms are the load-bearing ones: each is a place motion would be
   * wrong rather than merely absent. Session → session is what a desktop rail
   * does all day and has no direction in it.
   */
  check("moving between two conversations moves nothing", navMove(session, other), null);
  check("nor does the same one twice", navMove(session, session), null);
  check("nor two sections at the same depth", navMove(account, users), null);
  check("a gate screen is beside the sign-in form, not past it", navMove(home, gate), null);

  // The two stacks are never compared, which is what `isSheet` is asked first for.
  check("a sheet is a sheet whatever its depth", [isSheet(index), isSheet(oneAgent)], [true, true]);
  check("and a screen is not", [isSheet(home), isSheet(session)], [false, false]);
  check("the four sheet depths are the four screens", [depthOf(index), depthOf(account), depthOf(oneMachine), depthOf(oneAgent)], [1, 2, 3, 4]);
  // `/new` has one screen, so nothing inside it can move.
  check("and a picker has one", depthOf({ name: "new", machineId: null, cwd: null } as never), 1);

  /*
   * **The half of the slide that is not a function, and all three of its defects
   * were invisible to every driver here.**
   *
   * `navMove` decides *which* movement; `index.css` decides what a movement does,
   * and each of these was reported by somebody looking at a phone rather than
   * caught by anything in this process.
   *
   * **A width gate has to out-specify what it gates.** `@media` adds no
   * specificity, so `@media (min-width: 64rem) { ::view-transition-old(root) }` —
   * one pseudo-element, `(0,0,1)` — silently lost to
   * `:root[data-nav="push"]::view-transition-old(root)` at `(0,2,1)`, and the
   * desktop kept every animation it was written to be exempt from. Measured at
   * 1280px with `document.getAnimations()`: `nav-enter` and `nav-under` running
   * on the root pair. `prefers-reduced-motion` at the foot of the file had the
   * identical hole. So the invariant is the one that makes the class of bug
   * impossible rather than the two instances of it: **every view-transition rule
   * that sets an animation is keyed on `data-nav`**, which puts them all at one
   * specificity where source order — the thing a reader can actually see —
   * decides. A rule that sets anything else (`mix-blend-mode`, `z-index`) is not
   * scanned, because nothing overrules those by width.
   */
  const transitionCss = readFileSync(new URL("../src/index.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const animatingSelectors = [...transitionCss.matchAll(/([^{}]*::view-transition-[^{}]*)\{([^}]*)\}/g)]
    .filter((rule) => /animation\s*:/.test(rule[2] ?? ""))
    .flatMap((rule) => (rule[1] ?? "").split(",").map((one) => one.trim()))
    .filter((one) => one.length > 0);
  check("there are view-transition animations to check at all", animatingSelectors.length > 8, true);
  check(
    "and every one is keyed on data-nav, so a width gate can overrule it",
    animatingSelectors.filter((one) => !one.startsWith(":root[data-nav")),
    [],
  );
  // The two that were dead. Named as well as covered by the rule above, because
  // the rule would also pass on a file that had deleted them.
  check(
    "the desktop is exempt from the screen slide",
    /@media \(min-width: 64rem\) \{\s*:root\[data-nav\]::view-transition-old\(root\)/.test(transitionCss),
    true,
  );
  check(
    "and reduced motion from all four",
    /@media \(prefers-reduced-motion: reduce\) \{\s*:root\[data-nav\]::view-transition-old\(root\)/.test(transitionCss),
    true,
  );

  /*
   * **A closing sheet is one object, and the body giving up its name is the whole
   * of it.** A `view-transition-name` does not nest — a named descendant is lifted
   * out of its ancestor's snapshot into a *sibling* group — so with the body named
   * during a close the panel's frame travelled and its contents stood still.
   * Measured at 390px two fifths in: the head and the rounded top had moved and
   * every row inside was where it started. `router.ts` writes `data-nav` before
   * `startViewTransition`, so which elements are their own snapshot is a decision
   * each navigation gets to make.
   */
  check(
    "a closing sheet takes its contents with it",
    /:root\[data-nav="sheet-close"\] \[data-sheet-body\] \{\s*view-transition-name: none;/.test(transitionCss),
    true,
  );
  // …and the section slide still needs the name it gives back, or there is
  // nothing for `nav-enter` to move.
  check(
    "while a section still has a pane of its own to move",
    /\[data-sheet-body\] \{\s*view-transition-name: sheet-body;/.test(transitionCss),
    true,
  );
}

/* ------------------------------------------------------------------ *
 * A message that has been sent and has not come back
 *
 * Drawn in the conversation now rather than under it by the composer, which is
 * what makes it the transcript's business — and keyed by session, which is what
 * makes leaving the conversation mid-send and coming back show it still there.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe message on its way out\n");
{
  const { clearEcho, echoFor, echoVersion, landEcho, setEcho, settleEcho } = await import("../src/echo.js");
  const a = "m/a" as never;
  const b = "m/b" as never;

  check("a session with nothing outstanding has no echo", echoFor(a), null);
  setEcho(a, { text: "hello", seq: Number.MAX_SAFE_INTEGER, attachments: [] });
  check("one that sent something does", echoFor(a)?.text, "hello");
  check("and it is that session's alone", echoFor(b), null);

  /*
   * **The sentinel is what makes the ordinary case work.** Until the daemon names
   * a seq, nothing in the log can be newer — so an unrelated event arriving while
   * `POST /prompt` is still in flight must not clear a message that has not
   * landed yet.
   */
  settleEcho(a, 9_000);
  check("an unrelated event does not settle an unlanded message", echoFor(a)?.text, "hello");

  landEcho(a, 12);
  check("the daemon naming a seq lowers it", echoFor(a)?.seq, 12);
  settleEcho(a, 11);
  check("an earlier event still does not settle it", echoFor(a) !== null, true);
  settleEcho(a, 12);
  check("its own event does", echoFor(a), null);

  /*
   * ⚠ **The race that made this a store method rather than a call from the
   * composer.** `prompt` is on the 90-second slow-route budget and resumes a
   * terminal session first, while the `prompt` event comes down a socket waiting
   * for nothing — so the event routinely wins. `settleEcho` has already compared
   * it against the sentinel and quite correctly kept the echo, and `landEcho`
   * must not then resurrect a message the transcript is already drawing.
   */
  setEcho(b, { text: "again", seq: Number.MAX_SAFE_INTEGER, attachments: [] });
  clearEcho(b);
  landEcho(b, 40);
  check("a seq arriving after the log caught up resurrects nothing", echoFor(b), null);

  // The snapshot has to move, or `useSyncExternalStore` never re-reads.
  {
    const before = echoVersion();
    setEcho(b, { text: "x", seq: 1, attachments: [] });
    check("writing one is a change subscribers can see", echoVersion() > before, true);
    const written = echoVersion();
    clearEcho(b);
    check("and so is clearing it", echoVersion() > written, true);
    const cleared = echoVersion();
    clearEcho(b);
    check("but clearing nothing is not", echoVersion(), cleared);
  }
}

/* ------------------------------------------------------------------ *
 * The words a turn ends in
 *
 * Three places drew a wire identifier with its underscores taken out — `turn
 * cancelled`, `pump failed`, `ended: agent_exited` — at somebody reading their own
 * conversation to find out what happened to it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a turn says when it stops\n");
{
  const { resolvedByText, stopReasonText } = await import("../src/ui/tail.js");
  /*
   * Every member of `AnswerResolvedBy` except `client`, which never reaches the
   * caller — the answer beside it already says who. Written out rather than
   * derived, because a union cannot be enumerated at runtime and the point of the
   * assertion is that **none of them falls through to the identifier**.
   */
  const every = [
    "agent_withdrew",
    "agent_gone",
    "session_stopped",
    "turn_ended",
    "pump_failed",
    "no_turn",
    "turn_cancelled",
  ] as const;
  check(
    "no reason a question was taken away is drawn as its identifier",
    every.filter((by) => resolvedByText(by) === by.replace(/_/g, " ")),
    [],
  );
  check("and the one somebody did says who did it", resolvedByText("turn_cancelled"), "you stopped the turn");
  // Legible, and never a guess: a daemon newer than this client sends a member
  // that is not in the table, and the honest answer is what the whole thing used
  // to be.
  check("an unknown one keeps the old rendering", resolvedByText("some_new_reason" as never), "some new reason");

  /*
   * `end_turn` is filtered by `showsInTranscript` and never reaches this, so the
   * three that do are all turns that did not get where they were going — plus
   * `cancelled`, which is the only one somebody *did* and the only one drawn red.
   */
  check("a cancelled turn says one word", stopReasonText("cancelled"), "cancelled");
  const others = ["max_tokens", "max_turn_requests", "refusal"] as const;
  check(
    "and the rest say what happened rather than naming a constant",
    others.filter((reason) => stopReasonText(reason).includes(reason)),
    [],
  );
  check("an unknown stop reason is drawn as itself", stopReasonText("weather"), "turn ended: weather");

  /*
   * ⚠ The tint and the shape are `EventList`'s, and the pair is the whole point:
   * a cancelled turn's `turn_end` is its last event, so it lands in the row
   * `WaitingFoot` occupied an instant earlier. Read off disk, because a JSX
   * branch is untestable here by construction.
   */
  const src = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check("a cancel is drawn in the working line's own shape", /stopReason === "cancelled" \?[\s\S]{0,300}WorkingMark still/.test(src), true);
  check("in danger, and it is the only stop reason that is", /stopReason === "cancelled" \?[\s\S]{0,200}text-danger/.test(src), true);
  check("while every other reason stays a centred line", /text-center text-2xs font-medium text-fg[\s\S]{0,120}stopReasonText/.test(src), true);
}

/* ------------------------------------------------------------------ *
 * Which chips ride a message that has not landed
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat an unsent message carries\n");
{
  const { echoAttachments } = await import("../src/attach.js");
  const chip = (state: string, uploadId: string | null) =>
    ({
      localId: `l_${uploadId ?? "x"}`,
      file: null,
      name: `${uploadId ?? "pending"}.png`,
      size: 11,
      mimeType: "image/png",
      state,
      progress: 1,
      uploadId,
      error: null,
      cancel: null,
    }) as never;

  // The same rule `sendableAttachments` applies, and it has to be: what the bubble
  // draws and what the prompt names are one list, or a chip is shown on a message
  // that did not carry it.
  check(
    "only what the daemon has answered for",
    echoAttachments([chip("ready", "u_1"), chip("uploading", null), chip("failed", null)]).map((ref) => ref.uploadId),
    ["u_1"],
  );
  check("carrying what the bubble needs to draw it", echoAttachments([chip("ready", "u_1")])[0], {
    uploadId: "u_1",
    name: "u_1.png",
    mime: "image/png",
    bytes: 11,
    inlined: false,
  });
}

/* ------------------------------------------------------------------ *
 * What a row calls the folder it works in
 *
 * ⚠ Reported from a phone against a pinned row: the title read
 * `…/rends/2026-07-tare-r…` and the line under it `claude · …/rends/2026-07-ta…`
 * — the same absolute path, truncated twice, both of them mostly `/Users/rends`.
 * `folderNames` had already written down why two segments is wrong ("a wall of
 * `Users/rends`") and avoided it for folder *headers* while the rows went on
 * doing it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhere a row says it works\n");
{
  const { displayCwd, shortPath } = await import("../src/paths.js");
  const home = ["/Users/rends"];

  check("a directory under a root loses the root", displayCwd("/Users/rends/2026-07-tare-reemoat", home), "~/2026-07-tare-reemoat");
  check("however deep it is", displayCwd("/Users/rends/a/b/c", home), "~/a/b/c");
  check("and the root itself is the root", displayCwd("/Users/rends", home), "~");
  check("a trailing slash on the root changes nothing", displayCwd("/Users/rends/x", ["/Users/rends/"]), "~/x");

  /*
   * **The longest match wins**, because roots nest. `~/work` says more than `~`
   * about a path under both, and picking the first would make the answer depend
   * on the order a daemon happened to list them in.
   */
  check(
    "the most specific root is the one that is cut",
    displayCwd("/Users/rends/work/api", ["/Users/rends", "/Users/rends/work"]),
    "~/api",
  );
  check("whichever order they arrive in", displayCwd("/Users/rends/work/api", ["/Users/rends/work", "/Users/rends"]), "~/api");

  /*
   * **Two degradations, and both are exactly the old rendering.** `cwd` is not
   * confined, so a session outside every root is ordinary; and an empty list is
   * what an older daemon, an unreachable one and a listing that has not landed
   * yet all look like. Neither may invent a prefix.
   */
  check("a path under no root keeps the old rendering", displayCwd("/opt/thing/api", home), shortPath("/opt/thing/api"));
  check("and so does one with no roots at all", displayCwd("/Users/rends/x", []), shortPath("/Users/rends/x"));
  check("which is still two segments", displayCwd("/Users/rends/x", []), "…/rends/x");
  // A root that is empty or "/" must not turn every path into `~/…`.
  check("an empty root is not a prefix", displayCwd("/Users/rends/x", [""]), "…/rends/x");

  const { sessionLabel } = await import("../src/ui/bits.js");
  const row = (title: string | null, cwd: string) =>
    ({ snapshot: { title, workspace: { requestedCwd: cwd } } }) as never;
  check("an unnamed session is called by where it works", sessionLabel(row(null, "/Users/rends/api"), home), "~/api");
  check("a named one is called by its name", sessionLabel(row("fix the build", "/Users/rends/api"), home), "fix the build");
  /*
   * Defaulted rather than required, and the default is the honest one: every
   * caller that has no roots to hand gets the label this drew before roots
   * existed, rather than a guess about where home is.
   */
  check("and with no roots it is what it always was", sessionLabel(row(null, "/Users/rends/api")), "…/rends/api");

  /*
   * **The row draws the location once.** An unnamed session's *title* already is
   * its directory, so repeating it underneath is one fact twice in a row 40
   * characters wide — which is what the screenshot showed. Read off disk, because
   * the comparison is in JSX.
   */
  const browser = readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8");
  check("the row compares its location against its own label", /const subpath = located === label \? null : located;/.test(browser), true);
  check("and the label is built from the same roots", /sessionLabel\(row, roots\)/.test(browser), true);
}

/* ------------------------------------------------------------------ *
 * Telegram, whose chrome sits over this app's own
 *
 * The mini app draws ✕ Close until the page asks for a back button and ‹ Back
 * once it has — so "Close on the list, Back inside" is one function answering
 * `null` at the root. Everything asserted here is pure; the transport is not
 * reachable offline and is a no-op without it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat Telegram's own control does\n");
{
  const { upFrom } = await import("../src/nav.js");
  const { versionAtLeast, inTelegram } = await import("../src/telegram.js");

  const home = { name: "home" } as never;
  const gate = { name: "gate", screen: "register" } as never;
  const session = { name: "session", ref: { machineId: "m", sessionId: "s" } } as never;
  const index = { name: "settings", section: null, machineId: null, agent: null, plugin: null } as never;
  const account = { name: "settings", section: "account", machineId: null, agent: null, plugin: null } as never;
  const machines = { name: "settings", section: "machines", machineId: null, agent: null, plugin: null } as never;
  const oneMachine = { name: "settings", section: "machines", machineId: "m", agent: null, plugin: null } as never;
  const oneAgent = { name: "settings", section: "machines", machineId: "m", agent: "claude", plugin: null } as never;
  const onePlugin = { name: "settings", section: "machines", machineId: "m", agent: null, plugin: "board" } as never;

  /*
   * **`null` is the answer, not the absence of one.** Telegram has one control:
   * hiding the back button is precisely how ✕ Close appears. So the session list
   * closing the app is this returning `null`.
   */
  check("the session list has nowhere up, which is what draws Close", upFrom(home, "/"), null);
  check("and so does a signed-out screen", upFrom(gate, "/"), null);

  check("a conversation goes back to the list", upFrom(session, "/"), "/");
  // Never `history.back()`: on a cold deep link there is one entry, and in a mini
  // app leaving the app *is* closing it — from a conversation, which is the thing
  // this exists to stop.
  check("from a deep link too, not into history", upFrom(session, "/m/m_1/s/s_1"), "/");

  /*
   * Inside the sheet it walks the same levels the ◀ already walks, and leaves by
   * the same door the ✕ uses — one rule, so the two controls cannot disagree.
   */
  check("a section goes up to the section list", upFrom(account, "/m/m_1/s/s_1"), "/settings");
  check("an agent goes up to its machine", upFrom(oneAgent, "/"), "/settings/machines/m");
  // Two lists under a machine, and each walks one level rather than jumping to
  // the section — the same rule the agent depths keep, which is what stops the
  // ◀ and the ✕ becoming the same control.
  check("a plugin goes up to its machine, like an agent", upFrom(onePlugin, "/"), "/settings/machines/m");
  check("a machine goes up to Machines", upFrom(oneMachine, "/"), "/settings/machines");
  check("and Machines goes up to the list", upFrom(machines, "/"), "/settings");
  // At the index there is no level left inside the sheet, so up leaves it — for
  // whatever it was drawn over, which is what `Sheet`'s own ✕ does.
  check("the settings index leaves the sheet", upFrom(index, "/m/m_1/s/s_1"), "/m/m_1/s/s_1");
  check("onto home when it was opened cold", upFrom(index, "/"), "/");
  check("and so does the new-session sheet", upFrom({ name: "new", machineId: null, cwd: null } as never, "/m/m_1/s/s_1"), "/m/m_1/s/s_1");

  /*
   * **Segment-wise on integers**, which a string compare gets backwards at
   * exactly the version that matters: `6.10` is above `6.9`, and the back
   * button's gate is `6.1`.
   */
  check("6.1 is the gate and meets itself", versionAtLeast("6.1", "6.1"), true);
  check("6.0 is too old", versionAtLeast("6.0", "6.1"), false);
  check("6.10 is newer than 6.9, which a string compare denies", versionAtLeast("6.10", "6.9"), true);
  check("7 clears a 6.x gate on one segment", versionAtLeast("7", "6.1"), true);
  check("and 6 does not clear 6.1", versionAtLeast("6", "6.1"), false);
  /*
   * **Unparseable counts as too old**, and the direction is deliberate: refusing
   * the control leaves the client drawing Close, while asking an old client for a
   * back button is a request it answers by doing nothing — a page that believes
   * it has a control nobody can see.
   */
  check("a version that will not parse is too old", versionAtLeast("banana", "6.1"), false);
  check("and so is no version at all", versionAtLeast(null, "6.1"), false);

  // Nothing runs outside Telegram: the test is the injected transport, not a
  // pasted hash, and the driver has no such thing.
  check("none of this is live in an ordinary browser", inTelegram(), false);

  /*
   * **The bridge itself, driven.** Telegram's transport is a function it injects,
   * so a stub of it is the real contract rather than a mock of one — what goes
   * over it is a string this module built, and it is asserted verbatim.
   *
   * The stub is installed and removed inside this block: the `window` up top is
   * shared by every other check in this file, and a page that stays "in Telegram"
   * after this would change what modules imported later believe.
   */
  {
    const { setTelegramBack, telegramVersion } = await import("../src/telegram.js");
    const w = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;
    const sent: string[] = [];
    w["TelegramWebviewProxy"] = { postEvent: (t: string, d: string) => void sent.push(`${t} ${d}`) };
    (w["location"] as Record<string, unknown>)["hash"] = "#tgWebAppVersion=6.9&tgWebAppPlatform=ios";

    check("the launch hash carries the version", telegramVersion(), "6.9");

    let pressed = 0;
    setTelegramBack(() => void (pressed += 1));
    check("asking for a back button posts one event", sent, ['web_app_setup_back_button {"is_visible":true}']);

    // The half that draws ✕ Close: one control, and hiding it is how the other
    // appears.
    sent.length = 0;
    setTelegramBack(null);
    check("and dropping it hides the same one", sent, ['web_app_setup_back_button {"is_visible":false}']);

    /*
     * Telegram delivers by **calling into the page**, so something has to define
     * the function it calls. Under `script-src 'self'` their SDK can never load,
     * which is what makes owning this global safe — see the module's docblock.
     */
    const view = (w["Telegram"] as { WebView: { receiveEvent: (t: string) => void } }).WebView;
    setTelegramBack(() => void (pressed += 1));
    view.receiveEvent("back_button_pressed");
    check("a press reaches the handler", pressed, 1);
    // An event we do not know must pass through untouched rather than count.
    view.receiveEvent("theme_changed");
    check("and nothing else does", pressed, 1);

    /*
     * **One screen, one handler.** Replaced rather than accumulated: a stack of
     * stale closures is how a press navigates to where you were three screens
     * ago.
     */
    let second = 0;
    setTelegramBack(() => void (second += 1));
    view.receiveEvent("back_button_pressed");
    check("the newest screen owns the press", [pressed, second], [1, 1]);

    // A client too old for the feature is asked for nothing at all, rather than
    // asked and silently ignored.
    sent.length = 0;
    (w["location"] as Record<string, unknown>)["hash"] = "#tgWebAppVersion=6.0";
    setTelegramBack(() => {});
    check("an old client is asked for nothing", sent, []);

    delete w["TelegramWebviewProxy"];
    delete w["Telegram"];
    (w["location"] as Record<string, unknown>)["hash"] = "";
    check("and the stub leaves nothing behind", inTelegram(), false);
  }

  /*
   * The two halves that are not pure, read off disk. The inset is a **floor**
   * rather than an addition — on a notched device `env()` and Telegram's pill
   * describe the same strip, and adding them double-counts.
   */
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check("the Telegram header inset is a floor, not an addition", /:root\[data-telegram\] \.pt-safe \{\s*padding-top: max\(/.test(css), true);
  check("and it is scoped to Telegram", /\.pt-safe \{\s*padding-top: max\(0\.5rem/.test(css), true);
  const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  // `dataset["telegram"]` is the DOM spelling of the `[data-telegram]` the CSS
  // selects on; asserting the attribute string would pass on the comment.
  check("the marker is only written when the bridge is there", /if \(inTelegram\(\)\) \{[\s\S]{0,200}dataset\["telegram"\]/.test(entry), true);
  const bridge = readFileSync(new URL("../src/telegram.ts", import.meta.url), "utf8");
  /*
   * ⚠ The iframe transport is deliberately absent: the control plane sends
   * `frame-ancestors 'none'`, so Telegram Desktop and Web cannot load this page
   * and the arm would be unreachable. Adding it is the second half of letting
   * Telegram frame a document whose purpose is approving shell commands.
   */
  // Comments stripped, because the docblock *names* the absent transport and the
  // reason for it — which is the point of writing it down, and would otherwise
  // make this assertion fail on its own explanation.
  const bridgeCode = bridge.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no iframe transport, per the CSP", /window\.parent\.postMessage/.test(bridgeCode), false);
  check("and no script from anywhere else", /telegram\.org|<script/.test(bridgeCode), false);
  // The transport it *does* use is the one Telegram injects into its own webview.
  check("only the injected proxy", /TelegramWebviewProxy/.test(bridgeCode), true);
}

wss.close();
process.stdout.write("\nwhat a plugin may make this client draw\n");
{
  const {
    readBlock,
    readView,
    seedForm,
    pluginFailure,
    pluginPath,
    pluginDestination,
    pluginStateText,
    pluginUsable,
    screenPlugins,
    sessionActions,
    MIN_REFRESH_MS,
  } = await import("../src/plugins.js");
  const { ApiError } = await import("../src/http.js");

  /* ---------------------------------------------------------------- *
   * Everything here fails open.
   *
   * A plugin is a **third** release schedule: the web client ships with the
   * control plane weekly, a daemon ships when its owner runs `deploy.sh`, and a
   * plugin ships when its author feels like it — coordinated with neither. So
   * meeting output this client does not recognise is not an edge case, and a
   * narrowing that threw would take a whole screen away for one unknown field.
   * The failure that taught this is `endedWithDaemon`, which answered *no* for a
   * reason it had never heard of and took the composer off screen for a live
   * conversation.
   * ---------------------------------------------------------------- */

  check("a block type this client has never heard of is dropped", readBlock({ type: "canvas", data: 1 }), null);
  check("and so is something that is not a block at all", [readBlock(null), readBlock("text"), readBlock(7)], [null, null, null]);
  check(
    "a view whose blocks are all unknown is an empty view rather than a throw",
    readView({ title: "T", blocks: [{ type: "canvas" }, { type: "webgl" }] }),
    { title: "T", refreshMs: null, blocks: [] },
  );
  check("a view that is not an object at all", readView(null), { title: null, refreshMs: null, blocks: [] });
  check("a view whose blocks are not an array", readView({ blocks: "nope" }), { title: null, refreshMs: null, blocks: [] });

  check(
    "a text block with nothing in it still draws",
    readBlock({ type: "text" }),
    { type: "text", text: "", tone: "default" },
  );
  /*
   * A tone this client does not know falls to the ordinary one, and the direction
   * is chosen: a plugin can fail to make a control *look* dangerous and cannot
   * make a destructive one look harmless.
   */
  check("an unknown tone is the ordinary one", readBlock({ type: "notice", text: "x", tone: "nuclear" }), {
    type: "notice",
    text: "x",
    tone: "default",
  });
  check("and a known one survives", readBlock({ type: "notice", text: "x", tone: "danger" })?.type === "notice", true);

  const list = readBlock({ type: "list", rows: [{ id: "a" }, null, "x"], empty: "" });
  check(
    "rows that are not rows become empty rows rather than holes",
    list?.type === "list" ? list.rows.map((row) => [row.id, row.title, row.subtitle]) : null,
    [
      ["a", "", null],
      ["", "", null],
      ["", "", null],
    ],
  );
  check(
    "a row action's tone is the safe one unless it says otherwise",
    (() => {
      const one = readBlock({ type: "list", rows: [{ id: "a", actions: [{ id: "x" }, { id: "y", tone: "destructive" }] }], empty: "" });
      return one?.type === "list" ? one.rows[0]?.actions.map((action) => action.tone) : null;
    })(),
    ["plain", "destructive"],
  );

  const form = readBlock({
    type: "form",
    action: "save",
    fields: [{ key: "a", label: "A", kind: "quantum" }, { key: "b", label: "B", kind: "toggle", value: "true" }],
  });
  check(
    "a field kind this client cannot draw becomes a text input",
    form?.type === "form" ? form.fields.map((field) => field.kind) : null,
    ["text", "toggle"],
  );
  // It still round-trips, which is the whole of failing open: a field too new to
  // draw properly is still one somebody can read and submit.
  check("and its value survives", form?.type === "form" ? form.fields[0]?.value : null, null);
  check("a form with no submit label still has one", form?.type === "form" ? form.submit : null, "Save");

  /*
   * Every field is a string on the wire, including a toggle, so there is one
   * narrowing rather than five — and an unset toggle is off rather than empty.
   */
  check(
    "a form seeds from what the plugin sent",
    seedForm([
      { key: "a", label: "", kind: "text", value: "x", options: [], placeholder: null, help: null },
      { key: "b", label: "", kind: "toggle", value: null, options: [], placeholder: null, help: null },
      { key: "c", label: "", kind: "text", value: null, options: [], placeholder: null, help: null },
    ]),
    { a: "x", b: "false", c: "" },
  );

  /* ---------------------------------------------------------------- *
   * What a refusal says, and the one that is not about plugins at all.
   * ---------------------------------------------------------------- */
  const failed = (status: number, code: string, message = "m"): string =>
    pluginFailure(new ApiError(status, code, message));

  /*
   * ⚠ **A daemon that predates plugins is recognised by the shape of its refusal,
   * never by its version.** `parseBody` turns Hono's bare 404 — no envelope, so no
   * code of this system's own — into `http_404`, and that is the whole test.
   * Branching on `DAEMON_VERSION` is what compatibility rule 1 forbids, and this
   * assertion is what stops somebody "simplifying" it into one.
   */
  check("an old daemon is told apart from a missing plugin", failed(404, "http_404"), "This machine's daemon is too old for plugins. Update it and try again.");
  check("while a real 404 is about the plugin", failed(404, "plugin_not_found"), "That plugin is not installed on this machine any more.");
  check("a read-only grant", failed(403, "insufficient_scope"), "You have read-only access to this machine.");
  report(
    "a failed install says the machine was not changed",
    failed(409, "plugin_start_failed", "SyntaxError").includes("nothing was changed"),
    failed(409, "plugin_start_failed", "SyntaxError"),
  );
  // The daemon's own sentence names the field, which is the only useful thing to
  // say to whoever is holding the manifest.
  check("a bad manifest keeps the daemon's words", failed(400, "manifest_invalid", "id must be…"), "id must be…");
  check("a code this client has never seen falls through to the message", failed(400, "brand_new_code", "the daemon's words"), "the daemon's words");
  check("and something that is not an ApiError at all", pluginFailure(new Error("x")), "That did not work. Try again.");

  /* ---------------------------------------------------------------- *
   * Which plugins are offered where.
   * ---------------------------------------------------------------- */
  const plugin = (patch: Record<string, unknown>): never =>
    ({
      id: "p",
      name: "P",
      version: "1.0.0",
      description: null,
      scopes: [],
      net: [],
      contributes: { screen: null, settings: false, actions: [], hooks: [] },
      enabled: true,
      state: "running",
      failure: null,
      installedAt: 0,
      updatedAt: 0,
      ...patch,
    }) as never;

  const withScreen = plugin({ id: "a", contributes: { screen: { title: "A" }, settings: false, actions: [], hooks: [] } });
  const noScreen = plugin({ id: "b" });
  const off = plugin({ id: "c", enabled: false, contributes: { screen: { title: "C" }, settings: false, actions: [], hooks: [] } });
  const failing = plugin({ id: "d", state: "failed", contributes: { screen: { title: "D" }, settings: false, actions: [], hooks: [] } });

  /*
   * A launcher is a door. A door onto a sentence saying the plugin is not running
   * is worse than no door, and that sentence belongs on the plugin's row in
   * settings — where it is drawn.
   */
  check(
    "only plugins that draw a screen and are usable are launchable",
    screenPlugins([withScreen, noScreen, off, failing]).map((one) => one.id),
    ["a"],
  );
  check("and both halves of usable are asked", [pluginUsable(off), pluginUsable(failing), pluginUsable(withScreen)], [false, false, true]);

  const acting = plugin({
    id: "e",
    name: "E",
    contributes: {
      screen: null,
      settings: false,
      actions: [
        { id: "one", title: "One", on: "session" },
        { id: "two", title: "Two", on: "screen" },
      ],
      hooks: [],
    },
  });
  check(
    "only session-surface actions reach a session's menu",
    sessionActions([acting, off]).map((offer) => [offer.plugin.id, offer.actionId]),
    [["e", "one"]],
  );

  check(
    "a plugin's state is words rather than a colour",
    [
      pluginStateText(plugin({ state: "running" })),
      pluginStateText(plugin({ state: "starting" })),
      pluginStateText(plugin({ state: "failed" })),
      pluginStateText(plugin({ state: "stopped" })),
      pluginStateText(plugin({ enabled: false, state: "running" })),
    ],
    ["Running", "Starting", "Failed", "Idle", "Switched off"],
  );

  /* ---------------------------------------------------------------- *
   * What v2 added: a tone, a destination, and a refresh.
   * ---------------------------------------------------------------- */

  /*
   * ⚠ **All three, not one and a stranger.** This asserted only `danger` plus an
   * unknown word, so a typo in either narrowing list — `["ok", "warning",
   * "danger"]` — would have dropped every warn row's ink and left both drivers
   * green. The whole point of `ok|warn|danger` is that a plugin names meaning and
   * the host picks the ink; a member that silently stops surviving is the ink
   * going missing for a state nobody can see is missing.
   */
  check(
    "every tone this client knows survives, and one it does not is no tone",
    (() => {
      const one = readBlock({
        type: "list",
        empty: "",
        rows: [
          { id: "a", tone: "ok" },
          { id: "b", tone: "warn" },
          { id: "c", tone: "danger" },
          { id: "d", tone: "chartreuse" },
          { id: "e" },
        ],
      });
      return one?.type === "list" ? one.rows.map((row) => row.tone) : null;
    })(),
    ["ok", "warn", "danger", null, null],
  );

  /*
   * ⚠ **The field a plugin would most like to put a URL in.** Both known shapes
   * survive and everything else — a URL above all — becomes a row that is simply
   * not tappable. The daemon narrows this too; this is the second of the two,
   * because `wire.ts` is a hand mirror and trusting the daemon's narrowing would
   * be trusting a copy.
   */
  check(
    "only the two destinations this app has survive",
    (() => {
      const one = readBlock({
        type: "list",
        empty: "",
        rows: [
          { id: "a", open: { session: "s_1" } },
          { id: "b", open: { screen: true } },
          { id: "c", open: { url: "https://evil.example" } },
          { id: "d", open: "https://evil.example" },
          { id: "e", open: { session: "" } },
          { id: "f", open: { screen: false } },
          { id: "g" },
        ],
      });
      return one?.type === "list" ? one.rows.map((row) => row.open) : null;
    })(),
    [{ session: "s_1" }, { screen: true }, null, null, null, null, null],
  );

  check(
    "a destination resolves against the machine it was read on",
    [
      pluginDestination("m_1" as never, { session: "s_9" }),
      pluginDestination("m_1" as never, { screen: true }),
      pluginDestination("m_1" as never, null),
    ],
    [{ kind: "session", sessionId: "s_9" }, { kind: "screen" }, null],
  );

  /*
   * The floor is re-applied on the side that owns the timer. The daemon clamps
   * too, but that constant belongs to the *daemon* — an older one with a lower
   * floor, or a field arriving from a build that predates the clamp, would
   * otherwise set an interval this tab has to honour.
   */
  check(
    "a refresh interval is floored here as well as there",
    [
      readView({ refreshMs: 100, blocks: [] }).refreshMs,
      readView({ refreshMs: 9_000, blocks: [] }).refreshMs,
      readView({ refreshMs: 0, blocks: [] }).refreshMs,
      readView({ refreshMs: -5, blocks: [] }).refreshMs,
      readView({ refreshMs: "fast", blocks: [] }).refreshMs,
      readView({ blocks: [] }).refreshMs,
    ],
    [MIN_REFRESH_MS, 9_000, null, null, null, null],
  );

  check("a plugin's screen is a short, shared path", pluginPath("m_1" as never, "board"), "/p/m_1/board");
  check("and every segment is encoded", pluginPath("m 1" as never, "a/b"), "/p/m%201/a%2Fb");
}

process.stdout.write("\nwhat somebody is shown before a plugin is sent anywhere\n");
{
  const { peekPluginArchive } = await import("../src/pluginArchive.js");
  const { gzipSync, deflateRawSync, crc32 } = await import("node:zlib");

  const MANIFEST = JSON.stringify({
    id: "board",
    name: "Task board",
    version: "0.3.0",
    api: 2,
    description: "One card per session.",
    scopes: ["sessions.read", "store"],
    net: ["api.example.com"],
    contributes: {
      screen: { title: "Board" },
      settings: true,
      actions: [{ id: "advance", title: "Move card on", on: "session" }],
      hooks: ["turn.ended"],
    },
  });

  /*
   * Two archive writers, small enough to read, and separate from the import
   * section's for its reason: that one exists to write archives no honest tool
   * would produce, and coupling a consent screen's happy path to a fixture whose
   * job is to be malformed would be reading the wrong thing.
   */
  const tarOf = (files: Record<string, string>): Buffer => {
    const parts: Buffer[] = [];
    for (const [name, body] of Object.entries(files)) {
      const data = Buffer.from(body, "utf8");
      const head = Buffer.alloc(512);
      head.write(name, 0, "utf8");
      head.write("000644 \0", 100);
      head.write("000000 \0", 108);
      head.write("000000 \0", 116);
      head.write(data.length.toString(8).padStart(11, "0") + " ", 124);
      head.write("00000000000 ", 136);
      head.write("        ", 148);
      head.write("0", 156);
      head.write("ustar\0", 257);
      head.write("00", 263);
      let sum = 0;
      for (const byte of head) sum += byte;
      head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      parts.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
  };

  const zipOf = (files: Record<string, string>): Buffer => {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let at = 0;
    for (const [name, body] of Object.entries(files)) {
      const raw = Buffer.from(body, "utf8");
      const packed = deflateRawSync(raw);
      const named = Buffer.from(name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(raw), 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(named.length, 26);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(crc32(raw), 16);
      entry.writeUInt32LE(packed.length, 20);
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt16LE(named.length, 28);
      entry.writeUInt32LE(at, 42);
      locals.push(local, named, packed);
      central.push(entry, named);
      at += local.length + named.length + packed.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(at, 16);
    return Buffer.concat([Buffer.concat(locals), directory, end]);
  };

  const peek = (bytes: Buffer): ReturnType<typeof peekPluginArchive> =>
    peekPluginArchive(new Blob([bytes as unknown as BlobPart]));

  const flat = await peek(tarOf({ "plugin.json": MANIFEST, "server.js": "export {}" }));
  check(
    "a .tar.gz says what the plugin asks for, before anything is sent",
    flat.kind === "ok" ? [flat.manifest.id, flat.manifest.scopes, flat.manifest.net] : flat,
    ["board", ["sessions.read", "store"], ["api.example.com"]],
  );
  check(
    "including what it will be told, which asks for no scope at all",
    flat.kind === "ok" ? [flat.manifest.hooks, flat.manifest.screen, flat.manifest.settings] : flat,
    [["turn.ended"], "Board", true],
  );

  const folded = await peek(tarOf({ "board/plugin.json": MANIFEST, "board/server.js": "export {}" }));
  check("an archive holding one folder reads the same", folded.kind === "ok" ? folded.manifest.id : folded, "board");

  const zipped = await peek(zipOf({ "plugin.json": MANIFEST, "server.js": "export {}" }));
  check("and a .zip does too, since the daemon takes both", zipped.kind === "ok" ? zipped.manifest.id : zipped, "board");

  const deep = await peek(tarOf({ "a/b/plugin.json": MANIFEST }));
  check(
    "nothing deeper than the daemon itself will look for",
    deep.kind,
    "unreadable",
  );

  /*
   * ⚠ **Unreadable is never a refusal, and it may never be a guess.** The daemon
   * is the authority and takes shapes this reader may not, so refusing here would
   * make the browser a second and stricter gate. What it may not do is invent —
   * hence a reason, and a caller that draws the reason rather than an empty list.
   */
  const garbage = await peek(Buffer.from("this is not an archive at all"));
  check("something that is not an archive says so", garbage.kind === "unreadable" ? garbage.reason : garbage, "that is not a .tar.gz or a .zip");
  const broken = await peek(tarOf({ "plugin.json": "{not json" }));
  check("and so does a plugin.json that will not parse", broken.kind === "unreadable" ? broken.reason : broken, "that plugin.json is not valid JSON");

  /*
   * A manifest declaring nothing must read as declaring nothing, never as
   * unreadable: "it asks for nothing" is a true and useful thing to show, and
   * conflating it with "I cannot tell" would put the weakest plugin behind the
   * scariest sentence.
   */
  const bare = await peek(tarOf({ "plugin.json": JSON.stringify({ id: "x", name: "X", version: "1.0.0" }) }));
  check(
    "a plugin that asks for nothing reads as asking for nothing",
    bare.kind === "ok" ? [bare.manifest.scopes, bare.manifest.hooks, bare.manifest.net] : bare,
    [[], [], []],
  );

  /*
   * ⚠ **The ceiling is charged against what the decompressor produced**, not
   * against what arrived — the whole point being that a few kilobytes on the wire
   * must not become eight megabytes in a phone's tab.
   */
  const bomb = (() => {
    const head = Buffer.alloc(512);
    const data = Buffer.alloc(12 * 1024 * 1024, 0x41);
    head.write("filler.bin", 0, "utf8");
    head.write("000644 \0", 100);
    head.write("000000 \0", 108);
    head.write("000000 \0", 116);
    head.write(data.length.toString(8).padStart(11, "0") + " ", 124);
    head.write("00000000000 ", 136);
    head.write("        ", 148);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const byte of head) sum += byte;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return gzipSync(Buffer.concat([head, data, Buffer.alloc(1024)]));
  })();
  check(
    "a small archive that unpacks to a large one is stopped at the ceiling",
    (await peek(bomb)).kind === "unreadable",
    true,
  );

  /* ---------------------------------------------------------------- *
   * The rules that live only in a component, asserted against its source.
   *
   * `webcheck` has no DOM, so these are read the way `Composer.tsx`'s are. Each
   * one fails silently and in a direction nobody would notice from a screenshot,
   * which is why a source assertion is worth more here than it looks.
   * ---------------------------------------------------------------- */
  const screenSrc = readFileSync(new URL("../src/ui/PluginScreen.tsx", import.meta.url), "utf8");
  report(
    "the view is cleared on a switch and never on a refresh",
    /if \(round === 0\) setView\(null\)/.test(screenSrc),
    "round === 0 guard on setView",
  );
  report(
    "a failed tick leaves what is on screen",
    /if \(live && round === 0\) setError/.test(screenSrc),
    "round === 0 guard on setError",
  );
  report("and it only ticks while somebody is looking", /if \(document\.hidden\) return/.test(screenSrc), "document.hidden");
  report(
    "a tick that lands during a read is dropped rather than queued",
    /if \(reading\.current > 0\) return/.test(screenSrc),
    "in-flight guard",
  );
  report(
    "and an answer for a plugin somebody has navigated away from is not drawn",
    /liveRoute\.current !== issuedFor/.test(screenSrc),
    "route identity on the action answer",
  );

  const panelSrc = readFileSync(new URL("../src/ui/settings/PluginsPanel.tsx", import.meta.url), "utf8");
  report(
    "nothing is sent from the picker: the file goes to the manifest reader first",
    /onChange=\{\(event\) => \{[\s\S]{0,400}?choose\(file\)/.test(panelSrc) && !/onChange=[\s\S]{0,400}?send\(file\)/.test(panelSrc),
    "the picker calls choose(), not send()",
  );
  report(
    "and an archive nobody could read takes a second, named press",
    /Install without reading it/.test(panelSrc),
    "the unreadable path is a separate control",
  );
}

process.stdout.write("\nwhich routes are pop-ups, asked from both directions\n");
{
  const { isSheet } = await import("../src/nav.js");
  const { isOverlayPath } = await import("../src/ui/overlay.js");

  /*
   * ⚠ **These two answer one question from two directions and must hold the same
   * set** — `isSheet` from a parsed route, `isOverlayPath` from a path. A route in
   * one and not the other is a pop-up that either forgets what it was drawn over
   * (so its ✕ goes home) or records one while being a screen (so Back leaves the
   * app). Both were reachable when the path list was two literals.
   *
   * Asserted as a table of route-and-its-path rather than on the one that was
   * added, so the next pop-up is covered by being written down here at all.
   */
  const cases: [unknown, string, boolean][] = [
    [{ name: "home" }, "/", false],
    [{ name: "session", ref: { machineId: "m", sessionId: "s" } }, "/m/m/s/s", false],
    [{ name: "gate", screen: "register" }, "/register", false],
    [{ name: "new", machineId: null, cwd: null }, "/new", true],
    [{ name: "settings", section: null, machineId: null, agent: null, plugin: null }, "/settings", true],
    [{ name: "plugin", machineId: "m", pluginId: "board" }, "/p/m/board", true],
  ];
  check(
    "every route agrees with its own path about being a pop-up",
    cases.filter(([route, path, want]) => isSheet(route as never) !== want || isOverlayPath(path) !== want),
    [],
  );
  // Whole-segment matching, so a future `/pinned` is not mistaken for a plugin
  // screen — the same rule `/settingsomething` already had.
  check("a path that merely starts with the same letters is not one", isOverlayPath("/pinned"), false);
  check("nor is a plugin id at the root", isOverlayPath("/board"), false);
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
