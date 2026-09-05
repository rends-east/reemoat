import { readFileSync, readdirSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nthe decision surfaces, at the platform tap minimum\n");
{
  /*
   * **Every pressable thing on a card where the agent is waiting on a human is
   * 44px**, and this is asserted on those three files rather than on the whole UI
   * for a reason worth stating: a blanket rule would be false. Measured across
   * `src/ui`, 40 of 57 class strings carrying `tap` or `press` do not reach 44px,
   * and most of them are right not to — `SignIn`'s `tap ${LINK}` is a link inside a
   * sentence, `AgentsPanel`'s are `<summary>` elements in running text, and the
   * machine tabs are deliberately 32px pills in a strip you drag sideways. A check
   * needing a 40-entry exception list is a list, not a check.
   *
   * What makes these three different is consequence. A mis-tap here answers the
   * agent: it approves a command, refuses one, or submits a form into the model's
   * context. `AskCard`'s own docblock already argues the standard — *"44px, like
   * every other target in this app… It was `min-h-9`, i.e. 36px, on the one row in
   * this UI where a mis-tap approves something"* — and the standard was then
   * violated on the same card's header controls (26px, 2px apart) and on
   * `ElicitationCard`'s answer rows (40px) and `PermissionCard`'s detail disclosure
   * (18px), all of which this check found. A convention plus a docblock is not a
   * mechanism; this is the mechanism.
   *
   * `size="lg"` is absent from the pattern deliberately: an `IconButton` carries no
   * `tap` in the caller's markup, because the primitive adds its own — so a control
   * routed through the primitive is not scanned here at all. **That is an exemption
   * rather than coverage**, and the assertions at the end of this section are what
   * make it one. The sentence that originally stood here said the primitive's own
   * 44px entry covered them, which was false while `md` existed — 36px, with no
   * growth mechanism, and the *default* — and therefore false for about a third of
   * its call sites. `md` is deleted and `size` is required now, so the exemption is
   * finally earned rather than assumed: the table has no entry under the floor, no
   * caller can omit the prop, and no caller can take the size back through
   * `className`, all three asserted down there rather than believed up here.
   * Only hand-rolled class strings reach the scan in this loop.
   */
  const DECISION_CARDS = ["AskCard.tsx", "PermissionCard.tsx", "ElicitationCard.tsx"];
  // `min-h-14` and `min-h-16` are taller rows — a row carrying a subline, and the
  // new-session tile carrying three lines — and `menuRow` and `TAP_GROW_Y` are the
  // two shared constants that reach 44 by themselves. Anything not on this list is
  // asked to prove its height rather than assumed to have one.
  const REACHES_44 = /min-h-11|min-h-14|min-h-16|\bh-11\b|menuRow|TAP_GROW_Y/;
  // Both spellings of the attribute. The template-literal arm stops at the first
  // backtick, which holds because every interpolation on these cards is a ternary
  // over double-quoted strings.
  const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`)/g;

  const short: string[] = [];
  let scanned = 0;
  for (const file of DECISION_CARDS) {
    const src = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    for (const match of src.matchAll(CLASS_ATTR)) {
      const classes = match[1] ?? match[2] ?? "";
      if (!/\btap\b|\bpress\b/.test(classes)) continue;
      scanned += 1;
      if (!REACHES_44.test(classes)) short.push(`${file}: ${classes.slice(0, 60)}`);
    }
  }

  // A pattern that matches nothing would pass this section silently, which is the
  // failure mode of every source-text assertion in this file.
  check("the scan actually found the controls", scanned >= 6, true);
  check("nothing a person taps to answer an agent is under 44px", short, []);

  /*
   * ⚠ **The plugin surface, held to the same floor by a different argument.**
   *
   * It is deliberately not added to `DECISION_CARDS` above: that list is narrow
   * on purpose, and its reason is that a mis-tap there *answers the agent*. This
   * is a second consequence rather than a widening of that one. Uninstalling a
   * plugin takes everything it stored and nothing brings it back, and a plugin
   * author can mark any row action `destructive` — so the two files below carry
   * irreversible controls drawn by somebody who is not this app.
   *
   * Two sweeps, because the controls fail two different ways. The hand-rolled
   * ones reach the `tap` scan and were 20px: `PluginView`'s row opener claimed
   * "`tap` for the 44px reach", and `.tap` in `index.css` is three `transition`
   * properties with no height at all. The rest go through `Button` at
   * `size="sm"` — 36px — which `BUTTON_SIZE` licenses only for "the only thing on
   * that row", and these sit four abreast.
   *
   * The `size="sm"` sweep reads an *element* rather than a line, tracking brace
   * depth to find the tag's own `>`: the prop and the escape are on different
   * lines of the same tag, and an arrow function in `onClick` puts a `>` inside
   * the props that a line- or regex-based scan stops at.
   */
  const PLUGIN_SURFACE: readonly (readonly [string, URL])[] = [
    ["PluginView.tsx", new URL("../src/ui/PluginView.tsx", import.meta.url)],
    ["PluginsPanel.tsx", new URL("../src/ui/settings/PluginsPanel.tsx", import.meta.url)],
  ];
  // The documented escape, spelled once: `sm` keeps the desktop density and the
  // media query puts the platform minimum back wherever there is a finger.
  const COARSE_FLOOR = /pointer:coarse\)\]:min-h-11/;

  const shortPlugin: string[] = [];
  const bareSmall: string[] = [];
  let tapped = 0;
  let small = 0;
  for (const [label, url] of PLUGIN_SURFACE) {
    const src = readFileSync(url, "utf8");
    for (const match of src.matchAll(CLASS_ATTR)) {
      const classes = match[1] ?? match[2] ?? "";
      if (!/\btap\b|\bpress\b/.test(classes)) continue;
      /*
       * `LINK` is excluded, and it is the one exclusion here. It is the shared
       * class for a link *inside running text* — "Drawn by board on this machine.
       * All plugins" — and the scan this one is modelled on already argues that
       * case in its own docblock, beside `SessionBrowser`'s two-line rows and
       * `AgentsPanel`'s `<summary>` elements. A 44px box around three words in the
       * middle of a sentence is not a bigger target, it is a broken paragraph.
       * Everything that is a control somebody aims at still has to answer.
       */
      if (classes.includes("${LINK}")) continue;
      tapped += 1;
      if (!REACHES_44.test(classes)) shortPlugin.push(`${label}: ${classes.slice(0, 60)}`);
    }
    for (const piece of src.split(/<(?=Button\b|DangerButton\b)/).slice(1)) {
      let depth = 0;
      let end = -1;
      for (let i = 0; i < piece.length; i += 1) {
        const ch = piece.charAt(i);
        if (ch === "{" || ch === "(") depth += 1;
        else if (ch === "}" || ch === ")") depth -= 1;
        else if (ch === ">" && depth === 0) {
          end = i;
          break;
        }
      }
      if (end < 0) continue;
      const props = piece.slice(0, end);
      if (!/size="sm"/.test(props)) continue;
      small += 1;
      if (!COARSE_FLOOR.test(props)) bareSmall.push(`${label}: ${props.slice(0, 60).replace(/\s+/g, " ")}`);
    }
  }

  /*
   * Both counts, for the reason the sweep above states: a pattern that matches
   * nothing passes silently, and this one has two patterns to get wrong.
   *
   * ⚠ **`small` fell from 8 to 6, and the fall is the improvement rather than a
   * regression to accommodate.** `PluginRow` used to draw up to four outlined
   * `size="sm"` buttons in a wrap — Open, Settings, Switch off, Remove — which was
   * the standing counterexample to `web-shell.md`'s rule that everything else a
   * settings row can do sits behind **one kebab**. They are `RowAction`s now, and
   * `menuRow` is `min-h-11` at every pointer, so the four controls that left this
   * count did not get smaller: they stopped needing an escape hatch. The assertion
   * below is what proves the four went somewhere rather than away.
   *
   * ⚠ **This went on to enumerate what was left — "`PluginView`'s four and the
   * two-step confirm this row keeps" — and that enumeration expired.** Measured
   * now: `PluginView` still draws four (a plugin's own row actions, by somebody who
   * is not this app) and `PluginsPanel` draws **three**, the confirming pair plus a
   * Restart, so `small` is 7. The count below is deliberately a floor rather than
   * the number, precisely so that a control arriving on this surface is not a
   * failure — but a sentence naming the members is a second copy of a list, and it
   * drifted the first time one was added. What the floor is for is the pattern:
   * a `size="sm"` scan that matches nothing passes silently.
   *
   * ⚠ **And all seven now carry the escape twice**, which is a fact worth writing
   * down before somebody reads it as duplication and tidies it: `BUTTON_SIZE.sm`
   * carries the coarse floor itself as of this release, so these hand-written
   * copies are redundant rather than wrong. Deleting them is safe **only** while
   * the `BUTTON_SIZE` check directly below stands, which is why that check was
   * added in the same change.
   *
   * ⚠ **And then seven became five** (E7's review, Q3.552): the confirming pair
   * left this file for `TwoStep` in `bits.tsx`, whose two answers go through
   * `BUTTON_SIZE.sm` with no `className` of their own — which is exactly the case
   * the check below exists for, and the sweep above cannot see. What is left on
   * this surface is `PluginView`'s four and `PluginsPanel`'s Restart.
   */
  check("the plugin sweep actually found the controls", [tapped >= 1, small >= 5], [true, true]);
  check("nothing on a plugin's own surface is under 44px", shortPlugin, []);
  check("and every small control there keeps the coarse-pointer floor", bareSmall, []);

  /*
   * ⚠ **And the primitive all of those `size="sm"` call sites go through, which is
   * where the floor actually lives — asserted here for the first time.**
   *
   * The sweep above reads *call sites*: it passes for every button that writes the
   * escape into its own `className` by hand and says nothing whatever about the
   * ones that do not. So for the whole time `BUTTON_SIZE.sm` was
   * `"min-h-9 px-2.5 text-xs"` — 36px, no growth mechanism of any kind — this
   * section was green, and the only thing holding that entry was its own docblock
   * reserving `sm` for *"a confirmation that has replaced the controls on a
   * settings row, so it is the only thing on that row"*. The table's docblock now
   * carries the count of how many call sites took it anyway and how many of those
   * are the exact opposite of that shape — an `Empty`'s `action`, the one control
   * on an otherwise empty pane. **A reservation stated in a docblock and enforced
   * by nothing is not a reservation**, which is `ICON_BUTTON_SIZE.md`'s lesson one
   * table over: that one has been pinned here since it was learned, and this one
   * never was.
   *
   * Held to `COARSE_FLOOR` rather than to a second spelling of 44, so there stays
   * one definition of the escape in this file; and read off the **stripped**
   * source, because the docblock above the table quotes the old 36px value
   * verbatim while arguing that it expired.
   */
  {
    const tableSrc = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
    const buttonAt = tableSrc.indexOf("const BUTTON_SIZE = {");
    const buttonSizes = [
      ...tableSrc.slice(buttonAt, tableSrc.indexOf("} as const;", buttonAt)).matchAll(/^ {2}(\w+): "([^"]*)",$/gm),
    ].map((entry) => [entry[1] ?? "", entry[2] ?? ""] as const);
    // The usual guard: a table that was renamed out from under this reads as an
    // empty list, and every sweep below would pass over it having asserted nothing.
    check("the button size table was found and has entries in it", [buttonAt >= 0, buttonSizes.length >= 2], [true, true]);
    check(
      "and every size a caller can name reaches 44px under a finger",
      buttonSizes.filter(([, classes]) => !/\bmin-h-11\b/.test(classes)).map(([name]) => name),
      [],
    );
    /*
     * ⚠ **And which of the two ways each one gets there, because the pair is the
     * property.** `md` is the default and is unconditionally 44px — demoting it to
     * the media query would take the floor off every desktop pointer at once, and
     * `/min-h-11/` above cannot tell the two apart. `sm` keeps its 36px density on a
     * mouse and buys the floor back only where there is a finger, which is the whole
     * of what the escape is for.
     */
    check(
      "the default is 44px at every pointer",
      buttonSizes.filter(([name]) => name === "md").map(([, classes]) => /^min-h-11\b/.test(classes)),
      [true],
    );
    check(
      "and the small one carries the escape rather than a bare height",
      buttonSizes.filter(([name]) => name === "sm").map(([, classes]) => COARSE_FLOOR.test(classes)),
      [true],
    );
  }

  /*
   * ⚠ **`ChoiceRow`, which neither sweep above reaches and which nothing else
   * held to a height at all.** `bits.tsx` is read elsewhere in this file for
   * tokens — opacity and border — and never for a target size, and this row is
   * not on a decision card or on the plugin surface, so it fell between the two.
   * It is the row every model and every harness in `AgentBuilder` is chosen on and
   * every system in `SystemsPanel` is opened from: a mis-tap picks the wrong
   * model, which is the consequence the decision-card scan is scoped by, arriving
   * two screens earlier. Held to the same pattern rather than to a second spelling
   * of 44, so there is one definition of the floor in this file.
   */
  const bitsSrc = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  /*
   * Only the leading literal run of the template, up to its first `${`. That is
   * where an unconditional utility lives, and stopping there is what keeps this
   * off the two interpolations — one of which is itself a nested template, so a
   * `[^`]*` reaching for the closing backtick finds the wrong one.
   */
  const choiceRowClasses = /className=\{`(tap press flex[^`$]*)\$\{/.exec(
    bitsSrc.slice(bitsSrc.indexOf("export function ChoiceRow")),
  )?.[1] ?? "";
  check("the primitive's own class string was found", choiceRowClasses.length > 0, true);
  check("and the row a model is chosen on clears the tap minimum", REACHES_44.test(choiceRowClasses), true);

  /*
   * ⚠ **And the screen every session starts from, where exactly one assertion
   * existed and it was bound to one handler** (`Import code`, by its `onClick`),
   * leaving the eight controls beside it pinned by nothing. Same pattern, same
   * floor, swept over the file.
   *
   * ⚠ **One of them was genuinely under 44px, and the exception was written down
   * as an equality rather than skipped — which is what got it fixed.**
   * `DirectoryPicker`'s folder rows carried no height utility at all: `py-2.5` is
   * 20px, the label is `text-sm` whose line-height `index.css` sets to 1.375rem =
   * 22px, and `border-b` adds 1. That was **43px**, one short of the platform
   * minimum, on the rows somebody walks a directory tree with — where a mis-tap
   * opens the wrong folder rather than doing nothing. It was also the only tap
   * target on this screen whose height came from type metrics rather than from a
   * utility, so it would have moved again, silently, the next time the type scale
   * was touched.
   *
   * `min-h-11` now asks for the floor directly and the list below is empty. The
   * empty list is the assertion: an allowlist would have gone quietly green on the
   * fix *and* on the next regression, while an equality fails on both — which is
   * why the exception was recorded this way while it stood.
   */
  const startSrc = readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8");
  const shortStart: string[] = [];
  let aimed = 0;
  for (const match of startSrc.matchAll(CLASS_ATTR)) {
    const classes = match[1] ?? match[2] ?? "";
    if (!/\btap\b|\bpress\b/.test(classes)) continue;
    aimed += 1;
    if (!REACHES_44.test(classes)) shortStart.push(classes.slice(0, 60));
  }
  /*
   * ⚠ **Eight, and it was nine.** The `Edit <preset>` control under the picker is
   * gone: editing an assembled agent is a row on the machine's Agents screen now,
   * where the thing being edited is a full-width row rather than a 112px tile in a
   * strip you drag sideways. What replaced the `+` beside it is the gear, which is
   * the same control in the same slot and therefore still counted here.
   *
   * A count going *down* is only good news if the act moved rather than
   * disappeared, which is the trap `PluginsPanel`'s kebab assertion was written
   * against one section down. What answers it here is the pair below: this file
   * builds no path into the builder, and `MachineAgentsSection` builds both.
   */
  check("the new-session sweep actually found the screen's controls", aimed, 8);
  check("and every one of them clears 44px", shortStart, []);

  /*
   * ⚠ **Where those four controls went, asserted off the file rather than
   * assumed.** The count above dropping is only good news if the acts moved into
   * a menu; if somebody deleted them instead, that check would go *greener* while
   * the screen lost the only way to switch a plugin off. So this reads
   * `PluginsPanel.tsx` off disk and requires the kebab and its four rows — the
   * same shape `webcheck` already uses to hold `SessionBrowser` to calling
   * `pinnedFor` and `orphansFor`.
   *
   * `Remove` carries `danger` because it is the one act here that destroys
   * something: uninstalling takes the plugin's `plugin_data` with it and nothing
   * brings that back. `RowAction`'s own docblock argues why that is a tone on a
   * menu row rather than a `DangerButton`.
   */
  {
    // Comments stripped, as every other source read here is: the includes below
    // are on JSX, and a docblock quoting a removed row (`label="Settings"` is
    // the one this file argues against) would satisfy or fail them from prose
    // (review D12).
    const panel = stripComments(readFileSync(new URL("../src/ui/settings/PluginsPanel.tsx", import.meta.url), "utf8"));
    /*
     * ⚠ **`Settings` is deliberately *not* in this list any more, and the check
     * below is what stops it coming back.** A plugin's settings are on the
     * plugin's own page; a second entry here would be a second door to one pane,
     * which is how the one nobody uses drifts from the one they do.
     */
    const wanted = ['label="Open"', 'label="Remove"', "danger", "<Menu", "IconButton"];
    // Comments stripped: the docblock over the note records the cut sentence.
    const consent = readFileSync(new URL("../src/ui/PluginConsent.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // The archive note is eleven words; the reassurance that used to follow it
    // described a step the screen draws anyway.
    check("the archive note no longer promises what the consent wall shows", consent.includes("Nothing is sent until"), false);
    check("and says re-installing keeps data", consent.includes("Re-installing keeps stored data."), true);
    check(
      "a machine's plugin row keeps every act, behind one kebab",
      wanted.filter((needle) => !panel.includes(needle)),
      [],
    );
    check("and offers no settings of its own", panel.includes('label="Settings"'), false);
    /*
     * ⚠ **Open is present-but-disabled while the plugin is off**, which its own
     * comment claimed for a release while the JSX gated it on `plugin.enabled`
     * and drew nothing. A control that vanishes is one somebody goes looking
     * for; a dimmed row says why it will not act.
     */
    check("Open stays in the menu while the plugin is off, disabled", /label="Open"\s*disabled=\{!plugin\.enabled\}/.test(panel), true);
    /*
     * **The remove confirmation names the plugin and replaces the row's
     * controls.** "Remove it and everything it kept?" was drawn *under* a row
     * whose link and kebab stayed live, and Cancel was the one filled button on
     * the screen. The pair is `TwoStep`'s now (E7's review, Q3.552): Cancel
     * last and in the default tone are that primitive's guarantees, pinned over
     * it in `webcheck.settings-routing.ts`. What this file has to hold is that
     * the question and the act reach it — the act as `danger` with the glyph,
     * since uninstalling takes the plugin's data — that the row draws no Cancel
     * of its own beside them, and that no Cancel in this file (the install
     * flow's abort included) wears `tone="primary"`.
     */
    const confirmStart = panel.indexOf("and its data?");
    check("the remove question names the plugin", confirmStart >= 0 && /Remove <span[^>]*>\{plugin\.name\}<\/span> and its data\?/.test(panel), true);
    const confirmBox = confirmStart >= 0 ? panel.lastIndexOf("<TwoStep", confirmStart) : -1;
    // Where the element closes: its own `/>` on a line of its own, since a `<>…</>` fragment inside `question` carries a `/>` too.
    const confirmGroup = confirmBox >= 0 ? panel.slice(confirmBox, confirmStart + panel.slice(confirmStart).search(/^\s*\/>/m)) : "";
    check("and the pair is the primitive's, with the act destructive", /act=\{\{ label: "Remove", danger: true, icon: Trash2 \}\}/.test(confirmGroup), true);
    check("and the row draws no Cancel of its own beside it", /setConfirming\(false\)/.test(panel), false);
    check("and Cancel wears the default tone", /tone="primary"[^>]*>\s*Cancel|<Button[^>]*tone="primary"[\s\S]{0,120}Cancel/.test(panel), false);
    // The confirmation is drawn *instead of* the link-and-kebab box, so the two
    // are the arms of one ternary rather than siblings: `confirming ? (…) : (…)`.
    check("and the confirmation stands in for the row's controls rather than under them", /\{confirming \? \(\s*<TwoStep\b/.test(panel), true);
    /*
     * ⚠ **The row is a link, and the link is the whole answer to "where are this
     * plugin's settings".** Without this, deleting the `Settings` entry above
     * reads as an improvement while leaving a screen that lists plugins and can
     * reach none of them.
     */
    check("and the row itself opens the plugin", /marketEntryPath\(plugin\.id\)/.test(panel), true);
    /*
     * ⚠ **The wall of scope prose is gone from this row and must not return.**
     * Every scope was drawn here as a sentence, on every row, on every machine —
     * identical text about a plugin whose permissions are one tap away on its own
     * page. It is the table's only other reader that ever existed, so an import of
     * it here is the shape the regression takes.
     */
    check("and does not restate every permission on it", panel.includes("PLUGIN_SCOPE_TEXT"), false);
    // The switch is the one whose label is computed, so it cannot be a literal —
    // and it is the act that would be silently lost by the deletion this guards.
    check(
      "including the switch, whose label depends on which way it is",
      /label=\{plugin\.enabled \? "Switch off" : "Switch on"\}/.test(panel),
      true,
    );
  }

  /* ---------------------------------------------------------------- *
   * Where a plugin's settings are, and what the permissions line says.
   *
   * ⚠ **Three shapes read off disk, because all three are decisions about
   * *placement* and nothing in the type system can hold one.** Each was asked for
   * in as many words, and each has a plausible-looking edit that undoes it while
   * everything still compiles and every other check stays green.
   * ---------------------------------------------------------------- */
  {
    const sheet = readFileSync(new URL("../src/ui/plugins/PluginsSheet.tsx", import.meta.url), "utf8");
    const entry = readFileSync(new URL("../src/ui/plugins/MarketEntry.tsx", import.meta.url), "utf8");
    /*
     * ⚠ **Settings are a screen of their own, reached by the gear in the head.**
     * They were a section on the entry page — under a permissions fold, above an
     * install control, on a page that also carries a version history, which is a
     * form buried in a brochure. Both halves are asserted: the gear exists and
     * goes to the settings path, and the page below no longer draws the pane. One
     * without the other is either a control that goes nowhere or two doors to one
     * screen.
     */
    /*
     * ⚠ **The gear is gone, and both halves are pinned because either alone is a
     * defect.** A head that still builds the path is a control nobody can see; a
     * bulk bar that does not build it is a screen with no way in.
     *
     * What it was, and why it went: the only route into a plugin's settings, asking
     * no question about *which* machines — the screen it opened then picked one from
     * a dropdown over a set that is not the set the plugin is on, and where that came
     * to one it drew nothing at all, so the commonest state named no machine
     * anywhere. The scope is chosen on the plugin's page now and rides the URL.
     */
    const installsSrcEarly = stripComments(
      readFileSync(new URL("../src/ui/plugins/MachineInstalls.tsx", import.meta.url), "utf8"),
    );
    const fleetSrcEarly = stripComments(
      readFileSync(new URL("../src/ui/plugins/InstalledList.tsx", import.meta.url), "utf8"),
    );
    check("the head carries no gear", /Settings2/.test(sheet), false);
    check("and builds no settings path of its own", /marketSettingsPath\(/.test(sheet), false);
    check("but still draws the settings screen", /<PluginSettingsScreen/.test(sheet), true);
    check("handing it the machines the route names", /machines=\{route\.settings\}/.test(sheet), true);
    check("and the entry page draws no settings of its own", /PluginSettings/.test(entry), false);
    /* The way in is the bulk bar, and the entry page is what turns a selection into
       an address. */
    check("the bulk bar is the way into settings", /onConfigure/.test(installsSrcEarly), true);
    check("and the entry page is what makes it an address", /marketSettingsPath\(/.test(entry), true);
    /*
     * ⚠ **The import screen declines it, and the reason is measured.** That control
     * navigates the sheet, which unmounts `InstalledList` and drops the chosen
     * `File` — the same loss `onBusyChange` prevents one prop up, except this one is
     * not even gated on `busy`. Absent rather than disabled: a control that is never
     * usable there is one somebody keeps trying.
     */
    check("the import screen offers no way to walk away mid-upload", /onConfigure/.test(fleetSrcEarly), false);
    /*
     * ⚠ **An entry is drawn whether or not this instance has a catalogue, and the
     * sheet testing `base` first is what made `Offline` unreachable.** An instance
     * with no `REEMOAT_CP_PLUGIN_CATALOGUE_URL` is an ordinary deployment — the
     * file says so two comments away — and on it every plugin row in the settings
     * sheet and on the Installed tab opened the *market's* sentence, "there is
     * nothing to browse", about a plugin sitting on the person's own disk. Removal
     * across the fleet vanished with it, since that lives in `MachineInstalls`
     * inside `MarketEntry`.
     *
     * Both halves, because either alone is the bug: the sheet must hand a nullable
     * base straight to `MarketEntry`, and `MarketEntry` must answer a null one
     * with `Offline` rather than a spinner that never resolves — `useCatalogue`
     * answers `null` for ever on a null base by design.
     */
    /*
     * ⚠ **Pinned positively, because the interesting failure is not restoring the
     * old ternary.** Asserting the absence of `base === null ? <Empty>` is
     * satisfied by `base={base ?? ""}`, which is the *worse* form of the same
     * defect: `MarketEntry`'s null arm never fires, `useCatalogue` answers `null`
     * for ever on an empty base, and every catalogue-less instance gets an entry
     * screen that is a spinner which never resolves. So the base must reach the
     * component untouched.
     */
    check("the base reaches the entry untouched", /<MarketEntry state=\{state\} base=\{base\}/.test(stripComments(sheet)), true);
    check("and MarketEntry takes a nullable base", /base: string \| null;/.test(entry), true);
    /*
     * ⚠ **The market's own install closure must take and forward the signal.** It
     * took two parameters against a four-parameter `InstallAct` and TypeScript
     * accepted it — fewer parameters is assignable, silently — so the signal was
     * dropped here while `MachineInstalls` drew the Cancel that belongs to it.
     * Pressing it aborted controllers nothing listened to and the plugin landed on
     * every ticked machine anyway. Both halves: the closure names the parameter,
     * and the daemon call receives it.
     */
    check(
      "and its install closure forwards the cancellation signal",
      /const install: InstallAct = async \(daemon, machineId, _onProgress, signal\)/.test(stripComments(entry)) &&
        /installPluginFromSource\([\s\S]{0,220}\n\s*signal,\n\s*\);/.test(stripComments(entry)),
      true,
    );
    /*
     * And the method it calls actually has somewhere to put it — a route that
     * declines the parameter is the same defect one layer down, and `request`
     * already composes a caller's signal with its own deadline.
     */
    {
      const daemonSrc = stripComments(
        readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8"),
      );
      check(
        "and the source-install route accepts one",
        /installPluginFromSource\([\s\S]{0,320}signal\?: AbortSignal,[\s\S]{0,320}signal \}\),/.test(daemonSrc),
        true,
      );
    }
    /*
     * ⚠ **The sheet must consult the origin, not merely have one available.**
     * `market.ts`'s own assertions cover `marketUpFrom` as a pure function; they
     * say nothing about whether this file calls it, so reverting one import here
     * left the ◀ pointing at the market again with every pure check still green.
     */
    check("the sheet resolves its way up through the origin", /marketUpFrom\(route, origin\)/.test(stripComments(sheet)), true);
  /*
   * ⚠ **The settings sheet's box, string for string.** These two pop-ups are
   * siblings a tap apart: one opening as a heading with a pill and the other as a
   * rail beside a pane reads as two applications, and a 2px difference between the
   * rails reads as one of them being broken. Pinned as literals rather than as
   * "there is a rail", because a rail that measures differently is the failure.
   */
  {
    const bare = stripComments(sheet);
    const nav = stripComments(readFileSync(new URL("../src/ui/plugins/MarketNav.tsx", import.meta.url), "utf8"));
    const settingsNav = stripComments(
      readFileSync(new URL("../src/ui/settings/SettingsNav.tsx", import.meta.url), "utf8"),
    );
    check(
      "the market draws Settings' rail",
      /hidden w-56 shrink-0 overflow-y-auto overscroll-contain border-r border-edge sm:block/.test(bare),
      true,
    );
    check("and Settings' pane", /flex min-h-0 min-w-0 flex-1 flex-col/.test(bare), true);
    check(
      "and Settings' scroller",
      /min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5/.test(bare),
      true,
    );
    check("with the sheet body's padding cancelled once", /-mx-4 -my-5 flex min-h-0 flex-1 sm:-mx-5/.test(bare), true);
    /*
     * ⚠ `AppShell`'s standing rule: a resized window may not render a rail that is
     * not there, so the breakpoint is a class string and never a measurement.
     */
    check("and no breakpoint read in JavaScript", /matchMedia|innerWidth|clientWidth/.test(bare), false);
    /*
     * The phone keeps the strip, because this pop-up has no index depth for a list
     * to live at — and the chevron is withdrawn at `sm`+ exactly where the rail
     * already draws that row, which is the predicate `Settings.tsx` spells the same
     * way. Not `origin !== null`: an origin points at a screen this rail cannot
     * draw, and that chevron must survive at every width.
     */
    check("the phone keeps the strip", /sm:hidden/.test(bare) && /tabPill\(/.test(bare), true);
    check(
      "and the chevron is withdrawn where the rail draws the row",
      /withinNav \? "contents sm:hidden" : "contents"/.test(bare),
      true,
    );
    /*
     * ⚠ **And the plugin's name is not withdrawn with it.** The gate rode the whole
     * head row for one release, which took the identity off the desktop entirely:
     * the sheet says "Plugins", the rail says "Market", and the pane opened on a
     * description with nothing anywhere naming what it described. The rail makes the
     * way *back* redundant and says nothing about *which plugin*, so the two must be
     * gated separately — asserted by position, since the name has to fall outside
     * the gated span rather than merely exist.
     */
    {
      const gate = bare.indexOf("withinNav ?");
      const closes = bare.indexOf("</span>", gate);
      const named = bare.indexOf("{title}", closes);
      check("but the plugin's name is not", gate > 0 && closes > gate && named > closes, true);
      check("and the icon beside it is drawn at every width too", bare.indexOf("<MarketIcon") > closes, true);
    }
    /*
     * One table behind the strip and the rail, so they cannot drift in order or in
     * wording. ⚠ Matched on the **iteration** rather than on the name: the import
     * survives a hand-written array below it, and `/MARKET_TABS/` alone passed a
     * rail that listed its own two tabs inline.
     */
    check(
      "the strip and the rail are both drawn from one table",
      /MARKET_TABS\.filter\(/.test(bare) && /MARKET_TABS\.map\(/.test(nav),
      true,
    );
    /* One row shape behind both rails, and neither hand-rolls one. */
    check("both rails draw the same row", /<RailRow/.test(settingsNav) && /<RailRow/.test(nav), true);
    check(
      "and neither hand-rolls one",
      /min-h-11 w-full items-center gap-2 px-4 py-3\.5/.test(settingsNav + nav),
      false,
    );
  }
    check(
      "and answers a missing catalogue with the page a file-installed plugin gets",
      /if \(base === null\) \{[\s\S]{0,200}<Offline/.test(entry),
      true,
    );
  }
  {
    const consent = stripComments(readFileSync(new URL("../src/ui/PluginConsent.tsx", import.meta.url), "utf8"));
    /*
     * ⚠ **The permissions are behind the fold, not on it.** The closed line
     * carried a comma-separated summary of the scopes, which truncated mid-word in
     * the width it actually has — so the closed state disclosed two capabilities
     * out of four and hid the rest behind an ellipsis, while the control's own
     * label shared the row with them. A truncated permission list is worse than no
     * list, because it looks complete.
     *
     * ⚠ **The fold is `bits.tsx`'s now, so the closed line is a prop rather than a
     * `<button>` this file draws.** It was private here — and its own comment
     * claimed the grid animation existed *"so a fold in this app opens one way"*
     * while `MarketEntry` drew a native `<details>` about 200px further down **the
     * same screen**, with an instant snap and the platform's disclosure triangle.
     * A claim about how an app behaves cannot be kept by a function nobody outside
     * one file can reach, which is why it moved rather than being copied.
     *
     * The assertion follows it: a `label` that is a bare string cannot carry a
     * summary at all, which is a stronger form of what counting the closed line's
     * children used to check.
     */
    check(
      "the fold is the shared one rather than a private copy",
      [/<Disclosure\b/.test(consent), /function Disclosure/.test(consent)],
      [true, false],
    );
    check("and the closed line says only what the control is", /label="Permissions"/.test(consent), true);
    /*
     * ⚠ **What a plugin *adds* is an ask, and it has to be one or the card
     * contradicts itself.** `asksNothing` is derived from the rows' own `asks`
     * flag, so a plugin contributing only a harness would otherwise draw the
     * command line it will run and *"It asks for nothing, is told nothing and
     * reaches nowhere."* one line under it — which is the exact `net` defect this
     * file already records, arriving through a new door.
     *
     * ⚠ **And it is a *separate row* from the screens-and-menu-rows one below it,
     * which is `asks: false`.** Those are things this app draws on the plugin's
     * behalf and nothing is granted; these are a program the machine will run and a
     * host a key is sent to. Two lists, because one flag cannot be both.
     */
    check(
      "what a plugin adds to the machine is disclosed as an ask, in its own row",
      [
        /title: "It adds, to this machine",\s*asks: true,\s*items: manifest\.adds,/.test(consent),
        /title: "It adds",\s*asks: false,/.test(consent),
      ],
      [true, true],
    );
    /*
     * ⚠ **And `http` gets one extra sentence**, because it is the one thing in that
     * list a person cannot read off the address unless they already know what the
     * scheme means for a pasted key. The daemon permits it only to this machine or
     * this network; what it costs is that the key travels in the clear, and that is
     * the difference between a self-hosted model and a mistake.
     */
    check(
      "and a provider reached in the clear says so, tested on the line that is drawn",
      // The expression itself holds `//` inside a string literal and this file's
      // comment stripper eats a line from there on, so what is pinned is the
      // binding and the place it is drawn — which is the pair that matters anyway.
      [/const inTheClear = manifest\.adds\.some\(/.test(consent), /\{inTheClear && \(/.test(consent)],
      [true, true],
    );
    /*
     * ⚠ **On the `system ` lines only, and over all of them it was a false alarm.**
     * A harness line carries an argv, and an argv is arbitrary: a plugin
     * contributing **no providers** and one harness with
     * `args: ["--base", "http://127.0.0.1:8080"]` drew *"one provider is reached
     * over http"* on a card with no provider on it at all. The narrowing is the
     * assertion, because the sentence reads perfectly well either way.
     */
    check(
      "and it is a fact about a provider rather than about anything in an argv",
      /one\.startsWith\("system "\) &&/.test(consent),
      true,
    );
    /*
     * ⚠ **And there is one fold on this card**, which is what makes the placement
     * assertions below say anything: "above the fold" is satisfied by a sentence
     * parked inside a *second* fold sitting over the first.
     */
    check("and there is one fold for the sentence below to be above", (consent.match(/<Disclosure\b/g) ?? []).length, 1);
    /*
     * ⚠ **Both plugin screens, because the fold moved to end a disagreement
     * between them** rather than to tidy one file. `MarketEntry`'s `Earlier
     * versions` was the native `<details>`; a second one reappearing on either
     * screen restores exactly the state `Disclosure`'s docblock was written
     * against. Scoped to these two rather than swept over `src/ui`, since
     * `AgentsPanel`'s raw-transcript `<details>` is a deliberate survivor with its
     * own argument in `ui/login.ts`.
     */
    check(
      "and neither plugin screen falls back to the platform's fold",
      /<details/.test(consent + stripComments(readFileSync(new URL("../src/ui/plugins/MarketEntry.tsx", import.meta.url), "utf8"))),
      false,
    );
    /*
     * ⚠ **The card is chrome for an identification, and only the picker needs one.**
     * On the market's entry page the name, the version and the description are the
     * sheet's own head three lines up, so the border and its 24px of padding were
     * drawn around a single collapsed row reading `Permissions` — a region whose
     * contents are one word. Tied to `names`, which is already the flag for "this
     * block is the only thing that says what the plugin is".
     */
    check("the bordered card is drawn only where this block names the plugin", /names \? "mt-3 rounded-lg border border-edge p-3" : "mt-3"/.test(consent), true);
    /*
     * ⚠ **And the tap target went with the component instead of being lost in the
     * move.** `min-h-11` is on the fold because it opens the list of capabilities
     * somebody is about to grant a stranger's code, and this app is used from a
     * phone. It is asserted against `bits.tsx` now, where the class string lives: a
     * height that disappears in a refactor disappears silently, which is the same
     * quiet loss `aria-expanded` was nearly a victim of when `AskCard`'s collapse
     * became an `IconButton`.
     */
    check(
      "and the fold keeps its 44px, in the file it moved to",
      /className="tap flex min-h-11 w-full items-center gap-1\.5/.test(
        stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8")),
      ),
      true,
    );
    /*
     * ⚠ **The sentence naming the blast radius is OUTSIDE the fold and above it,
     * which reverses what this block asserted one release ago — and the reversal is
     * the finding rather than a change of mind.**
     *
     * It was pinned here as the fold's *last child*, on the reasoning that it is
     * the conclusion of the list and that outside it was a conclusion to nothing.
     * What that reasoning produced is why it moved: the fold mounted **closed**, so
     * the default render of every install path — the market entry, a machine's own
     * picker, the fleet-wide import — was a collapsed 13px row reading
     * `Permissions`, with live install controls under it and nothing on screen
     * saying what a plugin *is*. On the market entry that collapsed row was the
     * entire consent block. The one sentence naming what an install actually costs
     * — *a plugin runs on this machine as you, with your files* — sat behind the
     * same tap as the list it qualifies, and **nothing has ever gated Install on
     * that tap being taken**. It is not the conclusion of the list; it is the frame
     * around it, true whatever the manifest says.
     *
     * A placement is the one thing no type can hold, so it is pinned by position
     * off the source the way the strip-and-rail assertions above are.
     */
    const honest = consent.indexOf("A plugin runs on this machine as you");
    const opensFold = consent.indexOf("<Disclosure");
    check("the sentence about what a plugin really is exists", honest >= 0, true);
    check("and it is above the fold rather than behind it", honest >= 0 && opensFold > honest, true);
    /*
     * ⚠ **And the list itself is open on arrival on every install path.** The fold
     * is kept so the capabilities can be put *away*, never so they start out of
     * sight. `Disclosure` seeds its state once at mount, so this is a default
     * rather than a control and a fold somebody closes stays closed — which is why
     * the primitive's own default is `false` and correctly so, and why this is
     * asserted here instead: this is the one screen with an argument for the other
     * value. `first` is unconditional now for the same reason the caveat is: the
     * fold is never this block's first child any more.
     */
    check(
      "and the capabilities are open on arrival",
      /<Disclosure first=\{false\} label="Permissions" defaultOpen>/.test(consent),
      true,
    );
    /*
     * The http caveat at nine words, under the ten-word caveat cap (review D10):
     * it ran to nineteen, and `http` and "unencrypted" are the two words that
     * carry it, so both are asserted to survive whatever else is cut.
     */
    const clear = /<p className="mt-1 text-xs text-fg">\s*([^<]*http[^<]*)<\/p>/.exec(consent)?.[1]?.trim() ?? "";
    check("the http caveat names the protocol and the consequence", /\bhttp\b/.test(clear) && /unencrypted/.test(clear), true);
    check("in ten words or fewer", clear.length > 0 && clear.split(/\s+/).length <= 10, true);
  }
  {
    /*
     * Comments stripped before the search, because this file *argues* about the
     * element it must not contain — and a lock that its own docblock satisfies is
     * a lock that passes over the deleted code it was written to protect.
     */
    const view = readFileSync(new URL("../src/ui/PluginView.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    /*
     * ⚠ **A plugin's `select` is drawn with this app's own picker, never a native
     * `<select>`.** It was one, wearing the shared `FIELD` class — and a native
     * select keeps the platform's chrome unless *every* one of `appearance`, the
     * border, the radius and the arrow is overridden, so what shipped was a
     * system-drawn outline in a form of `edge-strong` boxes, opening a menu in the
     * operating system's colours. It read, in the screenshot that ended it, as a
     * stylesheet that had failed to load.
     *
     * Asserted as the absence of the element rather than the presence of
     * `Dropdown`: a second `<select>` added anywhere in this file is the same
     * regression, and only the absence catches it.
     */
    check("no plugin field is a native select", /<select[\s>]/.test(view), false);
    check("and the picker it uses is the app's own", /<Dropdown/.test(view), true);
  }
  {
    const menu = readFileSync(new URL("../src/ui/SessionMenu.tsx", import.meta.url), "utf8");
    /*
     * ⚠ **Stop is the last row of this menu at every install.** Plugin rows used
     * to sit *under* it, on a rule that read "never above Stop" — and what that
     * produced is the opposite of what it was protecting: the red row with no way
     * back stopped being last the moment anything was installed, and sat in the
     * middle of a list of somebody else's words. Above the separator, Stop is last
     * whatever is installed, which is a stronger version of the same property.
     */
    const offersAt = menu.indexOf("offers.map(");
    const stopAt = menu.indexOf('label="Stop"');
    check("a plugin's rows are drawn before Stop", offersAt >= 0 && stopAt > offersAt, true);
    /*
     * ⚠ **And the row cannot wrap.** `"Rename this session · Auto title"` in a
     * 208px panel wrapped to a second line, which made one row twice the height of
     * every other and moved Stop down by however long a plugin author's title
     * happened to be. Two elements, so the plugin's name gives way before the verb
     * does.
     */
    check("the action and the plugin's name are two elements", /note=\{offer\.plugin\.name\}/.test(menu), true);
    check("and both of them truncate", (menu.match(/truncate/g) ?? []).length >= 2, true);
  }

  /*
   * ⚠ **And the other half of the exemption above — a premise for a year, a
   * ratchet for a release, and a property now.**
   *
   * The history is the reason this block still exists, so it is written down
   * rather than deleted with the mechanism it produced. `ICON_BUTTON_SIZE` had
   * **four** entries and only three of them reached the platform minimum: `sm` is
   * 24px of ink with `after:-inset-2.5` around it (24 + 20 = 44), `chip` is 32px
   * with `TAP_GROW_Y`, and `lg` is `h-11`, which is the 44px itself. The fourth
   * was `md` — `h-9 w-9`, 36px, with no growth mechanism of any kind — and `md`
   * was the **default**. So "routed through the primitive" was never the same
   * thing as "44px", and the call site that thought about its target least got the
   * one size that was wrong. The sweep that stood here before skipped every
   * `IconButton` call site on precisely the premise that disproves.
   *
   * The ratchet that replaced the premise named four call sites drawn at that
   * default — `Header`'s back chevron, `SessionMenu`'s kebab, `Sheet`'s ✕ and
   * `AgentsPanel`'s credential ✕ — recorded rather than fixed, on the stated
   * grounds that *"fixing them is a decision about the interface and not about
   * this driver"*. **The decision was taken.** All four name a size now and no two
   * of them by the same argument; `md` is *deleted* rather than resized, because
   * widening it to `h-11` would have moved every layout that had settled around a
   * 36px box; and `size` lost its default, so omitting it no longer compiles. The
   * list is gone because it is empty — a ratchet with nothing on it asserts a
   * property that already holds and reads as a debt that is still owed.
   *
   * ⚠ **What the compiler covers now, and what it still cannot see.** `size` is
   * required and typed `keyof typeof ICON_BUTTON_SIZE`, so `tsc` is what refuses a
   * call site with no size and a call site naming one that does not exist. The
   * regex that used to do both is redundant *over call sites*, and it is
   * deliberately not kept as a second opinion: a scan that agrees with the type
   * system in every case teaches the next reader that the scan is what holds the
   * floor, which is exactly how the old premise survived for a year.
   *
   * Three things are left that no type can hold, and they are what is below.
   *
   *   - **The table.** Three string literals whose 44px is a fact about CSS. A
   *     value edited to `h-9 w-9` under any of those three names typechecks
   *     perfectly and puts every call site in the app under the floor at once.
   *   - **The absence of a default**, which is what makes the compiler's half true
   *     at all. Restore `size = "lg"` and every future call site is silently
   *     unreviewed again, with nothing failing anywhere.
   *   - **`className` at a call site**, which can take the size back. The
   *     primitive interpolates the caller's string *after* its own and that buys
   *     nothing: every utility lands in one stylesheet at equal specificity, so
   *     what wins is the order **in the sheet** rather than the order in the
   *     attribute — and the call site cannot read that order.
   *
   *     ⚠ **This said "Tailwind v4 emits alphabetically, so `.h-11` is written to
   *     the sheet **before** `.h-9` and a caller's `h-9` wins over `lg`", and both
   *     halves of that are backwards.** Measured on the shipped bundle,
   *     `packages/web/dist/assets/index-*.css`: `.h-9` is emitted at byte 14077 and
   *     `.h-11` at 14153, so on that pair the *primitive* wins and a caller's
   *     smaller box is the one that loses. "Alphabetical" holds for a **word**
   *     scale — `.items-center` before `.items-start`, which is the trap `FIELD`
   *     and `menuRow` document and which is why the shorthand was believed — while
   *     a **numeric** scale is emitted in numeric order, so it predicts the wrong
   *     winner exactly where two numbers straddle ten, which is where every
   *     tap-target argument in this repository lives. `BUTTON_SIZE`'s docblock in
   *     `bits.tsx` now carries that measurement in full, and is the copy to read.
   *
   *     **The sweep below is unchanged by the correction, because the property was
   *     never "the caller wins".** It is that which one wins is decided somewhere
   *     the call site cannot see: `h-14` against `lg` takes the size back in the
   *     direction the numbers happen to allow, and a variant-prefixed height wins
   *     from a block whose position has nothing to do with either number. So no
   *     call site may pass a height or a width at all.
   */
  const bitsCode = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
  const tableAt = bitsCode.indexOf("const ICON_BUTTON_SIZE");
  const sizeTable = bitsCode.slice(tableAt, bitsCode.indexOf("} as const;", tableAt));
  /*
   * Every entry, as a name and the class string it resolves to. The two spellings
   * are both real — `sm` and `lg` are plain strings, `chip` is a template holding
   * `${TAP_GROW_Y}` — and a fourth entry added in either shape is read the same
   * way rather than skipped for not looking like its neighbours.
   */
  const sizes = [...sizeTable.matchAll(/^ {2}(\w+): (?:"([^"]*)"|`([^`]*)`),$/gm)].map(
    (entry) => [entry[1] ?? "", entry[2] ?? entry[3] ?? ""] as const,
  );
  check("the size table was found and has entries in it", sizes.length >= 3, true);
  /*
   * The three mechanisms, spelled once. `sm` grows a transparent `::after` by 10px
   * a side, `chip` grows vertically only through the shared `TAP_GROW_Y` — a
   * symmetric inset would put its target on the mode chip's *face*, and the chip
   * beside it changes the model — and `lg` simply is 44px. A size that reaches the
   * floor some fourth way has to say so here, which is the point: the assertion is
   * that the table *states* how, not that it happens to.
   */
  const NAMES_ITS_44 = /after:-inset-2\.5|\$\{TAP_GROW_Y\}|\bh-11\b/;
  check(
    "and every size a caller can name says how it reaches 44px",
    sizes.filter(([, classes]) => !NAMES_ITS_44.test(classes)).map(([name]) => name),
    [],
  );
  /*
   * ⚠ **And 36px has not come back under a name a reader trusts.** `md` is gone
   * for good rather than resized: a size that reappears under the name somebody
   * remembers as 36px is worse than no size at all, and `h-9 w-9` under any other
   * name is the same defect with the evidence removed.
   */
  check(
    "and the one that never reached it is gone rather than renamed",
    [sizes.some(([name]) => name === "md"), /h-9 w-9/.test(sizeTable)],
    [false, false],
  );

  const iconButtonAt = bitsCode.indexOf("export function IconButton");
  const iconButtonArgs = bitsCode.slice(iconButtonAt, bitsCode.indexOf("}: {", iconButtonAt));
  const iconButtonProps = bitsCode.slice(bitsCode.indexOf("}: {", iconButtonAt), bitsCode.indexOf("}): ReactNode {", iconButtonAt));
  check(
    "the primitive's own signature and prop list were found",
    [/\bsize\b/.test(iconButtonArgs), iconButtonProps.length > 0],
    [true, true],
  );
  /*
   * ⚠ **This is the assertion that hands the floor to the compiler**, and it is
   * the one worth the most: `size` with no default is why every call site in
   * `src/ui` is now type-checked against the table above, and restoring one would
   * un-assert the whole app in a single character with nothing else failing. Both
   * halves — no default in the destructuring, and not optional in the type — since
   * either alone lets a caller through.
   *
   * Anchored to the start of a line, because the props list opens with
   * `icon: ComponentType<{ size?: number | string; … }>` — the *glyph's* own size,
   * which an unanchored `/size\?:/` reads as this one being optional and which is
   * how the first draft of this check passed while asserting the opposite.
   */
  check("and `size` has no default, which is what makes the type check mean anything", /size = /.test(iconButtonArgs), false);
  check("nor is it optional", /^\s*size\?:/m.test(iconButtonProps), false);
  /*
   * And the type is read off the table rather than spelled a second time, so the
   * two cannot drift: a hand-written `"sm" | "chip" | "lg" | "md"` would typecheck
   * against a table that no longer has the fourth entry only until somebody puts
   * one back.
   */
  check("and the union it accepts is the table itself", /^\s*size: keyof typeof ICON_BUTTON_SIZE;$/m.test(iconButtonProps), true);

  /*
   * The call sites, swept for the one thing the compiler cannot read: a
   * `className` that takes the size back. Every one of them today passes margins
   * and nothing else, which is what this is here to keep true.
   *
   * A size handed down as a *prop* (`size={size}`) is no longer reported and that
   * is the change: it used to be, on the correct grounds that a source sweep
   * cannot resolve it and that the component holding it had a default of its own.
   * The component holding it is now typed against the same table, and every value
   * in the table clears the floor — so resolving it buys nothing a type has not
   * already proved.
   */
  /*
   * Every geometry utility a caller could reach for, variant prefixes included —
   * `sm:h-9` is the same defect wearing a breakpoint, and a pattern anchored only
   * to the start of a class would miss it. Margins are deliberately not matched:
   * `-ml-1` and `ml-1` are what these call sites actually pass, and pulling a
   * control 4px into a head row is nobody's business but the caller's.
   */
  const HEIGHT_OR_WIDTH = /(?:^|\s)(?:[a-z-]+:)*-?(?:min-|max-)?[hw]-/;
  const iconButtons: string[] = [];
  const resized: string[] = [];
  const sweepIconButtons = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        sweepIconButtons(child);
        continue;
      }
      if (!/\.tsx$/.test(entry.name)) continue;
      // Comments out first, for the reason every source-text pin here gives: the
      // docblocks around these call sites quote `h-9 w-9` while arguing about it.
      const text = stripComments(readFileSync(child, "utf8"));
      for (const call of text.matchAll(/<IconButton\b[\s\S]*?\/>/g)) {
        const where = `${entry.name}: ${call[0].replace(/\s+/g, " ").slice(0, 72)}`;
        iconButtons.push(where);
        const classes = /className=(?:"([^"]*)"|\{`([^`]*)`)/.exec(call[0]);
        if (classes !== null && HEIGHT_OR_WIDTH.test(classes[1] ?? classes[2] ?? "")) resized.push(where);
      }
    }
  };
  sweepIconButtons(new URL("../src/ui/", import.meta.url));
  // A pattern that matches nothing passes silently, which is this driver's one
  // failure mode. The count is a floor rather than a number so that adding a
  // control does not fail a check about class strings.
  check("the sweep found the primitive's call sites", iconButtons.length >= 20, true);
  check("and no call site takes its size back through className", resized, []);

  /*
   * ⚠ **And the controls that never reach the primitive at all, which every sweep
   * above is blind to by construction.**
   *
   * They matched `<IconButton …/>`, so a control written as a raw `<button>` with
   * a hand-rolled class string was invisible however small it was — and four were,
   * spelling out the same `h-9 w-9` that `md` drew, arrived at independently four
   * times. One of them was `SessionBrowser`'s bell, the control that answers this
   * product's central question: *which agent is waiting for me*. They are all
   * `IconButton` now, and the finding is that nothing said so: the ratchet
   * retired above stayed green for the entire time they were on screen, because
   * they were never call sites.
   *
   * **A source sweep is the only thing that can catch this.** There is no type to
   * check — a tap target is a string of Tailwind utilities, and `h-9 w-9` and
   * `h-11 w-11` are the same type — the primitive cannot see a control that never
   * called it, and nothing in this repository renders these files. What is left is
   * reading the class attribute off disk, which is what every placement assertion
   * in this driver already does.
   *
   * The rule is the **floor** rather than the routing, because a small box is not
   * the defect: `sm` itself is `h-6 w-6`. A small box with nothing around it is.
   * `Toast`'s dismiss is the one hand-rolled square that legitimately stays one —
   * 24px of ink with the same transparent `after:-inset-2.5`, because a toast has
   * to stay a thin strip over the composer and its target cannot be bought with
   * layout — and it is what proves this scan reaches real controls rather than
   * counting zero of them.
   */
  const SQUARE = /\bh-(\d+)\b[^"`]*?\bw-\1\b/;
  const GROWS_TO_44 = /after:-inset-2\.5|TAP_GROW_Y|min-h-11/;
  /*
   * ⚠ **This sweep found one control the first time it was run, and it has since
   * been fixed — so what stands here is the sweep and not a list.**
   *
   * `SessionBrowser`'s per-folder `+` (*New session in <folder>*) was `h-7 w-7`:
   * 28px, in a folder header whose own row is `min-h-9`, with no growth mechanism
   * of any kind. It was never one of the four `h-9 w-9` copies, which is why no
   * scan of any earlier shape reached it, and it is always visible on a coarse
   * pointer — so on the phone this app is used from it was a 28px target.
   *
   * It was briefly recorded rather than fixed, on the reasoning the retired
   * `md` list gave: that the remedy was a decision about that header rather than
   * about this driver, and that neither remedy was free — growing the box makes
   * the folder row taller than every session row beneath it, and growing the
   * target symmetrically spends 10px a side onto the face of the folder's own
   * collapse `<button>` immediately to its left, which is the adjacency
   * `ICON_BUTTON_SIZE.chip` exists to describe. Both are true, and both were
   * arguments against the two remedies that were considered rather than against
   * fixing it: `chip` is a 32px box that fits `min-h-9` unchanged, grown to 44px
   * by `TAP_GROW_Y`, which is vertical only and so spends nothing horizontally.
   * The control is on the primitive at that size now and no list survives it.
   *
   * The sweep stays, and it is the half of this section with a future: it reads
   * `<button>` rather than `<IconButton>`, so it is the only thing here that can
   * see a control which never went near the primitive at all.
   */
  const handRolled: string[] = [];
  let plainButtons = 0;
  let squares = 0;
  const sweepPlainButtons = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        sweepPlainButtons(child);
        continue;
      }
      if (!/\.tsx$/.test(entry.name)) continue;
      const text = stripComments(readFileSync(child, "utf8"));
      /*
       * Brace and paren depth to find the tag's own `>`, the way the plugin
       * `size="sm"` sweep further up already does: an arrow function in `onClick`
       * puts a `>` inside the props that a lazy regex or a line scan stops at, and
       * these files are full of them.
       */
      for (const piece of text.split(/<(?=button\b)/).slice(1)) {
        let depth = 0;
        let end = -1;
        for (let i = 0; i < piece.length; i += 1) {
          const ch = piece.charAt(i);
          if (ch === "{" || ch === "(") depth += 1;
          else if (ch === "}" || ch === ")") depth -= 1;
          else if (ch === ">" && depth === 0) {
            end = i;
            break;
          }
        }
        if (end < 0) continue;
        plainButtons += 1;
        const props = piece.slice(0, end);
        const square = SQUARE.exec(props);
        // Tailwind's scale is 0.25rem a step, so `h-11` is the 44px itself and
        // anything below it has to say how it gets there.
        if (square === null || Number(square[1]) >= 11) continue;
        squares += 1;
        if (!GROWS_TO_44.test(props)) handRolled.push(`${entry.name}: h-${square[1]} w-${square[1]}`);
      }
    }
  };
  sweepPlainButtons(new URL("../src/ui/", import.meta.url));
  check("the button sweep reached the whole surface", [plainButtons >= 40, squares >= 1], [true, true]);
  check("nothing hand-rolls a square target under 44px", handRolled, []);
}
