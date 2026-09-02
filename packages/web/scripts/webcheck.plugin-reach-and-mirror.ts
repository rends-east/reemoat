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
    /*
     * ⚠ **The row this fixture did not have, which is why the defect it exists to
     * catch passed every driver.** `unknown` is the reach on a *cold load* — the
     * ordinary first second, since `bootstrap` promotes to `phase: "ready"` on the
     * machine list, before a single probe — and with `online`, `probing` and
     * `offline` here and nothing for it, both predicates below could fold it into
     * `unreachable` with every assertion in this section still green.
     */
    machine("cold", { reach: "unknown" }),
    machine("banned", { ownerDisabled: true }),
    machine("over", { overLimit: true }),
    machine("shared", { scopes: ["session:read", "session:write"], owned: false }),
    machine("unchosen"),
  ];
  const chosen = new Set(["ok", "probing", "asleep", "cold", "banned", "over", "shared"] as never[]);
  const plan = planTargets(fleet, chosen as never);

  /*
   * ⚠ **The partition is the property, not the four reasons.** Every chosen
   * machine is in exactly one of the two lists — a machine that fell out of both
   * would be one somebody ticked and never heard about again, which is the single
   * failure this whole screen is shaped to prevent. Asserted over the set rather
   * than over the cases, so a fifth reason cannot open a gap by being forgotten.
   */
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

  /*
   * ⚠ **`probing` is attempted and `offline` is skipped, and both are
   * deliberate.** `daemonReadable` treats `probing` as readable because a
   * tab-switch must not unmount a panel; and an unreachable machine is *skipped*
   * rather than refused at the checkbox, because a laptop with the lid shut is the
   * ordinary case and a result line saying so beats a control that will not move.
   */
  check("a machine mid-probe is attempted", plan.eligible.includes("probing" as never), true);
  check(
    "a sleeping one is accounted for rather than attempted",
    plan.skipped.find((one) => one.id === ("asleep" as never))?.reason,
    "unreachable",
  );
  /*
   * ⚠ **And one nobody has asked yet is neither of those two.** It is not attempted
   * — what is installed there cannot be read, so every icon would be drawn from a
   * guess — and it is not `unreachable`, because nothing has failed: the remedy for
   * an outage is to wake the host, and there is no outage. `daemonRead`'s partition,
   * reaching the two predicates it had never been applied to. The pair with `asleep`
   * is the assertion: these two used to be one answer.
   */
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

  /*
   * ⚠ **Both unions are read off `install.ts` rather than typed out here a second
   * time**, which is the shape the `MarketTab` sweep already takes and the reason a
   * fifth and a seventh member could arrive unwatched. `SettingsBlock` had a
   * six-member list written out by hand below; `asking` was added to the type and
   * to the function, and "every reason has a sentence" went on sweeping the six it
   * knew about. `SkipReason` had no sweep at all — its sentences were asserted one
   * at a time, at the call sites that happened to need one. **A list of members
   * maintained beside a union asserts only what somebody remembered to copy.**
   */
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
  /*
   * ⚠ **Only one of them has earned the words "not reachable"** — `reachText`'s rule
   * one file over, arriving here through the same partition. A machine nobody has
   * measured is "not checked yet"; naming a remedy for an outage that has not
   * happened is the defect, and it is worse in this list than on a screen, because
   * these sentences are what a skipped row *reports* after the fact.
   */
  check(
    "and only the one that did not answer says so",
    reasons.filter((one) => /not reachable/.test(skipText(one as never))),
    ["unreachable"],
  );

  /*
   * ⚠ **Ordered by remedy, `machineBadgeText`'s rule.** A machine in more than one
   * of these states names the one that has to be fixed first — a banned owner
   * needs an admin, and retiring another machine does nothing for it.
   */
  check(
    "a machine in two bad states names the remedy that comes first",
    skipReasonFor(machine("both", { ownerDisabled: true, overLimit: true })),
    "owner_disabled",
  );
  /*
   * ⚠ **`machine:admin`, not `session:write`.** A route's scope is the caller's,
   * and installing is an act on the machine rather than on a session — so a shared
   * machine somebody drives sessions on all day is one they may not put code on.
   * Caught here rather than by the daemon's 403, which arrives after an upload.
   */
  check(
    "a grant that drives sessions cannot install",
    plan.skipped.find((one) => one.id === ("shared" as never))?.reason,
    "not_admin",
  );

  /*
   * ⚠ **The switch position, said out loud on the row.** Installing does not
   * switch a plugin on, and an update **inherits** the switch — `host.ts` is
   * explicit that re-enabling somebody's disabled plugin because they updated it
   * would be the daemon deciding on their behalf. If this line does not say so,
   * "I updated it and it does not work" is what arrives instead, and it is the
   * most likely question this feature generates.
   */
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

  /*
   * ⚠ **What the collapsed machine row says, which is the line that replaced a
   * results panel and a Clear button.**
   *
   * The screen used to answer "did that work" *after* the fact, with a notice
   * somebody then had to dismiss. This is the same answer given *before* anybody
   * presses anything and given again after — on the closed row, beside the word
   * Machines — so there is nothing to announce and nothing to clear. The boxes
   * inside are a draft of where the plugin should go; this line is where it is.
   *
   * Names while there are few enough to read, because "on laptop" answers the
   * question somebody actually has and "on 1 of 3" makes them open the list to
   * find out which. Three is where a phone's width turns the line into a
   * paragraph.
   */
  check("nowhere", installedSummary(3, []), "not installed anywhere");
  check("one of three, named", installedSummary(3, ["laptop"]), "on laptop");
  check("three of four, still named", installedSummary(4, ["a", "b", "c"]), "on a, b, c");
  check("four of six becomes a count", installedSummary(6, ["a", "b", "c", "d"]), "on 4 of 6 machines");
  check("everywhere", installedSummary(3, ["a", "b", "c"]), "on all 3 machines");
  /*
   * A fleet of one never says "on all 1 machines", and never names the machine
   * either: there is only one, and repeating its name in a line about it is the
   * chrome restating the body.
   */
  check("a fleet of one", installedSummary(1, ["only"]), "installed");
  /*
   * ⚠ **The other half of that line: the machines the act did not reach.**
   * `installedSummary` is derived from what is *installed*, so a machine that
   * failed is left out of it rather than named — the closed row cannot report a
   * failure at all, and the panel that can is collapsed and `inert`. Same shape as
   * `removalQuestion`: one machine is named, several are named while they still
   * fit a phone's width, and past that they are counted.
   */
  check("nothing failed, so there is nothing to say", failureSummary([]), "");
  check("one machine is named", failureSummary(["laptop"]), "Failed on laptop — the row says why.");
  check("two are still named", failureSummary(["laptop", "mini"]), "Failed on laptop, mini — each row says why.");
  check(
    "and past three they are counted",
    failureSummary(["a", "b", "c", "d"]),
    "Failed on 4 machines — each row says why.",
  );
  /*
   * ⚠ **It never says what happened on the machine, only that the act failed
   * there.** `MachineInstalls` retries nothing but `plugin_busy` because a `POST`
   * that failed in transit says nothing about whether the daemon acted — it may be
   * halfway through unpacking — so a line claiming nothing was installed would be a
   * claim this client cannot make. The reason is the row's, and the row is open by
   * then.
   */
  check(
    "and it claims nothing about what the daemon did",
    /installed|removed|updated|nothing happened/.test(failureSummary(["laptop"])),
    false,
  );
  check("and no fleet at all", installedSummary(0, []), "no machines");
  /* ------------------------------------------------ configuring one ----- */
  /*
   * ⚠ **A different predicate from `skipReasonFor`, and the scope is why.**
   * Installing is an act on the *machine* and takes `machine:admin`; a settings pane
   * is read behind `session:read` and written behind `session:write`. So a grant
   * that drives every session on somebody's host all day may not put code on it and
   * *may* configure what is already there — and reusing the install predicate would
   * grey out the one control that grant is entitled to.
   */
  {
    const pane = { version: "1.0.0", contributes: { settings: true } };
    const noPane = { version: "0.2.1", contributes: { settings: false } };
    const named = (id: string): never => (fleet.find((one) => (one as { id: string }).id === id) ?? fleet[0]) as never;

    check("a reachable machine with a pane is configurable", settingsBlockFor(named("ok"), pane), null);
    /*
     * ⚠ **And one nobody has asked yet is blocked by the wait rather than by
     * anything it has done**, which is the second copy of `skipReasonFor`'s repair —
     * made a second time because these two are deliberately not one predicate. It
     * greyed Settings over a whole fleet on every cold load, with a notice naming a
     * machine that was about to answer.
     */
    check("and one nobody has asked yet is waited for rather than written off", settingsBlockFor(named("cold"), pane), "asking");
    /*
     * ⚠ **The two predicates disagree on the shared machine, and that disagreement
     * is the reason both exist.** This is what stops somebody folding them into one.
     */
    check(
      "a session grant may configure what it may not install",
      [skipReasonFor(named("shared")), settingsBlockFor(named("shared"), pane)],
      ["not_admin", null],
    );
    /*
     * ⚠ **`not_installed` and `no_pane` sit BELOW `no_scope` and `unreachable`, and
     * the obvious order is a bug.** `store.fetchPlugins` swallows every failure into
     * an empty list, so a 403 and a daemon nobody can reach both arrive here as
     * `null` — and answering "that machine does not have this plugin" about either
     * is a claim this client cannot make. `skipReasonFor`'s own argument about
     * `unreachable`, one field over.
     */
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
    /* Ordered by remedy, so a machine in two states names the one to fix first. */
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
    /*
     * ⚠ **`enabled` is not consulted**, `offersSettings`' standing rule: a plugin
     * somebody switched off is the commonest reason to open its settings.
     */
    check(
      "and a switched-off plugin is still configurable",
      settingsBlockFor(named("ok"), { ...pane, contributes: { settings: true } }),
      null,
    );

    /*
     * ⚠ **Read off the union for `SkipReason`'s reason, and it is the same defect
     * twice.** This was six members typed out by hand; `asking` was added to the
     * type and to `settingsBlockText`, and both sweeps below went on sweeping the
     * six they knew about — so the newest arm was the one arm nothing checked.
     */
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
    /*
     * ⚠ **The wait says "not read yet" and never "cannot be read"**, which is the
     * whole of this arm: nothing was asked, so nothing failed — and `settingsNotice`
     * names the *first* blocker in fleet order, so one unasked machine was speaking
     * for a whole selection that was about to answer.
     */
    check("a machine nobody has asked about yet says so, and says it as a wait", blockSays("asking"), "server has not been checked yet, so its settings have not been read");
    check(
      "and only the one that did not answer claims an outage",
      blocks.filter((one) => /is not reachable/.test(blockSays(one))),
      ["unreachable"],
    );
    check("the version is named where there is one", settingsBlockText("no_pane", "server", "0.2.1"), "server has no settings pane for 0.2.1");
    check("and left out where there is not", settingsBlockText("no_pane", "server", null), "server has no settings pane");

    /*
     * ⚠ **The empty string rather than `null`**, so one value feeds the visible line
     * and the `aria-describedby` pointing at it — `EventList`'s rule about a notice
     * that reads empty in exactly the state it was added for.
     */
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

  /* ------------------------------------------------ one row's icons ------ */
  /*
   * ⚠ **The 32-cell sweep rather than the handful somebody thought of**, which is
   * what `draftAct` was extracted from this component for and for the same reason:
   * left inline these are ternaries nothing checks, in the one place on this screen
   * where being wrong means pressing a control that does something other than what
   * it says.
   */
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
  /*
   * ⚠ **Install and remove are never both offered**, which is what makes a row's
   * trailing group readable at a glance rather than a state somebody has to parse.
   */
  check(
    "a row never offers to install and to remove at once",
    answers.filter((one) => one.acts.includes("install") && one.acts.includes("remove")),
    [],
  );
  /*
   * ⚠ **An update never appears without a remove**: an update is an install onto a
   * machine that already has it, so a row offering Update alone would be claiming an
   * install state it does not hold.
   */
  check(
    "and never offers an update it has nothing to update",
    answers.filter((one) => one.acts.includes("update") && !one.acts.includes("remove")),
    [],
  );
  /*
   * ⚠ **Remove is always last, and it is not cosmetic.** The row's confirming pair
   * replaces the trailing group, so the last child before the tap and Cancel after
   * it occupy the same pixels — Q3.218's measured property, reaching a row of icons.
   */
  check(
    "and remove is always the last of them",
    answers.filter((one) => one.acts.includes("remove") && one.acts[one.acts.length - 1] !== "remove"),
    [],
  );
  /*
   * ⚠ **Every `skipReasonFor` state offers nothing, `unreachable` included.**
   * Under the draft that was a rule about a claim — an unticked box on a machine
   * nobody can read. Under live acts it is stronger: Install there fires a request
   * that cannot land, and Remove claims there is something to remove.
   *
   * ⚠ **This said "all four" and there are five** — `asking` split off `unreachable`
   * — which is a comment that was true when written and quietly stopped being. The
   * assertion under it never counted them: it reads the boolean `blocked`, which is
   * `skipReasonFor(…) !== null` collapsed by the caller, so it swept the new state
   * on the day it arrived. A number in prose beside a sweep that does not use it is
   * the thing to write as a property, not to keep in step by hand.
   */
  check("a blocked row offers nothing", answers.filter((one) => one.row.blocked && one.acts.length > 0), []);
  /*
   * ⚠ **And a busy row offers nothing, which is also what stops a second bulk press
   * double-sending**: the bar's counts are derived from this, so a machine with a
   * request out is in none of them.
   */
  check("nor does one with a request out", answers.filter((one) => one.row.busy && one.acts.length > 0), []);
  check(
    "and a screen holding no archive offers neither install nor update",
    answers.filter((one) => !one.canInstall && (one.acts.includes("install") || one.acts.includes("update"))),
    [],
  );
  /* The accessible name is the label, and seven rows saying "Remove" is seven
     controls a screen reader cannot tell apart. */
  /*
   * ⚠ **What a row *draws* is narrower than what it can report**, and the two are
   * separate on purpose: the bar reads `rowActs` to decide whether its own Remove
   * may move, so a row that could not report a removable machine would take the
   * bar's Remove down with it. The property is not the filter — it is that
   * everything a row draws is undone by pressing something else on the same row.
   */
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

  /* ------------------------------------------------ the bulk bar --------- */
  /*
   * ⚠ **The sweep is 2048 cells and its output is collected rather than printed.**
   * `draftAct`'s own block records why: a sweep whose output nobody reads is a sweep
   * whose failure nobody sees.
   */
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
  /*
   * ⚠ **Install, update and remove are "any"; settings is "every", and the asymmetry
   * is the decision.** The first three are fan-outs — a machine the act cannot reach
   * falls out and says so on its own row, which is `planTargets`' partition — while
   * settings is a **navigation**: there is one screen and nothing to skip, so a
   * selection of seven opening a screen about a subset would be the "selected and
   * never heard about again" failure in different clothes.
   */
  check(
    "settings moves only where every selected machine can take it",
    bulkCells.filter(
      (one) => one.answer.settings !== (one.counts.selected > 0 && Math.min(one.counts.configurable, one.counts.selected) === one.counts.selected),
    ),
    [],
  );
  /*
   * ⚠ **And the other three are the opposite rule**, asserted rather than left to
   * read the same as the one above.
   */
  check(
    "while remove moves where any of them can",
    bulkCells.filter((one) => one.answer.remove !== Math.min(one.counts.removable, one.counts.selected) > 0),
    [],
  );
  /*
   * ⚠ **Independence: holding three counts fixed and moving the fourth never changes
   * the other three answers.** The strongest available form of "these four controls
   * do not leak into each other", and a property the single button could not have
   * had.
   */
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
  /*
   * ⚠ **`configurable` is clamped rather than trusted.** The caller derives both
   * from one walk so agreeing is expected — but a count larger than the selection
   * would enable Settings over a selection holding a machine that cannot take it,
   * which is the one state this control exists to refuse.
   */
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
  /*
   * ⚠ **Settings does not consult `canInstall`.** A plugin that arrived as a file is
   * exactly the one whose settings somebody wants, and that screen can never
   * install anything.
   */
  check(
    "settings works on a screen that cannot install",
    bulkEnabled({ selected: 2, installable: 0, updatable: 0, removable: 2, configurable: 2, canInstall: false }).settings,
    true,
  );

  /* ------------------------------------------------ search and filter ---- */
  const fleet = [
    { id: "m_1", name: "laptop", installed: true },
    { id: "m_2", name: "mini", installed: false },
    { id: "m_3", name: "server", installed: true },
  ];
  const needles = ["", "  ", "LAP", "lap", "m_2", "zzz"];
  const filters = ["all", "installed", "absent"] as const;
  /*
   * ⚠ **A subsequence, which is `waitingFloor`'s posture**: order preserved, no
   * duplicates, and nothing invented. A list whose order depends on the filter is a
   * list that reorders under a thumb.
   */
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
  /*
   * ⚠ **The id is matched as well as the name**, because the id is drawn on the row
   * exactly where `ambiguousNames` says the name cannot tell two hosts apart — a
   * needle that could not reach it would be unable to separate the one pair search
   * is most needed for.
   */
  check("and the id is searchable too", shownRows(fleet, "m_2", "all").map((one) => one.name), ["mini"]);
  /*
   * ⚠ **The two halves of the filter partition the whole**, for every needle: a
   * machine in neither is one nothing on this screen can reach.
   */
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

  /*
   * ⚠ **The line that closes the hazard the filter opens.** Select four machines,
   * narrow the filter so two disappear, and the bar still acts on four — which has
   * to be the behaviour, since hiding a row is not unselecting it, but which has to
   * be *said* or one press removes a plugin from machines that are not on screen.
   */
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

  /*
   * ⚠ **Total over every combination**, because an empty box where a list should be
   * is the one state with nothing else on screen to explain it. And ⚠ **no
   * `JSON.stringify`**: `MarketList` quotes a needle through a serialiser one screen
   * over, which shows somebody their own input escaped for anything holding a quote.
   */
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

  /* ------------------------------------------------ the row's subline ---- */
  /*
   * ⚠ **The third argument kept its slot and changed meaning** — `ticked` became
   * `enabled` when the draft went — so the sentence below appears nowhere in the old
   * body on purpose: these fail against it rather than passing by accident.
   *
   * ⚠ **Switched off outranks both comparisons.** An install never switches a plugin
   * on and an update *inherits* the switch, so without this line "I updated it and
   * it does not work" is what arrives instead.
   */
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
  /* One rule for "behind", shared by the subline and the Update icon beside it. */
  check("behind is numeric and null is never behind", [isBehind("0.9.0", "0.10.0"), isBehind("0.10.0", "0.9.0"), isBehind("1.0.0", null)], [true, false, false]);

  /* ------------------------------------------------ the question --------- */
  check("one machine is named", removalQuestion(["laptop"]), "Remove it from laptop and everything it kept there?");
  check("several are counted", removalQuestion(["a", "b", "c"]), "Remove it from 3 machines and everything it kept on them?");
  check("and none is still a sentence", removalQuestion([]), "Remove it from 0 machines and everything it kept on them?");
  /*
   * ⚠ **The row's question and a one-machine bulk selection are the same string**,
   * which is what stops the two confirmations drifting into two different promises
   * about the same act.
   */
  check("the row and the bar ask the same thing about one machine", removalQuestion(["laptop"]), removalQuestion(["laptop"]));
}

