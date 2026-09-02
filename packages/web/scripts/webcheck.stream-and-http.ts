import { readFileSync } from "node:fs";
import { check, report, sleep } from "./webcheck.env.js";
import {
  attachWithin,
  attaches,
  events,
  forgotten,
  hello,
  newStream,
  nextAttach,
  recorder,
} from "./webcheck.ws.js";

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
 * ⚠ **Three arms now, and the middle one is the edit the extraction deferred.**
 * The note that used to stand here said the second arm was "a *faithful
 * extraction* rather than an improvement": `String(cause)` yields
 * `"TypeError: Failed to fetch"` for a dead network, which is what all 23 sites
 * already showed, and *"changing what people read on 23 screens belongs in its own
 * edit"*. This is that edit. What was reaching those screens verbatim was a
 * constructor name and a Chrome string — and from `sendWithProgress`'s own budgets
 * `TypeError: upload stalled` — printed at somebody who had opened a settings pane
 * to find out what went wrong.
 *
 * The sentence is still pinned in both directions, and now there is a third thing
 * to pin: **which** failures get it. `isTransportFailure` alone is a *negation* —
 * "not an `ApiError`" — so it is true of a thrown string, a thrown object and a
 * bug in this client as well as of a dead link. Those are this client
 * mis-throwing, and reporting them as a network failure would hide a defect behind
 * a sentence about the weather, so `errorText` pairs the predicate with
 * `instanceof Error` and the arms below are what hold that pairing in place.
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

  /*
   * The unanswered arm. `TRANSPORT_TEXT` is not exported — it is one sentence in
   * `http.ts` and exporting it would invite a second caller to compose with it —
   * so the literal is written out here and the three checks below are what tie it
   * to the implementation. The assertions about its *shape* that follow are then
   * assertions about the shipped string rather than about a copy of it.
   *
   * **Two clauses, and the second is the whole reason this is not "try again".** A
   * transport failure says nothing about whether the daemon acted: `machine.ts`'s
   * `settleTransport` argues it at length and acts on it, refusing to replay
   * anything but a `GET` or a `DELETE`, because the failure that most often lands
   * here is this client's own `AbortSignal.timeout` firing long after the daemon
   * accepted the request, appended the event and started the turn.
   */
  const TRANSPORT = "the connection failed, and whether the request arrived is not known";
  check("a dead network says what is known and what is not", errorText(new TypeError("Failed to fetch")), TRANSPORT);
  check("an abort says the same thing, because it means the same thing", errorText(new DOMException("The operation was aborted.", "TimeoutError")), TRANSPORT);
  /*
   * ⚠ **The stalled upload, which is the one that had a *second* constructor name
   * to leak.** `ImportCode`'s `uploadFailureText` maps the codes it knows and falls
   * through to `errorText`, so before this arm existed a stalled archive upload
   * read `TypeError: upload stalled` on a screen whose whole subject is a file.
   */
  check("and so does a request this client gave up on", errorText(new TypeError("upload stalled")), TRANSPORT);
  /*
   * The register, asserted rather than left to a reader's eye: lower case and
   * unpunctuated, which is what the `ApiError` messages beside it look like — `you
   * already have a machine called that`, `${name} is not reachable` — so a caller
   * cannot tell which arm it got and does not have to.
   */
  check("in the register of the answers it sits beside", [/^[a-z]/.test(TRANSPORT), /[.!?]$/.test(TRANSPORT)], [true, false]);
  // And it advises nothing, because there is nothing it can honestly advise: see
  // the comment above, and `settleTransport`'s refusal to replay a write.
  check("and it does not advise a retry it cannot promise", /try again|retry|reload|refresh/i.test(TRANSPORT), false);
  /*
   * ⚠ **The four `isTransportFailure` would have swallowed.** Nothing thrown here
   * is guaranteed to be an `Error` — a `catch (cause: unknown)` takes whatever was
   * thrown — and the predicate is true of every one of these, since it only asks
   * whether the thing is *not* an `ApiError`. `instanceof Error` is the narrowing,
   * and these are what it is for: a client that threw a string is a bug to find,
   * not a network to blame.
   */
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
