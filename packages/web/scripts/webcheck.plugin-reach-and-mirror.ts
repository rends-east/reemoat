import { readFileSync } from "node:fs";
import { check, report, skip } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhich machines an act reaches, and what it says about the rest\n");
{
  const {
    failureSummary,
    installedSummary,
    outcomeText,
    planTargets,
    settingsBlockFor,
    settingsBlockText,
    settingsNotice,
    skipReasonFor,
    skipText,
  } = await import("../src/install.js");

  const machine = (id: string, patch: Record<string, unknown> = {}): never =>
    ({
      id,
      name: id,
      relayUrl: "https://relay.example",
      relayOnline: true,
      enrolled: true,
      lastSeenAt: null,
      owned: true,
      overLimit: false,
      ownerDisabled: false,
      scopes: ["session:read", "session:write", "machine:admin"],
      route: null,
      reach: "online",
      offlineReason: null,
      tokenDegraded: false,
      tokenExpiresAt: null,
      health: null,
      lastError: null,
      ...patch,
    }) as never;

  const fleet = [
    machine("ok"),
    machine("probing", { reach: "probing" }),
    machine("asleep", { reach: "offline", offlineReason: "no_route" }),
    // The cold-load reach: without this row, folding unknown into unreachable passes every check below.
    machine("cold", { reach: "unknown" }),
    machine("banned", { ownerDisabled: true }),
    machine("over", { overLimit: true }),
    machine("shared", { scopes: ["session:read", "session:write"], owned: false }),
    machine("unchosen"),
  ];
  const chosen = new Set(["ok", "probing", "asleep", "cold", "banned", "over", "shared"] as never[]);
  const plan = planTargets(fleet, chosen as never);

  check(
    "every chosen machine is either attempted or accounted for, and never both",
    [...chosen]
      .map((id) => (plan.eligible.includes(id) ? 1 : 0) + (plan.skipped.some((one) => one.id === id) ? 1 : 0))
      .filter((count) => count !== 1),
    [],
  );
  check("and a machine nobody chose is in neither", [
    plan.eligible.includes("unchosen" as never),
    plan.skipped.some((one) => one.id === ("unchosen" as never)),
  ], [false, false]);

  check("a machine mid-probe is attempted", plan.eligible.includes("probing" as never), true);
  check(
    "a sleeping one is accounted for rather than attempted",
    plan.skipped.find((one) => one.id === ("asleep" as never))?.reason,
    "unreachable",
  );
  check(
    "and one nobody has asked yet is a wait, not an outage",
    [
      plan.eligible.includes("cold" as never),
      plan.skipped.find((one) => one.id === ("cold" as never))?.reason,
    ],
    [false, "asking"],
  );
  check(
    "which is a different sentence from the one that did not answer",
    skipText("asking") === skipText("unreachable"),
    false,
  );
  check(
    "and says what is unknown rather than what failed",
    skipText("asking"),
    "not checked yet, so what is installed there is not known",
  );

  // Unions are read off install.ts rather than listed here, so a new member cannot go unswept.
  const installSrc = stripComments(readFileSync(new URL("../src/install.ts", import.meta.url), "utf8"));
  const unionOf = (name: string): readonly string[] => {
    const at = installSrc.indexOf(`export type ${name} =`);
    return at < 0 ? [] : [...installSrc.slice(at, installSrc.indexOf(";", at)).matchAll(/"([a-z_]+)"/g)].map((one) => one[1] ?? "");
  };
  const reasons = unionOf("SkipReason");
  // A read that came back empty passes every sweep below while asserting nothing,
  // which is this driver's one failure mode.
  check("the skip union was found, and the two falses are two members of it", [reasons.length >= 5, reasons.includes("asking"), reasons.includes("unreachable")], [true, true, true]);
  check("every skip reason has a sentence", reasons.filter((one) => skipText(one as never).length === 0), []);
  check("and no two of them read the same", new Set(reasons.map((one) => skipText(one as never))).size, reasons.length);
  check(
    "and only the one that did not answer says so",
    reasons.filter((one) => /not reachable/.test(skipText(one as never))),
    ["unreachable"],
  );

  check(
    "a machine in two bad states names the remedy that comes first",
    skipReasonFor(machine("both", { ownerDisabled: true, overLimit: true })),
    "owner_disabled",
  );
  check(
    "a grant that drives sessions cannot install",
    plan.skipped.find((one) => one.id === ("shared" as never))?.reason,
    "not_admin",
  );

  check(
    "an update to a plugin somebody switched off says it is still off",
    outcomeText({ kind: "updated", from: "0.2.0", to: "0.2.1", enabled: false }),
    "updated 0.2.0 → 0.2.1, still switched off",
  );
  check(
    "and one that is on just says what changed",
    outcomeText({ kind: "updated", from: "0.2.0", to: "0.2.1", enabled: true }),
    "updated 0.2.0 → 0.2.1",
  );
  check(
    "a skipped machine says the remedy rather than the state",
    outcomeText({ kind: "skipped", reason: "over_limit" }),
    skipText("over_limit"),
  );

  check("nowhere", installedSummary(3, []), "not installed anywhere");
  check("one of three, named", installedSummary(3, ["laptop"]), "on laptop");
  check("three of four, still named", installedSummary(4, ["a", "b", "c"]), "on a, b, c");
  check("four of six becomes a count", installedSummary(6, ["a", "b", "c", "d"]), "on 4 of 6 machines");
  check("everywhere", installedSummary(3, ["a", "b", "c"]), "on all 3 machines");
  check("a fleet of one", installedSummary(1, ["only"]), "installed");
  check("nothing failed, so there is nothing to say", failureSummary([]), "");
  check("one machine is named", failureSummary(["laptop"]), "Failed on laptop — the row says why.");
  check("two are still named", failureSummary(["laptop", "mini"]), "Failed on laptop, mini — each row says why.");
  check(
    "and past three they are counted",
    failureSummary(["a", "b", "c", "d"]),
    "Failed on 4 machines — each row says why.",
  );
  check(
    "and it claims nothing about what the daemon did",
    /installed|removed|updated|nothing happened/.test(failureSummary(["laptop"])),
    false,
  );
  check("and no fleet at all", installedSummary(0, []), "no machines");
  {
    const pane = { version: "1.0.0", contributes: { settings: true } };
    const noPane = { version: "0.2.1", contributes: { settings: false } };
    const named = (id: string): never => (fleet.find((one) => (one as { id: string }).id === id) ?? fleet[0]) as never;

    check("a reachable machine with a pane is configurable", settingsBlockFor(named("ok"), pane), null);
    check("and one nobody has asked yet is waited for rather than written off", settingsBlockFor(named("cold"), pane), "asking");
    check(
      "a session grant may configure what it may not install",
      [skipReasonFor(named("shared")), settingsBlockFor(named("shared"), pane)],
      ["not_admin", null],
    );
    check(
      "a machine nobody can read is not reported as not having it",
      settingsBlockFor(named("asleep"), null),
      "unreachable",
    );
    check(
      "and neither is one whose sessions are not yours to read",
      settingsBlockFor(machine("blind", { scopes: [] }), null),
      "no_scope",
    );
    check(
      "a banned owner outranks the limit, and both outrank everything else",
      [
        settingsBlockFor(machine("both", { ownerDisabled: true, overLimit: true }), pane),
        settingsBlockFor(named("over"), pane),
      ],
      ["owner_disabled", "over_limit"],
    );
    check("a machine that really does not have it says so", settingsBlockFor(named("ok"), null), "not_installed");
    check("and one on a version with no pane says which version", settingsBlockFor(named("ok"), noPane), "no_pane");
    check(
      "and a switched-off plugin is still configurable",
      settingsBlockFor(named("ok"), { ...pane, contributes: { settings: true } }),
      null,
    );

    const blocks = unionOf("SettingsBlock");
    const blockSays = (block: string): string => settingsBlockText(block as never, "server", "0.2.1");
    check("the block union was found, and holds the two falses separately", [blocks.length >= 7, blocks.includes("asking"), blocks.includes("unreachable")], [true, true, true]);
    check(
      "every reason has a sentence, and each names the machine",
      blocks.filter((one) => {
        const said = blockSays(one);
        return said.length === 0 || !said.includes("server");
      }),
      [],
    );
    check("and no two of them read the same", new Set(blocks.map(blockSays)).size, blocks.length);
    check("a machine nobody has asked about yet says so, and says it as a wait", blockSays("asking"), "server has not been checked yet, so its settings have not been read");
    check(
      "and only the one that did not answer claims an outage",
      blocks.filter((one) => /is not reachable/.test(blockSays(one))),
      ["unreachable"],
    );
    check("the version is named where there is one", settingsBlockText("no_pane", "server", "0.2.1"), "server has no settings pane for 0.2.1");
    check("and left out where there is not", settingsBlockText("no_pane", "server", null), "server has no settings pane");

    check("nothing blocking is nothing said", settingsNotice([]), "");
    check(
      "one blocker is said in full",
      settingsNotice([{ name: "server", block: "no_pane", version: "0.2.1" }]),
      "server has no settings pane for 0.2.1.",
    );
    check(
      "and several name the first and count the rest",
      settingsNotice([
        { name: "server", block: "no_pane", version: "0.2.1" },
        { name: "nuc", block: "unreachable", version: null },
        { name: "mini", block: "not_installed", version: null },
      ]),
      "server has no settings pane for 0.2.1, and 2 more.",
    );
  }

}

