import { readFileSync, readdirSync } from "node:fs";
import { check, report } from "./webcheck.env.js";

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
  /*
   * ⚠ **`catalogue` is on all four rather than on the one case that reads it**,
   * and that is `parseSettingsRoute`'s `plugin` lesson arriving one file over: a
   * fixture missing a field reads as `undefined`, `?? null` is true for that, and
   * the assertion that was supposed to fail passes. The compiler is what catches
   * it here, so the field is written out rather than spread in.
   */
  const off = { registration: "off", email: false, source: null, catalogue: null } as const;
  const offMail = { registration: "off", email: true, source: null, catalogue: null } as const;
  const openLocal = { registration: "open", email: false, source: null, catalogue: null } as const;
  const openMail = { registration: "open", email: true, source: null, catalogue: null } as const;

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

  /*
   * ⚠ **`catalogue` is a third free variable, and it has to be supplied here for
   * the same reason the §13 constants are.** The handler closes over
   * `pluginCatalogueUrl`, so a `new Function` that did not pass it throws a
   * `ReferenceError` at call time rather than asserting anything — which is what
   * this span is *for*: a field added to that payload is a field this driver
   * either spans or breaks on, never one it silently ignores.
   */
  const instanceWireBody = (
    mode: { enabled: boolean; requiresEmail: boolean },
    configured: boolean,
    catalogue: string | null = null,
  ): unknown => {
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
      "pluginCatalogueUrl",
      "db",
      "c",
      source.slice(open + 1, close).join("\n"),
    );
    return handler(
      () => mode,
      () => ({ configured }),
      SOURCE_URL,
      VERSION,
      catalogue,
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
  /*
   * ⚠ **The catalogue address, across the same span, in both states.** The market
   * is unreachable without it and the CSP is built from the same variable — so
   * the field going missing from the payload, or arriving under a different key,
   * is a Plugins pop-up that silently has no Market tab on every instance in the
   * fleet. Asserted through the server's own handler rather than against a
   * fixture, which is what makes it a span rather than a second transcription.
   */
  check(
    "the catalogue address survives the wire",
    parseInstanceConfig(instanceWireBody({ enabled: true, requiresEmail: true }, true, "https://plugins.example"))
      ?.catalogue,
    "https://plugins.example",
  );
  check(
    "and an instance with none says so rather than leaving it undefined",
    parseInstanceConfig(instanceWireBody({ enabled: true, requiresEmail: true }, true))?.catalogue,
    null,
  );
  /*
   * A scheme-less value is no catalogue. It would otherwise resolve **relative to
   * this origin**, and the control plane's SPA fallback answers such a path with
   * `index.html` — so the market would fetch the app's own HTML and report the
   * catalogue as malformed, which is a confusing way to say "that URL is wrong".
   * `isAbsoluteHttpUrl` is the same guard the §13 offer already gets, and for the
   * same reason.
   */
  check(
    "and a scheme-less one is refused rather than resolved against this origin",
    parseInstanceConfig(instanceWireBody({ enabled: true, requiresEmail: true }, true, "plugins.example"))?.catalogue,
    null,
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
  const {
    canResetField,
    draftAfterClear,
    fieldOrigin,
    MAIL_BACKLOG_WARN_MS,
    mailTrouble,
    originText,
    secretFieldText,
    seedPublicUrl,
    senderMismatch,
    smtpProblem,
    SMTP_DRAFT_FIELD,
  } = await import("../src/instance.js");
  const { linkError, userState, userStateText } = await import("../src/account.js");
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

  /*
   * ⭐ **A per-field Reset survives the next Save** (review D14). `save` sends
   * all six fields from the draft, and the Reset used to re-sync the draft only
   * while the form had no edits — so edit Host, Reset From, Save wrote the old
   * From straight back under a "Saved." toast. The rule is one field: the
   * cleared key takes the server's answer, every other field keeps its edit.
   */
  // Every field differs between the two, so "moves exactly one" below is a real
  // claim on all six rather than on the three a blank fixture would leave equal.
  const edited = { host: "typed.example", port: "2525", security: "plaintext", username: "typed", from: "typed@example", publicUrl: "https://typed.example" };
  const answered = { host: "env.example", port: "587", security: "starttls", username: "env", from: "env@example", publicUrl: "https://env.example" };
  check("a cleared key takes the server's value in a dirty draft", draftAfterClear(edited, "mail.from", answered).from, "env@example");
  check("and every other field keeps its edit", draftAfterClear(edited, "mail.from", answered), { ...edited, from: "env@example" });
  // The password is write-only and has no draft field, so clearing it moves nothing.
  check("a key with no draft field changes nothing", draftAfterClear(edited, "smtp.password", answered), edited);
  // Every key the form saves has a field, and each clear touches exactly one.
  check(
    "the table names the six keys Save sends",
    Object.keys(SMTP_DRAFT_FIELD).sort(),
    ["mail.from", "mail.public_url", "smtp.host", "smtp.port", "smtp.security", "smtp.username"],
  );
  for (const [key, name] of Object.entries(SMTP_DRAFT_FIELD)) {
    const after = draftAfterClear(edited, key, answered);
    const moved = (Object.keys(after) as (keyof typeof after)[]).filter((k) => after[k] !== edited[k]);
    check(`clearing ${key} moves ${name} and nothing else`, moved, [name]);
  }

  /*
   * **The public URL is a value on a fresh server, not a placeholder** (review
   * D15). `mailConfigured` requires `mail.public_url`, and the screen offered
   * the origin only greyed in the box — so a filled-in form saved into a server
   * that still refused to send. Unset anywhere: the origin goes into the draft
   * and the form is dirty, so Save is live and sends it. Set anywhere — here
   * or in the environment — it is somebody's decision and nothing moves.
   */
  const origin = "https://cp.example";
  const urlField = (over: Record<string, unknown>) => field({ key: "mail.public_url", ...over });
  check("unset anywhere: the origin is seeded and the form is dirty", seedPublicUrl(draft, urlField({}), origin), {
    draft: { ...draft, publicUrl: origin },
    dirty: true,
  });
  check("a field the server did not send counts as unset", seedPublicUrl(draft, undefined, origin), {
    draft: { ...draft, publicUrl: origin },
    dirty: true,
  });
  const stored = { ...draft, publicUrl: "https://stored.example" };
  check("stored here: untouched", seedPublicUrl(stored, urlField({ source: "database", value: stored.publicUrl }), origin), {
    draft: stored,
    dirty: false,
  });
  check(
    "from the environment: untouched",
    seedPublicUrl(stored, urlField({ source: "environment", envSet: true, value: stored.publicUrl }), origin),
    { draft: stored, dirty: false },
  );
  // An origin `smtpProblem` would refuse is not offered: a seeded value under a
  // problem sentence is worse than an empty box.
  check("a non-http origin is not seeded", seedPublicUrl(draft, urlField({}), "null"), { draft, dirty: false });

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
   * `emailChangeNeedsProof` is gone (Q1.630): `PUT /v1/me/email` takes the
   * session alone by the owner's decision, and the predicate that decided when to
   * draw the password field went with it. An API-key caller proves the password
   * (Q1.630, amended 2026-09-05), and this app still draws no field for it:
   * `SignIn` takes no key, so the only browser presenting one is the legacy
   * adoption, which sees the server's 400 sentence. `relaycheck` pins the route's
   * shape for both credentials.
   */
  check("the email form asks no proof of its own", /emailChangeNeedsProof|account-email-proof/.test(
    readFileSync(new URL("../src/ui/settings/AccountSection.tsx", import.meta.url), "utf8"),
  ), false);

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

  check("a non-admin sees three rows", navRows(plain).map((row) => row.spec.id), ["account", "keys", "machines"]);
  /*
   * THE case, and it is invisible to the only people who could report it: a
   * heading computed from the static table renders "Server" above nothing for a
   * non-admin, and only an admin ever sees this nav in a correct state.
   */
  check("and no heading floats over nothing", navRows(plain).every((row) => row.heading === null), true);
  check("an unknown viewer is treated as a non-admin", navRows(null).map((row) => row.spec.id), ["account", "keys", "machines"]);
  check(
    "an admin sees six",
    navRows(admin).map((row) => row.spec.id),
    ["account", "keys", "machines", "server", "email", "users"],
  );
  check(
    "with the heading on the first row of its group only",
    navRows(admin).map((row) => row.heading),
    [null, null, null, "server", null, null],
  );
  const adminIndex = (id: string): number => navRows(admin).findIndex((row) => row.spec.id === id);
  check("and Server sits above Users", adminIndex("server") < adminIndex("users"), true);
  // Email slots between them: it was split out of Server and reads as its
  // continuation, and Users is the screen with the most rows, so it goes last.
  check("with Email between the two", adminIndex("server") < adminIndex("email") && adminIndex("email") < adminIndex("users"), true);
  check("every group has a title", Object.keys(GROUP_TITLES).length >= 1, true);
  /*
   * ⚠ **The heading may not be a word a row under it uses.** It was "Server"
   * over "Server settings", and a heading that restates its first row reads as
   * the row. Pinned as the string *and* as the property, so a renamed row cannot
   * quietly collide with it again. Decision 2A.
   */
  check("the admin band is headed \"Admin\"", GROUP_TITLES.server, "Admin");
  check(
    "and no row under it shares a word with its heading",
    navRows(admin)
      .filter((row) => row.spec.group === "server")
      .every((row) => !row.spec.title.toLowerCase().split(/\s+/).includes(GROUP_TITLES.server.toLowerCase())),
    true,
  );

  /*
   * **No field in Server or Email settings writes itself.**
   *
   * The SMTP form shipped with two saving mechanisms: some fields committed on
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
  // The SMTP form is `EmailSection` since the split; the field primitive both
  // draw is `SettingField`, so all three are swept.
  const emailSection = readFileSync(new URL("../src/ui/settings/EmailSection.tsx", import.meta.url), "utf8");
  const settingField = readFileSync(new URL("../src/ui/settings/SettingField.tsx", import.meta.url), "utf8");
  check("no settings field commits on blur", /onBlur=/.test(serverSection + emailSection + settingField), false);
  /*
   * **Reset waits with the rest of the form** (review D8). `busy` is the flag
   * Save and the password's Remove already read, and Reset was the one control
   * on these two screens that stayed live during a write — a clear racing a
   * Save, both answering with the whole table in an order nobody chose. Pinned
   * on the primitive and on every call site: a field drawn without `busy`
   * gets a Reset that is never disabled, with the prop defaulting to `false`.
   */
  // Stripped for the positive, as this file's other positives are: the raw read
  // above is right for the fail-closed negative and wrong here, where a docblock
  // quoting the JSX would satisfy the regex (E9's review).
  const settingFieldCode = settingField.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("SettingField's Reset is disabled while the form is busy", /<Button size="sm" tone="ghost" disabled=\{busy\} onClick=\{onReset\}>/.test(settingFieldCode), true);
  const fieldSites = (serverSection + emailSection).split("<SettingField").slice(1).map((site) => site.slice(0, site.indexOf("/>")));
  check("the two screens draw fields through it", fieldSites.length > 0, true);
  check("and every one of them passes busy", fieldSites.filter((site) => !/busy=\{busy\}/.test(site)).length, 0);
  /*
   * And the password's state sentence is not rebuilt in the JSX. It was two
   * expressions — an existence test on `set` and an `originText` beside it — and
   * two expressions on one line are two things that can disagree, which they
   * did: "No password set. from the environment". The rule is that this file
   * asks one function.
   */
  const emailCode = emailSection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("the secret's state is not re-derived on the screen", /No password|A password is set/.test(emailCode), false);
  check("and the screen asks the one function", /secretFieldText\(/.test(emailCode), true);
  /*
   * ⭐ **The password's Remove exists only while a row is stored here**, and the
   * placeholder promising to keep the stored one with it. On a fresh server
   * both were drawn — a Remove for nothing, over a placeholder describing a
   * value that did not exist. Removability is `set` alone (`secretFieldText`'s
   * own distinction: presence is `set || envSet`, removability is `set`), so
   * the gate is that field and nothing looser.
   */
  const removeGate = emailCode.indexOf("passwordStored =");
  check("removing the stored password is gated on a row being stored", removeGate >= 0, true);
  check("and the gate reads `set` alone", /passwordStored = passwordField\?\.set === true/.test(emailCode), true);
  check("and the Remove is two-step, naming what goes", /Remove the stored password\?/.test(emailCode), true);
  /*
   * The pair is `TwoStep`'s (E7's review, Q3.552): a `plain` Remove — nothing
   * here is irreversible, the password can be typed again — and Cancel last is
   * the primitive's guarantee. What this file holds is the question and the act
   * reaching it, the ghost Remove as its resting control, and the request handed
   * over whole rather than run here with a flag of this form's own.
   */
  check(
    "with a plain act, the ghost Remove at rest, and the request handed to the primitive",
    [
      /question="Remove the stored password\?"\s*act=\{\{ label: "Remove" \}\}\s*onAct=\{\(\) => clear\("smtp\.password"\)\}/.test(emailCode),
      /rest=\{\s*<Button size="sm" tone="ghost" disabled=\{busy\} onClick=\{\(\) => setRemoving\(true\)\}>/.test(emailCode),
      /setRemoving\(false\)/.test(emailCode),
    ],
    [true, true, false],
  );
  /*
   * **The removal holds the form's one lock** (review D8; E7's review). `clear`
   * is what both the confirmed Remove and a one-tap Reset go through, so `busy`
   * is set there rather than in `clearKey`: held only by the one-tap wrapper it
   * was off for the whole of a confirmed removal, and Save, Send and every Reset
   * read enabled beside a request still out — a second `adminSaveSettings` and
   * two answers re-syncing the draft in whichever order they landed, the D14
   * class E4 had just closed. The primitive takes the flag back as `disabled`,
   * so Remove is refused while a Save is out, which the hand-rolled act's
   * `disabled={busy}` did.
   */
  check(
    "and the removal holds the form's busy, from the promise it hands over",
    [
      /const clear = \(key: string\): Promise<void> => \{\s*setBusy\(true\);\s*return cp\s*\.adminSaveSettings\(\{ clear: \[key\] \}\)/.test(emailCode),
      /setDraft\(\(current\) => \(dirty \? draftAfterClear\(current, key, synced\) : synced\)\);\s*\}\)\s*\.finally\(\(\) => setBusy\(false\)\);\s*\};/.test(emailCode),
      /const clearKey = \(key: string\): void => \{\s*void clear\(key\)\.catch\(/.test(emailCode),
      /onAct=\{\(\) => clear\("smtp\.password"\)\}\s*disabled=\{busy\}/.test(emailCode),
    ],
    [true, true, true, true],
  );
  /*
   * **Registration is a badge and a verb, not a switch** (decision 7A). A
   * `role="switch"` promises a tap flips it, and opening waits behind a confirm.
   * Only the widening act is confirmed (Q3.220): the question text appears in
   * one arm and the closing tap goes straight to `close()`.
   */
  const serverCode = serverSection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  /*
   * **The badge is the server's answer and nothing else** (review D12). `open`
   * is read off `answer.registration.enabled` on every render, no state holds a
   * copy, and the only thing a 200 does is hand the answer up through
   * `onChanged` — so the badge flips inside `.then`, after the server, never
   * on the tap.
   */
  const registration = serverCode.slice(serverCode.indexOf("function Registration("), serverCode.indexOf("function Domains("));
  check("the registration badge reads the answer", /const open = answer\.registration\.enabled;/.test(registration), true);
  check("and is drawn from it", /<Badge tone="strong">\{open \? "Open" : "Closed"\}<\/Badge>/.test(registration), true);
  check("with no state holding a copy", /useState\([^)]*registration|useState<boolean>\(open/.test(registration), false);
  check("flipping only inside .then, through onChanged", /\.then\(\(updated\) => onChanged\(updated\)\)/.test(registration), true);
  // And the question closes through the primitive alone, on that same promise
  // (E7's review, Q3.552): nothing in this component puts the flag back itself.
  check("and the question closes on that promise, through the primitive", [/onAct=\{\(\) => save\(true\)\}/.test(registration), /setConfirming\(false\)/.test(registration)], [true, false]);
  check("registration is not drawn as a switch", /role="switch"/.test(serverCode), false);
  check("opening registration asks first", (serverCode.match(/Open registration to anyone\?/g) ?? []).length, 1);
  check("and closing does not", /open \? close\(\) : setConfirming\(true\)/.test(serverCode), true);
  /*
   * **Remint is two-step** (decision 12A, Q3.219's mirror): the cost of a remint
   * lands on somebody else's provisioning script, not on the person tapping.
   * The first mint retires nothing and stays one tap.
   */
  check("reminting the provisioning key asks first", /Replace the provisioning key\?/.test(serverCode), true);
  // `mintNow` is the one-tap path with the panel's own wait; the remint hands
  // `mint` itself to the primitive.
  check("and the first mint does not", /minted \? \(\) => setConfirming\(true\) : mintNow\}/.test(serverCode), true);
  // Save buttons are drawn always and disabled until dirty: a button that
  // materialises on the first keystroke is a layout shift under the finger.
  check("Save is never gated on dirtiness in the JSX", /dirty && \(?\s*<Button/.test(serverCode + emailCode), false);
  check("and is disabled until dirty instead", ((serverCode + emailCode).match(/disabled=\{busy \|\| !dirty/g) ?? []).length, 2);
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
   * ⚠ **The identifier field says both, because the route takes both.** `/v1/login`
   * resolves a name and then a *verified* address, and a field labelled `Username`
   * in front of that is a feature nobody discovers — the only place this app can
   * say so is the label, since there is no placeholder and no help text on this
   * screen. Read off disk for the reason every other placement rule here is:
   * nothing typed can hold what a label says.
   *
   * `autoComplete="username"` is asserted *unchanged* beside it, and that is the
   * half a well-meaning edit takes: `email` there tells a password manager to stop
   * offering a saved username, on a form where the username is still the primary
   * way in.
   */
  check("the identifier field offers both ways in", /Username or email/.test(signIn), true);
  check("and still autocompletes as the username it also is", /autoComplete="username"/.test(signIn), true);

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
    emailSection.split("useState<SmtpDraft>").length - 1,
    1,
  );
  // And the screen asks that function on a clear, whether or not the form is
  // dirty: the rule is pure, the placement is not, and this is the placement.
  check("a clear patches the draft through draftAfterClear", /draftAfterClear\(current, key, synced\)/.test(emailCode), true);
  /*
   * And the seed is **load-only, by construction**: called exactly once, in a
   * state initialiser ahead of the draft's own — never in the re-sync after a
   * save or a clear, where a person who emptied the field on purpose would
   * watch it come back.
   */
  check("the public URL is seeded exactly once", emailCode.split("seedPublicUrl(").length - 1, 1);
  check("in a state initialiser", /useState\(\(\) => seedPublicUrl\(/.test(emailCode), true);
  // Both operands guarded, the `>= 0` idiom: -1 is less than every real position.
  const seedAt = emailCode.indexOf("seedPublicUrl(");
  const draftAt = emailCode.indexOf("useState<SmtpDraft>");
  check("ahead of the draft it seeds", seedAt >= 0 && draftAt >= 0 && seedAt < draftAt, true);
  check("and nowhere after it — not a re-sync, a save or a clear", /seedPublicUrl\(/.test(emailCode.slice(emailCode.indexOf("useState<SmtpDraft>"))), false);
  /*
   * **The seed alone does not hide the server's diagnosis** (E14's review):
   * `mail.problems` is drawn under a clean form, and the seed dirties it with a
   * value nobody typed — so on exactly the server it is for, the sentence saying
   * what was missing vanished. `seeded` starts as the seed's own dirtiness, and
   * the first edit or a Save — dirt of the person's own — clears it.
   */
  check("the diagnosis is drawn while the seed is the only edit", /\{\(!dirty \|\| seeded\) &&\s*!answer\.mail\.configured &&\s*answer\.mail\.problems\.map\(/.test(emailCode), true);
  check("seeded starts as the seed's own dirtiness", /const \[seeded, setSeeded\] = useState\(seed\.dirty\);/.test(emailCode), true);
  check("the first edit clears it", /setDraft\(\(current\) => \(\{ \.\.\.current, \.\.\.patch \}\)\);\s*setDirty\(true\);\s*setSeeded\(false\);/.test(emailCode), true);
  check("and so does a save", /setDirty\(false\);\s*setSeeded\(false\);/.test(emailCode), true);
  /*
   * **Why Send is off is said beside it** (review D12): a test sends with what
   * is *stored*, so an unsaved form and an unconfigured server are the two
   * reasons, each a sentence, and the button is disabled on either.
   */
  check("the two reasons a test cannot send", /const sendBlocked = dirty \? "Save first\." : !answer\.mail\.configured \? "Configure the server first\." : null;/.test(emailCode), true);
  check("disable Send", /<Button disabled=\{busy \|\| sendBlocked !== null\} onClick=\{sendTest\}>/.test(emailCode), true);
  check("and are drawn under it", /\{sendBlocked !== null && <p className="mt-2 text-xs text-muted">\{sendBlocked\}<\/p>\}/.test(emailCode), true);
  check("and that draft lives on the Email screen, not the Server one", /SmtpDraft/.test(serverSection), false);

  // The property rather than the rows, so a third group cannot arrive wrong.
  for (const me of [null, plain, admin]) {
    const headings = navRows(me).map((row) => row.heading).filter((heading) => heading !== null);
    check(`a group heads at most one row (${me?.name ?? "nobody"})`, headings.length, new Set(headings).size);
  }
}
