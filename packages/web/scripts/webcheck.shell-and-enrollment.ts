import { readFileSync, readdirSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhat this app says while nobody is looking at it\n");
{
  const appSrc = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  check(
    "the badge counts what the bell counts",
    /const blocked = sessionLists\(state\)\.blocked\.length;/.test(appSrc),
    true,
  );
  check(
    "and it is a prefix on the plain name rather than a second title",
    /document\.title = blocked === 0 \? PAGE_TITLE : `\(\$\{blocked\}\) \$\{PAGE_TITLE\}`;/.test(appSrc),
    true,
  );
  check("and it never outlives the state that put it there", /return \(\) => \{\s*document\.title = PAGE_TITLE;\s*\};/.test(appSrc), true);
  const shipped = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  const named = /const PAGE_TITLE = "([^"]*)";/.exec(appSrc)?.[1] ?? "";
  check("both copies of the name were found", [shipped.length > 0, named.length > 0], [true, true]);
  check("and the tab is called the same thing before and after this app loads", named, shipped);

  const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
  const shell = stripComments(readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8"));
  check("the viewport tag was found", viewport.length > 0, true);
  check(
    "the keyboard moves the layout viewport, and the layout it moves is still there",
    [/\binteractive-widget=resizes-content\b/.test(viewport), /\bh-dvh\b/.test(shell)],
    [true, true],
  );
  check("and the safe area is still opted into", /\bviewport-fit=cover\b/.test(viewport), true);
}

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
  check("typing beats an open card", escapeAction([ask], true), { dismiss: null, stop: false });
  check("and beats an open sheet", escapeAction([sheet, menu], true), { dismiss: null, stop: false });

  check("one layer owns it", escapeAction([ask], false).dismiss, ask.id);
  check("a menu over a card takes it first", escapeAction([ask, menu], false).dismiss, menu.id);
  check("a menu inside a sheet, likewise", escapeAction([sheet, menu], false).dismiss, menu.id);
  check("a sheet over a card takes it", escapeAction([ask, sheet], false).dismiss, sheet.id);

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

  check(
    "bare letters survive a menu and a card, and not a sheet",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [sheet, menu]].map(shortcutsEnabled),
    [true, true, true, true, false, false, false],
  );

  check(
    "a numbered answer survives only the card's own layer",
    [[], [ask], [menu], [ask, menu], [sheet], [ask, sheet], [ask, menu, sheet]].map(decisionShortcutsEnabled),
    [true, true, false, false, false, false, false],
  );

  const uiRoot = new URL("../src/", import.meta.url);
  const keyListeners: string[] = [];
  const sweep = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) sweep(child);
      else if (/\.tsx?$/.test(entry.name) && entry.name !== "overlay.ts") {
        const text = readFileSync(child, "utf8");
        if (text.includes('window.addEventListener("keydown"')) {
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

  const { SHEET_BODY, SHEET_PANEL, SHEET_SCREEN } = await import("../src/ui/bits.js");
  const bodyClasses = SHEET_BODY.split(/\s+/);
  check(
    "a sheet's body is a flex column, so its children's flex-1 means something",
    ["flex", "flex-col", "min-h-0", "flex-1"].map((name) => bodyClasses.includes(name)),
    [true, true, true, true],
  );
  // The sheet body clips and carries no padding: a scroll container overflows by its own end padding and draws bars (Q3.553).
  const unprefixed = (name: string): string => name.replace(/^[a-z0-9-]+:/, "");
  check(
    "and it clips rather than scrolls",
    [bodyClasses.includes("overflow-hidden"), bodyClasses.includes("overflow-y-auto")],
    [true, false],
  );
  check(
    "and pads nothing, so there is no end padding for a child to overflow by",
    bodyClasses.filter((name) => /^p[xytblr]?-/.test(unprefixed(name))),
    [],
  );
  check(
    "and a screen inside it cancels nothing",
    SHEET_SCREEN.split(/\s+/).filter((name) => unprefixed(name).startsWith("-m")),
    [],
  );
  check("and it paints its own ground, so a slide covers what it replaces", bodyClasses.includes("bg-surface"), true);
  check("a sheet's height is definite at both widths", /(^|\s)h-\[/.test(SHEET_PANEL) && /\ssm:h-\[/.test(SHEET_PANEL), true);

  const askCardSrc = readFileSync(new URL("../src/ui/AskCard.tsx", import.meta.url), "utf8");
  check(
    "the ask card's height ceilings are literal classes",
    ["max-h-[min(70dvh,100%)]", "max-h-[min(88dvh,100%)]"].map((cls) => askCardSrc.includes(`"${cls}"`)),
    [true, true],
  );
  check("and neither is built out of an interpolation", /max-h-\[min\(\$\{/.test(askCardSrc), false);
  check("the answer numbers are hidden on a coarse pointer", askCardSrc.includes('"pointer-coarse:hidden"'), true);
  check("and that is asked of the pointer, not of the width", /sm:hidden[^"]*\{index \+ 1\}/.test(askCardSrc), false);
  // Class attributes only: AskCard.tsx's prose may name the word.
  const askCardClasses = [...askCardSrc.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`)/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  check("the scan found the card's class strings", askCardClasses.length >= 10, true);
  check("and none of them clips text", askCardClasses.filter((cls) => /\btruncate\b/.test(cls)), []);
  check("the collapsed bar wraps instead", askCardSrc.includes('text-xs font-medium wrap-anywhere">{title}'), true);
  check(
    "the header's cancel keeps its own group behind a rule",
    /border-l border-edge\/60 pl-1/.test(askCardSrc),
    true,
  );
  check(
    "and the collapsed bar draws no cancel while the open card does",
    [askCardSrc.includes("{controls(false)}"), askCardSrc.includes("{controls(true)}")],
    [true, true],
  );
  check("the footer no longer draws a cancel of its own", /\{cancel\}/.test(askCardSrc), false);
  check(
    "and is drawn only where there is something to put in it",
    /\{\(layout === "buttons" \|\| \(actions !== undefined && actions !== null\)\) && \(/.test(askCardSrc),
    true,
  );
  const sessionViewSrc = readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8");
  const eventListSrcForFoot = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check("the card measures itself for whoever is drawing behind it", /heightOut\.current\?\.\(panel\.offsetHeight\)/.test(askCardSrc), true);
  check("and gives the room back as it goes", /heightOut\.current\?\.\(0\)/.test(askCardSrc), true);
  check(
    "the transcript's own foot is what the card raises",
    /paddingBottom: Math\.max\(TRANSCRIPT_FOOT_PX, askHeight \+ ASK_CLEARANCE\)/.test(eventListSrcForFoot),
    true,
  );
  check("and the scroll box outside it pads nothing", /paddingBottom/.test(stripComments(sessionViewSrc)), false);
  check("and chases the tail when it changes, which no resize reports", /\}, \[askHeight\]\);/.test(sessionViewSrc), true);
  const composerSrc = stripComments(readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8"));
  const gutterOf = (src: string, after: string): string | null => {
    const at = src.indexOf(after);
    if (at < 0) return null;
    return /\bpx-(\d+)\b/.exec(src.slice(at, at + 200))?.[1] ?? null;
  };
  const gutters = {
    transcript: gutterOf(stripComments(eventListSrcForFoot), "${COLUMN} px-"),
    card: gutterOf(stripComments(askCardSrc), "pointer-events-none absolute inset-0 ${COLUMN}"),
    composer: gutterOf(composerSrc, "${COLUMN} px-"),
  };
  check("the three gutters were all found", Object.values(gutters).every((g) => g !== null), true);
  check("and the conversation column has one gutter", gutters, {
    transcript: "4",
    card: "4",
    composer: "4",
  });
  const eventListSrc = readFileSync(new URL("../src/ui/EventList.tsx", import.meta.url), "utf8");
  check(
    "a settled question's row is handed the questions rather than fetching them",
    /<ElicitationResolvedRow event=\{event\} asked=\{node\.asked\} \/>/.test(eventListSrc),
    true,
  );
  check("and draws each one over its answer", /answer\.question \?\? answer\.label/.test(eventListSrc), true);
  const permissionCardSrc = readFileSync(new URL("../src/ui/PermissionCard.tsx", import.meta.url), "utf8");
  check(
    "a plan gets the room because it is a plan, not because of what it is titled",
    /size=\{context\.plan !== null \? "tall" : "normal"\}/.test(permissionCardSrc),
    true,
  );
  check("and nothing on that card matches a plan by its title", permissionCardSrc.includes("Ready to code?"), false);
  check("and never a ceiling it can shrink under", /(^|\s)(sm:)?max-h-/.test(SHEET_PANEL), false);

  check(
    "the overlay paths",
    [
      "/settings",
      "/settings/account",
      "/settings/machines/m_1/systems/anthropic",
      "/new",
      "/new/m_1",
      "/agent/m_1",
      "/agent/m_1/%2Fhome%2Fme",
    ].map(isOverlayPath),
    [true, true, true, true, true, true, true],
  );
  check(
    "and the screens that are not overlays",
    ["/", "/m/m_1/s/s_1"].map(isOverlayPath),
    [false, false],
  );
  check("a longer first segment is not one of them", isOverlayPath("/settingsomething"), false);

  check(
    "every settings section is an overlay path",
    SECTION_SPECS.every((spec) => isOverlayPath(settingsPath(spec.id))),
    true,
  );
}

process.stdout.write("\nnothing names a colour that no longer exists\n");
{
  const RETIRED = ["accent", "accent-ink", "warn", "ok", "offer", "offer-ink"];
  const LIVE = ["add", "add-ink", "del", "del-ink", "caution"];
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

  const pattern = new RegExp(
    `\\b(?:text|bg|border|ring|from|to|fill|stroke|decoration|outline|shadow|divide|accent)-(?:${RETIRED.join("|")})\\b`,
  );
  // Comments are stripped: a docblock may name a retired class while explaining why it went.
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
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  check(
    "and the tokens themselves are gone from @theme",
    RETIRED.filter((name) => new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  check(
    "and the live ones are really declared",
    LIVE.filter((name) => !new RegExp(`^\\s*--color-${name}:`, "m").test(css)),
    [],
  );
  check("the one exception survives", /--color-danger:\s*#7e362b/.test(css), true);

  const spendsCaution = files.flatMap((file) =>
    (
      stripped(readFileSync(file, "utf8")).match(
        /\b(?:text|bg|border|ring|from|to|fill|stroke|decoration|outline|shadow|divide|accent)-caution\b/g,
      ) ?? []
    ).map((cls) => `${file.slice(file.indexOf("/packages/web/src/") + "/packages/web/src/".length)}: ${cls}`),
  );
  check("caution is one word on one chip, and never a fill", spendsCaution, ["tasks.ts: text-caution"]);

  // No module changes the mouse except PaneHandle (col-resize); `files` includes .css, which srcFiles() does not.
  // The declaration arm needs a cursor value, never a bare `cursor:`, because wire.ts declares `cursor: number`.
  const CURSOR_VALUES =
    "pointer|default|not-allowed|text|move|grab|grabbing|wait|help|crosshair|" +
    "zoom-in|zoom-out|none|auto|progress|cell|alias|copy|context-menu|no-drop|" +
    "all-scroll|[a-z]+-resize";
  const cursorPattern = new RegExp(
    `\\bcursor\\s*[:=]\\s*["'\`]?(?:${CURSOR_VALUES})\\b|\\bcursor-(?:${CURSOR_VALUES})\\b`,
  );
  const CURSOR_ALLOWED: readonly string[] = ["src/ui/PaneHandle.tsx"];
  const cursorOffenders = files
    .filter((file) => cursorPattern.test(stripped(readFileSync(file, "utf8"))))
    .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length));
  check("the sweep can see a declaration", cursorPattern.test("cursor: pointer;"), true);
  // Assembled, never written out: Tailwind scans scripts/ too, so a literal class here would compile into both builds.
  const utilityProbe = "cursor" + "-pointer";
  check("and one written as a utility", cursorPattern.test(`className="tap ${utilityProbe}"`), true);
  check("and one written as an inline style", cursorPattern.test('style={{ cursor: "pointer" }}'), true);
  check("and it does not see the wire's byte cursor", cursorPattern.test("  cursor: number;"), false);
  check("nor its assignments", [cursorPattern.test("cursor = next;"), cursorPattern.test("cursor?: string;")], [false, false]);
  check("one control changes the mouse, and it is named", cursorOffenders.sort(), [...CURSOR_ALLOWED].sort());
  // The utility arm also runs over raw text in src/ and scripts/, since Tailwind's scanner reads comments.
  const rawUtility = new RegExp(`\\bcursor-(?:${CURSOR_VALUES})\\b`);
  const authored: string[] = [...files];
  const scriptsDir = new URL("./", import.meta.url);
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) authored.push(new URL(entry.name, scriptsDir).pathname);
  }
  report("both authored trees are in the second sweep", authored.length > files.length, `${authored.length} files`);
  check("the raw sweep can see the class spelling", rawUtility.test(`x ${utilityProbe} y`), true);
  check(
    "and nobody writes it, comments included, since the scanner reads those too",
    authored
      .filter((file) => rawUtility.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(file.indexOf("/packages/web/") + "/packages/web/".length))
      .sort(),
    [...CURSOR_ALLOWED].sort(),
  );

  // `navigator.clipboard` exists only in a secure context, so only ui/clipboard.ts may name it, and it keeps an execCommand fallback.
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

// router.ts parses the path in its module body, so pathname is set before the import and the import is the assertion.

process.stdout.write("\na URL that will not decode\n");
{
  const stub = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;
  const loc = stub["location"] as Record<string, unknown>;
  const go = (path: string): void => void (loc["pathname"] = path);
  stub["addEventListener"] = (): void => {};
  stub["history"] = {
    pushState: (_state: unknown, _title: string, path: string): void => go(path),
    replaceState: (_state: unknown, _title: string, path: string): void => go(path),
  };

  go("/m/m_1/s/s_1%");

  let router: typeof import("../src/router.js") | null = null;
  let loadError: string | null = null;
  try {
    router = await import("../src/router.js");
  } catch (cause) {
    loadError = String(cause);
  }
  // Reported rather than checked, so a failure here does not take the enrollment section below with it.
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
    check("nor does a machine id that will not decode", threw("/m/m_1%/s/s_1"), null);
    check("nor does /new with one", threw("/new/m_1%"), null);
    check("nor does an escape that begins and does not finish", threw("/m/%E0%A4%A/s/x"), null);

    check("what this app builds is encoded", sessionPath({ machineId: "m_1%", sessionId: "s_1%" } as never), "/m/m_1%25/s/s_1%25");
    check("and so is a new-session link", newPath("m_1%" as never), "/new/m_1%25");
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

// Both values are single-quoted: the control-plane URL derives from the request's Host header, so unquoted it is shell source.
// cpctl.ts prints the same lines from its own copy; its body is run below and compared.

process.stdout.write("\nthe three lines a daemon is started with\n");
{
  const { enrollmentLines, enrollmentExpiryText } = await import("../src/enrollment.js");

  check(
    "exactly what cpctl prints",
    enrollmentLines("https://cp.example", "ec_abc"),
    "export REEMOAT_AUTH=signed\nexport REEMOAT_CONTROL_PLANE='https://cp.example'\nexport REEMOAT_ENROLL_CODE='ec_abc'",
  );
  check("the constant line carries no quotes", enrollmentLines("https://cp", "ec").split("\n")[0], "export REEMOAT_AUTH=signed");

  const urlLine = (url: string): string | undefined => enrollmentLines(url, "ec_x").split("\n")[1];
  check("a backtick is data", urlLine("http://a`id`b"), "export REEMOAT_CONTROL_PLANE='http://a`id`b'");
  check("so is a command substitution", urlLine("http://a$(id)b"), "export REEMOAT_CONTROL_PLANE='http://a$(id)b'");
  check("so is a semicolon", urlLine("http://a;id"), "export REEMOAT_CONTROL_PLANE='http://a;id'");
  check("and so is an ampersand", urlLine("http://a&id"), "export REEMOAT_CONTROL_PLANE='http://a&id'");
  check(
    "an apostrophe cannot close the quoting",
    urlLine("http://a'b"),
    "export REEMOAT_CONTROL_PLANE='http://a'\\''b'",
  );
  check(
    "the code is quoted by the same rule",
    enrollmentLines("https://cp", "ec_a'b").split("\n")[2],
    "export REEMOAT_ENROLL_CODE='ec_a'\\''b'",
  );

  // Runs a top-level function's body read off disk, because cpctl.ts and app.ts cannot be imported here.
  // Only `: string` is stripped; any other annotation, a rename or nesting must throw rather than skip the comparison.
  const extract = (
    source: string,
    name: string,
    params: readonly string[],
  ): ((...args: string[]) => string) => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
    if (start < 0) throw new Error(`no top-level ${name} to extract`);
    // A top-level declaration in these files ends at a bare `}` in column 0,
    // which is why this does not have to count braces through template literals.
    const end = lines.indexOf("}", start);
    if (end < 0) throw new Error(`${name} has no closing brace in column 0`);
    const body = lines.slice(start + 1, end).join("\n").replaceAll(": string", "");
    return new Function(...params, body) as (...args: string[]) => string;
  };

  const callable = (source: string): ((url: string, code: string, baseUrl: string) => string) =>
    extract(source, "enrollmentLines", ["controlPlaneUrl", "code", "BASE_URL"]) as (
      url: string,
      code: string,
      baseUrl: string,
    ) => string;

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
  check(
    "cpctl's only divergence is its BASE_URL fallback",
    cpctl("", "ec_x", "https://fallback"),
    enrollmentLines("https://fallback", "ec_x"),
  );

  const extractionFails = (source: string): boolean => {
    try {
      callable(source);
      return false;
    } catch {
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
  check(
    "and neither is an annotation this cannot strip",
    extractionFails("function enrollmentLines(a, b) {\n  const q = (v: URL) => String(v);\n  return q(a);\n}\n"),
    true,
  );
  check(
    "while the shape cpctl actually has is extracted",
    extractionFails("function enrollmentLines(controlPlaneUrl: string, code: string): string {\n  return controlPlaneUrl;\n}\n"),
    false,
  );

  // app.ts keeps its own `shellQuote` for GET /install.sh (the image carries no web src), so it runs over the same hostile table.
  {
    const quoteOf = (source: string): ((value: string) => string) =>
      extract(source, "shellQuote", ["value"]) as (value: string) => string;
    const webQuote = quoteOf(readFileSync(new URL("../src/enrollment.ts", import.meta.url), "utf8"));
    const appQuote = quoteOf(
      readFileSync(new URL("../../control-plane/src/app.ts", import.meta.url), "utf8"),
    );
    for (const hostile of [
      "https://cp.example",
      "http://a`id`b",
      "http://a$(id)b",
      "http://a'b",
      "http://a;id",
      "http://a$&b",
      "http://a''b",
    ]) {
      check(`app.ts quotes ${JSON.stringify(hostile)} as web does`, appQuote(hostile), webQuote(hostile));
    }
    check("an apostrophe is closed, escaped and reopened", appQuote("a'b"), "'a'\\''b'");
  }

  {
    const { installCommand } = await import("../src/enrollment.js");
    check(
      "the installer command is the literal both READMEs carry",
      installCommand("https://app.reemoat.com"),
      "curl -fsSL 'https://app.reemoat.com/install.sh' | sh",
    );
    check("a trailing slash does not double", installCommand("https://cp/"), installCommand("https://cp"));
    check(
      "and the origin is data, not source",
      installCommand("http://a`id`b"),
      "curl -fsSL 'http://a`id`b/install.sh' | sh",
    );
  }

  // NewSession.tsx's empty machine line leaves the command out: its Add a machine button already leads to Settings → Machines, which prints it.
  {
    const reads = (path: string): string =>
      stripComments(readFileSync(new URL(`../src/ui/${path}`, import.meta.url), "utf8"));
    const browser = reads("SessionBrowser.tsx");
    const machines = reads("settings/MachinesSection.tsx");
    const shell = reads("AppShell.tsx");
    const newSession = reads("NewSession.tsx");
    check(
      "the three screens with room for it call the one renderer",
      [/installCommand\(/.test(browser), /installCommand\(/.test(machines), /installCommand\(/.test(shell)],
      [true, true, true],
    );
    check(
      "and none writes the command out by hand",
      [/curl -fsSL/.test(browser), /curl -fsSL/.test(machines), /curl -fsSL/.test(shell)],
      [false, false, false],
    );
    check("the new-session strip does not draw it", /installCommand/.test(newSession), false);
    const doorAt = shell.indexOf("mayAddMachine(state.me) ? (");
    const commandAt = shell.indexOf("installCommand(");
    const otherArmAt = doorAt < 0 ? -1 : shell.indexOf(") : (", doorAt);
    const noticeAt = shell.indexOf("machineQuotaNotice(");
    check(
      "the command is inside the door arm, not beside the notice",
      [
        /mayAddMachine\(state\.me\) \? \([\s\S]{0,1200}installCommand\(/.test(browser),
        /canAdd \? \([\s\S]{0,200}<CommandLine command=\{installCommand\(/.test(machines),
        doorAt >= 0 && doorAt < commandAt && commandAt < otherArmAt && otherArmAt < noticeAt,
      ],
      [true, true, true],
    );

    // docs/DECISIONS.md cites these names, and docscheck resolves them from this list (Q1.650).
    const GONE = ["MachineOffer", "machineOffer", "machineOfferHref"];
    check(
      "nothing in the client draws or builds a machine offer",
      srcFiles().filter((file) => GONE.some((name) => stripComments(srcFile(file)).includes(name))),
      [],
    );
  }

  const now = 1_700_000_000_000;
  check("time left is said in minutes", enrollmentExpiryText(now + 58 * 60_000, now), "expires in 58m");
  check("and in hours when there are some", enrollmentExpiryText(now + 61 * 60_000, now), "expires in 1h 1m");
  check("a spent code says so", enrollmentExpiryText(now - 1, now), "expired");
}

// The rail width reaches the DOM as a custom property: a React-owned width snaps back whenever the store publishes.

process.stdout.write("\nhow wide the rail is\n");
{
  const { MACHINE_COLUMN_PX, RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, clampRailWidth } = await import("../src/ui/rail.js");

  check("the bounds leave a usable range and the default is inside it", [RAIL_MIN < RAIL_DEFAULT, RAIL_DEFAULT < RAIL_MAX], [
    true,
    true,
  ]);
  check("a rail nobody has dragged has a width to announce", (await import("../src/ui/rail.js")).rail.width(), RAIL_DEFAULT);
  check(
    "the bounds are the machine column plus the list's own three numbers",
    [RAIL_MIN - MACHINE_COLUMN_PX, RAIL_DEFAULT - MACHINE_COLUMN_PX, RAIL_MAX - MACHINE_COLUMN_PX],
    [240, 312, 480],
  );
  const columnSrc = stripComments(readFileSync(new URL("../src/ui/MachineColumn.tsx", import.meta.url), "utf8"));
  check(
    "and the machine column is drawn at that width, in that unit",
    [
      new RegExp(`w-\\[${MACHINE_COLUMN_PX}px\\]`).test(columnSrc),
      /w-\[[\d.]+r?em\]/.test(columnSrc),
    ],
    [true, false],
  );

  check("a width inside the bounds is kept", clampRailWidth(360), 360);
  check("too narrow is refused rather than allowed", clampRailWidth(10), RAIL_MIN);
  check("and so is too wide", clampRailWidth(4000), RAIL_MAX);
  check("the bounds are inclusive", [clampRailWidth(RAIL_MIN), clampRailWidth(RAIL_MAX)], [RAIL_MIN, RAIL_MAX]);
  check("a fractional pointer position is rounded", clampRailWidth(360.6), 361);

  check("a hand-edited storage value cannot produce a rail of NaN", clampRailWidth(Number.NaN), RAIL_DEFAULT);
  check("nor can an infinity", [clampRailWidth(Infinity), clampRailWidth(-Infinity)], [RAIL_DEFAULT, RAIL_DEFAULT]);

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

  setRailWidth(RAIL_DEFAULT + 40);
  check("committing the same width again tells nobody", notified, 1);

  setRailWidth(9999);
  check("a width past the bound commits the bound", railWidth(), RAIL_MAX);
  check("and that is a change, so it is announced", notified, 2);

  unsubscribe();
  setRailWidth(RAIL_DEFAULT);
  check("and an unsubscribed listener stops hearing", notified, 2);
  check("while the value still moved", railWidth(), RAIL_DEFAULT);

  const shell = stripComments(readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8"));
  check(
    "the width reaches the rail as a custom property, not a React style prop",
    /lg:w-\[var\(--rail-w\)\]/.test(shell),
    true,
  );
  check("and nothing sets an inline width on the aside", /<aside[^>]*style=/.test(shell), false);
  check("the committed width is synced onto documentElement by the shell", /setProperty\("--rail-w"/.test(shell), true);
  const paneHandle = stripComments(readFileSync(new URL("../src/ui/PaneHandle.tsx", import.meta.url), "utf8"));
  const panelForHandle = stripComments(readFileSync(new URL("../src/ui/TaskPanel.tsx", import.meta.url), "utf8"));
  check(
    "the two draggable panes share one separator, and each says which way it grows",
    [
      /<PaneHandle pane=\{rail\} label="Sidebar width" sign=\{1\}/.test(shell),
      /pane=\{taskPane\}[\s\S]{0,120}sign=\{-1\}/.test(panelForHandle),
    ],
    [true, true],
  );
  check("the drag writes the pane's property directly", /style\.setProperty\(pane\.prop,/.test(paneHandle), true);
  check(
    "the handle is bounded by the same helper the store is",
    /pane\.clamp\(origin\.width \+ sign \* \(event\.clientX - origin\.x\)\)/.test(paneHandle),
    true,
  );
  check(
    "a press that never moved commits no width",
    [/moved\.current = false;/.test(paneHandle), /if \(commit && moved\.current\)/.test(paneHandle)],
    [true, true],
  );
  check("and a pane that unmounts mid-drag gives its property back", /\(\) => \(\) => \{\s*if \(from\.current === null\) return;/.test(paneHandle), true);
  check("a focusable separator always has a position to announce", /aria-valuenow=\{announced \?\? declared\(\)\}/.test(paneHandle), true);
  check(
    "and neither separator is reachable by a finger",
    [
      /lg:\[@media\(pointer:fine\)\]:block/.test(shell),
      /md:\[@media\(pointer:fine\)\]:block/.test(panelForHandle),
      /\blg:block\b/.test(shell),
      /\bmd:block\b/.test(panelForHandle),
    ],
    [true, true, false, false],
  );
  check("the drag captures its pointer", /setPointerCapture\(event\.pointerId\)/.test(paneHandle), true);
  check(
    "and adds no window listener to leak",
    /window\.addEventListener\("pointer/.test(paneHandle) || /window\.addEventListener\("pointer/.test(shell),
    false,
  );
  check(
    "the separator asks CSS what it declared rather than asking how wide the window is",
    [/getComputedStyle\(document\.documentElement\)/.test(paneHandle), /matchMedia|innerWidth|clientWidth/.test(paneHandle)],
    [true, false],
  );
  check(
    "a cancelled gesture on a pane with no committed width gives the property back",
    /if \(settled === null\) document\.documentElement\.style\.removeProperty\(pane\.prop\);/.test(paneHandle),
    true,
  );

  const { TASK_DEFAULT, TASK_MAX, TASK_MIN, subscribeTaskWidth, taskPane, taskWidth } = await import(
    "../src/ui/taskWidth.js"
  );
  check("the bounds leave a usable range around both declared widths", [TASK_MIN < TASK_DEFAULT, TASK_DEFAULT < TASK_MAX], [true, true]);
  check("a width nobody has chosen is unset rather than a default", taskWidth(), null);

  let toldTask = 0;
  const stopTask = subscribeTaskWidth(() => void (toldTask += 1));
  taskPane.setWidth(TASK_DEFAULT + 24);
  check("a committed width is readable back", taskWidth(), TASK_DEFAULT + 24);
  check("and every subscriber is told", toldTask, 1);
  check("and it is written where a reload will find it", storage.get("reemoat.taskWidth"), String(TASK_DEFAULT + 24));
  taskPane.setWidth(9999);
  check("a width past the bound commits the bound", taskWidth(), TASK_MAX);
  taskPane.setWidth(1);
  check("and too narrow is refused rather than allowed", taskWidth(), TASK_MIN);
  check("a hand-edited storage value cannot produce a panel of NaN", taskPane.clamp(Number.NaN), TASK_DEFAULT);
  taskPane.reset();
  check("a reset hands the stylesheet's two answers back", [taskWidth(), storage.get("reemoat.taskWidth")], [null, undefined]);
  const afterFirstReset = toldTask;
  taskPane.reset();
  check("and resetting an already-unset pane tells nobody twice", toldTask - afterFirstReset, 0);
  stopTask();

  check("the handle is on the z-order table rather than a literal", /\$\{LAYER\.header\}/.test(shell), true);
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

  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
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

process.stdout.write("\nthe menu, the machines and the build\n");
{
  const drawer = stripComments(readFileSync(new URL("../src/ui/MenuDrawer.tsx", import.meta.url), "utf8"));
  const column = stripComments(readFileSync(new URL("../src/ui/MachineColumn.tsx", import.meta.url), "utf8"));
  const browser = stripComments(readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8"));
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const { shortcutsEnabled } = await import("../src/ui/overlay.js");
  report("all three surfaces were found to read", [drawer.length, column.length, browser.length].every((n) => n > 500), "three files, none of them empty");

  check(
    "the drawer covers the app rather than docking beside it",
    [/useDismissible\("sheet"/.test(drawer), /useDismissible\("menu"/.test(drawer)],
    [true, false],
  );
  check("so a drawer on the stack silences the bare-letter shortcuts", shortcutsEnabled([{ id: 91, kind: "sheet" }]), false);
  const layerActive = /useDismissible\("sheet",\s*onClose,\s*([A-Za-z_$][\w$]*)\)/.exec(drawer)?.[1] ?? "";
  const mountGuard = /if \(!([A-Za-z_$][\w$]*)\) return null;/.exec(drawer)?.[1] ?? "";
  report(
    "the layer's lifetime and the panel's were both found",
    layerActive.length > 0 && mountGuard.length > 0,
    `layer on ${layerActive}, mounted on ${mountGuard}`,
  );
  check("the sheet layer lives exactly as long as the panel it covers the app with", layerActive, mountGuard);

  // No close button in the drawer head, by the owner's call; the remaining exits are asserted to work (Q3.628).
  const CLOSER = /<IconButton[^>]*?label="Close[^"]*"[\s\S]{0,240}?\/>/;
  report(
    "the close-control sweep can see one",
    CLOSER.test('<IconButton icon={X} label="Close menu" onClick={onClose} size="nav" />'),
    "positive control",
  );
  check("the drawer draws no close control of its own", CLOSER.test(drawer), false);
  check(
    "and the two ways out that remain are both wired",
    [/useDismissible\("sheet", onClose, shown\)/.test(drawer), /onClick=\{leaving \? undefined : onClose\}/.test(drawer)],
    [true, true],
  );
  // Read un-stripped on purpose: what is asserted is MenuDrawer.tsx's own paragraph recording that call.
  const drawerRaw = readFileSync(new URL("../src/ui/MenuDrawer.tsx", import.meta.url), "utf8");
  const prose = (text: string): string => text.replace(/\n[ \t]*\*?/g, " ").replace(/\s+/g, " ");
  const RECORDED: Array<[string, RegExp]> = [
    ["the call that deleted it", /There was a ✕ here and it is gone by the owner's call/],
    ["the exits that remain", /the ways out are now: Escape/],
    ["the population left with none of them", /leaves without one is a screen-reader user on \*\*iOS\*\*/],
    ["the entry that argues both", /Q3\.628/],
  ];
  report(
    "the drawer was read a second time with its comments intact",
    drawerRaw.length > drawer.length,
    `${drawerRaw.length} raw against ${drawer.length} stripped`,
  );
  check(
    "the head records the call, the exits that remain and who is left with none",
    RECORDED.filter(([, re]) => !re.test(prose(drawerRaw))).map(([what]) => what),
    [],
  );
  check(
    "and every one of those is prose, which is why this one read is not stripped",
    RECORDED.filter(([, re]) => re.test(prose(drawer))).map(([what]) => what),
    [],
  );
  check("it announces itself as modal, which the inert it installs makes true", [/role="dialog"/.test(drawer), /aria-modal="true"/.test(drawer)], [true, true]);
  const scrimAt = drawer.indexOf("aria-hidden={true}");
  const scrimEnd = scrimAt < 0 ? -1 : drawer.indexOf("/>", scrimAt);
  const scrim = scrimAt >= 0 && scrimEnd > scrimAt ? drawer.slice(scrimAt, scrimEnd) : "";
  report("the scrim element was found, both ends anchored", scrim.length > 0 && scrim.length < 600, `${scrim.length} chars`);
  check(
    "the scrim swallows no taps once it is only a fade",
    [/pointer-events-none/.test(scrim), /onClick=\{leaving \?/.test(scrim)],
    [true, true],
  );

  const insetOf = (name: string): string =>
    /(?:^|\s)(px-[\w.[\]/-]+)/.exec(new RegExp(`const ${name} = "([^"]*)"`).exec(drawer)?.[1] ?? "")?.[1] ?? "";
  const rowInset = insetOf("DRAWER_ROW");
  const headingInset = insetOf("DRAWER_HEADING");
  report("both insets were read off the drawer's own constants", rowInset.length > 0 && headingInset.length > 0, `rows ${rowInset}, heading ${headingInset}`);
  check("the heading over these rows shares their left edge", headingInset, rowInset);
  check("and the popover's heading is not borrowed for them", /MENU_HEADING/.test(drawer), false);
  const headingClasses = /const DRAWER_HEADING = "([^"]*)"/.exec(drawer)?.[1] ?? "";
  check(
    "and it is the same caps idiom at the menu's tone",
    ["text-2xs", "font-semibold", "tracking-wider", "uppercase", "text-faint"].every((part) => headingClasses.includes(part)),
    true,
  );
  check(
    "it is portaled beside #root, which is the element inert lands on",
    /createPortal\(/.test(drawer) && /document\.body/.test(drawer),
    true,
  );
  check("it paints from the z-order table rather than a literal", /\$\{LAYER\.overlay\}/.test(drawer), true);
  check("and reads no breakpoint in JavaScript", /matchMedia|innerWidth|clientWidth/.test(drawer), false);
  check("there is no hand-rolled focus trap", /tabIndex/.test(drawer), false);

  check(
    "the drawer arrives from its edge, over the one scrim this app has",
    [/animate-drawer/.test(drawer), /animate-scrim/.test(drawer), /bg-fg\/25/.test(drawer)],
    [true, true, true],
  );
  const sheetMs = /--animate-sheet:\s*sheet\s+(\d+)ms/.exec(css)?.[1] ?? "";
  const drawerMs = /--animate-drawer:\s*drawer\s+(\d+)ms/.exec(css)?.[1] ?? "";
  report("both movements were found in the stylesheet", sheetMs.length > 0 && drawerMs.length > 0, `sheet ${sheetMs}ms, drawer ${drawerMs}ms`);
  check("and the drawer travels on the sheet's clock", drawerMs, sheetMs);
  check("its keyframe moves on the inline axis", /@keyframes drawer \{\s*from \{\s*transform: translateX\(-100%\);/.test(css), true);
  check("and it does not try to leave by reversing its arrival", /animate-drawer[^"`]*\breverse\b/.test(drawer), false);
  const outMs = /--animate-drawer-out:\s*drawer-out\s+(\d+)ms[^;]*\bboth\b/.exec(css)?.[1] ?? "";
  report("the departure was found, and it fills forwards", outMs.length > 0, `${outMs}ms both`);
  const waitMs = /DRAWER_EXIT_MS = (\d+);/.exec(drawer)?.[1] ?? "";
  check("the panel waits exactly as long as the movement it is playing", waitMs, outMs);
  check(
    "and the scrim leaves with it rather than blinking out",
    /animate-scrim-out/.test(drawer) && /@keyframes drawer-out/.test(css),
    true,
  );
  const leaving = stripComments(readFileSync(new URL("../src/ui/leaving.ts", import.meta.url), "utf8"));
  check(
    "the exit is derived during render rather than scheduled after the commit",
    [/if \(open !== wasOpen\.current\)/.test(leaving), /\}, \[open\]\);/.test(leaving)],
    [true, false],
  );
  check(
    "and it ends on the element's own movement, with the constant only as a backstop",
    [
      /event\.target !== event\.currentTarget/.test(leaving),
      /animationName/.test(leaving),
      /window\.setTimeout\(\(\) => \{\s*setLeaving\(false\);?\s*\}, backstopMs\)|setTimeout\(\(\) => setLeaving\(false\), backstopMs\)/.test(leaving),
    ],
    [true, false, true],
  );
  const drawerCalls = /useLeaving\(open, DRAWER_EXIT_MS\)/.test(drawer);
  const panelCalls = /useLeaving\(open, TASK_PANEL_EXIT_MS\)/.test(
    stripComments(readFileSync(new URL("../src/ui/TaskPanel.tsx", import.meta.url), "utf8")),
  );
  check("and both surfaces that keep a layer past its close are callers", [drawerCalls, panelCalls], [true, true]);

  const destinations = [...drawer.matchAll(/go\(([A-Za-z_$][\w$]*\([^)]*\))\)/g)].map((m) => m[1]);
  check("the drawer's destinations, in order and no others", destinations, [
    "settingsPath()",
    "marketPath()",
    "pluginPath(machine, plugin.id)",
  ]);
  check("and nothing navigates except the helper itself", (drawer.match(/navigate\(/g) ?? []).length, 1);
  check(
    "and each goes through the helper that closes the drawer first",
    /const go = [\s\S]{0,80}?onClose\(\);\s*navigate\(path\);/.test(drawer),
    true,
  );
  const buttons = [...drawer.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
  report(
    "the button reader sees a face inside a button written with an arrow",
    [...'<button onClick={() => x}>\n<Monogram size="lg" />\n</button>'.matchAll(/<button\b[\s\S]*?<\/button>/g)].some((m) =>
      /size="lg"/.test(m[0]),
    ),
    "positive control",
  );
  report("the drawer's buttons were found", buttons.length >= 6, `${buttons.length} buttons`);
  check(
    "it opens with who you are, and the face is not itself a control",
    [/<Monogram /.test(drawer), /<Monogram [^>]*size="lg"/.test(drawer), buttons.filter((b) => /size="lg"/.test(b)).length],
    [true, true, 0],
  );
  check("and it draws a face rather than a letter", /personEmoji\(name\)/.test(drawer) && /size="md"/.test(drawer), true);
  check("and every account's row draws one too", /personEmoji\(account\.name\)/.test(drawer), true);

  // In the shell the name under the face discloses this computer's accounts; a browser keeps its plain head (Q3.642).
  check("the account panel is the shell's alone", /const native = state\.host !== null;/.test(drawer), true);
  check(
    "and the browser keeps its plain head",
    /\{!native && \(\s*<div className="flex shrink-0 items-center gap-3 px-3 pt-3 pb-4">/.test(drawer),
    true,
  );
  check(
    "a disclosure over a fold that is inert while closed",
    [/aria-expanded=\{expanded\}/.test(drawer), /aria-controls=\{id\}/.test(drawer), /inert=\{!expanded\}/.test(drawer), /grid-rows-\[0fr\]/.test(drawer)],
    [true, true, true, true],
  );
  check(
    "and it navigates nowhere",
    buttons.filter((b) => /aria-expanded/.test(b) && /navigate\(|\bgo\(/.test(b)).length,
    0,
  );
  check("acts close the panel before they ask the store", /const act = [\s\S]{0,80}?onClose\(\);/.test(drawer), true);
  check(
    "switching and adding go through the store",
    [/act\(\(\) => store\.switchAccount\(account\.key\)\)/.test(drawer), /act\(\(\) => store\.addAccount\(\)\)/.test(drawer)],
    [true, true],
  );
  check("and Add account only while the host has room for one", /accounts\?\.canAdd === true && \(/.test(drawer), true);
  check("the list is the host's, read when the panel opens", /nativeAccounts\(\)\.then/.test(drawer), true);
  check(
    "the current account is ringed rather than outlined, and marked current",
    [/ring-2 ring-fg ring-offset-2 ring-offset-surface/.test(drawer), /\boutline-/.test(drawer), /aria-current="true"/.test(drawer)],
    [true, false, true],
  );
  check("and it is a row, not a button", buttons.filter((b) => /aria-current/.test(b)).length, 0);
  check(
    "the list's faces are smaller than the head's",
    [(drawer.match(/size="row"/g) ?? []).length >= 2, /personEmoji\(account\.name\)\} size="md"/.test(drawer)],
    [true, false],
  );
  check("a rule under the head, drawn whether or not the fold is open", /\{children\}\s*<div className="mt-2 border-t border-edge" \/>/.test(drawer), true);
  check(
    "and the fold is remembered: read on every mount, kept only while open",
    [
      /useState\(readAccountsOpen\)/.test(drawer),
      /if \(open\) window\.localStorage\.setItem\(ACCOUNTS_OPEN_KEY, "1"\);\s*else window\.localStorage\.removeItem\(ACCOUNTS_OPEN_KEY\);/.test(drawer),
      /setExpanded\(!expanded\);\s*writeAccountsOpen\(!expanded\);/.test(drawer),
    ],
    [true, true, true],
  );
  check(
    "the chevron turns on the child, not the row",
    [/<Icon\s+as=\{ChevronDown\}[\s\S]{0,120}?transition-transform[\s\S]{0,80}?rotate-180/.test(drawer), /transition/.test(/const DRAWER_ROW = "([^"]*)"/.exec(drawer)?.[1] ?? "transition")],
    [true, false],
  );
  check(
    "each account's server is drawn in mono at the step below its name",
    (drawer.match(/font-mono text-2xs text-muted">\{serverLabel\(/g) ?? []).length,
    2,
  );
  check("and signed out is a word at the trailing edge, where the host says so", /\{!account\.signedIn && <span className="shrink-0 text-2xs text-faint">signed out<\/span>\}/.test(drawer), true);
  const { personEmoji } = await import("../src/ui/bits.js");
  const faces = ["admin", "rends", "someone else", "Ада", "🙂 leading emoji"].map((n) => personEmoji(n));
  check("a face is the same one every time it is asked", faces, ["admin", "rends", "someone else", "Ада", "🙂 leading emoji"].map((n) => personEmoji(n)));
  check("an empty name still gets one rather than a blank circle", personEmoji(null).length > 0 && personEmoji("").length > 0, true);
  report("and the names tried here do not all land on one face", new Set(faces).size > 1, `${new Set(faces).size} of ${faces.length}`);
  const bitsSrc = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
  check("and nothing rolls it", /Math\.random/.test(bitsSrc), false);
  const faceList = /const FACES = \[([^\]]*)\]/.exec(bitsSrc)?.[1] ?? "";
  report("the face list was found", faceList.length > 0, `${(faceList.match(/"/g) ?? []).length / 2} faces`);
  check("every face is one code point", [/\u200d/.test(faceList), /\ufe0f/.test(faceList)], [false, false]);
  check("and the foot carries the build and no wordmark", [/Version \{APP_VERSION\}/.test(drawer), /<Mark\b/.test(drawer)], [true, false]);
  const versionRow = /<div className="([^"]*)">Version \{APP_VERSION\}/.exec(drawer)?.[1] ?? "";
  report("the build line's own element was found", versionRow.length > 0, versionRow);
  check(
    "the build is a stamp under the rows rather than one more of them",
    [/\btext-center\b/.test(versionRow), /\btext-faint\b/.test(versionRow), /\btext-muted\b/.test(versionRow)],
    [true, true, false],
  );
  const rowClasses = /const DRAWER_ROW = "([^"]*)"/.exec(drawer)?.[1] ?? "";
  const nameRow = /<span className="([^"]*)">\{name \?\? "Signed in"\}/.exec(drawer)?.[1] ?? "";
  report("the row and the name were both read", rowClasses.length > 0 && nameRow.length > 0, `${rowClasses} | ${nameRow}`);
  check(
    "nothing in the drawer is emphasised, and the caps band keeps its weight",
    [/font-/.test(rowClasses), /font-/.test(nameRow), /font-semibold/.test(headingClasses)],
    [false, false, true],
  );
  const names = [
    ...[...drawer.matchAll(/<span className="([^"]*)">\{name \?\? "Signed in"\}/g)].map((m) => m[1] ?? ""),
    ...[...drawer.matchAll(/<span className="([^"]*)">\{account\.name \?\? serverLabel\(account\.origin\)\}/g)].map((m) => m[1] ?? ""),
  ];
  report("every name the drawer draws was read", names.length >= 3, `${names.length} names`);
  check("and none of them carries a weight", names.filter((n) => /font-/.test(n)), []);
  check("the one extra fact is still drawn only when it is true", /me\?\.via === "api_key"/.test(drawer), true);
  const signOutAt = drawer.indexOf("store.signOut()");
  const versionAt = drawer.indexOf("Version {APP_VERSION}");
  report("the way out and the build line were both found", signOutAt > 0 && versionAt > 0, `${signOutAt} then ${versionAt}`);
  check(
    "the way out is separated, drawn as a refusal, and sits above the build line",
    [/border-t border-edge/.test(drawer), /text-danger/.test(drawer), signOutAt < versionAt],
    [true, true, true],
  );
  check(
    "the machine's plugin screens survived the move, still gated on there being some",
    /screenPlugins\(/.test(drawer) && /launchable\.length > 0/.test(drawer),
    true,
  );
  check("and the help popover left with the footer it sat in", /HelpButton/.test(drawer) || /HelpButton/.test(browser), false);

  const TRIGGER = /(?:<IconButton[^>]*label="Menu"|aria-label="Menu")[\s\S]{0,320}?(?:\/>|<\/button>)/;
  report(
    "the trigger sweep can see both spellings",
    TRIGGER.test('<IconButton icon={MenuIcon} label="Menu" size="chip" />') &&
      TRIGGER.test('<button aria-label="Menu" className="x"><Icon /></button>'),
    "positive control",
  );
  const phoneTrigger = TRIGGER.exec(browser)?.[0] ?? "";
  const deskTrigger = TRIGGER.exec(column)?.[0] ?? "";
  check("the list header opens the menu, and so does the machine column", [phoneTrigger.length > 0, deskTrigger.length > 0], [true, true]);
  check("the list header's copy is withdrawn where the column draws one", /lg:hidden/.test(phoneTrigger), true);
  check("and the column's needs no breakpoint, being inside the lg aside", /\blg:/.test(deskTrigger), false);

  report("the call sweep can see one", /machineTabs\(/.test("machineTabs(groups, view)"), "positive control");
  for (const [what, code] of [
    ["the phone's tab strip", browser],
    ["the desktop column", column],
  ] as const) {
    check(`${what} is drawn from the tab list and the All tab beside it`, [/machineTabs\(/.test(code), /allTab\(/.test(code)], [true, true]);
    check(`${what} selects through the store`, /selectMachine\(/.test(code), true);
    check(`${what} reveals the selection on a change rather than every render`, /\}, \[selected/.test(code), true);
  }
  check(
    "and the column carries none of the horizontal strip's three cues",
    [/no-scrollbar/.test(column), /edge-fade/.test(column), /overscroll-contain/.test(column), /scrollWidth/.test(column)],
    [false, false, false, false],
  );
  check("while the strip it was borrowed from still has them", /no-scrollbar/.test(browser) && /edge-fade/.test(browser), true);
  check(
    "the selected machine is a filled mark rather than a band beside the session rows",
    [
      /tab\.selected\s*\n?\s*\? "bg-fg text-ink/.test(column),
      /tab\.selected \? "bg-raised"/.test(column),
      /tab\.selected \? "font-medium text-fg"/.test(column),
    ],
    [true, false, true],
  );
  check("and the fill it moved onto carries a transition of its own", /transition-colors/.test(column), true);
  check(
    "and the count on top of it keeps a ring, or the two fills merge",
    /bg-fg px-1 text-2xs font-semibold text-ink ring-2 ring-ink/.test(column),
    true,
  );
  const machineDrag = stripComments(readFileSync(new URL("../src/ui/machineDrag.ts", import.meta.url), "utf8"));
  check(
    "the machine reorder is a hook, and both axes mount it",
    [/export function useMachineDrag\(/.test(machineDrag), /useMachineDrag\(\{ axis: "y"/.test(column), /useMachineDrag\(\{ axis: "x"/.test(browser)],
    [true, true, true],
  );
  check(
    "and it splices through the body the agent strip already had",
    [/from "\.\.\/agentStrip"/.test(machineDrag), /\bmoveRow\(/.test(machineDrag)],
    [true, true],
  );
  check(
    "a finger's gesture refuses the scroll only while a drag is live",
    /if \(event\.cancelable\) event\.preventDefault\(\);/.test(machineDrag),
    true,
  );
  const gestureSrc = (file: string): string => stripComments(srcFile(`ui/${file}`));
  const plumbing = gestureSrc("rowDrag.ts");
  const client = srcFiles().map((rel) => [rel, stripComments(srcFile(rel))] as const);
  report("every sweep here is over the whole client", client.length > 100, `${client.length} files`);
  const sweptFor = (hit: RegExp): string[] => client.filter(([, body]) => hit.test(body)).map(([rel]) => rel).sort();
  check(
    "the files that put a touch listener on a node themselves are the two that may",
    sweptFor(/addEventListener\("touch/),
    ["ui/rowDrag.ts", "ui/settings/MachineAgentsSection.tsx"].sort(),
  );
  check("and beginning a gesture is the plumbing's alone", sweptFor(/addEventListener\("touchstart/), ["ui/rowDrag.ts"]);
  check(
    "every gesture reaches it through the one hook, and no screen that draws one mounts it",
    sweptFor(/useTouchGesture[(<]/),
    ["ui/machineDrag.ts", "ui/machineSwipe.ts", "ui/rowDrag.ts"].sort(),
  );
  check(
    "which registers both halves non-passive, on the node, from the ref callback",
    [
      /export function useTouchGesture</.test(plumbing),
      /node\.addEventListener\("touchstart", going\.start, \{ passive: false \}\)/.test(plumbing),
      /node\.addEventListener\("touchmove", going\.move, \{ passive: false \}\)/.test(plumbing),
      /const scrollerRef = useCallback\([\s\S]{0,400}previous\.removeEventListener\("touchstart"/.test(plumbing),
    ],
    [true, true, true, true],
  );
  check(
    "the haptic is one number, named once and imported rather than re-typed",
    [
      /export const HAPTIC_MS = \d+;/.test(plumbing),
      /navigator\.vibrate\?\.\(HAPTIC_MS\)/.test(machineDrag),
      /vibrate\?\.\(\d/.test(machineDrag + plumbing),
    ],
    [true, true, false],
  );
  check("and the pointer is taken at arm rather than at the press", /setPointerCapture/.test(machineDrag.slice(machineDrag.indexOf("const arm"))), true);
  check("while the press itself captures nothing", /setPointerCapture/.test(machineDrag.slice(0, machineDrag.indexOf("const arm"))), false);
  check("the hold and the swipe share one distance, by import", [/PRESS_SLOP/.test(machineDrag), /from "\.\/rowDrag"/.test(machineDrag)], [true, true]);
  check("a drop may not also select the machine it dropped", /onClickCapture/.test(machineDrag), true);
  const endBody = machineDrag.slice(machineDrag.indexOf("const end = useCallback"));
  report("the drop's own body was isolated", endBody.length > 0, `${String(endBody.length)} chars`);
  check(
    "a drop checks the row is still where it armed before writing an order",
    [/settled\[going\.from\]\?\.id !== going\.id/.test(endBody), /setMachineOrder\(moveRow\(settled,/.test(endBody)],
    [true, true],
  );
  check(
    "and a drag whose row left the list is ended rather than left running",
    [/!tabs\.some\(\(tab\) => tab\.id === going\.id\)\) end\(\)/.test(machineDrag), /\}, \[tabs, end\]\)/.test(machineDrag)],
    [true, true],
  );
  check("All is refused rather than being absent by luck", /id === ALL_MACHINES/.test(machineDrag), true);
  check("and the class that would take scrolling from the list is never used", /touch-none/.test(machineDrag), false);
  const sheet = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const tapAt = sheet.indexOf(".tap {");
  const slidesAt = sheet.indexOf(".slides {");
  report("both transition opt-ins were found", tapAt > 0 && slidesAt > 0, `tap at ${String(tapAt)}, slides at ${String(slidesAt)}`);
  check("the sliding opt-in is declared after the one it has to beat", slidesAt > tapAt, true);
  const header = stripComments(readFileSync(new URL("../src/ui/Header.tsx", import.meta.url), "utf8"));
  const bar = /className=\{`sticky top-0 \$\{LAYER\.header\}([^`]*)`\}/.exec(header)?.[1] ?? "";
  report("the header's own class string was found", bar.length > 0, bar.trim());
  check("the bar draws no rule under itself", /border-b/.test(bar), false);
  const veil = Number(/bg-surface\/(\d+)/.exec(bar)?.[1] ?? "0");
  check("and its ground is opaque enough to stand in for one", veil >= 95, true);
  check("while still being a veil rather than a wall", [veil < 100, /backdrop-blur/.test(bar)], [true, true]);
  check("the header's top inset is written as one expression", /pt-\[max\([\d.]+rem,env\(safe-area-inset-top\)\)\]/.test(bar), true);
  check("and it does not try to add padding beside an unlayered class", /pt-safe/.test(bar), false);
  const view = stripComments(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
  const wire = stripComments(readFileSync(new URL("../src/wire.ts", import.meta.url), "utf8"));
  check(
    "a message on its way is drawn as work about to happen",
    /const working = echo !== null \|\| \(snapshot !== null && showsWorking\(snapshot\)\);/.test(view),
    true,
  );
  check("and the predicate it ORs stays a pure reading of the snapshot", /echo|Echo/.test(wire), false);

  const composer = stripComments(readFileSync(new URL("../src/ui/Composer.tsx", import.meta.url), "utf8"));
  const composerPad = /\$\{COLUMN\} px-4 pb-(\d+)/.exec(composer)?.[1] ?? "";
  const footPad = /<div className="pb-safe shrink-0 px-3 pt-3">\s*<div className="pb-(\d+)">/.exec(browser)?.[1] ?? "";
  report("both bottom insets were found", composerPad.length > 0 && footPad.length > 0, `composer pb-${composerPad}, rail foot pb-${footPad}`);
  check("New session stops where the composer's box stops", footPad, composerPad);
  check("and neither spends it on the band that carries pb-safe", /pb-safe[^"]*\bpb-\d/.test(browser + composer), false);
  check("nor does any surface pair pt-safe with a top padding utility", /pt-safe[^"]*\bpt-\d/.test(browser + composer + header), false);
  check("and it carries the transform the other refuses", /\.slides \{[^}]*transform \d+ms/.test(sheet), true);
  const decls = (block: string): string[] =>
    (/\{([\s\S]*?)\}/.exec(block)?.[1] ?? "")
      .split(",")
      .map((one) => one.trim().replace(/^transition:\s*/, "").replace(/;$/, ""))
      .filter((one) => one.length > 0);
  const tapDecls = decls(sheet.slice(tapAt));
  const slideDecls = decls(sheet.slice(slidesAt));
  check("and it still says everything the other one does", slideDecls.slice(0, tapDecls.length), tapDecls);
  // Scoped to MachineTabs: SessionBrowser's folder chevrons use the transform transition legitimately.
  const stripBody = browser.slice(browser.indexOf("function MachineTabs("));
  const tabsOnly = stripBody.slice(0, stripBody.indexOf("\nfunction "));
  report("the tab strip's own body was isolated", tabsOnly.length > 0 && tabsOnly.length < browser.length, `${String(tabsOnly.length)} chars`);
  for (const [what, code] of [["the phone's tab strip", tabsOnly], ["the desktop column", column]] as const) {
    check(`${what} slides its neighbours with the opt-in, not the utility`, [/\? "slides"/.test(code), /"transition-transform"/.test(code)], [true, false]);
  }
  check(
    "the same control answers a keyboard",
    [/altKey/.test(machineDrag), /ArrowUp/.test(machineDrag), /ArrowLeft/.test(machineDrag), /isTypingInto\(/.test(machineDrag)],
    [true, true, true, true],
  );
  check("and a keyboard move is announced", /moved to position/.test(machineDrag), true);
  check(
    "on both axes, from the one sentence the hook owns",
    [/aria-live="polite"/.test(column), /aria-live="polite"/.test(browser), /drag\.announcement/.test(column), /drag\.announcement/.test(browser)],
    [true, true, true, true],
  );
  const shortcuts = /const SHORTCUTS = \{([\s\S]*?)\} as const;/.exec(machineDrag)?.[1] ?? "";
  report("the shortcut table was found", shortcuts.length > 0, shortcuts.replace(/\s+/g, " ").trim());
  check(
    "the reorder names itself, and names the keys it takes",
    [
      /"aria-keyshortcuts": SHORTCUTS\[axis\]/.test(machineDrag),
      /"aria-roledescription": MOVABLE/.test(machineDrag),
      /\by: "Alt\+/.test(shortcuts),
      /\bx: "Alt\+/.test(shortcuts),
    ],
    [true, true, true, true],
  );
  const branch = /const back = vertical \? "(\w+)" : "(\w+)";[\s\S]{0,80}const on = vertical \? "(\w+)" : "(\w+)";/.exec(machineDrag);
  report("the handler's own arrow branch was found", branch !== null, branch?.[0].replace(/\s+/g, " ") ?? "not found");
  const named = (axis: "x" | "y"): string[] =>
    (new RegExp(`\\b${axis}: "([^"]+)"`).exec(shortcuts)?.[1] ?? "")
      .split(" ")
      .map((one) => one.replace("Alt+", ""))
      .sort();
  const taken = (vertical: boolean): string[] =>
    [branch?.[vertical ? 1 : 2] ?? "", branch?.[vertical ? 3 : 4] ?? "", "Home", "End"].sort();
  check("the vertical axis names the keys its own handler takes", named("y"), taken(true));
  check("and so does the horizontal one, which is the half a single spelling would hide", named("x"), taken(false));
  check(
    "and the two it names on both axes are keys the handler reads",
    [/event\.key === "Home"/.test(machineDrag), /event\.key === "End"/.test(machineDrag)],
    [true, true],
  );
  check(
    "neither surface re-types either attribute, so there is one answer to draw",
    [
      /aria-keyshortcuts/.test(column),
      /aria-keyshortcuts/.test(browser),
      /aria-roledescription/.test(column),
      /aria-roledescription/.test(browser),
    ],
    [false, false, false, false],
  );
  for (const [what, code] of [["the phone's tab strip", browser], ["the desktop column", column]] as const) {
    check(`${what} draws the order it is handed and sorts nothing itself`, [/localeCompare/.test(code), /machineOrder\(/.test(code)], [false, false]);
  }

  {
    const { MAX_MACHINE_ORDER, nextOrder } = await import("../src/machineOrder.js");
    const stale = Array.from({ length: MAX_MACHINE_ORDER }, (_, at) => `m_gone_${String(at)}`);
    const drawn = ["m_b", "m_a", "m_c"];
    const next = nextOrder(stale, drawn);
    check("a saturated order still holds every machine that is drawn", next.slice(-drawn.length), drawn);
    check("and it is still inside the bound", next.length, MAX_MACHINE_ORDER);
    check(
      "the slots it gave up are the last stale ones, not the first",
      [next.includes("m_gone_0"), next.includes(`m_gone_${String(MAX_MACHINE_ORDER - drawn.length - 1)}`), next.includes(`m_gone_${String(MAX_MACHINE_ORDER - 1)}`)],
      [true, true, false],
    );
    check(
      "so a second drag on that list answers the live ids rather than none",
      nextOrder(next, ["m_c", "m_b", "m_a"]).slice(-3),
      ["m_c", "m_b", "m_a"],
    );
    check(
      "with nothing stale to give up, the tail is cut after all",
      nextOrder([], Array.from({ length: MAX_MACHINE_ORDER + 5 }, (_, at) => `m_${String(at)}`)).length,
      MAX_MACHINE_ORDER,
    );
  }

  const strip = stripComments(browser);
  const tabInset = /min-h-11 items-center gap-1\.5 px-(\d+)/.exec(strip)?.[1] ?? "";
  const markInset = /absolute inset-x-(\d+) -bottom-px/.exec(strip)?.[1] ?? "";
  report("both insets were found to compare", tabInset.length > 0 && markInset.length > 0, `tab px-${tabInset}, mark inset-x-${markInset}`);
  check("the mark under a tab is as wide as the tab's own content box", markInset, tabInset);
  check("All and the + share that inset", (strip.match(new RegExp(`px-${tabInset}\\b`, "g")) ?? []).length >= 3, true);
  check("the cut edge fades by twice a tab's inset", /w-8 bg-gradient-to-l/.test(strip) && Number(tabInset) * 2 === 8, true);
  const { MACHINE_COLUMN_PX: columnPx } = await import("../src/ui/rail.js");
  check("widening the phone's tabs did not widen the desktop column", columnPx, 72);
  check("and the two insets are not one number by accident", new RegExp(`px-${tabInset}\\b`).test(stripComments(column)), false);

  const swipe = stripComments(readFileSync(new URL("../src/ui/machineSwipe.ts", import.meta.url), "utf8"));
  check(
    "the swipe asks no second source of truth about the width",
    [/matchMedia\("\(min-width/.test(swipe), /innerWidth <|window\.innerWidth\b(?!.*EDGE)/.test(swipe), /\blg:/.test(swipe)],
    [false, false, false],
  );
  check("it asks the DOM's own answer instead, once per gesture", /offsetParent === null/.test(swipe), true);
  const appShell = readFileSync(new URL("../src/ui/AppShell.tsx", import.meta.url), "utf8");
  check("and the breakpoint is still answered in two class strings", [/lg:hidden/.test(browser), /lg:flex/.test(appShell)], [true, true]);
  check("a follow that CSS cannot reach asks about reduced motion itself", /prefers-reduced-motion/.test(swipe), true);
  check(
    "it begins on touchstart, non-passive, through the one hook the census above pins",
    [/useTouchGesture</.test(swipe), /addEventListener\("touch/.test(swipe)],
    [true, false],
  );
  check(
    "a live follow is never transitioned, and the settle's timer can be taken back",
    [
      /const slide = \(by: number\): void => \{[\s\S]{0,200}unsettle\(node\)/.test(swipe),
      /const settling = useRef<number \| null>\(null\);/.test(swipe),
      /window\.clearTimeout\(settling\.current\)/.test(swipe),
      /settling\.current = window\.setTimeout\(/.test(swipe),
    ],
    [true, true, true, true],
  );
  check(
    "and the node going takes the pending clear with it",
    /const wrapRef = useCallback\([\s\S]{0,300}window\.clearTimeout\(settling\.current\)/.test(swipe),
    true,
  );
  const timers = (swipe.match(/window\.setTimeout\(/g) ?? []).length;
  const held = (swipe.match(/settling\.current = window\.setTimeout\(/g) ?? []).length;
  check("every timer the swipe starts is one it can cancel", [timers, held], [1, 1]);
  const slideMs = Number(/const SETTLE_MS = (\d+);/.exec(swipe)?.[1] ?? "0");
  const clearMs = Number(/const SETTLE_CLEAR_MS = (\d+);/.exec(swipe)?.[1] ?? "0");
  report("both settle durations were found", slideMs > 0 && clearMs > 0, `slide ${String(slideMs)}ms, clear ${String(clearMs)}ms`);
  check("the transition comes off after the slide it animates, not during it", clearMs > slideMs, true);
  check("the swipe's slop is the hold's, by import rather than by coincidence", [/PRESS_SLOP/.test(swipe), /from "\.\/rowDrag"/.test(swipe)], [true, true]);
  check("and it stands down while a row drag owns the touch", /busy\.current\(\)/.test(swipe), true);
  check("the platform's own Back keeps its edge", /EDGE_DEAD_ZONE/.test(swipe), true);
  check(
    "a swipe selects a machine and does not navigate",
    [/selectMachine\(/.test(swipe), /navigate\(/.test(swipe), /startViewTransition/.test(swipe)],
    [true, false, false],
  );
  check("and it clamps at both ends rather than wrapping", /Math\.min\(Math\.max\(/.test(swipe), true);
  check(
    "the machine tabs mark the selected one with a rule rather than a fill",
    [/function TabUnderline\(\)/.test(browser), /\{tab\.selected && <TabUnderline \/>\}/.test(browser), /rounded-full px-2\.5 text-xs/.test(browser)],
    [true, true, false],
  );
  const nav = /<nav[^>]*className="([^"]*)"/.exec(column)?.[1] ?? "";
  report("the column's own element was found", nav.length > 0, nav);
  check("it is divided by a line and paints no ground of its own", [/border-r border-edge/.test(nav), /\bbg-/.test(nav)], [true, false]);

  report("the refusal sweep can see one", /label="Search everything/.test('label="Search everything — not built yet"'), "positive control");
  check(
    "the header's search is the one that works, and there is no second, dead one",
    [/label="Search everything/.test(browser), /aria-label="Search sessions"/.test(browser)],
    [false, true],
  );
  check("the list column still names the app for a screen reader, exactly once", (browser.match(/<h1\b/g) ?? []).length, 1);
  const footAt = browser.indexOf("function SidebarFoot");
  const footEnd = browser.indexOf("\n}\n", footAt);
  const foot = footAt < 0 || footEnd <= footAt ? "" : browser.slice(footAt, footEnd);
  report("the footer was found", foot.length > 0, `${foot.length} chars`);
  check(
    "New session is still a full-width button at the foot of the list, and never a FAB",
    [/size="sm"[\s\S]{0,120}className="w-full"/.test(foot), /\bfixed\b|\babsolute\b|\brounded-full\b/.test(foot)],
    [true, false],
  );
  check("the account row left, and the footer still draws no rule the composer's cannot meet", /ProfileMenu|border-t/.test(foot), false);

  const version = stripComments(readFileSync(new URL("../src/version.ts", import.meta.url), "utf8"));
  check("the drawer says what build this is", /APP_VERSION/.test(drawer), true);
  check(
    "the constant guards the identifier a Vite-less import does not define",
    [/typeof __APP_VERSION__ === "string"/.test(version), /__APP_VERSION__\s*===\s*undefined/.test(version)],
    [true, false],
  );
  const { APP_VERSION } = await import("../src/version.js");
  check("so this driver, which has no Vite, gets the fallback rather than a ReferenceError", APP_VERSION, "dev");
  const viteConfig = stripComments(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8"));
  check(
    "and the build reads it from this package's manifest rather than a second literal",
    /__APP_VERSION__: JSON\.stringify\(/.test(viteConfig) &&
      /JSON\.parse\(readFileSync\(new URL\("\.\/package\.json"/.test(viteConfig),
    true,
  );
}
