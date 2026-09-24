import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhat a control still looks like when it refuses\n");
{
  // Comments come off first: docblocks in bits.tsx and SystemsPanel quote the very classes the negative checks forbid.
  const source = (name: string): string =>
    stripComments(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"));
  const bits = source("ui/bits.tsx");
  const newSession = source("ui/NewSession.tsx");
  const builder = source("ui/AgentBuilder.tsx");
  const systems = source("ui/settings/SystemsPanel.tsx");
  const between = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    if (start === -1) return "";
    // A missing terminator must yield empty rather than the rest of the file, or negative checks hit something else entirely.
    const end = text.indexOf(to, start + from.length);
    return end === -1 ? "" : text.slice(start, end);
  };
  const choiceRow = between(bits, "export function ChoiceRow", "\n}\n");
  const tile = between(newSession, "const bound = disabled", "</button>");
  const strip = between(newSession, "function AgentStrip(", "\nfunction MachineLine");
  const tones = between(bits, "const BUTTON_TONE", "\n};");
  const trigger = between(bits, "tap press inline-flex min-h-8 w-full", '"');
  const option = between(bits, 'role="option"', "</button>");
  const iconButton = between(bits, "export function IconButton", "\n}\n");
  // An empty slice is a rename, and every negative assertion below would pass over it.
  check(
    "every control this section is about was actually found",
    [choiceRow, tile, strip, tones, trigger, option, iconButton].map((one) => one.length > 0),
    [true, true, true, true, true, true, true],
  );

  // No opacity on a control whose 12px subline is its refusal: faint at 40% composites to 1.83:1.
  check("no opacity is spent on the row that has to say why it refuses", /opacity/.test(choiceRow), false);
  check("nor on the tile that does", /opacity/.test(tile), false);
  check("nor anywhere else in the strip", /opacity/.test(strip), false);
  check("nor on the dropdown option that carries the same kind of reason", /opacity/.test(option), false);
  check(
    "which dims its label and leaves the reason at full strength",
    [
      /\$\{unavailable \? "text-muted" : ""\}/.test(option),
      /<span className="block text-2xs text-faint">\{item\.description\}/.test(option),
    ],
    [true, true],
  );
  // Hover still matches a disabled button, so the fill is granted by state rather than undone by a disabled variant.
  check(
    "and grants its hover fill by state instead of taking it back",
    [/disabled:hover:/.test(option), /unavailable \? "" : "hover:bg-raised"/.test(option)],
    [false, true],
  );
  // Three sanctioned opacities (the primary and ghost tones, IconButton), none with a boundary or subline; a fourth is the defect, not the count.
  check("exactly three sanctioned opacities in the whole vocabulary file", (bits.match(/opacity/g) ?? []).length, 3);
  check(
    "and all three are on controls with no boundary to lose and no subline to composite",
    /opacity/.test(bits.replace(tones, "").replace(iconButton, "")),
    false,
  );
  check("while the two ghost buttons below it still have theirs", (newSession.match(/disabled:opacity-40/g) ?? []).length, 2);
  check(
    "the tile dims its title and its glyph and leaves the reason alone",
    [
      /className=\{disabled \? "text-faint" : "text-muted"\}/.test(tile),
      /\$\{disabled \? "text-muted" : ""\}/.test(tile),
      /className="[^"]*w-full truncate text-2xs text-faint">\s*\{subline\}/.test(tile),
    ],
    [true, true, true],
  );
  // An empty span is 0px tall, so the subline reserves its line from the custom property text-2xs takes its line-height from.
  check(
    "the subline holds its line even when it is empty, at the height its own text would take",
    [
      /min-h-\[var\(--text-2xs--line-height\)\][^"]*">\s*\{subline\}/.test(tile),
      /--text-2xs--line-height: /.test(readFileSync(new URL("../src/index.css", import.meta.url), "utf8")),
    ],
    [true, true],
  );
  check(
    "and the row does the same three, in the same order",
    [
      /disabled \? "text-faint" : "text-muted"/.test(choiceRow),
      /disabled \|\| placeholder \? "text-muted" : ""/.test(choiceRow),
      /className="block truncate text-2xs text-faint">\{subline\}/.test(choiceRow),
    ],
    [true, true, true],
  );

  check("the row's boundary is a boundary", /border border-edge-strong/.test(choiceRow), true);
  check("the tile's is too", /border-edge-strong/.test(tile), true);
  check("and the + beside it, dashed or not", /border-dashed border-edge-strong/.test(strip), true);
  // A refused row hands back the hairline: WCAG 1.4.11 exempts inactive components, and edge-strong signals pressable.
  check(
    "and a refused row gives it back for the decorative hairline",
    /disabled \? "border border-edge" : "border border-edge-strong"/.test(choiceRow),
    true,
  );
  // disabled is asked before picked, or a restored unpressable pick takes the strong border.
  check(
    "and the tile asks whether it is refused before it asks whether it is chosen",
    /const bound = disabled\s*\? "border-edge"\s*: picked\s*\? "border-edge-strong"/.test(tile),
    true,
  );
  check(
    "and neither hands a pressable-looking edge to something that cannot be pressed",
    [choiceRow, tile].map((one) => /\bdisabled\s*\?\s*"[^"]*edge-strong/.test(one)),
    [false, false],
  );
  // Buttons keep a boundary when refused on purpose: a lone control's border says a control is here, a sibling row's says which can be pressed.
  check("while the menu row has no boundary to hand back in either state", /border-edge/.test(option), false);
  check(
    "and every one of them takes its hover as a fill",
    [choiceRow, tile, strip].map((one) => /hover:bg-raised/.test(one)),
    [true, true, true],
  );
  check(
    "with no border moved under a pointer anywhere this run touched",
    [choiceRow, tile, strip, builder, systems].map((one) => /hover:border-/.test(one)),
    [false, false, false, false, false],
  );
  check("and neither migrated screen writes a row of its own", [/min-h-14/.test(builder), /min-h-14/.test(systems)], [false, false]);

  // Token-exact lookahead: the destructive tone deliberately takes the strong edge when disabled.
  check("neither outlined tone hands its boundary back when it is refused", /disabled:border-edge(?!-strong)/.test(tones), false);
  const cssTokens = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const token = (name: string): [number, number, number] => {
    const hex = new RegExp(`--color-${name}: #([0-9a-f]{6});`).exec(cssTokens)?.[1] ?? "";
    return [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((pair) => parseInt(pair, 16)) as [number, number, number];
  };
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: [number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const over = (front: [number, number, number], back: [number, number, number], alpha: number): [number, number, number] =>
    front.map((value, index) => Math.round(alpha * value + (1 - alpha) * back[index]!)) as [number, number, number];
  const ratio = (one: number, other: number): number =>
    (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
  const surface = token("surface");
  const dangerEdge = over(token("danger"), surface, 0.45);
  check("the danger border at 45% is the swatch the docblock names", `#${dangerEdge.map((value) => value.toString(16).padStart(2, "0")).join("")}`, "#c5a5a0");
  check(
    "and it measures 2.27:1 on surface, which is under 3:1 and is the whole argument",
    [ratio(luminance(dangerEdge), luminance(surface)).toFixed(2), ratio(luminance(dangerEdge), luminance(surface)) < 3],
    ["2.27", true],
  );
  // Read raw on purpose: the figure lives in prose, and a positive assertion about prose is safe.
  const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  check(
    "and BUTTON_TONE's own docblock quotes it rather than remembering it",
    bitsRaw.slice(bitsRaw.indexOf("border-danger/45"), bitsRaw.indexOf("const BUTTON_TONE")).includes("2.27:1"),
    true,
  );
  check(
    "and the two tones that keep the opacity are the two with no boundary to lose",
    [/primary: "[^"]*disabled:opacity-40/.test(tones), /ghost: "[^"]*disabled:opacity-40/.test(tones)],
    [true, true],
  );
  check(
    "the dropdown's trigger dims its ink and keeps its box",
    [/border border-edge-strong/.test(trigger), /disabled:text-faint/.test(trigger), /disabled:border-edge(?!-strong)/.test(trigger)],
    [true, true, false],
  );
}

