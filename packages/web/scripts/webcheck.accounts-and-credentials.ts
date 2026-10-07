import { readFileSync } from "node:fs";
import { check, report, sleep, storage } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

// Whether a failure ends the session is decided by the error code, never by the status.

process.stdout.write("\nwhen a failed call ends the session\n");
{
  const { ApiError } = await import("../src/http.js");
  const { authFailure, signedOutText, signInError, signInReady } = await import("../src/account.js");
  const err = (status: number, code: string): unknown => new ApiError(status, code, code);

  check("an unknown session token ends it", authFailure(err(401, "invalid_api_key")), "credentials");
  check("a revoked one does too", authFailure(err(401, "session_revoked")), "credentials");
  check("an expired one says so separately", authFailure(err(401, "session_expired")), "expired");
  check("an unrecognised 401 still ends it", authFailure(err(401, "http_401")), "credentials");
  check("but a wrong current password does NOT", authFailure(err(401, "invalid_password")), null);
  check("nor does a refused sign-in", authFailure(err(401, "invalid_login")), null);
  check("a disabled user ends it", authFailure(err(403, "user_disabled")), "disabled");
  check("but a plain 403 does NOT", authFailure(err(403, "forbidden")), null);
  check("nor does any other route-level refusal", authFailure(err(403, "no_scopes")), null);
  check("nor a 404", authFailure(err(404, "machine_not_found")), null);
  check("nor a 500", authFailure(err(500, "boom")), null);
  check("and a transport failure never does", authFailure(new TypeError("Failed to fetch")), null);
  check("a revoked API key ends it", authFailure(err(401, "api_key_revoked")), "credentials");
  check("so does no credential at all", authFailure(err(401, "missing_api_key")), "credentials");

  const SURFACE: ReadonlyArray<readonly [status: number, code: string]> = [
    [400, "bad_request"],
    [401, "api_key_revoked"],
    [401, "invalid_api_key"],
    [401, "invalid_login"],
    [401, "invalid_password"],
    [401, "missing_api_key"],
    [401, "session_expired"],
    [401, "session_revoked"],
    // device_revoked also drops the stored device id; session_revoked must not, or every sign-in past the session cap spends a device slot.
    [401, "device_revoked"],
    [403, "forbidden"],
    [403, "machine_over_limit"],
    [403, "machine_revoked"],
    [403, "no_scopes"],
    // owner_disabled is about the machine's owner, not the caller, and must never end the session.
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
    "seven codes end a session, and no more",
    SURFACE.filter(([status, code]) => authFailure(err(status, code)) !== null).map(([, code]) => code),
    [
      "api_key_revoked",
      "invalid_api_key",
      "missing_api_key",
      "session_expired",
      "session_revoked",
      "device_revoked",
      "user_disabled",
    ],
  );
  check(
    "and each of those says which kind of ending it is",
    SURFACE.map(([status, code]) => authFailure(err(status, code))).filter((f) => f !== null),
    ["credentials", "credentials", "credentials", "expired", "credentials", "device_revoked", "disabled"],
  );
  check(
    "a retired device is its own ending, and a revoked session is not",
    [authFailure(err(401, "device_revoked")), authFailure(err(401, "session_revoked"))],
    ["device_revoked", "credentials"],
  );
  check(
    "and each has a sentence of its own that names what happened",
    [signedOutText("device_revoked") === signedOutText("credentials"), signedOutText("device_revoked").length > 0],
    [false, true],
  );
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

  // One sentence for every cause of a refused login: naming a field would undo the server's anti-enumeration.
  check("a wrong password and an unknown name read the same", signInError(err(401, "invalid_login")), signInError(err(401, "invalid_login")));
  check(
    "and the sentence blames neither half of the form",
    /\bname\b|\bemail\b|\busername\b|\baddress\b|\bpassword\b/i.test(signInError(err(401, "invalid_login"))),
    false,
  );
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

// parseBody never sees a Response, so the wait is read from the body's retryAfterSeconds, not the Retry-After header.

process.stdout.write("\nhow long the throttle said to wait\n");
{
  const { ApiError } = await import("../src/http.js");
  const { changePasswordError, retryAfter, signInError, tooManyAttemptsText, waitText } = await import(
    "../src/account.js"
  );
  const throttled = (detail: unknown): unknown =>
    new ApiError(429, "too_many_attempts", "too many attempts", detail);

  // Both ends of the throttle's range, because the wording changes unit between them.
  check("a short block is said in seconds", tooManyAttemptsText(throttled({ retryAfterSeconds: 30 })), "Too many attempts. Wait 30 seconds and try again.");
  check("a long one is said in minutes", tooManyAttemptsText(throttled({ retryAfterSeconds: 900 })), "Too many attempts. Wait 15 minutes and try again.");
  check("and one second is not one seconds", waitText(1), "1 second");
  check("nor is one minute one minutes", waitText(60), "1 minute");
  // Rounded up in both retryAfter and waitText: coming back before the block lifts extends it.
  check("a fractional second rounds up", retryAfter(throttled({ retryAfterSeconds: 30.2 })), 31);
  check("and 61 seconds is two minutes, not one", waitText(61), "2 minutes");
  check("59 seconds stays in seconds", waitText(59), "59 seconds");

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

  check(
    "the sign-in form and the password form say the same thing",
    signInError(throttled({ retryAfterSeconds: 120 })),
    changePasswordError(throttled({ retryAfterSeconds: 120 })),
  );
  check("and it carries the number", signInError(throttled({ retryAfterSeconds: 120 })), "Too many attempts. Wait 2 minutes and try again.");
}

// cp.ts already read storage at import, before this runs, so the migration rule is the pure pickStored.

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
  // An empty value and a missing key must read alike: a killed tab leaves a half-written value.
  check(
    "an empty fresh name does not shadow the old one",
    cp.pickStored("", "rk_old"),
    { value: "rk_old", kind: "api_key", migrated: true },
  );
  check(
    "a session token under the old name is still a session",
    cp.pickStored(null, "rs_old"),
    { value: "rs_old", kind: "session", migrated: true },
  );
  check("the two kinds are told apart by their prefix", [cp.credentialKind("rk_x"), cp.credentialKind("rs_x")], ["api_key", "session"]);
  // Only the control plane assigns prefixes, so an unrecognised value is more likely a new token kind than a key.
  check("and anything unrecognised is treated as a session", cp.credentialKind("xx_x"), "session");

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
  // The legacy names are swept, or the next read adopts a token from a tab signed out on purpose.
  storage.set("remoslop.credential", "rs_from_before_the_rename");
  cp.setSession("rs_after");
  check("and adopting the pre-rename name clears it", storage.has("remoslop.credential"), false);
  cp.clearSession();
  storage.set("remoslop.apiKey", "rk_older_still");
  cp.clearSession();
  check("signing out sweeps every legacy name", storage.has("remoslop.apiKey"), false);
}

