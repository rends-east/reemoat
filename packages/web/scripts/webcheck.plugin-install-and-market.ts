import { readFileSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhere a failed install or removal is said, and how much of it survives\n");
{
  const installsSrc = readFileSync(new URL("../src/ui/plugins/MachineInstalls.tsx", import.meta.url), "utf8");
  const installsBody = stripComments(installsSrc);

  report(
    "nothing moves the list under a thumb",
    !/scrollIntoView|scrollTop\s*=/.test(installsBody),
    "no scroll is driven from this component; the person's position is theirs",
  );
  {
    const scrollerOpen = installsBody.indexOf("overflow-y-auto");
    const listEnd = installsBody.lastIndexOf("</ul>");
    const scrollerClose = installsBody.indexOf("</div>", listEnd);
    // Anchored on each control's enablement, unique to the bar: the words wrap in the JSX and Remove also appears on a row.
    const bulk = ["!can.install", "!can.update", "!can.remove", "!can.settings"].map((word) => installsBody.indexOf(word));
    report(
      "the bulk bar is drawn outside the scroller",
      scrollerOpen > 0 && scrollerOpen < listEnd && bulk.every((at) => at > scrollerClose && at > 0),
      "every bulk control appears after the scrolling box has closed",
    );
    report(
      "and there is exactly one scrolling box, holding only the rows",
      (installsBody.match(/overflow-y-auto/g) ?? []).length === 1 && installsBody.indexOf("<ul") > scrollerOpen,
      "one scroller in the file, and the list is inside it",
    );
  }
  report(
    "the machine list does not end the scroll chain",
    !/overscroll-contain/.test(installsBody),
    "no overscroll-behavior: contain on a box that may have nothing to scroll",
  );
  report(
    "a row's controls are not inside its label",
    !/<label(?![^>]*htmlFor)[\s\S]{0,900}?<(IconButton|Button)\b/.test(installsBody) && /htmlFor=/.test(installsBody),
    "the checkbox is reached by htmlFor, so a tap on Remove does not also select the row",
  );
  {
    const icons = installsBody.match(/<IconButton[\s\S]*?\/>/g) ?? [];
    report(
      "a row's acts do not overlap each other's targets",
      icons.filter((call) => /size="lg"/.test(call)).length >= 2 && icons.every((call) => !/size="sm"/.test(call)),
      "44px boxes on the row; 24 + 20 = 44, so two `sm` targets overlap by 18px",
    );
  }
  {
    const rowIcons = installsBody.slice(installsBody.indexOf("function MachineRow"));
    report(
      "a row draws no removal",
      /drawnActs\(one\.acts\)/.test(rowIcons) && !/Trash2/.test(rowIcons),
      "the row's icons come from drawnActs, and no bin is drawn there",
    );
    report(
      "and every question is the bar's, asked by exactly the two acts that earn one",
      (installsBody.match(/setConfirming\("/g) ?? []).length === 2 &&
        (installsBody.match(/setConfirming\("remove"\)/g) ?? []).length === 1 &&
        (installsBody.match(/setConfirming\("install"\)/g) ?? []).length === 1 &&
        !/setConfirming/.test(rowIcons) &&
        /disabled=\{!can\.install\}[\s\S]{0,120}?installTargets\.length > 1 \? setConfirming\("install"\) : act\(installTargets, \[\]\)/.test(
          installsBody,
        ) &&
        /disabled=\{!can\.update\}[\s\S]{0,80}?act\(idsWith\("update"\), \[\]\)/.test(installsBody),
      "two askers, both in the bar; a lone install acts, and update never asks",
    );
  }
  {
    const box = /flex h-\[[\d.]+rem\] flex-col overflow-hidden rounded-md border/.test(installsBody);
    const line = installsBody.indexOf("id={noticeId}");
    const closes = installsBody.indexOf("</div>", line);
    const bar = Math.min(...["!can.install", "!can.update", "!can.remove", "!can.settings"].map((one) => installsBody.indexOf(one)));
    report(
      "the line that appears is inside the table, which has a definite height",
      box && line > 0 && closes > line && closes < bar,
      "it is closed inside the fixed box, so nothing it holds can move the bar",
    );
    report(
      "and nothing above the bar is mounted conditionally",
      !/\{notice\.length > 0 && \(/.test(installsBody) && !/\{chosenRows\.length > 0 && \(/.test(installsBody),
      "always mounted, only the text swaps",
    );
  }
  report(
    "a slow answer is dropped per machine rather than per act",
    /epochs\.current\.get\(id\) !== epoch/.test(installsBody) && !/generation\.current !== epoch/.test(installsBody),
    "two rows acting at once must not discard each other's answers",
  );
  report(
    "the store is refreshed per machine, in that machine's finally",
    /inFlight\.current\.delete\(id\);\s*\n\s*store\.refreshPlugins\(id\);/.test(installsBody) &&
      (installsBody.match(/refreshPlugins/g) ?? []).length === 1,
    "one call, and it is inside the per-job finally",
  );
  // Only plugin_busy is retried: a POST is not replayable, and a transport failure says nothing about whether the daemon acted.
  report(
    "one retry, for one code, and nothing else",
    /error\.code === "plugin_busy"/.test(installsBody) &&
      /BUSY_RETRY_MS/.test(installsBody) &&
      (installsBody.match(/setTimeout/g) ?? []).length === 1 &&
      (installsBody.match(/await once\(\)/g) ?? []).length === 2,
    "a DELETE inherits its own retry from machine.ts one layer down",
  );
  report(
    "the four bulk controls are decided outside this file",
    /const can = bulkEnabled\(/.test(installsBody) &&
      /rowActs\(/.test(installsBody) &&
      ["install", "update", "remove", "settings"].every((act) => installsBody.includes(`disabled={!can.${act}}`)),
    "every bulk control reads the pure answer; none is re-derived in JSX",
  );
  report(
    "a row's Cancel is derived from the controller its job holds",
    /cancellable: controller !== null/.test(installsBody) && !/setCancellable/.test(installsBody),
    "the flag is the controller, so it cannot disagree with one",
  );
  report(
    "a caller beside it is told for exactly as long as anything is running",
    /const busy = \[\.\.\.local\.values\(\)\]\.some/.test(installsBody) &&
      /onBusyChange\?\.\(busy\);/.test(installsBody) &&
      !/onBusyChange\?\.\(true\)/.test(installsBody),
    "derived from the rows, not raised and lowered around one act",
  );
  report(
    "and it can be called off while it runs",
    /const controller = what === "install" && install !== null \? new AbortController\(\) : null;/.test(installsBody) &&
      /if \(controller !== null\) inFlight\.current\.set\(id, controller\);/.test(installsBody) &&
      /controller\.signal,/.test(installsBody) &&
      /onClick=\{cancelAll\}/.test(installsBody),
    "one controller per install job, registered, and its signal is what the act uses",
  );
  report(
    "and calling it off is not drawn as a failure",
    /const calledOff = \(\): boolean => controller\?\.signal\.aborted === true;/.test(installsBody) &&
      (installsBody.match(/if \(calledOff\(\)\)/g) ?? []).length === 3 &&
      !/cancelled\.current/.test(installsBody),
    "every arm that could write a failed row asks this request's own signal",
  );
  // The region is mounted before it has anything to say: a status inserted with its content is often not spoken, VoiceOver on iOS included.
  report(
    "and it is a live region that is always mounted",
    /role="status" aria-live="polite"/.test(installsBody) &&
      /className=\{said\.length === 0 \? ""/.test(installsBody) &&
      !/\{said\.length > 0 &&/.test(installsBody),
    "the ternary is on the className, not on the mount",
  );
  report(
    "a failure keeps every character of itself",
    /row\.kind === "failed" \? "wrap-anywhere text-fg" : "truncate text-muted"/.test(installsSrc) &&
      !/block truncate text-2xs text-muted/.test(installsSrc),
    "the failed arm wraps and takes full ink; the rest still truncate",
  );
  report(
    "a machine still being asked is drawn as late rather than as out",
    /const waiting = row\.kind === "blocked" && row\.reason === "asking";/.test(installsBody) &&
      /const out = row\.kind === "blocked" && !waiting;/.test(installsBody) &&
      /\$\{out \? "opacity-60" : ""\}/.test(installsBody) &&
      /disabled=\{out\}/.test(installsBody) &&
      !/disabled=\{row\.kind === "blocked"\}/.test(installsBody),
    "the dimming and the box both key on `out`, which excludes the wait",
  );
  {
    const seedAt = installsBody.indexOf("if (seeded.current || state.machines.length === 0) return;");
    const seed = seedAt < 0 ? "" : installsBody.slice(seedAt, installsBody.indexOf("}, [state.machines]);", seedAt));
    report(
      "and a fleet of one that has not answered yet latches nothing",
      seedAt >= 0 &&
        /if \(reason === "asking"\) return;\s*seeded\.current = true;/.test(seed) &&
        seed.indexOf('if (reason === "asking") return;') < seed.indexOf("seeded.current = true;"),
      "the wait returns above the latch, so a later publish still decides",
    );
  }
}

process.stdout.write("\nwhich plugins screen a URL names\n");
{
  const {
    MARKET_TABS,
    marketEntryPath,
    marketPaneTitle,
    marketPath,
    marketSettingsPath,
    marketUp,
    marketUpFrom,
    marketUpLabel,
    marketUpWithinNav,
    parseMarketRoute,
  } = await import("../src/market.js");
  const { depthOf, navMove } = await import("../src/nav.js");

  const seg = (path: string): string[] => path.split("/").filter((part) => part.length > 0).slice(1);

  check("the bare path is the market", parseMarketRoute([]), { tab: "market", entry: null, settings: [] });
  check("the other tab", parseMarketRoute(["installed"]), { tab: "installed", entry: null, settings: [] });
  check("one entry", parseMarketRoute(["p", "autotitle"]), { tab: "market", entry: "autotitle", settings: [] });
  check("and its settings, on the machines the URL names", parseMarketRoute(["p", "autotitle", "settings", "m_1", "m_2"]), {
    tab: "market",
    entry: "autotitle",
    settings: ["m_1", "m_2"],
  });
  check("a settings path naming no machine is the entry", parseMarketRoute(["p", "autotitle", "settings"]), {
    tab: "market",
    entry: "autotitle",
    settings: [],
  });
  check(
    "settings never arrive without a plugin to be about",
    [["settings"], ["settings", "m_1"], ["p"], ["p", "", "settings", "m_1"], ["installed", "settings", "m_1"], []]
      .map((segments) => parseMarketRoute(segments))
      .filter((route) => route.settings.length > 0 && route.entry === null),
    [],
  );
  // Repeated segments rather than a comma list, because URI component encoding leaves a comma alone.
  check(
    "a machine id holding a comma is still one machine",
    parseMarketRoute(seg(marketSettingsPath("x", ["a,b", "c"] as never)), decodeURIComponent).settings,
    ["a,b", "c"],
  );
  check(
    "and every segment is encoded and decoded like any other",
    parseMarketRoute(seg(marketSettingsPath("x", ["m 1", "m/2"] as never)), decodeURIComponent).settings,
    ["m 1", "m/2"],
  );
  check("a repeated machine is one machine", parseMarketRoute(["p", "x", "settings", "m_1", "m_1"]).settings, ["m_1"]);
  check("and an empty segment names none", parseMarketRoute(["p", "x", "settings", "", "m_1"]).settings, ["m_1"]);
  check("the order the URL named them is the order that comes back", parseMarketRoute(["p", "x", "settings", "m_2", "m_1"]).settings, ["m_2", "m_1"]);
  check("and its tab is the one it was reached from", parseMarketRoute(["p", "x"]).tab, "market");

  check(
    "a bare /plugins/p, an unknown tab and junk all fall to the market",
    [parseMarketRoute(["p"]), parseMarketRoute(["nonsense"]), parseMarketRoute(["installed", "extra"])].map(
      (route) => route.entry,
    ),
    [null, null, null],
  );
  check(
    "an unknown leaf under a plugin is that plugin",
    parseMarketRoute(["p", "autotitle", "nonsense"]),
    { tab: "market", entry: "autotitle", settings: [] },
  );
  check("an unknown segment is the market rather than a tab nothing draws", parseMarketRoute(["nonsense"]).tab, "market");

  {
    const src = readFileSync(new URL("../src/market.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const union = src.slice(src.indexOf("export type MarketTab ="));
    const members = [...union.slice(0, union.indexOf(";")).matchAll(/"([a-z]+)"/g)].map((one) => one[1] ?? "").sort();
    check("the tab union is readable at all", members.length > 0, true);
    check("and every one of its members is a drawable tab", MARKET_TABS.map((tab) => String(tab.id)).sort(), members);
    check("each with a title to draw", MARKET_TABS.filter((tab) => tab.title.trim().length === 0), []);
  }
  check("both tabs round-trip", MARKET_TABS.map((tab) => parseMarketRoute(seg(marketPath(tab.id))).tab), [
    "market",
    "installed",
  ]);
  check(
    "and an entry round-trips through its own builder",
    parseMarketRoute(seg(marketEntryPath("autotitle"))),
    { tab: "market", entry: "autotitle", settings: [] },
  );
  check(
    "and so do its settings, with the machines they are about",
    parseMarketRoute(seg(marketSettingsPath("autotitle", ["m_1", "m_2"] as never))),
    { tab: "market", entry: "autotitle", settings: ["m_1", "m_2"] },
  );
  check(
    "a settings path is an entry path with the machines on it",
    marketSettingsPath("a b", ["m_1"] as never),
    `${marketEntryPath("a b")}/settings/m_1`,
  );
  check(
    "an id is encoded and decoded like every other segment",
    parseMarketRoute(seg(marketEntryPath("a b")), decodeURIComponent).entry,
    "a b",
  );

  const shapes = [
    parseMarketRoute([]),
    parseMarketRoute(["installed"]),
    parseMarketRoute(["p"]),
    parseMarketRoute(["p", "autotitle"]),
    parseMarketRoute(["p", "autotitle", "settings", "m_1"]),
    parseMarketRoute(["p", "autotitle", "settings", "m_1", "m_2"]),
  ];
  check(
    "a way back and a name for the screen it leaves arrive together",
    shapes.filter((route) => (marketUp(route) === null) !== (marketPaneTitle(route) === null)),
    [],
  );
  check("a tab leaves the pop-up rather than moving inside it", marketUp(parseMarketRoute([])), null);
  check("an entry walks back to the list", marketUp(parseMarketRoute(["p", "x"])), "/plugins");
  check("and settings walk back to the plugin", marketUp(parseMarketRoute(["p", "x", "settings", "m_1"])), "/plugins/p/x");

  const ORIGIN = "/settings/machines/m_1/plugins";
  check(
    "an origin changes exactly one depth's answer",
    shapes.filter((route) => marketUpFrom(route, ORIGIN) !== marketUp(route)).map((route) => marketUp(route)),
    ["/plugins"],
  );
  check(
    "and with no origin it is marketUp exactly",
    shapes.filter((route) => marketUpFrom(route, null) !== marketUp(route)),
    [],
  );
  check(
    "an entry reached from the settings sheet walks back there",
    marketUpFrom(parseMarketRoute(["p", "x"]), ORIGIN),
    ORIGIN,
  );
  check(
    "but its settings still walk to the plugin first, whichever machines they are about",
    marketUpFrom(parseMarketRoute(["p", "x", "settings", "m_1", "m_2"]), ORIGIN),
    "/plugins/p/x",
  );
  check("and a tab still leaves the pop-up", marketUpFrom(parseMarketRoute([]), ORIGIN), null);
  check(
    "a settings path with no machine takes the entry's answer",
    marketUpFrom(parseMarketRoute(["p", "x", "settings"]), ORIGIN),
    ORIGIN,
  );

  check(
    "only an entry's parent is a row the rail draws",
    shapes.map((route) => marketUpWithinNav(route, null)),
    shapes.map((route) => route.entry !== null && route.settings.length === 0),
  );
  check(
    "and an origin takes exactly that one back out of the rail",
    shapes.filter((route) => marketUpWithinNav(route, ORIGIN) !== marketUpWithinNav(route, null)).map(marketUp),
    ["/plugins"],
  );
  check(
    "nothing is withdrawn that has nowhere to go",
    shapes.filter((route) => marketUpWithinNav(route, null) && marketUp(route) === null),
    [],
  );
  check(
    "the label names where it actually goes",
    [
      marketUpLabel(parseMarketRoute(["p", "x"]), null),
      marketUpLabel(parseMarketRoute(["p", "x"]), ORIGIN),
      marketUpLabel(parseMarketRoute(["p", "x", "settings", "m_1"]), null),
      marketUpLabel(parseMarketRoute(["p", "x", "settings", "m_1"]), ORIGIN),
    ],
    ["Back to Market", "Back", "Back to the plugin", "Back to the plugin"],
  );
  check(
    "and it never says Market about a screen the rail cannot draw",
    shapes
      .flatMap((route) => [null, ORIGIN].map((from) => [marketUpLabel(route, from), marketUpWithinNav(route, from)] as const))
      .filter(([label, within]) => (label === "Back to Market") !== within),
    [],
  );

  // upFrom's origin argument defaults to null, so a caller that stops passing it still typechecks; hence the call-site check.
  {
    const { upFrom } = await import("../src/nav.js");
    const asPluginsRoute = (segments: string[]): never =>
      ({ name: "plugins", ...parseMarketRoute(segments) }) as never;
    check(
      "an entry's way up honours the origin",
      upFrom(asPluginsRoute(["p", "x"]), "/m/m_1/s/s_1", ORIGIN),
      ORIGIN,
    );
    check(
      "and falls back to the market list without one",
      upFrom(asPluginsRoute(["p", "x"]), "/m/m_1/s/s_1"),
      "/plugins",
    );
    check(
      "a tab still leaves the pop-up onto what it was drawn over",
      upFrom(asPluginsRoute([]), "/m/m_1/s/s_1", ORIGIN),
      "/m/m_1/s/s_1",
    );
    const appSrc = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
    check("and the app actually hands it the origin", /upFrom\(route, under, origin\)/.test(appSrc), true);

    const { originFor } = await import("../src/nav.js");
    const SETTINGS = "/settings/machines/m_1/plugins";
    const ENTRY = "/plugins/p/x";
    check("crossing from one pop-up to another records where you came from", originFor(SETTINGS, ENTRY, null), SETTINGS);
    check("walking deeper inside one pop-up keeps it", originFor(ENTRY, `${ENTRY}/settings`, SETTINGS), SETTINGS);
    check("and records nothing where there was nothing", originFor(ENTRY, `${ENTRY}/settings`, null), null);
    check("opening a pop-up from a screen records none", originFor("/m/m_1/s/s_1", ENTRY, null), null);
    check("and navigating to a screen records none", originFor(ENTRY, "/m/m_1/s/s_1", SETTINGS), null);
    check("a plugin's screen and the market are different pop-ups", originFor("/p/m_1/board", ENTRY, null), "/p/m_1/board");
  }

  const asRoute = (route: unknown): never => ({ name: "plugins", ...(route as object) }) as never;
  const market = asRoute(parseMarketRoute([]));
  const installed = asRoute(parseMarketRoute(["installed"]));
  const entry = asRoute(parseMarketRoute(["p", "autotitle"]));
  const settings = asRoute(parseMarketRoute(["p", "autotitle", "settings", "m_1"]));
  check(
    "the two tabs are one depth, an entry the next, its settings the next",
    [depthOf(market), depthOf(installed), depthOf(entry), depthOf(settings)],
    [1, 1, 2, 3],
  );
  check("switching tabs moves nothing", navMove(market, installed), null);
  check("walking into an entry pushes the section", navMove(market, entry), "section-push");
  check("and walking back out pops it", navMove(entry, market), "section-pop");
  check("opening settings pushes one more", navMove(entry, settings), "section-push");
  check("and the way back pops it", navMove(settings, entry), "section-pop");
  check(
    "narrowing the scope moves nothing",
    navMove(settings, asRoute(parseMarketRoute(["p", "autotitle", "settings", "m_1", "m_2"]))),
    null,
  );
  check(
    "and leaving it is a close from either depth",
    [navMove(market, { name: "home" } as never), navMove(entry, { name: "home" } as never)],
    ["sheet-close", "sheet-close"],
  );
}

process.stdout.write("\nwhat the catalogue says, and what this build will read of it\n");
{
  const { compareVersions, isNewer, catalogueNotice, catalogueEndpoint, previewOf, readCatalogue, readOne, readVersions } =
    await import("../src/catalogue.js");

  const PIN_REPO = "rends-east/autotitle";
  const PIN_COMMIT = "b".repeat(40);
  // Addresses are built from the pin: the reader drops an entry whose manifest address is not the derivation.
  const source = (patch: Record<string, unknown> = {}): Record<string, unknown> => {
    const repo = typeof patch["repo"] === "string" ? patch["repo"] : PIN_REPO;
    const commit = typeof patch["commit"] === "string" ? patch["commit"] : PIN_COMMIT;
    return {
      kind: "github",
      repo,
      commit,
      browse: `https://github.com/${repo}/tree/${commit}`,
      manifest: `https://github.com/${repo}/blob/${commit}/plugin.json`,
      manifestRaw: `https://raw.githubusercontent.com/${repo}/${commit}/plugin.json`,
      archive: `https://codeload.github.com/${repo}/tar.gz/${commit}`,
      archiveName: `autotitle-${commit}.tar.gz`,
      archiveBytes: 14741,
      icon: null,
      sha256Seen: "deff37945c201",
      ...patch,
    };
  };
  const entry = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "autotitle",
    name: "Autotitle",
    description: "Names a session from what the agent did.",
    version: "0.2.1",
    api: 2,
    scopes: ["sessions.read", "sessions.write"],
    net: [],
    contributes: { screen: null, settings: true, actions: [], hooks: ["turn.ended"] },
    source: source(),
    homepage: null,
    author: "rends-east",
    license: "AGPL-3.0",
    categories: ["sessions"],
    publishedAt: "2026-08-20T10:00:00.000Z",
    ...patch,
  });

  const read = readCatalogue({ schema: 1, plugins: [entry()] });
  check("a catalogue reads", [read.kind, read.kind === "ok" ? read.entries.length : -1], ["ok", 1]);
  check(
    "and the fields somebody consents to survive it",
    read.kind === "ok" ? [read.entries[0]?.scopes, read.entries[0]?.contributes.hooks] : null,
    [["sessions.read", "sessions.write"], ["turn.ended"]],
  );

  check("an empty catalogue is a state rather than a failure", readCatalogue({ schema: 1, plugins: [] }).kind, "ok");
  check(
    "and it says so in words",
    catalogueNotice(readCatalogue({ schema: 1, plugins: [] })),
    "There is nothing in the catalogue yet.",
  );

  // The one reader in the client that fails closed: a half-read entry is a half-read permission list.
  check("a schema this build does not speak is refused whole", readCatalogue({ schema: 2, plugins: [entry()] }), {
    kind: "too_new",
    schema: 2,
  });
  check(
    "and it is never partially parsed",
    (() => {
      const answer = readCatalogue({ schema: 2, plugins: [entry()] });
      return "entries" in answer;
    })(),
    false,
  );
  check("a document that is not one says so", readCatalogue({ plugins: [] }).kind, "malformed");
  check("and so does a list that is not a list", readCatalogue({ schema: 1, plugins: "no" }).kind, "malformed");

  // Closed means a required field missing or mistyped, never an unknown field, or every deployed client goes dark when the service adds one.
  {
    const tomorrow = entry({
      downloads: 4210,
      source: source({ signature: "sig", mirrors: ["a"] }),
      contributes: { screen: null, settings: false, actions: [], hooks: ["turn.ended"], commands: [{ id: "c" }] },
    });
    const answer = readCatalogue({ schema: 1, plugins: [tomorrow], generatedAt: "2026-08-23T00:00:00.000Z" });
    check(
      "a field this build has not heard of is ignored, never a refusal",
      [answer.kind, answer.kind === "ok" ? answer.entries.length : -1],
      ["ok", 1],
    );
    check(
      "and the fields it does know survive beside it",
      answer.kind === "ok" ? [answer.entries[0]?.id, answer.entries[0]?.contributes.hooks] : null,
      ["autotitle", ["turn.ended"]],
    );
    check("the same holds for one plugin", readOne({ schema: 1, plugin: tomorrow, extra: 1 }).kind, "ok");
    check(
      "and for a version history",
      readVersions({ schema: 1, id: "autotitle", versions: [tomorrow], extra: 1 }).kind,
      "ok",
    );
  }

  check(
    "a schema bump reads as the app being behind, not as a broken catalogue",
    catalogueNotice({ kind: "too_new", schema: 2 }) === catalogueNotice({ kind: "malformed", reason: "x" }),
    false,
  );
  check(
    "and it names the remedy rather than the fault",
    (catalogueNotice({ kind: "too_new", schema: 2 }) ?? "").includes("updated"),
    true,
  );

  // The daemon accepts only a full 40-character commit sha, since a tag can move.
  const admitted = (patch: Record<string, unknown> = {}): number => {
    const answer = readCatalogue({ schema: 1, plugins: [entry({ source: source(patch) })] });
    return answer.kind === "ok" ? answer.entries.length : -1;
  };
  const sourceOf = (patch: Record<string, unknown> = {}) => {
    const answer = readCatalogue({ schema: 1, plugins: [entry({ source: source(patch) })] });
    return answer.kind === "ok" ? (answer.entries[0]?.source ?? null) : null;
  };

  check("an entry pinned to a tag rather than a commit is not offered", admitted({ commit: "v1.2.0" }), 0);

  check("a repository that is not owner/name is not offered", admitted({ repo: "rends-east/autotitle/tree" }), 0);
  check("and neither is one that is itself a URL", admitted({ repo: "https://evil.example/x" }), 0);

  check(
    "the manifest a program reads is derived from the pin",
    sourceOf()?.manifestRaw,
    `https://raw.githubusercontent.com/${PIN_REPO}/${PIN_COMMIT}/plugin.json`,
  );
  check(
    "one the catalogue points somewhere else is not offered at all",
    admitted({ manifestRaw: "https://plugins.example/manifests/autotitle.json" }),
    0,
  );
  check(
    "and neither is one on the right host at a commit that is not the pin",
    admitted({ manifestRaw: `https://raw.githubusercontent.com/${PIN_REPO}/${"a".repeat(40)}/plugin.json` }),
    0,
  );

  check(
    "a browse link off github.com is replaced by the pinned tree rather than honoured",
    sourceOf({ browse: "https://evil.example/rends-east/autotitle" })?.browse,
    `https://github.com/${PIN_REPO}/tree/${PIN_COMMIT}`,
  );
  check(
    "and so is a manifest link that is merely http",
    sourceOf({ manifest: `http://github.com/${PIN_REPO}/blob/${PIN_COMMIT}/plugin.json` })?.manifest,
    `https://github.com/${PIN_REPO}/blob/${PIN_COMMIT}/plugin.json`,
  );
  check(
    "a host that only looks like github.com is not github.com",
    [
      sourceOf({ browse: "https://github.com@evil.example/x" })?.browse,
      sourceOf({ browse: "https://github.com.evil.example/x" })?.browse,
    ],
    [`https://github.com/${PIN_REPO}/tree/${PIN_COMMIT}`, `https://github.com/${PIN_REPO}/tree/${PIN_COMMIT}`],
  );

  check(
    "an icon off the manifest host is no icon rather than no plugin",
    (() => {
      const answer = readCatalogue({
        schema: 1,
        plugins: [entry({ source: source({ icon: "https://evil.example/i.svg" }) })],
      });
      return answer.kind === "ok" ? [answer.entries.length, answer.entries[0]?.source.icon ?? null] : null;
    })(),
    [1, null],
  );
  check(
    "and one at the pin is kept exactly as it was sent",
    sourceOf({ icon: `https://raw.githubusercontent.com/${PIN_REPO}/${PIN_COMMIT}/icon.svg` })?.icon,
    `https://raw.githubusercontent.com/${PIN_REPO}/${PIN_COMMIT}/icon.svg`,
  );

  check(
    "a zero-byte archive keeps its zero",
    (() => {
      const answer = readCatalogue({ schema: 1, plugins: [entry({ source: source({ archiveBytes: 0 }) })] });
      return answer.kind === "ok" ? answer.entries[0]?.source.archiveBytes : "missing";
    })(),
    0,
  );
  check(
    "and a missing icon is null rather than a broken address",
    (() => {
      const answer = readCatalogue({ schema: 1, plugins: [entry()] });
      return answer.kind === "ok" ? answer.entries[0]?.source.icon : "missing";
    })(),
    null,
  );

  check("one plugin answers the same union, with one entry", readOne({ schema: 1, plugin: entry() }).kind, "ok");
  check(
    "and a plugin this build cannot read is zero of them rather than an error",
    (() => {
      const answer = readOne({ schema: 1, plugin: { id: "x" } });
      return answer.kind === "ok" ? answer.entries.length : -1;
    })(),
    0,
  );
  check(
    "a version history is the same union too",
    (() => {
      const answer = readVersions({ schema: 1, id: "autotitle", versions: [entry(), entry({ version: "0.2.0" })] });
      return answer.kind === "ok" ? answer.entries.map((one) => one.version) : null;
    })(),
    ["0.2.1", "0.2.0"],
  );

  check("0.10.0 is newer than 0.9.0, which a string compare gets backwards", isNewer("0.10.0", "0.9.0"), true);
  check("and 0.9.0 is not newer than 0.10.0", isNewer("0.9.0", "0.10.0"), false);
  check("equal versions are neither", compareVersions("1.2.3", "1.2.3"), 0);
  check("a shorter version is padded rather than refused", compareVersions("1.2", "1.2.0"), 0);
  check("and something unreadable sorts as zero rather than throwing", compareVersions("what", "0.0.0"), 0);

  // Resolved with the URL constructor, so a base that is not a URL throws rather than yielding a relative path the SPA fallback would answer.
  check(
    "an endpoint is built the same way whether the base ends in a slash",
    [
      catalogueEndpoint("https://plugins.example", "api/plugins/list"),
      catalogueEndpoint("https://plugins.example/", "/api/plugins/list"),
    ],
    ["https://plugins.example/api/plugins/list", "https://plugins.example/api/plugins/list"],
  );

  const only = readCatalogue({ schema: 1, plugins: [entry()] });
  const preview = previewOf((only.kind === "ok" ? only.entries[0] : null) as never);
  check(
    "the fallback preview carries what a person agrees to",
    [preview.scopes, preview.net, preview.hooks, preview.settings],
    [["sessions.read", "sessions.write"], [], ["turn.ended"], true],
  );
}
