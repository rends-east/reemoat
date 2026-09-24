#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Holds the documentation to what it claims: the CLAUDE.md budget, Q-citations, DECISIONS.md symbols against source, the index counts, and rule globs. */

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

/** The only copy of the ceiling, matching the limit at which Claude Code itself warns. */
const MAX_CLAUDE_MD_CHARS = 150_000;

/** Per-rule ceiling. Raised by small steps, not to a round number: a rule at the wall usually wants splitting by subject. */
const MAX_RULE_CHARS: number | null = 34_000;

/** Rule paths: globs are matched against these too, so a directory outside the list can never be scoped. */
const SOURCE_DIRS = ["src", "scripts", "deploy", "packages", ".github", "plugins"];
// rs is safe only because SKIP_DIR skips target; toml is out because Cargo.lock would let stale symbols resolve.
const SOURCE_EXT = /\.(ts|tsx|js|mjs|rs|sql|sh|yml|yaml|json|in|md)$/;
// target holds gigabytes of build metadata that would let stale symbols resolve; gen is walked because gen/android is hand-edited source.
const SKIP_DIR = /^(node_modules|dist|target|\.git|\.gstack)$/;

/** Generated directories, skipped by position: gen/schemas, gen/apple, and the Gradle build trees gen/android/.gitignore names. */
const SKIP_PATH =
  /^packages\/native\/src-tauri\/gen\/(?:schemas|apple)$|^packages\/native\/src-tauri\/gen\/android\/(?:.*\/)?(?:build|\.gradle|\.kotlin)$/;

/** Named one at a time: listing the root would take in pnpm-lock.yaml and let stale symbols resolve to package names. */
const ROOT_FILES = ["README.md", "SECURITY.md", "THIRD-PARTY.md"];

