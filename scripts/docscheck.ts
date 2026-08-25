#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The regression driver for the documentation, and the only one whose subject is
 * prose.
 *
 * It exists because the last time this repository cut `CLAUDE.md` down — 301 KB
 * to 110 KB — the cut installed **no number and no check**, only
 * two qualitative sentences. Twenty-three commits over the next six days grew it
 * back to 326 KB, ~30 900 chars a day, and **not one of them made it smaller.**
 * That is this repository's own invariant read from the other end: *a property the
 * code appears to have and nothing enforces is worse than one it visibly lacks.*
 *
 * Six assertions, and every one of them was a live defect on the day it was
 * written rather than a hypothetical:
 *
 *   1. `CLAUDE.md` fits the budget. Claude Code itself warns past 150 000 chars —
 *      the string is compiled into the CLI and appears in no documentation page —
 *      and a warning printed once at session start is what the file already had in
 *      spirit while it tripled.
 *   2. That budget is written down **once**. `MAX_CLAUDE_MD_CHARS` below is the
 *      number; `CLAUDE.md` names this driver instead of restating it, for the
 *      reason `SETTING_KEYS` gives one file over — a count transcribed into prose
 *      is a count that drifts, and this file's own pointer drifted through 453 and
 *      294 before anything checked it.
 *   3. Every `Q<group>.<n>` citation resolves, in `README.md`, `CLAUDE.md`, in
 *      `.claude/rules/` and in source comments. How many there are is *printed by
 *      the run* rather than written here, for the reason item 2 gives. A citation
 *      that resolves to nothing is worse than no citation: it reads as evidence.
 *   4. Every identifier `docs/DECISIONS.md` cites greps to something. That is that
 *      file's **own stated rule** — *"Names are cited by symbol, never by line
 *      number… If a name in this file greps to nothing, that is a bug in the
 *      file"* — and nothing enforced it: **18 of the symbols cited resolve to
 *      nothing**, pinned below so the list can only shrink, against a total the
 *      run prints. One of them, `SPINNER_AFTER_MS`, turned out to describe a
 *      control that was built and withdrawn, which is what this assertion is for.
 *   5. The entry count in the index equals the headings, no number names two
 *      entries, and **every place that restates the total agrees with it** — the
 *      paragraph under the Groups table, `CLAUDE.md`, and `README.md`. It was 294
 *      against a real 509 because the stated method counted one heading depth
 *      while Q3 and Q5 live at the other — and it found **nine numbers naming two
 *      entries each**, a seam from the same assembly that left a second H1. All
 *      nine are renumbered; the assertion stays as an empty ratchet. `README.md`
 *      is why the repository *root* is in the corpus at all: it sat at 509 while
 *      the index and `CLAUDE.md` had both been corrected to 644, and no assertion
 *      here had ever read it.
 *   6. Every `paths:` glob matches a real file. This is the one failure with **no
 *      symptom at all**: a rule scoped to a path that has been renamed simply stops
 *      arriving, and nothing anywhere says so.
 *
 * Offline, one process, no network, no fleet, no agent — the same shape as every
 * other driver here:
 *   pnpm docscheck
 */