process.stdout.write("\nthe one mirror whose other half is in a different repository\n");
{
  /*
   * ⚠ **`packages/web/src/catalogue.ts` is a hand mirror of a file this repository
   * does not contain**, and that makes it the only mirror here neither side's CI
   * can check. The original is `services/plugins/src/catalogue.ts` in
   * `rends-east/reemoat-prod`; this is `rends-east/reemoat`. An import across that
   * line compiles on the machine both are checked out on and fails in this repo's
   * CI on the first run — and would publish a private service's shape besides.
   *
   * So the two copies can only be compared where both happen to be on one disk:
   * the development box and the stand. Everywhere else this **must skip** — and
   * the skip is the dangerous part, not the comparison.
   *
   * ⚠ **A skip that says nothing is a green tick about work nobody did.** It is
   * the same shape as the assertion that read `.clamped === true` and stayed true
   * while becoming meaningless: nothing fails, nothing is checked, and "skipped"
   * and "agrees" are indistinguishable in the output. For this pair, skipping is
   * not the edge case — in CI it is *every* run. So it prints a line of its own
   * and says which file it wanted.
   */
  const ORIGINAL = new URL("../../../../services/plugins/src/catalogue.ts", import.meta.url);
  let service: string | null = null;
  try {
    service = readFileSync(ORIGINAL, "utf8");
  } catch {
    // Absent is the ordinary state in CI and a real answer, not a failure — said
    // out loud rather than passed over.
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
    /** Depth-1 field names of the object literal beginning at `from`. */
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

    /*
     * ⚠ **`client ⊆ service`, the opposite direction from the in-repo sweep.**
     * There the client is allowed to be behind, because an older *daemon* sends
     * less and the field is optional here. Here the client is allowed to be behind
     * too — the service's contract is that fields are added and never repurposed,
     * and `readCatalogue` tolerates ones it has never heard of. What it may not do
     * is declare a field the service does not send: `readOne` fails **closed** on a
     * required field, so a name this side invented or that was renamed over there
     * does not degrade one row, it takes the whole market dark.
     */
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
      /*
       * Unreadable is a failure here rather than a skip: the file *is* on this
       * disk, so a declaration this cannot find means the shape changed under the
       * pattern — which is precisely when the comparison is worth most and exactly
       * when it would otherwise fall silent.
       */
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
  /*
   * ⚠ **A superseded gate, asserted because it is still exported.** This answered
   * whether the **gear** was drawn on a plugin's row, and there is no gear:
   * `plugin-ui.md` records it going, and the way in is the machine table's bulk bar
   * with the scope on the URL. The live gate is `settingsBlockFor` under
   * `bulkEnabled`'s `settings` arm, and it is asserted in its own section above.
   *
   * ⚠ **The rule below is now the *inverse* of the shipped one, which is exactly
   * why these six stay rather than going with the control they gated.** This
   * answers *anywhere* — one install with a pane is enough, a fleet mid-update
   * being the ordinary case — while `install.ts` answers *every*:
   * `selected > 0 && at(counts.configurable) === selected`. Q3.468 is the argument,
   * and it is not a tidy-up: Settings is a **navigation** rather than a fan-out, so
   * one screen about a subset of what somebody ticked is the "selected and never
   * heard about again" failure in different clothes. A reader who finds an exported
   * function with no caller and wires it back in re-opens Q7.108, and these are what
   * would say so.
   *
   * *`enabled` is not consulted* is the half that survived the reversal intact:
   * a plugin somebody switched off is the commonest reason to open its settings,
   * and `settingsBlockFor` independently declines to consult it — asserted there,
   * against the function that is actually called.
   *
   * ⚠ **Deleting it is three edits and one of them is not in this file**: the
   * function and its docblock in `plugins.ts`, this block, and nothing in
   * `docs/DECISIONS.md` — `docscheck` greps whole file text, so the prose citations
   * in `pane.ts` and `install.ts` keep both `Q` references resolving. Scrubbing
   * those two comments as well is what would fail its symbol pass.
   */
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
    // Against the *daemon's* list rather than this file's own union, so the table
    // is pinned to the thing it describes rather than to the mirror of it.
    const { PLUGIN_SCOPES } = await import("../../../src/plugins/protocol.js");
    /*
     * ⚠ **One table now, and the second one was deleted rather than kept in
     * step.** There were two — a long sentence per scope and a two-word form for
     * the closed permissions line — and the closed line no longer draws anything
     * but the word "Permissions", so the short table had exactly one reader and
     * lost it. Two exhaustive records over one union is the pair that drifts by
     * one, and the cheapest way to stop that pair drifting is for there to be one
     * of them.
     */
    check("every scope has a line", Object.keys(PLUGIN_SCOPE_TEXT).sort(), [...PLUGIN_SCOPES].sort());
    check("and none of them is blank", Object.values(PLUGIN_SCOPE_TEXT).filter((one) => one.trim().length === 0), []);
    /*
     * ⚠ **The length is the change, so the length is what is pinned.** These were
     * sentences and six of them stacked was a wall of prose in the fold somebody
     * opens before granting a stranger's code access to their sessions — which is
     * the one screen where an unread disclosure discloses nothing. Nothing else in
     * this build would notice them growing back one entry at a time; `webcheck` is
     * the only thing that can, and `PLUGIN_SCOPE_TEXT_MAX` lives beside the table
     * so the ceiling and the strings move together.
     */
    check(
      "a permission is a line, not a paragraph",
      Object.entries(PLUGIN_SCOPE_TEXT)
        .filter(([, line]) => line.length > PLUGIN_SCOPE_TEXT_MAX)
        .map(([scope, line]) => `${scope}: ${line.length}`),
      [],
    );
    /*
     * Whose money it is has to survive the shortening — that is the whole reason
     * `model` was given a scope of its own rather than riding `sessions.write` —
     * and so does the half of `sessions.write` that answers agents' questions,
     * which is the capability that approves shell commands.
     */
    check("the one that spends money still says so", /you|your/.test(PLUGIN_SCOPE_TEXT.model), true);
    check(
      "and the one that answers permissions still says that",
      /answer/.test(PLUGIN_SCOPE_TEXT["sessions.write"]),
      true,
    );
  }
  {
    /*
     * ⚠ **What a settings pane may draw, mirrored, and asserted as a *subset* of
     * what a screen draws.** These are two vocabularies over one protocol: a
     * plugin's screen keeps all five blocks and all five field kinds, and a
     * settings pane is bounded to three controls and the words around them. The
     * subset direction is the load-bearing half — a settings type that is not a
     * screen type is a value `PluginView` has no arm for, which renders as
     * nothing and says nothing about itself.
     */
    const { PLUGIN_SETTINGS_BLOCK_TYPES, PLUGIN_SETTINGS_FIELD_KINDS } = await import("../src/wire.js");
    const { PLUGIN_BLOCK_TYPES, PLUGIN_SETTINGS_BLOCK_TYPES: daemonBlocks, PLUGIN_SETTINGS_FIELD_KINDS: daemonKinds } =
      await import("../../../src/plugins/protocol.js");
    check("a settings pane draws a subset of what a screen draws", PLUGIN_SETTINGS_BLOCK_TYPES.filter((one) => !PLUGIN_BLOCK_TYPES.some((two) => two === one)), []);
    check("the block mirror agrees with the daemon", [...PLUGIN_SETTINGS_BLOCK_TYPES], [...daemonBlocks]);
    check("and so does the field mirror", [...PLUGIN_SETTINGS_FIELD_KINDS], [...daemonKinds]);
    /*
     * The three the person asked for, named rather than counted: a box you type
     * in, a switch, a dropdown. A fourth arriving without this failing would be a
     * vocabulary that grew back without anybody deciding to.
     */
    check("and there are three of them", [...PLUGIN_SETTINGS_FIELD_KINDS].sort(), ["select", "text", "toggle"]);
  }
  const of = (id: string, name: string, categories: string[], description = "a plugin about sessions") =>
    ({ id, name, categories, description }) as never;

  const titles = of("autotitle", "Auto title", ["sessions"]);
  const board = of("board", "Board", ["work"]);
  const loose = of("loose", "Loose", []);

  /*
   * ⚠ **Names only, and the exclusion of the description is a decision rather
   * than an oversight — so it is pinned rather than described.** A catalogue is a
   * handful of entries and a needle matched against prose hits most of them:
   * every one of these three has "sessions" somewhere in its description, so a
   * search for it would return all three and the box would read as broken.
   */
  check("an empty needle is not a search", [matchesQuery(titles, ""), matchesQuery(titles, "   ")], [true, true]);
  check("the name matches, whatever the case", matchesQuery(titles, "AUTO TIT"), true);
  check("and so does the id, because that is a name people type", matchesQuery(titles, "autotit"), true);
  check("a needle in the description alone matches nothing", matchesQuery(board, "sessions"), false);
  check("and one that is in neither matches nothing either", matchesQuery(titles, "zzz"), false);

  /*
   * ⚠ **One group back means the caller draws no heading**, which is the rule the
   * JSX reads rather than one it invents: a heading over the whole list labels
   * "everything", and a single plugin under a category name reads as a section
   * somebody forgot to fill.
   */
  check("a catalogue that agrees on one category is one group", groupCatalogue([titles, of("x", "X", ["sessions"])], "").length, 1);
  check(
    "and two categories are two, in name order",
    groupCatalogue([board, titles], "").map((group) => group.name),
    ["sessions", "work"],
  );
  /*
   * `Other` is the *absence* of a category rather than one of them, so it goes
   * last wherever it falls alphabetically — between `sessions` and `work` it would
   * read as a category somebody chose.
   */
  check(
    "the plugins that name none come last, never in the middle",
    groupCatalogue([loose, board, titles], "").map((group) => group.name),
    ["sessions", "work", UNGROUPED],
  );
  /*
   * ⚠ **The first category only.** A plugin listing several drawn under each
   * would put one row on screen twice in a list whose whole job is to be
   * countable — the objection that stopped a pinned session being drawn twice in
   * the rail.
   */
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
  /*
   * The needle and the grouping are one pass: a group that survives filtering
   * down to nothing must not be drawn as an empty heading.
   */
  check("a group nothing matches is not a heading with nothing under it", groupCatalogue([board, titles], "auto").map((g) => g.name), ["sessions"]);
  check("and a needle matching nothing is no groups at all", groupCatalogue([board, titles], "zzz"), []);
}