process.stdout.write("\nwhat the machine table's controls can do\n");
{
  const {
    bulkEnabled,
    drawnActs,
    installedSubline,
    isBehind,
    noRowsText,
    removalQuestion,
    rowActLabel,
    rowActs,
    rowShown,
    selectionLine,
    shownRows,
  } = await import("../src/install.js");

  const rowCells: { row: { installed: boolean; behind: boolean; blocked: boolean; busy: boolean }; canInstall: boolean }[] = [];
  for (const installed of [false, true]) {
    for (const behind of [false, true]) {
      for (const blocked of [false, true]) {
        for (const busy of [false, true]) {
          for (const canInstall of [false, true]) rowCells.push({ row: { installed, behind, blocked, busy }, canInstall });
        }
      }
    }
  }
  const answers = rowCells.map((cell) => ({ ...cell, acts: rowActs(cell.row, cell.canInstall) }));
  check("all three acts are reachable", [...new Set(answers.flatMap((one) => one.acts))].sort(), ["install", "remove", "update"]);
  check(
    "a row never offers to install and to remove at once",
    answers.filter((one) => one.acts.includes("install") && one.acts.includes("remove")),
    [],
  );
  check(
    "and never offers an update it has nothing to update",
    answers.filter((one) => one.acts.includes("update") && !one.acts.includes("remove")),
    [],
  );
  check(
    "and remove is always the last of them",
    answers.filter((one) => one.acts.includes("remove") && one.acts[one.acts.length - 1] !== "remove"),
    [],
  );
  check("a blocked row offers nothing", answers.filter((one) => one.row.blocked && one.acts.length > 0), []);
  check("nor does one with a request out", answers.filter((one) => one.row.busy && one.acts.length > 0), []);
  check(
    "and a screen holding no archive offers neither install nor update",
    answers.filter((one) => !one.canInstall && (one.acts.includes("install") || one.acts.includes("update"))),
    [],
  );
  check(
    "a row draws nothing that cannot be undone from the row",
    answers.filter((one) => drawnActs(one.acts).includes("remove")),
    [],
  );
  check(
    "and it draws everything else it can do",
    answers.filter((one) => drawnActs(one.acts).length !== one.acts.filter((act) => act !== "remove").length),
    [],
  );
  check(
    "so an installed, current machine offers the row nothing at all",
    drawnActs(rowActs({ installed: true, behind: false, blocked: false, busy: false }, true)),
    [],
  );
  check(
    "each act names the machine it is about",
    (["install", "update", "remove"] as const).map((act) => rowActLabel(act, "laptop")),
    ["Install on laptop", "Update on laptop", "Remove from laptop"],
  );

  const sizes = [0, 1, 2, 3];
  const bulkCells: { counts: Parameters<typeof bulkEnabled>[0]; answer: ReturnType<typeof bulkEnabled> }[] = [];
  for (const selected of sizes) {
    for (const installable of sizes) {
      for (const updatable of sizes) {
        for (const removable of sizes) {
          for (const configurable of sizes) {
            for (const canInstall of [false, true]) {
              const counts = { selected, installable, updatable, removable, configurable, canInstall };
              bulkCells.push({ counts, answer: bulkEnabled(counts) });
            }
          }
        }
      }
    }
  }
  check("the sweep is the whole space", bulkCells.length, 4 * 4 * 4 * 4 * 4 * 2);
  check(
    "all four controls are reachable in both directions",
    (["install", "update", "remove", "settings"] as const).flatMap((act) => [
      bulkCells.some((one) => one.answer[act]),
      bulkCells.some((one) => !one.answer[act]),
    ]),
    [true, true, true, true, true, true, true, true],
  );
  check(
    "nothing is offered over an empty selection",
    bulkCells.filter((one) => one.counts.selected === 0 && Object.values(one.answer).some(Boolean)),
    [],
  );
  check(
    "a screen holding no archive never offers install or update",
    bulkCells.filter((one) => !one.counts.canInstall && (one.answer.install || one.answer.update)),
    [],
  );
  check(
    "settings moves only where every selected machine can take it",
    bulkCells.filter(
      (one) => one.answer.settings !== (one.counts.selected > 0 && Math.min(one.counts.configurable, one.counts.selected) === one.counts.selected),
    ),
    [],
  );
  check(
    "while remove moves where any of them can",
    bulkCells.filter((one) => one.answer.remove !== Math.min(one.counts.removable, one.counts.selected) > 0),
    [],
  );
  {
    const leaked: string[] = [];
    for (const one of bulkCells) {
      for (const [field, act] of [
        ["installable", "install"],
        ["updatable", "update"],
        ["removable", "remove"],
        ["configurable", "settings"],
      ] as const) {
        for (const value of sizes) {
          const moved = bulkEnabled({ ...one.counts, [field]: value });
          for (const other of ["install", "update", "remove", "settings"] as const) {
            if (other !== act && moved[other] !== one.answer[other]) leaked.push(`${field}->${other}`);
          }
        }
      }
    }
    check("no count moves a control it is not about", [...new Set(leaked)], []);
  }
  check(
    "a configurable count larger than the selection is not believed",
    bulkEnabled({ selected: 2, installable: 0, updatable: 0, removable: 0, configurable: 9, canInstall: true }).settings,
    true,
  );
  check(
    "and one smaller than it refuses",
    bulkEnabled({ selected: 2, installable: 0, updatable: 0, removable: 0, configurable: 1, canInstall: true }).settings,
    false,
  );
  check(
    "settings works on a screen that cannot install",
    bulkEnabled({ selected: 2, installable: 0, updatable: 0, removable: 2, configurable: 2, canInstall: false }).settings,
    true,
  );

  const fleet = [
    { id: "m_1", name: "laptop", installed: true },
    { id: "m_2", name: "mini", installed: false },
    { id: "m_3", name: "server", installed: true },
  ];
  const needles = ["", "  ", "LAP", "lap", "m_2", "zzz"];
  const filters = ["all", "installed", "absent"] as const;
  check(
    "what is shown is always a subsequence of the fleet",
    needles.flatMap((needle) =>
      filters.filter((filter) => {
        const shown = shownRows(fleet, needle, filter);
        const indexes = shown.map((one) => fleet.indexOf(one));
        return (
          new Set(shown).size !== shown.length ||
          indexes.some((at, i) => at < 0 || (i > 0 && at <= (indexes[i - 1] ?? -1)))
        );
      }),
    ),
    [],
  );
  check("no search and no filter is the whole fleet", shownRows(fleet, "", "all"), fleet);
  check("and a blank needle is no search", shownRows(fleet, "   ", "all"), fleet);
  check("the needle is case-folded", shownRows(fleet, "LAP", "all").map((one) => one.name), ["laptop"]);
  check("and the id is searchable too", shownRows(fleet, "m_2", "all").map((one) => one.name), ["mini"]);
  check(
    "installed and not-installed partition what the needle left",
    needles.filter((needle) => {
      const all = shownRows(fleet, needle, "all");
      const on = shownRows(fleet, needle, "installed");
      const off = shownRows(fleet, needle, "absent");
      return on.length + off.length !== all.length || [...on, ...off].some((one) => !all.includes(one));
    }),
    [],
  );
  check("and one row agrees with the list it is in", rowShown(fleet[0] as never, "lap", "installed"), true);

  check("nothing selected says so", selectionLine(0, 0), "nothing selected");
  check("one is singular", selectionLine(1, 0), "1 machine selected");
  check("several are counted", selectionLine(3, 0), "3 machines selected");
  check("and what the filter is hiding is named", selectionLine(4, 2), "4 selected, 2 of them not shown");
  check(
    "the hidden clause appears exactly when something is hidden",
    [0, 1, 2, 3].flatMap((selected) =>
      [0, 1, 2, 3].filter((hidden) => selectionLine(selected, hidden).includes("not shown") !== (selected > 0 && hidden > 0)),
    ),
    [],
  );

  check(
    "there is always a sentence where the list is empty",
    [0, 3].flatMap((total) => needles.flatMap((needle) => filters.filter((f) => noRowsText(total, needle, f).length === 0))),
    [],
  );
  check("a needle that matched nothing is quoted back", noRowsText(3, "zzz", "all"), "No machine here is called “zzz”.");
  check("with real quotation marks rather than a serialiser", noRowsText(3, 'a"b', "all").includes('\\"'), false);
  check("an empty Installed filter says where it is not", noRowsText(3, "", "installed"), "It is not on any of your machines.");
  check("and an empty Not-installed filter says it is everywhere", noRowsText(3, "", "absent"), "It is on every machine you have.");
  check("no machines at all is its own sentence", noRowsText(0, "", "all"), "You have no machines yet, so there is nowhere to put a plugin.");

  check("a switched-off machine says so", installedSubline("0.4.0", "0.4.0", false), "0.4.0 · switched off");
  check("even with nothing on offer", installedSubline("0.4.0", null, false), "0.4.0 · switched off");
  check("and being off outranks being behind", installedSubline("0.3.3", "0.4.0", false), "0.3.3 · switched off");
  check("and outranks being ahead", installedSubline("0.4.0", "0.3.3", false), "0.4.0 · switched off");
  check("a machine behind the offer says what is available", installedSubline("0.3.3", "0.4.0", true), "0.3.3 · 0.4.0 available");
  check(
    "a machine ahead of it says so rather than falling through",
    installedSubline("0.4.0", "0.3.3", true),
    "0.4.0 · newer than the 0.3.3 offered here",
  );
  check("an equal one is just the version", installedSubline("0.4.0", "0.4.0", true), "0.4.0");
  check("with nothing on offer it is the bare version", installedSubline("0.4.0", null, true), "0.4.0");
  check(
    "the comparison is numeric in both directions",
    [installedSubline("0.10.0", "0.9.0", true), installedSubline("0.9.0", "0.10.0", true)],
    ["0.10.0 · newer than the 0.9.0 offered here", "0.9.0 · 0.10.0 available"],
  );
  check("behind is numeric and null is never behind", [isBehind("0.9.0", "0.10.0"), isBehind("0.10.0", "0.9.0"), isBehind("1.0.0", null)], [true, false, false]);

  check("one machine is named", removalQuestion(["laptop"]), "Remove it from laptop and everything it kept there?");
  check("several are counted", removalQuestion(["a", "b", "c"]), "Remove it from 3 machines and everything it kept on them?");
  check("and none is still a sentence", removalQuestion([]), "Remove it from 0 machines and everything it kept on them?");
  check("the row and the bar ask the same thing about one machine", removalQuestion(["laptop"]), removalQuestion(["laptop"]));
}

