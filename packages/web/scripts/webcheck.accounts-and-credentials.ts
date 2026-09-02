import { readFileSync } from "node:fs";
import { check, report, sleep, storage } from "./webcheck.env.js";

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

  /*
   * ⚠ **The refusal names no half of the form, and now it cannot.** `/v1/login`
   * answers one `invalid_login` for a name nobody has, an address nobody proved, a
   * user with no password row and a password that is simply wrong — so a sentence
   * naming any one of them is the client putting the enumeration back that the
   * server spends a decoy hash to avoid. It read *"That name and password do not
   * match"*, which was merely narrow while the field took only a name and became
   * misleading the moment it took an address too.
   */
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
   * `/v1/login` keys on the submitted identifier — a name or an address, whichever
   * was typed — plus the caller's address;
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