const root = new URL("../", import.meta.url);
const ROOT = fileURLToPath(root);
let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * The ceiling, and the only place it is written down.
 *
 * 150 000 is Claude Code's own: past it the CLI prints `<file> is over the
 * 150.0k-char limit (<n> chars)` and points at `/memory`. Matching it rather than
 * choosing a tighter number is deliberate — a budget somebody else also enforces
 * cannot be argued down locally — and the *report* line below prints the
 * percentage so drift is visible long before it is fatal.
 */
const MAX_CLAUDE_MD_CHARS = 150_000;

/**
 * Where a rule file may not exceed.
 *
 * This existed as `null` for exactly one commit, while PASS 1 held prose verbatim
 * and the largest rule was 41 KB. Setting it before the condensing landed would
 * have made CI red about a state the plan deliberately passes through, which is
 * how a check gets switched off rather than satisfied.
 *
 * 32 000, set when the largest rule was 26 268 — deliberately narrower headroom
 * than `CLAUDE.md`'s. The rules have grown into it since, and *how much is left is
 * printed by the report line below* rather than restated here, because a headroom
 * figure in a comment is the same second copy item 2 is about.
 * The reason a rule file needs its own ceiling at all
 * is that the bloat this driver exists to catch does not have to come back to the
 * root file to hurt: fifteen rules growing quietly is the same cost arriving
 * through fifteen doors, and it is *less* visible, because no CLI warns about it.
 */
const MAX_RULE_CHARS: number | null = 32_000;

// ---------------------------------------------------------------- the corpus

/**
 * Where this driver looks for source.
 *
 * `plugins` is the demo plugin, and it is here for two reasons rather than for
 * completeness. A rule file's `paths:` globs are matched against *this* list, so a
 * rule scoped to a directory outside it silently never arrives — which is the one
 * failure in this driver with no symptom of its own. And a symbol cited about the
 * reference plugin should resolve against the reference plugin.
 */
const SOURCE_DIRS = ["src", "scripts", "deploy", "packages", ".github", "plugins"];
/**
 * `js` is in this list for one file: a plugin's `server.js`.
 *
 * A plugin is plain JavaScript on purpose — it must not depend on this daemon's
 * toolchain — so the only executable half of the reference plugin would otherwise
 * be invisible to the symbol check while its manifest was not.
 */
const SOURCE_EXT = /\.(ts|tsx|js|sql|sh|yml|yaml|json|in|md)$/;
// `.gstack` is not part of this repository — it is a local agent-tooling
// directory that some contributors have in their checkout. Skipped so a walk
// never descends into somebody's private tooling and reports citations from it;
// harmless on a clone that has none.
const SKIP_DIR = /^(node_modules|dist|\.git|\.gstack)$/;

/**
 * The repository root's own files, which no walk of `SOURCE_DIRS` ever reached.
 *
 * `README.md` states the entry count of `docs/DECISIONS.md` — the same number the
 * Groups table totals and `CLAUDE.md` quotes — and it drifted to 509 against a real
 * 644 with every assertion here green, because the corpus simply did not contain
 * the file. That is this driver failing at its own thesis, so the fix is to widen
 * the corpus rather than to add one more special case.
 *
 * Named one file at a time rather than by listing the directory. The root also
 * holds `pnpm-lock.yaml`, whose megabyte of dependency names matches `SOURCE_EXT`
 * and would let a stale symbol "resolve" to some package's — switching assertion 4
 * off in the direction that reads as passing, which is the failure mode `SELF` is
 * already about one comment down.
 *
 * ⚠ **`SECURITY.md` was outside this list and it cost the worst documentation
 * defect in the tree.** It, `CLAUDE.md` and Q7.32 all described a control-plane
 * audit table holding "the identity of people" beside the signing key, with no
 * retention. No such table exists: `schema.sql` declares 22 tables, the package
 * contains 22 `INSERT INTO` targets, the sets match, and `relay/authorize.ts` has
 * no `INSERT` at all. Three documents agreed about a thing that was never built,
 * each making the next look corroborated — and the file a security researcher
 * opens first was the one nothing here had ever read. Assertion 4 still cannot
 * catch that particular claim, because it named no symbol; what widening the
 * corpus buys is that every *citation* in these files now has to resolve.
 */
const ROOT_FILES = ["README.md", "SECURITY.md", "THIRD-PARTY.md"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIR.test(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * This file, which may never be evidence for itself.
 *
 * Both pinned lists below name the very strings they are pinning — eighteen
 * symbols and ten Q-numbers, as string literals — so leaving this file in the
 * corpus makes every one of them resolve *to the allowlist that excuses it*, and
 * both ratchets silently invert: the debt reads as paid and a genuinely new
 * broken pointer would pass the moment somebody added it here. Measured by
 * getting it wrong first, which is the only reason this comment is this long.
 */
const SELF = join(ROOT, "scripts/docscheck.ts");

const allFiles = [
  ...SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...ROOT_FILES.map((f) => join(ROOT, f)).filter((p) => existsSync(p)),
];
const sourceFiles = allFiles.filter((p) => SOURCE_EXT.test(p) && !p.includes("/docs/") && p !== SELF);
const corpus = sourceFiles.map((p) => readFileSync(p, "utf8")).join("\n");

const decisions = read("docs/DECISIONS.md");
const claudeMd = read("CLAUDE.md");
const readme = read("README.md");

const RULES_DIR = join(ROOT, ".claude/rules");
const ruleFiles = existsSync(RULES_DIR)
  ? readdirSync(RULES_DIR).filter((f) => f.endsWith(".md")).sort()
  : [];

// ------------------------------------------------- 1 & 2: the budget

process.stdout.write("\nthe budget, and the one place it is written down\n");

const chars = claudeMd.length;
const pct = Math.round((chars / MAX_CLAUDE_MD_CHARS) * 100);
process.stdout.write(
  `  note  CLAUDE.md is ${chars.toLocaleString("en-US")} chars, ${pct}% of ${MAX_CLAUDE_MD_CHARS.toLocaleString("en-US")}\n`,
);
check(`CLAUDE.md is within ${MAX_CLAUDE_MD_CHARS.toLocaleString("en-US")} chars`, chars <= MAX_CLAUDE_MD_CHARS, true);

/*
 * That the prose does not restate the number.
 *
 * Any digit form of the ceiling appearing in `CLAUDE.md` is a second copy, and the
 * second copy is the one that goes stale — which is the exact failure the count in
 * its own DECISIONS pointer suffered twice. Written as a search for the *value*
 * rather than a fixed string so that changing `MAX_CLAUDE_MD_CHARS` cannot leave
 * this assertion checking a number nobody uses any more.
 */
const forms = [
  String(MAX_CLAUDE_MD_CHARS),
  MAX_CLAUDE_MD_CHARS.toLocaleString("en-US"),
  `${MAX_CLAUDE_MD_CHARS / 1000}k`,
  `${(MAX_CLAUDE_MD_CHARS / 1000).toFixed(1)}k`,
];
const restated = forms.filter((f) => claudeMd.includes(f));
check("CLAUDE.md does not restate the budget as a literal", restated, []);

for (const f of ruleFiles) {
  const n = readFileSync(join(RULES_DIR, f), "utf8").length;
  if (MAX_RULE_CHARS === null) continue;
  check(`.claude/rules/${f} is within ${MAX_RULE_CHARS} chars`, n <= MAX_RULE_CHARS, true);
}
if (ruleFiles.length > 0) {
  const total = ruleFiles.reduce((a, f) => a + readFileSync(join(RULES_DIR, f), "utf8").length, 0);
  const sized = ruleFiles
    .map((f) => [f, readFileSync(join(RULES_DIR, f), "utf8").length] as const)
    .sort((a, b) => b[1] - a[1]);
  const worst = sized[0] ?? (["none", 0] as const);
  const headroom =
    MAX_RULE_CHARS === null
      ? "no per-rule budget until PASS 2"
      : `${Math.round((1 - worst[1] / MAX_RULE_CHARS) * 100)}% of headroom left`;
  process.stdout.write(
    `  note  ${ruleFiles.length} rules, ${total.toLocaleString("en-US")} chars, largest ${worst[0]} at ${worst[1].toLocaleString("en-US")} (${headroom})\n`,
  );
}

// ------------------------------------------------- 3: Q-citations resolve

process.stdout.write("\nevery decision this repository cites\n");

/*
 * The trailing `[a-z]?` and the boundary are both load-bearing.
 *
 * `Q6.10a` is a real and deliberate entry — "Five events is the small case" —
 * sitting beside `Q6.10`. Without the optional letter this pattern captured
 * `Q6.10` out of both headings and reported a duplicate that does not exist,
 * which is the same defect in the other direction from the nine that did: a
 * checker that miscounts is worse than none, because its output is believed.
 * Measured by pinning `Q6.10` as known debt and then finding it was the driver's
 * own bug.
 */
const headingList = [...decisions.matchAll(/^#{3,4} (Q\d+\.\d+[a-z]?)(?= |$)/gm)]
  .map((m) => m[1])
  .filter((q): q is string => q !== undefined);
const headings = new Set(headingList);

/*
 * Empty, and it is worth saying why rather than deleting the assertion.
 *
 * The assembly that created `docs/DECISIONS.md` out of two documents — the same
 * seam that left a second H1 — did not reconcile the numbering across the join,
 * so **nine numbers named two different questions each**. `Q1.40` was both "Does
 * the pty get a stdin pipe?" and "Can an admin reset their own password without
 * giving it?".
 *
 * It was pinned rather than fixed at first, on the grounds that no citation named
 * one of the nine, so the harm was latent. That held for exactly one pass: PASS 2
 * cited six of them, from prose whose surrounding sentence disambiguated for a
 * human and not for a link, and this assertion is what caught it in the same run.
 * All nine second occurrences were renumbered onto free numbers at the end of
 * their group, and every citation — four inside `DECISIONS.md`, three in the rule
 * files — was repointed by reading which entry it actually meant.
 *
 * The list stays as an empty ratchet: a new collision fails here rather than
 * waiting for somebody to cite it.
 */
const KNOWN_DUPLICATE_NUMBERS: string[] = [];

/*
 * ⚠ **Every root document cites, and only two of them were ever read.**
 *
 * This list held `CLAUDE.md` and `README.md`, so `SECURITY.md`'s citations were
 * checked by nothing — and it is the file a security researcher opens first, the
 * same file `ROOT_FILES` above already carries a warning about. It cites two
 * entries today and both happen to resolve, which is exactly the state a citation
 * check exists to stop being luck. `ROOT_FILES` is spread rather than re-listed,
 * so a document added there is cited-checked without a second edit here.
 *
 * `CHANGELOG.md` is deliberately not in `ROOT_FILES` and therefore deliberately
 * not here — see the rule stated in that file's own header.
 */
const citers: Array<[string, string]> = [
  ["CLAUDE.md", claudeMd],
  /*
   * Not a root file, and `/docs/` is out of the source corpus, so this is the one
   * document that would otherwise cite decisions with nothing checking that they
   * resolve. It carries the release rules that used to live in `CONTRIBUTING.md`,
   * which was in `ROOT_FILES` and therefore checked; losing that on a file move
   * is exactly the silent kind of gap this driver exists for.
   */
  ["docs/RELEASING.md", read("docs/RELEASING.md")],
  ...ROOT_FILES.filter((f) => existsSync(join(ROOT, f))).map((f) => [f, read(f)] as [string, string]),
  ...ruleFiles.map((f) => [`.claude/rules/${f}`, readFileSync(join(RULES_DIR, f), "utf8")] as [string, string]),
  ...sourceFiles
    .filter((p) => /\.(ts|tsx)$/.test(p))
    .map((p) => [relative(ROOT, p), readFileSync(p, "utf8")] as [string, string]),
];

const dangling: string[] = [];
let cited = 0;
for (const [where, text] of citers) {
  for (const m of text.matchAll(/\bQ\d+\.\d+[a-z]?\b/g)) {
    cited += 1;
    const q = m[0];
    if (!headings.has(q)) dangling.push(`${q} (${where})`);
  }
}
process.stdout.write(`  note  ${cited} citations across ${citers.length} files, ${headingList.length} headings to resolve against\n`);
check("every Q-citation names a real entry", dangling, []);

// ------------------------------------------------- 4: identifiers grep

process.stdout.write("\nevery symbol the decision record cites\n");

/*
 * Names from outside this repository, which the rule cannot be about.
 *
 * Kept as an explicit list rather than by also searching `node_modules`: the point
 * of the rule is that a name greps to *our* code, and widening the corpus to every
 * dependency would let a stale internal name pass because some package happens to
 * export the same word. Each entry says where it really comes from.
 */
const FOREIGN = new Set([
  "API_KEY_INVALID", // gemini's error string, quoted in the session/authenticate entry
  "AvailableCommandInput", // the ACP schema's own type name, quoted from the spec
  "CLAUDE_CONFIG_DIR", // claude's own env var, named as the remedy for a bypassed permission path
  "PreToolUse", // a Claude Code hook name
  "TodoWrite", // claude's own tool
  "WINDOW_UPDATE", // an HTTP/2 frame type
  "approvalPolicy", // codex's own session field
  "sandboxPolicy", // codex's own session field
  "clientWidth", // the DOM
  "translateY", // CSS
  "recvBuf", // `yamux-js` internals, in the entry about its broken flow control
  "resOnFinish", // likewise
  "sendWindowUpdate", // likewise
  "readStart", // Node's own `StreamBase`, in the entry about the stream window it credits
  "readStop", // likewise — the half that is wired to an event, where its pair is not
  "isTaskTool", // the adapter's function, not ours — the entry says so explicitly
  "REEMOAT_AGENTS", // an env var that was proposed and never built; the entry says so
]);

/*
 * Cited by `docs/DECISIONS.md` and greps to nothing in this repository.
 *
 * By that file's own rule — *"Names are cited by symbol, never by line number.
 * Line numbers rot; a symbol you can `grep` for does not. If a name in this file
 * greps to nothing, that is a bug in the file"* — every one of these is a bug, and
 * nothing had ever asked. They are not all the same kind: some are renames the
 * record did not follow, some are third-party names that belong in `FOREIGN` once
 * somebody confirms where they come from, and some may be functions that were
 * planned and never written. **Triaging them is outstanding work**, so they are
 * pinned rather than classified, and pinned by equality so the list can only
 * shrink: a new broken pointer fails, and fixing one fails until it leaves here.
 *
 * Recorded 2026-08-14. How many symbols are cited in total is printed by the run
 * rather than written down here: it grows with the file, while this list may only
 * shrink, so pinning the two together would make every new entry look like debt.
 */
const CITED_BUT_UNRESOLVED = [
  "PrefixPattern", "SPINNER_AFTER_MS", "checkAndFail", "completeCommandExecutionEvent",
  "detectSlashIntent", "elapsedTimeSeconds", "formatUserCode", "looksBinary", "nextStep",
  "remainingText", "scheduleAvailableCommandsUpdate", "sessionDir", "subagentRetry",
  "subagentType", "supportsEffort", "toolDetail", "totalDurationMs", "workDir",
];

/** camelCase, PascalCase or CONST_CASE, five characters or more. */
const IDENT = /^(?:[A-Za-z_$][A-Za-z0-9_$]*)$/;
const looksLikeSymbol = (s: string) =>
  s.length >= 5 && IDENT.test(s) && (/[a-z][A-Z]/.test(s) || (/^[A-Z0-9_]+$/.test(s) && s.includes("_")));

const symbols = new Set<string>();
for (const m of decisions.matchAll(/`([^`\n]+)`/g)) {
  const t = (m[1] ?? "").trim();
  if (looksLikeSymbol(t)) symbols.add(t);
}

