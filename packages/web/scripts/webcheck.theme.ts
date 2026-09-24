import { readFileSync } from "node:fs";

import { check, report, storage } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

// Pins the dark palette and the switch that picks it; Q3.669 is the palette, Q3.670 the switch.

const css = stripComments(srcFile("index.css"));
const between = (text: string, start: string, end: string): string => {
  const at = text.indexOf(start);
  return at < 0 ? "" : text.slice(at, text.indexOf(end, at + start.length));
};
const tokensOf = (block: string): Map<string, string> =>
  new Map([...block.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
const light = tokensOf(between(css, "@theme {", "\n}\n"));
const dark = tokensOf(between(css, ':root[data-theme="dark"] {', "\n}"));

process.stdout.write("\nthe dark palette names every colour the light one does, and nothing else\n");
{
  report("both palettes were read", light.size >= 14 && dark.size >= 14, `${light.size} light, ${dark.size} dark`);
  check("every light colour has a dark twin", [...light.keys()].filter((name) => !dark.has(name)), []);
  check("and the dark palette invents none", [...dark.keys()].filter((name) => !light.has(name)), []);
  check("no twin is its light value copied across", [...light].filter(([name, value]) => dark.get(name) === value).map(([name]) => name), []);
  check(
    "the dark block is unlayered, since the shadow properties it overrides are",
    [/@layer theme \{\s*:root\[data-theme="dark"\]/.test(css), /:root \{[^}]*--shade: 60 52 38;[^}]*--shade-k: 1;/.test(css)],
    [false, true],
  );
  check(
    "and it turns the shadows black and heavier, and the page's own controls dark",
    [
      /:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/.test(css),
      /:root\[data-theme="dark"\] \{[^}]*--shade: 0 0 0;/.test(css),
      Number(/:root\[data-theme="dark"\] \{[^}]*--shade-k: ([\d.]+);/.exec(css)?.[1] ?? "0") > 1,
    ],
    [true, true, true],
  );
  const shadows = [...between(css, "@theme {", "\n}\n").matchAll(/--shadow-[a-z0-9]+:([^;]+);/g)].map((m) => m[1] ?? "");
  report("the shadow scale was read", shadows.length === 5, `${shadows.length} shadows`);
  check(
    "every shadow layer takes its colour from the two properties, so the dark block reaches it",
    shadows.filter((value) => /rgb\(\d/.test(value) || !/rgb\(var\(--shade\) \/ calc\([\d.]+ \* var\(--shade-k\)\)\)/.test(value)),
    [],
  );
}

process.stdout.write("\neach palette keeps the contrast the other was argued at\n");
{
  const rgb = (hex: string): [number, number, number] =>
    [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string): number => {
    const [r, g, b] = rgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (one: string, other: string): number =>
    (Math.max(lum(one), lum(other)) + 0.05) / (Math.min(lum(one), lum(other)) + 0.05);
  const over = (front: string, back: string, alpha: number): string =>
    `#${rgb(front)
      .map((value, index) => Math.round(alpha * value + (1 - alpha) * rgb(back)[index]!).toString(16).padStart(2, "0"))
      .join("")}`;

  check("the ratio is the published one", ratio("#000000", "#ffffff").toFixed(0), "21");
  const PAPERS = ["ink", "surface", "raised"];
  // Read off the card, so the weights measured are the ones drawn.
  const card = stripComments(srcFile("ui/AskCard.tsx"));
  const hintAlphas = [...card.matchAll(/option\.primary === true \? "text-ink\/(\d+)"/g)].map((m) => Number(m[1]) / 100);
  const hoverAlphas = [...card.matchAll(/bg-fg text-ink hover:bg-fg\/(\d+)/g)].map((m) => Number(m[1]) / 100);
  report("the primary fill's hints and hover were read off the card", hintAlphas.length > 0 && hoverAlphas.length > 0, `${hintAlphas.length} hints, ${hoverAlphas.length} hovers`);
  for (const [name, palette] of [["light", light], ["dark", dark]] as const) {
    const unread: string[] = [];
    const hex = (token: string): string => {
      const value = (palette.get(token) ?? "").toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(value)) return value;
      unread.push(token);
      return "#000000";
    };
    const short = (floor: number, fronts: string[], backs: string[]): string[] =>
      fronts.flatMap((front) =>
        backs.filter((back) => ratio(hex(front), hex(back)) < floor).map((back) => `${front} on ${back}`),
      );
    check(`${name}: every text tone clears 4.5:1 on every paper`, short(4.5, ["fg", "muted", "faint", "danger", "caution"], PAPERS), []);
    check(`${name}: a control's only boundary clears 3:1 on every paper`, short(3, ["edge-strong"], PAPERS), []);
    check(
      `${name}: a diff's ink reads on its own band, and body text on both bands`,
      [...short(4.5, ["add-ink"], ["add"]), ...short(4.5, ["del-ink"], ["del"]), ...short(4.5, ["fg"], ["add", "del"])],
      [],
    );
    check(`${name}: the affirmative fill carries its own label`, short(4.5, ["ink"], ["fg"]), []);
    check(
      `${name}: the key hint on that fill is still text, hovered too`,
      PAPERS.flatMap((paper) =>
        [1, ...hoverAlphas].flatMap((fillAlpha) => {
          const fill = over(hex("fg"), hex(paper), fillAlpha);
          return hintAlphas
            .filter((hintAlpha) => ratio(over(hex("ink"), fill, hintAlpha), fill) < 4.5)
            .map((hintAlpha) => `ink/${String(hintAlpha)} on fg/${String(fillAlpha)} over ${paper}`);
        }),
      ),
      [],
    );
    // Q3.205: raised is the message you wrote at 1.22:1, and edge sits one step further out.
    check(
      `${name}: raised stays the step it was argued at, and edge beyond it`,
      [Math.abs(ratio(hex("raised"), hex("surface")) - 1.22) < 0.03, ratio(hex("edge"), hex("surface")) > ratio(hex("raised"), hex("surface"))],
      [true, true],
    );
    check(`${name}: the rail stays the hint it is (Q3.210)`, Math.abs(ratio(hex("ink"), hex("surface")) - 1.06) < 0.02, true);
    // A token missing or not written #rrggbb would be weighed as black, which passes every check above.
    check(`${name}: every colour weighed above was read as #rrggbb`, [...new Set(unread)], []);
  }
  const darkLum = (token: string): number => lum(dark.get(token) ?? "#000000");
  check(
    "dark: a paper higher up is lighter, which is the only elevation a dark ground shows",
    [darkLum("ink") < darkLum("surface"), darkLum("surface") < darkLum("raised"), darkLum("raised") < darkLum("edge")],
    [true, true, true],
  );
  check(
    "dark: neither end is the pure one, which halates and crushes",
    [dark.get("fg") !== "#ffffff", dark.get("ink") !== "#000000", lum(dark.get("fg") ?? "#ffffff") < 0.85],
    [true, true, true],
  );
}

process.stdout.write("\na colour lives in the palette, so a second palette is one block\n");
{
  const files = srcFiles();
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/;
  const FIXED = new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|shadow)-(?:${["white", "black"].join("|")}|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3})\\b`);
  check("the literal pattern sees a hex and a function", [LITERAL.test('style={{ color: "#fff" }}'), LITERAL.test("rgb(0 0 0)")], [true, true]);
  check("the fixed-colour pattern sees a palette-free utility", FIXED.test(`className="${["bg", "white"].join("-")}"`), true);
  report("there are files to sweep", files.length >= 100, `${files.length} files`);
  // legal/ holds policies as data, whose prose may quote anything.
  const swept = files.filter((file) => !file.startsWith("legal/"));
  check("no component writes a colour of its own", swept.filter((file) => LITERAL.test(stripComments(srcFile(file)))), []);
  check("nor names one outside the palette", swept.filter((file) => FIXED.test(stripComments(srcFile(file)))), []);

  const SCRIM = new RegExp(["bg", "fg/25"].join("-"));
  check("fg is never a scrim, since it turns light in the dark palette", swept.filter((file) => SCRIM.test(stripComments(srcFile(file)))), []);
  check(
    "every scrim takes the one token",
    ["ui/Sheet.tsx", "ui/MenuDrawer.tsx", "ui/TaskPanel.tsx", "ui/AgentConfigBar.tsx"].filter((file) => !/\bbg-scrim\b/.test(srcFile(file))),
    [],
  );
}

process.stdout.write("\nthe page is dark on its first paint, and the two writers agree\n");
{
  const boot = readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");
  const theme = stripComments(srcFile("theme.ts"));
  const key = /export const THEME_KEY = "([^"]+)";/.exec(theme)?.[1] ?? "";
  check("theme.ts names its key", key, "reemoat.theme");
  check("and the first-paint script reads the same one", boot.includes(`getItem("${key}")`), true);
  check(
    "both write the same attribute, and rewrite the scheme tag with it",
    [
      boot.includes('setAttribute("data-theme", theme)'),
      /root\.dataset\["theme"\] = next;/.test(theme),
      boot.includes('querySelector(\'meta[name="color-scheme"]\')') && boot.includes('scheme.setAttribute("content", theme)'),
      /querySelector\('meta\[name="color-scheme"\]'\)\?\.setAttribute\("content", next\)/.test(theme),
    ],
    [true, true, true, true],
  );
  // Q3.670: light until the switch says dark, whatever the system says; a phone on a dark system opened dark.
  const SYSTEM = /prefers-color-scheme|matchMedia/;
  check("the system's appearance is asked nowhere", [SYSTEM.test(stripComments(boot)), SYSTEM.test(theme), SYSTEM.test(css)], [false, false, false]);
  check("and the first paint is dark only on a stored dark", /var theme = chosen === "dark" \? "dark" : "light";/.test(boot), true);
  const inks = [/theme === "dark" \? "(#[0-9a-f]{6})" : "(#[0-9a-f]{6})"/.exec(boot)?.slice(1) ?? []].flat();
  check("its browser-chrome colours are the two inks, read off the palettes", inks, [dark.get("ink"), light.get("ink")]);
  check("it is a classic script, not a module that would run after the paint", /\bimport\b|\bexport\b/.test(stripComments(boot)), false);

  const shellHtml = (name: string): string =>
    readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replaceAll(/<!--[\s\S]*?-->/g, "");
  const html = shellHtml("index.html");
  const script = html.indexOf('<script src="/theme.js"></script>');
  const meta = html.indexOf('<meta name="theme-color"');
  const scheme = html.indexOf('<meta name="color-scheme" content="light" />');
  check(
    "the app's shell loads it blocking, in the head, after both tags it rewrites and before the app",
    [script > meta && meta > 0 && script > scheme && scheme > 0, script < html.indexOf("</head>"), html.indexOf('<script type="module"') > script],
    [true, true, true],
  );
  check("and one theme-color tag, since the switch decides it rather than a media query", (html.match(/name="theme-color"/g) ?? []).length, 1);
  // The gate is another origin with no switch, so it is light and carries none of this.
  const gate = shellHtml("gate.html");
  check(
    "the gate stays light: no first-paint script, a light scheme, and no install",
    [gate.includes("theme.js"), /<meta name="color-scheme" content="light" \/>/.test(gate), /installTheme/.test(stripComments(srcFile("gate-main.tsx")))],
    [false, true, false],
  );
  check("the app's entry installs it and tells the shell", /installTheme\(inNativeShell\(\) \? setNativeTheme : undefined\);/.test(stripComments(srcFile("main.tsx"))), true);
  check(
    "a swap holds every transition but the switch's own for two frames",
    [
      /:root\[data-theme-swap\] \*:not\(\[data-keeps-motion\]\),[\s\S]{0,120}transition: none !important;/.test(css),
      /requestAnimationFrame\(\(\) =>\s*requestAnimationFrame\(\(\) => \{\s*delete root\.dataset\["themeSwap"\];/.test(theme),
    ],
    [true, true],
  );
}

process.stdout.write("\nwhat the switch chooses, and what it survives\n");
{
  const { chosenTheme, THEME_KEY } = await import("../src/theme.js");
  const read = (stored: string | null): string => {
    if (stored === null) storage.delete(THEME_KEY);
    else storage.set(THEME_KEY, stored);
    return chosenTheme();
  };
  check("light until dark is stored, and anything else is light", [read(null), read("dark"), read("light"), read("sepia")], ["light", "dark", "light", "light"]);
  storage.delete(THEME_KEY);
  check(
    "nothing clears the whole store, so signing out keeps the device's choice",
    srcFiles().filter((file) => /localStorage\.clear\(/.test(stripComments(srcFile(file)))),
    [],
  );
}

process.stdout.write("\nthe switch is the drawer's last row, and it is a switch\n");
{
  const drawer = stripComments(srcFile("ui/MenuDrawer.tsx"));
  const row = between(drawer, "function DarkThemeRow()", "\n}\n");
  report("the row was found", row.length > 200, `${row.length} chars`);
  check(
    "announced as a switch with its state, and pinning the other palette",
    [/role="switch"/.test(row), /aria-checked=\{dark\}/.test(row), /onClick=\{\(\) => setTheme\(dark \? "light" : "dark"\)\}/.test(row)],
    [true, true, true],
  );
  check("it leaves the drawer open, so the repaint happens in view", /onClose|navigate\(|\bgo\(/.test(row), false);
  const list = between(drawer, '<div className="min-h-0 flex-1 overflow-y-auto px-1.5">', '<div className="shrink-0 border-t border-edge px-1.5 py-1.5">');
  check(
    "under every other row in the list, and above the parted-off Sign out",
    [list.trimEnd().endsWith("<DarkThemeRow />\n        </div>"), list.indexOf("<DarkThemeRow />") > list.indexOf("launchable.map(")],
    [true, true],
  );
  check("parted from a plugin's screens when there are any", /\{launchable\.length > 0 && <div className="my-1\.5 border-t border-edge" \/>\}\s*<DarkThemeRow \/>/.test(drawer), true);
  // Q3.209: bg-fg is a mark under a stated size, so it is the knob's and never the track's.
  const knob = /<span\s+data-keeps-motion=""\s+className=\{`([^`]*)`\}/.exec(row)?.[1] ?? "";
  check(
    "the knob is the glyph-sized mark and keeps its motion; the track only takes the state tone",
    [/\bsize-3\.5\b/.test(knob), /\bbg-fg\b/.test(knob), /\btransition-transform\b/.test(knob), (row.match(/\bbg-fg\b/g) ?? []).length, /border-edge-strong \$\{dark \? "bg-raised" : ""\}/.test(row)],
    [true, true, true, 1, true],
  );
}