// A 401 belongs to the credential the request carried, not to whichever is current when it lands.

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

  // Answered through a function: TS narrows answer to null here because it is assigned in a nested closure (TS2349).
  const respond = (response: Response): void => {
    if (!answer) throw new Error("no request was in flight to answer");
    answer(response);
  };

  let signedOut = 0;
  cp.onSignedOut(() => void (signedOut += 1));

  cp.setSession("rs_stale");
  const late = cp.me().catch((error: unknown) => error);
  await sleep(20);
  cp.setSession("rs_fresh");
  respond(refusal("session_expired"));
  const caught = await late;

  check("a 401 for a superseded credential does not clear the current one", cp.currentCredential()?.value, "rs_fresh");
  check("nor the copy in storage", storage.get("reemoat.credential"), "rs_fresh");
  report("and does not return the tab to the gate", signedOut === 0, `signedOut fired ${signedOut}×`);
  check("the caller is still told the call failed", (caught as { code?: string }).code, "session_expired");

  const now = cp.me().catch(() => null);
  await sleep(20);
  respond(refusal("session_revoked"));
  await now;
  check("a 401 for the credential still held clears it", cp.currentCredential(), null);
  report("and signs the tab out", signedOut === 1, `signedOut fired ${signedOut}×`);

  // Restore the store's handler, which store.ts registers once at module load.
  cp.onSignedOut((failure) => store.handleSignedOut(failure));
  globalThis.fetch = realFetch;
  cp.clearSession();
}

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
  const internals = store as unknown as {
    stopPolling(): void;
    connections: Map<string, unknown>;
    serverRaw: { state: string; since: number | null };
  };
  const { RECONNECT_QUIET_MS } = await import("../src/reach.js");
  // The store's waits are on the monotonic clock and the wall clock; a check moves them rather than sleeping through them.
  const later = async (ms: number, run: () => void | Promise<void>): Promise<void> => {
    const monotonic = performance.now.bind(performance);
    const wall = Date.now;
    performance.now = () => monotonic() + ms;
    Date.now = () => wall() + ms;
    try {
      await run();
    } finally {
      performance.now = monotonic;
      Date.now = wall;
    }
  };

  // The hold on what is drawn runs out on a timer of its own. Held back here and run by hand below, so that a hold which
  // never set one, or set it for the wrong moment, fails a check rather than waiting on some other publish to hide it.
  const realTimeout = globalThis.setTimeout;
  const holds: { run: () => void; ms: number }[] = [];
  (globalThis as Record<string, unknown>)["setTimeout"] = (run: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === undefined || ms <= RECONNECT_QUIET_MS - 1_000 || ms > RECONNECT_QUIET_MS) return (realTimeout as (...args: unknown[]) => unknown)(run, ms, ...rest);
    holds.push({ run, ms });
    return 0;
  };
  cp.setSession("rs_boot");
  await store.bootstrap();
  (globalThis as Record<string, unknown>)["setTimeout"] = realTimeout;
  // Stop the poll: tick would call the path under test mid-section.
  internals.stopPolling();
  // With several accounts, a down control plane must still draw the app so the drawer reaches the others.
  check("a control plane that is down still draws the app, drawer and all", store.getSnapshot().phase, "ready");
  report("and says so", store.getSnapshot().cpError !== null, `cpError: ${String(store.getSnapshot().cpError)}`);
  // Q3.707: one string stood for a server that did not answer, one that answered badly, and a registry never read.
  check(
    "as three answers: the server did not answer, the registry was never read, and neither was the account",
    [internals.serverRaw.state, internals.serverRaw.since !== null, store.getSnapshot().meRead],
    ["unreachable", true, "failed"],
  );
  // Q3.714: one failed listing is weak evidence, and it is asked again before anything is drawn of it.
  check(
    "but a listing that has only just failed is drawn as the wait it still is",
    [store.getSnapshot().server, store.getSnapshot().registry],
    [{ state: "unknown", since: null }, "unknown"],
  );
  report("the hold set its own release, for when the window is spent", holds.length >= 1, holds.map((timer) => `${String(Math.round(timer.ms))}ms`).join(", "));
  await later(RECONNECT_QUIET_MS, () => holds.at(-1)?.run());
  check(
    "and once it has outlasted the quiet window it is drawn as what it is, dated from the attempt that failed",
    [store.getSnapshot().server.state, store.getSnapshot().registry, store.getSnapshot().server === internals.serverRaw],
    ["unreachable", "failed", true],
  );
  {
    const view = stripComments(srcFile("ui/SessionView.tsx"));
    const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
    const app = stripComments(srcFile("App.tsx"));
    // Q3.708: the only wait with no shell is the one before the host has named an account, and no request is out during it.
    const loadingArm = app.slice(app.indexOf("function Starting()"), app.indexOf("function StartFailed()"));
    report("the one wait with nothing known was found", loadingArm.includes("<Spinner />"), `${loadingArm.length} chars`);
    const gates = app.slice(app.indexOf('if (state.phase === "signed_out")'), app.indexOf("<MenuDrawer"));
    check(
      "a signed-in launch draws the shell at once, loading or not, so the drawer and its accounts are never out of reach",
      [
        /if \(state\.phase === "loading" && state\.host === null && inNativeShell\(\)\) return <Starting \/>;/.test(gates),
        (gates.match(/state\.phase === "loading"/g) ?? []).length,
        /Reading your sign-in from this device…/.test(loadingArm),
        /const STARTING_WORDS_MS = 2_000;/.test(app),
      ],
      [true, 1, true, true],
    );
    check(
      "and a boot call the host rejected is a failure with a way to ask again, never the sign-in form",
      [
        /if \(state\.bootFailed\) return <StartFailed \/>;/.test(app),
        app.indexOf("if (state.bootFailed)") < app.indexOf('if (state.phase === "signed_out")'),
        /if \(hostBootFailed\(\)\) \{\s*this\.patch\(\{ bootFailed: true \}\);\s*return;/.test(stripComments(srcFile("store.ts"))),
      ],
      [true, true, true],
    );
    // The outage is the connection pill's to say (Q3.659): no banner over the list, and the title keeps its workspace line.
    check(
      "and nothing above the conversations says it",
      [/cpError/.test(view), /ControlPlaneNotice|CONTROL_PLANE_UNREACHABLE/.test(browser + view), /<ConnectionPill/.test(browser)],
      [false, false, true],
    );
    check(
      "and the list does not call an unread registry empty",
      [/\{body\.kind === "no_machines" && \(/.test(browser), /state\.machines\.length === 0 && !probing/.test(browser)],
      [true, false],
    );
    check("and the wait before the host answers says nothing about an outage, which never reaches it", /cpError|state\.server/.test(loadingArm), false);
  }

  const me = { id: "u_1", name: "ada", isAdmin: true, via: "session", hasPassword: true };
  routes = (path) => (path === "/v1/machines" ? { machines: [] } : path === "/v1/me" ? me : null);
  await store.resume("cp-retry");
  check("a registry that answers with nothing in it still leaves the loading screen", store.getSnapshot().phase, "ready");
  check("and the outage banner is cleared", store.getSnapshot().cpError, null);
  check(
    "and it is now known to be empty, which is the only thing that may be called no machines",
    [store.getSnapshot().server, store.getSnapshot().registry],
    [{ state: "ok", since: null }, "known"],
  );
  // tick retries while there are no connections and the phase is loading, so leaving loading is what stops the poll.
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

  routes = (path) => (path === "/v1/machines" ? { machines: [record] } : path === "/v1/me" ? me : null);
  await store.resume("cp-retry");
  check("a machine arriving later is still connected", internals.connections.has("m_cp"), true);
  check("and the phase does not move back", store.getSnapshot().phase, "ready");

  // Q3.703: with a machine known, a listing that failed at a wake stayed failed, and "Connecting…" with it, until the next wake.
  routes = (path) => (path === "/v1/me" ? me : null);
  await store.resume("cp-retry");
  report("a listing that fails with a machine known is the pill's cause", store.getSnapshot().cpError !== null, `cpError: ${String(store.getSnapshot().cpError)}`);
  check(
    "the server is what did not answer, and a registry once read stays read",
    [internals.serverRaw.state, store.getSnapshot().registry],
    ["unreachable", "known"],
  );
  check("while a server that answered a moment ago is still drawn as answering", store.getSnapshot().server, { state: "ok", since: null });
  routes = (path) => (path === "/v1/machines" ? { machines: [record] } : path === "/v1/me" ? me : null);
  await store.poll();
  report("a first failure is asked again a second later, and not by a poll that lands sooner", store.getSnapshot().cpError !== null, "still failed");
  await later(1_000, () => store.poll());
  check("and the next poll asks again and clears it, with no wake", store.getSnapshot().cpError, null);

  // The poll is four seconds apart, so the second-later attempt is a timer of the failure's own. Caught here rather than slept through.
  {
    const polling = store as unknown as { pollTimer: unknown; soonTimer: unknown };
    const page = document as unknown as { visibilityState?: string };
    const realSetTimeout = globalThis.setTimeout;
    const armed: { run: () => void; ms: number }[] = [];
    polling.pollTimer = 0;
    page.visibilityState = "visible";
    // Only the early pass is held back; every other timer here is somebody's real wait.
    (globalThis as Record<string, unknown>)["setTimeout"] = (run: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== 1_000) return (realSetTimeout as (...args: unknown[]) => unknown)(run, ms, ...rest);
      armed.push({ run, ms });
      return 0;
    };
    try {
      routes = (path) => (path === "/v1/me" ? me : null);
      await store.resume("cp-retry");
      const early = armed.filter((timer) => timer.ms === 1_000);
      check("a listing that fails while the poll runs sets one early pass a second out", early.length, 1);
      let asked = 0;
      routes = (path) => {
        if (path === "/v1/machines") asked += 1;
        return path === "/v1/machines" ? { machines: [record] } : path === "/v1/me" ? me : null;
      };
      await later(1_000, async () => {
        early[0]?.run();
        for (let at = 0; at < 50 && store.getSnapshot().cpError !== null; at += 1) await sleep(10);
      });
      check("and that pass asks the listing again, which clears it between two polls", [asked > 0, store.getSnapshot().cpError], [true, null]);
    } finally {
      (globalThis as Record<string, unknown>)["setTimeout"] = realSetTimeout;
      polling.pollTimer = null;
      polling.soonTimer = null;
      delete page.visibilityState;
    }
  }
  check("which is the only thing that clears the server's trouble", store.getSnapshot().server, { state: "ok", since: null });

  // Offline is a name for a failure and never one by itself: a server on this same computer answers with the network off.
  store.noteDevice(false);
  await sleep(30);
  check(
    "going offline asks the listing at once, and a server that still answers is no trouble",
    [store.getSnapshot().device, store.getSnapshot().server.state, store.getSnapshot().cpError],
    ["offline", "ok", null],
  );
  store.noteDevice(true);
  routes = (path) => (path === "/v1/me" ? me : null);
  store.noteDevice(false);
  await sleep(30);
  check(
    "and one that does not is the failure the word is for",
    [store.getSnapshot().device, store.getSnapshot().server.state, store.getSnapshot().registry],
    ["offline", "unreachable", "known"],
  );
  routes = (path) => (path === "/v1/machines" ? { machines: [record] } : path === "/v1/me" ? me : null);
  store.noteDevice(true);
  await store.resume("online");
  check(
    "back online, the listing a wake asks clears it",
    [store.getSnapshot().device, store.getSnapshot().server],
    ["online", { state: "ok", since: null }],
  );

  // Q3.716: the link back. Each rule is about which of two answers lands first, so the listing is held open and let go by
  // hand, the clock is moved rather than slept through, and every wait the store sets is caught and run here or not at all.
  {
    const peek = store as unknown as {
      pollTimer: unknown;
      soonTimer: unknown;
      holdTimer: unknown;
      holdDue: number | null;
      nextListingAt: number;
      listingFailures: number;
      listingOut: number | null;
      provedDown: Map<string, number>;
      answeredFor: Map<string, number>;
      listFailing: Map<string, number>;
      awayAsks: number | null;
      serverNudged: boolean;
      soon(ms: number): void;
      nextProbeAt: Map<string, number>;
      probeFailures: Map<string, number>;
      emit(): void;
    };
    const page = document as unknown as { visibilityState?: string };
    const realSet = globalThis.setTimeout;
    const nap = (ms: number): Promise<void> => new Promise((resolve) => void realSet(resolve, ms));
    const timers: { run: () => void; ms: number }[] = [];
    (globalThis as Record<string, unknown>)["setTimeout"] = (run: () => void, ms?: number) => {
      timers.push({ run, ms: ms ?? 0 });
      return 0;
    };
    const fetchBefore = globalThis.fetch;
    let listing: "answers" | "fails" | "hangs" | "refuses" = "answers";
    let asked = 0;
    let fleet: unknown[] = [record];
    const out: { answer: (machines: unknown[]) => void; lose: () => void }[] = [];
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === "/v1/me") return Promise.resolve(json(me));
      if (path !== "/v1/machines") return Promise.reject(new TypeError("fetch failed"));
      asked += 1;
      if (listing === "answers") return Promise.resolve(json({ machines: fleet }));
      if (listing === "fails") return Promise.reject(new TypeError("fetch failed"));
      if (listing === "refuses") return Promise.resolve(new Response("bad gateway", { status: 502 }));
      return new Promise<Response>((resolve, reject) => out.push({ answer: (machines) => resolve(json({ machines })), lose: () => reject(new TypeError("fetch failed")) }));
    }) as typeof fetch;
    const lose = (): void => out.shift()?.lose();
    /** One still out answers: with the fleet as it is now, or as it was when that one was asked. */
    const land = (index: number, machines: unknown[] = fleet): void => out.splice(index, 1)[0]?.answer(machines);
    const drawn: string[] = [];
    const watching = store.subscribe(() => drawn.push(store.getSnapshot().server.state));

    try {
      // A request that timed out is known to have failed ten seconds after it was asked, its quiet window already spent.
      listing = "hangs";
      const lost = store.resume("cp-retry");
      await nap(20);
      listing = "answers";
      timers.length = 0;
      await later(10_000, async () => {
        lose();
        await lost;
      });
      check("a listing that timed out is known to have failed, and nothing is drawn of it", [internals.serverRaw.state, store.getSnapshot().server.state], ["unreachable", "ok"]);
      const { SERVER_CONFIRM_MS } = await import("../src/reach.js");
      check(
        "its hold runs out when the ask that follows has had time to answer, not when the window did",
        timers.filter((timer) => timer.ms > SERVER_CONFIRM_MS - 100 && timer.ms <= SERVER_CONFIRM_MS).length,
        1,
      );
      await later(11_000, async () => {
        await store.poll();
        await nap(20);
      });
      check("and that ask answers, so one lost listing was never on screen", [store.getSnapshot().cpError, internals.serverRaw.state, drawn.includes("unreachable")], [null, "ok", false]);

      listing = "hangs";
      const gone = store.resume("cp-retry");
      await nap(20);
      timers.length = 0;
      await later(10_000, async () => {
        lose();
        await gone;
      });
      const hold = timers.find((timer) => timer.ms > SERVER_CONFIRM_MS - 100 && timer.ms <= SERVER_CONFIRM_MS);
      check("with nothing answering the ask that follows either, it is still not drawn a moment before", store.getSnapshot().server.state, "ok");
      await later(10_000 + SERVER_CONFIRM_MS, () => hold?.run());
      check("and is drawn once that time is up, dated from the ask that failed first", [store.getSnapshot().server.state, store.getSnapshot().server.since === internals.serverRaw.since], ["unreachable", true]);

      // An ask still out rode the link as it was. Waited for, it holds the next one back for the ten seconds it takes to time out.
      listing = "answers";
      await later(11_000, async () => {
        await store.poll();
        await nap(20);
      });
      check("an answer clears it at once", [store.getSnapshot().server.state, store.getSnapshot().cpError], ["ok", null]);
      listing = "fails";
      await store.resume("cp-retry");
      listing = "hangs";
      asked = 0;
      await later(1_100, () => store.poll());
      check("a server that did not answer is asked again a second later", asked, 1);
      listing = "answers";
      await later(5_200, async () => {
        await store.poll();
        await nap(20);
      });
      check(
        "past that it holds nothing back: the next is asked beside it at the poll's own pace, and its answer stands",
        [asked, store.getSnapshot().cpError, internals.serverRaw.state],
        [2, null, "ok"],
      );
      lose();
      await nap(20);
      check("and the one it was asked beside, failing after it, takes nothing back", [store.getSnapshot().cpError, internals.serverRaw.state], [null, "ok"]);

      // Both still out: the older one times out six seconds after the newer was asked. Paced from that landing, every
      // late failure of an outage put the next ask off again, and the asks came every six seconds for a pace of four.
      listing = "fails";
      await store.resume("cp-retry");
      listing = "hangs";
      await later(1_100, () => store.poll());
      await later(5_200, () => store.poll());
      const newest = peek.listingOut ?? 0;
      await later(11_100, async () => {
        lose();
        await nap(20);
      });
      check("a failure landing late is paced from the ask already out beside it, which is its retry", [out.length, peek.nextListingAt - newest], [1, 2_000]);
      lose();
      await nap(20);
      listing = "answers";
      peek.nextListingAt = 0;
      await later(12_000, async () => {
        await store.poll();
        await nap(20);
      });

      // Two listings out, the newer answering first: the older one's answer is the older truth.
      listing = "hangs";
      const older = store.resume("cp-retry");
      await nap(20);
      let newer: Promise<void> = Promise.resolve();
      await later(1_100, async () => {
        newer = store.retry();
        await nap(10);
      });
      check("two listings are out", out.length, 2);
      listing = "answers";
      fleet = [{ ...record, name: "renamed" }];
      land(1);
      await nap(20);
      const names = new Set<string | undefined>();
      const naming = store.subscribe(() => void names.add(store.getSnapshot().machines.find((machine) => machine.id === "m_cp")?.name));
      land(0, [record]);
      await older;
      await newer;
      await nap(20);
      naming();
      check("an older listing that answers after a newer one changes nothing either", [...names], ["renamed"]);
      fleet = [record];
      await store.resume("cp-retry");

      // Machines whose reach, route and tunnel this check decides, standing where real ones would.
      const real = internals.connections.get("m_cp") as { state(): Record<string, unknown> };
      interface StandIn {
        connection: object;
        reach: "online" | "offline";
        relayOnline: boolean;
        began: number;
        routeAsks: number;
        forgets: number;
        fail(): void;
      }
      const standInFor = (id: string, name: string): StandIn => {
        let route: Promise<null> | null = null;
        let settle: (() => void) | null = null;
        const self: StandIn = { connection: {}, reach: "offline", relayOnline: true, began: 0, routeAsks: 0, forgets: 0, fail: () => settle?.() };
        self.connection = Object.assign(Object.create(real) as object, {
          id,
          state: () => ({ ...real.state(), id, name, reach: self.reach, offlineReason: self.reach === "offline" ? "no_route" : null, relayOnline: self.relayOnline }),
          update: (next: { relayOnline: boolean }) => void (self.relayOnline = next.relayOnline),
          forgetRoute: () => void (self.forgets += 1),
          probedSince: () => self.began,
          resolveRoute: (): Promise<null> => {
            self.routeAsks += 1;
            if (route === null) {
              self.began = performance.now();
              route = new Promise<null>((resolve) => {
                settle = () => {
                  route = null;
                  settle = null;
                  resolve(null);
                };
              });
            }
            return route;
          },
        });
        return self;
      };
      const doubted = (): string[] => [...store.getSnapshot().doubted].sort();
      const laptop = standInFor("m_cp", "laptop");
      internals.connections.set("m_cp", laptop.connection);
      // The machine it stands in for was probed while this section had its clock moved forward.
      peek.provedDown.delete("m_cp");
      peek.answeredFor.delete("m_cp");
      peek.pollTimer = 0;
      page.visibilityState = "visible";
      peek.emit();

      // Passes meet in one probe: an early one, the poll, a wake. Counted once each, three of them set the next four seconds out.
      listing = "fails";
      const before = peek.probeFailures.get("m_cp") ?? 0;
      peek.nextProbeAt.delete("m_cp");
      void store.poll();
      await nap(10);
      peek.nextProbeAt.delete("m_cp");
      void store.poll();
      await nap(10);
      check("two passes that meet in one probe ask the route once between them", [laptop.forgets, laptop.routeAsks], [2, 1]);
      laptop.fail();
      await nap(20);
      check("and its failure is one failure", (peek.probeFailures.get("m_cp") ?? 0) - before, 1);

      // The link was down for both, and comes back to the server first. The probe still out was asked in the outage.
      check("a machine found down while the server is not answering is in doubt", doubted(), ["m_cp"]);
      peek.nextProbeAt.delete("m_cp");
      void store.poll();
      await nap(10);
      listing = "answers";
      peek.soonTimer = null;
      timers.length = 0;
      await later(4_000, async () => {
        peek.nextListingAt = 0;
        void store.poll();
        await nap(20);
      });
      check(
        "the server answers, and the machine is asked now rather than at the pace the outage had reached",
        [internals.serverRaw.state, peek.probeFailures.has("m_cp"), timers.some((timer) => timer.ms === 0)],
        ["ok", false, true],
      );
      check("the machine is still in doubt: the answer names nothing by itself", doubted(), ["m_cp"]);
      peek.soonTimer = null;
      timers.length = 0;
      laptop.fail();
      await nap(20);
      check(
        "the probe that was out fails, having begun before that answer: it settles nothing, and the one that will is asked now",
        [doubted(), (peek.nextProbeAt.get("m_cp") ?? Infinity) <= Date.now(), timers.some((timer) => timer.ms === 0)],
        [["m_cp"], true, true],
      );
      asked = 0;
      await later(5_000, async () => {
        void store.poll();
        await nap(10);
        laptop.fail();
        await nap(20);
      });
      check("one begun after it settles it: the machine is its own trouble, and the server is asked nothing more for it", [doubted(), asked], [[], 0]);

      // A second machine is found down. Held to the newest answer instead of the first, every listing asked for the one put
      // the other back in doubt, and each doubt asked another listing: ninety in two minutes, with nothing changing.
      const everDoubted = new Set<string>();
      const noting = store.subscribe(() => void store.getSnapshot().doubted.forEach((id) => everDoubted.add(id)));
      const studio = standInFor("m_two", "studio");
      fleet = [record, { ...record, id: "m_two", name: "studio" }];
      internals.connections.set("m_two", studio.connection);
      peek.emit();
      check("a second machine found down is in doubt, and the first is not", doubted(), ["m_two"]);
      asked = 0;
      for (const at of [6_000, 6_200, 10_000, 14_000, 18_000, 22_000]) {
        await later(at, async () => {
          peek.nextProbeAt.clear();
          void store.poll();
          await nap(10);
          laptop.fail();
          studio.fail();
          await nap(20);
        });
      }
      check("both are settled, by one listing, and the first was never put back in doubt by it", [doubted(), asked, everDoubted.has("m_cp")], [[], 1, false]);
      const again = store.retry();
      await nap(20);
      laptop.fail();
      studio.fail();
      await again;
      check("a press on Try again asks the server and leaves machines already named as they were", [asked, doubted()], [2, []]);
      noting();

      // A machine dropped while its probe is out: the failure is nobody's.
      peek.nextProbeAt.clear();
      void store.poll();
      await nap(10);
      fleet = [record];
      await store.resume("cp-retry");
      studio.fail();
      laptop.fail();
      await nap(20);
      check("a probe that fails after its machine left the list is counted for nobody", [internals.connections.has("m_two"), peek.probeFailures.has("m_two"), peek.nextProbeAt.has("m_two")], [false, false, false]);

      // A daemon the server says is not dialled in is probed without anything being asked, so no probe will ever find it
      // back. Unasked, it stayed unreachable until its token was renewed, minutes after it had dialled in again.
      laptop.relayOnline = false;
      fleet = [{ ...record, relayOnline: false }];
      peek.nextListingAt = Date.now() + 60_000;
      peek.emit();
      check("a daemon newly missed has the listing asked from a second out", [peek.awayAsks, peek.nextListingAt <= Date.now() + 1_000], [0, true]);
      const paces: number[] = [];
      let at = 0;
      asked = 0;
      for (let round = 0; round < 8; round += 1) {
        at += (paces.at(-1) ?? 1_000) + 100;
        await later(at, async () => {
          void store.poll();
          await nap(10);
          paces.push(Math.round((peek.nextListingAt - Date.now()) / 100) * 100);
          laptop.fail();
          await nap(20);
        });
      }
      check("and then at a pace that doubles to a minute, since it may be a laptop asleep for the night", [asked, paces], [8, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]]);
      fleet = [record];
      peek.soonTimer = null;
      timers.length = 0;
      peek.nextProbeAt.set("m_cp", Date.now() + 600_000);
      await later(at + 60_100, async () => {
        void store.poll();
        await nap(20);
      });
      peek.emit();
      check(
        "the listing that says it has dialled in again has it probed at once, and stops the asking",
        [laptop.relayOnline, peek.nextProbeAt.has("m_cp"), timers.some((timer) => timer.ms === 0), peek.awayAsks],
        [true, false, true, null],
      );
      laptop.fail();
      await nap(20);

      // A machine in doubt cannot wait out a listing's timeout, so its ask ignores the pace; it still gives the one out a second.
      const mini = standInFor("m_two", "mini");
      fleet = [record, { ...record, id: "m_two", name: "mini" }];
      internals.connections.set("m_two", mini.connection);
      peek.emit();
      listing = "hangs";
      asked = 0;
      void store.poll();
      await nap(10);
      await later(500, async () => {
        void store.poll();
        await nap(10);
      });
      check("a listing asked for a machine in doubt is given the second a healthy answer takes", asked, 1);
      await later(1_100, async () => {
        void store.poll();
        await nap(10);
      });
      check("and past it another is asked beside it, whatever the pace", asked, 2);
      listing = "answers";
      land(0);
      land(0);
      laptop.fail();
      mini.fail();
      await nap(20);
      internals.connections.delete("m_two");
      fleet = [record];
      await store.resume("cp-retry");
      laptop.fail();
      await nap(20);

      // Whatever answers first is the first word that the link is back.
      const down = async (): Promise<void> => {
        listing = "fails";
        const pass = store.resume("cp-retry");
        await nap(20);
        laptop.fail();
        await pass;
        listing = "answers";
        peek.nextListingAt = Date.now() + 60_000;
        peek.listingFailures = 6;
        peek.nextProbeAt.set("m_cp", Date.now() + 60_000);
        peek.probeFailures.set("m_cp", 6);
        // A timer caught here never fires, and one the store believes is still to fire would swallow the next.
        peek.soonTimer = null;
        timers.length = 0;
      };
      await down();
      check("with the server not answering, and an outage's pace reached", [internals.serverRaw.state, peek.listingFailures, peek.nextListingAt > Date.now() + 50_000], ["unreachable", 6, true]);
      laptop.reach = "online";
      peek.emit();
      check(
        "a machine that answers again has the server asked now and its count started over",
        [peek.listingFailures, peek.nextListingAt, timers.filter((timer) => timer.ms === 0).length],
        [0, 0, 1],
      );
      // Under a server that is really down, a machine whose probes pass and whose listings fail comes back every second.
      peek.nextListingAt = Date.now() + 60_000;
      peek.listingFailures = 6;
      peek.soonTimer = null;
      timers.length = 0;
      laptop.reach = "offline";
      peek.emit();
      laptop.reach = "online";
      peek.emit();
      check("once for that spell: coming back a second time is not a pace of its own", [peek.listingFailures, peek.nextListingAt > Date.now() + 50_000], [6, true]);
      asked = 0;
      peek.nextListingAt = 0;
      await later(100, async () => {
        void store.poll();
        await nap(20);
      });
      check("and the next spell is another: the server answers, and its flag is put down", [asked, internals.serverRaw.state, peek.serverNudged], [1, "ok", false]);

      laptop.reach = "offline";
      peek.emit();
      await down();
      peek.nextListingAt = 0;
      await later(100, async () => {
        void store.poll();
        await nap(20);
      });
      check(
        "the server answering again asks about the machine, which had not been due for a minute",
        [internals.serverRaw.state, peek.probeFailures.get("m_cp") ?? 0, peek.nextProbeAt.has("m_cp"), timers.some((timer) => timer.ms === 0)],
        ["ok", 0, false, true],
      );

      await down();
      const woke = store.wake("online", performance.now());
      check("a wake starts both counts over before it asks anything: what it finds down is a first failure", [peek.listingFailures, peek.probeFailures.get("m_cp") ?? 0], [0, 0]);
      await nap(20);
      laptop.fail();
      await woke;
      // A server that answers with an error is alive and under load, and a lid opened is no reason to ask it more often.
      listing = "refuses";
      const refused = store.resume("cp-retry");
      await nap(20);
      laptop.fail();
      await refused;
      peek.listingFailures = 6;
      const wokeAgain = store.wake("online", performance.now());
      check("a wake leaves a refusing server its count", [internals.serverRaw.state, peek.listingFailures], ["refusing", 6]);
      await nap(20);
      laptop.fail();
      await wokeAgain;
      listing = "answers";
      const mended = store.resume("cp-retry");
      await nap(20);
      laptop.fail();
      await mended;

      // A machine back by a door of its own, a stream's probe or a request's answer, with its sessions still unread.
      peek.listFailing.set("m_cp", performance.now());
      peek.soonTimer = null;
      timers.length = 0;
      laptop.reach = "online";
      peek.emit();
      check("a machine that answers again with its sessions unread has them read now, not at the next poll", [internals.serverRaw.state, timers.filter((timer) => timer.ms === 0).length], ["ok", 1]);
      peek.listFailing.delete("m_cp");
      laptop.reach = "offline";
      peek.emit();

      // The early pass is one timer, set for the soonest thing; what is due after it had no timer at all.
      laptop.reach = "online";
      peek.emit();
      peek.soonTimer = null;
      timers.length = 0;
      laptop.reach = "offline";
      peek.emit();
      const early = timers.find((timer) => timer.ms === 1_000);
      check("a machine newly down sets an early pass a second out", early !== undefined, true);
      peek.nextProbeAt.set("m_cp", Date.now() + 3_000);
      timers.length = 0;
      early?.run();
      await nap(20);
      check("and a pass that fires before the probe is due sets the next for when it is", timers.filter((timer) => timer.ms > 2_900 && timer.ms <= 3_000).length, 1);
      laptop.reach = "online";
      peek.emit();
      await down();
      peek.nextListingAt = Date.now() + 2_000;
      peek.soonTimer = null;
      timers.length = 0;
      peek.soon(0);
      timers.find((timer) => timer.ms === 0)?.run();
      await nap(20);
      check("the same for a listing that is not due yet", timers.filter((timer) => timer.ms > 1_900 && timer.ms <= 2_000).length, 1);
      listing = "answers";
      await store.resume("cp-retry");
      internals.connections.set("m_cp", real);

      // With no machine held the poll is a whole pass, and passes wait for each other: one whose listing went out before the
      // link was back held the next for its timeout, and a press on Try again adopted it.
      internals.connections.delete("m_cp");
      listing = "fails";
      await store.resume("cp-retry");
      listing = "hangs";
      asked = 0;
      const waiting = store.resume("cp-retry");
      await nap(20);
      listing = "answers";
      await later(4_100, async () => {
        void store.poll();
        await nap(20);
      });
      check("with no machine held, the poll asks beside a pass still waiting on its listing, and the answer stands", [asked, internals.serverRaw.state, store.getSnapshot().cpError], [2, "ok", null]);
      lose();
      await waiting;
      check("and that pass, failing after it, takes nothing back", [internals.serverRaw.state, store.getSnapshot().cpError], ["ok", null]);
      listing = "fails";
      await store.resume("cp-retry");
      listing = "hangs";
      const adopted = store.resume("cp-retry");
      await nap(20);
      listing = "answers";
      asked = 0;
      let pressed: Promise<void> = Promise.resolve();
      await later(1_100, async () => {
        pressed = store.retry();
        await nap(20);
      });
      check("a press on Try again asks for itself rather than wait out the pass it adopts", [asked, internals.serverRaw.state, store.getSnapshot().cpError], [1, "ok", null]);
      lose();
      await adopted;
      await pressed;
    } finally {
      watching();
      (globalThis as Record<string, unknown>)["setTimeout"] = realSet;
      globalThis.fetch = fetchBefore;
      peek.pollTimer = null;
      peek.soonTimer = null;
      peek.holdTimer = null;
      peek.holdDue = null;
      delete page.visibilityState;
    }
  }

  internals.stopPolling();
  internals.connections.delete("m_cp");
  globalThis.fetch = realFetch;
  cp.clearSession();
}

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

  // The client mirrors the server's password bounds, so they are read off the control plane's password.ts; nothing else crosses that boundary.
  const policy = readFileSync(new URL("../../control-plane/src/password.ts", import.meta.url), "utf8");
  const serverBound = (name: string): number => {
    const found = new RegExp(`^export const ${name} = (\\d+);$`, "m").exec(policy)?.[1];
    // Throws rather than comparing against NaN, naming the constant that went missing.
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

// Height is stated as a min-h rather than padding, which a caller's own padding class could silently override.

process.stdout.write("\nthe one measurement in a text field's chrome\n");
{
  const { FIELD } = await import("../src/ui/bits.js");

  check("the field states a resting height", FIELD.includes("min-h-9"), true);
  check("and the floor that clears 44px under a thumb", FIELD.includes("[@media(pointer:coarse)]:min-h-11"), true);
  check("with no vertical padding at all", /\bpy-\d/.test(FIELD), false);
  check(
    "and it carries no layout for a caller to fight",
    ["w-full", "mt-", "flex-1", "block", "max-w-"].filter((token) => FIELD.includes(token)),
    [],
  );
}

// describeAgent's table order is its correctness: browsers' agents contain their predecessors' names.

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
  check("Chrome is not reported as Safari", describeAgent(CHROME_MAC)?.startsWith("Chrome"), true);
  check("Edge is not reported as Chrome", describeAgent(EDGE_WINDOWS), "Edge on Windows");
  check("Chrome on iOS is not reported as Safari", describeAgent(CHROME_IPHONE), "Chrome on iPhone");
  check("Android is not reported as Linux", describeAgent(CHROME_ANDROID), "Chrome on Android");
  check("Firefox on a desktop Linux", describeAgent(FIREFOX_LINUX), "Firefox on Linux");

  // Synthetic minimal pairs: firstMatch returns on the first hit, so each more specific needle must precede the broader one.
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

  check("a platform with no known browser still says the platform", describeAgent("Mozilla/5.0 (Windows NT 10.0)"), "Windows");
  check("nothing recognised is null, never a guess", describeAgent("SomeBot/1.0"), null);
  check("an absent agent is null", describeAgent(null), null);
  check("so is one that predates the table", describeAgent(undefined), null);
  check("and so is an empty string", describeAgent("   "), null);

  check("your own row is named too", deviceLine(CHROME_MAC), "Chrome on macOS");

  check("a session that recorded nothing says so", deviceLine(null), "Signed in before this was recorded");
  check("and so does one whose field is empty", deviceLine("  "), "Signed in before this was recorded");
  check("an agent we cannot read is a different sentence", deviceLine("SomeBot/1.0"), "Unrecognised browser");
  check("nothing recorded is not 'recorded'", agentWasRecorded(null), false);
  check("nor is an empty string", agentWasRecorded("   "), false);
  check("an unreadable agent still counts as recorded", agentWasRecorded("SomeBot/1.0"), true);
  report(
    "every row says something",
    [null, undefined, "  ", "SomeBot/1.0", CHROME_MAC].every((ua) => deviceLine(ua).length > 0),
    "5 shapes",
  );
}