process.stdout.write("\nno authorization on the Configure agent screen\n");
{
  // Read raw on purpose: the builder's prose must not name the removed credential box either.
  const builderRaw = readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8");
  const builder = stripComments(builderRaw);
  const systemsRaw = readFileSync(new URL("../src/ui/settings/SystemsPanel.tsx", import.meta.url), "utf8");
  const systems = stripComments(systemsRaw);
  check("the screen and the panel it no longer borrows from were both found", [builder.length > 0, systems.length > 0], [true, true]);

  check(
    "the builder names no credential control, in its code or in its prose",
    [/KeyOnly/, /keyMissing/, /\.\/settings\//].filter((one) => one.test(builderRaw)).map(String),
    [],
  );
  const fields = builder.split("<input").slice(1).map((one) => one.slice(0, 500));
  check("and carries exactly three fields", fields.length, 3);
  check(
    "and every one of them is one of the three it is entitled to",
    fields.filter(
      (one) =>
        !/aria-label="Agent name"/.test(one) &&
        !/type="search"/.test(one) &&
        !/aria-label=\{`Type a \$\{system\.displayName\} model id`\}/.test(one),
    ).length,
    0,
  );
  // The real key field is type text on purpose (password managers), so these opt-outs are what mark a credential.
  check(
    "nor dressed as one by any of the marks this app's real key field carries",
    [/type="password"/, /autoComplete/, /data-1p-ignore/, /data-lpignore/, /SystemKey\(/].filter((one) => one.test(builder)).map(String),
    [],
  );
  check(
    "while the box itself still exists, and is still mounted twice in settings",
    [
      /export function KeyOnly\(/.test(systemsRaw),
      (systems.match(/<KeyOnly\b/g) ?? []).length,
      /<KeyOnly[^>]*routing=\{true\}/.test(systems),
    ],
    [true, 2, true],
  );
  {
    const asks = systems.indexOf("Remove the {keyName}? New sessions pointed at");
    const start = asks < 0 ? -1 : systems.lastIndexOf("<TwoStep", asks);
    // Positional anchors: an arrow prop puts a > inside the tag that a regex over it would stop at.
    const asking = start < 0 ? "" : systems.slice(start, asks + systems.slice(asks).search(/^\s*\/>/m));
    const keyOnly = systems.slice(systems.indexOf("export function KeyOnly("));
    check("the removal is the primitive's, and the question was found", [start >= 0, asks >= 0], [true, true]);
    check(
      "one box in both arms, centred rather than trailing, with the named button at rest",
      [
        /align="center"/.test(asking),
        /\bjustify-(?:center|end)\b/.test(keyOnly),
        /act=\{\{ label: "Remove", danger: true, icon: Trash2 \}\}/.test(asking),
        /rest=\{[\s\S]*?<DangerButton icon=\{Trash2\} disabled=\{busy\} onClick=\{\(\) => setConfirmingRemove\(true\)\}>\s*Remove the \{keyName\}/.test(asking),
        /setConfirmingRemove\(false\)/.test(keyOnly),
      ],
      [true, false, true, true, false],
    );
    const removal = keyOnly.slice(keyOnly.indexOf("const remove = "), keyOnly.indexOf("const borrowed = "));
    check(
      "and the removal holds the box's busy, so the key form is refused while it is out",
      [
        /disabled=\{busy \|\| daemon === undefined\}/.test(asking),
        /^const remove = \(\): Promise<void> \| undefined => \{\s*if \(daemon === undefined\) return undefined;\s*setBusy\(true\);\s*return daemon\s*\.removeSystemKey\(system\.id\)/.test(removal),
        /onChanged\(\);\s*\}\)\s*\.finally\(\(\) => setBusy\(false\)\);\s*\};/.test(removal),
      ],
      [true, true, true],
    );
  }
  check(
    "the one button on the screen is still wired to the refusal that folds the key in",
    [
      /const conflict = current === null \? null : choiceRefusal\(harness, current, routingOf\(harness\), nameOf\);/.test(
        builder,
      ),
      /disabled=\{busy \|\| current === null \|\| harness === null \|\| conflict !== null\}/.test(builder),
    ],
    [true, true],
  );
  // The status span stays mounted: a live region inserted with its content is often not announced.
  check(
    "and the line beside it is that same refusal, with nothing to say when there is none",
    [
      /role="status"[^>]*>\s*\{error \?\? conflict\}/.test(builder.replace(/\s+/g, " ")),
      /pick a (model|harness|LLM)/i.test(builder),
    ],
    [true, false],
  );

  // The model list is the refusal's other consumer; nativeHarness must stay absent from this screen.
  const builderFlat = builder.replace(/\s+/g, " ");
  check(
    "and every row of the model list is greyed by that same refusal, unconditioned",
    [
      /const why = choiceRefusal\(null, choice, null\);/.test(builder),
      /subline=\{ shared !== null \? null : \(why \?\? \(groups\.length > 1 \? null : group\.system\.displayName\)\) \}/.test(
        builderFlat,
      ),
      /disabled=\{why !== null\}/.test(builder),
      /nativeHarness/.test(builder),
    ],
    [true, true, true, false],
  );
  // Refused on the provider heading via hostable, never on the row via choiceRefusal (Q3.479).
  check(
    "a provider the harness cannot be pointed at is one heading, asked of hostable and no one else",
    [
      /const wholeProvider = harness === null \? null : hostable\(harness, group\.system, routing, nameOf\);/.test(
        builder,
      ),
      /if \(wholeProvider !== null\)/.test(builder),
      /harness === null \? null :/.test(builder),
    ],
    [true, true, true],
  );
  check(
    "and the sentence hoisted off a large group is that same refusal, unanimous",
    [
      /const sublines = group\.choices\.map\(\(one\) => choiceRefusal\(null, one, null\)\);/.test(builder),
      /sublines\.every\(\(one\) => one === first\)/.test(builder),
      /group\.choices\.length > 3/.test(builder),
    ],
    [true, true, true],
  );

  const stacked = builder.replace(/\s+/g, " ");
  const pair = stacked.slice(stacked.indexOf('<Field label="Harness"'), stacked.indexOf("</Field> </div>"));
  check("the stacked pair was found and both rows ask for a glyph", [pair.length > 0, (pair.match(/glyph=/g) ?? []).length], [true, 2]);
  // Harness above Model: the model row waits on an expensive read and the harness list needs none (Q3.528).
  check(
    "the row that costs nothing to answer is above the row that waits",
    stacked.indexOf('<Field label="Harness"') < stacked.indexOf('<Field label="Model"'),
    true,
  );
  // Field's prop value holds a > from an arrow, so the anchor excludes elements rather than that character.
  check(
    "the row that can never have one reserves the hole, and the row that can fills it",
    [
      /<Field label="Model"[^<]*> <ChoiceRow glyph=\{emptyGlyph\}/.test(pair),
      /<Field label="Harness"[^<]*> <ChoiceRow glyph=\{harness === null \? emptyGlyph : <AgentGlyph agent=\{harness\} size=\{18\} \/>\}/.test(pair),
    ],
    [true, true],
  );
  // Each clear empties only its own field; one press emptying two is the implicit form Q3.479 rejected.
  check(
    "each field can be emptied, and a clear reaches no further than its own",
    [
      (pair.match(/clear=\{/g) ?? []).length,
      /clear=\{current === null \|\| busy \? null : \(\) => setPicked\(null\)\}/.test(pair),
      /clear=\{harness === null \|\| busy \? null : \(\) => setHarness\(null\)\}/.test(pair),
      /setPicked\(null\)[^}]*setHarness/.test(pair),
      /setHarness\(null\)[^}]*setPicked/.test(pair),
    ],
    [2, true, true, false, false],
  );
  check(
    "the pair's refusal is drawn on the harness row, and the model row still names its provider",
    [
      /<Field label="Harness"[^<]*>.*?subline=\{conflict\}/.test(pair),
      /subline=\{reading \? [^:]*: \(current\?\.system\.displayName \?\? null\)\}/.test(pair),
    ],
    [true, true],
  );
  check(
    "and the model row is the only thing that waits for the expensive read",
    [
      /disabled=\{busy \|\| reading\}/.test(pair),
      /const reading = capabilities === null;/.test(builder),
      /if \(systems === null \|\| \(preset !== null && stored === null\)\) \{/.test(builder),
      /if \(step === "llm" && reading\) \{/.test(builder),
    ],
    [true, true, true, true],
  );
  const slot = /const emptyGlyph = <span aria-hidden="true" className="block h-\[(\d+)px\] w-\[(\d+)px\]" \/>;/.exec(builder);
  const mark = /<AgentGlyph agent=\{harness\} size=\{(\d+)\}/.exec(stacked);
  check("and the hole is square and exactly as wide as the mark it holds a place for", [slot?.[1], slot?.[2], mark?.[1]], ["18", "18", "18"]);

  // The switch runs inside isBuiltinAgentId so AgentGlyph's never arm stays exhaustive; a plugin harness gets a monogram from its id.
  {
    const icons = readFileSync(new URL("../src/ui/AgentIcons.tsx", import.meta.url), "utf8");
    check(
      "a harness a plugin added is drawn, and the never arm that makes a fifth built-in loud is still reachable",
      [
        /if \(!isBuiltinAgentId\(agent\)\) return <MonogramGlyph agent=\{agent\} size=\{size\} \/>;\s*switch \(agent\) \{/.test(icons),
        /function unglyphed\(agent: never\)/.test(icons),
        /function MonogramGlyph\(\{ agent, size \}: \{ agent: string; size: number \}\)/.test(icons),
        /agent\.slice\(agent\.indexOf\(":"\) \+ 1\)/.test(icons),
      ],
      [true, true, true, true],
    );
    check("and what it draws is a letter", /\{letter\}/.test(icons) && /\(Array\.from\(local\)\[0\] \?\? "\?"\)\.toUpperCase\(\)/.test(icons), true);
  }
}