/** SKIP_PATH is tested only on directories, so a file named build is still source. */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIR.test(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (SKIP_PATH.test(relative(ROOT, p))) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

/** Excluded from the corpus, or its pinned lists would resolve against themselves. */
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

process.stdout.write("\nthe budget, and the one place it is written down\n");

const chars = claudeMd.length;
const pct = Math.round((chars / MAX_CLAUDE_MD_CHARS) * 100);
process.stdout.write(
  `  note  CLAUDE.md is ${chars.toLocaleString("en-US")} chars, ${pct}% of ${MAX_CLAUDE_MD_CHARS.toLocaleString("en-US")}\n`,
);
check(`CLAUDE.md is within ${MAX_CLAUDE_MD_CHARS.toLocaleString("en-US")} chars`, chars <= MAX_CLAUDE_MD_CHARS, true);

// Any digit form of the ceiling in CLAUDE.md is a second copy; searched by value so changing the constant keeps this honest.
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

process.stdout.write("\nevery decision this repository cites\n");

// The optional letter and the boundary are load-bearing: Q6.10a is a real entry beside Q6.10.
const headingList = [...decisions.matchAll(/^#{3,4} (Q\d+\.\d+[a-z]?)(?= |$)/gm)]
  .map((m) => m[1])
  .filter((q): q is string => q !== undefined);
const headings = new Set(headingList);

// Empty ratchet: a new numbering collision fails here before anybody cites it.
const KNOWN_DUPLICATE_NUMBERS: string[] = [];

// ROOT_FILES is spread in, so a document added there is citation-checked with no second edit; CHANGELOG.md is deliberately out.
const citers: Array<[string, string]> = [
  ["CLAUDE.md", claudeMd],
  // Under /docs/, so outside the corpus: listed so its citations are still checked.
  ["docs/RELEASING.md", read("docs/RELEASING.md")],
  ["docs/NATIVE.md", read("docs/NATIVE.md")],
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

process.stdout.write("\nevery symbol the decision record cites\n");

/** Names from outside this repository, listed rather than found by searching node_modules, where a stale internal name could match a dependency's. */
const FOREIGN = new Set([
  "API_KEY_INVALID", // gemini's error string, quoted in the session/authenticate entry
  "AvailableCommandInput", // the ACP schema's own type name, quoted from the spec
  "CLAUDE_CONFIG_DIR", // claude's own env var, named as the remedy for a bypassed permission path
  "CLAUDE_JOB_DIR", // claude's own env var, the gate on its exit handoff for background work
  "isSubagentTask", // `claude-agent-acp`'s own predicate, the reason a backgrounded subagent is announced as nothing
  "replaySessionHistory", // `claude-agent-acp`'s own method, named for what it does *not* replay
  "toolUseId", // claude's own field on a background task record
  "PreToolUse", // a Claude Code hook name
  "TodoWrite", // claude's own tool
  "WINDOW_UPDATE", // an HTTP/2 frame type
  "approvalPolicy", // codex's own session field
  "sandboxPolicy", // codex's own session field
  "clientWidth", // the DOM
  // The File System Access API's own type, quoted in Q7.145 for what it does not carry.
  "FileSystemDirectoryHandle",
  "translateY", // CSS
  // WebKit's own predicate, cited in Q3.638; nothing in this tree declares it.
  "isSelectionRoot",
  "recvBuf", // `yamux-js` internals, in the entry about its broken flow control
  "resOnFinish", // likewise
  "sendWindowUpdate", // likewise
  "readStart", // Node's own `StreamBase`, in the entry about the stream window it credits
  "readStop", // likewise — the half that is wired to an event, where its pair is not
  "isTaskTool", // the adapter's function, not ours — the entry says so explicitly
  // Also the adapter's: what answers a rejected plan with an interrupting deny.
  "applyExitPlanModeSelection",
  "REEMOAT_AGENTS", // an env var that was proposed and never built; the entry says so
  // The ACP schema's own request types, quoted in Q2.224 for carrying no history field.
  "ResumeSessionRequest",
  "LoadSessionRequest",
  // The two adapters' internals, cited in Q6.107 for how each handles a second prompt.
  "turnQueue",
  "activePrompt",
]);

// Cited by DECISIONS.md and greps to nothing. Pinned by equality so the list can only shrink; triage is outstanding.
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

process.stdout.write("\nthe index, against the headings it describes\n");

const perGroup = new Map<string, number>();
for (const q of headingList) {
  const g = q.split(".")[0] ?? q;
  perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
}

const seen = new Set<string>();
const duplicated = new Set<string>();
for (const q of headingList) (seen.has(q) ? duplicated : seen).add(q);
check("no Q-number names two entries, beyond the known set", [...duplicated].sort(), [...KNOWN_DUPLICATE_NUMBERS].sort());

const ambiguous = [...new Set(citers.flatMap(([, t]) => [...t.matchAll(/\bQ\d+\.\d+[a-z]?\b/g)].map((m) => m[0])))]
  .filter((q) => duplicated.has(q))
  .sort();
check("no citation names a duplicated number", ambiguous, []);

// Group cells match with or without a link wrapper, since the Groups table is also the table of contents.
const indexed = new Map<string, number>();
for (const m of decisions.matchAll(/^\|\s*\[?\*\*(Q\d+)\*\*\]?(?:\([^)]*\))?\s*\|[^|]*\|\s*(\d+)\s*\|/gm)) {
  if (m[1] !== undefined) indexed.set(m[1], Number(m[2]));
}

check("the index names every group that has entries", [...perGroup.keys()].sort(), [...indexed.keys()].sort());
for (const [g, n] of [...indexed].sort()) check(`the index count for ${g}`, n, perGroup.get(g) ?? 0);

const statedTotal = /\|\s*\|\s*\|\s*\*\*(\d+)\*\*\s*\|/.exec(decisions);
check("the index states a total", statedTotal !== null, true);
if (statedTotal) check("the stated total is the real one", Number(statedTotal[1] ?? -1), headingList.length);

// The paragraph under the table contrasts the total with the count at one heading depth, derived here that way on purpose.
const shallowHeadings = [...decisions.matchAll(/^### (Q\d+\.\d+[a-z]?)(?= |$)/gm)].length;
const explained = /it says (\d+) rather than the (\d+)\b/.exec(decisions);
check("the paragraph under the table explains a total", explained !== null, true);
if (explained) {
  check("the explained total is the real one", Number(explained[1] ?? -1), headingList.length);
  check("the one-depth count it contrasts with is the real one", Number(explained[2] ?? -1), shallowHeadings);
}

const inClaudeMd = /`docs\/DECISIONS\.md`\*\*\s*—\s*(\d+)\s*entries/.exec(claudeMd);
check("CLAUDE.md quotes an entry count", inClaudeMd !== null, true);
if (inClaudeMd) check("CLAUDE.md's entry count is the real one", Number(inClaudeMd[1] ?? -1), headingList.length);

const inReadme = /`docs\/DECISIONS\.md`[^\n]*?\b(\d+)\s+entries/.exec(readme);
check("README.md quotes an entry count", inReadme !== null, true);
if (inReadme) check("README.md's entry count is the real one", Number(inReadme[1] ?? -1), headingList.length);

for (const [where, text, pattern] of [
  [".github/ISSUE_TEMPLATE/config.yml", read(".github/ISSUE_TEMPLATE/config.yml"), /\b(\d+)\s+entries/],
] as const) {
  const found = pattern.exec(text);
  check(`${where} quotes an entry count`, found !== null, true);
  if (found) check(`${where}'s entry count is the real one`, Number(found[1] ?? -1), headingList.length);
}

process.stdout.write("\nthe counts this documentation states about the code\n");

// Counted on route registrations at the start of a line; a looser pattern would count a Map read in server.ts as a route.
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

// The installer URL is derived from SOURCE_URL and the asset ci-release.sh uploads, never from installCommand, which carries a fleet's own origin.
{
  const appSource = read("packages/control-plane/src/app.ts");
  const sourceUrl = /^const SOURCE_URL = "([^"]+)";$/m.exec(appSource)?.[1] ?? "";
  check("app.ts still declares SOURCE_URL as a plain literal", sourceUrl.length > 0, true);

  // Read off the gh release create call, as its last file argument; a second file there is its own failure, so the README check keeps measuring the installer.
  const release = read("deploy/ci-release.sh");
  const createCall = /"\$GH" release create(?:[^\n]*\\\n)*[^\n]*/.exec(release)?.[0] ?? "";
  check("ci-release.sh still creates the release with gh", createCall.length > 0, true);
  const workFiles = [...createCall.matchAll(/\$RELEASE_WORK\/([A-Za-z0-9._-]+)"/g)].map((m) => m[1] ?? "");
  check("exactly one $RELEASE_WORK file is named on that call", workFiles.length, 1);
  const asset = workFiles.at(-1) ?? "";
  check("ci-release.sh uploads a named installer asset", asset.length > 0, true);

  const expected = `${sourceUrl}/releases/latest/download/${asset}`;
  check("README.md's one-liner downloads that asset from that repository", readme.includes(expected), true);
  check("and so does deploy/README.md", read("deploy/README.md").includes(expected), true);
  check("with no second copy beside it", (readme.match(/curl -fsSL/g) ?? []).length, 1);
  check(
    "and the hosted instance is never what the README tells you to download from",
    /curl[^\n]*app\.reemoat\.com/.test(readme),
    false,
  );
}

check("DECISIONS.md has exactly one H1", (decisions.match(/^# /gm) ?? []).length, 1);

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

// SKIP_PATH is pinned from both sides: too narrow makes gen/android unscopable, too wide lets a gen/schemas glob load until the next clean.
// The table is what holds on CI, where gen/schemas is absent from disk.
const underGen = (d: string): boolean => repoFiles.some((p) => p.startsWith(`packages/native/src-tauri/gen/${d}/`));
check("gen/android is a place a rule may be scoped to", underGen("android"), true);
check("gen/schemas is not, so a glob there is still dead", underGen("schemas"), false);
for (const [p, skipped] of [
  ["packages/native/src-tauri/gen/schemas", true],
  ["packages/native/src-tauri/gen/apple", true],
  ["packages/native/src-tauri/gen/android", false],
  ["packages/native/src-tauri/gen/android/app/src/main/res/xml", false],
  ["packages/native/src-tauri/gen/android/buildSrc/src/main", false],
  ["packages/native/src-tauri/gen/android/build", true],
  ["packages/native/src-tauri/gen/android/.gradle", true],
  ["packages/native/src-tauri/gen/android/app/build", true],
  ["packages/native/src-tauri/gen/android/buildSrc/.kotlin", true],
] as const) {
  check(`the walk ${skipped ? "refuses" : "enters"} ${p}`, SKIP_PATH.test(p), skipped);
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