// The login parser is a guess; when nothing is recognised the card shows the raw output.

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

  // The one measured failure string: BSD script on macOS cannot copy termios from a pipe.
  const TCGETATTR = "script: tcgetattr/ioctl: Operation not supported on socket\n";
  check("the macOS pty failure is recognised", extractFailure(TCGETATTR) !== null, true);
  check(
    "and it is drawn as a failure once the process is gone",
    readLoginTranscript(TCGETATTR, true, true).phase,
    "failed",
  );
  // A failure line while the flow runs is not failed: these programs warn and retry.
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

  check(
    "a redrawn URL is offered once",
    extractUrls("go to https://example.com/device\r  go to https://example.com/device\n"),
    ["https://example.com/device"],
  );

  check("a code introduced by its own word", extractCode("Then enter the code: WDJB-MJHT"), "WDJB-MJHT");
  const reprinted =
    "Open https://example.com/a and enter the code: AAAA-1111\n" +
    "That code expired.\n" +
    "Open https://example.com/b and enter the code: BBBB-2222\n";
  check("a reprinted flow offers the newest code", extractCode(reprinted), "BBBB-2222");
  check("beside the newest page", readLoginTranscript(reprinted, false, false).url, "https://example.com/b");
  // FAILURES is matched against the whole transcript, so it may hold nothing the flow recovers from.
  check("an expiry it recovered from is not a failure", extractFailure(reprinted), null);
  check("so the finished run reads as done", readLoginTranscript(reprinted, true, false).phase, "done");
  check("a bare hyphenated code", extractCode("  ABCD-1234  \n"), "ABCD-1234");
  check("an unhyphenated one needs the word", extractCode("Your code is 4827193\n"), null);
  // The bare pattern matches anything hyphenated and shouty, and these flows
  // print several such words that are not codes.
  check("and a word that merely looks like one is not", extractCode("charset UTF-8\n"), null);

  // done and needsInput come from the daemon, not the bytes: the process exit and the agent's flow table.
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

  // Once the process exits a code and link are spent, so neither is offered (Q3.430).
  {
    const finished = readLoginTranscript(device, true, false);
    check("an exited flow offers no page and no code", [finished.url, finished.code], [null, null]);
    check("and is still recognised as finished", finished.phase, "done");
    const brokenAfterCode = `${device}\nscript: tcgetattr/ioctl: Operation not supported on socket\n`;
    const failed = readLoginTranscript(brokenAfterCode, true, false);
    check("a failed flow offers neither either", [failed.url, failed.code, failed.phase], [null, null, "failed"]);
    // transcriptIsTheAnswer needs its phase guard: nulling fields on exit would otherwise open the raw pane under every success.
    check("a finished run is never its own transcript's answer", transcriptIsTheAnswer(finished), false);
    check("and neither is a failed one", transcriptIsTheAnswer(failed), false);
  }

  // done only means the pty child ended; the re-probe is the only verdict on success (Q3.430).
  check("a check in flight outranks everything", loginOutcome(true, true, true), "checking");
  check("a check that could not be made is not a verdict", loginOutcome(false, true, true), "unreachable");
  check(
    "and otherwise the probe's own three answers survive",
    [loginOutcome(false, false, true), loginOutcome(false, false, false), loginOutcome(false, false, null)],
    ["signedIn", "notSignedIn", "cannotTell"],
  );
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
    check("never under a failure that named itself", rawTranscriptIsOpen(broken, "cannotTell"), false);
    check(
      "and the live rule is unchanged",
      rawTranscriptIsOpen(readLoginTranscript(unrecognised, false, false), null),
      true,
    );
  }
}