process.stdout.write("\nthe one mirror whose other half is in a different repository\n");
{
  // The original is services/plugins/src/catalogue.ts in another repository, so this compares only where both are on disk and skips loudly elsewhere.
  const ORIGINAL = new URL("../../../../services/plugins/src/catalogue.ts", import.meta.url);
  let service: string | null = null;
  try {
    service = readFileSync(ORIGINAL, "utf8");
  } catch {
    // Absent is the ordinary state in CI; the skip below says so.
    service = null;
  }

  if (service === null) {
    skip(
      "the catalogue service is not on this disk, so its mirror is unchecked",
      "services/plugins/src/catalogue.ts — expected in CI, a problem on the box",
    );
  } else {
    const clientSrc = readFileSync(new URL("../src/catalogue.ts", import.meta.url), "utf8");
    const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const membersAt = (clean: string, from: number): string[] => {
      let depth = 0;
      let token = "";
      const out: string[] = [];
      for (let i = clean.indexOf("{", from); i < clean.length; i += 1) {
        const c = clean[i] ?? "";
        if (c === "{") {
          depth += 1;
          token = "";
          continue;
        }
        if (c === "}") {
          depth -= 1;
          token = "";
          if (depth === 0) break;
          continue;
        }
        if (depth !== 1) continue;
        if (c === ":") {
          const field = token.trim().replace(/\?$/, "");
          if (/^[A-Za-z_]\w*$/.test(field)) out.push(field);
          token = "";
        } else if (c === ";" || c === "\n" || c === ",") token = "";
        else token += c;
      }
      return [...new Set(out)].sort();
    };
    const declOf = (src: string, name: string): string[] | null => {
      const clean = strip(src);
      const head = new RegExp(`(?:export )?interface ${name}\\s*\\{`).exec(clean);
      return head === null ? null : membersAt(clean, head.index);
    };
    const nestedOf = (src: string, iface: string, field: string): string[] | null => {
      const clean = strip(src);
      const head = new RegExp(`(?:export )?interface ${iface}\\s*\\{`).exec(clean);
      if (head === null) return null;
      const at = clean.indexOf(`${field}: {`, head.index);
      return at < 0 ? null : membersAt(clean, at);
    };

    // Asserted as client within service: readOne fails closed on a required field, so a field the service does not send takes the whole market dark.
    const halves: [string, string[] | null, string[] | null][] = [
      ["the entry", declOf(service, "CatalogueEntry"), declOf(clientSrc, "CatalogueEntry")],
      [
        "its source",
        nestedOf(service, "CatalogueEntry", "source"),
        declOf(clientSrc, "CatalogueSource") ?? nestedOf(clientSrc, "CatalogueEntry", "source"),
      ],
    ];
    const invented: string[] = [];
    let read = 0;
    for (const [name, theirs, ours] of halves) {
      // A failure rather than a skip: the file is on disk, so the declaration pattern no longer matches.
      check(`${name} is readable on both sides`, theirs !== null && ours !== null, true);
      if (theirs === null || ours === null) continue;
      read += theirs.length;
      for (const field of ours) if (!theirs.includes(field)) invented.push(`${name}: ${field}`);
    }
    // A floor, because "found no fields" and "found no drift" print the same.
    report("there are fields to compare at all", read >= 20, `${read} fields across both halves`);
    check("this client declares no catalogue field the service does not send", invented, []);
  }
}

