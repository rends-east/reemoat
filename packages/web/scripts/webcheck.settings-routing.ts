import { readFileSync, readdirSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

// Imports settings.ts, never router.ts: router.ts reads window.location and installs a popstate listener when it loads.

process.stdout.write("\nwhich settings screen a URL names\n");
{
  const {
    DEFAULT_SECTION,
    SECTION_SPECS,
    agentSetupPath,
    agentStripPath,
    harnessSigninPath,
    parseSettingsRoute,
    parseSettingsSection,
    settingsPath,
    sectionAllowed,
    visibleSections,
    settingsUp,
    settingsPaneTitle,
    settingsLeafPath,
    settingsUpLabel,
  } = await import("../src/settings.js");
  const { originFor, sheetTitle, sheetUpLabel, upFrom } = await import("../src/nav.js");

  check("no segment is the index", parseSettingsSection(undefined), null);
  check("a known one is itself", parseSettingsSection("machines"), "machines");
  check("an unknown one is the index", parseSettingsSection("nonsense"), null);
  check("the deleted Agents section is one of them", parseSettingsSection("agents"), null);
  check("and the case a URL arrives in does not decide", parseSettingsSection("Account"), null);
  check("the index path", settingsPath(), "/settings");
  check("a section path", settingsPath("account"), "/settings/account");
  check(
    "every section round-trips through its own path",
    SECTION_SPECS.map((spec) => parseSettingsSection(settingsPath(spec.id).split("/")[2])),
    SECTION_SPECS.map((spec) => spec.id),
  );

  const seg = (path: string): string[] => path.split("/").filter((part) => part.length > 0).slice(1);

  check("a machine path", settingsPath("machines", "m_1" as never), "/settings/machines/m_1");
  check(
    "a system path",
    settingsPath("machines", "m_1" as never, "openai"),
    "/settings/machines/m_1/systems/openai",
  );
  check(
    "a machine path round-trips",
    parseSettingsRoute(seg(settingsPath("machines", "m_1" as never))),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: false, leaf: null },
  );
  check(
    "a system path round-trips",
    parseSettingsRoute(seg(settingsPath("machines", "m_1" as never, "moonshot"))),
    { section: "machines", machineId: "m_1", system: "moonshot", signin: null, agents: false, leaf: null },
  );
  check(
    "a system this build does not know still parses",
    parseSettingsRoute(["machines", "m_1", "systems", "somethingnew"]).system,
    "somethingnew",
  );
  check(
    "but an absurd one is dropped rather than carried into a request path",
    parseSettingsRoute(["machines", "m_1", "systems", "x".repeat(500)]).system,
    null,
  );
  check(
    "an empty system segment falls back to the chooser",
    parseSettingsRoute(["machines", "m_1", "systems", ""]).system,
    null,
  );
  check(
    "and the machine survives that",
    parseSettingsRoute(["machines", "m_1", "systems", ""]).machineId,
    "m_1",
  );
  check(
    "a segment that is not `systems` drops to the machine",
    parseSettingsRoute(["machines", "m_1", "sessions", "kimi"]),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: false, leaf: null },
  );
  check(
    "the machine's agent strip parses",
    parseSettingsRoute(["machines", "m_1", "agents"]),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: true, leaf: null },
  );
  check(
    "and the old one-agent address opens that agent's card again",
    parseSettingsRoute(["machines", "m_1", "agents", "claude"]),
    { section: "machines", machineId: "m_1", system: null, signin: "claude", agents: true, leaf: null },
  );
  check(
    "which is the address Set up emits, under the list rather than beside it",
    agentSetupPath("m_1" as never, "claude"),
    "/settings/machines/m_1/agents/claude",
  );
  {
    const longest = `${"p".repeat(32)}:${"l".repeat(32)}`;
    check(
      "and a harness a plugin added round-trips, at the longest id one may have",
      [
        parseSettingsRoute(seg(agentSetupPath("m_1" as never, "byo:gemini")), decodeURIComponent),
        parseSettingsRoute(seg(agentSetupPath("m_1" as never, longest)), decodeURIComponent).signin,
        longest.length,
      ],
      [
        { section: "machines", machineId: "m_1", system: null, signin: "byo:gemini", agents: true, leaf: null },
        longest,
        65,
      ],
    );
    check(
      "while a segment longer than any id falls to the list",
      parseSettingsRoute(["machines", "m_1", "agents", "x".repeat(500)]),
      { section: "machines", machineId: "m_1", system: null, signin: null, agents: true, leaf: null },
    );
    check(
      "and so does the Sign-ins list's harness leaf, at the same length",
      [
        parseSettingsRoute(seg(harnessSigninPath("m_1" as never, longest)), decodeURIComponent).signin,
        parseSettingsRoute(["machines", "m_1", "signin", "x".repeat(500)]).signin,
      ],
      [longest, null],
    );
  }
  check(
    "which is the address the builder emits",
    agentStripPath("m_1" as never),
    "/settings/machines/m_1/agents",
  );
  check(
    "and it round-trips",
    parseSettingsRoute(seg(agentStripPath("m_1" as never))),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: true, leaf: null },
  );
  check(
    "the two leaves under a machine are exclusive",
    [
      parseSettingsRoute(["machines", "m_1", "agents"]).system,
      parseSettingsRoute(["machines", "m_1", "systems", "moonshot"]).agents,
      parseSettingsRoute(["machines", "m_1", "agents", "claude"]).system,
    ],
    [null, false, null],
  );
  check(
    "a machine id under another section is ignored",
    parseSettingsRoute(["account", "m_1", "agents", "kimi"]),
    { section: "account", machineId: null, system: null, signin: null, agents: false, leaf: null },
  );
  check(
    "the caller's decoder is what runs",
    parseSettingsRoute(["machines", "m%201", "agents"], decodeURIComponent).machineId,
    "m 1",
  );

  check(
    "a bare plugins segment is the machine",
    parseSettingsRoute(["machines", "m_1", "plugins"]),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: false, leaf: null },
  );
  check(
    "and so is one that still names a plugin",
    parseSettingsRoute(["machines", "m_1", "plugins", "board"]),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: false, leaf: null },
  );
  check(
    "including one nobody has installed",
    parseSettingsRoute(["machines", "m_1", "plugins", "not-installed"]),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: false, leaf: null },
  );
  {
    const source = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
    check("settings.ts builds no path to a plugin", /plugins\/\$\{/.test(source), false);
  }
  check(
    "a system goes up to its machine",
    settingsUp({ section: "machines", machineId: "m_1" as never, system: "moonshot", signin: null, agents: false, leaf: null }),
    { path: "/settings/machines/m_1", withinNav: false },
  );
  check(
    "the agent strip goes up to its machine, wherever it was opened from",
    settingsUp({ section: "machines", machineId: "m_1" as never, system: null, signin: null, agents: true, leaf: null }),
    { path: "/settings/machines/m_1", withinNav: false },
  );
  check(
    "a sign-in goes up to its machine, like the two leaves beside it",
    settingsUp({ section: "machines", machineId: "m_1" as never, system: null, signin: "acme:gemini", agents: false, leaf: null }),
    { path: "/settings/machines/m_1", withinNav: false },
  );
  {
    const setup = {
      section: "machines" as const,
      machineId: "m_1" as never,
      system: null,
      signin: "claude",
      agents: true,
      leaf: null,
    };
    const fromNew = "/new/m_1/%2FUsers%2Fme%2Fsrc";
    check(
      "the Set up leaf goes up to the list, wherever the sheet was opened from",
      [settingsUp(setup), settingsUp(setup, fromNew), settingsUpLabel(setup, fromNew)],
      [
        { path: "/settings/machines/m_1/agents", withinNav: false },
        { path: "/settings/machines/m_1/agents", withinNav: false },
        "Agents",
      ],
    );
  }
  check(
    "and it is titled by what it is rather than by which machine",
    settingsPaneTitle({ section: "machines", machineId: "m_1" as never, system: null, signin: null, agents: true, leaf: null }),
    "Agents",
  );
  {
    const strip = {
      section: "machines" as const,
      machineId: "m_1" as never,
      system: null,
      signin: null, agents: true,
      leaf: null,
    };
    const fromNew = "/new/m_1/%2FUsers%2Fme%2Fsrc";
    check(
      "the strip's chevron goes back to New session when that is where it was opened from",
      [settingsUp(strip, fromNew), settingsUpLabel(strip, fromNew)],
      [{ path: fromNew, withinNav: false }, "New session"],
    );
    check(
      "and nothing else in this sheet reads it",
      [
        settingsUp(
          { section: "machines" as const, machineId: "m_1" as never, system: null, signin: null, agents: false, leaf: null },
          fromNew,
        ),
        settingsUp(
          { section: "account" as const, machineId: null, system: null, signin: null, agents: false, leaf: null },
          fromNew,
        ),
      ],
      [
        { path: "/settings/machines", withinNav: false },
        { path: "/settings", withinNav: true },
      ],
    );
    check(
      "a crossing from any other pop-up falls back to the address",
      settingsUp(strip, "/plugins/p/board"),
      { path: "/settings/machines/m_1", withinNav: false },
    );
    check("and so does no crossing at all", settingsUp(strip), {
      path: "/settings/machines/m_1",
      withinNav: false,
    });
    const list = "/settings/machines/m_1/agents";
    const leaf = "/settings/machines/m_1/agents/claude";
    const at = (path: string) => parseSettingsRoute(seg(path), decodeURIComponent);
    const o1 = originFor(fromNew, list, null);
    const o2 = originFor(list, leaf, o1);
    const up1 = settingsUp(at(leaf), o2);
    const o3 = originFor(leaf, up1?.path ?? "", o2);
    const up2 = settingsUp(at(list), o3);
    check(
      "New session → Agents → Set up → ◀ → ◀ lands back on New session",
      [o1, o2, up1, up2, settingsUpLabel(at(leaf), o2), settingsUpLabel(at(list), o3)],
      [
        fromNew,
        fromNew,
        { path: list, withinNav: false },
        { path: fromNew, withinNav: false },
        "Agents",
        "New session",
      ],
    );
  }

  const plain = { id: "u_1", name: "ada", isAdmin: false };
  const admin = { id: "u_2", name: "root", isAdmin: true };
  check("a plain user sees five sections", visibleSections(plain).map((s) => s.id), ["account", "devices", "keys", "machines", "logs"]);
  check(
    "an admin sees eight",
    visibleSections(admin).map((s) => s.id),
    ["account", "devices", "keys", "machines", "logs", "server", "email", "users"],
  );
  check("and the table has exactly eight entries", SECTION_SPECS.length, 8);
  check("and Logs is not an admin section", SECTION_SPECS.find((spec) => spec.id === "logs")?.adminOnly, false);
  check(
    "the user sections carry no blurb and the admin sections do",
    SECTION_SPECS.map((spec) => spec.blurb !== null),
    SECTION_SPECS.map((spec) => spec.adminOnly),
  );

  const leafOf = (segments: readonly string[]): string | null => parseSettingsRoute(segments).leaf;
  check(
    "the three form screens parse to their leaf",
    [leafOf(["account", "password"]), leafOf(["account", "email"]), leafOf(["keys", "new"])],
    ["password", "email", "new-key"],
  );
  check(
    "and anything else under those sections falls up to the section",
    [parseSettingsRoute(["account", "nope"]), parseSettingsRoute(["keys", "password"])].map((r) => [r.section, r.leaf]),
    [["account", null], ["keys", null]],
  );
  check("a leaf never carries a machine", parseSettingsRoute(["account", "password"]).machineId, null);
  check(
    "each leaf's path parses back to itself",
    (["password", "email", "new-key"] as const).map((leaf) => parseSettingsRoute(settingsLeafPath(leaf).split("/").slice(2)).leaf),
    ["password", "email", "new-key"],
  );
  check(
    "a form screen goes up to its section, outside the nav",
    [settingsUp(parseSettingsRoute(["account", "password"])), settingsUp(parseSettingsRoute(["keys", "new"]))],
    [{ path: "/settings/account", withinNav: false }, { path: "/settings/keys", withinNav: false }],
  );
  check(
    "and is titled by what it is, never by its parent's name",
    (["password", "email", "new-key"] as const).map((leaf) => settingsPaneTitle(parseSettingsRoute(settingsLeafPath(leaf).split("/").slice(2)))),
    ["Password", "Your email", "New key"],
  );
  const accountSrc = stripComments(readFileSync(new URL("../src/ui/settings/AccountSection.tsx", import.meta.url), "utf8"));
  const keysSrc = stripComments(readFileSync(new URL("../src/ui/settings/KeysSection.tsx", import.meta.url), "utf8"));
  check("no row on Account opens a form in place", /setEditing|\[editing,/.test(accountSrc), false);
  check("and its verbs navigate to the leaf", (accountSrc.match(/navigate\(settingsLeafPath\(/g) ?? []).length >= 3, true);
  check("the keys screen is a table", /<KeyTable>/.test(keysSrc), true);
  check("whose New key leaves the screen rather than opening under itself", /navigate\(settingsLeafPath\("new-key"\)\)/.test(keysSrc) && !/setAsking/.test(keysSrc), true);
  const newKeyScreen = keysSrc.slice(keysSrc.indexOf("export function NewKeyScreen"));
  check("and the New key screen mints nothing itself", /mintMyKey\(/.test(newKeyScreen), false);
  check("peeks the handoff in its state initialiser", /useState<string \| null>\(peekHandoff\)/.test(newKeyScreen), true);
  check("clears it from the effect, first", /useEffect\(\(\) => \{\s*clearHandoff\(\);/.test(newKeyScreen), true);
  check("and clearing nulls the handoff", /function clearHandoff\(\): void \{\s*handoff = null;\s*\}/.test(keysSrc), true);
  check("and walks back when there is nothing to show", /if \(minted === null\) back\(\);/.test(newKeyScreen), true);
  check("and the minted key is drawn once, with no second box of the same bytes", /CommandLine/.test(keysSrc), false);
  // One placeholder row per settings list, at the height of the row it stands in for (Q3.548).
  const bitsSrc = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
  check("SkeletonRow takes no count", /export function SkeletonRow\(\{ tall = false \}: \{ tall\?: boolean \} = \{\}\): ReactNode/.test(bitsSrc), true);
  check("only a height, in the two settings-row sizes", /tall \? "min-h-14" : "min-h-11"/.test(bitsSrc), true);
  check("and stands the list in as busy, with the bar hidden", /aria-busy="true"[\s\S]{0,200}aria-hidden="true"/.test(bitsSrc), true);
  const settingsDir = new URL("../src/ui/settings/", import.meta.url);
  const twoInARow = readdirSync(settingsDir)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => /<SkeletonRow[^>]*\/>\s*<SkeletonRow[^>]*\/>|\.map\([^)]*<SkeletonRow/.test(stripComments(readFileSync(new URL(name, settingsDir), "utf8"))));
  check("no settings list draws two placeholder rows", twoInARow, []);
  const machinesSrc = stripComments(readFileSync(new URL("../src/ui/settings/MachinesSection.tsx", import.meta.url), "utf8"));
  check("the machines list's skeleton is the tall one", /<SkeletonRow tall \/>/.test(machinesSrc), true);
  check("and the machine row is min-h-14", /className="tap press flex w-full min-h-14 items-center/.test(machinesSrc), true);
  check("while no other settings list asks for it", readdirSync(settingsDir).filter((name) => name !== "MachinesSection.tsx" && /<SkeletonRow tall/.test(readFileSync(new URL(name, settingsDir), "utf8"))), []);
  check("and somebody we could not identify sees five", visibleSections(null).map((s) => s.id), ["account", "devices", "keys", "machines", "logs"]);
  check("the default section is a real one", SECTION_SPECS.some((spec) => spec.id === DEFAULT_SECTION), true);
  check("and it is the first row, so the rail's highlight is not a choice somebody made", SECTION_SPECS[0]?.id, DEFAULT_SECTION);
  check(
    "and one nobody is refused",
    [null, plain, admin].map((me) => sectionAllowed(DEFAULT_SECTION, me)),
    [true, true, true],
  );
  check("a bare /settings is still the index", parseSettingsSection(undefined), null);
  check("with nowhere to go", settingsUp(parseSettingsRoute([])), null);
  check("and no name for the pane", settingsPaneTitle(parseSettingsRoute([])), null);
  check("a typed URL is not a tap", [sectionAllowed("users", null), sectionAllowed("users", plain), sectionAllowed("users", admin)], [false, false, true]);
  check("nothing else fails closed on a missing `me`", sectionAllowed("account", null), true);
  check(
    "no admin-only section is ever offered to a non-admin",
    [visibleSections(null), visibleSections(plain)].map((list) => list.filter((spec) => spec.adminOnly).length),
    [0, 0],
  );
  check(
    "and every section an admin sees is reachable by URL",
    visibleSections(admin).map((spec) => sectionAllowed(spec.id, admin)),
    visibleSections(admin).map(() => true),
  );
  check(
    "the list and the URL guard agree on every section",
    SECTION_SPECS.every((spec) =>
      [null, plain, admin].every(
        (me) => sectionAllowed(spec.id, me) === visibleSections(me).some((s) => s.id === spec.id),
      ),
    ),
    true,
  );

  const up = (segments: readonly (string | undefined)[]) => settingsUp(parseSettingsRoute(segments));
  check("the index has nowhere to go", up([]), null);
  check("a section goes to the index", up(["account"]), { path: "/settings", withinNav: true });
  check("and so does Machines", up(["machines"]), { path: "/settings", withinNav: true });
  check("a machine's systems go up to Machines, at every width", up(["machines", "m_1", "systems"]), {
    path: "/settings/machines",
    withinNav: false,
  });
  check("and one system goes up to its machine", up(["machines", "m_1", "systems", "anthropic"]), {
    path: "/settings/machines/m_1",
    withinNav: false,
  });
  const reachable: readonly (readonly (string | undefined)[])[] = [
    ["account"],
    ["users"],
    ["machines"],
    ["machines", "m_1"],
    ["machines", "m_1", "agents"],
    ["machines", "m_1", "agents", "claude"],
    ["machines", "m_1", "systems"],
    ["machines", "m_1", "systems", "moonshot"],
    ["account", "password"],
    ["account", "email"],
    ["keys"],
    ["keys", "new"],
    ["email"],
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

  // The sheet head names the pop-up and the pane names the screen, because the head spans the section rail at sm and above (Q3.427).
  const pane = (segments: readonly (string | undefined)[]): string | null =>
    settingsPaneTitle(parseSettingsRoute(segments));
  check("the index has no pane heading", pane([]), null);
  check(
    "a section names itself in the pane",
    [pane(["account"]), pane(["keys"]), pane(["machines"]), pane(["server"]), pane(["email"]), pane(["users"])],
    ["Account", "API keys", "Machines", "Server", "Email", "Users"],
  );
  check(
    "every machine depth is titled by what the screen is",
    [
      pane(["machines", "m_1"]),
      pane(["machines", "m_1", "systems"]),
      pane(["machines", "m_1", "systems", "moonshot"]),
      pane(["machines", "m_1", "signin", "byo:gemini"]),
    ],
    ["Machine settings", "Machine settings", "Sign-in", "Sign-in"],
  );
  {
    const { unspokenFor, anyKeySet } = await import("../src/agents.js");
    const sys = (id: string, loginVia: string | null): unknown => ({ id, displayName: id, loginVia });
    const harness = (id: string, slots: { envName: string; set: boolean }[]): unknown => ({
      id,
      displayName: id,
      available: true,
      loggedIn: null,
      credentials: slots,
    });
    const built = [
      sys("anthropic", "claude"),
      sys("openai", "codex"),
      sys("moonshot", "kimi"),
      sys("openrouter", "opencode"),
      sys("byo:deepseek", null),
    ] as never;
    const machine = [
      harness("claude", [{ envName: "ANTHROPIC_API_KEY", set: true }]),
      harness("opencode", [{ envName: "OPENROUTER_API_KEY", set: false }]),
      harness("byo:gemini", [{ envName: "GEMINI_API_KEY", set: false }]),
    ] as never;
    check(
      "only a harness no provider speaks for gets a row of its own",
      unspokenFor(machine, built).map((one: { id: string }) => one.id),
      ["byo:gemini"],
    );
    check(
      "and a plugin that named its own harness gets no second row",
      unspokenFor(machine, [...(built as unknown as unknown[]), sys("byo:native", "byo:gemini")] as never).map(
        (one: { id: string }) => one.id,
      ),
      [],
    );
    check(
      "nor one with nowhere to put a key",
      unspokenFor([harness("byo:keyless", [])] as never, built).map((one: { id: string }) => one.id),
      [],
    );
    check(
      "and an unread listing offers nothing",
      [unspokenFor(machine, null).length, unspokenFor(null, built).length],
      [0, 0],
    );
    check(
      "a row says whether a key is saved, never whether anybody signed in",
      [
        anyKeySet(harness("a", [{ envName: "X", set: false }, { envName: "Y", set: true }]) as never),
        anyKeySet(harness("b", [{ envName: "X", set: false }]) as never),
      ],
      [true, false],
    );
    const { harnessSigninPath, parseSettingsRoute } = await import("../src/settings.js");
    const walked = parseSettingsRoute(
      harnessSigninPath("m_1" as never, "byo:gemini").slice("/settings/".length).split("/"),
      decodeURIComponent,
    );
    check(
      "the harness leaf round-trips through its own segment",
      [walked.signin, walked.system, walked.agents],
      ["byo:gemini", null, false],
    );
    const asBefore = parseSettingsRoute(["machines", "m_1", "systems", "moonshot"]);
    check("while the provider leaf is untouched", [asBefore.system, asBefore.signin], ["moonshot", null]);
    const panel = stripComments(
      readFileSync(new URL("../src/ui/settings/SystemsPanel.tsx", import.meta.url), "utf8"),
    );
    const machinePane = stripComments(
      readFileSync(new URL("../src/ui/settings/MachineSection.tsx", import.meta.url), "utf8"),
    );
    check(
      "the list draws the rule's rows, after every provider, and leads to the other leaf",
      [
        /unspokenFor\(agents, systems\)\.map/.test(panel),
        panel.indexOf("unspokenFor(agents, systems)") > panel.indexOf("onClick={() => onPick(system.id)}"),
        /onPickHarness\(agent\.id\)/.test(panel),
        /harnessSigninPath\(machineId, agent\)/.test(
          stripComments(
            readFileSync(new URL("../src/ui/settings/MachineSystemsSection.tsx", import.meta.url), "utf8"),
          ),
        ),
      ],
      [true, true, true, true],
    );
    check(
      "and the heading no longer says the half that came first",
      [machinePane.includes(">Sign-ins</h2>"), machinePane.includes(">Systems</h2>")],
      [true, false],
    );
  }
  check(
    "and no depth is titled the same as the screen its chevron points at",
    reachable.filter((segments) => {
      const route = parseSettingsRoute(segments);
      const label = settingsUpLabel(route);
      return label !== null && label === settingsPaneTitle(route);
    }),
    [],
  );
  check(
    "the strip is titled Agents and its leaf Setup",
    [pane(["machines", "m_1", "agents"]), pane(["machines", "m_1", "agents", "claude"])],
    ["Agents", "Setup"],
  );
  check("and takes no machine name to say it", settingsPaneTitle.length, 1);
  const everyShape: readonly (readonly (string | undefined)[])[] = [...reachable, []];
  check(
    "a heading and a way up arrive together",
    everyShape.map((segments) => settingsPaneTitle(parseSettingsRoute(segments)) === null),
    everyShape.map((segments) => settingsUp(parseSettingsRoute(segments)) === null),
  );
  const settingsTsxSrc = stripComments(
    readFileSync(new URL("../src/ui/settings/Settings.tsx", import.meta.url), "utf8"),
  );
  check("the head is the pop-up's name, not the screen's", sheetTitle({ name: "settings", section: "account", machineId: null, system: null } as never), "Settings");
  check("and the pane draws no panel of its own", /<Sheet/.test(settingsTsxSrc), false);
  check(
    "and the pane's heading is withdrawn where the rail draws the row",
    /withinNav\s*\?\s*"sm:hidden"\s*:\s*""/.test(settingsTsxSrc),
    true,
  );
  check("the neutral pane is gone", /Pick a setting from the list/.test(settingsTsxSrc), false);
  check(
    "the desktop draws the default instead",
    /hidden sm:block/.test(settingsTsxSrc) && /DEFAULT_SECTION/.test(settingsTsxSrc),
    true,
  );
  check("and the phone still gets the list", /sm:hidden[\s\S]{0,200}variant="page"/.test(settingsTsxSrc), true);
  check(
    "the way up is still computed from the section the URL names",
    /const here = \{ \.\.\.route, section: active \};/.test(settingsTsxSrc),
    true,
  );
  check("one section renders through one table", /function SectionBody\(/.test(settingsTsxSrc), true);
  check(
    "and each section is drawn from exactly one place",
    ["<MachinesSection", "<AccountSection", "<KeysSection", "<ServerSection", "<EmailSection", "<UsersSection"].map(
      (tag) => (settingsTsxSrc.match(new RegExp(tag, "g")) ?? []).length,
    ),
    [1, 1, 1, 1, 1, 1],
  );

  const sheetSrc = stripComments(readFileSync(new URL("../src/ui/Sheet.tsx", import.meta.url), "utf8"));
  check("a sheet's title is the panel's name, one rank above the pane's", /<h1 id=\{headingId\}/.test(sheetSrc), true);
  check("and exactly one element is what the dialog is named by", (sheetSrc.match(/id=\{headingId\}/g) ?? []).length, 1);
  check("and nothing hides it at a width", /id=\{headingId\}[^>]*(sm:)?hidden/.test(sheetSrc), false);

  check("the pane draws the way back", /ChevronLeft/.test(settingsTsxSrc), true);
  check(
    "only the one-column pop-up puts a chevron in the head",
    [
      sheetUpLabel({ name: "settings", section: "account", machineId: null, system: null } as never),
      sheetUpLabel({ name: "plugins", tab: "market", entry: null, settings: [] } as never),
      sheetUpLabel({ name: "plugin", machineId: "m_1", pluginId: "p" } as never),
      sheetUpLabel({ name: "new", machineId: null, cwd: null } as never),
      sheetUpLabel({ name: "agent", machineId: "m_1", cwd: null, step: null, preset: null , harness: null } as never),
      sheetUpLabel({ name: "agent", machineId: "m_1", cwd: null, step: "llm", preset: null , harness: null } as never),
    ],
    [null, null, null, null, "New session", "Configure agent"],
  );
  {
    const headUp = (route: unknown): string | null =>
      sheetUpLabel(route as never) === null ? null : upFrom(route as never, "/");
    const popups = [
      { name: "settings", section: "account", machineId: null, system: null },
      { name: "settings", section: "machines", machineId: "m_1", system: "moonshot" },
      { name: "plugins", tab: "market", entry: null, settings: [] },
      { name: "plugin", machineId: "m_1", pluginId: "p" },
      { name: "new", machineId: null, cwd: null },
      { name: "agent", machineId: "m_1", cwd: null, step: "llm", preset: null , harness: null },
    ];
    check(
      "and every one of them has somewhere up, which is what the head declines to draw",
      popups.map((route) => upFrom(route as never, "/")),
      ["/settings", "/settings/machines/m_1", "/", "/", "/", "/agent/m_1"],
    );
    check(
      "so the head's chevron is the builder's alone",
      popups.map(headUp),
      [null, null, null, null, null, "/agent/m_1"],
    );
  }
  check("nor reserves room for one", /inline-flex w-3 shrink-0/.test(sheetSrc), false);
  check("the head draws one only when a caller hands it somewhere to go", /\{up !== undefined && \(/.test(sheetSrc), true);

  check("the panel is re-focused per screen, not per sheet", /useEffect\(\(\) => \{\s*panelRef\.current\?\.focus\(\);\s*\}, \[screen\]\);/.test(sheetSrc), true);
  check("and exactly one thing in the panel remembers where focus came from", (sheetSrc.match(/document\.activeElement/g) ?? []).length, 1);
  check(
    "and it is declared first, and keyed on nothing",
    /const previous = document\.activeElement;[\s\S]*?\}, \[\]\);[\s\S]*?\}, \[screen\]\);/.test(sheetSrc),
    true,
  );
  check("the panel says what screen it is on", (sheetSrc.match(/role="status"/g) ?? []).length, 1);
  check("and says it by rendering the head rather than a copy of it", /<p role="status" aria-live="polite" className="sr-only">\s*\{title\}/.test(sheetSrc), true);
  // Each index is checked to be >= 0 first: a missing attribute answers -1 and would pass the ordering check.
  const modalAt = sheetSrc.indexOf("aria-modal");
  const regionAt = sheetSrc.indexOf('role="status"');
  const portalAt = sheetSrc.indexOf("document.body,");
  check("the panel is still a modal dialog", modalAt >= 0, true);
  check("and still portals somewhere", portalAt >= 0, true);
  check(
    "and the region is inside the dialog rather than beside it",
    [modalAt >= 0 && regionAt >= 0 && modalAt < regionAt, regionAt >= 0 && portalAt >= 0 && regionAt < portalAt],
    [true, true],
  );
  check("and the head is a string, because a node has no words", [/title: string;/.test(sheetSrc), /title: ReactNode/.test(sheetSrc)], [true, false]);
  const appSrc = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  check("the sheet that has many screens actually hands one over", /screen=\{screenOf\(route\)\}/.test(appSrc), true);
  check("and the head's chevron is gated on the label rather than on the destination", /upLabel === null \? null : upFrom\(route, under, origin\)/.test(appSrc), true);
  check(
    "and both halves of it read the same origin",
    /sheetUpLabel\(route, origin\)/.test(appSrc),
    true,
  );
  check(
    "a screen key holds the screen and not the screen's own state",
    [
      /case "new":\s*return "new";/.test(appSrc),
      /route\.settings\.length > 0/.test(appSrc),
      /route\.settings\.join/.test(appSrc),
      /return `agent\/\$\{route\.step \?\? ""\}\/\$\{route\.preset \?\? ""\}\/\$\{route\.harness \?\? ""\}`;/.test(
        appSrc,
      ),
    ],
    [true, true, false, true],
  );
  check(
    "and a harness seed is part of that screen rather than its state",
    /route\.harness \?\? ""/.test(appSrc),
    true,
  );
  check("and every route shape is named rather than defaulted", /function screenOf[\s\S]*?\n\}/.exec(appSrc)?.[0].includes("default:") ?? true, false);
  check("at the settings pane's own size, which reaches 44px", /icon=\{ChevronLeft\}[\s\S]{0,400}size="nav"/.test(sheetSrc), true);
  check(
    "the chevron says where it goes",
    [
      settingsUpLabel(parseSettingsRoute(["account"])),
      settingsUpLabel(parseSettingsRoute(["machines", "m_1"])),
      settingsUpLabel(parseSettingsRoute(["machines", "m_1", "systems", "anthropic"])),
      settingsUpLabel(parseSettingsRoute(["machines", "m_1", "agents", "claude"])),
    ],
    ["Settings", "Machines", "Machine settings", "Agents"],
  );
  check("and says nothing at the index", settingsUpLabel(parseSettingsRoute([])), null);
  check(
    "the row is gated on the way up, not on the name",
    /\{up !== null && \(/.test(settingsTsxSrc),
    true,
  );

  const announced = (segments: readonly (string | undefined)[]): string | null => {
    const route = parseSettingsRoute(segments);
    return settingsPaneTitle({ ...route, section: route.section ?? DEFAULT_SECTION });
  };
  check(
    "the rail announces the pane's own name at every depth",
    reachable.filter((segments) => announced(segments) !== pane(segments)),
    [],
  );
  check("and names the default where the URL names none", [pane([]), announced([])], [null, "Account"]);
  check(
    "so every section a rail can highlight has a sentence to announce",
    SECTION_SPECS.filter((spec) => settingsPaneTitle(parseSettingsRoute([spec.id])) === null).map((spec) => spec.id),
    [],
  );
  {
    const nav = stripComments(readFileSync(new URL("../src/ui/settings/SettingsNav.tsx", import.meta.url), "utf8"));
    check(
      "the sentence is computed once, over the route the body reads",
      /const paneName = settingsPaneTitle\(\{ \.\.\.here, section: shown \}\);/.test(settingsTsxSrc),
      true,
    );
    check("and reaches both mounts", (settingsTsxSrc.match(/paneName=\{paneName\}/g) ?? []).length, 2);
    check(
      "while the rail draws it and derives nothing",
      [
        /<p role="status" aria-live="polite" className="sr-only">\s*\{paneName\}\s*<\/p>/.test(nav),
        /rows\.find/.test(nav),
      ],
      [true, false],
    );
    check("and it cannot be left out", [/^\s*paneName: string \| null;$/m.test(nav), /paneName\?:/.test(nav)], [true, false]);
  }
}

// TwoStep's rule is pinned here once, over the primitive; each site's own pin covers only what it still decides (Q3.552).
process.stdout.write("\nthe two-step confirmation is one primitive\n");
{
  const React = await import("react");
  // tsx compiles bits.tsx with the classic JSX runtime (the root tsconfig names no jsx), so rendering needs a global React.
  (globalThis as Record<string, unknown>)["React"] = React;
  const { createElement: h } = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TwoStep, twoStepAct, TWO_STEP_BOX } = await import("../src/ui/bits.js");
  const { Trash2 } = await import("lucide-react");

  const draw = (over: Partial<Parameters<typeof TwoStep>[0]>): string =>
    renderToStaticMarkup(
      h(TwoStep, {
        armed: true,
        onArm: () => {},
        question: h("span", null, "Delete ", h("b", null, "ada"), " for good?"),
        act: { label: "Delete", danger: true, icon: Trash2 },
        onAct: () => Promise.resolve(),
        className: "mt-3",
        ...over,
      }),
    );

  // Drawn with a rest, as every site passes one: without it a resting control leaking into the armed arm is invisible.
  const rest = h("button", { type: "button" }, "Retire laptop");
  const armed = draw({ rest });
  const question = armed.indexOf("for good?");
  const act = armed.indexOf("Delete</button>");
  const cancel = armed.indexOf("Cancel</button>");
  check("the armed arm draws the question, the act and Cancel", [question >= 0, act >= 0, cancel >= 0], [true, true, true]);
  check("in that order", question < act && act < cancel, true);
  check("and Cancel is the last button in the box", armed.indexOf("<button", cancel), -1);
  check("and the resting control is not drawn while armed", armed.includes("Retire laptop"), false);
  const actTag = armed.slice(armed.lastIndexOf("<button", act), act);
  const cancelTag = armed.slice(armed.lastIndexOf("<button", cancel), cancel);
  check("the act is destructive and leads with its glyph", [/text-danger/.test(actTag), /<svg/.test(actTag)], [true, true]);
  check("and Cancel is plain, never filled", [/bg-fg/.test(cancelTag), /border-edge-strong/.test(cancelTag)], [false, true]);
  check("neither is disabled before the act is tapped", /disabled=""/.test(armed), false);
  const plain = draw({ act: { label: "Save limit" } });
  const plainAct = plain.slice(plain.lastIndexOf("<button", plain.indexOf("Save limit</button>")), plain.indexOf("Save limit</button>"));
  check("a plain act is outlined too, with no glyph and no red", [/<svg/.test(plainAct), /text-danger/.test(plainAct), /border-edge-strong/.test(plainAct)], [false, false, true]);
  const actTagOf = (markup: string, label: string): string => markup.slice(markup.lastIndexOf("<button", markup.indexOf(`${label}</button>`)), markup.indexOf(`${label}</button>`));
  const namedDanger = actTagOf(draw({ act: { label: "Revoke", danger: true, icon: Trash2, ariaLabel: "Revoke abc…" } }), "Revoke");
  const namedPlain = actTagOf(draw({ act: { label: "Revoke", ariaLabel: "Revoke abc…" } }), "Revoke");
  check("the act carries the caller's accessible name, on the danger arm and the plain one", [/aria-label="Revoke abc…"/.test(namedDanger), /aria-label="Revoke abc…"/.test(namedPlain)], [true, true]);
  const withCost = draw({ consequence: "Frees the name and a slot." });
  check("a consequence is drawn under the question, muted, inside its span", /for good\?<\/span><span class="block text-muted">Frees the name and a slot\.<\/span><\/span>/.test(withCost), true);

  const resting = draw({ armed: false, rest });
  const box = (markup: string): string => /^<div class="([^"]*)">/.exec(markup)?.[1] ?? "";
  check("the resting arm draws the caller's control and no question", [resting.includes("Retire laptop"), resting.includes("Cancel"), resting.includes("for good?")], [true, false, false]);
  check("and the box is the same element with the same classes in both arms", [box(armed).length > 0, box(armed) === box(resting)], [true, true]);
  check("with the caller's className appended to it", /\bmt-3$/.test(box(armed)), true);
  check("the box is drawn from the exported string", box(armed).startsWith(`${TWO_STEP_BOX} `), true);
  const users = stripComments(readFileSync(new URL("../src/ui/settings/UsersSection.tsx", import.meta.url), "utf8"));
  check(
    "and the one form that draws the box itself takes it by name",
    [/import \{[^}]*\bTWO_STEP_BOX\b[^}]*\} from "\.\.\/bits"/.test(users), /<div className=\{`\$\{TWO_STEP_BOX\} mt-2`\}>/.test(users), /"mt-2 flex flex-wrap items-center gap-2"/.test(users)],
    [true, true, false],
  );
  const led = { lead: h("i", null, "lead") };
  check("a lead is drawn first in both arms", [draw(led).startsWith(`<div class="${box(armed)}"><i>lead</i>`), draw({ ...led, armed: false, rest: h("b", null, "rest") }).startsWith(`<div class="${box(armed)}"><i>lead</i>`)], [true, true]);

  const questionClasses = (markup: string): string => /<span class="([^"]*)">/.exec(markup)?.[1] ?? "";
  check("unset packs from the start: no centring on the box, no growth on the question", [/justify-center/.test(box(armed)), /flex-1|basis-full/.test(questionClasses(armed))], [false, false]);
  const centred = draw({ align: "center" });
  check("center centres the box and puts the question on its own line", [/\bjustify-center\b/.test(box(centred)), /\bbasis-full text-center\b/.test(questionClasses(centred))], [true, true]);
  const ended = draw({ align: "end" });
  check("end lets the question grow so the answers sit at the end", [/justify-center/.test(box(ended)), /\bflex-1\b/.test(questionClasses(ended)), /basis-full/.test(questionClasses(ended))], [false, true, false]);

  const log: string[] = [];
  const hooks = {
    setBusy: (busy: boolean): void => void log.push(`busy:${busy}`),
    disarm: (): void => void log.push("disarm"),
    fail: (cause: unknown): void => void log.push(`fail:${String(cause)}`),
  };
  twoStepAct(undefined, hooks);
  check("a void act closes the question on the tap and never goes busy", log, ["disarm"]);
  log.length = 0;
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  twoStepAct(pending, hooks);
  check("a promise goes busy at once and closes nothing yet", log, ["busy:true"]);
  settle();
  await pending;
  check("and on the 200 the wait ends and only then the question closes", log, ["busy:true", "busy:false", "disarm"]);
  log.length = 0;
  let refuse!: (cause: unknown) => void;
  const failing = new Promise<void>((_, reject) => {
    refuse = reject;
  });
  twoStepAct(failing, hooks);
  refuse(new Error("boom"));
  await failing.catch(() => undefined);
  check("and a rejection ends the wait, says why, and leaves the question standing", log, ["busy:true", "busy:false", "fail:Error: boom"]);

  const bits = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
  const primitive = bits.slice(bits.indexOf("export function TwoStep("), bits.indexOf("export const SHEET_PANEL"));
  check("the component runs its act through the protocol", /twoStepAct\(onAct\(\), \{\s*setBusy,\s*disarm: \(\) => onArm\(false\),/.test(primitive), true);
  check("and a failure defaults to a toast with errorText's sentence", /fail: onFailure \?\? \(\(cause\) => toast\("error", errorText\(cause\)\)\)/.test(primitive), true);
  check("both act arms are refused while busy or disabled", (primitive.match(/disabled=\{busy \|\| disabled\} onClick=\{run\}/g) ?? []).length, 2);
  check("Cancel is refused while busy, puts the flag back, and names no tone", /<Button size=\{size\} disabled=\{busy\} onClick=\{\(\) => onArm\(false\)\}>\s*Cancel\s*<\/Button>/.test(primitive), true);
  check("the act's label is the spinner while busy", /const label = busy \? <Spinner \/> : act\.label;/.test(primitive), true);
  check("and the primitive never arms itself", /onArm\(true\)/.test(primitive), false);

  const settingsDir = new URL("../src/ui/settings/", import.meta.url);
  const swept: (readonly [string, string])[] = [
    ...readdirSync(settingsDir)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => [name, stripComments(readFileSync(new URL(name, settingsDir), "utf8"))] as const),
    ["AgentBuilder.tsx", stripComments(readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8"))] as const,
    ["PluginConsent.tsx", stripComments(readFileSync(new URL("../src/ui/PluginConsent.tsx", import.meta.url), "utf8"))] as const,
  ];
  check("the sweep found the settings screens", swept.length >= 12, true);
  check(
    "no settings screen hand-rolls a two-step's Cancel",
    swept.filter(([, src]) => /onClick=\{\(\) => set\w+\((?:false|null)\)\}[^<]*>\s*Cancel\s*</.test(src)).map(([name]) => name),
    [],
  );
  check(
    "and every Cancel left, counted as a token, is a form's way back or an abort",
    swept.map(([name, src]) => [name, (src.match(/\bCancel\b/g) ?? []).length] as const).filter(([, n]) => n > 0),
    [["AccountSection.tsx", 2], ["AgentsPanel.tsx", 1], ["PluginsPanel.tsx", 2]],
  );
  check("and no Cancel anywhere on them is filled", swept.filter(([, src]) => /tone="primary"[\s\S]{0,160}?>\s*Cancel\s*</.test(src)).map(([name]) => name), []);
  const sites = swept
    .map(([name, src]) => [name, (src.match(/<TwoStep\b/g) ?? []).length] as const)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  check(
    "the fifteen confirmations are the primitive's, by file",
    sites,
    [
      ["AccountSection.tsx", 1],
      ["AgentBuilder.tsx", 1],
      ["AgentsPanel.tsx", 1],
      ["DevicesSection.tsx", 1],
      ["EmailSection.tsx", 1],
      ["MachineAgentsSection.tsx", 1],
      ["MachineSection.tsx", 1],
      ["PluginsPanel.tsx", 1],
      ["ServerSection.tsx", 3],
      ["SystemsPanel.tsx", 1],
      ["UsersSection.tsx", 3],
    ],
  );
  check("fifteen in all", sites.reduce((sum, [, n]) => sum + n, 0), 15);
  check(
    "and every one of those files imports it from bits",
    sites.filter(([name]) => !/import \{[^}]*\bTwoStep\b[^}]*\} from "\.\.?\/bits"/.test(swept.find(([n]) => n === name)?.[1] ?? "")).map(([name]) => name),
    [],
  );
}

process.stdout.write("\nthe daemon's log follows a reader at the bottom\n");
{
  const { followsTail } = await import("../src/ui/settings/LogsSection.js");
  const end = { scrollHeight: 1000, scrollTop: 600, clientHeight: 400 };
  check("a pane scrolled to the end follows", followsTail(end), true);
  check("and so does one within the slack", followsTail({ ...end, scrollTop: 568 }), true);
  check("one scrolled further up does not", followsTail({ ...end, scrollTop: 567 }), false);
  // Three lines of about sixteen pixels, measured after they render.
  check("and a reader at the end reads as scrolled away once a poll has grown the pane", followsTail({ ...end, scrollHeight: 1048 }), false);

  const logs = stripComments(readFileSync(new URL("../src/ui/settings/LogsSection.tsx", import.meta.url), "utf8"));
  check(
    "so following is decided on the reader's own scroll",
    /onScroll=\{\(event\) => \{\s*following\.current = followsTail\(event\.currentTarget\);\s*\}\}/.test(logs),
    true,
  );
  const pin = /use(?:Layout)?Effect\(\(\) => \{([\s\S]*?)\}, \[lines\]\);/.exec(logs)?.[1] ?? "";
  check(
    "and the effect after a poll acts on that decision without measuring again",
    [pin.length > 0, /following\.current\) pane\.scrollTop = pane\.scrollHeight;/.test(pin), /followsTail|clientHeight/.test(pin)],
    [true, true, false],
  );
}
