import { readFileSync, readdirSync } from "node:fs";

import { check, report } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

/** The `@theme` block alone: a coarse-pointer restatement of the same names follows it (Q3.662). */
const themeBlock = (text: string): string => {
  const at = text.indexOf("@theme {");
  return at < 0 ? "" : text.slice(at, text.indexOf("\n}\n", at));
};

// Pins the two font families and the type scale; `.claude/rules/web-typography.md` is the rule, Q3.579.

const WEB_SRC = new URL("../src/", import.meta.url);
const cssRaw = readFileSync(new URL("index.css", WEB_SRC), "utf8");
const css = stripComments(cssRaw);

process.stdout.write("\nthe two families this app has, and the ones it must not grow\n");
{
  const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());

  check("the stylesheet declares exactly two font families", families.length, 2);
  check("and both are tokens rather than stacks", families, ["var(--font-sans)", "var(--font-mono)"]);

  // Only HTML comments are stripped: `stripComments` would cut every `//` URL, including the googleapis one this looks for.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replaceAll(
    /<!--[\s\S]*?-->/g,
    "",
  );
  const WEBFONT = /@font-face|googleapis|gstatic|\.woff/i;

  check("the webfont pattern matches a webfont", WEBFONT.test('@import url("//fonts.googleapis.com/x");'), true);
  // Raw CSS for the same reason: stripping turns a googleapis import into a bare `https:` the pattern cannot match.
  const HIDDEN_BY_STRIP = '@import url("https://fonts.googleapis.com/css2?family=Inter");';
  check("stripping comments would have hidden one", WEBFONT.test(stripComments(HIDDEN_BY_STRIP)), false);
  check("while the raw text still finds it", WEBFONT.test(HIDDEN_BY_STRIP), true);
  check(
    "no webfont is loaded, in the stylesheet or in the shell",
    [WEBFONT.test(cssRaw), WEBFONT.test(html)],
    [false, false],
  );
}

process.stdout.write("\nevery size from the scale, and the one that is not\n");
{
  const ALLOWED = ["ui/CommandLine.tsx"];

  const sources: { file: string; text: string }[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        sources.push({ file: `${prefix}${entry.name}`, text: stripComments(readFileSync(new URL(entry.name, dir), "utf8")) });
      }
    }
  };
  walk(WEB_SRC, "");

  const ARBITRARY = /(?<![\w:-])text-\[[^\]]+\]/;
  const found = sources.filter((s) => ARBITRARY.test(s.text)).map((s) => s.file).sort();

  report("there are files to sweep at all", sources.length >= 50, `${sources.length} files under src/`);
  check("the sweep can see an arbitrary size", ARBITRARY.test('className="text-[11px]"'), true);
  check("no size is written outside the scale, beyond the one named exception", found, ALLOWED);

  const steps = [...themeBlock(css).matchAll(/--text-([a-z0-9]+):\s*([^;]+);/g)].map((m) => m[1]);
  check("the scale is the six steps the rule describes", steps, ["2xs", "xs", "sm", "base", "lg", "xl"]);
  // Q3.662: under a finger every step and its line-height are restated, the size exactly two pixels up.
  const coarseAt = css.indexOf("@media (pointer: coarse) {\n    :root");
  const coarse = coarseAt < 0 ? "" : css.slice(coarseAt, css.indexOf("}", coarseAt));
  const rem = (text: string): Map<string, number> =>
    new Map([...text.matchAll(/--text-([a-z0-9-]+):\s*([\d.]+)rem;/g)].map((m) => [m[1] ?? "", Number(m[2])]));
  const base = rem(themeBlock(css));
  const finger = rem(coarse);
  check("a coarse pointer restates every step and every line-height, and nothing else", [...finger.keys()], [...base.keys()]);
  check(
    "each size is exactly two pixels up",
    steps.filter((step) => Math.round(((finger.get(step ?? "") ?? 0) - (base.get(step ?? "") ?? 0)) * 16) !== 2),
    [],
  );
  check(
    "and no line-height shrinks with it",
    steps.filter((step) => (finger.get(`${step}--line-height`) ?? 0) <= (base.get(`${step}--line-height`) ?? 0)),
    [],
  );
  check("in the theme layer, so a utility still wins over it", /@layer theme \{\s*@media \(pointer: coarse\)/.test(css), true);
}