{
  const { offersSettings } = await import("../src/plugins.js");
  // Superseded gate kept because offersSettings is still exported; its "anywhere" rule is the inverse of install.ts's "every" (Q3.468, Q7.108).
  const row = (id: string, settings: boolean, enabled = true): never =>
    ({ id, enabled, contributes: { screen: null, settings, actions: [], hooks: [] } }) as never;
  check("no rows, no pane", offersSettings([], "autotitle"), false);
  check("a plugin that declares none", offersSettings([row("autotitle", false)], "autotitle"), false);
  check("one that does", offersSettings([row("autotitle", true)], "autotitle"), true);
  check("another plugin's pane is not this one's", offersSettings([row("board", true)], "autotitle"), false);
  check(
    "one machine out of two is enough",
    offersSettings([row("autotitle", false), row("autotitle", true)], "autotitle"),
    true,
  );
  check("and being switched off changes nothing", offersSettings([row("autotitle", true, false)], "autotitle"), true);
}

process.stdout.write("\nfinding a plugin in the market, and what the headings are for\n");
{
  const { UNGROUPED, groupCatalogue, matchesQuery } = await import("../src/market.js");
  {
    const { PLUGIN_SCOPE_TEXT, PLUGIN_SCOPE_TEXT_MAX } = await import("../src/wire.js");
    // Pinned to the daemon's list rather than this package's mirror of it.
    const { PLUGIN_SCOPES } = await import("../../../src/plugins/protocol.js");
    check("every scope has a line", Object.keys(PLUGIN_SCOPE_TEXT).sort(), [...PLUGIN_SCOPES].sort());
    check("and none of them is blank", Object.values(PLUGIN_SCOPE_TEXT).filter((one) => one.trim().length === 0), []);
    check(
      "a permission is a line, not a paragraph",
      Object.entries(PLUGIN_SCOPE_TEXT)
        .filter(([, line]) => line.length > PLUGIN_SCOPE_TEXT_MAX)
        .map(([scope, line]) => `${scope}: ${line.length}`),
      [],
    );
    check("the one that spends money still says so", /you|your/.test(PLUGIN_SCOPE_TEXT.model), true);
    check(
      "and the one that answers permissions still says that",
      /answer/.test(PLUGIN_SCOPE_TEXT["sessions.write"]),
      true,
    );
  }
  {
    // The subset direction is load-bearing: a settings type that is not a screen type renders as nothing in PluginView.
    const { PLUGIN_SETTINGS_BLOCK_TYPES, PLUGIN_SETTINGS_FIELD_KINDS } = await import("../src/wire.js");
    const { PLUGIN_BLOCK_TYPES, PLUGIN_SETTINGS_BLOCK_TYPES: daemonBlocks, PLUGIN_SETTINGS_FIELD_KINDS: daemonKinds } =
      await import("../../../src/plugins/protocol.js");
    check("a settings pane draws a subset of what a screen draws", PLUGIN_SETTINGS_BLOCK_TYPES.filter((one) => !PLUGIN_BLOCK_TYPES.some((two) => two === one)), []);
    check("the block mirror agrees with the daemon", [...PLUGIN_SETTINGS_BLOCK_TYPES], [...daemonBlocks]);
    check("and so does the field mirror", [...PLUGIN_SETTINGS_FIELD_KINDS], [...daemonKinds]);
    check("and there are three of them", [...PLUGIN_SETTINGS_FIELD_KINDS].sort(), ["select", "text", "toggle"]);
  }
  const of = (id: string, name: string, categories: string[], description = "a plugin about sessions") =>
    ({ id, name, categories, description }) as never;

  const titles = of("autotitle", "Auto title", ["sessions"]);
  const board = of("board", "Board", ["work"]);
  const loose = of("loose", "Loose", []);

  check("an empty needle is not a search", [matchesQuery(titles, ""), matchesQuery(titles, "   ")], [true, true]);
  check("the name matches, whatever the case", matchesQuery(titles, "AUTO TIT"), true);
  check("and so does the id, because that is a name people type", matchesQuery(titles, "autotit"), true);
  check("a needle in the description alone matches nothing", matchesQuery(board, "sessions"), false);
  check("and one that is in neither matches nothing either", matchesQuery(titles, "zzz"), false);

  check("a catalogue that agrees on one category is one group", groupCatalogue([titles, of("x", "X", ["sessions"])], "").length, 1);
  check(
    "and two categories are two, in name order",
    groupCatalogue([board, titles], "").map((group) => group.name),
    ["sessions", "work"],
  );
  check(
    "the plugins that name none come last, never in the middle",
    groupCatalogue([loose, board, titles], "").map((group) => group.name),
    ["sessions", "work", UNGROUPED],
  );
  const many = of("many", "Many", ["work", "sessions"]);
  check(
    "a plugin in several categories is drawn once, under the first",
    groupCatalogue([many], "").map((group) => [group.name, group.entries.length]),
    [["work", 1]],
  );
  check(
    "rows inside a group are in name order rather than the service's",
    groupCatalogue([of("z", "Zebra", ["work"]), of("a", "Apple", ["work"])], "")[0]?.entries.map((one) => one.name),
    ["Apple", "Zebra"],
  );
  check("a group nothing matches is not a heading with nothing under it", groupCatalogue([board, titles], "auto").map((g) => g.name), ["sessions"]);
  check("and a needle matching nothing is no groups at all", groupCatalogue([board, titles], "zzz"), []);
}

