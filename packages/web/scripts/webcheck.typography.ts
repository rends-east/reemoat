import { readFileSync, readdirSync } from "node:fs";

import { check, report, skip } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";

/*
 * The two families, the scale, and the one copy of both that lives somewhere else.
 *
 * Nothing checked any of this before. A third `font-family`, a webfont, a size
 * written as `text-[13px]` or a stack edited on one side of the landing page and
 * not the other passed `typecheck` and all seven other drivers in silence — which
 * is the whole reason the rule this pins had to be *found* by counting rather than
 * read anywhere. `.claude/rules/web-typography.md` is that rule; Q3.579 is the
 * argument.
 */

const WEB_SRC = new URL("../src/", import.meta.url);
const cssRaw = readFileSync(new URL("index.css", WEB_SRC), "utf8");
const css = stripComments(cssRaw);

process.stdout.write("\nthe two families this app has, and the ones it must not grow\n");
{
  /*
   * Comments stripped, because `--font-sans`'s own docblock is thirty lines about
   * faces this app does *not* ship and names several of them.
   */
  const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());

  check("the stylesheet declares exactly two font families", families.length, 2);
  /*
   * By value and in order, which is stricter than counting two of them: a literal
   * stack written in place of the token is the drift this is for, and it would
   * keep the count at two. `body` first, `pre, code, kbd` second.
   */
  check("and both are tokens rather than stacks", families, ["var(--font-sans)", "var(--font-mono)"]);

  /*
   * ⚠ **The HTML is stripped of *HTML* comments, never of `//`.** `stripComments`
   * is written for TypeScript, where `//` starts a comment; in markup it starts
   * the authority of every absolute URL. Running it here would delete the rest of
   * the line after `https:` — including, precisely, a
   * `https://fonts.googleapis.com` this assertion exists to find. The negative
   * check would then pass *because* the evidence was removed.
   */
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replaceAll(
    /<!--[\s\S]*?-->/g,
    "",
  );
  const WEBFONT = /@font-face|googleapis|gstatic|\.woff/i;

  // A control for the paragraph above: the pattern does find one when there is one.
  check("the webfont pattern matches a webfont", WEBFONT.test('@import url("//fonts.googleapis.com/x");'), true);
  /*
   * ⚠ **`cssRaw`, and the paragraph above is the reason — it was written for the
   * HTML and the CSS was left on the stripped text anyway.** `//` opens a comment
   * in TypeScript and opens the authority of a URL everywhere else, and a
   * stylesheet is the second place. Measured: `@import
   * url("https://fonts.googleapis.com/css2?family=Inter")` survives `WEBFONT`
   * raw and becomes `@import url("https:` after `stripComments`, so three of this
   * pattern's four arms — `googleapis`, `gstatic`, and any absolute `.woff` —
   * could not match. Only an inline `@font-face` block was still being caught,
   * which is not how a webfont ordinarily arrives.
   *
   * Comments are not a hiding place here the way they are for the family sweep
   * below: `--font-sans`'s docblock names faces this app does not ship, but it
   * names none of these four strings.
   */
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
  /*
   * The scale exists *because* `text-[11px]` and `text-[10px]` were scattered
   * through every component with no relationship between them — `index.css` says
   * so at the top of the block. One survivor is left, and it is named here rather
   * than tolerated: the `md` ratchet's trick, which is to write the exception down
   * so the next one cannot hide behind it.
   */
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

  // A sweep that found nothing to sweep passes silently — the failure mode of
  // every source-text assertion in this driver.
  report("there are files to sweep at all", sources.length >= 50, `${sources.length} files under src/`);
  check("the sweep can see an arbitrary size", ARBITRARY.test('className="text-[11px]"'), true);
  check("no size is written outside the scale, beyond the one named exception", found, ALLOWED);

  /*
   * And the scale itself is six steps. Not a style rule — a floor under the
   * assertion above, which would go quiet if the tokens were renamed out from
   * under Tailwind and every `text-2xs` in the app stopped resolving.
   */
  const steps = [...css.matchAll(/--text-([a-z0-9]+):\s*([^;]+);/g)].map((m) => m[1]);
  check("the scale is the six steps the rule describes", steps, ["2xs", "xs", "sm", "base", "lg", "xl"]);
}