process.stdout.write("\nthe two caps constants and the field label, and the colour that may not be appended\n");
{
  // Each constant already carries a colour, so an appended one is a silent no-op; FIELD_LABEL is sentence case now and still carries text-fg.
  const CAPS = ["SETTINGS_HEADING", "MENU_HEADING", "FIELD_LABEL"];
  const COLOUR = /(?<![\w:-])text-(?:fg|muted|faint|danger|ink|accent|warn|ok)\b/;

  const sources: { file: string; text: string }[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        sources.push({ file: `${prefix}${entry.name}`, text: stripComments(readFileSync(new URL(entry.name, dir), "utf8")) });
      }
    }
  };
  walk(WEB_SRC, "");

  const composed: string[] = [];
  let interpolations = 0;
  for (const { file, text } of sources) {
    for (const literal of text.match(/`[^`]*`/g) ?? []) {
      if (!CAPS.some((name) => literal.includes(`\${${name}}`))) continue;
      interpolations += 1;
      if (COLOUR.test(literal)) composed.push(`${file}: ${literal}`);
    }
  }

  // Printed rather than asserted: an exact count would redden on every legitimate new mono.
  const monos = sources.reduce((total, { text }) => total + (text.match(/font-mono/g) ?? []).length, 0);
  report("mono is written at a call site this many times", monos > 0, `${monos} call sites`);

  report("the constants are composed somewhere at all", interpolations >= 5, `${interpolations} interpolations`);
  check("the sweep can see an appended colour", COLOUR.test("`${SETTINGS_HEADING} mb-1.5 text-faint`"), true);
  check("and does not fire on layout beside one", COLOUR.test("`mt-3 block ${SETTINGS_HEADING}`"), false);
  check("no colour is appended to a heading constant", composed, []);
}

process.stdout.write("\nevery site of the caps idiom, and the ones that are outside the constants\n");
{
  // A census against the table below, over comment-stripped text since bits.tsx quotes the idiom in prose. Q5.115.
  type Site = { file: string; hits: number; constant: boolean; anchor: string; why: string };

  const SITES: Site[] = [
    { file: "ui/bits.tsx", hits: 2, constant: true, anchor: "", why: "MENU_HEADING and SETTINGS_HEADING" },
    {
      file: "ui/AgentBuilder.tsx",
      hits: 1,
      constant: false,
      anchor: "const HIDDEN_PROVIDER_HEADING =",
      why: "text-faint, written out rather than `${SETTINGS_HEADING} text-faint`",
    },
    {
      file: "ui/MenuDrawer.tsx",
      hits: 1,
      constant: false,
      anchor: "const DRAWER_HEADING =",
      why: "the drawer's own px-3 inset, which MENU_HEADING's px-2.5 would put 2px inboard of its rows",
    },
    {
      file: "ui/TaskPanel.tsx",
      hits: 1,
      constant: false,
      anchor: "const FINISHED_HEADING =",
      why: "text-faint, spent by both arms of the finished band: every other heading there names work that is going",
    },
  ];

  const IDIOM = /tracking-wider/g;
  const hitsIn = (text: string): number => (text.match(IDIOM) ?? []).length;

  const files = srcFiles();
  report("there are files to sweep at all", files.length >= 50, `${files.length} files under src/`);
  check("the sweep can see the idiom", hitsIn('className="text-2xs tracking-wider uppercase"'), 1);

  const found: string[] = [];
  for (const file of files) {
    const n = hitsIn(stripComments(srcFile(file)));
    if (n > 0) found.push(`${file} ×${n}`);
  }
  check(
    "every site of the caps idiom is one the rule accounts for, and no other",
    found.sort(),
    SITES.map((site) => `${site.file} ×${site.hits}`).sort(),
  );

  for (const file of ["ui/bits.tsx"]) {
    const raw = srcFile(file);
    report(
      `${file} quotes the idiom in a comment, so stripping is what keeps the count honest`,
      hitsIn(raw) > hitsIn(stripComments(raw)),
      `${hitsIn(raw)} raw against ${hitsIn(stripComments(raw))} in code`,
    );
  }

  // Each exception needs a comment closing just above its anchor; a missing anchor is checked first so -1 never slices the file's end.
  for (const site of SITES.filter((s) => !s.constant)) {
    const raw = srcFile(site.file);
    const at = raw.indexOf(site.anchor);
    check(`${site.file}: the site the rule names is there exactly once`, [at >= 0, at === raw.lastIndexOf(site.anchor)], [true, true]);
    const before = at < 0 ? "" : raw.slice(0, at);
    const closes = before.lastIndexOf("*/");
    // 80 characters: the measured gaps are at most 39, and a generous bound would accept an unrelated comment.
    report(
      `${site.file}: and it says why it is outside the constants, at the code`,
      closes >= 0 && before.length - closes <= 80,
      site.why,
    );
    check(`${site.file}: a comment closes immediately above it`, closes >= 0 && before.length - closes <= 80, true);
  }

  // RETIRE_HEADING was the idiom's one danger-coloured copy; retiring a machine is a DangerRow in its screen's last group now.
  check(
    "no heading is spelled out in danger any more, so retiring draws no caps of its own",
    [/RETIRE_HEADING/.test(srcFile("ui/settings/MachineSection.tsx")), /tracking-wider[^"`]*text-danger|text-danger[^"`]*tracking-wider/.test(srcFile("ui/settings/MachineSection.tsx"))],
    [false, false],
  );
}