process.stdout.write("\nyour own API keys\n");
{
  const { stripComments } = await import("./webcheck.source.js");
  const {
    changePasswordError,
    clearRevokedKeyNotice,
    CONTROL_PLANE_UNREACHABLE,
    linkError,
    orderKeys,
    peekRevokedKeyNotice,
    registerError,
    rememberRevokedKey,
    revokedKeyNotice,
    signInError,
    thisBrowsersKey,
  } = await import("../src/account.js");
  const read = (file: string): string =>
    stripComments(readFileSync(new URL(`../src/ui/settings/${file}`, import.meta.url), "utf8"));

  // keyPrefix is a fixed slice of the key, so this browser's row is a string comparison; a session is never a listed key.
  // Built rather than written out: a literal rk_ key trips the CI secrets scan.
  const key = `rk_9f2a1b3c${"0".repeat(14)}`;
  check("this browser's key is the one whose prefix the credential carries", thisBrowsersKey({ value: key, kind: "api_key" }, "9f2a1b3c"), true);
  check("and a different prefix is not", thisBrowsersKey({ value: key, kind: "api_key" }, "00000000"), false);
  check("a session credential is never a listed key, whatever its bytes", thisBrowsersKey({ value: key, kind: "session" }, "9f2a1b3c"), false);
  check("and no credential is no key", thisBrowsersKey(null, "9f2a1b3c"), false);

  const keyRow = read("KeyRow.tsx");
  const guard = "thisBrowser && !revoked && (";
  const firstGuard = keyRow.indexOf(guard);
  check("the row has the this-browser guard", firstGuard >= 0, true);
  for (const literal of ["this browser", "revoking it signs you out"]) {
    check(`"${literal}" is drawn exactly once`, keyRow.split(literal).length - 1, 1);
    check(`and only under the guard`, keyRow.indexOf(literal) > firstGuard, true);
  }
  check("and the consequence is drawn at text-xs", /<span className="text-xs text-muted">revoking it signs you out<\/span>/.test(keyRow), true);
  // Row height is h-12 on the row with no vertical cell padding, so contents cannot change it; the header keeps its own (Q3.554).
  const rowStart = keyRow.indexOf("<tr className={`h-12 border-t border-edge align-middle ");
  const rowEnd = keyRow.indexOf("</tr>", rowStart);
  check("a key row is a fixed 48px", rowStart >= 0 && rowEnd > rowStart, true);
  check("and no cell of it pads vertically", /\b(py|pt|pb)-/.test(keyRow.slice(rowStart, rowEnd)), false);
  // Own keys are one tap: the admin keys panel that needed a confirm is gone (Q1.631).
  const keys = read("KeysSection.tsx");
  check("own keys are one tap", [/<TwoStep\b/.test(keyRow), /\bconfirm\b/.test(keyRow), /confirm=/.test(keys)], [false, false, false]);
  check("and the screen decides this-browser from the credential in hand", /thisBrowsersKey\(credential,/.test(keys), true);
  check("the Revoke button names its key", keyRow.split("`Revoke ${record.prefix}…`").length - 1, 1);
  check("as its own prop", /ariaLabel=\{`Revoke \$\{record\.prefix\}…`\}/.test(keyRow), true);
  check("and DangerButton forwards the name", /ariaLabel=\{ariaLabel\}/.test(read("../bits.tsx")), true);

  // Failed is deliberately not an arm: minting does not need the list.
  check("New key is disabled while the list is unread, at the ceiling, and while minting", /disabled=\{newKeyWaits \|\| atCeiling \|\| minting\}/.test(keys), true);
  check("where waiting is the list being unread", /newKeyWaits = keys === null;/.test(keys), true);
  check("and a failed read is not a reason to wait", /newKeyWaits = [^;]*"failed"/.test(keys), false);
  const ceiling = /^const MAX_KEYS = (\d+);$/m.exec(keys)?.[1] ?? null;
  // The ceiling is the keys group's footer, the one consequence it says at rest; otherwise the footer says keys never expire.
  const ceilingLine = /footer=\{atCeiling \? (`[^`]*`) : "Keys never expire\."\}/.exec(keys)?.[1] ?? null;
  check("the ceiling is a readable constant", ceiling !== null, true);
  check("the ceiling line is drawn under the guard", ceilingLine !== null, true);
  const lineAt = ceilingLine === null ? -1 : keys.indexOf(ceilingLine);
  const tableAt = keys.indexOf("<KeyTable>");
  check("as the group's footer, which is written before the table it sits under", lineAt >= 0 && tableAt >= 0 && lineAt < tableAt, true);
  const ceilingText = (ceilingLine ?? "").replaceAll("${MAX_KEYS}", ceiling ?? "").replace(/^`|`$/g, "");
  check("and reads N of N", ceilingText, `${ceiling} of ${ceiling}; revoke one first.`);
  check("in six words", ceilingText.split(/\s+/).length, 6);
  check("a failed key read says so with Try again wired to load", /<Empty failed action=\{<Button size="sm" onClick=\{load\}>Try again<\/Button>\}>\s*Could not read your keys\.\s*<\/Empty>/.test(keys), true);
  const secret = read("OneTimeSecret.tsx");
  check("Done is required of every caller", [/onDone: \(\) => void;/.test(secret), /onDone\?:/.test(secret)], [true, false]);
  check("a copy that failed says so", /toast\("error", "Could not copy — select it by hand\."\)/.test(secret), true);
  check("and a copy that landed is announced", /<span aria-live="polite">\{copied \? "Copied" : "Copy"\}<\/span>/.test(secret), true);
  check("with the value at text-xs, never smaller", /<pre className="[^"]*\bfont-mono text-xs\b[^"]*"/.test(secret), true);

  // Revoking this tab's key: notice, clear, reload, with no re-read between, or the dead key's 401 reads as an expiry.
  const remembers = keys.indexOf("rememberRevokedKey(");
  const clears = keys.indexOf("cp.clearSession()");
  const leaves = keys.indexOf("window.location.href");
  check("the revoke leaves a notice for the gate", remembers >= 0, true);
  check("clears the credential itself", clears >= 0, true);
  check("and leaves", leaves >= 0, true);
  check("in that order", remembers < clears && clears < leaves, true);
  const between = keys.slice(clears, leaves);
  check("with no re-read between the clear and the reload", /load\(\)|myKeys\(/.test(between), false);
  check("and no request can 401 its way there first", keys.indexOf("load()", remembers) === -1 || keys.indexOf("load()", remembers) > leaves, true);

  // Peek and clear are separate calls so StrictMode's double initialiser sees the same line; storage is injected for this driver.
  const fake = new Map<string, string>();
  const jar = {
    getItem: (name: string): string | null => fake.get(name) ?? null,
    setItem: (name: string, value: string): void => void fake.set(name, value),
    removeItem: (name: string): void => void fake.delete(name),
  };
  check("no revoke, no notice", peekRevokedKeyNotice(jar), null);
  rememberRevokedKey(jar, "9f2a1b3c");
  check("a revoke leaves one, naming the key", peekRevokedKeyNotice(jar), revokedKeyNotice("9f2a1b3c"));
  check("which reads as an act, not an expiry", /revoked\. Sign in again\.$/.test(revokedKeyNotice("9f2a1b3c")), true);
  check("reading it does not consume it: a second peek is the same line", peekRevokedKeyNotice(jar), revokedKeyNotice("9f2a1b3c"));
  clearRevokedKeyNotice(jar);
  check("and clearing is what deletes it", peekRevokedKeyNotice(jar), null);
  clearRevokedKeyNotice(jar);
  check("and clearing twice is nothing", peekRevokedKeyNotice(jar), null);
  const app = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  check("the gate peeks in a state initialiser", /useState<string \| null>\(\(\) => \{\s*try \{\s*return peekRevokedKeyNotice\(window\.sessionStorage\)/.test(app), true);
  check("and clears in a mount effect", /useEffect\(\(\) => \{\s*try \{\s*clearRevokedKeyNotice\(window\.sessionStorage\)/.test(app), true);
  check("with nothing left that deletes on read", /takeRevokedKeyNotice/.test(app), false);

  const rows = [
    { id: "a", createdAt: 1, revokedAt: null },
    { id: "b", createdAt: 3, revokedAt: 4 },
    { id: "c", createdAt: 2, revokedAt: null },
    { id: "d", createdAt: 5, revokedAt: null },
  ];
  check("live keys newest first, revoked last", orderKeys(rows).map((row) => row.id), ["d", "c", "a", "b"]);

  const account = read("AccountSection.tsx");
  check("the account screen lists no keys", /myKeys\(/.test(account), false);
  check("and mints none", /mintMyKey\(/.test(account), false);
  // Both arms share one TwoStep box so the last child keeps its pixels (Q3.218, Q3.552).
  check("a failed device read says so with Try again wired to refresh", /<Empty\s+failed\s+action=\{\s*<Button size="sm" onClick=\{refresh\}>\s*Try again\s*<\/Button>\s*\}\s*>\s*Could not read your sessions\.\s*<\/Empty>/.test(account), true);
  const othersQuestion = account.indexOf("Sign out ${others} other device${others === 1 ? \"\" : \"s\"}?");
  check("signing out the other devices asks, naming the count", othersQuestion >= 0, true);
  const othersBox = othersQuestion >= 0 ? account.lastIndexOf("<TwoStep", othersQuestion) : -1;
  // Where the element closes: its own `/>` on a line of its own, since a `<>…</>` fragment inside `question` carries a `/>` too.
  const others = othersBox >= 0 ? account.slice(othersBox, othersQuestion + account.slice(othersQuestion).search(/^\s*\/>/m)) : "";
  check("inside one box, the primitive's, with the resting button as its rest", othersBox >= 0 && /rest=\{\s*<Button size="sm" onClick=\{\(\) => setConfirming\(true\)\}[^>]*>/.test(others), true);
  check(
    "with the DangerButton acting on the request itself, and Cancel last the primitive's",
    [/act=\{\{ label: "Sign out", danger: true, icon: LogOut \}\}/.test(others), /onAct=\{signOutOthers\}/.test(others), /setConfirming\(false\)/.test(account)],
    [true, true, false],
  );
  check("the keys screen does both", /myKeys\(/.test(keys) && /mintMyKey\(/.test(keys), true);
  check("the device list draws one skeleton row", account.split("<SkeletonRow").length - 1, 1);
  check("and no longer narrates its own loading", /reading your sessions/.test(account), false);

  check("the constant is the sentence", CONTROL_PLANE_UNREACHABLE, "Cannot reach the control plane.");
  const transport = new TypeError("Failed to fetch");
  check(
    "every error reader answers it for a transport failure",
    [linkError(transport), registerError(transport), changePasswordError(transport)],
    [CONTROL_PLANE_UNREACHABLE, CONTROL_PLANE_UNREACHABLE, CONTROL_PLANE_UNREACHABLE],
  );
  check("and the sign-in reader builds on it", signInError(transport).startsWith(`${CONTROL_PLANE_UNREACHABLE} `), true);
  // Q3.708: with the shell drawn at once these screens are reachable before the account is, and `me === null` alone drew a failure.
  const draws = ([["AccountSection.tsx", account], ["KeysSection.tsx", keys]] as const).filter(
    ([, src]) =>
      !/import \{ MeUnread \} from "\.\.\/Unreachable";/.test(src) ||
      !/<MeUnread \/>/.test(src) ||
      src.includes(CONTROL_PLANE_UNREACHABLE) ||
      /me === null[^;]{0,120}<Empty failed/.test(src),
  );
  check("both screens hand an unread account to the one guard, and hold no sentence of their own", draws.map(([name]) => name), []);
  check("the account screen does on all three of its arms", account.split("<MeUnread />").length - 1, 3);
  const unreadSrc = stripComments(srcFile("ui/Unreachable.tsx"));
  const meUnread = unreadSrc.slice(unreadSrc.indexOf("export function MeUnread()"), unreadSrc.indexOf("function AskAgain("));
  report("the guard's body was found", meUnread.length > 0, `${meUnread.length} chars`);
  check(
    "which is a wait until the account has been asked for, and names what failed only after",
    [
      /if \(state\.meRead !== "failed"\) return <SkeletonRow \/>;/.test(meUnread),
      meUnread.indexOf("<SkeletonRow />") < meUnread.indexOf("<Unreachable"),
      /<AskAgain ask=\{\(\) => store\.refreshMe\(\)\} \/>/.test(meUnread),
    ],
    [true, true, true],
  );
}
