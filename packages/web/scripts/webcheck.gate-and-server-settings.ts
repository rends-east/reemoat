import { existsSync, readFileSync, readdirSync } from "node:fs";
import { check, report } from "./webcheck.env.js";

// Every module under `packages/web/src` an entry reaches, dynamic imports included: a lazy chunk is as much in the bundle as the entry.
function closure(entry: string, valuesOnly = false): Set<string> {
  const root = new URL("../src/", import.meta.url);
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const parts = `${from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ""}/${spec}`.split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    const base = stack.join("/");
    for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      if (existsSync(new URL(candidate, root))) return candidate;
    }
    return null;
  };

  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(new URL(file, root), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const match of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      // `valuesOnly` skips type-only imports: TypeScript erases them, so they put no byte in a bundle.
      if (valuesOnly) {
        const upto = code.slice(0, match.index);
        const line = code.slice(upto.lastIndexOf("\n") + 1);
        if (/^\s*(?:import|export)\s+type\b/.test(line)) continue;
      }
      const next = resolve(file, match[1] ?? "");
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}

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

  check("no segments is no gate screen", parseGateScreen([]), null);
  check("an unrelated path is none", parseGateScreen(["settings"]), null);
  check("a session path is none", parseGateScreen(["m", "m_1", "s", "s_1"]), null);
  // A prefix-matching parser would eat `/new`, an existing overlay route.
  check("and /new is none", parseGateScreen(["new"]), null);
  for (const screen of GATE_SCREENS) {
    check(`${screen} names itself`, parseGateScreen([screen]), screen);
    check(`${screen} round-trips through its path`, parseGateScreen(gatePath(screen).slice(1).split("/")), screen);
  }
  check("and the case a URL arrives in does not decide", parseGateScreen(["Reset"]), null);

  check("a truncated sign-up link offers the sign-up form", incompleteLinkRemedy("confirm")?.path, "/register");
  check("a truncated reset link offers a new one", incompleteLinkRemedy("reset")?.path, "/forgot");
  // That account exists and is signed in somewhere, so a reset is not what was lost.
  check("a truncated verify link offers nothing rather than the wrong thing", incompleteLinkRemedy("verify"), null);
  check(
    "and the screens that never carry a token have no remedy at all",
    [incompleteLinkRemedy("register"), incompleteLinkRemedy("forgot")],
    [null, null],
  );
  check("whole segments only", isGatePath("/registerish"), false);
  check("a real one is a gate path", isGatePath("/register"), true);

  // A settings section named like a gate screen would silently steal its route.
  check(
    "no gate screen collides with a settings path",
    SECTION_SPECS.every((spec) => !isGatePath(settingsPath(spec.id))),
    true,
  );

  const real = "pr_AbCdEf0123456789_-xyz";
  check("a well-formed registration token", isGateToken(real), true);
  check("and an email token", isGateToken("et_AbCdEf0123456789xyz"), true);
  check("an API key is not one", isGateToken("rk_AbCdEf0123456789xyz"), false);
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
  check("a truncated token is nothing rather than a request", readGateToken("#t=pr_abc"), null);
  check("and rubbish in the fragment never throws", readGateToken("#%%%"), null);
  // `%2D` decodes to a character inside the token alphabet, so this fails if the shape check ever runs before the decode.
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
  // Asked for different reasons and equal today: delete this deliberately the day they diverge.
  check(
    "needing a token and outranking a session agree, for now",
    GATE_SCREENS.every((screen) => gateNeedsToken(screen) === gateOutranksSession(screen)),
    true,
  );

  // `/verify` spends its token below THE LINE, so a token alone cannot repoint an account's reset channel.
  check("exactly one screen needs a session", GATE_SCREENS.filter(gateNeedsSession), ["verify"]);
  check(
    "and it is one of the token screens",
    GATE_SCREENS.every((screen) => !gateNeedsSession(screen) || gateNeedsToken(screen)),
    true,
  );

  // Driven through the real `cp` and mapper: this is what the signed-out branch in `Gate.tsx` exists to prevent.
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

  // No predicate below may read `source` or `legal`, so a URL or a true here would hide one that started to.
  // `catalogue` is written out on all four: a missing field reads as `undefined`, which `?? null` would let pass.
  const off = { registration: "off", email: false, source: null, catalogue: null, appDownload: null, legal: false } as const;
  const offMail = { registration: "off", email: true, source: null, catalogue: null, appDownload: null, legal: false } as const;
  const openLocal = { registration: "open", email: false, source: null, catalogue: null, appDownload: null, legal: false } as const;
  const openMail = { registration: "open", email: true, source: null, catalogue: null, appDownload: null, legal: false } as const;

  // The fixtures are not trusted to match the wire: the server's own handler from `app.ts` is run through the client's parser.
  const appSource = readFileSync(new URL("../../control-plane/src/app.ts", import.meta.url), "utf8");

  const literalIn = (name: string): string => {
    const found = new RegExp(`^const ${name} = "([^"]*)";$`, "m").exec(appSource);
    if (found === null) throw new Error(`app.ts no longer declares a top-level string const ${name}`);
    return found[1] ?? "";
  };
  const SOURCE_URL = literalIn("SOURCE_URL");
  const VERSION = literalIn("VERSION");
  const wireSource = { url: SOURCE_URL, version: VERSION };

  // Every free variable of the handler is supplied here, so a new payload field is spanned or throws, never ignored.
  const instanceWireBody = (
    mode: { enabled: boolean; requiresEmail: boolean },
    configured: boolean,
    catalogue: string | null = null,
    legal = false,
  ): unknown => {
    const source = appSource.split("\n");
    const open = source.findIndex((line) => line.startsWith('  app.get("/v1/instance"'));
    if (open < 0) throw new Error("app.ts no longer registers GET /v1/instance at the top level of its routes");
    const close = source.findIndex((line, index) => index > open && line === "  });");
    if (close < 0) throw new Error("app.ts's /v1/instance handler has no closing `});` at its own indent");
    const handler = new Function(
      "registrationMode",
      "mailConfigured",
      "SOURCE_URL",
      "VERSION",
      "pluginCatalogueUrl",
      "appDownloadUrl",
      "legalDocuments",
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
      // Always null here: the download address's parser is driven in `webcheck.devices.ts`.
      null,
      legal,
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
  check(
    "and a scheme-less one is refused rather than resolved against this origin",
    parseInstanceConfig(instanceWireBody({ enabled: true, requiresEmail: true }, true, "plugins.example"))?.catalogue,
    null,
  );

  // The instance document carries no machine offer; an older control plane's is dropped on read, not refused (Q1.650).
  check(
    "the instance document names no machine offer",
    Object.keys(instanceWireBody({ enabled: true, requiresEmail: true }, true) as object).includes("machines"),
    false,
  );
  check(
    "and a control plane from before the deletion is read with its offer dropped",
    parseInstanceConfig({
      ...(instanceWireBody({ enabled: true, requiresEmail: true }, true) as object),
      machines: { offer: "https://get.example" },
    }),
    { ...openMail, source: wireSource },
  );

  check(
    "registration off with mail configured survives the wire too",
    parseInstanceConfig(instanceWireBody({ enabled: false, requiresEmail: false }, true)),
    { ...offMail, source: wireSource },
  );

  // An unreadable shape is `null` (unknown, which fails open), never a config with everything off.
  check("a body from before this release is unknown", parseInstanceConfig({}), null);
  check("so is one that is not an object at all", parseInstanceConfig("registration: open"), null);
  check("and null itself", parseInstanceConfig(null), null);
  check("the client's own type is not a wire body", parseInstanceConfig({ registration: "open", email: true }), null);
  check(
    "a nested body missing the mail half is unknown, not mail-less",
    parseInstanceConfig({ registration: { enabled: true } }),
    null,
  );

  // Fails open, unlike `visibleSections`: closed where the cost is a missing screen, open where it is a locked-out person.
  check("an unknown config is reported as unknown", gateOffer("register", null), "unknown");
  check("for both doors", gateOffer("forgot", null), "unknown");
  check("registration closed", gateOffer("register", off), "closed");
  check("registration open", gateOffer("register", openLocal), "link");
  // Registration off with mail on is an admin-only instance where people still reset their own passwords.
  check("recovery survives registration being closed", gateOffer("forgot", offMail), "link");
  check("no mail, no recovery", gateOffer("forgot", openLocal), "closed");

  check("an unknown config still offers to register", showsGateLink("register", null), true);
  check("and still offers recovery", showsGateLink("forgot", null), true);
  check("only a definite no hides a door", showsGateLink("register", off), false);
  check("recovery survives registration being closed, in the drawn form too", showsGateLink("forgot", offMail), true);
  check("and no mail really does hide recovery", showsGateLink("forgot", openLocal), false);

  // A door is never missing without a sentence, and never explained while it is there.
  for (const config of [null, off, offMail, openLocal, openMail]) {
    const silent = gateNotice(config) === null;
    const both = showsGateLink("register", config) && showsGateLink("forgot", config);
    check(`a missing door always has a sentence (${JSON.stringify(config)})`, silent, both);
  }
  check("an unknown config says nothing at all", gateNotice(null), null);

  check("an unknown config waits rather than guessing", signupMode(null), null);
  check("closed", signupMode(off), "closed");
  // The cell an implementation keyed on `email` alone gets wrong.
  check("closed even with mail", signupMode(offMail), "closed");
  check("open without mail takes a password only", signupMode(openLocal), "open_local");
  check("open with mail requires an address", signupMode(openMail), "open_verified");

  // Fails closed, unlike `gateOffer`: the cost is an admin handing a password over by hand, not a lockout.
  check("inviting is refused while the config is unknown", adminMayInvite(null), false);
  check("and allowed only with mail", [adminMayInvite(openMail), adminMayInvite(openLocal)], [true, false]);

  // `null` may mean waiting only until a read finishes: a signed-out tab never re-reads, so a failed read would spin for ever.
  check("an unread config still waits", signupScreen(null, false), "waiting");
  check("and a read that finished with nothing to show says so", signupScreen(null, true), "unavailable");

  for (const config of [null, off, offMail, openLocal, openMail]) {
    for (const settled of [true, false]) {
      check(
        `nothing hangs but the unread config (${JSON.stringify(config)}, settled=${settled})`,
        signupScreen(config, settled) === "waiting",
        config === null && !settled,
      );
    }
  }
  for (const config of [off, offMail, openLocal, openMail]) {
    check(
      `a config that lands wins whatever the screen had settled for (${JSON.stringify(config)})`,
      [signupScreen(config, true), signupScreen(config, false)],
      [signupMode(config), signupMode(config)],
    );
  }

  check("no mail, so an address can do nothing", mailUsable(openLocal), false);
  check("mail, so it can", mailUsable(openMail), true);
  // Keyed on `email` alone: an admin-only instance still recovers its own accounts.
  check("registration decides nothing about it", [mailUsable(off), mailUsable(offMail)], [false, true]);

  check(
    "an unknown config keeps both ways back and withholds the convenience",
    [showsGateLink("forgot", null), mailUsable(null), adminMayInvite(null)],
    [true, true, false],
  );
  // Fails open: `AddMachine` is the only way to create a machine, and `me` is unreadable whenever `bootstrap` fails.
  check(
    "and it keeps the only door to a machine open too",
    (await import("../src/quota.js")).mayAddMachine(null),
    true,
  );

  // Comment-stripped: the branch docblocks quote the ordering, so the raw file would pass whichever way round the code is.
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const gateBranch = app.indexOf('route.name === "gate"');
  const legalBranch = app.indexOf('route.name === "legal"');
  const picker = app.indexOf("<ChooseServer");
  const signedOut = app.indexOf('phase === "signed_out"');
  const wall = app.indexOf("mustChangePassword === true");
  const shell = app.indexOf("<AppShell");
  check("and still has a signed-out phase for a screen to outrank", signedOut >= 0, true);
  check("and still has a wall in front of a temporary password", wall >= 0, true);
  check("and still renders the shell behind it", shell >= 0, true);
  check("and still draws a document before either", legalBranch >= 0, true);

  // The app draws no gate screen: the control plane serves them from `dist-gate`.
  check("the app bundle draws no gate route at all", gateBranch, -1);

  // Two builds with no shared chunks, so each entry's import graph is its bundle; `GateCard` is shared on purpose (`ForcedPasswordChange` renders one).
  const appClosure = closure("main.tsx");
  const gateClosure = closure("gate-main.tsx");
  report("the walk found a bundle at all", appClosure.size > 40, `${appClosure.size} modules from main.tsx`);
  check(
    "the app bundle reaches no gate screen",
    [...appClosure].filter((f) => f.startsWith("ui/gate/") && f !== "ui/gate/GateCard.tsx").sort(),
    [],
  );
  check(
    "the one shared box really is shared",
    [appClosure.has("ui/gate/GateCard.tsx"), gateClosure.has("ui/gate/GateCard.tsx")],
    [true, true],
  );
  check(
    "and the gate bundle still draws all four",
    [...gateClosure].filter((f) => f.startsWith("ui/gate/")).sort(),
    ["ui/gate/Gate.tsx", "ui/gate/GateApp.tsx", "ui/gate/GateCard.tsx", "ui/gate/Handoff.tsx"],
  );
  check("App.tsx imports no gate screen", /ui\/gate\/Gate/.test(app), false);

  // A browser holds no device key, so `dist-gate` can open no channel and must carry no transport; `signInAuth.ts`'s one-provider claim rests on this too.
  check(
    "the Install control ships in the app and not in the gate",
    [appClosure.has("ui/agentInstall.ts"), gateClosure.has("ui/agentInstall.ts")],
    [true, false],
  );
  check(
    "the account panel and the doors that switch accounts ship in the app and not in the gate",
    [
      appClosure.has("ui/MenuDrawer.tsx"),
      gateClosure.has("ui/MenuDrawer.tsx"),
      appClosure.has("ui/UseAnotherAccount.tsx"),
      gateClosure.has("ui/UseAnotherAccount.tsx"),
    ],
    [true, false, true, false],
  );
  check(
    "while the sign-in screen's pure table and its store-free read ship in both",
    [appClosure.has("slot.ts"), gateClosure.has("slot.ts"), appClosure.has("ui/backAccount.ts"), gateClosure.has("ui/backAccount.ts")],
    [true, true, true, true],
  );

  const TRANSPORT = ["e2ee.ts", "machine.ts", "stream.ts", "daemon.ts", "store.ts"];
  const gateValues = closure("gate-main.tsx", true);
  const appValues = closure("main.tsx", true);
  check(
    "the gate bundle reaches no transport module",
    TRANSPORT.filter((f) => gateValues.has(f)).sort(),
    [],
  );
  // Non-vacuity: the app must reach every transport module, or the list above names nothing.
  check(
    "while the app bundle reaches every one of them",
    TRANSPORT.filter((f) => appValues.has(f)).sort(),
    [...TRANSPORT].sort(),
  );
  report(
    "the value-only walk still found a bundle",
    gateValues.size > 20 && gateValues.size < gateClosure.size,
    `${gateValues.size} value modules of ${gateClosure.size} in the graph`,
  );
  check(
    "each bundle links exactly one store, and never both",
    [
      appValues.has("store.ts"),
      appValues.has("gateStore.ts"),
      gateValues.has("gateStore.ts"),
      gateValues.has("store.ts"),
    ],
    [true, false, true, false],
  );
  // `vite.gate.config.ts` defines no `__APP_VERSION__`, so a gate edge to `version.ts` would ship claiming to be a development build.
  check(
    "the gate never reaches the version constant its build does not define",
    [gateValues.has("version.ts"), appValues.has("version.ts")],
    [false, true],
  );

  // The page lets go of its credential before the host's base moves, with `detachSession` so the server left stays signed in (Q7.148).
  // The no-op exit sits above both, or saving the current address would sign you out.
  const chooseServer = readFileSync(new URL("../src/ui/ChooseServer.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const noop = chooseServer.indexOf("typed === current");
  const clears = chooseServer.indexOf("cp.detachSession()");
  const adopts = chooseServer.indexOf("setNativeServer(typed)");
  check("the server screen still does all three", [noop >= 0, clears >= 0, adopts >= 0], [true, true, true]);
  check("saving an unchanged address gives nothing up", noop < clears, true);
  check("and the credential goes before the host's origin moves", clears < adopts, true);
  check("and only the page's copy goes: the server being left stays signed in", /clearSession\(/.test(chooseServer), false);
  // The credential is restored inside the catch: a restore anywhere else would re-arm it after the base had moved.
  const refused = chooseServer.slice(adopts, chooseServer.indexOf("window.location.assign", adopts));
  check(
    "a refused switch gives the page its credential back, inside the catch",
    /catch \(cause: unknown\) \{\s*if \(held !== null\) cp\.adoptHydratedCredential\(held\.value\);/.test(refused),
    true,
  );
  check(
    "the add screen says nothing about what adding costs, nor whose the address is",
    [/signs none of the others out/.test(chooseServer), /keeps running until you quit Reemoat/.test(chooseServer), /That address is ours/.test(chooseServer)],
    [false, false, false],
  );
  const accountSection = readFileSync(new URL("../src/ui/settings/AccountSection.tsx", import.meta.url), "utf8");
  check("and Settings no longer says a switch signs this computer out", /signs this computer out/.test(accountSection), false);
  // Settings states the server and offers no way to change it (Q3.643): repointing a signed-in account would make it a different account.
  const accountCode = accountSection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check(
    "Settings shows the server and offers no way to change it",
    [/Server address/.test(accountCode), /store\.pickServer\(\)/.test(accountCode), /action=\{null\}/.test(accountCode)],
    [true, false, true],
  );
  check("and says where the other door is", /Another server is another account, from the menu\./.test(accountCode), true);
  check(
    "and Sign out says, in the shell, that it takes the account off this computer",
    /nativeBoot\(\) !== null\s*\?\s*"Ends this sign-in on the server too, and takes this account off this computer\."/.test(accountCode),
    true,
  );
  // The field opens on the build's suggestion when there is no server and on the server when there is; nothing is written until Continue.
  check(
    "the field opens on the current server, or on what the build suggests",
    /useState\(current \?\? suggested \?\? ""\)/.test(chooseServer),
    true,
  );
  check("the suggestion is read as itself and never as the server", /defaultServer/.test(chooseServer), true);
  check("and the first screen greets rather than interrogating", /Welcome to Reemoat/.test(chooseServer), true);
  check("while an account being added is named as that", /adding \? "Add account" : "Welcome to Reemoat"/.test(chooseServer), true);
  check(
    "an add is decided by the live list, and the screen waits for it",
    [/const back = useBackAccount\(\);/.test(chooseServer), /const adding = back !== null && back !== undefined;/.test(chooseServer), /if \(back === undefined\) return/.test(chooseServer)],
    [true, true, true],
  );
  check(
    "the explainer is drawn only where there is no address above it, on a first run",
    /\{!editing && !adding && suggested === null && \(/.test(chooseServer),
    true,
  );
  check("no sentence here is about a sign-in the screen holds: no entrance reaches it with one", /signedIn/.test(chooseServer), false);
  // A disabled input takes no focus, so Continue takes it while the field is locked.
  check(
    "the field takes focus where it can be typed in, and Continue does while it is locked",
    [/autoFocus=\{!editing && !locked\}/.test(chooseServer), /autoFocus=\{locked\}/.test(chooseServer)],
    [true, true],
  );
  check(
    "the way back is drawn only on an add, and names the account it returns to",
    [
      /\{adding && \(\s*<button[^>]*onClick=\{leave\}/.test(chooseServer),
      /<span className="truncate">\{back\.label\}<\/span>/.test(chooseServer),
      /store\.switchAccount\(null\)/.test(chooseServer),
    ],
    [true, true, true],
  );
  check("and there is no Cancel beside Continue", />\s*Cancel\s*</.test(chooseServer), false);
  check("it no longer claims a switch keeps a sign-in it may not have", /stays signed in to/.test(chooseServer), false);
  check("and no longer that it forgets a sign-in", /forgets this computer/.test(chooseServer), false);
  check("and the probe carries no credential", /probeServer\([^)]*authorization/i.test(chooseServer), false);

  // Locked with `disabled`, never `readOnly` (focusable, draws a caret); the pencil calls `flushSync` first because a disabled field ignores focus (Q3.643).
  check("the field is locked only on the build's own suggestion", /useState\(!editing && suggested !== null\)/.test(chooseServer), true);
  check("by disabling it, never by making it read-only", [/disabled=\{locked\}/.test(chooseServer), /readOnly/.test(chooseServer)], [true, false]);
  check(
    "with a labelled pencil beside it while it is",
    /\{locked && \(\s*<IconButton icon=\{Pencil\} label="Edit server address" size="nav"/.test(chooseServer),
    true,
  );
  check(
    "which unlocks, then focuses, then selects, inside the tap",
    /flushSync\(\(\) => setLocked\(false\)\);\s*field\.current\?\.focus\(\);\s*field\.current\?\.select\(\);/.test(chooseServer),
    true,
  );
  // Without the two `disabled:` variants a disabled `FIELD` draws like an editable one, and opacity would dim the address too.
  const fieldClass = /className=\{`min-w-0 flex-1 \$\{FIELD\}([^`]*)`\}/.exec(chooseServer)?.[1] ?? "";
  report("the field's own class string was found", fieldClass.length > 0, fieldClass.trim());
  check(
    "the locked field dims its ink and steps its boundary back, with no opacity anywhere here",
    [/disabled:border-edge\b/.test(fieldClass), /disabled:text-muted/.test(fieldClass), /opacity/.test(chooseServer)],
    [true, true, false],
  );

  // The picker outranks every screen that needs a config, since a config needs a server.
  check("the server picker is drawn above every screen that needs a config", picker >= 0 && picker < legalBranch, true);
  check("and above the sign-in screen it is reached from", picker < signedOut, true);

  // Sliced to `App`'s own body: a hook below an early return crashes the render (React error #310), which `typecheck` cannot see.
  const appBody = app.slice(app.indexOf("export function App("), app.indexOf("function OverlaySheet("));
  const lastHook = Math.max(
    ...["useState(", "useEffect(", "useSyncExternalStore(", "useRoute(", "useUnder(", "useOrigin("].map((hook) =>
      appBody.lastIndexOf(hook),
    ),
  );
  check("the hook sweep can see App's body at all", appBody.length > 0 && lastHook > 0, true);
  check("every hook in App runs above its first early return", lastHook < appBody.indexOf("<ChooseServer"), true);
  // Past the wall a temporary password would get the whole app, where every route below THE LINE answers 403.
  check("and the wall itself is in front of the app", wall < shell, true);

  // A mailed token must never reach `setSession`, and every navigation replaces: Back onto a spent token would re-submit it.
  const gateDir = new URL("../src/ui/gate/", import.meta.url);
  const gateScreenFiles = readdirSync(gateDir).filter((name) => /\.tsx?$/.test(name));
  check("there are gate screens to have checked", gateScreenFiles.length > 0, true);
  for (const name of gateScreenFiles) {
    const code = readFileSync(new URL(name, gateDir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    check(`${name} never stores a mailed token as the credential`, /setSession\(/.test(code), false);
    // One level of nesting is allowed for, so a nested call as the first argument still counts as replacing.
    const calls = code.match(/navigate\(/g)?.length ?? 0;
    const replacing = code.match(/navigate\((?:[^()]|\([^()]*\))*,\s*true\)/g)?.length ?? 0;
    check(`${name} replaces on all ${calls} of its navigations`, replacing, calls);
  }

  // A card that can only be waited on must say how to leave; the scan is crude and misses a spinner drawn by a helper.
  const gateTsx = readFileSync(new URL("../src/ui/gate/Gate.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const cards = gateTsx.split("<GateCard").slice(1).map((rest) => rest.slice(0, rest.indexOf("</GateCard>")));
  const waits = cards.filter((card) => card.includes("<Spinner"));
  // Non-vacuity: a rule about spinner cards is worth nothing on a file with none.
  check("there are cards that can only be waited on", waits.length > 0, true);
  check("and every one of them carries a way off it", waits.filter((card) => card.includes("footer=")).length, waits.length);

  // Comment-stripped: the branch's docblock quotes both strings searched for here.
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
  // Rendering `SignIn` in place keeps the token in this URL's fragment; a navigation would lose it.
  check("and the way on is the sign-in form itself", /<SignIn\b/.test(gateTsx), true);

  // `store.refreshConfig` is the only thing on a signed-out tab that can finish a config read.
  check("the sign-up screen can ask the control plane again", /store\.refreshConfig\(/.test(gateTsx), true);
  check("and reads the screen state rather than re-deriving the mode", /signupMode\(/.test(gateTsx), false);
  check("through the function that has both inputs", /signupScreen\(/.test(gateTsx), true);

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
  check("and never re-derives it from the config's own field", /config\?\.email|config\.email/.test(accountTsx), false);
  check("the promise about resetting your own password is still made", promisesReset >= 0, true);
  check("and it is made downstream of the check that it is true", asksMailUsable < promisesReset, true);
  check("and where it cannot be kept, the block says why", /cannot send mail/.test(accountTsx), true);
}

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

  // `set` means a database row, not that a password exists: an environment password arrives with set false and envSet true.
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
  check("an absent field says nothing at all", secretFieldText(undefined), null);

  for (const set of [true, false]) {
    for (const envSet of [true, false]) {
      const source = set ? "database" : envSet ? "environment" : "unset";
      const text = secretFieldText(secret({ set, envSet, source })) ?? "";
      check(`presence is set||envSet (set=${set}, envSet=${envSet})`, !text.startsWith("No password"), set || envSet);
    }
  }

  const draft = { host: "", port: "", security: "", username: "", from: "", publicUrl: "" };
  // An empty form means mail is off, which is legal: refusing it would make mail impossible to turn off.
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

  // Every field differs between the two, so moving exactly one is a real claim on all six.
  const edited = { host: "typed.example", port: "2525", security: "plaintext", username: "typed", from: "typed@example", publicUrl: "https://typed.example" };
  const answered = { host: "env.example", port: "587", security: "starttls", username: "env", from: "env@example", publicUrl: "https://env.example" };
  check("a cleared key takes the server's value in a dirty draft", draftAfterClear(edited, "mail.from", answered).from, "env@example");
  check("and every other field keeps its edit", draftAfterClear(edited, "mail.from", answered), { ...edited, from: "env@example" });
  // The password is write-only and has no draft field, so clearing it moves nothing.
  check("a key with no draft field changes nothing", draftAfterClear(edited, "smtp.password", answered), edited);
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

  // `mailConfigured` requires `mail.public_url`, so an unset one is seeded as a real draft value rather than a placeholder.
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
  // An origin `smtpProblem` would refuse is not seeded.
  check("a non-http origin is not seeded", seedPublicUrl(draft, urlField({}), "null"), { draft, dirty: false });

  const healthy = { pending: 0, failed: 0, oldestPendingMs: null, lastError: null, lastFailedAt: null, paused: false };
  check("a quiet queue says nothing", mailTrouble(healthy), null);
  check("and neither does something in flight", mailTrouble({ ...healthy, pending: 2, oldestPendingMs: 30_000 }), null);

  check("an older control plane draws no banner rather than an all-clear", mailTrouble(undefined), null);

  // Ordered by remedy, not severity: only the breaker is currently stopping delivery.
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
  report(
    "and it counts in English",
    mailTrouble({ ...healthy, failed: 1 })?.text.includes("1 message has") === true,
    `${String(mailTrouble({ ...healthy, failed: 1 })?.text)}`,
  );

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
  check("no address at all is not unconfirmed", userState({ ...person, email: null, emailVerified: false }, true), null);
  // Without SMTP nobody has a verified address, so a badge on every row would be noise.
  check("and nothing is flagged where nobody could confirm", userState({ ...person, emailVerified: false }, false), null);
  check(
    "each state reads differently",
    new Set((["disabled", "no_password", "temporary_password", "unverified_email"] as const).map(userStateText)).size,
    4,
  );

  // The email change takes the session alone (Q1.630); `relaycheck` pins the route for both credentials.
  check("the email form asks no proof of its own", /emailChangeNeedsProof|account-email-proof/.test(
    readFileSync(new URL("../src/ui/settings/AccountSection.tsx", import.meta.url), "utf8"),
  ), false);

  // The three dead-link causes must read the same: they are indistinguishable without the token.
  const dead = linkError(new ApiError(409, "token_unusable", "unknown, used or expired"));
  check("an unusable link says one thing", dead.length > 0, true);
  check("and says nothing about which of the three it was", /used|expired/.test(dead) && !/unknown token/.test(dead), true);

  const plain = { id: "u_1", name: "ada", isAdmin: false };
  const admin = { id: "u_2", name: "root", isAdmin: true };

  check("a non-admin sees five rows", navRows(plain).map((row) => row.spec.id), ["account", "devices", "keys", "machines", "logs"]);
  check("and no heading floats over nothing", navRows(plain).every((row) => row.heading === null), true);
  check("an unknown viewer is treated as a non-admin", navRows(null).map((row) => row.spec.id), ["account", "devices", "keys", "machines", "logs"]);
  check(
    "an admin sees eight",
    navRows(admin).map((row) => row.spec.id),
    ["account", "devices", "keys", "machines", "logs", "server", "email", "users"],
  );
  check(
    "with the heading on the first row of its group only",
    navRows(admin).map((row) => row.heading),
    [null, null, null, null, null, "server", null, null],
  );
  const adminIndex = (id: string): number => navRows(admin).findIndex((row) => row.spec.id === id);
  check("and Server sits above Users", adminIndex("server") < adminIndex("users"), true);
  // Email reads as Server's continuation, and Users has the most rows, so it goes last.
  check("with Email between the two", adminIndex("server") < adminIndex("email") && adminIndex("email") < adminIndex("users"), true);
  check("every group has a title", Object.keys(GROUP_TITLES).length >= 1, true);
  check("the admin band is headed \"Admin\"", GROUP_TITLES.server, "Admin");
  check(
    "and no row under it shares a word with its heading",
    navRows(admin)
      .filter((row) => row.spec.group === "server")
      .every((row) => !row.spec.title.toLowerCase().split(/\s+/).includes(GROUP_TITLES.server.toLowerCase())),
    true,
  );

  // One key, one writer: a blur-commit beside Save would make Save clear fields that had just saved themselves.
  const serverSection = readFileSync(
    new URL("../src/ui/settings/ServerSection.tsx", import.meta.url),
    "utf8",
  );
  // The SMTP form is `EmailSection`, and both screens draw `SettingField`, so all three are swept.
  const emailSection = readFileSync(new URL("../src/ui/settings/EmailSection.tsx", import.meta.url), "utf8");
  const settingField = readFileSync(new URL("../src/ui/settings/SettingField.tsx", import.meta.url), "utf8");
  check("no settings field commits on blur", /onBlur=/.test(serverSection + emailSection + settingField), false);
  // Reset is disabled while a write is out, on the primitive and at every call site, since the prop defaults to false.
  // Stripped for the positive, where a docblock quoting the JSX would satisfy it; the raw read above suits the negative.
  const settingFieldCode = settingField.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("SettingField's Reset is disabled while the form is busy", /<Button size="sm" tone="ghost" disabled=\{busy\} onClick=\{onReset\}>/.test(settingFieldCode), true);
  const fieldSites = (serverSection + emailSection).split("<SettingField").slice(1).map((site) => site.slice(0, site.indexOf("/>")));
  check("the two screens draw fields through it", fieldSites.length > 0, true);
  check("and every one of them passes busy", fieldSites.filter((site) => !/busy=\{busy\}/.test(site)).length, 0);
  const emailCode = emailSection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("the secret's state is not re-derived on the screen", /No password|A password is set/.test(emailCode), false);
  check("and the screen asks the one function", /secretFieldText\(/.test(emailCode), true);
  // Removability is `set` alone; presence is `set || envSet`.
  const removeGate = emailCode.indexOf("passwordStored =");
  check("removing the stored password is gated on a row being stored", removeGate >= 0, true);
  check("and the gate reads `set` alone", /passwordStored = passwordField\?\.set === true/.test(emailCode), true);
  check("and the Remove is two-step, naming what goes", /Remove the stored password\?/.test(emailCode), true);
  // The act and its cancel are `TwoStep`'s (Q3.552); this file owns the question and hands the request over whole.
  check(
    "with a plain act, the ghost Remove at rest, and the request handed to the primitive",
    [
      /question="Remove the stored password\?"\s*act=\{\{ label: "Remove" \}\}\s*onAct=\{\(\) => clear\("smtp\.password"\)\}/.test(emailCode),
      /rest=\{\s*<Button size="sm" tone="ghost" disabled=\{busy\} onClick=\{\(\) => setRemoving\(true\)\}>/.test(emailCode),
      /setRemoving\(false\)/.test(emailCode),
    ],
    [true, true, false],
  );
  // `busy` is set in `clear`, which the confirmed Remove and a one-tap Reset both go through, so no second write can start.
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
  // Registration is a badge and a verb, not a switch; only opening, the widening act, is confirmed (Q3.220).
  const serverCode = serverSection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // The badge is read off the server's answer on every render, so it flips only after the server.
  const registration = serverCode.slice(serverCode.indexOf("function Registration("), serverCode.indexOf("function Domains("));
  check("the registration badge reads the answer", /const open = answer\.registration\.enabled;/.test(registration), true);
  check("and is drawn from it", /<Badge tone="strong">\{open \? "Open" : "Closed"\}<\/Badge>/.test(registration), true);
  check("with no state holding a copy", /useState\([^)]*registration|useState<boolean>\(open/.test(registration), false);
  check("flipping only inside .then, through onChanged", /\.then\(\(updated\) => onChanged\(updated\)\)/.test(registration), true);
  // The question closes through the primitive alone, on that promise (Q3.552).
  check("and the question closes on that promise, through the primitive", [/onAct=\{\(\) => save\(true\)\}/.test(registration), /setConfirming\(false\)/.test(registration)], [true, false]);
  check("registration is not drawn as a switch", /role="switch"/.test(serverCode), false);
  check("opening registration asks first", (serverCode.match(/Open registration to anyone\?/g) ?? []).length, 1);
  check("and closing does not", /open \? close\(\) : setConfirming\(true\)/.test(serverCode), true);
  // Remint is two-step and the first mint one tap: a remint's cost lands on somebody else's provisioning script (Q3.219).
  check("reminting the provisioning key asks first", /Replace the provisioning key\?/.test(serverCode), true);
  check("and the first mint does not", /minted \? \(\) => setConfirming\(true\) : mintNow\}/.test(serverCode), true);
  // Save is always drawn and disabled until dirty: appearing on the first keystroke is a layout shift under the finger.
  check("Save is never gated on dirtiness in the JSX", /dirty && \(?\s*<Button/.test(serverCode + emailCode), false);
  check("and is disabled until dirty instead", ((serverCode + emailCode).match(/disabled=\{busy \|\| !dirty/g) ?? []).length, 2);
  const signIn = readFileSync(new URL("../src/ui/SignIn.tsx", import.meta.url), "utf8");
  check("the sign-in screen does not re-derive which doors to draw", /gateOffer\(/.test(signIn), false);

  // Both doors are underlined links on separate lines: with no accent colour the underline is the only cue.
  check("both doors wear the shared link look", signIn.split("${LINK}").length - 1, 2);

  // The doors are absolute anchors to the control plane opened in a new target, built from `controlPlaneOrigin` because the shell's own origin is not the server.
  // Comment-stripped: the docblocks beside these quote the shapes searched for; the `LINK` count above counts a constant and stays raw.
  const signInBody = signIn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check(
    "the two doors are absolute addresses at the control plane",
    (signInBody.match(/href=\{`\$\{authority\}\/(register|forgot)`\}/g) ?? []).length,
    2,
  );
  check("and each opens outside this document", (signInBody.match(/target="_blank"/g) ?? []).length, 2);
  check("the sign-in screen navigates nowhere itself", /navigate\(/.test(signInBody), false);
  check("and never builds an address out of this page's origin", /location\.origin/.test(signInBody), false);
  check("it asks the host where the control plane is", /controlPlaneOrigin\(\)/.test(signInBody), true);
  check("the sign-in screen names no server", /nativeBoot\(\)\?\.server/.test(signInBody), false);
  // Without a way back, a reachable but wrong address would strand somebody: Settings needs a session.
  check("but it offers a way back to the screen that sets one", /pickServer\(\)/.test(signInBody), true);
  check("and that control names a destination rather than an address", /https?:\/\//.test(signInBody), false);
  // Shell only, and only on a window nobody has signed in to: `signInExits` in `slot.ts` is the table.
  check("and it is drawn only where there is somewhere to go", /\{exits\.server && \(/.test(signInBody), true);
  check("and it asks the table rather than the shell", /inNativeShell\(\)/.test(signInBody), false);

  // Remove account is an act, not a link, so the `LINK` look stays on the two doors.
  check(
    "the way back and Remove account act through the seam, never the store",
    [
      /signInAuth\(\)\s*\.switchBack\(\)/.test(signInBody),
      /signInAuth\(\)\s*\.forgetAccount\(\)/.test(signInBody),
      /from "\.\.\/store"|\bstore\.\w+\(/.test(signInBody),
    ],
    [true, true, false],
  );
  check(
    "and are drawn from the table, with the live answer",
    [
      /const back = useBackAccount\(\);/.test(signInBody),
      /signInExits\(nativeBoot\(\), back === undefined \? undefined : \(back\?\.key \?\? null\)\)/.test(signInBody),
      /\{exits\.back && back != null && \(/.test(signInBody),
      /\{exits\.remove && \(/.test(signInBody),
    ],
    [true, true, true, true],
  );
  check("the way back names the account it returns to", /<span className="truncate">\{back\.label\}<\/span>/.test(signInBody), true);
  check("and there is no Cancel beside Sign in", />\s*Cancel\s*</.test(signInBody), false);
  // A bare negated class would stop at the arrow inside an onClick handler, so the tag reader steps over arrows; the report is its positive control.
  const OPENING = /<(?:button|Button)\b(?:=>|[^>])*?>/g;
  report(
    "the tag reader reads past an arrow",
    [...'<button onClick={() => go()} disabled={busy}>'.matchAll(OPENING)].map((m) => m[0]).join("").includes("disabled={busy}"),
    "positive control",
  );
  const controls = [...signInBody.matchAll(OPENING)].map((m) => m[0]);
  report("the sign-in screen's controls were found", controls.length >= 4, `${controls.length} controls`);
  check(
    "every control on it waits for a sign-in in flight",
    controls.filter((c) => !/disabled=\{busy/.test(c)),
    [],
  );

  // The label says both because the login route takes both; `autoComplete` stays username, still the primary way in.
  check("the identifier field offers both ways in", /Username or email/.test(signIn), true);
  check("and still autocompletes as the username it also is", /autoComplete="username"/.test(signIn), true);

  const gateCode = readFileSync(new URL("../src/ui/gate/Gate.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  check("no gate screen tells somebody their account does not exist", /does not exist/.test(gateCode), false);
  check("and confirming is called confirming", /Confirm account/.test(gateCode), true);
  const signInCode = signIn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("and they are not one line with a separator", /·/.test(signInCode), false);
  // `bg-fg` is the affirmative action inside a decision. A navigation is not one.
  const bits = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  const linkDecl = /export const LINK = "([^"]*)"/.exec(bits)?.[1] ?? "";
  check("a link carries an underline", /\bunderline\b/.test(linkDecl), true);
  check("and never a fill", /\bbg-/.test(linkDecl), false);

  // The instance body is parsed, never cast: the server's shape and `InstanceConfig` differ and a generic cannot notice.
  const cpSource = readFileSync(new URL("../src/cp.ts", import.meta.url), "utf8");
  const cpCode = cpSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("the instance config is never cast into its own type", /readJson<InstanceConfig>/.test(cpCode), false);
  check("it goes through the parser", /parseInstanceConfig\(/.test(cpSource), true);
  check(
    "and the SMTP fields are held in one draft",
    emailSection.split("useState<SmtpDraft>").length - 1,
    1,
  );
  check("a clear patches the draft through draftAfterClear", /draftAfterClear\(current, key, synced\)/.test(emailCode), true);
  // The seed is load-only: in a re-sync it would bring back a field somebody emptied on purpose.
  check("the public URL is seeded exactly once", emailCode.split("seedPublicUrl(").length - 1, 1);
  check("in a state initialiser", /useState\(\(\) => seedPublicUrl\(/.test(emailCode), true);
  // Both operands guarded, the `>= 0` idiom: -1 is less than every real position.
  const seedAt = emailCode.indexOf("seedPublicUrl(");
  const draftAt = emailCode.indexOf("useState<SmtpDraft>");
  check("ahead of the draft it seeds", seedAt >= 0 && draftAt >= 0 && seedAt < draftAt, true);
  check("and nowhere after it — not a re-sync, a save or a clear", /seedPublicUrl\(/.test(emailCode.slice(emailCode.indexOf("useState<SmtpDraft>"))), false);
  // The seed dirties the form, so `seeded` keeps the server's diagnosis drawn until an edit of the person's own.
  check("the diagnosis is drawn while the seed is the only edit", /\{\(!dirty \|\| seeded\) &&\s*!answer\.mail\.configured &&\s*answer\.mail\.problems\.map\(/.test(emailCode), true);
  check("seeded starts as the seed's own dirtiness", /const \[seeded, setSeeded\] = useState\(seed\.dirty\);/.test(emailCode), true);
  check("the first edit clears it", /setDraft\(\(current\) => \(\{ \.\.\.current, \.\.\.patch \}\)\);\s*setDirty\(true\);\s*setSeeded\(false\);/.test(emailCode), true);
  check("and so does a save", /setDirty\(false\);\s*setSeeded\(false\);/.test(emailCode), true);
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