process.stdout.write("\nthe three caps constants, and the colour that may not be appended\n");
{
  /*
   * **A colour appended to one of the three heading constants is a silent no-op,
   * and this is the sweep the rule said existed.**
   *
   * Each constant already carries a colour — `SETTINGS_HEADING` is `text-muted`,
   * `MENU_HEADING` is `text-faint`, `FIELD_LABEL` is `text-muted` — so
   * `` `${SETTINGS_HEADING} text-faint` `` puts two members of one family on one
   * element and lets Tailwind's emission order decide, not the line. It reads as a
   * choice and is not one. `MachineSection`'s `RETIRE_HEADING` and `AgentBuilder`'s
   * `HIDDEN_PROVIDER_HEADING` are spelled out for exactly this reason.
   *
   * ⚠ **`.claude/rules/web-typography.md` claimed this sweep before it existed**,
   * and `AgentBuilder.tsx` was carrying a live instance the whole time — a heading
   * that had rendered `text-muted` for four releases while asking for `text-faint`,
   * louder than the caption under it. A rule that names its own enforcement has to
   * have some, or the sentence is the thing being trusted.
   *
   * Comments are stripped first, so the two docblocks that *quote* the forbidden
   * form in order to forbid it are not findings.
   */
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

  /*
   * Every template literal that interpolates one of the three, tested whole. A
   * class string never contains a backtick, so `` `[^`]*` `` is the literal and
   * nothing nests.
   */
  const composed: string[] = [];
  let interpolations = 0;
  for (const { file, text } of sources) {
    for (const literal of text.match(/`[^`]*`/g) ?? []) {
      if (!CAPS.some((name) => literal.includes(`\${${name}}`))) continue;
      interpolations += 1;
      if (COLOUR.test(literal)) composed.push(`${file}: ${literal}`);
    }
  }

  /*
   * How many call sites write `font-mono` by hand, printed rather than asserted.
   *
   * The rule used to state this as a number — *38* — and it was wrong within the
   * change that wrote it, because two more arrived three files away. An exact
   * assertion would be worse than the prose: every legitimate new mono would
   * redden the build. A `note` is what `docscheck` does with its rule and glob
   * counts, and it is the shape that cannot go stale.
   */
  const monos = sources.reduce((total, { text }) => total + (text.match(/font-mono/g) ?? []).length, 0);
  report("mono is written at a call site this many times", monos > 0, `${monos} call sites`);

  // Two floors, because a sweep that found nothing to sweep passes silently and a
  // pattern that cannot match anything passes silently too.
  report("the constants are composed somewhere at all", interpolations >= 5, `${interpolations} interpolations`);
  check("the sweep can see an appended colour", COLOUR.test("`${SETTINGS_HEADING} mb-1.5 text-faint`"), true);
  check("and does not fire on layout beside one", COLOUR.test("`mt-3 block ${SETTINGS_HEADING}`"), false);
  check("no colour is appended to a heading constant", composed, []);
}

process.stdout.write("\nevery site of the caps idiom, and the ones that are outside the constants\n");
{
  /*
   * **A census, because the rule was carrying a count and a count cannot see a
   * skipped item.**
   *
   * `.claude/rules/web-typography.md` said "*four* sites spend the idiom outside
   * the constants **on purpose**, and every one of them says so at the code", and
   * then named four. That sentence was the only record of the set, and it went
   * wrong the first time somebody added a fifth: `MenuDrawer`'s `DRAWER_HEADING`
   * arrived with its own docblock arguing for itself, every driver stayed green —
   * the sweep one block up only looks for a *colour appended to a constant* — and
   * the rule went on saying four. Prose that nothing differences is prose that
   * drifts, which is the same failure `SETTINGS_HEADING`'s own count had (Q5.115)
   * and the reason that one is a `report` rather than a number.
   *
   * So the list lives here and the rule cites it. This differences **two
   * derivations**: every `tracking-wider` under `packages/web/src`, read off the
   * files, against the table below. A sixth site reddens this as "found, not
   * listed"; a fifth deleted reddens it as "listed, not found". Neither is
   * reachable by a `length === N` over the same sweep, which is what a count is.
   *
   * ⚠ **Comments are stripped, and that is load-bearing rather than tidy.**
   * `bits.tsx` and `SessionBrowser.tsx` each *quote* the idiom in a docblock — one
   * to say what the trio is, the other to record the folder header that lost it —
   * so over raw text both files would be findings with a count one too high, and
   * the table would have to be wrong to match. The two controls below assert
   * exactly that difference rather than trusting it.
   */
  type Site = { file: string; hits: number; constant: boolean; anchor: string; why: string };

  /*
   * The three constants first. `FIELD_LABEL` is the one that surprises a reader of
   * the rule: it is a constant rather than an exception, and it lives beside the
   * form control that uses it rather than in `bits.tsx` with the other two.
   */
  const SITES: Site[] = [
    { file: "ui/bits.tsx", hits: 2, constant: true, anchor: "", why: "MENU_HEADING and SETTINGS_HEADING" },
    { file: "ui/settings/SettingField.tsx", hits: 1, constant: true, anchor: "", why: "FIELD_LABEL, the third constant" },
    {
      file: "ui/SessionBrowser.tsx",
      hits: 1,
      constant: false,
      anchor: 'text-2xs font-semibold tracking-wider text-fg uppercase',
      why: "the waiting-elsewhere band, at text-fg — louder than the rows under it on purpose",
    },
    {
      file: "ui/settings/MachineSection.tsx",
      hits: 1,
      constant: false,
      anchor: "const RETIRE_HEADING =",
      why: "text-danger, written out rather than composed onto SETTINGS_HEADING",
    },
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
  // A sweep that found nothing to sweep passes silently, so the floor is first.
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

  /*
   * The two controls for the paragraph about stripping: each of these files really
   * does quote the idiom in prose, so the raw count is higher than the counted one
   * — which is what makes the table's numbers the code's rather than the docs'.
   */
  for (const file of ["ui/bits.tsx", "ui/SessionBrowser.tsx"]) {
    const raw = srcFile(file);
    report(
      `${file} quotes the idiom in a comment, so stripping is what keeps the count honest`,
      hitsIn(raw) > hitsIn(stripComments(raw)),
      `${hitsIn(raw)} raw against ${hitsIn(stripComments(raw))} in code`,
    );
  }

  /*
   * **And the other half of the rule's sentence: every exception *says so at the
   * code*.** A list of five files is a list of five places somebody chose not to
   * use a constant; what keeps that from becoming five accidents is the argument
   * written beside each. So the site is located by an anchor of its own and a
   * comment is required to close immediately above it.
   *
   * ⚠ **`indexOf` guarded before the slice.** A missing anchor gives -1, and
   * `slice(-1 - 600, -1)` would read the *end* of the file and quite possibly find
   * a comment terminator there — the widening-slice false-green this repository has
   * measured four times. The anchor's absence is its own failing check, and the gap is only
   * computed when it was found.
   */
  for (const site of SITES.filter((s) => !s.constant)) {
    const raw = srcFile(site.file);
    const at = raw.indexOf(site.anchor);
    check(`${site.file}: the site the rule names is there exactly once`, [at >= 0, at === raw.lastIndexOf(site.anchor)], [true, true]);
    const before = at < 0 ? "" : raw.slice(0, at);
    const closes = before.lastIndexOf("*/");
    /*
     * 80 characters: measured, the five gaps are 3, 3, 3, 3 and 39 — a docblock
     * ending on the line above a `const`, or a `{/* … *\/}` above the element. A
     * generous bound would pass on a comment about something else entirely.
     */
    report(
      `${site.file}: and it says why it is outside the constants, at the code`,
      closes >= 0 && before.length - closes <= 80,
      site.why,
    );
    check(`${site.file}: a comment closes immediately above it`, closes >= 0 && before.length - closes <= 80, true);
  }
}

process.stdout.write("\nevery path this app draws, at the one size a path is drawn at\n");
{
  /*
   * ⚠ **A mono run does not inherit the size of the sans line it sits in.** Mono
   * reads larger than sans at an equal nominal size, so `font-mono` with no size
   * of its own takes the line's number and renders a step above it. Measured the
   * expensive way: the session row's subpath inherited `text-xs` from its subline
   * and came out level with the row's own `text-sm` title — reported as "the
   * folder name is the size of the session name", which is a hierarchy failure
   * rather than a font one.
   *
   * `text-2xs` is the floor for a path, and these **five** are every place one is
   * drawn. Two carry the size themselves; three inherit a line that is already
   * `text-2xs`, so those are asserted on the line rather than on the span.
   *
   * ⚠ **It said four, and the fifth shipped past it** — the agents screen's
   * provenance line, which interpolated an absolute `settings.json` path straight
   * into a sans sentence. A count in prose is not a census: nothing here derives
   * the list, so a new path is caught only by somebody reading this paragraph.
   * That is the standing limitation of this block and is why each entry is a pair
   * rather than a single `.test`.
   */
  const read = (rel: string): string =>
    stripComments(readFileSync(new URL(rel, WEB_SRC), "utf8"));

  /*
   * ⚠ **Anchored on the crumb's own `className`, because a bare `font-mono
   * text-2xs` matched something else.** `NewSession.tsx` draws a `loading…`
   * placeholder at that pair twenty-six lines above the crumbs, and `.test()`
   * stops at the first hit — so both the family and the step could have come off
   * every crumb in the picker and this check would still have printed ok. The
   * pattern names the interactive element instead: `tap` and `min-h-11` belong to
   * the crumb button and to nothing else on the line.
   */
  const carried: [string, RegExp][] = [
    // the picker's breadcrumbs, and the row's subpath under a folder
    ["the directory picker's crumbs", /tap -my-2 inline-flex min-h-11 items-center font-mono text-2xs/],
  ];
  for (const [name, pattern] of carried) {
    check(`${name} state their own size`, pattern.test(read("ui/NewSession.tsx")), true);
    // A control, so the anchor cannot go quiet the way the bare pair did: the
    // element is there to be found at all.
    check(`${name} were found as an element, not as a pair of classes`, /tap -my-2 inline-flex min-h-11/.test(read("ui/NewSession.tsx")), true);
  }

  /*
   * ⚠ **The session row is the exemption, and it is asserted as a pair.** Its
   * subline is sans at `text-2xs` — one family and one size for the agent, the
   * machine and the path together. Mono was tried here and taken back out twice:
   * at `text-xs` it drew level with the row's own `text-sm` title, and at
   * `text-2xs` it still fit about a fifth fewer characters into the tightest slot
   * in the app, which is a row whose whole job is to be scanned.
   *
   * The negative half is the one that matters and it is the one that would go
   * quiet alone: a `text-2xs` assertion says nothing about the family, and a
   * "no font-mono" assertion passes on a file where the subline was deleted. So
   * the size, the absence of mono, and the subpath still being drawn at all are
   * one check.
   */
  {
    const browser = read("ui/SessionBrowser.tsx");
    const subline = /<div className="mt-0\.5 truncate text-2xs text-muted">([\s\S]*?)<\/div>/.exec(browser);
    check("the session row's subline was found", subline !== null, true);
    check(
      "and it is sans, at one size, with the path still on it",
      [
        subline !== null && /\bfont-mono\b/.test(subline[1] ?? ""),
        subline !== null && /`? · \$\{subpath\}`?/.test(subline[1] ?? ""),
      ],
      [false, true],
    );
  }
  check(
    "a diff's file path is drawn at the same step",
    /truncate font-mono text-2xs/.test(read("ui/DiffView.tsx")),
    true,
  );

  /*
   * The two that inherit. Asserted as a pair — the mono span exists *and* the line
   * carrying it is `text-2xs` — because either half alone goes quiet: a span with
   * no size passes a size check trivially, and a `text-2xs` line proves nothing if
   * the path stopped being mono.
   */
  check(
    "the session header's path is mono, on a subtitle line that is already text-2xs",
    [
      /<span className="truncate font-mono" title=\{where\}>/.test(read("ui/SessionView.tsx")),
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

  /*
   * ⚠ **The fifth, and it is three runs on one line rather than one.** The agents
   * screen says where a claude session's opening mode came from, and the sentence
   * carries a settings **key**, the **value** written against it and a **path** —
   * three of the four things `web-typography.md`'s mono list names, in what was a
   * single sans template string. Asserted as the same pair the two above are, plus
   * that the path goes through `paths.ts` rather than being interpolated raw:
   * `shortPath` and not `displayCwd`, because this file sits under no browse root
   * and this screen fetches none.
   */
  check(
    "the agents screen's provenance line is mono where it quotes the machine, on a text-2xs line",
    [
      /<span className="font-mono">permissions\.defaultMode<\/span>/.test(read("ui/settings/MachineAgentsSection.tsx")),
      /<span className="font-mono">\{settingsMode\.value\}<\/span>/.test(read("ui/settings/MachineAgentsSection.tsx")),
      /<span className="font-mono">\{shortPath\(settingsMode\.file\)\}<\/span>/.test(read("ui/settings/MachineAgentsSection.tsx")),
      /className="mt-2 text-2xs text-muted wrap-anywhere" title=\{settingsMode\.file\}/.test(read("ui/settings/MachineAgentsSection.tsx")),
    ],
    [true, true, true, true],
  );
  // The negative that makes the three above a rule: no raw path left in the prose.
  check(
    "and the file is never interpolated into the sentence raw",
    /from \$\{settingsMode\.file\}/.test(read("ui/settings/MachineAgentsSection.tsx")),
    false,
  );
}

process.stdout.write("\nthe other copy of both stacks, in a repository this one does not contain\n");
{
  /*
   * ⚠ **`services/landing/index.html` is a hand-copy of the two stacks and of five
   * of the six scale steps, and it is in the *other* repository.** `app/` is
   * `rends-east/reemoat` and going public; `services/` is the private
   * `rends-east/reemoat-prod`, whose `.gitignore` excludes `/app/`. CI checks out
   * one of them, so this comparison runs on a development box and on the stand and
   * nowhere else.
   *
   * That makes the **skip** the important half, not the comparison — the same
   * argument the plugin catalogue mirror makes one file over. A skip that printed
   * `ok` would be a green tick about work nobody did, on every push. Q7.133.
   */
  const ORIGINAL = new URL("../../../../services/landing/index.html", import.meta.url);
  let landing: string | null = null;
  try {
    landing = readFileSync(ORIGINAL, "utf8");
  } catch {
    // Absent is the ordinary state in CI and a real answer, not a failure.
    landing = null;
  }

  if (landing === null) {
    skip(
      "the landing is not on this disk, so its copy of both stacks is unchecked",
      "services/landing/index.html — expected in CI, a problem on the box",
    );
  } else {
    const stackOf = (text: string, name: string): string | null => {
      const found = new RegExp(`--font-${name}:\\s*([^;]+);`).exec(text);
      // Whitespace only: the landing wraps the same list at a different column.
      return found === null ? null : (found[1] ?? "").replaceAll(/\s+/g, " ").trim();
    };

    for (const name of ["sans", "mono"]) {
      const ours = stackOf(css, name);
      const theirs = stackOf(landing, name);
      /*
       * Unreadable is a failure rather than a skip once the file *is* on this
       * disk: a declaration this cannot find means the shape moved under the
       * pattern, which is exactly when the comparison is worth most and exactly
       * when it would otherwise fall silent.
       */
      check(`--font-${name} was found on both sides`, [ours !== null, theirs !== null], [true, true]);
      if (ours !== null && theirs !== null) check(`and the landing's --font-${name} is this one`, theirs, ours);
    }

    /*
     * The scale is compared as a **subset**, not for equality: the landing tops out
     * at `--text-lg` and has no `--text-xl`, legitimately — it draws no pop-up over
     * a list. Equality here would fail on a difference that is correct, which is
     * how a check earns being switched off.
     */
    const scaleOf = (text: string): Map<string, string> =>
      new Map([...text.matchAll(/--text-([a-z0-9]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
    const ours = scaleOf(css);
    const theirs = scaleOf(landing);

    report("the landing names a scale at all", theirs.size >= 4, `${theirs.size} steps against this app's ${ours.size}`);
    const wrong: string[] = [];
    for (const [step, value] of theirs) {
      const mine = ours.get(step);
      if (mine === undefined) wrong.push(`--text-${step}: the landing has it and this app does not`);
      else if (mine !== value) wrong.push(`--text-${step}: landing ${value}, app ${mine}`);
    }
    check("every step the landing names is this app's step, at this app's value", wrong, []);
  }
}
