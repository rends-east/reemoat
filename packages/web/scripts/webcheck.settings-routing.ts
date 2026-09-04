import { readFileSync, readdirSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

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
    DEFAULT_SECTION,
    SECTION_SPECS,
    agentStripPath,
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
  const { sheetTitle, sheetUpLabel, upFrom } = await import("../src/nav.js");

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
   * argument, stated on `MachineSystemsSection`: what is configured belongs to
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
  /*
   * ⚠ **A system this client has never heard of still parses**, which is the one
   * place this differs from the agent segment it replaced. Systems are a table on
   * the daemon, so a machine on a newer build knows some this client does not, and
   * validating here would make them unreachable from a client that is merely
   * older. `compatibility.md` rule 2: an unknown value degrades rather than
   * throws. The daemon is what refuses one that is genuinely wrong.
   */
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
  // Three refusals, each falling *up* to the nearest real screen rather than to
  // a 404 — `parseSettingsSection`'s posture, one level down.
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
  /*
   * ⚠ **`…/agents` names a screen again, and the tail of the old address goes
   * with it.** It meant *one agent's sign-in* until a harness and the account it
   * signs in to came apart, and then it meant nothing and fell to the machine.
   * It now names the machine's agent **list** — the strip — which is what a
   * person reading the address would guess, and `…/agents/claude` lands there
   * rather than on the machine: that is still "fall up to the nearest real
   * screen", and the screen it falls to is one tap from what that address used to
   * open. A redirect is still refused, for the reason it always was — this
   * function is pure, and a redirect would have to guess which system a harness
   * stood for.
   */
  check(
    "the machine's agent strip parses",
    parseSettingsRoute(["machines", "m_1", "agents"]),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: true, leaf: null },
  );
  check(
    "and the old one-agent address falls to it, tail dropped",
    parseSettingsRoute(["machines", "m_1", "agents", "claude"]),
    { section: "machines", machineId: "m_1", system: null, signin: null, agents: true, leaf: null },
  );
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
  /*
   * ⚠ **A strip route never carries a system and a system route never carries the
   * flag**, which is what makes every consumer's `if (route.agents)` safe to test
   * first. The type cannot say it — `SettingsRoute` is deliberately not a
   * discriminated union, for the reason its own docblock gives — so the parser is
   * the only producer and this is where that is pinned.
   */
  check(
    "the two leaves under a machine are exclusive",
    [
      parseSettingsRoute(["machines", "m_1", "agents"]).system,
      parseSettingsRoute(["machines", "m_1", "systems", "moonshot"]).agents,
    ],
    [null, false],
  );
  check(
    "a machine id under another section is ignored",
    parseSettingsRoute(["account", "m_1", "agents", "kimi"]),
    { section: "account", machineId: null, system: null, signin: null, agents: false, leaf: null },
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

  /*
   * ⚠ **There is no plugin leaf under a machine any more, and these are the
   * assertions that say so rather than the absence of any.** A plugin's settings
   * moved to the plugin's own page under `/plugins`; what stays here is the list,
   * which is drawn on the machine's screen. So `…/plugins` and
   * `…/plugins/:pluginId` both answer *the machine* — the "fall up to the nearest
   * real screen" posture this parser already had, now covering an address that
   * used to resolve to something.
   *
   * Both forms are pinned, not just the bare one: the deep form is the address
   * somebody may have bookmarked or been linked, and the failure it must not have
   * is landing nowhere.
   */
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
  /*
   * ⚠ **Nothing in this module builds that path any more.** `pluginSettingsPath`
   * is gone, and this reads the file rather than the module because a deleted
   * export cannot be asserted absent by importing it — `typecheck` catches a call
   * site, and catches nothing about a *string* somebody hand-writes back into a
   * `navigate`.
   */
  {
    const source = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
    check("settings.ts builds no path to a plugin", /plugins\/\$\{/.test(source), false);
  }
  /*
   * One system walks up to its machine, because the list is drawn on it. It was a
   * pair with a plugin's leaf; the plugin half is gone, and this is what is left
   * of the rule rather than a rule that quietly stopped covering anything.
   */
  check(
    "a system goes up to its machine",
    settingsUp({ section: "machines", machineId: "m_1" as never, system: "moonshot", signin: null, agents: false, leaf: null }),
    { path: "/settings/machines/m_1", withinNav: false },
  );
  /*
   * ⚠ **And the strip goes up to its machine too, which is the assertion that
   * `settingsUp` may not be reading `history.state`.** This screen has two doors
   * — a row on the machine's screen, and New session's gear — and only one of
   * them is a *parent*. The gear is a crossing between two pop-ups, answered by
   * `origin`; if the chevron here ever started naming where you came from, it
   * would be `history.back()` wearing a hat, which `Header.tsx` argues against and
   * this whole module is derived-from-the-URL to avoid.
   */
  check(
    "the agent strip goes up to its machine, wherever it was opened from",
    settingsUp({ section: "machines", machineId: "m_1" as never, system: null, signin: null, agents: true, leaf: null }),
    { path: "/settings/machines/m_1", withinNav: false },
  );
  /*
   * ⚠ **And so does a sign-in, which was the one leaf that did not.** It walked to
   * the machines *list* — one level past its own machine — under a chevron reading
   * "Back to Machines" beside a pane `settingsPaneTitle` titles "Sign-in". Same
   * defect as the system leaf above, reintroduced by an `if` that enumerates the
   * leaves rather than deriving them, and asserted here so the next leaf added has
   * a row to copy.
   */
  check(
    "a sign-in goes up to its machine, like the two leaves beside it",
    settingsUp({ section: "machines", machineId: "m_1" as never, system: null, signin: "acme:gemini", agents: false, leaf: null }),
    { path: "/settings/machines/m_1", withinNav: false },
  );
  check(
    "and it is titled by what it is rather than by which machine",
    settingsPaneTitle({ section: "machines", machineId: "m_1" as never, system: null, signin: null, agents: true, leaf: null }),
    "Agents",
  );
  /*
   * ⚠ **Except when it was opened from New session, which is a crossing and not a
   * parent.** The strip's gear leaves one pop-up for another, so the machine — the
   * parent in the URL — is not where anybody came from, and a ◀ walking there
   * strands them in settings with the sheet they were filling in gone. That was
   * reported. `origin` is what answers it, exactly as it does for the market and
   * for the builder.
   *
   * ⚠ **And it is read at this one screen only.** Applied at every depth it would
   * break walking *up* inside this sheet, because `originFor` keeps an origin
   * across a move *within* one pop-up — so a settings sheet opened from New session
   * would answer `/new` for its sections and its machines too. The two rows below
   * are that assertion.
   */
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
    /*
     * ⚠ **Narrowed to the New session pop-up rather than to "any origin", and the
     * label is why.** `settingsUpLabel` derives every other name by parsing the
     * parent as a settings address; a `/plugins` parent would answer `null` there
     * and draw a chevron reading "Settings" over a screen that is not it. One
     * destination outside this sheet, one name for it, and no way to produce a
     * third.
     */
    check(
      "a crossing from any other pop-up falls back to the address",
      settingsUp(strip, "/plugins/p/board"),
      { path: "/settings/machines/m_1", withinNav: false },
    );
    // And with no origin at all, which is the machine-row door and a cold link.
    check("and so does no crossing at all", settingsUp(strip), {
      path: "/settings/machines/m_1",
      withinNav: false,
    });
  }

  const plain = { id: "u_1", name: "ada", isAdmin: false };
  const admin = { id: "u_2", name: "root", isAdmin: true };
  check("a plain user sees three sections", visibleSections(plain).map((s) => s.id), ["account", "keys", "machines"]);
  check(
    "an admin sees six",
    visibleSections(admin).map((s) => s.id),
    ["account", "keys", "machines", "server", "email", "users"],
  );
  // Six ids, and this is the count the plan named three ways before it was one:
  // the union, the table and the `SectionBody` switch. The switch ends in a
  // `never` arm and the union is the table's element type, so this line is the
  // table's own claim.
  check("and the table has exactly six entries", SECTION_SPECS.length, 6);
  // The owner's call: the rows everybody sees say what they are and carry no
  // second line; the admin rows keep one because their titles do not.
  check(
    "the user sections carry no blurb and the admin sections do",
    SECTION_SPECS.map((spec) => spec.blurb !== null),
    SECTION_SPECS.map((spec) => spec.adminOnly),
  );

  /*
   * **Nothing on a settings screen expands in place.** The password form, the
   * address form and the key mint opened inside their rows for one release and
   * the owner's review of it was two words. Each is a leaf address now; the row
   * carries the verb and the verb navigates. Pinned at both ends: the parser
   * answers the leaf, and the screens hold no `editing`/`asking` toggle.
   */
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
  // The mint is the list's one tap and the screen only shows the answer: it
  // calls `mintMyKey` nowhere, reads the handoff once, and leaves when empty.
  const newKeyScreen = keysSrc.slice(keysSrc.indexOf("export function NewKeyScreen"));
  check("and the New key screen mints nothing itself", /mintMyKey\(/.test(newKeyScreen), false);
  check("reads the handoff once", /useState<string \| null>\(takeHandoff\)/.test(newKeyScreen), true);
  check("and walks back when there is nothing to show", /if \(minted === null\) back\(\);/.test(newKeyScreen), true);
  check("and the minted key is drawn once, with no second box of the same bytes", /CommandLine/.test(keysSrc), false);
  /*
   * **One placeholder row per settings list, and the primitive cannot be asked
   * for more.** `SkeletonRow` exists because "No keys yet." was drawn before the
   * keys had been read, and it is one row because the lists it stands in for
   * commonly hold zero or one thing — three placeholders collapsing to one
   * sentence is a layout shift that implied two items. Q3.548. Pinned on the
   * primitive's signature and on every settings file, so a `rows` prop or a
   * second adjacent row cannot arrive quietly.
   */
  const bitsSrc = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
  check("SkeletonRow takes no count", /export function SkeletonRow\(\): ReactNode/.test(bitsSrc), true);
  check("and stands the list in as busy, with the bar hidden", /aria-busy="true"[\s\S]{0,200}aria-hidden="true"/.test(bitsSrc), true);
  const settingsDir = new URL("../src/ui/settings/", import.meta.url);
  const twoInARow = readdirSync(settingsDir)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => /<SkeletonRow \/>\s*<SkeletonRow \/>|\.map\([^)]*<SkeletonRow/.test(stripComments(readFileSync(new URL(name, settingsDir), "utf8"))));
  check("no settings list draws two placeholder rows", twoInARow, []);
  /*
   * `me` really is null while `phase` is "ready": `bootstrap`'s catch keeps that
   * phase when the control plane is unreachable but machines are already known,
   * and never sets `me`. So this fails closed rather than optimistically.
   */
  check("and somebody we could not identify sees three", visibleSections(null).map((s) => s.id), ["account", "keys", "machines"]);
  /*
   * The default the pane draws where the URL names no section — `Settings.tsx`
   * renders it at `sm` and above, and the rail highlights the same constant.
   */
  check("the default section is a real one", SECTION_SPECS.some((spec) => spec.id === DEFAULT_SECTION), true);
  check("and it is the first row, so the rail's highlight is not a choice somebody made", SECTION_SPECS[0]?.id, DEFAULT_SECTION);
  /*
   * ⚠ **The one that would actually bite.** The desktop pane draws this with nobody
   * having tapped for it, so an `adminOnly` default opens a non-admin on a screen
   * whose every request answers 403 — and `visibleSections`, which exists to stop
   * exactly that, is not on this path. Over all three identities, `null` included.
   */
  check(
    "and one nobody is refused",
    [null, plain, admin].map((me) => sectionAllowed(DEFAULT_SECTION, me)),
    [true, true, true],
  );
  /*
   * ⚠ **The index is still the index.** Drawing a section at `/settings` is a fact
   * about the pane, not about the route: below `sm` that address really is the
   * section list, and a parser that answered `account` here would delete the phone's
   * list screen and give the chevron a self-loop.
   */
  check("a bare /settings is still the index", parseSettingsSection(undefined), null);
  check("with nowhere to go", settingsUp(parseSettingsRoute([])), null);
  check("and no name for the pane", settingsPaneTitle(parseSettingsRoute([])), null);
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
  check("a machine's systems go up to Machines, at every width", up(["machines", "m_1", "systems"]), {
    path: "/settings/machines",
    withinNav: false,
  });
  // Up from a system is the machine's own screen — which is where its systems are
  // listed, so the chooser did not go anywhere, it stopped being a screen of its own.
  check("and one system goes up to its machine", up(["machines", "m_1", "systems", "anthropic"]), {
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
    // ⚠ The two system depths were missing from this list, which is what let a
    // system route reach the pane with no arm of its own and no sweep noticing:
    // the chevron and the heading below both read "Machine settings" for a
    // release. They are reachable shapes — `MachineSystemsSection` links to the
    // first and every card on it to the second — so they belong to every sweep
    // this list drives, not only to the three literals one block down.
    ["machines", "m_1", "systems"],
    ["machines", "m_1", "systems", "moonshot"],
    // The three form screens, each its own address rather than a form opening
    // inside a row (`SettingsLeaf`). Reachable: every row's verb navigates here.
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

  /* ---------------------------------------------------------------- *
   * Which element names a settings screen
   *
   * ⭐ A sheet's head is a child of its panel, so at `sm` and above it spans the
   * 224px section rail *as well as* the pane. Measured at 1280px: the head's text
   * box starts 40px in, so `mac · agents` was drawn across a rail whose rows read
   * Account / API keys / Machines / Server / Email / Users — a title describing one pane and
   * covering two. The name moved into the pane; the head names the pop-up. Q3.427.
   * ---------------------------------------------------------------- */
  const pane = (segments: readonly (string | undefined)[]): string | null =>
    settingsPaneTitle(parseSettingsRoute(segments));
  check("the index has no pane heading", pane([]), null);
  check(
    "a section names itself in the pane",
    [pane(["account"]), pane(["keys"]), pane(["machines"]), pane(["server"]), pane(["email"]), pane(["users"])],
    ["Account", "API keys", "Machines", "Server", "Email", "Users"],
  );
  /*
   * **Every machine depth is titled by what the screen is**, never by which
   * machine it is about and never by the agent. The head used to draw
   * `route.agent` raw — a lower-case URL segment in `text-lg font-semibold` above
   * a row reading "Claude (claude-agent-acp)" — and then drew the machine's name,
   * which put the same word in the heading, the rename field under it and the
   * Retire button. The name lives where it is editable and where it is destroyed.
   * Q3.433.
   *
   * ⚠ **The system depth answers "System settings" rather than the machine's
   * string, and this list used to demand all three be identical.** That was the
   * assertion, not the rule: it was written when a system route had no arm of its
   * own and fell through to the machine's, and it therefore pinned the very
   * collision {@link settingsUpLabel} then turned into "◀ Back to Machine
   * settings" beside `<h2>Machine settings</h2>` — one string claiming to be both
   * where you are and where you are going. What the block is about survives
   * unchanged and is what the third entry still tests: the title says what the
   * **kind** of screen is. It is not the segment, which is the defect Q3.427
   * reverted verbatim (`moonshot` in `font-semibold` over a card reading the
   * daemon's own display name), and it is not the machine.
   */
  check(
    "every machine depth is titled by what the screen is",
    [
      pane(["machines", "m_1"]),
      pane(["machines", "m_1", "systems"]),
      pane(["machines", "m_1", "systems", "moonshot"]),
      pane(["machines", "m_1", "signin", "byo:gemini"]),
    ],
    /*
     * ⚠ **"Sign-in", and the two leaves say the same word on purpose.** The list
     * above them holds providers *and* harnesses now — signing in on a machine is
     * not only about inference — so what a reader opened is a sign-in either way,
     * and the leaves differ only in which of the machine's two catalogues resolved
     * the name. That is an internal difference and gets no presentation, which is
     * this screen's own standing rule about a row's kind.
     */
    ["Machine settings", "Machine settings", "Sign-in", "Sign-in"],
  );
  /* ---------------------------------------------------------------- *
   * ⭐ The Sign-ins list holds two kinds of row
   *
   * Reported: a plugin declared that its harness reads `GEMINI_API_KEY`, the
   * daemon accepted that key over `PUT /agent-auth/:agent`, and **no screen
   * anywhere offered a box to type it into**. A paste box for a harness is drawn
   * by `AgentDetail`, and for a harness with no wizard the only screen that
   * mounted it was a *system's* card, gated on `system.loginVia !== null`. Every
   * built-in is named that way — Anthropic names claude, OpenRouter and OpenCode
   * Zen both name opencode — and nothing requires a plugin to contribute such a
   * provider, so a plugin declaring only routed ones left its harness's slots
   * unreachable. `docs/PLUGINS.md` promised the box in as many words.
   *
   * So the list stopped being about inference. `unspokenFor` is the membership
   * rule and it is pure, which is what lets these run with no DOM.
   * ---------------------------------------------------------------- */
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
      // The example plugin's own shape: a routed provider, naming no harness.
      sys("byo:deepseek", null),
    ] as never;
    const machine = [
      harness("claude", [{ envName: "ANTHROPIC_API_KEY", set: true }]),
      harness("opencode", [{ envName: "OPENROUTER_API_KEY", set: false }]),
      harness("byo:gemini", [{ envName: "GEMINI_API_KEY", set: false }]),
    ] as never;
    /*
     * ⚠ **The first half is what stops this being a duplicate.** Adding every
     * harness would put claude beside Anthropic — two rows, one credential, two
     * answers to *signed in?* — which is the shape `MachineSystemsSection` was
     * built to remove and says so in its own docblock. So on a machine with no
     * plugins this answers nothing at all, and the list is byte-for-byte what it
     * was before any of this.
     */
    check(
      "only a harness no provider speaks for gets a row of its own",
      unspokenFor(machine, built).map((one: { id: string }) => one.id),
      ["byo:gemini"],
    );
    /*
     * And the plugin that *did* contribute a provider naming its harness keeps the
     * one card it already had, rather than gaining a second.
     */
    check(
      "and a plugin that named its own harness gets no second row",
      unspokenFor(machine, [...(built as unknown as unknown[]), sys("byo:native", "byo:gemini")] as never).map(
        (one: { id: string }) => one.id,
      ),
      [],
    );
    /*
     * ⚠ **A harness with nothing to paste gets no row either.** `envNames: []` is
     * an author saying a key is not how this is configured — opencode's own
     * `authHint` sends people to a terminal — and a row opening an empty card is a
     * control that is not true in the state it is drawn in.
     */
    check(
      "nor one with nowhere to put a key",
      unspokenFor([harness("byo:keyless", [])] as never, built).map((one: { id: string }) => one.id),
      [],
    );
    /*
     * ⚠ **An unread listing answers nothing, and the systems half is the one that
     * matters.** Without the providers there is no way to know which harnesses are
     * already spoken for, and guessing the permissive way draws a duplicate row for
     * claude for as long as that read is in flight. The screen degrades the other
     * way round on purpose: a failed `GET /agent-auth` leaves the providers exactly
     * as they were.
     */
    check(
      "and an unread listing offers nothing",
      [unspokenFor(machine, null).length, unspokenFor(null, built).length],
      [0, 0],
    );
    // The badge's own fact, which is a key rather than a sign-in: these are exactly
    // the harnesses with no wizard, so "signed in" is a word this row cannot use.
    check(
      "a row says whether a key is saved, never whether anybody signed in",
      [
        anyKeySet(harness("a", [{ envName: "X", set: false }, { envName: "Y", set: true }]) as never),
        anyKeySet(harness("b", [{ envName: "X", set: false }]) as never),
      ],
      [true, false],
    );
    /*
     * The address, and the two leaves are separate because a plugin may name the
     * same local id in both of its contribution blocks — so one segment could not
     * say which catalogue resolves it.
     */
    const { harnessSigninPath, parseSettingsRoute } = await import("../src/settings.js");
    // With the decoder the real caller passes: a contributed id carries a colon,
    // which `harnessSigninPath` percent-encodes, so an identity decode here would
    // be asserting the wrong half of the round trip.
    const walked = parseSettingsRoute(
      harnessSigninPath("m_1" as never, "byo:gemini").slice("/settings/".length).split("/"),
      decodeURIComponent,
    );
    check(
      "the harness leaf round-trips through its own segment",
      [walked.signin, walked.system, walked.agents],
      ["byo:gemini", null, false],
    );
    /*
     * ⚠ **And every address that ever worked still does**, which is why the
     * provider leaf was left where it was rather than moved under one shared
     * segment.
     */
    const asBefore = parseSettingsRoute(["machines", "m_1", "systems", "moonshot"]);
    check("while the provider leaf is untouched", [asBefore.system, asBefore.signin], ["moonshot", null]);
    /*
     * ⚠ **Placements, read off disk, because nothing typed can hold one.** The
     * rule is pure and asserted above; what is not expressible in a type is that
     * the list actually calls it, that the row leads to the leaf rather than to the
     * provider one, and that the heading stopped saying a word that is no longer
     * true of what is under it.
     */
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
        // After the providers: a group appearing rather than a group moving.
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
  /*
   * ⚠ **And the general form of that defect, rather than the one instance of it:
   * no depth may share its title with its own parent's.** `settingsUpLabel` is
   * derived from the parent's title, so a title that is not injective across a
   * parent and its child draws a chevron and a heading that read alike, and
   * nothing in either function can detect it — the label is *correct*, it is the
   * pair that is useless. Swept over every reachable shape so a seventh depth
   * cannot land on a parent's string the way the system depth did.
   */
  check(
    "and no depth is titled the same as the screen its chevron points at",
    reachable.filter((segments) => {
      const route = parseSettingsRoute(segments);
      const label = settingsUpLabel(route);
      return label !== null && label === settingsPaneTitle(route);
    }),
    [],
  );
  /*
   * ⚠ **`…/agents` moved out of that list rather than being deleted from it, and
   * the two shapes above took its place.** It was there as an address naming
   * *nothing* — the old one-agent screen, falling to the machine — so it asserted
   * that a dead address is titled by where it lands. It names a screen again now,
   * and that screen has a name of its own; what still has to hold is the rule the
   * block is about, which is that the title says what the screen **is**. "Agents"
   * is that answer, not the machine's name and not "Agents on <machine>": the
   * machine is named by the row you came through and by the chevron pointing back
   * at it.
   */
  check(
    "and the strip is titled by what it is, at both of its addresses",
    [pane(["machines", "m_1", "agents"]), pane(["machines", "m_1", "agents", "claude"])],
    ["Agents", "Agents"],
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
  /*
   * ⚠ **The head is `sheetTitle`'s answer now, and `Settings.tsx` renders no
   * `<Sheet>` at all.** There is one panel for every route-backed pop-up, so this
   * moved from a class string in one screen to a pure function over every route —
   * which is strictly better here, since it can be *driven* rather than grepped.
   * What still has to be read off disk is that this file does not draw a second
   * panel inside the first. Q3.484.
   */
  check("the head is the pop-up's name, not the screen's", sheetTitle({ name: "settings", section: "account", machineId: null, system: null } as never), "Settings");
  check("and the pane draws no panel of its own", /<Sheet/.test(settingsTsxSrc), false);
  check(
    "and the pane's heading is withdrawn where the rail draws the row",
    /withinNav\s*\?\s*"sm:hidden"\s*:\s*""/.test(settingsTsxSrc),
    true,
  );
  /*
   * No neutral state at `sm` and above: the rail highlights `DEFAULT_SECTION` and
   * the pane draws it. Three facts, and the phone half is the one that has to
   * survive — below `sm` this address really is the section list.
   */
  check("the neutral pane is gone", /Pick a setting from the list/.test(settingsTsxSrc), false);
  check(
    "the desktop draws the default instead",
    /hidden sm:block/.test(settingsTsxSrc) && /DEFAULT_SECTION/.test(settingsTsxSrc),
    true,
  );
  check("and the phone still gets the list", /sm:hidden[\s\S]{0,200}variant="page"/.test(settingsTsxSrc), true);
  /*
   * ⚠ **The default feeds the pane and never the chrome.** Handed to `settingsUp`
   * it answers `{path: "/settings", withinNav: true}` — a chevron, `sm:hidden`, on
   * a phone, pointing at the screen it is already on. Pinned as the literal,
   * because "it still reads `active`" is a property no pure assertion can see.
   */
  check(
    "the way up is still computed from the section the URL names",
    /const here = \{ \.\.\.route, section: active \};/.test(settingsTsxSrc),
    true,
  );
  /*
   * One table from a section id to a screen, because there are two call sites for
   * it now — the URL's section, and the default. Four `&&`s would let a fifth
   * section render at one and not the other, with nothing to catch it.
   */
  check("one section renders through one table", /function SectionBody\(/.test(settingsTsxSrc), true);
  /*
   * And one call site per section, which is the half `SectionBody`'s existence does
   * not guarantee on its own: a screen left behind in the pane as well would render
   * twice at one depth and once at the other, with `typecheck` seeing nothing.
   * `active === "machines" &&` legitimately survives in `drilled`, so the property
   * is counted on the components rather than matched on the guard.
   */
  check(
    "and each section is drawn from exactly one place",
    ["<MachinesSection", "<AccountSection", "<KeysSection", "<ServerSection", "<EmailSection", "<UsersSection"].map(
      (tag) => (settingsTsxSrc.match(new RegExp(tag, "g")) ?? []).length,
    ),
    [1, 1, 1, 1, 1, 1],
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
  /*
   * ⚠ **And settings gets no chevron in the head**, which is the half of Q3.432
   * that survives Q3.473. Its head spans a 224px section rail above `sm`, so a ◀
   * there points at something the rail is already listing; the pane draws its own.
   * `sheetUpLabel` is what decides, so this is asserted over every pop-up rather
   * than by grepping the one screen that must not ask.
   */
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
  /*
   * ⚠ **And the caller, because a chevron is a property of the *composition*
   * rather than of either function.** `App.tsx` draws one line —
   * `const up = upLabel === null ? null : upFrom(route, under)` — and neither half
   * pins it alone: `sheetUpLabel` answers `null` for every pop-up but the builder,
   * while `upFrom` answers a **real destination** for all of them, so on its own
   * `upFrom` says a chevron is drawn everywhere. Only the pair says whether one is.
   *
   * This used to be greppable and is not any more. When settings rendered its own
   * `Sheet`, "settings passes no `up=`" was a text search over one file; the
   * property now lives entirely in that ternary, and a text match over `App.tsx`
   * would keep agreeing with it after somebody turned it round. So the two are
   * driven as the pair the caller composes, with `upFrom`'s own answer beside it
   * to show what is being suppressed — the whole point of Q3.446's argument, which
   * was about *width* rather than about there being nowhere to go.
   */
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
  /*
   * ⚠ **`preset: null` on those two literals is a behavioural fix, not a type
   * nit.** `as never` lets a hand-built route omit a field the union now requires,
   * and `undefined === null` is `false` — so the second literal answered "Edit
   * agent" the moment editing became an address. Which is the shape of the whole
   * hazard: this driver builds routes by hand precisely where the compiler is
   * being told not to look, so a field added to the union is invisible here until
   * it changes an answer. The four-way sweep of this pair lives with the rest of
   * the builder's addresses, further down.
   */
  check("nor reserves room for one", /inline-flex w-3 shrink-0/.test(sheetSrc), false);
  /*
   * The head's own chevron is conditional and never a reserved slot: a screen with
   * nowhere to go must not draw a control that goes nowhere, and this pop-up's head
   * changes its title between screens anyway, so a left edge moving with it costs
   * nothing that was being held still.
   */
  check("the head draws one only when a caller hands it somewhere to go", /\{up !== undefined && \(/.test(sheetSrc), true);

  /* ---------------------------------------------------------------- *
   * One panel, many screens
   *
   * ⚠ **The bill for `OverlaySheet`, and the reason nothing typed can catch it.**
   * One `<Sheet>` element now serves `/new`, `/agent` and `/agent/:step`, so the
   * mount-time focus effect ran once for the whole flow: tapping the Model row
   * unmounted the button holding focus, the browser dropped it to `<body>`, and a
   * keyboard user re-Tabbed from the top of the document on every screen and on
   * every ◀ back out of one. The element never unmounts, so every type in this
   * file agrees with itself either way.
   * ---------------------------------------------------------------- */
  check("the panel is re-focused per screen, not per sheet", /useEffect\(\(\) => \{\s*panelRef\.current\?\.focus\(\);\s*\}, \[screen\]\);/.test(sheetSrc), true);
  /*
   * ⚠ **And its pair, which is the same defect wearing the other hat.** The
   * capture/restore effect must stay at `[]`: run per screen, its *cleanup* fires
   * on every screen change and restores focus to a control the outgoing screen has
   * just unmounted — which lands on `<body>`, which is exactly what was being
   * fixed. Declaration order matters with it, since React runs a component's
   * effects in the order they are written and the capture has to record what held
   * focus before the panel takes it.
   */
  check("and exactly one thing in the panel remembers where focus came from", (sheetSrc.match(/document\.activeElement/g) ?? []).length, 1);
  check(
    "and it is declared first, and keyed on nothing",
    /const previous = document\.activeElement;[\s\S]*?\}, \[\]\);[\s\S]*?\}, \[screen\]\);/.test(sheetSrc),
    true,
  );
  /*
   * ⚠ **The head changing is the only thing that says the screen changed**, so it
   * is spoken. Exactly one region, and it renders `title` **live** rather than a
   * string captured in the focus effect: `sheetTitle` answers `null` for a
   * plugin's own screen and `OverlaySheet` draws an empty placeholder until the
   * plugin reports a name a round-trip later, so a region fed from the effect
   * would speak `""` once and never correct itself. Rendered live it is silent
   * while empty — an empty region announces nothing — and speaks the name when it
   * arrives. Nothing typed can tell those two apart.
   */
  check("the panel says what screen it is on", (sheetSrc.match(/role="status"/g) ?? []).length, 1);
  check("and says it by rendering the head rather than a copy of it", /<p role="status" aria-live="polite" className="sr-only">\s*\{title\}/.test(sheetSrc), true);
  /*
   * ⚠ **Inside the `aria-modal` dialog**, which is not a placement preference:
   * `aria-modal="true"` lets a screen reader hide everything outside the dialog
   * element, so a region beside it — or left in `#root`, which `syncInert` marks
   * `inert` — never fires at all. Same finding `Toast` records about why it
   * portals. Asserted by source order against both the dialog above it and the
   * portal target below it, since a driver with no DOM has nothing else to read.
   */
  /*
   * Each operand is checked against `>= 0` first, the sweep the `picksRef`
   * ordering pin one section over is the reason for: `aria-modal` was the left
   * side of the first comparison and nothing else in this file asserts it exists,
   * so deleting the attribute made `indexOf` answer -1 — less than every real
   * position — and the assertion passed while the property it names, the one thing
   * that decides whether the region is announced at all, was gone.
   */
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
  /*
   * ⚠ **A `ReactNode` title cannot be spoken**, and widening it back typechecks
   * clean at both call sites while silently muting the region. The `<h1>`'s own
   * docblock already asked for one unconditional text node so `aria-labelledby`
   * resolves at both widths; the type now enforces what that comment asked for.
   */
  check("and the head is a string, because a node has no words", [/title: string;/.test(sheetSrc), /title: ReactNode/.test(sheetSrc)], [true, false]);
  /*
   * ⚠ **`screen` is optional, so a caller that stops passing it typechecks clean
   * and reverts to the defect.** Same shape as the `upFrom(route, under, origin)`
   * call-site pin: the property is about the caller, so it is asserted on the
   * caller. `ImportCode` passes nothing on purpose — one screen, focused once on
   * the way in — which is why the prop cannot simply be made required.
   */
  const appSrc = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  check("the sheet that has many screens actually hands one over", /screen=\{screenOf\(route\)\}/.test(appSrc), true);
  /*
   * The one line the pair above is a fact about. Text, because a composition
   * inside a component body is not reachable from a driver with no DOM — and
   * narrow, because it is the *gate* that is the property: `upFrom` alone answers
   * a destination for every pop-up, so a `Sheet` handed `upFrom(route, under)`
   * unconditionally would grow a chevron on all five of them with the behavioural
   * assertions above still green.
   */
  check("and the head's chevron is gated on the label rather than on the destination", /upLabel === null \? null : upFrom\(route, under, origin\)/.test(appSrc), true);
  /*
   * ⚠ **And both halves are handed the same origin, which is a property of this
   * one line and of nothing typed.** The label names the destination — that is
   * `sheetUpLabel`'s stated rule — so a label computed without the origin over a
   * destination computed with it is the chevron naming somewhere you are not
   * going, and it is one omitted argument away at all times. Both defaulted to
   * `null`, so the compiler has nothing to say about either.
   */
  check(
    "and both halves of it read the same origin",
    /sheetUpLabel\(route, origin\)/.test(appSrc),
    true,
  );
  /*
   * ⚠ **And `screenOf` folds in what a screen *is* and leaves out what a screen's
   * own state happens to ride the URL as** — the post-condition on a function
   * whose whole output is a key, and the half that cannot be inferred from its
   * type. Both mistakes are silent: keyed on the whole route, `NewSession`'s
   * documented "the address follows the folder" rewrite fires on every step into
   * a directory and the panel steals focus mid-interaction; keyed on the title, it
   * never fires inside settings or plugins at all, because `sheetTitle` answers
   * one constant for every screen under each.
   */
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
  /*
   * ⚠ **The seed is part of what an agent screen *is*, beside the preset**, and it
   * arrived after this pin was written — which is exactly the shape this block
   * exists to catch, since a field left out of the key is silent in both
   * directions. The builder holds the seed in `useState` at mount, so two addresses
   * differing only in which harness they start from are two screens: left out, the
   * panel would keep the first one's focus and mount the second with the first's
   * state on screen for a frame.
   */
  check(
    "and a harness seed is part of that screen rather than its state",
    /route\.harness \?\? ""/.test(appSrc),
    true,
  );
  /*
   * The other half of the same post-condition, and the one a text pin cannot fake:
   * `screenOf` has no `default`, so every arm of the route union is named and a
   * seventh route shape fails to build rather than silently sharing a key with
   * whatever `default` returned.
   */
  check("and every route shape is named rather than defaulted", /function screenOf[\s\S]*?\n\}/.exec(appSrc)?.[0].includes("default:") ?? true, false);
  /*
   * ⚠ **Which of the three, and why — the *choice*, where the sweeps in the
   * tap-minimum section assert the *floor*.**
   *
   * This used to read as a guard against a default: `md` was `h-9 w-9` and was
   * what `size` fell back to, so a chevron added without the prop was a 36px
   * target on the control a phone uses to leave every screen of this pop-up. There
   * is no default now — `md` is deleted and `size` is required — so omitting it
   * does not compile and naming a size that misses 44px is not expressible. What
   * is left to protect is which one was picked: `sm` is 24px of ink reaching 44
   * through a transparent `after:-inset-2.5`, which is what keeps this chevron
   * flush in a head row that a 44px box would have made taller than the title
   * beside it. `Header`'s pair went the other way on the same question and its
   * docblock argues why; the two must not be quietly converged.
   */
  check("at the settings pane's own size, which reaches 44px", /icon=\{ChevronLeft\}[\s\S]{0,400}size="sm"/.test(sheetSrc), true);
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
      settingsUpLabel(parseSettingsRoute(["machines", "m_1", "systems", "anthropic"])),
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

  /* ---------------------------------------------------------------- *
   * What the rail says out loud, which is the third member of that pair
   *
   * ⚠ **The heading and the way up were pinned together above and the
   * *announcement* was pinned by nothing** — not the prop, not the live region,
   * not what feeds it. So `SettingsNav` derived the sentence itself, from the
   * `active` it highlights, and `active` cannot see the branch below it: `drilled`
   * is tested **before** `SectionBody`, so at `/settings/machines/:id`, `…/systems`
   * and `…/agents` the pane drew a machine's own screen while the region said
   * "Machines" — and on a desktop it said it two boxes from an `<h2>` reading
   * "Machine settings", one chrome contradicting itself in a single paint.
   *
   * The remedy is that both come from one function over one route, so the pure
   * half is an *identity* rather than a table: the announcement is
   * `settingsPaneTitle` over the route the **body** reads, which is `here` with the
   * index default substituted. Where the URL names a section that is `here` itself
   * and the two strings are literally the same one.
   * ---------------------------------------------------------------- */
  const announced = (segments: readonly (string | undefined)[]): string | null => {
    const route = parseSettingsRoute(segments);
    return settingsPaneTitle({ ...route, section: route.section ?? DEFAULT_SECTION });
  };
  check(
    "the rail announces the pane's own name at every depth",
    reachable.filter((segments) => announced(segments) !== pane(segments)),
    [],
  );
  /*
   * ⚠ **And at the index, where the two deliberately differ and the prop's `null`
   * arm would otherwise be reachable.** `/settings` parses to `section: null` — below
   * `sm` it *is* the list — so the heading is correctly absent while the pane at
   * `sm`+ draws `DEFAULT_SECTION`. A region mounted with nothing to say is a failure
   * with no symptom, which is why the prop is required rather than optional.
   */
  check("and names the default where the URL names none", [pane([]), announced([])], [null, "Account"]);
  check(
    "so every section a rail can highlight has a sentence to announce",
    SECTION_SPECS.filter((spec) => settingsPaneTitle(parseSettingsRoute([spec.id])) === null).map((spec) => spec.id),
    [],
  );
  /*
   * The wiring, which no pure assertion can reach: the caller computes it over
   * `shown` and hands it to **both** mounts, and the nav derives nothing of its own.
   * `rows.find` is the shape the defect took — the highlighted row's label read back
   * out of the list — so its absence is asserted rather than the presence of the
   * prop alone.
   */
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
    /*
     * Required rather than optional, and that is the whole of what keeps the check
     * above meaning anything: an omitted optional leaves the region mounted with
     * nothing in it, which is silent in every direction a person could notice.
     */
    check("and it cannot be left out", [/^\s*paneName: string \| null;$/m.test(nav), /paneName\?:/.test(nav)], [true, false]);
  }
}