const unresolved = [...symbols].filter((s) => !FOREIGN.has(s) && !corpus.includes(s)).sort();
process.stdout.write(`  note  ${symbols.size} symbols cited, ${sourceFiles.length} source files searched\n`);
check("no symbol cited in DECISIONS.md greps to nothing, beyond the known set", unresolved, [...CITED_BUT_UNRESOLVED].sort());
if (unresolved.length > 0) {
  process.stdout.write(`  debt  ${unresolved.length} cited symbols still resolve to nothing; see CITED_BUT_UNRESOLVED\n`);
}

// ------------------------------------------------- 5: the index is true

process.stdout.write("\nthe index, against the headings it describes\n");

/*
 * Counted over the headings rather than the distinct numbers, which differ by the
 * nine duplicates above. An entry is a heading — two entries sharing a number are
 * still two entries, and saying 499 would undercount the file to make a defect
 * disappear into a total.
 */
const perGroup = new Map<string, number>();
for (const q of headingList) {
  const g = q.split(".")[0] ?? q;
  perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
}

const seen = new Set<string>();
const duplicated = new Set<string>();
for (const q of headingList) (seen.has(q) ? duplicated : seen).add(q);
check("no Q-number names two entries, beyond the known set", [...duplicated].sort(), [...KNOWN_DUPLICATE_NUMBERS].sort());

