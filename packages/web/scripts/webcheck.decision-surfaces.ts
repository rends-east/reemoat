import { readFileSync, readdirSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nthe decision surfaces, at the platform tap minimum\n");
{
  // Scoped to the decision cards, where a mis-tap answers the agent; IconButton sizes are asserted below.
  const DECISION_CARDS = ["AskCard.tsx", "PermissionCard.tsx", "ElicitationCard.tsx"];
  const REACHES_44 = /min-h-11|min-h-14|min-h-16|\bh-11\b|menuRow|TAP_GROW_Y/;
  // The template arm stops at the first backtick: every interpolation on these cards is a ternary over double-quoted strings.
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

  check("the scan actually found the controls", scanned >= 6, true);
  check("nothing a person taps to answer an agent is under 44px", short, []);

  // Plugin surfaces carry irreversible controls drawn by plugin authors.
  // The size="sm" sweep tracks brace depth to find the tag's `>`, since an arrow in onClick puts one inside the props.
  const PLUGIN_SURFACE: readonly (readonly [string, URL])[] = [
    ["PluginView.tsx", new URL("../src/ui/PluginView.tsx", import.meta.url)],
    ["PluginsPanel.tsx", new URL("../src/ui/settings/PluginsPanel.tsx", import.meta.url)],
  ];
  // `sm` keeps desktop density; the coarse-pointer media query restores the 44px floor.
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
      // `LINK` is excluded: it is a link inside running text, not a control.
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

  // A floor, not the count: a new control is not a failure, but a sweep that matches nothing must be (Q3.552).
  check("the plugin sweep actually found the controls", [tapped >= 1, small >= 5], [true, true]);
  check("nothing on a plugin's own surface is under 44px", shortPlugin, []);
  check("and every small control there keeps the coarse-pointer floor", bareSmall, []);

  // The floor lives in bits.tsx's BUTTON_SIZE, read with comments stripped.
  {
    const tableSrc = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
    const buttonAt = tableSrc.indexOf("const BUTTON_SIZE = {");
    const buttonSizes = [
      ...tableSrc.slice(buttonAt, tableSrc.indexOf("} as const;", buttonAt)).matchAll(/^ {2}(\w+): "([^"]*)",$/gm),
    ].map((entry) => [entry[1] ?? "", entry[2] ?? ""] as const);
    check("the button size table was found and has entries in it", [buttonAt >= 0, buttonSizes.length >= 2], [true, true]);
    check(
      "and every size a caller can name reaches 44px under a finger",
      buttonSizes.filter(([, classes]) => !/\bmin-h-11\b/.test(classes)).map(([name]) => name),
      [],
    );
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

  const bitsSrc = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  // Only the leading literal run: the template's second interpolation nests another template.
  const choiceRowClasses = /className=\{`(tap press flex[^`$]*)\$\{/.exec(
    bitsSrc.slice(bitsSrc.indexOf("export function ChoiceRow")),
  )?.[1] ?? "";
  check("the primitive's own class string was found", choiceRowClasses.length > 0, true);
  check("and the row a model is chosen on clears the tap minimum", REACHES_44.test(choiceRowClasses), true);

  const startSrc = readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8");
  const shortStart: string[] = [];
  let aimed = 0;
  for (const match of startSrc.matchAll(CLASS_ATTR)) {
    const classes = match[1] ?? match[2] ?? "";
    if (!/\btap\b|\bpress\b/.test(classes)) continue;
    aimed += 1;
    if (!REACHES_44.test(classes)) shortStart.push(classes.slice(0, 60));
  }
  // Exact on purpose: a lower count must be checked against where the act moved (Q3.640).
  check("the new-session sweep actually found the screen's controls", aimed, 8);
  check("and every one of them clears 44px", shortStart, []);

  {
    // Comments stripped so a docblock quoting a removed row cannot satisfy or fail these checks.
    const panel = stripComments(readFileSync(new URL("../src/ui/settings/PluginsPanel.tsx", import.meta.url), "utf8"));
    const wanted = ['label="Open"', 'label="Remove"', "danger", "<Menu", "IconButton"];
    // Comments stripped: the docblock over the note quotes the cut sentence.
    const consent = readFileSync(new URL("../src/ui/PluginConsent.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    check("the archive note no longer promises what the consent wall shows", consent.includes("Nothing is sent until"), false);
    check("and says re-installing keeps data", consent.includes("Re-installing keeps stored data."), true);
    check(
      "a machine's plugin row keeps every act, behind one kebab",
      wanted.filter((needle) => !panel.includes(needle)),
      [],
    );
    check("and offers no settings of its own", panel.includes('label="Settings"'), false);
    check("Open stays in the menu while the plugin is off, disabled", /label="Open"\s*disabled=\{!plugin\.enabled\}/.test(panel), true);
    // The remove pair is TwoStep's (Q3.552); its Cancel order and tone are pinned in webcheck.settings-routing.ts.
    const confirmStart = panel.indexOf("and its data?");
    check("the remove question names the plugin", confirmStart >= 0 && /Remove <span[^>]*>\{plugin\.name\}<\/span> and its data\?/.test(panel), true);
    const confirmBox = confirmStart >= 0 ? panel.lastIndexOf("<TwoStep", confirmStart) : -1;
    // Close at a `/>` on its own line: a fragment inside `question` carries a `/>` too.
    const confirmGroup = confirmBox >= 0 ? panel.slice(confirmBox, confirmStart + panel.slice(confirmStart).search(/^\s*\/>/m)) : "";
    check("and the pair is the primitive's, with the act destructive", /act=\{\{ label: "Remove", danger: true, icon: Trash2 \}\}/.test(confirmGroup), true);
    check("and the row draws no Cancel of its own beside it", /setConfirming\(false\)/.test(panel), false);
    check("and Cancel wears the default tone", /tone="primary"[^>]*>\s*Cancel|<Button[^>]*tone="primary"[\s\S]{0,120}Cancel/.test(panel), false);
    check("and the confirmation stands in for the row's controls rather than under them", /\{confirming \? \(\s*<TwoStep\b/.test(panel), true);
    check("and the row itself opens the plugin", /marketEntryPath\(plugin\.id\)/.test(panel), true);
    check("and does not restate every permission on it", panel.includes("PLUGIN_SCOPE_TEXT"), false);
    check(
      "including the switch, whose label depends on which way it is",
      /label=\{plugin\.enabled \? "Switch off" : "Switch on"\}/.test(panel),
      true,
    );
  }

  {
    const sheet = readFileSync(new URL("../src/ui/plugins/PluginsSheet.tsx", import.meta.url), "utf8");
    const entry = readFileSync(new URL("../src/ui/plugins/MarketEntry.tsx", import.meta.url), "utf8");
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
    check("the bulk bar is the way into settings", /onConfigure/.test(installsSrcEarly), true);
    check("and the entry page is what makes it an address", /marketSettingsPath\(/.test(entry), true);
    check("the import screen offers no way to walk away mid-upload", /onConfigure/.test(fleetSrcEarly), false);
    // The base must reach MarketEntry untouched: `base ?? ""` would leave a catalogue-less instance on an endless spinner.
    check("the base reaches the entry untouched", /<MarketEntry state=\{state\} base=\{base\}/.test(stripComments(sheet)), true);
    check("and MarketEntry takes a nullable base", /base: string \| null;/.test(entry), true);
    // Fewer parameters is assignable in TypeScript, so a closure dropping `signal` would still compile.
    check(
      "and its install closure forwards the cancellation signal",
      /const install: InstallAct = async \(daemon, machineId, _onProgress, signal\)/.test(stripComments(entry)) &&
        /installPluginFromSource\([\s\S]{0,220}\n\s*signal,\n\s*\);/.test(stripComments(entry)),
      true,
    );
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
    check("the sheet resolves its way up through the origin", /marketUpFrom\(route, origin\)/.test(stripComments(sheet)), true);
  // The market's rail and scroller must be Settings.tsx's strings verbatim (Q3.553).
  {
    const bare = stripComments(sheet);
    const settingsSrc = stripComments(
      readFileSync(new URL("../src/ui/settings/Settings.tsx", import.meta.url), "utf8"),
    );
    const nav = stripComments(readFileSync(new URL("../src/ui/plugins/MarketNav.tsx", import.meta.url), "utf8"));
    const settingsNav = stripComments(
      readFileSync(new URL("../src/ui/settings/SettingsNav.tsx", import.meta.url), "utf8"),
    );
    const rail = /className="(hidden w-56 shrink-0 [^"]*)"/.exec(settingsSrc)?.[1] ?? null;
    check(
      "Settings draws a rail that scrolls and draws no bar",
      rail,
      "hidden w-56 shrink-0 overflow-y-auto overscroll-contain no-scrollbar border-r border-edge sm:block",
    );
    check("and the market draws the same one", rail !== null && bare.includes(`className="${rail}"`), true);
    check("and Settings' pane", /flex min-h-0 min-w-0 flex-1 flex-col/.test(bare), true);
    const scroller = /const paneScroll = `([^`$]+)\$\{\s*active === null \? "([^"]+)" : "([^"]+)"\s*\}`/.exec(
      settingsSrc,
    );
    check(
      "Settings' scroller pads by arm, flush on the phone's index and nowhere else",
      scroller === null ? null : [scroller[1], scroller[2], scroller[3]],
      ["min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain no-scrollbar ", "sm:px-5 sm:py-4", "px-4 py-4 sm:px-5"],
    );
    const market = /const paneScroll = `([^`$]+)\$\{\s*settingsScreen \? "([^"]*)" : "([^"]+)"\s*\}`/.exec(bare);
    check(
      "and the market draws the same base and section arm, with its settings screen flush",
      market === null || scroller === null ? null : [market[1] === scroller[1], market[2], market[3] === scroller[3]],
      [true, "", true],
    );
    const pluginSettings = stripComments(
      readFileSync(new URL("../src/ui/plugins/PluginSettings.tsx", import.meta.url), "utf8"),
    );
    check(
      "whose sticky bar reaches the edges without a negative margin",
      scroller !== null &&
        /className="sticky top-0 z-10 border-b border-edge bg-surface px-4 py-2 text-xs sm:px-5"/.test(pluginSettings) &&
        pluginSettings.includes(`const PANE_PAD = "${scroller[3]}";`),
      true,
    );
    check(
      "and no file here cancels a padding the box outside it no longer has",
      [/-m[xyt]-/.test(settingsSrc), /-m[xyt]-/.test(bare), /-m[xyt]-/.test(pluginSettings)],
      [false, false, false],
    );
    check("and no breakpoint read in JavaScript", /matchMedia|innerWidth|clientWidth/.test(bare), false);
    // Not `origin !== null`: an origin's chevron must survive at every width.
    check("the phone keeps the strip", /sm:hidden/.test(bare) && /tabPill\(/.test(bare), true);
    check(
      "and the chevron is withdrawn where the rail draws the row",
      /withinNav \? "contents sm:hidden" : "contents"/.test(bare),
      true,
    );
    {
      const gate = bare.indexOf("withinNav ?");
      const closes = bare.indexOf("</span>", gate);
      const named = bare.indexOf("{title}", closes);
      check("but the plugin's name is not", gate > 0 && closes > gate && named > closes, true);
      check("and the icon beside it is drawn at every width too", bare.indexOf("<MarketIcon") > closes, true);
    }
    // Matched on the iteration, not the name: an import survives a hand-written array.
    check(
      "the strip and the rail are both drawn from one table",
      /MARKET_TABS\.filter\(/.test(bare) && /MARKET_TABS\.map\(/.test(nav),
      true,
    );
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
    check(
      "the fold is the shared one rather than a private copy",
      [/<Disclosure\b/.test(consent), /function Disclosure/.test(consent)],
      [true, false],
    );
    check("and the closed line says only what the control is", /label="Permissions"/.test(consent), true);
    check(
      "what a plugin adds to the machine is disclosed as an ask, in its own row",
      [
        /title: "It adds, to this machine",\s*asks: true,\s*items: manifest\.adds,/.test(consent),
        /title: "It adds",\s*asks: false,/.test(consent),
      ],
      [true, true],
    );
    check(
      "and a provider reached in the clear says so, tested on the line that is drawn",
      // This file's comment stripper eats a line from the `//` inside the expression's string, so only the binding and its use are pinned.
      [/const inTheClear = manifest\.adds\.some\(/.test(consent), /\{inTheClear && \(/.test(consent)],
      [true, true],
    );
    check(
      "and it is a fact about a provider rather than about anything in an argv",
      /one\.startsWith\("system "\) &&/.test(consent),
      true,
    );
    check("and there is one fold for the sentence below to be above", (consent.match(/<Disclosure\b/g) ?? []).length, 1);
    // Scoped to the two plugin screens: AgentsPanel's raw-transcript `<details>` is a deliberate survivor.
    check(
      "and neither plugin screen falls back to the platform's fold",
      /<details/.test(consent + stripComments(readFileSync(new URL("../src/ui/plugins/MarketEntry.tsx", import.meta.url), "utf8"))),
      false,
    );
    check("the bordered card is drawn only where this block names the plugin", /names \? "mt-3 rounded-lg border border-edge p-3" : "mt-3"/.test(consent), true);
    // The fold carries no 44px floor by the owner's call: the floor is for controls that answer an agent.
    const bitsFold = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
    check(
      "and the fold is the height of its words, with the disclosure itself intact",
      [
        /className="tap flex w-full items-center gap-1\.5 text-left text-xs/.test(bitsFold),
        /className="tap flex min-h-11 w-full items-center gap-1\.5/.test(bitsFold),
        /aria-expanded=\{open\}/.test(bitsFold),
      ],
      [true, false, true],
    );
    const honest = consent.indexOf("A plugin runs on this machine as you");
    const opensFold = consent.indexOf("<Disclosure");
    check("the sentence about what a plugin really is exists", honest >= 0, true);
    check("and it is above the fold rather than behind it", honest >= 0 && opensFold > honest, true);
    // Open on arrival on this screen only; Disclosure's own default stays `false`.
    check(
      "and the capabilities are open on arrival",
      /<Disclosure first=\{false\} label="Permissions" defaultOpen>/.test(consent),
      true,
    );
    const clear = /<p className="mt-1 text-xs text-fg">\s*([^<]*http[^<]*)<\/p>/.exec(consent)?.[1]?.trim() ?? "";
    check("the http caveat names the protocol and the consequence", /\bhttp\b/.test(clear) && /unencrypted/.test(clear), true);
    check("in ten words or fewer", clear.length > 0 && clear.split(/\s+/).length <= 10, true);
  }
  {
    // Comments stripped: this file's docblock argues about the element it must not contain.
    const view = readFileSync(new URL("../src/ui/PluginView.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    check("no plugin field is a native select", /<select[\s>]/.test(view), false);
    check("and the picker it uses is the app's own", /<Dropdown/.test(view), true);
  }
  {
    const menu = readFileSync(new URL("../src/ui/SessionMenu.tsx", import.meta.url), "utf8");
    const offersAt = menu.indexOf("offers.map(");
    const stopAt = menu.indexOf('label="Stop"');
    check("a plugin's rows are drawn before Stop", offersAt >= 0 && stopAt > offersAt, true);
    check("the action and the plugin's name are two elements", /note=\{offer\.plugin\.name\}/.test(menu), true);
    check("and both of them truncate", (menu.match(/truncate/g) ?? []).length >= 2, true);

    // A parked session satisfies canResume by default, so the missing Resume is asserted through the `!isParked(` guard.
    const decides = menu.slice(menu.indexOf("const canResume"), menu.indexOf("const pinned"));
    check("a released session is not offered a Resume it does not need", /!isParked\(/.test(decides), true);
    check("and the guard is on the row that draws it", /canResume/.test(menu.slice(menu.indexOf('label="Resume"') - 400, menu.indexOf('label="Resume"'))), true);

    const stopGuard = menu.slice(menu.indexOf('label="Stop"') - 700, menu.indexOf('label="Stop"'));
    check("a released session can still be ended", /isParked\(session\)\)? &&/.test(stopGuard) || /\|\| isParked\(session\)/.test(stopGuard), true);
  }
  {
    // The screen must never say "park": the word names a mechanism the reader cannot see.
    const section = readFileSync(new URL("../src/ui/settings/MachineSection.tsx", import.meta.url), "utf8");
    const drawn = stripComments(section);
    const sentence = /A conversation left untouched this long[^<]*/.exec(drawn)?.[0]?.trim() ?? "";
    check("the idle setting explains itself in one sentence", sentence.length > 0 && sentence.split(".").filter((part) => part.trim().length > 0).length === 1, true);
    // Asserted over the whole stripped screen, not the extracted sentence, which would pass vacuously once reworded.
    check("without naming the mechanism, anywhere a reader could see it", /park/i.test(drawn), false);
    check("saying what happens and that nothing is lost", [
      /shut down/i.test(sentence),
      /where you left off/i.test(sentence),
    ], [true, true]);
    const headings = [...drawn.matchAll(/SETTINGS_HEADING\}>([^<]*)</g)].map((match) => match[1] ?? "");
    check("the screen has a heading for it", headings.includes("Idle sessions"), true);
    check("and no heading on it names the mechanism", headings.filter((heading) => /park/i.test(heading)), []);
  }

  // IconButton's `size` is required and typed against ICON_BUTTON_SIZE, so tsc covers call sites.
  // No type holds the rest, asserted below: the table's classes, the absent default, and a call-site className.
  const bitsCode = stripComments(readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8"));
  const tableAt = bitsCode.indexOf("const ICON_BUTTON_SIZE");
  const sizeTable = bitsCode.slice(tableAt, bitsCode.indexOf("} as const;", tableAt));
  // `chip` is a template holding `${TAP_GROW_Y}`, so both spellings of an entry are read.
  const sizes = [...sizeTable.matchAll(/^ {2}(\w+): (?:"([^"]*)"|`([^`]*)`),$/gm)].map(
    (entry) => [entry[1] ?? "", entry[2] ?? entry[3] ?? ""] as const,
  );
  check("the size table was found and has entries in it", sizes.length >= 3, true);
  // Each size must state how it reaches 44px: `sm`/`nav` by a coarse-pointer `::after` inset, `chip` by TAP_GROW_Y, `lg` by `h-11`.
  const COARSE = String.raw`\[@media\(pointer:coarse\)\]:`;
  const NAMES_ITS_44 = new RegExp(
    `${COARSE}after:-inset-2\\.5|${COARSE}after:-inset-1\\.5|\\$\\{TAP_GROW_Y\\}|\\bh-11\\b`,
  );
  check(
    "and every size a caller can name says how it reaches 44px under a finger",
    sizes.filter(([, classes]) => !NAMES_ITS_44.test(classes)).map(([name]) => name),
    [],
  );
  // Anchored on the coarse-pointer prefix, not the inset, so an ungated pad (which leaks `:hover`) cannot pass (Q5.114).
  const UNGATED_PAD = /(?<!\]:)after:(?:absolute|-inset-|-top-|-bottom-|inset-x-|top-|content-)/;
  check(
    "and neither of them grows on a pointer that hovers",
    sizes.filter(([, classes]) => UNGATED_PAD.test(classes)).map(([name]) => name),
    [],
  );
  // Keyed on the literal `COARSE` gate: any other arbitrary variant, such as `pointer:fine`, would pass a shape check.
  const growAt = bitsCode.indexOf("export const TAP_GROW_Y");
  const growValue = bitsCode.slice(growAt, bitsCode.indexOf(";", growAt));
  check("the shared vertical grow was found", growValue.includes("after:"), true);
  check(
    "and every class in it is gated on a coarse pointer too",
    growValue
      .split(/\s+/)
      .filter((token) => token.includes("after:") && !token.includes("[@media(pointer:coarse)]:after:")),
    [],
  );
  const glyphAt = bitsCode.indexOf("const ICON_BUTTON_GLYPH");
  const glyphTable = bitsCode.slice(glyphAt, bitsCode.indexOf("};", glyphAt));
  const glyphs = new Map(
    [...glyphTable.matchAll(/^ {2}(\w+): (\d+),$/gm)].map((entry) => [entry[1] ?? "", Number(entry[2] ?? 0)]),
  );
  check("the glyph table was found", glyphs.size > 0, true);
  check(
    "and every size a caller can name has a glyph chosen rather than fallen through to",
    sizes.map(([name]) => name).filter((name) => !glyphs.has(name)),
    [],
  );
  check("keyed on the size table, so the compiler refuses an unglyphed one", /Record<keyof typeof ICON_BUTTON_SIZE, number>/.test(bitsCode), true);
  check("and the chain that answered for names nobody wrote is gone", /size === "sm" \? 12/.test(bitsCode), false);
  // 4px a side (8 in total) is the ink margin every entry clears today.
  check(
    "and every glyph leaves ink margin inside its box",
    sizes
      .map(([name, classes]) => [name, /\bh-(\d+)\b/.exec(classes)?.[1] ?? null] as const)
      .filter(([name, h]) => h !== null && Number(h) * 4 - (glyphs.get(name) ?? 0) < 8)
      .map(([name]) => name),
    [],
  );

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
  // Anchored to line start: the props list opens with the icon's own `size?:`.
  check("and `size` has no default, which is what makes the type check mean anything", /size = /.test(iconButtonArgs), false);
  check("nor is it optional", /^\s*size\?:/m.test(iconButtonProps), false);
  check("and the union it accepts is the table itself", /^\s*size: keyof typeof ICON_BUTTON_SIZE;$/m.test(iconButtonProps), true);

  // Variant-prefixed sizes count too; margins are deliberately allowed.
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
      // Comments stripped: nearby docblocks quote `h-9 w-9`.
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
  check("the sweep found the primitive's call sites", iconButtons.length >= 20, true);
  check("and no call site takes its size back through className", resized, []);

  // Raw `<button>`s bypass IconButton, so a square under `h-11` must carry a 44px growth; Toast's dismiss is the known case.
  const SQUARE = /\bh-(\d+)\b[^"`]*?\bw-\1\b/;
  const GROWS_TO_44 = /\[@media\(pointer:coarse\)\]:after:-inset-2\.5|TAP_GROW_Y|min-h-11/;
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
        // Tailwind's scale is 0.25rem a step, so `h-11` is 44px.
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