process.stdout.write("\nwhich routes are pop-ups, asked from both directions\n");
{
  const { isSheet } = await import("../src/nav.js");
  const { isOverlayPath } = await import("../src/ui/overlay.js");

  const cases: [unknown, string, boolean][] = [
    [{ name: "home" }, "/", false],
    [{ name: "session", ref: { machineId: "m", sessionId: "s" } }, "/m/m/s/s", false],
    [{ name: "gate", screen: "register" }, "/register", false],
    // isSheet is an || chain and isOverlayPath a list of literals, so a new route arm reaches neither and typecheck sees nothing.
    [{ name: "legal", doc: "terms" }, "/terms", false],
    [{ name: "legal", doc: "privacy" }, "/privacy", false],
    [{ name: "new", machineId: null, cwd: null }, "/new", true],
    [{ name: "settings", section: null, machineId: null, system: null }, "/settings", true],
    [{ name: "plugin", machineId: "m", pluginId: "board" }, "/p/m/board", true],
    [{ name: "plugins", tab: "market", entry: null }, "/plugins", true],
    [{ name: "plugins", tab: "installed", entry: null }, "/plugins/installed", true],
    [{ name: "plugins", tab: "market", entry: "autotitle" }, "/plugins/p/autotitle", true],
    // The longest path this app builds: a prefix match in isOverlayPath would still pass every case above.
    [
      { name: "plugins", tab: "market", entry: "autotitle", settings: ["m_1", "m_2"] },
      "/plugins/p/autotitle/settings/m_1/m_2",
      true,
    ],
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