/* And that none of them is actually cited, which is what makes the debt latent. */
const ambiguous = [...new Set(citers.flatMap(([, t]) => [...t.matchAll(/\bQ\d+\.\d+[a-z]?\b/g)].map((m) => m[0])))]
  .filter((q) => duplicated.has(q))
  .sort();
check("no citation names a duplicated number", ambiguous, []);

/*
 * The `| **Q1** | … | 55 | `###` |` rows of the Groups table.
 *
 * The group cell is matched **with or without a link wrapper**, because that
 * table is also the document's table of contents: each group links to its own H2
 * section, so the cell reads `[**Q1**](#identity-reachability-and-trust)`. This
 * pattern required the bare form and answered "the index names no groups at all"
 * the moment the links were added — a failure that reads as the index having been
 * deleted rather than as this regex being narrower than the table.
 */
const indexed = new Map<string, number>();
for (const m of decisions.matchAll(/^\|\s*\[?\*\*(Q\d+)\*\*\]?(?:\([^)]*\))?\s*\|[^|]*\|\s*(\d+)\s*\|/gm)) {
  if (m[1] !== undefined) indexed.set(m[1], Number(m[2]));
}

check("the index names every group that has entries", [...perGroup.keys()].sort(), [...indexed.keys()].sort());
for (const [g, n] of [...indexed].sort()) check(`the index count for ${g}`, n, perGroup.get(g) ?? 0);