process.stdout.write("\nevery path this app draws, at the one size a path is drawn at\n");
{
  // Mono renders a step above sans at the same nominal size, so every path is drawn at `text-2xs`; this list is hand-kept, not derived.
  const read = (rel: string): string =>
    stripComments(readFileSync(new URL(rel, WEB_SRC), "utf8"));

  // Anchored on the crumb button's own classes: the bare pair also matches a placeholder earlier in NewSession.tsx.
  const carried: [string, RegExp][] = [
    ["the directory picker's crumbs", /tap -my-2 inline-flex min-h-11 items-center font-mono text-2xs/],
  ];
  for (const [name, pattern] of carried) {
    check(`${name} state their own size`, pattern.test(read("ui/NewSession.tsx")), true);
    check(`${name} were found as an element, not as a pair of classes`, /tap -my-2 inline-flex min-h-11/.test(read("ui/NewSession.tsx")), true);
  }

  // The session row's subline is sans at `text-2xs` by design; size, no mono and the subpath are one check so no half goes quiet alone.
  {
    const browser = read("ui/SessionBrowser.tsx");
    const subline = /<div className="mt-0\.5 flex min-w-0 items-center gap-\[2em\] text-2xs text-muted">([\s\S]*?)<\/div>/.exec(browser);
    check("the session row's subline was found", subline !== null, true);
    check(
      "and it is sans, at one size, naming the machine where the path was",
      [subline !== null && /\bfont-mono\b/.test(subline[1] ?? ""), subline !== null && /<MachineLabel name=\{machine\} \/>/.test(subline[1] ?? "")],
      [false, true],
    );
  }
  check(
    "a diff's file path is drawn at the same step",
    /truncate font-mono text-2xs/.test(read("ui/DiffView.tsx")),
    true,
  );

  check(
    "the session header's path is mono, on a subtitle line that is already text-2xs",
    [
      /<span data-unit="" className="truncate font-mono" title=\{where\}>/.test(read("ui/SessionView.tsx")),
      /justify-center text-2xs text-muted/.test(read("ui/Header.tsx")),
    ],
    [true, true],
  );
  check(
    "the import sheet's path is mono, on a footer line that is already text-2xs",
    [
      /<span className="font-mono">\{displayCwd\(into, roots\)\}<\/span>/.test(read("ui/ImportCode.tsx")),
      /className="min-w-0 flex-1 truncate text-2xs text-muted" title=\{into\}/.test(read("ui/ImportCode.tsx")),
    ],
    [true, true],
  );

  check(
    "the agents screen's provenance line is mono where it quotes the machine, on a text-2xs line",
    [
      /<span className="font-mono">permissions\.defaultMode<\/span>/.test(read("ui/settings/MachineAgentsSection.tsx")),
      /<span className="font-mono">\{settingsMode\.value\}<\/span>/.test(read("ui/settings/MachineAgentsSection.tsx")),
      /<span className="font-mono">\{shortPath\(settingsMode\.file\)\}<\/span>/.test(read("ui/settings/MachineAgentsSection.tsx")),
      // A Group footer is text-xs, so the line states text-2xs itself.
      /<span className="text-2xs wrap-anywhere" title=\{settingsMode\.file\}>/.test(read("ui/settings/MachineAgentsSection.tsx")),
    ],
    [true, true, true, true],
  );
  check(
    "and the file is never interpolated into the sentence raw",
    /from \$\{settingsMode\.file\}/.test(read("ui/settings/MachineAgentsSection.tsx")),
    false,
  );
}