process.stdout.write("\nwhich routes are pop-ups, asked from both directions\n");
{
  const { isSheet } = await import("../src/nav.js");
  const { isOverlayPath } = await import("../src/ui/overlay.js");

  /*
   * ⚠ **These two answer one question from two directions and must hold the same
   * set** — `isSheet` from a parsed route, `isOverlayPath` from a path. A route in
   * one and not the other is a pop-up that either forgets what it was drawn over
   * (so its ✕ goes home) or records one while being a screen (so Back leaves the
   * app). Both were reachable when the path list was two literals.
   *
   * Asserted as a table of route-and-its-path rather than on the one that was
   * added, so the next pop-up is covered by being written down here at all.
   */
  const cases: [unknown, string, boolean][] = [
    [{ name: "home" }, "/", false],
    [{ name: "session", ref: { machineId: "m", sessionId: "s" } }, "/m/m/s/s", false],
    [{ name: "gate", screen: "register" }, "/register", false],
    [{ name: "new", machineId: null, cwd: null }, "/new", true],
    [{ name: "settings", section: null, machineId: null, system: null }, "/settings", true],
    [{ name: "plugin", machineId: "m", pluginId: "board" }, "/p/m/board", true],
    // Both depths of the market, because they are different route shapes reaching
    // the same predicate — and `/plugins` is one segment away from `/p`, which is
    // exactly the neighbour a whole-segment rule exists for.
    [{ name: "plugins", tab: "market", entry: null }, "/plugins", true],
    [{ name: "plugins", tab: "installed", entry: null }, "/plugins/installed", true],
    [{ name: "plugins", tab: "market", entry: "autotitle" }, "/plugins/p/autotitle", true],
    /*
     * ⚠ **And the deepest one, because it is the longest path this app builds.** A
     * scoped settings screen carries one segment per machine, so `/plugins/p/x/
     * settings/m_1/m_2` is six segments where every other overlay is at most three
     * — and `isOverlayPath` compares the *first* segment, which is the property
     * that keeps that true. A `startsWith` creeping in here would still pass every
     * case above it.
     */
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