const statedTotal = /\|\s*\|\s*\|\s*\*\*(\d+)\*\*\s*\|/.exec(decisions);
check("the index states a total", statedTotal !== null, true);
if (statedTotal) check("the stated total is the real one", Number(statedTotal[1] ?? -1), headingList.length);

/*
 * And the paragraph six lines under the table, whose entire job is explaining that
 * total: *"it says 644 rather than the 369 that reading one depth gives"*. Both
 * halves are assertable and neither was asserted, so it sat at "629 rather than the
 * 294" — two numbers, both stale, in the one paragraph a reader goes to when the
 * total looks wrong. The second half is the count at `###` alone, which is exactly
 * the mistake the paragraph exists to describe, so it is derived here the wrong way
 * on purpose.
 */
const shallowHeadings = [...decisions.matchAll(/^### (Q\d+\.\d+[a-z]?)(?= |$)/gm)].length;
const explained = /it says (\d+) rather than the (\d+)\b/.exec(decisions);
check("the paragraph under the table explains a total", explained !== null, true);
if (explained) {
  check("the explained total is the real one", Number(explained[1] ?? -1), headingList.length);
  check("the one-depth count it contrasts with is the real one", Number(explained[2] ?? -1), shallowHeadings);
}

/* And that CLAUDE.md, which quotes the same number, agrees with it. */
const inClaudeMd = /`docs\/DECISIONS\.md`\*\*\s*—\s*(\d+)\s*entries/.exec(claudeMd);
check("CLAUDE.md quotes an entry count", inClaudeMd !== null, true);
if (inClaudeMd) check("CLAUDE.md's entry count is the real one", Number(inClaudeMd[1] ?? -1), headingList.length);

/*
 * And README.md, which states it a fourth time, in the documentation table.
 *
 * This is the one that drifted: 509 against a real 644, with `CLAUDE.md` and the
 * index both correct and both asserted. Nothing had read this file — see
 * `ROOT_FILES`.
 */
const inReadme = /`docs\/DECISIONS\.md`[^\n]*?\b(\d+)\s+entries/.exec(readme);
check("README.md quotes an entry count", inReadme !== null, true);
if (inReadme) check("README.md's entry count is the real one", Number(inReadme[1] ?? -1), headingList.length);

/*
 * And the one that was still outside this, which is the same defect a third time.
 *
 * The comment at the head of this driver claims assertion 5 covers "every place
 * that restates the total". It did not: `CONTRIBUTING.md` and the issue template's
 * `config.yml` both quoted the number, both were correct, and neither was read.
 * `CONTRIBUTING.md` has since been deleted and its release half moved to
 * `docs/RELEASING.md`, which restates no total; `config.yml` still does, and is
 * asserted here by the same pattern against the same number, so the claim in the
 * header stays true.
 */
for (const [where, text, pattern] of [
  [".github/ISSUE_TEMPLATE/config.yml", read(".github/ISSUE_TEMPLATE/config.yml"), /\b(\d+)\s+entries/],
] as const) {
  const found = pattern.exec(text);
  check(`${where} quotes an entry count`, found !== null, true);
  if (found) check(`${where}'s entry count is the real one`, Number(found[1] ?? -1), headingList.length);
}

// ------------------------------------------------- the counts about the code

process.stdout.write("\nthe counts this documentation states about the code\n");

/*
 * `README.md` says the HTTP surface is 94 routes and `docs/API.md` says 36 and
 * 58. All three were right and all three were asserted by nothing — a number in
 * prose about code that moves, which is the category this driver exists for. The
 * entry count above drifted to 509 for want of exactly this.
 *
 * Counted on `app.<verb>(` at the start of a line, which is how both services
 * register. Deliberately not a looser identifier: `registry.get(` in `server.ts`
 * and `healthRead.get(` in `app.ts` are a Map read and a handler, and a pattern
 * loose enough to catch them would count two routes that do not exist.
 */
const ROUTE = /^\s*app\.(get|post|put|patch|delete|all)\(/gm;
const countRoutes = (rel: string): number => [...read(rel).matchAll(ROUTE)].length;

const daemonRoutes = countRoutes("src/server.ts");
const cpRoutes = countRoutes("packages/control-plane/src/app.ts");
process.stdout.write(`  note  ${daemonRoutes} daemon routes, ${cpRoutes} control-plane routes\n`);

const api = read("docs/API.md");
const apiDaemon = /^## The daemon — (\d+) routes$/m.exec(api);
const apiCp = /^## The control plane — (\d+) routes$/m.exec(api);
check("docs/API.md names a daemon route count", apiDaemon !== null, true);
if (apiDaemon) check("and it is the real one", Number(apiDaemon[1] ?? -1), daemonRoutes);
check("docs/API.md names a control-plane route count", apiCp !== null, true);
if (apiCp) check("and it is the real one", Number(apiCp[1] ?? -1), cpRoutes);

const readmeRoutes = /`docs\/API\.md`[^\n]*?\b(\d+)\s+routes/.exec(readme);
check("README.md quotes a route total", readmeRoutes !== null, true);
if (readmeRoutes) {
  check("README.md's route total is both services added up", Number(readmeRoutes[1] ?? -1), daemonRoutes + cpRoutes);
}

/* One H1: the second was a seam left by the assembly that created this file. */
check("DECISIONS.md has exactly one H1", (decisions.match(/^# /gm) ?? []).length, 1);

// ------------------------------------------------- 6: rules that can load

process.stdout.write("\nevery rule, and whether it can ever arrive\n");

check("there are rule files at all", ruleFiles.length > 0, true);

const repoFiles = allFiles.map((p) => relative(ROOT, p));
/** The subset of glob syntax these rules use: `*` within a segment, `**` across. */
function globToRe(g: string): RegExp {
  const re = g
    .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/*", "\0")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${re}(?:/.*)?$`);
}

const deadGlobs: string[] = [];
let globCount = 0;
for (const f of ruleFiles) {
  const text = readFileSync(join(RULES_DIR, f), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) {
    failures += 1;
    process.stdout.write(`  FAIL  .claude/rules/${f} has no frontmatter\n`);
    continue;
  }
  const globs = [...(fm[1] ?? "").matchAll(/^\s*-\s+(.+?)\s*$/gm)]
    .map((m) => m[1])
    .filter((g): g is string => g !== undefined);
  if (globs.length === 0) {
    failures += 1;
    process.stdout.write(`  FAIL  .claude/rules/${f} declares no paths:, so it loads on every session\n`);
    continue;
  }
  for (const g of globs) {
    globCount += 1;
    const re = globToRe(g);
    if (!repoFiles.some((p) => re.test(p))) deadGlobs.push(`${g} (${f})`);
  }
}
process.stdout.write(`  note  ${ruleFiles.length} rules, ${globCount} globs, ${repoFiles.length} files to match against\n`);
check("every paths: glob matches a real file", deadGlobs, []);

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
