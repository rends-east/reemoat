#!/usr/bin/env node
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The regression driver for the native shell, and its subject is a **shell
 * configuration** — which is why it is a file of its own rather than a section of
 * another driver. No other check here can see `tauri.conf.json`, a capability
 * file, or a `#[tauri::command]`: `typecheck` compiles no Rust and reaches no JSON,
 * `webcheck` is scoped to `packages/web`, and `pincheck` reads version sites by
 * literal path. So everything in this file would otherwise be asserted by the
 * `cargo` build alone, which is a separate CI job, or by nothing at all.
 *
 * The assertions cluster around five facts, and each was a real hazard before it
 * was a line:
 *
 *   1. **The frontend is bundled locally.** That is the whole point of a native
 *      app here — the server must not be able to replace the code running in it —
 *      and it is one JSON field away from being false, silently, with the app
 *      still working.
 *   2. **The webview's file drops still arrive.** Tauri intercepts OS drag-and-drop
 *      by default, which takes the composer's attachments and the code importer
 *      with it. The paperclip keeps working, so the failure reads as "drag-and-drop
 *      was never supported" rather than as a regression. Nothing else anywhere
 *      would catch it.
 *   3. **The capability surface is empty, and the version sites stay six.** An
 *      app-defined command is not ACL-gated, so `commands.rs` *is* the surface and
 *      the capability file should add nothing to it; and `tauri.conf.json` names a
 *      *path* to the root manifest rather than a number, so this release is still
 *      written down in the six places `docs/RELEASING.md` lists.
 *   4. **`packages/native` is not a member of the workspace.** Three separate
 *      things depend on that one line — the fleet's install weight, whether a
 *      native bump drops every relay tunnel, and whether the control plane's image
 *      still builds — and deleting it undoes all three at once. Q4.114 is the same
 *      argument at a larger number.
 *   5. **One rule, not two copies of one rule.** The schemes a link may open are
 *      `OPENABLE` in `packages/web/src/ui/links.ts`; `commands.rs` carries a second
 *      copy as a backstop, and this is what stops a second copy from becoming a
 *      second policy.
 *
 * Offline, one process, no network, no fleet, no agent — and **no `cargo`**, which
 * is the property that lets it join `pnpm check` beside the other eight. What
 * needs a Rust toolchain is the `native` job in `.github/workflows/check.yml`:
 * `tauri-build` compiles the capability files into an ACL and a `version` path that
 * does not resolve fails there, and neither is reachable from text.
 *
 *   pnpm nativecheck
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

/**
 * A property that holds, with the measurement beside it.
 *
 * `daemoncheck`, `relaycheck` and `webcheck` all grew one of these and this file
 * had not: every assertion here whose subject is really a *bound* — "the census
 * saw more than nothing", "both lists were non-empty" — had to be written as an
 * equality against `true`, which then says `ok` and nothing else. The detail
 * string is what keeps a non-vacuity report readable: "17 commands, 4 of them
 * declared with arguments" says something `ok` on its own does not, and it is the
 * half a reader needs when the question is whether the check still bites.
 */
function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

/**
 * One capture, or `null`, and never a throw.
 *
 * `pincheck`'s idiom: a pattern that stops matching must fail as a *readable*
 * assertion rather than as a stack trace, because the two want different fixes.
 */
function capture(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1] ?? null;
}

/**
 * One function's body, cut between two anchors, or the empty string.
 *
 * ⚠ **`source.slice(source.indexOf(a), source.indexOf(b))` widens silently when
 * the *closing* anchor moves, and the `length > 0` floor beside every such slice
 * cannot see it.** A missing `indexOf` answers `-1`, and `String.slice` reads a
 * negative end as *counting from the end* — so the slice does not empty, it runs
 * to one character short of the file. Measured on the three call sites in this
 * file on 2026-09-17: `writeStored` 4078 → 32958 characters, `keyFallback`
 * 222 → 25776, `setServerBody` 465 → 7057 — every one of them with its floor
 * still printing `ok`.
 *
 * What that costs is the assertion, not the floor. Every positive line over such
 * a slice — "a device key is written through that one writer", "adopting a server
 * gives up the previous one's sign-in" — goes on matching, from **some other
 * function's body**, and says `ok` about a claim nothing checked any more. That is
 * the failure this repository keeps finding: an assertion that cannot fail.
 *
 * So both anchors have to be present and in order, and anything else is the empty
 * string, which is what the floors were written to catch. The opening anchor was
 * already covered — `slice(-1, b)` is empty — and this makes the pair symmetric
 * rather than accidentally half-safe.
 */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start < 0 || end < 0 || end <= start) return "";
  return source.slice(start, end);
}

/**
 * Rust source with `cargo fmt`'s line breaking taken back out.
 *
 * ⚠ **Every assertion in this file that reads a `.rs` file reads *formatted*
 * source, and nothing in this job knows that.** `cargo fmt --check` is a step of
 * the `native` job, which needs a Rust toolchain; this driver is in the `check`
 * job and deliberately runs no cargo. So the two can disagree indefinitely, and
 * they did: the assertions below were written against source that had never been
 * through `rustfmt`, and the first run of `cargo fmt` broke nine of them at once
 * by wrapping three expressions past `max_width = 100`. Either job could be made
 * green on its own and never both.
 *
 * The rule this restores is that **an assertion is about what the code says, not
 * about where the lines end**. Only rustfmt's four line-breaking artefacts are
 * undone, so a pattern can be written the way the expression reads:
 *
 *   - runs of whitespace become one space — the wrap itself;
 *   - space around a `.` is dropped — a broken method chain puts the dot first;
 *   - space after `(` is dropped — arguments pushed onto their own lines;
 *   - a trailing `,` before `)` is dropped — rustfmt adds one when it wraps a
 *     call and there is none in the single-line form.
 *
 * ⚠ **For code, never for prose.** Collapsing whitespace around a `.` also runs
 * two sentences of a docblock together, so an assertion whose subject is a
 * *comment* must read the raw text. `wrap_comments` and `normalize_comments` are
 * both `false` under default rustfmt, which is what makes that safe: the comment
 * layer is not reflowed, so nothing about it needs this.
 */
function flat(rust: string): string {
  return rust
    .replace(/\s+/g, " ")
    .replace(/ ?\. ?/g, ".")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
}

/**
 * Rust with its comment layer taken out, which is what an assertion about Rust
 * *code* has to read.
 *
 * ⚠ **The comment layer here is the specification, so it quotes the code**, and
 * every assertion in this file that searches a `.rs` for a pattern is therefore
 * searching the prose about that pattern too. Five call sites already strip
 * before matching and each records the same discovery locally: `bootCode`, where
 * the docblock explaining why there is no `rename_all` names the attribute;
 * `daemonSrc`, where *"never with a POSIX literal"* sits beside the literal;
 * `configCode`; `deviceCode`; and `libCode`, where `/RunEvent::Exit/.test(libRs)`
 * was green on the paragraph four lines above the callback and would have stayed
 * green with the callback deleted.
 *
 * ⚠ **The loud direction is a false red; the quiet one is a false green.** A
 * pattern satisfied by the prose passes whether or not the code is there — and a
 * block-commented attribute reads exactly like a live one, which is the shape a
 * tripwire dies in.
 *
 * One reader rather than a sixth copy, for `rustJsonKeys`'s reason: the second
 * copy of that loop arrived by extracting the first, with a comment saying so,
 * which is exactly how a third would.
 *
 * `//` is anchored at the start of a line — `stageCode`'s form rather than
 * `configCode`'s, because the unanchored one also eats the `https:` and its two
 * slashes inside a string literal: harmless in `config.rs`, not harmless in
 * general. The block strip is the unanchored one those five already use, so
 * folding them into this later cannot change a result.
 */
function rustCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * Kotlin with its comments taken out — the activity and the Gradle script are
 * both Kotlin.
 *
 * ⚠ **The block strip is anchored at the start of a line, and that is a
 * measurement rather than caution.** The debug block of
 * `gen/android/app/build.gradle.kts` carries four `jniLibs.keepDebugSymbols`
 * globs, each of them the string *star slash ABI slash star dot so*. Spelled out
 * in words because the sequence cannot be written inside a block comment at all,
 * which is the same fact from the other side: each of those string literals
 * contains a **slash followed by a star** (in `arm64-v8a` and its slash) and
 * begins with a **star followed by a slash**. {@link rustCode}'s unanchored strip
 * opens a comment at the first of those and closes it at the *next* glob's
 * leading pair, eating everything between. Measured on this checkout: the
 * `x86_64` line vanishes from the result and two others are spliced together —
 * in the one file every Gradle assertion below is about.
 *
 * Every block comment in both Kotlin files begins its own line, so the anchor
 * costs nothing here and the only thing it stops matching is a string.
 *
 * `//` is anchored for {@link rustCode}'s reason.
 */
function kotlinCode(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * XML with its comments taken out, and the Android resources are where the
 * prose-quotes-the-code hazard is at its sharpest in this tree.
 *
 * `res/xml/data_extraction_rules.xml` opens by explaining what it is for, and the
 * explanation **quotes `allowBackup="false"`** — the attribute an assertion below
 * searches `AndroidManifest.xml` for. Two files apart today, and one copy-paste
 * from being one file. `AndroidManifest.xml` carries comments of its own.
 *
 * An XML comment cannot nest and may not contain a double hyphen, so a
 * non-greedy run to the first close is the whole of the rule.
 */
function xmlCode(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * The JSON names a serde-derived struct body actually answers to.
 *
 * ⚠ **Walked line by line rather than matched as one pattern, and that walk is the
 * whole thing being compared.** A field's JSON name is the `serde(rename = "…")`
 * on the line above it where there is one and its own Rust spelling where there is
 * not — so a single regex that got the lookbehind subtly wrong would answer a
 * *superset* of the real names and pass for ever, which is the one failure a
 * census of this kind cannot survive.
 *
 * `pub` is optional because both shapes are read through here: `Stored` in
 * `local.rs` is private to its module and every payload struct that crosses the
 * bridge is `pub`. One reader rather than one per caller, because this loop was
 * already written down twice — and the second copy was added by extracting the
 * first, with a comment saying so, which is exactly how a third would arrive.
 */
function rustJsonKeys(body: string): string[] {
  const keys: string[] = [];
  let pending: string | null = null;
  for (const line of body.split("\n")) {
    const rename = /serde\(rename = "(\w+)"\)/.exec(line);
    if (rename !== null) {
      pending = rename[1] ?? null;
      continue;
    }
    const field = /^\s{4}(?:pub )?(\w+): /.exec(line);
    if (field === null) continue;
    keys.push(pending ?? field[1] ?? "");
    pending = null;
  }
  return keys.sort();
}

/**
 * The property names a TypeScript interface body declares, optional ones included.
 *
 * Anchored at exactly two spaces, which is what keeps a docblock out of the
 * answer: a continuation line is `   * …` — three spaces then an asterisk — so the
 * `\w` after the indent never matches, and `{@link DaemonState.machineId}` inside
 * one cannot be read as a field.
 */
function tsInterfaceKeys(body: string): string[] {
  return [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1] ?? "").sort();
}

const NATIVE = "packages/native";
const TAURI_DIR = `${NATIVE}/src-tauri`;
const CONF = `${TAURI_DIR}/tauri.conf.json`;

/* ------------------------------------------------------------------ *
 * The frontend is inside the binary
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe frontend, and where it comes from\n");

const conf = json(CONF);
const build = (conf["build"] ?? {}) as Record<string, unknown>;
const app = (conf["app"] ?? {}) as Record<string, unknown>;
const bundle = (conf["bundle"] ?? {}) as Record<string, unknown>;

check("tauri.conf.json names a frontendDist", typeof build["frontendDist"], "string");
const dist = String(build["frontendDist"]);
/*
 * `frontendDist` accepts a remote URL or a custom protocol as well as a path, and
 * a remote URL is exactly the shape this whole exercise exists to refuse: the app
 * would then load its own JavaScript from the server it is supervising, and the
 * server could replace it between launches.
 */
check("and it is a path rather than a URL", /^[a-z][a-z0-9+.-]*:/i.test(dist), false);
check(
  "which resolves to the web package's build output",
  resolve(ROOT, TAURI_DIR, dist),
  resolve(ROOT, "packages/web/dist"),
);
check(
  "there is no second copy of the frontend in this package",
  ["src", "dist", "index.html", "public"].filter((p) => existsSync(join(ROOT, NATIVE, p))),
  [],
);
/*
 * The dev server is the one place a URL belongs, and it is only read by
 * `tauri dev`. Pinned to loopback so a `devUrl` naming a deployed origin — which
 * would be the bundled-frontend rule broken in development, where it is hardest
 * to notice — fails here.
 */
const devUrl = build["devUrl"];
check(
  "the dev URL is a loopback dev server and nothing else",
  typeof devUrl === "string" && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(devUrl),
  true,
);

/*
 * **The last way a chunk URL could point off-origin**, and it fails closed in the
 * quietest possible manner.
 *
 * `frontendDist` being a path decides where the *bundle* comes from; Vite's `base`
 * decides what the `<script src>` inside `index.html` says. Set to a URL, Vite
 * emits absolute module URLs and the shell's `script-src 'self'` refuses them —
 * so the app is a blank window with the reason in a console nobody has open on a
 * page that never painted. Absent today, which is what makes root-relative URLs
 * resolve against `tauri://localhost`.
 *
 * Checked as "names no scheme" rather than "is absent", because `base: "./"` and
 * `base: "/"` are both legitimate and neither leaves the origin.
 */
const viteConfig = read("packages/web/vite.config.ts");
check(
  "the web build emits no asset URL that could leave this origin",
  /base:\s*["'`][a-z][a-z0-9+.-]*:/i.test(viteConfig),
  false,
);

const windows = (app["windows"] ?? []) as Record<string, unknown>[];
check("there is a window to check", windows.length, 1);
const main = windows[0] ?? {};
check("it is the one the Rust side builds", main["label"], "main");
/*
 * `create: false` because `lib.rs` builds this window from this very config in
 * order to attach `on_navigation` — the one thing a configuration file cannot
 * express. With `create` left true there would be two windows, one of them
 * unguarded.
 */
check("and the configuration leaves creating it to Rust", main["create"], false);
check(
  "no window is pointed at a remote URL",
  windows.filter((w) => typeof w["url"] === "string" && /^https?:/i.test(String(w["url"]))),
  [],
);

/*
 * ⚠ **The assertion with no other symptom.**
 *
 * Tauri intercepts OS file drops by default and the `drop` event then never
 * arrives with files — so `packages/web/src/ui/Composer.tsx`'s attachment drop and
 * `ui/ImportCode.tsx`'s archive drop both stop working while the paperclip and the
 * file picker beside them keep working. Nothing in `webcheck` can see it, nothing
 * in the build can see it, and the shape of the failure invites the conclusion
 * that the feature never existed.
 */
check("OS file drops still reach the webview", main["dragDropEnabled"], false);

/*
 * What makes `packages/web` need **zero** `@tauri-apps/*` npm packages: this
 * global is the whole bridge surface, read through a hand-written interface in
 * `packages/web/src/native.ts`. The idiom is inherited rather than invented — the
 * deleted `telegram.ts` read `window.TelegramWebviewProxy` through exactly that
 * shape, and it went out of the tree with the mini-app host it served, so this is
 * the last place the pattern is described. Asserted from both sides, because either alone
 * would pass while the other broke — a dependency added to the web manifest ships
 * a native-only module inside the bundle the control plane's image serves.
 */
check("the bridge global is injected", app["withGlobalTauri"], true);
const webManifest = json("packages/web/package.json");
check(
  "and the web package depends on no @tauri-apps package",
  [...Object.keys(webManifest["dependencies"] ?? {}), ...Object.keys(webManifest["devDependencies"] ?? {})].filter(
    (name) => name.startsWith("@tauri-apps/"),
  ),
  [],
);

/* ------------------------------------------------------------------ *
 * Security: the CSP, and what is switched off
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe policy this document carries, since no server sends it one\n");

const security = (app["security"] ?? {}) as Record<string, unknown>;
/*
 * ⚠ **`dangerousDisableAssetCspModification` and `dangerousRemoteDomainIpcAccess`
 * are the two keys that turn all of this off**, and both are invisible to every
 * other assertion here: the first stops Tauri adding the sources its own IPC needs
 * (so a policy that looks tighter is really a broken app), and the second hands
 * `invoke` to an origin nobody in this repository chose. Swept by prefix rather
 * than named, so a third one is covered on the day it is added.
 */
check(
  "nothing dangerous is switched on",
  Object.keys(security).filter((k) => /^dangerous/i.test(k)),
  [],
);

const csp = security["csp"];
check("the shell carries a CSP of its own", typeof csp === "string" && csp.length > 0, true);
const policy = String(csp);
const directives = new Map<string, string[]>(
  policy
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/);
      return [String(name), sources] as [string, string[]];
    }),
);

/*
 * **The same directive names the control plane sends, minus one.**
 *
 * Read off `packages/control-plane/src/app.ts` rather than transcribed, so a
 * directive added to the browser client's policy and forgotten here fails — which
 * is the shape of every CSP defect that document has had: `img-src` right and
 * `connect-src` wrong, or the reverse, with the reason only in a console nobody
 * has open.
 *
 * `frame-ancestors` is the declared difference: a window with no parent cannot be
 * framed, and the directive is meaningless on a document nothing embeds.
 */
const appTs = read("packages/control-plane/src/app.ts");
const browserDirectives = [...appTs.matchAll(/^\s*["`]([a-z-]+-src|base-uri|form-action|frame-ancestors) /gm)]
  .map((m) => m[1])
  .filter((name): name is string => name !== undefined);
const expected = [...new Set(browserDirectives)].filter((name) => name !== "frame-ancestors").sort();
check("the browser client's policy was readable at all", expected.length >= 9, true);
check("this policy names the same directives, minus frame-ancestors", [...directives.keys()].sort(), expected);

check("default-src is self", directives.get("default-src"), ["'self'"]);
check("script-src is self and nothing else", directives.get("script-src"), ["'self'"]);
check("object-src is none", directives.get("object-src"), ["'none'"]);
check("base-uri is self", directives.get("base-uri"), ["'self'"]);
check("form-action is self", directives.get("form-action"), ["'self'"]);
check("font-src is self", directives.get("font-src"), ["'self'"]);
/*
 * `blob:` because `ui/ImagePreview.tsx` builds one out of bytes it fetched with a
 * header, which is the *supported* way to see a file. `https:` because a plugin's
 * icon is read from an origin this client only learns from the wire, and a scheme
 * is the only bound a static policy can put on it. No `data:`, which the built
 * bundle does not need — measured on the browser client's own policy.
 */
check("img-src is self, blob and https", (directives.get("img-src") ?? []).sort(), ["'self'", "blob:", "https:"]);
/*
 * ⚠ **`connect-src` is the directive that can break everything**, and it is also
 * the one that cannot be written tightly here. The relay's origin arrives per
 * machine from `POST /v1/tokens`, so it is not knowable at build time; the browser
 * client gets it in a header the control plane builds from the same variable it
 * publishes, and a bundled app has no such header. So the bound is the scheme, and
 * the thing that actually holds is `script-src 'self'` above.
 *
 * The control plane must **not** appear here: `/v1/*` goes over IPC, so a
 * control-plane origin in `connect-src` would mean the transport split had quietly
 * stopped being one.
 */
const connect = directives.get("connect-src") ?? [];
check("connect-src reaches a relay over both of its schemes", ["https:", "wss:"].every((s) => connect.includes(s)), true);
check(
  "and carries nothing but schemes and self",
  connect.filter((s) => s !== "'self'" && !/^[a-z][a-z0-9+.-]*:$/.test(s)),
  [],
);
check("no source anywhere is a wildcard", policy.includes("*"), false);
check("and eval is never allowed", /unsafe-eval/.test(policy), false);

/* ------------------------------------------------------------------ *
 * The capability surface
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the webview is allowed to reach\n");

const capDir = join(ROOT, TAURI_DIR, "capabilities");
const caps = readdirSync(capDir).filter((f) => f.endsWith(".json"));
check("there are capability files to check", caps.length >= 1, true);

const granted: string[] = [];
for (const file of caps) {
  const cap = JSON.parse(readFileSync(join(capDir, file), "utf8")) as Record<string, unknown>;
  check(`${file} names the windows it applies to`, cap["windows"], ["main"]);
  check(`${file} grants nothing to a remote origin`, Object.hasOwn(cap, "remote"), false);
  /*
   * `description` rather than a comment, because a capability file is JSON and
   * this repository's comment layer is its specification. A capability with no
   * description is one whose reason has to be reconstructed.
   */
  check(`${file} says why it is what it is`, typeof cap["description"] === "string", true);
  for (const permission of (cap["permissions"] ?? []) as unknown[]) {
    granted.push(typeof permission === "string" ? permission : JSON.stringify(permission));
  }
}
/*
 * **Empty, and pinned as an exact list rather than as a ceiling.**
 *
 * Two different mistakes want two different lines: a permission that crept in, and
 * a line pinning something nobody uses. Commands this app defines are allowed to
 * every window without an entry, and the three Tauri plugins here are driven from
 * Rust — so a JS permission for `dialog`, `clipboard-manager` or `opener` would be
 * a door the webview could walk through on a page that renders agent output.
 */
check("the granted permission set is empty", granted.sort(), []);
check(
  "and no plugin the Rust side drives is reachable from the page",
  granted.filter((p) => /^(dialog|clipboard-manager|opener|http|fs|shell|updater):/.test(p)),
  [],
);
check("no permission is a wildcard", granted.filter((p) => p.includes("*")), []);

/* ------------------------------------------------------------------ *
 * One rule, not two copies of one rule
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe schemes a link may open, from both sides\n");

/*
 * `packages/web/src/ui/links.ts` holds the policy and the argument for it:
 * anything outside these three is *"launching a program named by an agent-chosen
 * string"*, on a page that renders agent output. `commands.rs` carries a second
 * copy as the half that holds if the page is ever wrong — and a second copy of a
 * rule is only safe while something compares them.
 */
const linksTs = read("packages/web/src/ui/links.ts");
const openableTs = capture(linksTs, /const OPENABLE = new Set\(\[([^\]]*)\]\)/);
check("the web client's allowlist was readable", openableTs !== null, true);
const webSchemes = [...(openableTs ?? "").matchAll(/"([a-z]+):"/g)]
  .map((m) => m[1])
  .filter((s): s is string => s !== undefined)
  .sort();

const commandsRs = read(`${TAURI_DIR}/src/commands.rs`);
const openableRs = capture(commandsRs, /const OPENABLE_SCHEMES: \[&str; \d+\] = \[([^\]]*)\]/);
check("the shell's allowlist was readable", openableRs !== null, true);
const rustSchemes = [...(openableRs ?? "").matchAll(/"([a-z]+)"/g)]
  .map((m) => m[1])
  .filter((s): s is string => s !== undefined)
  .sort();

check("both lists were found to be non-empty", [webSchemes.length > 0, rustSchemes.length > 0], [true, true]);
check("and they are the same set", rustSchemes, webSchemes);

/* ------------------------------------------------------------------ *
 * The command surface, from three directions
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The file a daemon writes, and the file this shell reads
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe announcement, from both sides of it\n");

/*
 * **One shape, written down twice, compared** — the same rule as `OPENABLE` below
 * and for a sharper reason. `src/announce.ts` is the only writer of
 * `~/.reemoat/daemon.json` and `local.rs` is the only reader, and they are in
 * different languages in different packages built by different toolchains. A field
 * renamed on one side is not a compile error anywhere: it is a local route that
 * silently stops being offered, on a fleet that goes on working through the relay,
 * with nothing in any log. Nobody would find it.
 *
 * The version is compared too. It is the field that decides whether a reader
 * *tries*, so two numbers drifting apart is the same failure arriving deliberately.
 */
{
  const ts = read("src/announce.ts");
  const rs = read("packages/native/src-tauri/src/local.rs");

  const written = capture(ts, /export interface LocalAnnounce \{([\s\S]*?)\n\}/);
  check("the daemon's side of the shape was readable", written !== null, true);
  const writtenKeys = [...(written ?? "").matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1] ?? "").sort();

  const stored = capture(rs, /struct Stored \{([\s\S]*?)\n\}/);
  check("and the shell's side of it", stored !== null, true);
  /*
   * `rustJsonKeys` is that walk, and its docblock carries the argument for why it
   * is a walk: a field's JSON name is the `rename` on the line above it when there
   * is one and its own name when there is not, and a single regex that got the
   * lookbehind subtly wrong would answer a *superset* and pass for ever.
   */
  const readJsonKeys = rustJsonKeys(stored ?? "");

  check("both sides were found to have fields", [writtenKeys.length > 0, readJsonKeys.length > 0], [true, true]);
  check("and the daemon writes exactly what the shell reads", writtenKeys, readJsonKeys);

  check(
    "the version the daemon stamps is the version the shell accepts",
    capture(ts, /export const ANNOUNCE_VERSION = (\d+);/),
    capture(rs, /const ANNOUNCE_VERSION: u32 = (\d+);/),
  );
}

/* ------------------------------------------------------------------ *
 * The second pair: what the shell hands the page at first paint
 *
 * `Boot` in `commands.rs` is serialized straight into `NativeBoot` in
 * `native.ts`, and **nothing compared them** — which is the same hole the pair
 * above exists to close, on the one struct every launch reads.
 *
 * ⚠ **The specific failure, and it is silent in five checkers at once.** `Boot`
 * carries no `#[serde(rename_all = "camelCase")]`; every camelCase field names
 * itself with its own `rename`. So a `pub device_id: Option<String>` added
 * without one serializes as `device_id`, `boot.deviceId` is `undefined` for ever,
 * and `tsc`, `cargo`, `cargo test`, `webcheck` and the command census below are
 * all green. The app then decides on every single launch that it has no device,
 * registers another, and walks into the account's device limit — with the only
 * evidence being a list of identically-named rows. `local.rs`'s docblock names
 * this class in so many words: *"A field renamed on one side is not a compile
 * error anywhere… Nobody would find it."*
 *
 * The reader is `rustJsonKeys`, shared with the pair above: a field's JSON name is
 * the `rename` on the line before it where there is one and its own name where
 * there is not.
 * ------------------------------------------------------------------ */

{
  const ts = read("packages/web/src/native.ts");

  const declared = capture(ts, /export interface NativeBoot \{([\s\S]*?)\n\}/);
  check("the page's side of the boot payload was readable", declared !== null, true);
  const pageKeys = tsInterfaceKeys(declared ?? "");

  const boot = capture(commandsRs, /pub struct Boot \{([\s\S]*?)\n\}/);
  check("and the shell's side of it", boot !== null, true);
  const hostKeys = rustJsonKeys(boot ?? "");

  check("both sides were found to have fields", [pageKeys.length > 0, hostKeys.length > 0], [true, true]);
  check("and the shell sends exactly what the page declares", hostKeys, pageKeys);

  /*
   * And the negative control, because the reader above is what the assertion
   * rests on: a struct that renames nothing must come back with its Rust
   * spellings, or the reader is silently answering the page's names whatever the
   * source says and the comparison is vacuous.
   */
  const renames = [...(boot ?? "").matchAll(/serde\(rename = "(\w+)"\)/g)].length;
  check(
    "the reader is actually reading renames rather than assuming them",
    renames > 0 && hostKeys.some((key) => /[A-Z]/.test(key)),
    true,
  );
  /*
   * ⚠ **Comments stripped first, and that is not fussiness.** Written against the
   * raw text this fails immediately — on the docblock of the very field that
   * explains why there is no `rename_all`. A source-text assertion that cannot
   * tell code from prose about the code is the shape `webcheck` already carries
   * `stripComments` for, and the failure here is the loud direction; the quiet
   * one is the same reader passing over a *commented-out* attribute.
   *
   * The attribute would sit in the derive above `pub struct`, outside the body
   * captured above, so the preamble is included.
   */
  const bootDecl = capture(commandsRs, /((?:#\[[^\]]*\]\s*)*pub struct Boot \{[\s\S]*?\n\})/) ?? "";
  const bootCode = bootDecl
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  check(
    "and `rename_all` is still absent, which is why each field needs its own",
    /#\[serde\([^)]*rename_all/.test(bootCode),
    false,
  );
  // The negative control for the strip itself: the prose that mentions the
  // attribute is in the file, so a reader that saw nothing would pass above for
  // the wrong reason.
  check("the strip had something to remove", bootDecl.length > bootCode.length, true);
}

/* ------------------------------------------------------------------ *
 * The other three payloads, which had no census at all
 *
 * ⚠ **`Boot` is not the only struct that crosses this bridge by hand-written
 * `serde(rename)`, and it was the only one anybody was watching.** The block above
 * states the failure in full — a camelCase field that forgets its own `rename`
 * serializes under its Rust spelling, the page reads `undefined` for ever, and
 * `tsc`, `cargo`, `cargo test`, `webcheck` and the command census are all green.
 * Nothing about that argument is specific to `Boot`. Three more payloads are shaped
 * exactly the same way and were reaching the page on trust:
 *
 *   - `DeviceKey` (`device.rs`) — `publicKey` and `atRest`. Drop either `rename`
 *     and `hostDeviceKeyReset` answers an object with the right *shape* and the
 *     wrong *keys*: `fresh.publicKey` is `undefined`, `boot.devicePublicKey` is
 *     overwritten with it, and the Devices screen shows a re-key that appears to
 *     have worked while the app now holds no public half to register. That is the
 *     `wrong_device` loop `e2ee.md` describes, arriving from the inside.
 *   - `DaemonState` (`daemon.rs`) — `machineId` and `exitCode`. The setup screen
 *     polls this once a second; `exitCode` is the *structured* half of "why did it
 *     stop", and its docblock says in so many words that it is the reason no arm
 *     in the store reads the log. A dropped `rename` makes `3` (the control plane
 *     refused the code) and `4` (it could not be reached) both read as `null`,
 *     which is the arm for "signalled, or we did not start it" — so the one screen
 *     that could offer a fresh code offers nothing.
 *   - `CpAnswer` (`proxy.rs`) — `statusText`. `answerToResponse` passes it to
 *     `new Response`, and `undefined` there is not an error: it becomes the empty
 *     string, so every control-plane error in the native build quietly loses its
 *     reason phrase.
 *
 * ⚠ **The page's side of `DeviceKey` is an inline return type, not an interface**,
 * which is why this reads `hostDeviceKeyReset`'s signature rather than a named
 * declaration. That is worth saying out loud rather than working around silently:
 * the two-field object is written twice inside `native.ts` itself — once on the
 * return type and once on the `invoke<…>` — and neither is a type this file could
 * have found by name.
 * ------------------------------------------------------------------ */

{
  const nativeTs = read("packages/web/src/native.ts");
  const deviceRs = read(`${TAURI_DIR}/src/device.rs`);
  const daemonRsRaw = read(`${TAURI_DIR}/src/daemon.rs`);
  const proxyRs = read(`${TAURI_DIR}/src/proxy.rs`);

  const payloads = [
    {
      what: "the device key",
      source: deviceRs,
      struct: "DeviceKey",
      // The one inline page-side type here. `[^}]*` is safe because the object has
      // no nested braces; a nested one would stop matching rather than answer a
      // truncated list, which is the direction a broken pattern has to fail in.
      page: () =>
        [
          ...(capture(nativeTs, /export async function hostDeviceKeyReset\(\): Promise<\{([^}]*)\}>/) ?? "").matchAll(
            /(\w+):/g,
          ),
        ]
          .map((m) => m[1] ?? "")
          .sort(),
    },
    {
      what: "the daemon's state",
      source: daemonRsRaw,
      struct: "DaemonState",
      page: () => tsInterfaceKeys(capture(nativeTs, /export interface DaemonState \{([\s\S]*?)\n\}/) ?? ""),
    },
    {
      what: "a control-plane answer",
      source: proxyRs,
      struct: "CpAnswer",
      // Not exported: the bridge answers it and `answerToResponse` consumes it in
      // the same module, so the pattern may not require an `export`.
      page: () => tsInterfaceKeys(capture(nativeTs, /\binterface CpAnswer \{([\s\S]*?)\n\}/) ?? ""),
    },
  ] as const;

  for (const payload of payloads) {
    const body = capture(payload.source, new RegExp(`pub struct ${payload.struct} \\{([\\s\\S]*?)\\n\\}`));
    check(`${payload.what}: the shell's side of the payload was readable`, body !== null, true);
    const hostKeys = rustJsonKeys(body ?? "");
    const pageKeys = payload.page();

    report(
      `${payload.what}: both sides were found to have fields`,
      hostKeys.length > 0 && pageKeys.length > 0,
      `${hostKeys.length} in ${payload.struct}, ${pageKeys.length} in native.ts`,
    );
    check(`${payload.what}: the shell sends exactly what the page declares`, hostKeys, pageKeys);

    /*
     * The same negative control `Boot` carries, and for the same reason: the
     * comparison above rests entirely on `rustJsonKeys` reading renames rather
     * than assuming them. Each of these three has at least one camelCase field
     * that exists **only** because of a `rename`, so a reader that silently
     * answered the page's spellings would still pass the equality and fail here.
     */
    const renames = [...(body ?? "").matchAll(/serde\(rename = "(\w+)"\)/g)].map((m) => m[1] ?? "");
    report(
      `${payload.what}: the reader is reading renames rather than assuming them`,
      renames.length > 0 && renames.every((name) => hostKeys.includes(name)) && hostKeys.some((k) => /[A-Z]/.test(k)),
      renames.length === 0 ? "no rename in the struct at all" : `${renames.length}: ${renames.join(", ")}`,
    );

    /*
     * And that `rename_all` is still absent, which is the premise the whole census
     * rests on — with the derive included in the capture, since the attribute would
     * sit above `pub struct` rather than in the body, and with comments stripped
     * first because two of these three carry prose that names the attribute.
     */
    const decl =
      capture(payload.source, new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*pub struct ${payload.struct} \\{[\\s\\S]*?\\n\\})`)) ?? "";
    const code = decl
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    check(`${payload.what}: and each field still needs its own rename`, /#\[serde\([^)]*rename_all/.test(code), false);
    /*
     * The one thing the loop cannot state generically: the derive has to be there
     * at all. A struct that stopped deriving `Serialize` would keep every `rename`
     * attribute, keep passing every line above, and cross no bridge.
     */
    check(`${payload.what}: and the struct is still serialized`, /derive\([^)]*Serialize/.test(decl), true);
  }
}

process.stdout.write("\nthe commands, declared against registered\n");

const libRs = read(`${TAURI_DIR}/src/lib.rs`);

/**
 * The attribute, in **both** its forms.
 *
 * ⚠ **`#[tauri::command]` takes arguments, and a pattern matching only the bare
 * literal drops every command that uses them — silently, in the direction that
 * reads as passing.** `commands.rs` says it in its own header: the bare form runs
 * the body on the main thread, the one the webview paints on, and
 * `#[tauri::command(async)]` runs it on the async runtime instead. **Most of this
 * surface carries the argument form** — anything that waits on a socket, on a disk
 * flush, on a platform panel or on a child process — and the moment the first of
 * them was changed, the census below stopped seeing it.
 *
 * ⚠ **The count is deliberately not restated here.** `commands.rs`'s own header
 * gives the reason — "a count restated in a comment is exactly the kind of claim
 * `docs/DECISIONS.md` records this repository learning not to keep" — and it has
 * been wrong twice in that file and once in this sentence, which read *four* while
 * ten commands used the argument form. The `report` at the bottom of this section
 * prints the live pair instead: how many commands there are, and how many of them
 * are declared with arguments.
 *
 * What is worth naming is the **counter-example**, because it is the reason this
 * can never be shortened into a census of `async fn`: `host_cp` is an `async fn`
 * under a **bare** attribute, and the macro gives it the same treatment without
 * being asked. The attribute is the fact here; the signature is not. (That
 * sentence named `host_cp` as one of the four for a while, which is the same class
 * of error as the count.)
 *
 * What that costs is both directions at once. "Every command the Rust declares is
 * registered" goes on saying `ok` over a list short of the truth by however many
 * commands use the argument form, so a command declared and never registered is no
 * longer caught; and the stray sweep at the bottom — whose whole job is to notice
 * a door opened in another file —
 * cannot see an `(async)` one there either. Neither failure has a symptom: the app
 * builds, the command works, and the check that was supposed to be watching the
 * surface is watching part of it.
 *
 * So the argument list is optional in the pattern, and the source is written once
 * and spliced into both readers rather than typed twice — a second copy is how
 * this became two patterns that had to be fixed separately in the first place.
 */
const COMMAND_ATTR = String.raw`#\[tauri::command(?:\([^)]*\))?\]`;

const declared = [...commandsRs.matchAll(new RegExp(`${COMMAND_ATTR}\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+(\\w+)`, "g"))]
  .map((m) => m[1])
  .filter((n): n is string => n !== undefined)
  .sort();
const handlerList = capture(libRs, /generate_handler!\[([\s\S]*?)\]/);
check("the handler list was readable at all", handlerList !== null, true);
const registered = [...(handlerList ?? "").matchAll(/commands::(\w+)/g)]
  .map((m) => m[1])
  .filter((n): n is string => n !== undefined)
  .sort();

check("there are commands to check", declared.length > 0, true);
/*
 * Both directions, each on its own line, for `pincheck`'s reason: a declared
 * command nobody registered is a dead function, and a registered one nobody
 * declared does not compile — but the *third* case is the expensive one and needs
 * the bridge to exist, so it lives beside the bridge in `webcheck`.
 */
check("every command the Rust declares is registered", declared.filter((c) => !registered.includes(c)), []);
check("and every command registered is declared", registered.filter((c) => !declared.includes(c)), []);
/*
 * One file holds the surface, so reading one file is reading all of it. A
 * `#[tauri::command]` somewhere else would be a door that this driver's census —
 * and any future reader's — would simply not see.
 */
const strayCommands: string[] = [];
for (const file of readdirSync(join(ROOT, TAURI_DIR, "src"))) {
  if (file === "commands.rs" || !file.endsWith(".rs")) continue;
  if (new RegExp(COMMAND_ATTR).test(readFileSync(join(ROOT, TAURI_DIR, "src", file), "utf8"))) strayCommands.push(file);
}
check("and every command lives in commands.rs", strayCommands, []);

/*
 * ⚠ **And the non-vacuity report for the widening itself.**
 *
 * The three lines above are only stronger than the bare literal while some command
 * actually uses the argument form. If the last `(async)` were taken off, the
 * optional group would stop being exercised, nothing here would go red, and the
 * next command declared with arguments would drop out of the census exactly as the
 * argument-form ones did — with the same absence of a symptom. Counting both
 * spellings separately is what makes that visible: the census has to be *larger*
 * than the bare count, not merely non-empty.
 *
 * ⚠ **Comments stripped before counting, and this is the file where that matters
 * most.** `commands.rs` opens by explaining the difference between the two forms
 * and quotes both of them in its own header; a later docblock quotes
 * `#[tauri::command(async)]` again as a standing TODO. Counted raw, the arguments
 * total came out at six against four real ones when this was written, and twelve
 * against ten when it was last re-measured (2026-09-17) — so a report whose whole
 * job is to say how much of the surface is exercised would have been reporting the
 * prose about the surface. The measurement is dated because the *gap* is the
 * subject rather than either number, and it widens as the file grows.
 */
const commandsCode = commandsRs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const bareAttrs = (commandsCode.match(/#\[tauri::command\]/g) ?? []).length;
const argAttrs = (commandsCode.match(/#\[tauri::command\([^)]*\)\]/g) ?? []).length;
report(
  "the census reaches the argument form of the attribute, not only the bare one",
  argAttrs > 0 && declared.length > bareAttrs,
  `${declared.length} commands, ${argAttrs} of them declared with arguments`,
);

/*
 * ⭐ **A desktop-only API must be behind a gate that names the platforms it is
 * missing on, and this check exists because one was not.**
 *
 * `host_pick_folder` shipped calling `blocking_pick_folder` with no `cfg` at all.
 * `tauri-plugin-dialog` 2.7.3 offers that method on desktop only — Android's own
 * answer to "choose a folder" is `ACTION_OPEN_DOCUMENT_TREE`, which hands back a
 * Storage Access Framework tree *URI* rather than a path, so the plugin does not
 * wrap it under that name. `host_save_file` survives beside it because a *file*
 * panel does have a mobile arm.
 *
 * ⚠ **The gap this closes is not the bug, it is the class.** `pnpm typecheck`,
 * `pnpm check`, `cargo clippy` and 74 `cargo test`s were all green when that
 * shipped, and every one of them was honest: **none compiles for
 * `aarch64-linux-android`**. The APK build is the only thing that did, and it runs
 * by hand and rarely. This is the static half — it cannot know what a crate offers
 * on a target, so the list is named and measured rather than derived, and the
 * `report` keeps it from going quiet if a name is ever renamed away.
 */
const MOBILE_ABSENT = ["blocking_pick_folder"];
const MOBILE_GATE = '#[cfg(not(any(target_os = "android", target_os = "ios")))]';

/** The attribute lines immediately above a definition, nearest last. */
function attrsAbove(code: string, needle: string): string[] {
  const at = code.indexOf(needle);
  if (at < 0) return [];
  const before = code.slice(0, at).split("\n");
  const out: string[] = [];
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const line = (before[i] ?? "").trim();
    if (line.length === 0) continue;
    if (!line.startsWith("#[")) break;
    out.unshift(line);
  }
  return out;
}

const ungated = MOBILE_ABSENT.filter((api) => {
  const at = commandsCode.indexOf(api);
  if (at < 0) return false;
  // The function the call sits in: the last `fn` declared above it.
  const head = commandsCode.slice(0, at);
  const fnAt = head.lastIndexOf("fn ");
  const name = /fn ([a-z0-9_]+)/.exec(commandsCode.slice(fnAt))?.[1] ?? "";
  return !attrsAbove(commandsCode, `fn ${name}(`).includes(MOBILE_GATE);
});
report(
  "the desktop-only dialog calls are still called by these names",
  MOBILE_ABSENT.every((api) => commandsCode.includes(api)),
  MOBILE_ABSENT.join(" "),
);
check("and every one of them is behind a gate naming the platforms it is missing on", ungated, []);

/*
 * ⚠ **One condition, two mechanisms, and nothing else can compare them.** A
 * `cfg!` macro and a `#[cfg]` attribute cannot share a token, so the platform
 * condition is written twice — once as `PICKS_FOLDER`, which the page reads as a
 * declared capability, and once on the function it describes. A build where those
 * disagree draws a control the shell will refuse, and compiles perfectly.
 */
const picksFolder = /pub const PICKS_FOLDER: bool = cfg!\(([\s\S]*?)\);/.exec(commandsCode)?.[1] ?? "";
report("the folder capability is declared as a constant", picksFolder.length > 0, picksFolder);
check(
  "and the capability it announces is the condition its implementation is gated on",
  `#[cfg(${picksFolder})]`,
  MOBILE_GATE,
);
/*
 * And the page reads that capability rather than deriving one. `platform` narrows
 * `"android"` to `"other"` along with every future desktop target, and "a phone
 * has no local daemon" is true today and is luck rather than a rule.
 */
const newSession = read("packages/web/src/ui/NewSession.tsx");
check(
  "the page asks the shell what it can do rather than guessing from the platform",
  [/nativeBoot\(\)\?\.picksFolder === true/.test(newSession), /hostPlatform\(/.test(newSession), /platform === "android"/.test(newSession)],
  [true, false, false],
);

/* ── the second declared capability, which nothing forced into existence ──── */

/*
 * ⚠ **The block above exists because an APK failed to compile. This one exists
 * because the same argument was left standing one field away.**
 *
 * `blocking_pick_folder` does not exist on Android, so the folder panel *had* to
 * become a declared capability — somebody was made to decide something. The five
 * daemon commands had the identical problem and no such pressure: `mod daemon`
 * and `mod local` compile for every target, so all five exist on a phone, are
 * registered, and answer `"unsupported"` or `None` only because
 * `Payload::locate` finds nothing staged and `~/.reemoat/daemon.json` is not
 * there. That is word for word the *"true today and is luck, not a rule"* the
 * folder capability's own docblock refuses, and it was carrying the whole setup
 * flow, the log screen and `localRoute.ts`'s probe.
 *
 * ⚠ **A census plus a required-member list, never a count.** A sixth daemon
 * command must be gated too, and a count cannot see one that was skipped. So the
 * members are derived from `declared` — the command census above, which reads
 * both forms of the attribute — and differenced against the five this capability
 * was written for. Adding one is red here until it is named.
 */
const canHostDaemon = /pub const CAN_HOST_DAEMON: bool = cfg!\(([\s\S]*?)\);/.exec(commandsCode)?.[1] ?? "";
report("the daemon-hosting capability is declared as a constant", canHostDaemon.length > 0, canHostDaemon);
check(
  "and it is false on the two platforms where a daemon on this computer is impossible",
  [canHostDaemon.startsWith("not("), canHostDaemon.includes('target_os = "android"'), canHostDaemon.includes('target_os = "ios"')],
  [true, true, true],
);
check(
  "and the field the page reads is filled from the constant rather than from a literal",
  /can_host_daemon: CAN_HOST_DAEMON,/.test(commandsCode),
  true,
);
const DAEMON_COMMANDS = ["host_daemon_log", "host_daemon_start", "host_daemon_state", "host_daemon_stop", "host_local_daemon"];
check(
  "the host's commands about a daemon on this computer are the five this capability is about",
  declared.filter((name) => /^host_(?:daemon_|local_daemon)/.test(name)),
  DAEMON_COMMANDS,
);

/*
 * ⚠ **And the page's side, comment-stripped.** `rustCode` is the reader rather
 * than a sixth copy of the same three lines: TypeScript's comment layer is the
 * same two forms Rust's is, and this is a file whose docblocks name every one of
 * the five commands and the gate itself — read raw, the prose about the rule
 * satisfies every pattern below with no code between them.
 */
const bridgeRaw = read("packages/web/src/native.ts");
const bridge = rustCode(bridgeRaw);
report(
  "the bridge's code survived the comment strip",
  bridgeRaw.length > bridge.length && bridge.includes("host_boot"),
  `${String(bridgeRaw.length - bridge.length)} characters of prose removed`,
);
/*
 * Split at each function declaration, so "does this call ask first" is answered
 * inside the function that makes the call. A file-wide pattern is green over one
 * gate and four unguarded `invoke`s, which is exactly the state this found.
 */
const bridgeFns = bridge.split(/(?=^(?:export )?(?:async )?function )/m);
report("the bridge was read as functions", bridgeFns.length > 1, `${String(bridgeFns.length - 1)} functions`);
const DAEMON_GATE = "canHostDaemonHere()";
const holders = DAEMON_COMMANDS.map((name) => ({ name, block: bridgeFns.find((block) => block.includes(`"${name}"`)) }));
check(
  "every one of them is invoked from a function that file declares",
  holders.filter((held) => held.block === undefined).map((held) => held.name),
  [],
);
check(
  "and every one of those functions asks the shell before it reaches the bridge",
  holders.filter((held) => held.block !== undefined && !held.block.includes(DAEMON_GATE)).map((held) => held.name),
  [],
);
/*
 * ⚠ **And the call is inside the declaration that heads its block rather than
 * merely somewhere in it**, because the split above only breaks at `function`. A
 * wrapper written `export const daemonLog = async () => { … }` is absorbed into
 * the *preceding* function's block and would read as gated by that function's
 * `canHostDaemonHere()` — the file-wide-pattern failure the split exists to
 * avoid, one declaration form further in. Every top-level declaration in that
 * file closes on a brace at column zero, so the command's literal has to appear
 * above the first one; the predicate is named so the fixtures below can exercise
 * it rather than a pattern written inside the assertion.
 */
const headDeclares = (block: string, command: string): boolean => {
  if (!/^(?:export )?(?:async )?function \w+/.test(block)) return false;
  const closes = block.indexOf("\n}");
  const at = block.indexOf(`"${command}"`);
  return at >= 0 && closes > 0 && at < closes;
};
check(
  "the block-heads-the-call predicate bites on a binding below the declaration and nowhere else",
  [
    headDeclares('export async function a(): Promise<void> {\n  await invoke("host_x");\n}\n', "host_x"),
    headDeclares('export async function a(): Promise<void> {\n  gate();\n}\n\nexport const b = async () => {\n  await invoke("host_x");\n};\n', "host_x"),
    headDeclares('const b = async () => {\n  await invoke("host_x");\n};\n', "host_x"),
  ],
  [true, false, false],
);
check(
  "and every daemon command is called inside the function its block declares",
  holders.filter((held) => held.block !== undefined && !headDeclares(held.block, held.name)).map((held) => held.name),
  [],
);
/*
 * ⚠ **And the gate reads the declared capability rather than deriving one, on
 * the settled payload rather than the cached one.** `hostPlatform()` narrows
 * `"android"` to `"other"` along with every future desktop target, and
 * `nativeBoot()` answers `null` until the one `host_boot` call lands — so a
 * synchronous read would answer "this device cannot" for every call made in the
 * frames before it, and `localRoute.ts` resolves a route on a wake, which is
 * precisely then. Both wrong answers are asserted absent, because either one
 * leaves every assertion above it green.
 */
const gateBody = bridgeFns.find((block) => /function canHostDaemonHere\b/.test(block)) ?? "";
check("the gate was found to read", gateBody.length > 0, true);
check(
  "and it reads the capability the shell declared, awaiting the one boot call",
  [
    /\bcanHostDaemon\b/.test(gateBody),
    /await hostReady/.test(gateBody),
    /hostPlatform\(/.test(gateBody),
    /nativeBoot\(\)/.test(gateBody),
  ],
  [true, true, false, false],
);
/*
 * ⚠ **And that silence is not a refusal, which is the third wrong answer and the
 * one that shipped.** The gate first read `?.canHostDaemon === true`, folding a
 * browser, an explicit `false` and *an unsettled payload* into one `no`. The
 * third is silence, and treating it as a refusal costs the whole local route:
 * measured, `webcheck.local-route.ts` went to eight failures, because its
 * `hostReady` settles at import before the driver installs its shell, so the
 * payload is `null` for its entire run — a fact that file pins about itself. Only
 * an explicit `false` means *no daemon can be on this device*, and it is the one
 * Android sends. Asserted as the pair so neither half can be dropped.
 */
check(
  "while an unsettled payload falls back rather than refusing",
  [/boot === null/.test(gateBody), /inNativeShell\(\)/.test(gateBody), /\?\.canHostDaemon === true/.test(gateBody)],
  [true, true, false],
);

/*
 * ⚠ **The `(async)` rule for a platform panel, which that file's own header
 * states and nothing held it to.**
 *
 * `commands.rs` says it at length: the panel's result is delivered *by* the main
 * event loop, so a bare `#[tauri::command]` blocking on `blocking_save_file` or
 * `blocking_pick_folder` is waiting on the loop it is itself holding — a frozen
 * window at best and a deadlock at worst. The attribute is the whole fix and the
 * docblock already warns it is easy to lose in a refactor, which is a hazard named
 * with no mechanism behind it.
 *
 * Split on the attribute and look at what each body reaches. Comment-stripped, or
 * the paragraph above would match itself.
 */
const panelBlocks = commandsCode
  .split(/(?=#\[tauri::command)/)
  .filter((block) => /app\s*\n?\s*\.dialog\(\)|\.dialog\(\)|\.blocking_/.test(block));
const panelNames = panelBlocks.map((block) => /pub (?:async )?fn ([a-z0-9_]+)/.exec(block)?.[1] ?? "?");
report("some command waits on a platform panel", panelBlocks.length > 0, panelNames.join(" "));
check(
  "and every command that does runs off the main thread",
  panelBlocks.filter((block) => !/^#\[tauri::command\([^)]*async[^)]*\)\]/.test(block.trim())).map(
    (block) => /pub (?:async )?fn ([a-z0-9_]+)/.exec(block)?.[1] ?? "?",
  ),
  [],
);

/* ------------------------------------------------------------------ *
 * Versions: the two this package does not add
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe versions, and the six that stay six\n");

const rootManifest = json("package.json");
const rootVersion = String(rootManifest["version"]);
const confVersion = conf["version"];

/*
 * **A path, not a number.** `docs/RELEASING.md` says all six sites move together in
 * one commit; a literal here would make it seven, in a file `pincheck` reads by
 * literal path and therefore would not read at all. Tauri resolves this against
 * the config file's own directory and takes the `version` field out of it.
 */
check(
  "tauri.conf.json's version is a path rather than a literal",
  typeof confVersion === "string" && !/^\d/.test(confVersion),
  true,
);
check(
  "and the path it names is the repository's root manifest",
  resolve(ROOT, TAURI_DIR, String(confVersion)),
  resolve(ROOT, "package.json"),
);

const cargoToml = read(`${TAURI_DIR}/Cargo.toml`);
const cargoVersion = capture(cargoToml, /^version = "([^"]+)"$/m);
check("Cargo.toml's version was readable", cargoVersion !== null, true);
check("and it is the inert one", cargoVersion, "0.0.0");
/*
 * The negative earns its place: it makes "somebody bumped it in sympathy with the
 * release" a failure rather than a seventh site nobody notices.
 */
check("which is deliberately not this release's", cargoVersion !== rootVersion, true);

const nativeManifest = json(`${NATIVE}/package.json`);
check("the native package declares no version of its own", Object.hasOwn(nativeManifest, "version"), false);
check("and it is private", nativeManifest["private"], true);

const cliPin = capture(read(`${NATIVE}/package.json`), /"@tauri-apps\/cli":\s*"([^"]+)"/);
const cratePin = capture(cargoToml, /^tauri = \{ version = "([^"]+)"/m);
const buildPin = capture(cargoToml, /^tauri-build = \{ version = "([^"]+)"/m);
check("the CLI pin was readable", cliPin !== null, true);
check("and it is exact rather than a range", /^\d+\.\d+\.\d+$/.test(cliPin ?? ""), true);
check("the tauri crate pin was readable", cratePin !== null, true);
check("and so was tauri-build's", buildPin !== null, true);
/*
 * The major and not the exact version: the CLI and the crates are published on
 * their own release lines and pinning them equal would be pinning a coincidence.
 * What actually breaks is a major drift, and that is what this says.
 */
check(
  "the CLI and both crates are the same major",
  [cliPin, cratePin, buildPin].map((v) => (v ?? "").split(".")[0]),
  ["2", "2", "2"],
);
/*
 * And the one line that compares a file to what would actually be *built*, rather
 * than to another file: `pincheck`'s argument for reading `node_modules`.
 */
const lockedTauri = capture(read(`${TAURI_DIR}/Cargo.lock`), /\nname = "tauri"\nversion = "([^"]+)"\n/);
check("Cargo.lock is committed and readable", lockedTauri !== null, true);
check("and the locked tauri is the one Cargo.toml asks for", lockedTauri, cratePin);

/* ------------------------------------------------------------------ *
 * Placement: out of the workspace, out of the image
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhere this package sits, and the three things that depend on it\n");

const workspace = read("pnpm-workspace.yaml");
/*
 * ⚠ **One line, three consequences**, and all three are invisible from here:
 * `@tauri-apps/cli` and its platform binary would install on every daemon host in
 * the fleet (`deploy/bootstrap.sh` and `deploy/deploy.sh` both run an unfiltered
 * root install); `deploy/deploy.sh`'s `RELAY_INPUTS` matches `pnpm-lock.yaml`, so
 * a Tauri bump would recreate the relay container and drop every tunnel; and the
 * control plane's image would stop building, because `--frozen-lockfile` verifies
 * the lockfile against every importer and the build context cannot see this one.
 * Q4.114 is the same argument at 552 MB.
 */
check("the root workspace excludes this package", /^\s*-\s*'!packages\/native'\s*$/m.test(workspace), true);
/*
 * Exclusion alone is not enough: pnpm resolves a root by searching *upwards*, so
 * `pnpm install` in here found the repository's root, installed the three projects
 * it lists and left this one with no `node_modules` — silently, exit 0.
 */
const ownRoot = read(`${NATIVE}/pnpm-workspace.yaml`);
check("and this package is its own pnpm root", /^\s*-\s*'\.'\s*$/m.test(ownRoot), true);
check(
  "which lists itself and nothing else",
  [...ownRoot.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]),
  ["."],
);
check("so the root lockfile holds no importer for it", read("pnpm-lock.yaml").includes("packages/native"), false);

/*
 * The control plane is a service that spawns nothing and draws nothing native, so
 * none of this belongs in its image. `.dockerignore` is deny-first, so the
 * assertion is that nothing allows it back in and that no COPY line names it —
 * the twice-written file list, held to saying nothing about this package twice.
 */
check("no .dockerignore line allows this package into the build context", /^!packages\/native/m.test(read(".dockerignore")), false);
check("and no Dockerfile stage copies it", read("deploy/docker/Dockerfile").includes("packages/native"), false);

/*
 * The root `tsconfig.json` compiles `packages/*​/src/**​/*.ts` and
 * `packages/*​/scripts/**​/*.ts` under `lib: ["ES2023"]`, `types: ["node"]` and
 * NodeNext — correct for everything that runs under `tsx`, and unable to compile a
 * line mentioning `window`. This package holds no TypeScript at all, so it needs
 * no exception; a `.ts` appearing here would be compiled by the daemon's config,
 * and a `.tsx` by nothing. Asserted rather than excluded, because an `exclude`
 * would make the second case silent.
 */
const strayTs: string[] = [];
const sweep = (dir: string, base: string): void => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (/^(node_modules|target|gen)$/.test(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sweep(path, `${base}/${entry}`);
    else if (/\.tsx?$/.test(entry)) strayTs.push(`${base}/${entry}`);
  }
};
sweep(join(ROOT, NATIVE), NATIVE);
check("this package holds no TypeScript, so no config has to claim it", strayTs, []);

/*
 * And the driver that walks `packages/` still skips what this package builds.
 * Measured at 2.9 GB after one `cargo check`: left in, `docscheck` reads every
 * `.json` fingerprint in there into its symbol corpus, which is assertion 4 of
 * that driver switched off in the direction that reads as passing.
 */
/*
 * ⚠ **Read off the comment-stripped source, and that is not caution.** The
 * paragraph `docscheck` now carries above its two skips names `gen/schemas`,
 * `gen/android` and `gen/apple` while explaining which of them is source, and it
 * quotes `SKIP_DIR` and `SKIP_PATH` to do it. Against raw text a capture here can
 * be satisfied by the prose that *describes* the skip instead of by the skip —
 * `cargoCode` further down carries the measurement where exactly that happened.
 */
const docscheckCode = read("scripts/docscheck.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");
const skipDir = capture(docscheckCode, /const SKIP_DIR = \/\^\(([^)]+)\)\$\//);
check("docscheck's directory skip was readable", skipDir !== null, true);
check("and it still skips this package's Rust build tree", (skipDir ?? "").split("|").includes("target"), true);
/*
 * ⚠ **`gen` is deliberately no longer in that list, and the assertion changed with
 * it rather than being deleted.** `gen/android` is committed hand-edited source:
 * this driver reads two files out of it a hundred lines down — `build.gradle.kts`
 * for the `rustls-platform-verifier` dependency and `proguard-rules.pro` for the
 * keep rule that stops R8 stripping it — so a rule in `.claude/rules/` has to be
 * able to point at those files, and a skip keyed on the bare name `gen` made that
 * a dead glob by construction. What replaced it is a path-based skip, and what is
 * worth asserting from *this* driver is that the pattern over there still names
 * this package's two genuinely generated trees at all: that is the half that goes
 * quiet if somebody replaces the pattern wholesale. `docscheck` pins the split
 * against its own walk, which is the half this one cannot see.
 */
check("and `gen` is not, which is what makes gen/android reachable", (skipDir ?? "").split("|").includes("gen"), false);
const skipPath = capture(docscheckCode, /const SKIP_PATH =\s*(\/[^\n]+\/);/);
check("docscheck's path skip was readable", skipPath !== null, true);
check(
  "and it still refuses the two trees this package generates",
  ["schemas", "apple"].filter((d) => !(skipPath ?? "").includes(d)),
  [],
);
/*
 * And the same driver can read this package's Rust at all, which is the other half
 * of the same edit: `src-tauri/src` is where the control-plane proxy, the keyring
 * keying rule and the navigation rule live, so a decision citing one of their
 * symbols has to be able to resolve. Safe **only** with the skip above — a corpus
 * that reached a build tree would read every vendored crate in it.
 */
const sourceExt = capture(docscheckCode, /const SOURCE_EXT = \/\\\.\(([^)]+)\)\$\//);
check("docscheck's extension list was readable", sourceExt !== null, true);
check("and it reads Rust", (sourceExt ?? "").split("|").includes("rs"), true);
/*
 * Not `toml`, and the negative is the assertion: `Cargo.toml` is a manifest of
 * dependency names and `Cargo.lock` a larger one, which is the hazard that driver
 * already refuses about `pnpm-lock.yaml` — a corpus of dependency names lets a
 * stale symbol resolve to somebody else's package.
 */
check("and not a manifest of dependency names", (sourceExt ?? "").split("|").includes("toml"), false);

const gitignore = read(".gitignore");
check(
  "and neither tree is tracked",
  [`${TAURI_DIR}/target/`, `${TAURI_DIR}/gen/schemas/`].filter((p) => !gitignore.includes(p)),
  [],
);

/* ------------------------------------------------------------------ *
 * The daemon payload, and the two sweeps it has to stay out of
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe daemon this app carries, and where it is allowed to sit\n");

const STAGE = "packages/native/scripts/build-daemon.mjs";
const stage = read(STAGE);

/*
 * **The runtime is a helper app in `Contents/Helpers` and the payload is a
 * `resources` entry, and swapping them is the failure this pair exists to catch.**
 *
 * The helper lands in `Contents/Helpers/`, where codesign treats it as nested
 * code — a bundle with its own signature, which the app's seal records and
 * `--verify --deep` walks; `resources` lands in `Contents/Resources/` and is not
 * reliably signed at all. `node` is the only Mach-O in the payload — everything
 * else is JavaScript, since `node:sqlite` is built in and the whole dependency set
 * is pure JS — so it is the only thing that has to be nested code, and putting the
 * JS tree there instead would put 200 MB through a code-signing walk that has
 * nothing to sign.
 *
 * ⚠ **A helper rather than an `externalBin`, and the Dock is why.** An
 * `externalBin` lands in `Contents/MacOS/`, and to LaunchServices a binary there
 * *is* Reemoat.app: libuv registers a process when `process.title` is set, npm sets
 * one for every MCP server an agent starts through `npx`, and each became a
 * Foreground application of `com.reemoat.app` with a blank "exec" tile in the
 * Dock. Measured with `lsappinfo` on 0.10.1; `build-daemon.mjs` carries the table.
 * So `externalBin` is asserted **absent**, and not only for the Dock: a runtime
 * there as well would be the 122 MB shipped twice that the shim assertion below
 * exists to prevent.
 *
 * The helper's source is asserted as the staging path because that path is a
 * decision: `target/` stands where `Contents/` stands, which is what lets one
 * relative path reach the runtime from the payload and from the executable in a
 * bundle and in `tauri dev` alike.
 */
check("nothing is an external binary, so Contents/MacOS holds the app alone", "externalBin" in bundle, false);
const macFiles = (((bundle["macOS"] ?? {}) as Record<string, unknown>)["files"] ?? {}) as Record<string, unknown>;
const helperEntries = Object.entries(macFiles).filter(([dest]) => dest.startsWith("Helpers/"));
check("the runtime is exactly one helper in Contents/Helpers", helperEntries.length, 1);
const [helperDest, helperSource] = helperEntries[0] ?? ["", ""];
const RUNTIME_HELPER = helperDest.slice("Helpers/".length);
check(
  "and it is an application bundle, staged where Contents/ stands",
  [/^[^/]+\.app$/.test(RUNTIME_HELPER), helperSource],
  [true, `target/Helpers/${RUNTIME_HELPER}`],
);
/*
 * ⚠ **`LSUIElement` is the whole fix, and it is one key in a file no build reads
 * until a person is looking at the Dock.** Measured on 0.10.1 with the same bytes
 * each time: the runtime in `Contents/MacOS` with a title set is
 * `type="Foreground"`, the same runtime in a helper carrying this key is
 * `type="UIElement"`. Nothing compiles, links or signs differently without it — so
 * it is asserted here, off the committed file `build-daemon.mjs` copies, with the
 * comment layer stripped because that file's prose names every key it carries.
 *
 * Its own identifier as well: sharing `com.reemoat.app` would make two bundles
 * claim one identity, which is the confusion the helper exists to end.
 *
 * ⚠ **And the app's own `Info.plist` must not carry the key**, which is the
 * obvious one-line fix and the rejected one: it would take Reemoat's own Dock icon
 * and menu bar away along with the blank ones.
 */
const helperPlistRaw = read(`${TAURI_DIR}/runtime/Info.plist`);
const helperPlist = xmlCode(helperPlistRaw);
check(
  "the helper's Info.plist survived the comment strip",
  helperPlistRaw.length > helperPlist.length && helperPlist.includes("<dict>"),
  true,
);
const plistValue = (xml: string, key: string): string | null =>
  capture(xml, new RegExp(`<key>${key}</key>\\s*(<true/>|<false/>|<string>[^<]*</string>)`));
check("and it keeps the runtime out of the Dock: LSUIElement is true", plistValue(helperPlist, "LSUIElement"), "<true/>");
check(
  "and it is an application of its own identity whose executable is the runtime",
  [
    plistValue(helperPlist, "CFBundleIdentifier"),
    plistValue(helperPlist, "CFBundleExecutable"),
    plistValue(helperPlist, "CFBundlePackageType"),
  ],
  [`<string>${String(conf["identifier"])}.runtime</string>`, "<string>node</string>", "<string>APPL</string>"],
);
check(
  "while the app's own Info.plist does not carry the key, or Reemoat would leave the Dock too",
  /LSUIElement/.test(xmlCode(read(`${TAURI_DIR}/Info.plist`))),
  false,
);
/*
 * ⚠ **The map form, not the list form.** `resource_relpath` in `tauri-utils` maps
 * `..` to a literal `_up_` path segment, so a list entry reaching out of
 * `src-tauri` lands at `Resources/_up_/_up_/…` and `resource_dir().join("daemon")`
 * finds nothing. The map form honours the destination it is given. Asserted as the
 * whole object rather than the key, because the destination is what `daemon.rs`
 * joins onto and a renamed value is a path that resolves to nothing at runtime.
 */
check("the payload is a resource, by the map form", bundle["resources"], { "target/daemon/": "daemon" });
/*
 * ⚠ **`target/` is not a tidiness choice, it is what keeps two other drivers
 * honest**, and it is the one thing about this staging directory that has to be
 * asserted rather than remembered.
 *
 * The payload is a verbatim copy of `src/`, `scripts/` and `deploy/`. Staged
 * anywhere else under `packages/native` it would be caught by this file's own
 * no-TypeScript sweep — which is the *good* failure. The bad one is `docscheck`:
 * it walks the working tree rather than `git ls-files`, so a second copy of every
 * `.ts` in `src/` would enter its symbol corpus, and assertion 4 there would start
 * answering `true` for symbols that no longer exist anywhere real. That is that
 * driver switched off in the direction that reads as passing. `SKIP_DIR` already
 * holds `target`, so the destination is chosen to land inside a skip that exists
 * rather than to need a new one.
 */
const stageDest = Object.keys((bundle["resources"] ?? {}) as Record<string, unknown>)[0] ?? "";
check("and it is staged under target/, which both sweeps already skip", stageDest.startsWith("target/"), true);
check("the staging script is where the config expects it", existsSync(join(ROOT, STAGE)), true);
/*
 * **Staged by its own step, never by `beforeBuildCommand`.** Resources are copied
 * from inside `build.rs` by `tauri-build`, and this crate's own `build.rs` refuses a
 * macOS build whose runtime helper is missing or staged for the other
 * architecture, so both are read by *cargo* — `cargo clippy`, `cargo test` and
 * `tauri build --no-bundle` all fail if the directory is absent, and the `native`
 * CI job runs all three. A `beforeBuildCommand` runs for `tauri build` alone and
 * would leave those three broken on a clean checkout. Both manifests are asserted
 * because the root script is what CI calls and the package script is what
 * actually stages.
 */
check(
  "the root exposes a staging step",
  /"native:stage":\s*"pnpm --dir packages\/native run stage"/.test(read("package.json")),
  true,
);
const nativePkg = read(`${NATIVE}/package.json`);
check("the package defines it", /"stage":\s*"node scripts\/build-daemon\.mjs"/.test(nativePkg), true);
/*
 * And both cargo-driving scripts run it first. Not a convenience: `tauri dev` runs
 * `build.rs` exactly like `tauri build` does, so a developer who has never staged
 * gets `ResourcePathNotFound` from a Rust build rather than a missing payload.
 */
for (const script of ["dev", "build"] as const) {
  check(
    `\`${script}\` stages before it reaches cargo`,
    new RegExp(`"${script}":\\s*"node scripts/build-daemon\\.mjs && tauri `).test(nativePkg),
    true,
  );
}
/*
 * ⚠ **The runtime is downloaded and verified, never copied off the build machine.**
 * `process.execPath` on this checkout is Homebrew's, and `otool -L` names seven
 * Homebrew dylibs under it (`@rpath/libnode.147.dylib`, `libuv`, `libada`, …) — a
 * bundle built from it runs on the machine that built it and nowhere else. And
 * since what is fetched is an executable that will be signed with this project's
 * identity and run as the user, the checksum step is not optional hygiene.
 */
check("the runtime is fetched from nodejs.org", /const NODE_DIST = "https:\/\/nodejs\.org\/dist"/.test(stage), true);
check("and verified against the release's own manifest", /SHASUMS256\.txt/.test(stage) && /checksum mismatch/.test(stage), true);
/*
 * ⚠ **A cache is valid only if the thing it caches is there, and this asked the
 * directory.**
 *
 * `existsSync(extracted)` answered `true` for a directory that had been emptied,
 * so the script reported *(cached)* and handed back a tree with no `bin/node` —
 * surfacing two functions later as `spawnSync … ENOENT` on a path whose own name
 * says "cache", which reads as a corrupt download. It broke CI on
 * `97d1e58`, having been poisoned by the run before it.
 *
 * Two independent ways in, which is why both halves are pinned. `Swatinem/rust-cache`
 * treats every subdirectory of `target/` as a build profile and cleans what it
 * does not recognise before saving — so the cache lived somewhere another tool
 * owns, and a green run saved the directory without its 130 MB binary. And
 * locally, `run()` aborts the script on a non-zero exit, so an interrupted `tar`
 * leaves a partial directory that every later run then trusts.
 *
 * The correctness half is validating by the **file about to be executed**; the
 * cost half is not living under `target/` at all. Neither replaces the other: the
 * first makes a poisoned cache a re-download instead of a failure, the second
 * stops it being poisoned every run.
 */
check("the runtime cache is validated by the binary, not the directory", /existsSync\(binary\)/.test(stage), true);
check("and a directory that lost its binary is refetched", /rmSync\(extracted, \{ recursive: true, force: true \}\)/.test(stage), true);
check(
  "and it does not live where rust-cache prunes",
  /const cacheDir = join\(tauriRoot, "\.node-cache"\)/.test(stage),
  true,
);
check("and it is gitignored under its new name", /^packages\/native\/src-tauri\/\.node-cache\/$/m.test(gitignore), true);
/*
 * ⚠ **And the workflow caches the directory the script actually writes to.** The
 * path is now written down twice — once in `build-daemon.mjs`, once in
 * `check.yml` — and a mismatch is silent in the direction that costs the most: CI
 * saves an empty path, every run re-downloads 50 MB, and nothing anywhere is red.
 * That is the `.dockerignore`/Dockerfile hazard `CLAUDE.md` already names, at a
 * smaller scale, and it gets the same treatment: read both off disk.
 *
 * The cache key is pinned to `NODE_VERSION` rather than to the script's hash —
 * the file changes far more often than the version does, and a key that churns is
 * a cache that never hits.
 */
const checkWorkflow = read(".github/workflows/check.yml");
/**
 * `check.yml` with its comments taken out.
 *
 * ⚠ **Every derivation over this file must read the stripped copy.** A comment
 * naming a toolchain triple satisfied the census that comment was explaining,
 * and the quiet direction is the one that matters: delete the real
 * `aarch64-linux-android<n>-clang` and leave a comment mentioning it, and both
 * the count below and the minSdk agreement beside it stay green over a CI leg
 * that names no toolchain at all. `deploycheck` states the same two rules over
 * the same file — a whole-line `#`, and the first `#` preceded by whitespace
 * outside a quoted scalar.
 */
/**
 * `check.yml` with its comments taken out, as a NAMED function.
 *
 * ⚠ **Named rather than applied inline, because the control below has to be
 * able to reach it.** It was an immediately-applied arrow, so the non-counting
 * control was written against a second, simpler regex declared inside the
 * assertion — which exercised that throwaway and never this stripper, and could
 * not go red whatever this did. Two rules, the same two `deploycheck` states
 * over the same file: a whole-line `#`, and the first `#` preceded by
 * whitespace outside a quoted scalar.
 */
function yamlCode(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return "";
      let quote: string | null = null;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i] as string;
        if (quote !== null) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === "#" && /\s/.test(line[i - 1] ?? " ")) {
          return line.slice(0, i).replace(/\s+$/, "");
        }
      }
      return line;
    })
    .join("\n");
}
const checkWorkflowCode = yamlCode(checkWorkflow);
check(
  "the workflow caches the directory the staging script writes to",
  /path: packages\/native\/src-tauri\/\.node-cache/.test(checkWorkflowCode),
  true,
);
check(
  "and keys that cache on the pinned runtime version",
  /steps\.node-runtime\.outputs\.version/.test(checkWorkflowCode),
  true,
);
/*
 * **The payload must contain no symlink, and the script asserts it itself.** The
 * bundler's `copy_file` refuses anything that is not a regular file and its walker
 * does not follow links, so one symlink is a `cargo build` that dies with
 * `"… is not a file"` — reported as a broken Rust build rather than as a packaging
 * mistake. Pinned here so the self-check cannot be deleted as redundant.
 */
check("the payload refuses to contain a symlink", /function assertNoSymlinks/.test(stage), true);
/*
 * ⚠ **The runtime is placed once, and this assertion exists because it was twice.**
 *
 * The payload needs a `node` inside `node_modules/.bin` — the package shims test
 * `$basedir/node`, and `deploy/agents.sh` resolves the runtime as the node *beside*
 * npm. Copying the binary there satisfies both and costs **122 MB, byte-identical
 * to the bundled runtime**: measured at 360 MiB projected for the bundle against
 * 244 MiB without it. Nothing failed, nothing warned, and the only symptom was a
 * download twice the size it needed to be.
 *
 * A symlink is what this wants and is the one thing the bundler cannot copy, so
 * what sits there is a shim. Asserted as "writes a shim, does not copy the binary"
 * rather than by measuring the staged tree, because this driver has to pass on a
 * clean checkout where nothing has been staged yet.
 *
 * ⚠ **The shim's first candidate is the helper, four levels up from `.bin`**,
 * which is `Contents/` in a bundle and `target/` in a development build — the
 * resource map above puts the payload at `daemon` directly under each. Matched
 * against the template as written, so a candidate that drifts from the helper's
 * name in the configuration is a red line rather than a daemon whose `npx` finds
 * no runtime.
 */
check(
  "the runtime is placed once and reached by a shim",
  new RegExp(
    `for candidate in "\\$basedir/\\.\\./\\.\\./\\.\\./\\.\\./Helpers/\\$\\{RUNTIME_HELPER\\}/Contents/MacOS/node"`,
  ).test(stage) && !/cpSync\(node, join\(binDir/.test(stage),
  true,
);
/*
 * ⚠ **And the shim's last line is a refusal, never a PATH lookup.**
 *
 * It used to read `exec node "$@"`, with a comment beside it calling PATH *"the
 * honest last word"*. It is not one: `daemon.rs`'s `daemon_path` puts the payload's
 * own `node_modules/.bin` **first** on the daemon's `PATH` — deliberately, so
 * `deploy/agents.sh` resolves the node *beside* npm — and that directory is where
 * this shim lives. So the fallback found the shim and re-execed it, for ever, on
 * any layout where both relative probes miss. `docs/NATIVE.md`'s *Open
 * measurements* names a `.deb` and an AppImage as exactly such a layout, and the
 * symptom there would have been a daemon that never starts rather than one that
 * says why.
 *
 * Asserted as an **absence** plus the sentence that replaced it, because the
 * positive alone would pass on a shim that carried both.
 */
/*
 * ⚠ **Compared against the code rather than the text, and this driver's own
 * `bootCode` says why.** Written against `stage` raw it fails on the docblock
 * above the shim — the one that explains what the old line did and quotes it —
 * and the quiet direction is the same reader passing over a *commented-out*
 * fallback. `//` is filtered by line start rather than anywhere, because that
 * file is full of `https://` inside string literals.
 */
const stageCode = stage
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");
check(
  "and its last word is a refusal rather than a PATH lookup",
  [/exec node "\$@"/.test(stageCode), /exit 127/.test(stageCode)],
  [false, true],
);
/*
 * ⚠ **One helper name, four copies, and a mismatch between any two is a bundle
 * that builds, signs and starts no daemon.** `bundle.macOS.files` says where the
 * bundler puts it, `build-daemon.mjs` stages it and writes the shim's path to it,
 * `build.rs` checks it and places it for a development build, and `daemon.rs`
 * spawns what is inside it. Nothing compiles one against another — a string in
 * JSON, one in JavaScript and two in Rust — so they are read here and compared,
 * each off its code rather than its prose, since every one of those files explains
 * the helper by name in a comment.
 */
check(
  "the helper's name is one string in the config, the staging script, build.rs and daemon.rs",
  [
    capture(stageCode, /const RUNTIME_HELPER = "([^"]+)";/),
    capture(rustCode(read(`${TAURI_DIR}/build.rs`)), /const RUNTIME_HELPER: &str = "([^"]+)";/),
    capture(rustCode(read(`${TAURI_DIR}/src/daemon.rs`)), /pub const RUNTIME_HELPER: &str = "([^"]+)";/),
  ],
  [RUNTIME_HELPER, RUNTIME_HELPER, RUNTIME_HELPER],
);
/*
 * ⚠ **Signed by the staging step, inside out, because the bundler will not.**
 * tauri-bundler 2.11 signs the app, its frameworks and its `externalBin` entries —
 * every one with the app's entitlements — and copies `bundle.macOS.files` as it
 * finds them before sealing the app around them. A helper that arrives unsigned is
 * sealed over as it is, and `codesign --verify --deep --strict` then refuses the
 * whole app: *"In subcomponent: …/Helpers/Reemoat Runtime.app"*, measured. So the
 * staging script signs it, with `entitlements-node.plist` and the hardened
 * runtime, verifies what it signed, and refuses the one configuration where the
 * identity it needs does not exist yet — `APPLE_CERTIFICATE`, which the bundler
 * imports into a keychain of its own during `tauri build`.
 *
 * Read off the code, and only as far as a regex can: whether the signature is
 * *accepted* is `codesign`'s to say, and a macOS build runs it on every stage.
 */
check(
  "the helper is signed with the runtime's own entitlements under the hardened runtime, then verified",
  [
    /cpSync\(join\(tauriRoot, "runtime", "Info\.plist"\)/.test(stageCode),
    /"--entitlements",\s*join\(tauriRoot, "entitlements-node\.plist"\)/.test(stageCode),
    /"--options",\s*"runtime"/.test(stageCode),
    /run\("codesign", \["--verify", "--strict", helper\]\)/.test(stageCode),
    /identity === "-" && process\.env\.APPLE_CERTIFICATE/.test(stageCode),
  ],
  [true, true, true, true, true],
);
/*
 * ⚠ **And `build.rs` refuses a helper staged for the other architecture, which is
 * the check the runtime's file name used to make for free.** While the runtime was
 * an `externalBin`, `tauri-build` resolved `binaries/node-<target-triple>`, so an
 * Intel build staged on an Apple-silicon machine failed on a missing file. A fixed
 * path in `bundle.macOS.files` copies whatever is there — an arm64 `node` in an
 * Intel app, a daemon that never starts on the machines it was built for — so the
 * header of the binary is read instead. Both CPU types are pinned, because a table
 * that lost one arm would refuse that architecture's every build rather than
 * checking it.
 */
const buildRsCode = rustCode(read(`${TAURI_DIR}/build.rs`));
check(
  "build.rs reads the staged runtime's CPU type and knows both macOS architectures",
  [
    /runtime_helper\(\);\s*tauri_build::build\(\)/.test(buildRsCode),
    /"aarch64" => \(0x0100_000c_u32,/.test(buildRsCode),
    /"x86_64" => \(0x0100_0007_u32,/.test(buildRsCode),
  ],
  [true, true, true],
);
/*
 * ⚠ **The 552 MB that must not come back.** The two ACP adapters each pull a
 * coding-agent CLI as *optional* platform packages, which `pnpm-workspace.yaml`'s
 * `overrides` strip from the pnpm tree for the reasons Q4.114 gives at length.
 * npm has no equivalent of pnpm's `'-'`, so the payload drops the whole optional
 * set — and `deploy/docker/Dockerfile` already measured what that costs on its own
 * ("`--no-optional` would take esbuild's own platform binary with it and break
 * `tsx`"), which is why exactly one of them is named back in.
 */
check("optional dependencies are dropped from the payload", /"--omit=optional"/.test(stage), true);
/*
 * ⚠ **And every target names esbuild's binary back in — checked per target, not
 * once.** This is the assertion that would have gone vacuous the day a second
 * platform was added: one `ESBUILD_BINARY` constant covering macOS would pass
 * while a Linux build silently shipped a `tsx` with no compiler behind it. The
 * table is the unit, so the check counts it.
 */
const triples = [...stage.matchAll(/"([a-z0-9_]+-[a-z0-9-]+)":\s*\{\s*dir:/g)].map((m) => m[1]);
const withEsbuild = [...stage.matchAll(/esbuild:\s*"(@esbuild\/[a-z0-9-]+)"/g)].map((m) => m[1]);
check("more than one platform is described", triples.length > 1, true);
check("and every one of them names an esbuild binary", withEsbuild.length, triples.length);
/*
 * ⚠ **The workspace package the payload would otherwise ship without, and three
 * lines are the whole of it.**
 *
 * `@reemoat/protocol` holds the Noise handshake the daemon speaks to an app. It is
 * a pnpm *workspace* package, so in this checkout `node_modules/@reemoat/protocol`
 * is a link into `packages/protocol` — and the bundler copies no symlink, which is
 * why `build-daemon.mjs` writes a real directory instead. Nothing asserted that it
 * did, and the failure that leaves is the worst shape a packaging bug comes in:
 * take the three lines out and `typecheck`, every driver, `pnpm native:stage` and
 * `cargo build` all still succeed, while the **shipped app's daemon dies at its
 * first start** on `Cannot find module '@reemoat/protocol'`. It is a *static*
 * import on the entry path — `scripts/daemon.ts` imports `ensureMachineKey` from
 * `src/machinekey.ts`, which imports the package at load — so the process is gone
 * before it has listened on anything, and there is no green-versus-red anywhere
 * between the edit and a person's machine.
 *
 * Only the manifest and the sources are copied, deliberately: copying the package
 * whole would follow its own `node_modules`, every entry of which is a pnpm link,
 * and `dereference` would turn each into a full copy of a tree the payload root
 * already has. So both halves are named, because a payload with the manifest and
 * no `src` resolves the package and then fails on its entry point instead.
 */
check(
  "the payload carries the protocol package as a real directory",
  /join\(stageDir, "node_modules", "@reemoat", "protocol"\)/.test(stage),
  true,
);
check(
  "and copies its manifest",
  /cpSync\(join\(repoRoot, "packages", "protocol", "package\.json"\), join\(protocol, "package\.json"\)\)/.test(stage),
  true,
);
check(
  "and its sources, dereferenced",
  /cpSync\(join\(repoRoot, "packages", "protocol", "src"\), join\(protocol, "src"\), \{\s*recursive: true,\s*dereference: true,\s*\}\)/.test(
    stage,
  ),
  true,
);
/*
 * And the non-vacuity half, which is the part that decides whether the three
 * assertions above are worth anything. They pin a copy; what makes the copy
 * load-bearing is that the daemon's own entry point reaches the package at import
 * time. Read off `src/` rather than assumed, because the day nothing there imports
 * it the copy is dead weight and these lines should be deleted rather than kept
 * green — and the day the *first* import lands in a file the payload does not carry,
 * the count is what says so.
 */
/*
 * ⚠ **Value imports only.** The first spelling of this counted
 * `/["']@reemoat\/protocol["']/` over raw source, which matched
 * `src/relay/tunnel.ts`'s `import type { StaticKey }` — erased by TypeScript and
 * requiring nothing at runtime — and `src/relay/protocol.ts`'s *comment* naming
 * the package. Two of the four matches were not imports at all, so the report
 * would have stayed green in the one world it exists to rule out: every
 * remaining reference erased and the payload copy genuinely dead weight.
 */
const importsProtocolAtLoad = (source: string): boolean =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .split("\n")
    .some((line) => /["']@reemoat\/protocol["']/.test(line) && !/^\s*(?:import|export)\s+type\b/.test(line));
const protocolImporters = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
  .filter((rel) => rel.endsWith(".ts"))
  .filter((rel) => importsProtocolAtLoad(readFileSync(join(ROOT, "src", rel), "utf8")));
report(
  "and the daemon really needs it: src/ imports it at load",
  protocolImporters.length > 0 && importsProtocolAtLoad(read("scripts/daemon.ts")),
  `${protocolImporters.length} value importer(s) under src/: ${protocolImporters.sort().join(", ")}`,
);
/*
 * **The runtime binary is a build input and never a tracked file.** 122 MB. On
 * macOS it is staged under `target/Helpers`, which the `target/` line already
 * keeps out; for any other triple it is still `binaries/node-<target-triple>`,
 * the name an `externalBin` resolves — which is why that line stays.
 */
check(
  "the staged runtime is gitignored",
  /^packages\/native\/src-tauri\/binaries\/$/m.test(read(".gitignore")) &&
    /^packages\/native\/src-tauri\/target\/$/m.test(read(".gitignore")),
  true,
);

/* ------------------------------------------------------------------ *
 * Distribution: configured, and inert
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat shipping this would take, and what is switched off until then\n");

check("the identifier is not Tauri's placeholder", conf["identifier"] !== "com.tauri.dev", true);
/*
 * ⚠ **`dmg` is not a default target, and that is a measurement rather than a
 * preference.** Tauri's `bundle_dmg.sh` drives Finder over AppleScript to lay the
 * disk image window out, and from a non-interactive shell that times out:
 * `execution error: Finder got an error: AppleEvent timed out. (-1712)`, measured
 * 2026-09-14 — after the `.app` had already been built correctly. So with `dmg` in
 * this list the ordinary `pnpm native:build` fails on a machine nobody is logged
 * into, including every CI runner, *having produced the artifact that matters*.
 * `--bundles dmg` from a logged-in session is the documented way to get one, and
 * `docs/NATIVE.md` carries it.
 */
check(
  "the disk image is not bundled by default",
  ((bundle["targets"] ?? []) as string[]).includes("dmg"),
  false,
);
check("but an app bundle is", ((bundle["targets"] ?? []) as string[]).includes("app"), true);
/*
 * ── the platform overlays, and the one rule that keeps every assertion here true
 *
 * ⚠ **Tauri reads five configuration files and this driver reads one.**
 * `tauri-utils`' `config/parse.rs` merges `tauri.<platform>.conf.json` over the
 * base for `linux`, `windows`, `macos`, `android` and `ios`, through
 * `json_patch::merge` — RFC 7386, where an array **replaces** and a `null`
 * **deletes the key**.
 *
 * Measured on this checkout, 2026-09-19: with `target/daemon` and `binaries/`
 * both moved aside, `cargo check` fails inside `build.rs` with no overlay
 * present and **succeeds** with a `tauri.macos.conf.json` carrying
 * `{"bundle":{"externalBin":null,"resources":null}}`. So the overlays are read
 * by **cargo**, at compile time, and not only by the bundler — which is what
 * makes a client build a configuration file rather than a cargo feature.
 *
 * ⚠ And it is what makes every assertion in this file a claim about the *base
 * file alone*, silently, from the moment one overlay exists: the CSP, the empty
 * permission set, `signingIdentity: null`, `dragDropEnabled: false`,
 * `createUpdaterArtifacts`, the licence path. Re-running all of them against
 * five merged configs is one answer. **This is the other, and it is stronger:**
 * an overlay may set only a named allowlist of keys, so there is nothing an
 * overlay *can* say that an assertion here is about.
 */
process.stdout.write("\nthe platform overlays, and what one may say\n");
/*
 * `$schema` is editor metadata rather than configuration — the base carries it
 * and an overlay that did not would lose completion in every editor — so it is
 * named here rather than left to read as an oversight.
 */
const OVERLAY_KEYS = ["$schema", "bundle.externalBin", "bundle.resources", "bundle.targets"];
const flatten = (value: unknown, prefix = ""): string[] =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
        flatten(inner, prefix === "" ? key : `${prefix}.${key}`),
      )
    : [prefix];
const overlays = readdirSync(join(ROOT, TAURI_DIR))
  .filter((name) => /^tauri\.[a-z]+\.conf\.json$/.test(name))
  .sort();
/*
 * ⚠ **`tauri.macos.conf.json` must not exist, and that is not tidiness.** The
 * base file *is* the macOS shape — `targets: ["app"]`, the payload, the hardened
 * runtime — so a macOS overlay would make every assertion above describe a
 * configuration no build ever uses, while staying green.
 */
check("the overlays are exactly the four client platforms", overlays, [
  "tauri.android.conf.json",
  "tauri.ios.conf.json",
  "tauri.linux.conf.json",
  "tauri.windows.conf.json",
]);
for (const name of overlays) {
  const overlay = json(`${TAURI_DIR}/${name}`);
  const keys = flatten(overlay).sort();
  check(`${name} sets only keys an overlay may set`, keys.filter((key) => !OVERLAY_KEYS.includes(key)), []);
  /*
   * The payload, deleted rather than emptied. `[]` and `{}` would merge to an
   * empty container, which `tauri-build` walks and finds nothing in; `null`
   * removes the field, which is the state the base file was in before either was
   * added. Both work today and only one of them says what it means.
   */
  const overlayBundle = (overlay["bundle"] ?? {}) as Record<string, unknown>;
  check(`and ${name} carries no daemon payload`, [overlayBundle["externalBin"], overlayBundle["resources"]], [
    null,
    null,
  ]);
  check(`and ${name} never asks for a disk image`, ((overlayBundle["targets"] ?? []) as string[]).includes("dmg"), false);
}
/*
 * The two desktop overlays name a bundler and the two mobile ones do not:
 * `tauri android build` and `tauri ios build` take the artifact kind on the
 * command line and read `bundle.targets` for nothing at all, so a value there
 * would be a setting with no reader.
 */
check(
  "the desktop overlays name their bundler and the mobile ones name none",
  overlays.map((name) => ((json(`${TAURI_DIR}/${name}`)["bundle"] as Record<string, unknown>)["targets"] ?? null)),
  [null, null, ["deb", "appimage"], ["nsis"]],
);
/*
 * And the sentence `build-daemon.mjs` refuses a Windows triple with names that
 * file by name. A refusal pointing at something that does not exist is worse
 * than no refusal, because it reads as authoritative.
 */
check(
  "the Windows refusal in build-daemon.mjs names a file that is there",
  /tauri\.windows\.conf\.json removes externalBin/.test(stageCode) &&
    overlays.includes("tauri.windows.conf.json"),
  true,
);
const mac = (bundle["macOS"] ?? {}) as Record<string, unknown>;
/*
 * Hardened runtime on, because notarization requires it and turning it on later is
 * the kind of change that reveals an entitlement was missing all along.
 */
check("the hardened runtime is on", mac["hardenedRuntime"], true);
check("an entitlements file is named", typeof mac["entitlements"], "string");
check("and it exists", existsSync(join(ROOT, TAURI_DIR, String(mac["entitlements"]))), true);
/*
 * **Two bundles, two signatures, two entitlement sets — and the split is the
 * assertion.**
 *
 * The app's set stays at one entitlement: this is the signature on the window
 * holding the fleet's credential. The bundled runtime's is five, because V8
 * cannot start under the hardened runtime without them — and they were *measured*
 * off the official build's own signature (`codesign -d --entitlements -`) rather
 * than chosen, so this list is what the people who build V8 ask for.
 *
 * Pinned as exact sets in both directions. A key added to the app's file is a
 * loosening of the wrong process — `disable-library-validation` there would mean
 * any dylib could be loaded into the window — and a key dropped from the
 * runtime's is a daemon that will not start. That one is no longer a failure
 * nobody sees until the first signed build: `build-daemon.mjs` signs the runtime
 * helper with this file on every build, ad-hoc when there is no identity.
 */
const keysOf = (rel: string): string[] =>
  [...read(rel).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1] ?? "").sort();
check("the app's entitlements stay at exactly one", keysOf(`${TAURI_DIR}/entitlements.plist`), [
  "com.apple.security.network.client",
]);
check("the runtime has its own file", existsSync(join(ROOT, TAURI_DIR, "entitlements-node.plist")), true);
check("and it carries exactly what V8 needs", keysOf(`${TAURI_DIR}/entitlements-node.plist`), [
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-executable-page-protection",
  "com.apple.security.cs.disable-library-validation",
]);
/*
 * ⚠ **`get-task-allow` is the one key in that measurement that must never be
 * copied**, and it is asserted absent rather than left to the exact-set check
 * above — because the failure it describes deserves its own sentence. It lets
 * another process attach a debugger and read the daemon's memory: every
 * transcript, the machine's signing keys, `identity.tunnel_key`. Node ships it
 * because Node's own builds are debuggable. Notarization rejects it, which is the
 * only reason anybody would find it by accident rather than by reading this.
 */
check(
  "and never the debug entitlement Node ships with",
  read(`${TAURI_DIR}/entitlements-node.plist`).includes("get-task-allow</key>"),
  false,
);
/*
 * ⚠ **No comment in a plist here may hold a double hyphen, and `plutil` will not
 * say so.** XML forbids one inside a comment. `plutil -lint` accepts it anyway;
 * codesign's parser does not, and refuses the whole file:
 * *"Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 15"*.
 * Measured on `entitlements-node.plist` the first time anything signed with it —
 * its comment quoted the `codesign` command that measured its keys, flags and
 * all, so the file that existed for the first signed build could not have signed
 * one. `xmlCode` above already states the rule; nothing held the files to it.
 *
 * Swept over every plist in the crate and in the helper's directory rather than
 * asserted of the four known ones, so a fifth arriving is held to it too, and the
 * predicate is driven both ways first: an empty offenders list is the passing
 * answer, so a pattern that stopped matching would read as a clean tree.
 */
const commentHasDoubleHyphen = (xml: string): boolean =>
  [...xml.matchAll(/<!--([\s\S]*?)-->/g)].some((m) => /--|-$/.test(m[1] ?? ""));
check(
  "the double-hyphen predicate bites where one is and nowhere else",
  [
    commentHasDoubleHyphen("<!-- codesign -d --xml -->\n<plist/>"),
    commentHasDoubleHyphen("<!-- ends in a hyphen--->"),
    commentHasDoubleHyphen("<!-- a single-hyphen word and an em dash — -->"),
    commentHasDoubleHyphen("<key>a--b</key>"),
  ],
  [true, true, false, false],
);
const plists = [
  ...readdirSync(join(ROOT, TAURI_DIR)).filter((name) => name.endsWith(".plist")),
  ...readdirSync(join(ROOT, TAURI_DIR, "runtime"))
    .filter((name) => name.endsWith(".plist"))
    .map((name) => `runtime/${name}`),
].sort();
report("the plists were found to sweep", plists.length >= 4, `${String(plists.length)}: ${plists.join(", ")}`);
check(
  "and no comment in one carries a double hyphen, which codesign refuses as malformed XML",
  plists.filter((rel) => commentHasDoubleHyphen(read(`${TAURI_DIR}/${rel}`))),
  [],
);
/*
 * ⚠ **The macOS floor is 13.0 because the *opt-in* background service needs it.**
 *
 * The daemon is an ordinary child process of this app and dies with it, which is
 * the default and needs no floor at all. What needs 13 is the switch beside it:
 * `SMAppService` is how a login item gets registered such that macOS owns it,
 * shows it in System Settings, and — the part that decides it — **removes it when
 * the app is deleted**. The alternative is a plist written by hand into
 * `~/Library/LaunchAgents`, which with `KeepAlive` survives the app being dragged
 * to the trash and relaunches a missing binary every ten seconds for ever.
 *
 * Pinned rather than left to drift, because lowering it would compile, install,
 * and then fail at the one call that matters — on the oldest machines, which are
 * the population least likely to report it. 11 and 12 are out of support, and the
 * nearest prior art in this space ships the same floor.
 */
check("the macOS floor is where the opt-in service starts", mac["minimumSystemVersion"], "13.0");
/*
 * ⚠ **Inert, and asserted inert.** With no `signingIdentity` a build is ad-hoc
 * signed and runs locally, which is what makes a development build work on a
 * machine with no certificate. A value committed here would be somebody's identity
 * in a public repository; signing is driven entirely by the environment —
 * `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` — so
 * neither an unsigned local build nor a signed release needs this field to move.
 */
check("no signing identity is committed", mac["signingIdentity"], null);
check("and no notarization provider is either", mac["providerShortName"], null);

/* ── the default server, and its absence here ────────────────────────────── */

/**
 * **Which fleet a build joins, and why this repository names none.**
 *
 * `option_env!("REEMOAT_DEFAULT_SERVER")` is the only build-time input this app
 * has. It is read in Rust rather than on the page for two reasons that both point
 * the same way: `native.ts` refuses `import.meta.env`-style flags in that layer,
 * and `host_cp`'s base has to live in the host process where the page cannot
 * reach it — which is the same string the OS keyring account is built from.
 *
 * ⚠ **Asserted absent, exactly as `signingIdentity` is.** This is AGPL software
 * and forks run their own control planes, so a value compiled in here would be
 * one deployment's address in everybody's binary. `cp-accounts.md` makes the same
 * argument for the two `REEMOAT_CP_*` addresses that reach the browser, and both
 * are for the same reason without a compiled-in default.
 */
const configRs = flat(read(`${TAURI_DIR}/src/config.rs`));
check(
  "the default server comes from the environment at compile time",
  /option_env!\("REEMOAT_DEFAULT_SERVER"\)/.test(configRs),
  true,
);
check("and nothing hard-codes one beside it", /const DEFAULT_SERVER: Option<&str> = Some\(/.test(configRs), false);
/*
 * Through the one normalizer, because a suggested value and a typed one have to
 * be the same spelling of the same server — two spellings is two credential keys,
 * one of which a sign-out would not reach.
 */
check("the suggestion goes through the one normalizer", /normalize_origin\(DEFAULT_SERVER\?\)/.test(configRs), true);
/*
 * ⚠ **`option_env!` is baked into a cached object file.** Without this line cargo
 * has no reason to recompile when the variable moves, so a fork that corrects its
 * address gets a binary silently keeping the previous one — a failure with no
 * symptom anywhere, which is why it is asserted rather than remembered.
 */
check(
  "cargo is told to notice the variable changing",
  /cargo:rerun-if-env-changed=REEMOAT_DEFAULT_SERVER/.test(read(`${TAURI_DIR}/build.rs`)),
  true,
);
/*
 * ⚠ **A suggestion for a form field, and never a value anything writes down.**
 * The first draft seeded it — first launch with a default compiled in wrote it to
 * `server.json` — and that was wrong twice: it skipped the setup screen, so the
 * app chose a fleet and said so afterwards on the sign-in form; and it created a
 * `credential#<origin>` keyring account for an origin nobody had confirmed.
 *
 * So `read_server` stays the **only** reader of *which server*, the shell calls
 * it and nothing else, and `default_server` is a second function answering a
 * second question. The two are held apart here because folding them is exactly
 * the edit that would pass every other assertion in this file.
 */
const shellRs = flat(read(`${TAURI_DIR}/src/lib.rs`));
check("the shell reads the chosen server and nothing else", /config::read_server\(&dir\)/.test(shellRs), true);
check("and never writes one at startup", /read_or_seed_server|write_server/.test(shellRs), false);
check("the suggestion is its own function", /pub fn default_server\(\) -> Option<String>/.test(configRs), true);
check("and it writes nothing", /fn default_server[\s\S]{0,200}write_server/.test(configRs), false);
/*
 * And it reaches the page as its own field. `Boot`/`NativeBoot` key equality is
 * asserted elsewhere in this file; what that cannot say is that the two fields
 * stay two.
 */
const commandsSrc = flat(read(`${TAURI_DIR}/src/commands.rs`));
check("the suggestion crosses the bridge under its own name", /rename = "defaultServer"/.test(commandsSrc), true);
check("and the chosen server is still a separate field", /pub server: Option<String>/.test(commandsSrc), true);
/*
 * **And no file in this repository supplies a value.** The sweep is over every
 * place a build is described — the native package, the root manifest, `deploy/`
 * and the workflows — for the name followed by an assignment. The
 * `rerun-if-env-changed=` declaration above is safe because there the `=`
 * *precedes* the name.
 */
const setters: string[] = [];
for (const file of [
  "package.json",
  `${NATIVE}/package.json`,
  `${TAURI_DIR}/tauri.conf.json`,
  ".github/workflows/check.yml",
  ".github/workflows/release.yml",
]) {
  if (/REEMOAT_DEFAULT_SERVER\s*[=:]\s*\S/.test(read(file))) setters.push(file);
}
check("and no file in this repository sets one", setters, []);

/* ── the private key in a file, and the mode it is created at ─────────────── */

/**
 * ⚠ **The device key's file fallback is a private key in plaintext, and what
 * bounds it is a mode set at `open` time.**
 *
 * `read_device_key_fallback`'s own docblock is blunt about why the file exists at
 * all — a Linux box with no D-Bus session or no unlocked collection accepts a
 * keyring write and keeps nothing, and the alternative to a file is an
 * installation that regenerates its static on every launch and spends a device
 * slot each time. So the file is the lesser failure, and the mode is the entire
 * difference between it and a bad one.
 *
 * `write_stored` is the single writer for all three of `server.json`'s subjects —
 * the origin, the device ids and the device keys — and it used to be `fs::write`.
 * That is wrong in three ways the docblock above it records at length, and the one
 * this pins is the first: `fs::write` creates at `0666 & !umask`, which is `0644`
 * under the default, on precisely the machines where "world-readable" has somebody
 * in it to read. Three docblocks and `.claude/rules/e2ee.md` said `0600` while no
 * line of code anywhere did.
 *
 * ⚠ **Asserted here although `cargo test` covers it, and the reason is which job
 * each runs in.** `config.rs`'s own tests do check the resulting mode — but they
 * need a Rust toolchain, so they live in the `native` job while this driver is in
 * `check` and deliberately runs no cargo. That is `flat`'s standing hazard at the
 * top of this file: the two can disagree indefinitely and either can be made green
 * on its own. A regression back to `fs::write` would leave both this assertion and
 * that test red, which is what makes it a regression rather than a discussion.
 */
const writeStored = between(configRs, "fn write_stored(", "pub fn read_device(");
check("the writer behind the fallback was found to read", writeStored.length > 0, true);
/*
 * The mode at **creation**, which is the half that closes the window in which the
 * bytes exist at the umask's mode — `write_private` records that ordering bug, and
 * a `set_permissions` after the fact is a fix with a race in it.
 */
check("the file is created with an explicit 0600", /options\.mode\(0o600\);/.test(writeStored), true);
check("and through OpenOptions rather than fs::write", /fs::OpenOptions::new\(\)/.test(writeStored), true);
check("and fs::write appears nowhere in it", /fs::write\(/.test(writeStored), false);
/*
 * And again on the open handle, which is what makes it exactly `0600` rather than
 * `0600 & !umask`: a umask carrying owner bits leaves `0400` at `0277` and nothing
 * readable at all at `0677`, and a key file this same user cannot read back on the
 * next launch is the regenerate-every-launch failure the file exists to prevent.
 */
check(
  "and narrowed again on the handle, against a umask with owner bits",
  /file\.set_permissions\(fs::Permissions::from_mode\(0o600\)\)/.test(writeStored),
  true,
);
/*
 * The mode on the **directory** is set on every write rather than only where
 * `create_dir_all` made one, because it left `0755` on every machine so far — the
 * same upgrade argument the rename below carries for the file.
 */
check(
  "and the directory is narrowed on every write",
  /fs::set_permissions\(dir, fs::Permissions::from_mode\(0o700\)\)/.test(writeStored),
  true,
);
/*
 * ⚠ **And it is a fresh inode, not the one that is already there.** A `server.json`
 * an earlier build created at `0644` keeps that mode for ever through any writer
 * that opens the existing file, so a fix that set a mode only at creation would
 * leave every installation in the field world-readable while passing every test
 * that starts from an empty directory. The rename is what narrows them.
 */
check("and the narrowed file replaces the old inode by rename", /fs::rename\(&tmp, &target\)/.test(writeStored), true);

/*
 * That the *device key* really goes through that writer, which is the link the two
 * halves hang on: a `write_device_key_fallback` that grew a writer of its own
 * would leave every assertion above green over a key file nothing narrows.
 */
const keyFallback = between(configRs, "pub fn write_device_key_fallback(", "pub fn erase_device_key_fallback(");
check("the fallback writer was found to read", keyFallback.length > 0, true);
check("a device key is written through that one writer", /write_stored\(dir, &stored\)/.test(keyFallback), true);
check("and never by a writer of its own", /fs::(write|OpenOptions|File)/.test(keyFallback), false);

/* ── what a `server.json` nobody can use is allowed to cost ──────────────── */

/**
 * ⚠ **Read with the comments taken out, and every pattern below is why.**
 * `config.rs` states each of these rules in prose directly above the code that
 * holds it — "`replaceable` is `false` and `write_stored` refuses", "the first one
 * wins" — so over the raw file a search for the *code* is satisfied by the
 * paragraph explaining it, and the cheapest route back to green is deleting the
 * explanation. `daemonSrc` below already strips for exactly this; `configRs`
 * above deliberately does not, because the assertions there are about names a
 * docblock cannot contain.
 *
 * **What this section is about.** `server.json` is the only copy of an X25519
 * device private key on a keyring-less host, so what `read_stored` decides about
 * a file it cannot use is a decision about that key. The census below is the six
 * arms that decide it — five states a stored file can be in that are not the
 * ordinary one, plus the ordinary one — and they do **not** answer one thing each:
 * three of them answer `true`, two answer `quarantine(dir)`, and one answers
 * `false`. So what a reader has to keep straight is the mapping rather than a
 * count, which is why the list is written out below and not tallied.
 *
 * ⚠ **This sentence read "there are four states and each answers a different
 * pair", 26 lines above a census that enumerates six arms sharing three answers.**
 * It was false on both halves, and it is the kind of false that costs something
 * here: the whole point of the census is that no number about these arms is
 * trustworthy unless it is differenced against the source.
 *
 * Three defects lived in the gaps between these arms: invalid UTF-8 classified as
 * a read failure, which is permanent and froze every configuration write on that
 * installation; a quarantine that preserved nothing and authorized the overwrite
 * anyway; and a superseded key retained in the quarantine for ever after a re-key.
 *
 * ⚠ **A census rather than a count, because a count cannot see a skipped arm.**
 * The list below is derived from the source in source order and compared for
 * equality against a hand-written one, so a new arm, a missing arm, a reordering
 * and a changed answer are each a different red line. `cargo test` covers the
 * *behaviour* — it is the `native` job and needs a toolchain; this is the `check`
 * job, which compiles no Rust, and the two can disagree indefinitely.
 */
const configCode = flat(
  read(`${TAURI_DIR}/src/config.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
const readStored = between(configCode, "fn read_stored(", "fn sync_dir(");
check("the reader behind every writer was found to read", readStored.length > 0, true);
const arms = [
  ...readStored.matchAll(
    /(ErrorKind::\w+|Err\(_\)|Ok\(parsed\)) => \((?:Stored::default\(\)|parsed), (true|false|quarantine\(dir\))\)/g,
  ),
].map(([, arm, answer]) => `${arm} => ${answer}`);
check("every state a stored file can be in, and what each one authorizes", arms, [
  // Nothing there: the whole truth, and a write proceeds.
  "ErrorKind::NotFound => true",
  // A directory at the path: nothing this app wrote is in it to lose, and POSIX
  // refuses `rename(file, directory)` so the one destructive statement cannot run.
  "ErrorKind::IsADirectory => true",
  // ⚠ Bytes that are not UTF-8. `read_to_string` does the decoding, so this is the
  // one read failure with **no errno** — evidence about the bytes rather than a
  // syscall saying no, and never transient. In the catch-all below it made the
  // file unreplaceable for ever: no quarantine, no replacement, and every
  // configuration write on that installation refused until somebody moved it by
  // hand — silently, on `host_device_set` and `host_device_clear`.
  "ErrorKind::InvalidData => quarantine(dir)",
  // Every read failure that *does* carry an errno: evidence of nothing about the
  // bytes, so they are neither moved nor replaced.
  "Err(_) => false",
  "Ok(parsed) => true",
  // Bytes that will not deserialize, and the answer is whatever the quarantine
  // managed rather than an unconditional `true`.
  "Err(_) => quarantine(dir)",
]);
/*
 * ⚠ **And the quarantine has to be able to say it preserved nothing.** It
 * answered `()`, so both of its failing paths — the slot already taken by an
 * earlier corruption, and a `rename` that did not land — left the caller marking
 * the file replaceable. After one recovery that is exactly backwards: the
 * retained copy holds what the *first* failure reduced the file to, and the bytes
 * being overwritten are the current key.
 */
check("the quarantine answers whether the bytes are actually aside", /fn quarantine\(dir: &Path\) -> bool/.test(configCode), true);
check("and its rename is read rather than discarded", /let _ = fs::rename\(/.test(configCode), false);
/*
 * And nothing calls it for its effect alone: a bare statement is an answer thrown
 * away, which is the shape that shipped. The lookbehind is what keeps
 * `discard_quarantine(dir);` — a different function, whose answer is genuinely
 * nothing — from satisfying this.
 */
check("and no caller drops that answer on the floor", /(?<!\w)quarantine\(dir\);/.test(configCode), false);
/*
 * ⚠ **The superseded key, and the two statements it takes to give one up.** A
 * quarantined `server.json` can hold a recoverable private key — a truncation past
 * the base64 leaves the key legible and the JSON unparseable — and nothing removed
 * it, so the Devices screen's **Re-key** gave up the keyring copy and the
 * `server.json` copy and left that one on disk for ever.
 *
 * ⚠ **The first fix put the removal on `erase_device_key_fallback`, and that is
 * the statement `device::store_secret` reaches too** — on every keyring-verified
 * first use, through `device::ensure_key`. A **promotion** to the keyring is not a
 * key given up; the docblock claiming *"`ensure_key`'s first-use path never comes
 * here"* was false the day it was written, and the path that survives its early
 * return is a `device_keys` entry `device::decode_key` rejects, where a quarantine
 * that may hold the legible copy was discarded over a key nobody gave up. So the
 * two acts are two functions, and this pair of assertions is which is which: the
 * promotion must reach no quarantine at all, and `give_up_device_key` — the one
 * `device::reset_key` calls — must reach it only after a write that landed.
 */
const eraseKey = between(configCode, "pub fn erase_device_key_fallback(", "pub fn give_up_device_key(");
check("the statement a promotion reaches was found to read", eraseKey.length > 0, true);
check("promoting a key to the keyring rewrites server.json and nothing else", /discard_quarantine/.test(eraseKey), false);
const giveUp = between(configCode, "pub fn give_up_device_key(", "pub fn normalize_origin(");
check("the statement a re-key reaches was found to read", giveUp.length > 0, true);
check(
  "giving up a file-held key drops the copy it supersedes, after the write that landed",
  /erase_device_key_fallback\(dir, origin\)\?; discard_quarantine\(dir, origin\); Ok\(\(\)\)/.test(giveUp),
  true,
);
/*
 * ⚠ **And never a file about some other server.** The removal was the **whole**
 * `server.json.unreadable` for one release, which is a sweep behind a per-origin
 * button: re-keying server A destroyed the last hand-recoverable copy of server
 * B's key. The argument for it — "a second server can only lose something already
 * superseded, because each origin is regenerated the first time it is used" —
 * fails on *the first time it is used*, which for a server nobody has opened since
 * the corruption has not happened. So the removal is guarded by a read of the
 * bytes, and the guard is asserted **in the same statement as the removal**: a
 * pattern matching `remove_file` alone would stay green with the guard deleted.
 */
check(
  "and the removal is guarded by what those bytes name, in the same statement",
  /fn discard_quarantine\(dir: &Path, origin: &str\) \{ if !quarantine_is_only_about\(dir, origin\) \{ return; \} let _ = fs::remove_file\(unreadable_file\(dir\)\); \}/.test(
    configCode,
  ),
  true,
);
/*
 * One definition and one caller, which is what keeps the split above from being
 * undone by a third statement growing its own removal.
 */
check(
  "and no other statement in the module reaches for it",
  configCode.replace(giveUp, "").split("discard_quarantine(").length - 1,
  1,
);
/*
 * The caller side, in the one file that has it. `device::reset_key` is the Devices
 * screen's Re-key and `device::store_secret` is the promotion; swapping which
 * function each reaches is the single edit that puts the defect back with every
 * assertion above still green.
 */
const deviceCode = flat(
  read(`${TAURI_DIR}/src/device.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
const resetKey = between(deviceCode, "pub fn reset_key(", "pub fn diffie_hellman(");
check("the re-key was found to read", resetKey.length > 0, true);
check("a re-key gives up the quarantined copy too", /config::give_up_device_key\(dir, origin\)/.test(resetKey), true);
const storeSecret = between(deviceCode, "fn store_secret(", "pub fn ensure_key(");
check("the promotion was found to read", storeSecret.length > 0, true);
check("and a promotion takes the other door", /config::erase_device_key_fallback\(dir, origin\)/.test(storeSecret), true);
check("and only that one", /give_up_device_key/.test(storeSecret), false);


/* ── what adopting a server gives up ─────────────────────────────────────── */

/**
 * ⚠ **Two rules at one call site, answering oppositely, and neither had ever been
 * asserted.** `host_set_server` erases the previous origin's *credential* — a
 * credential this app will not present is one it has no reason to hold, and doing
 * it in the same act is what makes "no credential is retained for a server you
 * are not using" true of the act rather than of an intention.
 *
 * It erases the previous origin's *device id* nowhere, and must not learn to:
 * the row on that server still exists, so forgetting the id leaves an
 * installation nobody can recognise in their own list and spends a second slot
 * against the account's limit on the way back. `cp-devices.md` is the argument.
 */
const setServer = flat(read(`${TAURI_DIR}/src/commands.rs`));
const setServerBody = between(setServer, "pub fn host_set_server", "pub fn host_credential_set");
check("the sweep can see host_set_server at all", setServerBody.length > 0, true);
check("adopting a server gives up the previous one's sign-in", /credential::erase\(&previous\)/.test(setServerBody), true);
check("and never the device recorded for it", /erase_device/.test(setServerBody), false);

/* ── what the host process assumes about the platform it is on ───────────── */

/**
 * **PATH is a list, joined by the platform's own separator.**
 *
 * ⚠ It was `parts.join(":")`, which is POSIX's — so on Windows the daemon's whole
 * `PATH` would have been one garbage entry and every agent CLI invisible. It also
 * closes a latent bug on the platforms that *do* use `:`, where a directory whose
 * own name contains one silently corrupted the list.
 *
 * Asserted here rather than left to `cargo test`, which cannot fail over a
 * separator it never sees: CI compiles this crate on Unix only, so the hand-rolled
 * join was correct in every environment that has ever run it.
 */
/*
 * Comments stripped: the docblocks beside each of these quote the very shape
 * being searched for — "never with a POSIX literal", "not Linuxbrew" — so the raw
 * file satisfies every search here whichever way round the code is, and the
 * cheapest route back to green would be deleting the explanation.
 */
const daemonSrc = flat(
  read(`${TAURI_DIR}/src/daemon.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
check("the daemon's PATH is joined with the platform's separator", /std::env::join_paths\(/.test(daemonSrc), true);
check("and never with a POSIX literal", /parts\.join\(":"\)/.test(daemonSrc), false);
check("and the user's own PATH is split the same way", /std::env::split_paths\(/.test(daemonSrc), true);
/*
 * Homebrew is named on exactly one fallback list, because it was measured on
 * exactly one platform. Linuxbrew on the Linux list would be a guess wearing a
 * measurement's clothes.
 */
check("Homebrew is named once, on the platform it was measured on", (daemonSrc.match(/\/opt\/homebrew\/bin/g) ?? []).length, 1);
check("and no fallback names Linuxbrew", /linuxbrew/i.test(daemonSrc), false);
/*
 * The login-shell probe is Unix by decision. It answered `None` on Windows by
 * luck — `SHELL` being unset — and that luck breaks under Git Bash and MSYS2,
 * which set it to a POSIX shell that knows nothing of the Windows `PATH`.
 */
check("the login-shell probe refuses where it cannot mean anything", /if !cfg!\(unix\) \{/.test(daemonSrc), true);
/*
 * No updater artifacts, and no updater. `docs/NATIVE.md` carries the steps, and
 * the one that has to happen *before* a first public build is generating the
 * keypair — a shipped build with no public key can never be updated in place by a
 * later one that has it.
 */
check("no updater artifacts are produced", bundle["createUpdaterArtifacts"], false);
check("and no updater is configured", Object.hasOwn((conf["plugins"] ?? {}) as object, "updater"), false);
/*
 * AGPL §6, not only §13: handing somebody a binary is a *distribution*, and the
 * offer that discharges it is the one served by the control plane's `SOURCE_URL`,
 * which says nothing about this artifact.
 */
check("the licence travels with the bundle", typeof bundle["licenseFile"], "string");
check(
  "and it is this repository's own",
  resolve(ROOT, TAURI_DIR, String(bundle["licenseFile"])),
  resolve(ROOT, "LICENSE"),
);
/*
 * The mobile blocks are declared and nothing is wired: `tauri ios init` has never
 * been run here and cannot be — it needs full Xcode and `rustup`, and this machine
 * has Command Line Tools and a Homebrew toolchain. Declared anyway so the
 * identifier and the OS floors are decided rather than defaulted on the day
 * somebody does run it.
 */
check("an iOS floor is decided rather than defaulted", typeof ((bundle["iOS"] ?? {}) as Record<string, unknown>)["minimumSystemVersion"], "string");
check("and an Android one", typeof ((bundle["android"] ?? {}) as Record<string, unknown>)["minSdkVersion"], "number");
check("no Apple development team is committed", ((bundle["iOS"] ?? {}) as Record<string, unknown>)["developmentTeam"], null);
/*
 * ⚠ **The two mobile platforms are in different states, and the pair is asserted
 * together so they cannot drift.**
 *
 * `keyring`'s `v1` feature has no store on either: `set_credential_store` returns
 * `Err(Invalid("platform", …))` at run time having compiled perfectly
 * (`keyring-4.2.0/src/v1.rs:109-128`). Every other thing a mobile build is
 * missing fails loudly at build or install time; this one passes every gate and
 * arrives at a person who then retypes their password on every launch.
 *
 * **Android has a real store now** — `keyring-core` with
 * `android-native-keyring-store`, SharedPreferences under a key held in the
 * Android Keystore — and it is compiled and linked here rather than argued about:
 * measured 2026-09-19, `cargo build --target aarch64-linux-android --lib`
 * produces `libreemoat_native_lib.so`.
 *
 * **iOS is still refused at compile time**, because nothing on this checkout can
 * compile it: that needs full Xcode and an `aarch64-apple-ios` target. The
 * refusal is a tripwire on the way to that arm, not a decision against one —
 * whoever installs the toolchain writes the `apple-native-keyring-store` arm and
 * deletes it in the same change.
 *
 * Asserted as a pair. Narrowing the refusal without writing the arm, or writing
 * an arm and leaving the refusal, are both states this catches.
 */
const credentialRs = read(`${TAURI_DIR}/src/credential.rs`);
/*
 * ⚠ **Read with the comments taken out, and this is the file in the tree where
 * that matters most.** `credential.rs` is one long argument about which store
 * each platform gets, and it makes that argument by quoting the code: the
 * docblock over the refusal names `apple-native-keyring-store` and
 * `android-native-keyring-store`, the `use` block quotes
 * `keyring-4.2.0/src/v1.rs:109-128`, and the refusal's own message names both
 * crates again. Both assertions below read the raw text, and the quiet direction
 * was open on each — wrap the refusal in a block comment, which is the shape a
 * tripwire dies in and exactly what somebody "just trying an iOS build" does, and
 * the raw pattern goes on saying `ok` over a build that would ship with no store
 * and keep no sign-in. Measured on this checkout: block-commented, the raw test
 * is still `true` and the stripped one is `false`.
 *
 * The control beside it is `bootCode`'s and `cargoCode`'s: a pattern over a
 * derived string passes for the wrong reason when the derivation returns
 * nothing.
 */
const credentialCode = rustCode(credentialRs);
check("the credential store's code survived the comment strip", credentialRs.length > credentialCode.length, true);
check(
  "iOS is refused at compile time, having no credential store yet",
  /#\[cfg\(target_os = "ios"\)\]\s*compile_error!/.test(credentialCode),
  true,
);
check(
  "and Android is not, because it has one",
  /#\[cfg\(target_os = "android"\)\]\s*fn entry/.test(credentialCode),
  true,
);
/*
 * And the store is named in the manifest rather than left to a default, which is
 * the rule the desktop `keyring` line already follows one platform over.
 */
const cargoCode = cargoToml
  .split("\n")
  .map((line) => line.replace(/#.*$/, ""))
  .join("\n");
/*
 * ⚠ **Compared against the code rather than the text, for `stageCode`'s reason
 * one file over.** Written against `cargoToml` raw, the assertion below is
 * satisfied by the prose above the dependency — measured: deleting
 * `android-native-keyring-store = "1"` outright left this driver all green. The
 * control is here because a pure test over a derived string passes when the
 * derivation returns nothing.
 */
check("the manifest's code survived the comment strip", cargoToml.length > cargoCode.length, true);
check(
  "the Android store is named in the manifest, and keyring is kept off that target",
  [
    /^android-native-keyring-store = /m.test(cargoCode),
    /\[target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies\]/.test(cargoToml),
  ],
  [true, true],
);
/*
 * ⚠ **And no `openssl`, which is a plan a measurement took back out.** The
 * intent was `openssl` with `vendored`, on the reasoning that `reqwest`'s
 * `default-tls` is native-tls and native-tls is OpenSSL away from Apple and
 * Windows. `cargo tree --target aarch64-linux-android` has no `openssl-sys` in
 * it at all: `reqwest` 0.13 resolves to `rustls` with `rustls-platform-verifier`,
 * which calls Android's own trust manager over JNI — so the `/v1` leg honours the
 * same `network_security_config` the webview legs do rather than being blind to
 * user-installed CAs. Asserted as an absence so the dependency cannot come back
 * without somebody re-reading why it went.
 */
/*
 * Compared against the manifest's *code*, for the reason this file already gives
 * at the staging shim: the paragraph above this line explains why there is no
 * `openssl` here and would satisfy the pattern on its own. TOML comments are `#`
 * to end of line, and no dependency line in this file carries one.
 */
check("and no vendored OpenSSL, which the Android tree does not use", /openssl/.test(cargoCode), false);
/*
 * ⚠ **And the companion positive, because the line above is a pure negative over
 * a *derived* string.** `/openssl/.test(cargoCode)` answers `false` for the
 * reason the assertion is about and also for two it is not: a strip that returned
 * the empty string, and one that ate the dependency tables. Both pass it exactly
 * as loudly. The control two checks up says only that *something* was removed —
 * one `#` anywhere in the file satisfies it — so it cannot tell those apart
 * either.
 *
 * So both halves of the discrimination are stated. The word **is** in the file,
 * in the paragraph explaining why it is not a dependency, which is what proves
 * the pattern still matches something at all; and the three tables an
 * `openssl = …` would have to appear in survived the strip, which is what proves
 * the negative is being taken over the place it is about.
 *
 * ⚠ A red on the first half means the explanation went, and that is worth a red:
 * this absence is a measurement — `cargo tree --target aarch64-linux-android`
 * carries no `openssl-sys` — and an absence whose reason has been deleted is the
 * next person's dependency.
 */
report(
  "and that negative is taken over a string the dependency tables survived",
  /openssl/.test(cargoToml) &&
    /^\[dependencies\]$/m.test(cargoCode) &&
    /^\[target\.'cfg\(target_os = "android"\)'\.dependencies\]$/m.test(cargoCode) &&
    /^reqwest = \{/m.test(cargoCode),
  `${cargoToml.length - cargoCode.length} characters of comment removed, ${
    cargoCode.split("\n").filter((line) => /^[a-z][\w-]* = /.test(line)).length
  } key lines left`,
);

/* ------------------------------------------------------------------ *
 * Android: one symbol, one manifest, and the three halves of TLS
 *
 * ⚠ **Nothing on this checkout can compile Android, and for as long as that was
 * true nothing read it either.** Homebrew's cargo, no `rustup`, no NDK — so
 * `cargo build --target aarch64-linux-android` is not available here, and
 * `.github/workflows/check.yml`'s `native-android` job is where that arm is
 * compiled at all. But a compiler is a compiler: it cannot see a JNI symbol that
 * no longer matches the Kotlin looking it up, an `android:allowBackup` flipped
 * back to the template's default, or a class R8 deleted on the way into the APK.
 * Every one of those compiles, links, signs and installs.
 *
 * ⚠ And **`gen/android` is generated**, which is what makes all of it one class
 * of failure rather than three. `tauri android init` writes that project from its
 * own templates and would overwrite every file this section reads;
 * `native-packaging.md` records it shipping Tauri's icons three builds running
 * for exactly that reason, and the directory is committed so that it *can* be
 * edited. Nothing else in this repository would notice the edits going away.
 *
 * So this section is the half of the Android story that is text, and its subject
 * is the one the whole file has: **a rule written down in more than one place,
 * with nothing comparing the copies.**
 * ------------------------------------------------------------------ */

process.stdout.write("\nAndroid: the symbol, the manifest, and what R8 is told to keep\n");

const ANDROID_DIR = `${TAURI_DIR}/gen/android`;
const gradleKts = read(`${ANDROID_DIR}/app/build.gradle.kts`);
const gradleCode = kotlinCode(gradleKts);
const proguard = read(`${ANDROID_DIR}/app/proguard-rules.pro`);
const proguardCode = proguard
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");
const cargoLock = read(`${TAURI_DIR}/Cargo.lock`);
/*
 * The strips this section rests on, each with the control `bootCode` wrote down
 * first: a pattern over a derived string passes when the derivation returns
 * nothing, and every assertion below is such a pattern.
 *
 * `proguard-rules.pro` is *mostly* comment — the keep rule carries ten lines of
 * measurement above it and the template's own commented-out examples above that
 * — so a strip that took the rule with them would leave the TLS line below green
 * over an APK with nothing kept in it. Hence the second half: something was
 * removed **and** something is left.
 */
check("the Gradle script's code survived the comment strip", gradleKts.length > gradleCode.length, true);
check(
  "and the keep file's did, without taking the rule with it",
  proguard.length > proguardCode.length && proguardCode.trim().length > 0,
  true,
);

/* ── the one symbol, derived from the Kotlin and differenced against the Rust ── */

/**
 * ⚠ **One identifier is written down in five files and nothing compared them.**
 *
 * `MainActivity.kt` declares `external fun initNdkContext`; the JVM turns that
 * into the symbol it looks for in the loaded library by JNI's own mangling rule —
 * `Java_`, then the package with every `.` as `_`, then the class, then the
 * method — and `credential.rs` exports that string **as a literal function
 * name**. Between them sit three more copies of the package: `namespace` and
 * `applicationId` in `build.gradle.kts`, and `identifier` in `tauri.conf.json`,
 * which is the one nobody thinks of as an Android file and is what a re-run of
 * `tauri android init` **derives the Kotlin package from**.
 *
 * ⚠ **What a mismatch costs, and why no compiler sees it.** Rust exports whatever
 * name it is given, and the JVM resolves an `external fun` lazily, at the first
 * call. So a renamed method, a renamed class, or a package Tauri regenerated from
 * a changed `identifier` all produce a clean
 * `cargo clippy --target aarch64-linux-android`, a clean Gradle build, a signed
 * APK — and an `UnsatisfiedLinkError` thrown out of `onCreate` on first launch.
 * `credential.rs` records what the *absence* of that one call already cost: the
 * first Android build panicked inside `setup` before drawing a pixel.
 *
 * ⚠ **A derivation, not a count and not a floor.** The expected symbol is built
 * from the Kotlin side and the two sets are compared for equality, so a Kotlin
 * `external fun` with no Rust export, a Rust export with no Kotlin declaration, a
 * renamed package and a second symbol added to one side alone are each a
 * different red line. A count would survive a *swap*, and a floor cannot see a
 * skipped item — which is the lesson `readStored`'s census three sections up is
 * already written out of.
 *
 * Both sides are read comment-stripped, because each quotes the other: the
 * docblock above the Rust export explains the JNI plumbing, and `MainActivity.kt`
 * names the Rust symbol in full — *"`credential.rs`'s
 * `Java_com_reemoat_app_MainActivity_initNdkContext`"* — so over raw text one
 * side's prose satisfies the other side's pattern with no code between them.
 */
const KOTLIN_MAIN = `${ANDROID_DIR}/app/src/main/java/com/reemoat/app/MainActivity.kt`;
const activityRaw = read(KOTLIN_MAIN);
const activity = kotlinCode(activityRaw);
check("the activity's code survived the comment strip", activityRaw.length > activity.length, true);

const kotlinPackage = capture(activity, /^package ([A-Za-z_][\w.]*)\s*$/m);
const kotlinClass = capture(activity, /^class (\w+)\s*:/m);
check("the activity names a package", kotlinPackage !== null, true);
check("and a class", kotlinClass !== null, true);
/*
 * ⚠ **And the file sits where its own package says it does.** Kotlin compiles a
 * source file whose directory disagrees with its `package` declaration without a
 * word, but `tauri android init` writes — and overwrites — *by directory*. So a
 * package changed without moving the file leaves the next init generating a
 * second `MainActivity` beside this one, with Tauri's body in it and no
 * `initNdkContext` at all, while this one goes on compiling. Derived rather than
 * restated, so the literal path read above is differenced against the only thing
 * that decides it.
 */
check(
  "and the file sits in the directory that package names",
  KOTLIN_MAIN,
  `${ANDROID_DIR}/app/src/main/java/${(kotlinPackage ?? "").split(".").join("/")}/${kotlinClass}.kt`,
);

/**
 * The symbol the JVM will look for, by JNI's own mangling rule.
 *
 * `Java_`, then the package segments, the class and the method joined by `_`,
 * with every `_` *inside* a name doubled to `_1` — the escape that stops `a_b.C`
 * and `a.b_C` naming one symbol. A `$` would become `_00024` and a non-ASCII
 * character `_0xxxx`; neither can occur here, because every name reaching this is
 * captured with `\w`, which admits neither. An overloaded native method takes a
 * `__` suffix and an encoded signature — none of these is overloaded, and one
 * that became so needs this function told rather than left to answer a string
 * that is confidently wrong.
 */
const jniSymbol = (pkg: string, cls: string, method: string): string =>
  `Java_${[...pkg.split("."), cls, method].map((part) => part.replace(/_/g, "_1")).join("_")}`;

const declaredExternals = [
  ...activity.matchAll(/^\s*(?:private |internal |public |protected )?external fun (\w+)\(/gm),
]
  .map((m) => m[1])
  .filter((name): name is string => name !== undefined)
  .sort();
const wantedSymbols = declaredExternals
  .map((name) => jniSymbol(kotlinPackage ?? "", kotlinClass ?? "", name))
  .sort();
report(
  "the activity declares native methods at all",
  declaredExternals.length > 0,
  `${declaredExternals.length}: ${declaredExternals.join(", ")}`,
);
/*
 * ⚠ **And the imports those signatures need, which was the one edit in that
 * file's banner with nothing behind it.** `external fun initNdkContext(context:
 * Context)` does not compile without `import android.content.Context`, and the
 * template has no use for it — so an `init` re-run, or a tidy-up of an import
 * the rest of the file never mentions, lands as a Kotlin error in the APK leg
 * rather than here, where nothing compiles Kotlin at all. Derived from the
 * signatures rather than written down as a literal, so a sixth native method
 * naming another platform type is held to the same rule. The types found are
 * pinned beside the absence: an empty list is the passing answer for the
 * difference, so the regex silently matching nothing would read as `ok`.
 */
const signatureTypes = [
  ...activity.matchAll(/^\s*(?:private |internal |public |protected )?external fun \w+\(([^)]*)\)/gm),
].flatMap((m) => [...(m[1] ?? "").matchAll(/:\s*([A-Z]\w*)/g)].map((found) => found[1] ?? ""));
check(
  "and every platform type they name is imported, Context among them",
  [
    [...new Set(signatureTypes)],
    [...new Set(signatureTypes)].filter((type) => !new RegExp(`^import [\\w.]+\\.${type}$`, "m").test(activity)),
  ],
  [["Context"], []],
);

/**
 * Every `Java_` export this crate carries, swept over the whole of `src/`.
 *
 * ⚠ **Written tolerant of the attribute list, which is the mistake this file has
 * already made once.** `#[tauri::command]` as a bare literal dropped every
 * command declared `#[tauri::command(async)]` — silently, in the direction that
 * reads as passing — and the shape is here twice over: the export carries
 * `#[cfg(target_os = "android")]` **and** `#[unsafe(no_mangle)]`, one of which is
 * an attribute with an argument list inside an attribute with an argument list.
 * So the run is `(?:#\[[^\]]*\]\s*)*` and every modifier before `extern` is
 * optional.
 *
 * ⚠ **`"system"` or `"C"`, because both are JNI-callable and swapping them is not
 * a compile error.** A census naming one would drop an export the day somebody
 * tidied the ABI string, and a dropped item is precisely what a count cannot
 * detect.
 *
 * Swept over every `.rs` rather than `credential.rs` alone, for the reason the
 * stray-command sweep gives one section up: an export in another file is a door
 * this census would simply not see.
 */
const JNI_EXPORT = /((?:#\[[^\]]*\]\s*)*)(?:pub\s+)?(?:unsafe\s+)?extern\s+"(?:system|C)"\s+fn\s+(Java_\w+)/g;
const exportedSymbols: string[] = [];
const looseSymbols: string[] = [];
const unexported: string[] = [];
for (const file of readdirSync(join(ROOT, TAURI_DIR, "src"))) {
  if (!file.endsWith(".rs")) continue;
  const code = rustCode(read(`${TAURI_DIR}/src/${file}`));
  for (const match of code.matchAll(JNI_EXPORT)) {
    const attrs = match[1] ?? "";
    const name = match[2] ?? "";
    exportedSymbols.push(name);
    if (!/#\[(?:unsafe\()?no_mangle\)?\]/.test(attrs) || !/#\[cfg\(target_os = "android"\)\]/.test(attrs)) {
      unexported.push(`${file}: ${name}`);
    }
  }
  for (const match of code.matchAll(/\bfn\s+(Java_\w+)/g)) looseSymbols.push(match[1] ?? "");
}
check(
  "every native method the activity declares is exported by the Rust, and nothing else is",
  exportedSymbols.sort(),
  wantedSymbols,
);
/*
 * ⚠ **And the loose sweep, which is what catches an export that stopped being
 * one.** `fn Java_…` with the `extern` taken off is a perfectly ordinary Rust
 * function; the pattern above stops seeing it, the equality above reports it as
 * *missing*, and a reader would conclude the Kotlin was wrong. Counted separately
 * so the two failures read differently: the same names both ways means the shape
 * is intact and only the set is in question.
 */
check("and no Java_ function in this crate is one the census could not see", looseSymbols.sort(), exportedSymbols);
/*
 * ⚠ **And the two attributes without which an export is not one.** `no_mangle` is
 * what makes the symbol the function's own name — without it the linker writes
 * `_ZN…` and the JVM finds nothing at the first call — and
 * `#[cfg(target_os = "android")]` is what keeps a JNI entry point out of the
 * desktop build, where `jni` is not a dependency at all. Checked per export
 * rather than over the file, because a file with two exports and one attribute
 * between them is exactly what a file-wide pattern cannot see.
 */
check("and each of them is unmangled and Android-only", unexported, []);

/*
 * ⚠ **And the library the activity loads is the one cargo builds.** Android's
 * `System.loadLibrary("x")` resolves `libx.so` out of the APK's `jniLibs`, and
 * the name in there is `[lib] name` from `Cargo.toml` — a fourth copy of a string
 * nothing compared. Renaming the crate's lib without the `loadLibrary` call is
 * the same `UnsatisfiedLinkError`, from the same `onCreate`, on a build that
 * compiled and signed.
 *
 * `cdylib` with it, because that is the crate type producing the `.so` at all: a
 * `[lib]` that lost it still builds `staticlib` and `rlib`, cargo says nothing,
 * Gradle packages no shared object, and the failure is the same error from a
 * directory that is simply empty.
 */
const loadedLibrary = capture(activity, /System\.loadLibrary\("(\w+)"\)/);
check("the activity loads a library by name", loadedLibrary !== null, true);
check("and it is the one this crate's [lib] produces", capture(cargoCode, /^\[lib\]\s*\nname = "(\w+)"/m), loadedLibrary);
check(
  "which is built as a shared object Android can load",
  (capture(cargoCode, /crate-type = \[([^\]]*)\]/) ?? "").includes(`"cdylib"`),
  true,
);

/*
 * ⚠ **And Back, which closed the app on the first press.**
 *
 * `WryActivity` — in the gitignored `generated/` tree — registers an
 * `OnBackPressedCallback` that calls `goBack()` while the webview `canGoBack()`
 * and otherwise finishes the activity, but only when `handleBackNavigation` is
 * true. `TauriActivity` overrides it to `false`, so nothing is registered and
 * the platform default runs: `finish()`. This app is a pathname router whose
 * five pop-up routes are real history entries (`router.ts`'s `navigate` is
 * `pushState`), so one press was leaving the *app* where it should have been
 * leaving a panel.
 *
 * ⚠ **Nothing offline could see it and nothing offline can derive it.** This
 * driver runs no cargo and compiles no Kotlin; `cargo clippy` compiles Rust; the
 * APK leg reads `classes.dex` for one class name. And the property's two other
 * copies are both in the `generated` package under `app/src/main`, which
 * `gen/android/app/.gitignore` ignores by a glob this paragraph deliberately
 * does not spell — a double star followed by a slash closes a block comment, and
 * `kotlinCode`'s own docblock is where that is already written down. A
 * `check`-job checkout does not carry those two files, so this is the one edit
 * in this file with no second copy to difference against. What catches a wry
 * release that renamed the property is the Kotlin compiler in the APK leg: an
 * `override` of nothing does not build.
 *
 * ⚠ **The count is the half that makes the comment strip load-bearing.** That
 * file's banner and the paragraph above the override both name the property in
 * prose — four occurrences raw, one in code — so a pattern over the raw text
 * would pass over a file where the override had been deleted and only the
 * explanation left. The count also refuses a second copy: an
 * `onBackPressedDispatcher.addCallback` added here would stack ahead of wry's
 * and the two would disagree about who finishes the activity.
 */
check(
  "the activity takes back navigation back from Tauri's override",
  /override val handleBackNavigation: Boolean = true/.test(activity),
  true,
);
check("and the property is written down exactly once, in code", (activity.match(/handleBackNavigation/g) ?? []).length, 1);
/*
 * ⚠ **And the package, in the three other places it is written down.**
 * `namespace` is what Gradle compiles the Kotlin under, `applicationId` is what
 * the APK installs as, and `identifier` is neither — it is the seed
 * `tauri android init` derives the Kotlin package from, so changing it and
 * re-running init regenerates `MainActivity.kt` under a new package while
 * `credential.rs`'s literal symbol stays exactly where it was.
 *
 * Compared as one set rather than as three pairs, so a failure names every copy
 * that disagrees instead of the first one it reaches.
 */
check(
  "the identifier, both Gradle names and the Kotlin package are one string",
  [
    conf["identifier"],
    capture(gradleCode, /^\s*namespace = "([\w.]+)"\s*$/m),
    capture(gradleCode, /^\s*applicationId = "([\w.]+)"\s*$/m),
  ],
  [kotlinPackage, kotlinPackage, kotlinPackage],
);

/* ── the manifest, and the two channels a device key must not leave by ────── */

/**
 * ⚠ **The device's X25519 private key can sit in a file, and Android ships two
 * mechanisms whose whole job is to copy that file off the phone.**
 *
 * `config.rs`'s `read_device_key_fallback` exists because a keyring write can be
 * accepted and lost; where it is taken, `server.json` in the app-private
 * directory holds the chosen control plane, the device id and the device private
 * key itself — which is why `write_stored` goes to the length of an `0600` set at
 * `open` time and a rename onto a fresh inode. **Auto Backup** uploads that
 * directory to the person's Google Drive and **`adb backup`** pulls it to a
 * laptop, and both are on by default. Everything `e2ee.md` claims about what a
 * capability stolen off the wire is worth rests on that key not being anywhere
 * else.
 *
 * ⚠ **Three attributes, because the platform changed the answer twice.**
 * `allowBackup="false"` is the whole of it up to API 30; `fullBackupContent` is
 * the API-23-to-30 spelling of the same refusal; and from API 31 up it is the
 * `dataExtractionRules` file that decides. A phone in the field is on exactly one
 * of those levels and nobody chooses which, so all three are asserted rather than
 * the newest.
 */
const manifestXml = read(`${ANDROID_DIR}/app/src/main/AndroidManifest.xml`);
const manifest = xmlCode(manifestXml);
check("the manifest's markup survived the comment strip", manifestXml.length > manifest.length, true);
const application = /<application\b[\s\S]*?>/.exec(manifest)?.[0] ?? "";
check("the application element was found to read", application.length > 0, true);
check(
  "nothing this app stores may leave by either backup channel",
  [
    /android:allowBackup="false"/.test(application),
    /android:fullBackupContent="false"/.test(application),
    /android:dataExtractionRules="@xml\/\w+"/.test(application),
  ],
  [true, true, true],
);
/*
 * ⚠ **The attribute names a resource, and the resource is where the refusal
 * actually lives.** `dataExtractionRules` pointing at a file that is not there is
 * a build failure; pointing at one that excludes nothing is not. So the attribute
 * alone asserts that somebody typed an opt-out, never that they wrote one.
 * Resolved by the name the manifest gives rather than by a literal path, so
 * renaming the resource cannot leave this reading a file nothing refers to.
 */
const rulesName = capture(application, /android:dataExtractionRules="@xml\/(\w+)"/) ?? "";
const rulesPath = `${ANDROID_DIR}/app/src/main/res/xml/${rulesName}.xml`;
check("the rules the manifest names are a file that is there", existsSync(join(ROOT, rulesPath)), true);
const rulesXml = existsSync(join(ROOT, rulesPath)) ? read(rulesPath) : "";
const rules = xmlCode(rulesXml);
check("the rules' markup survived the comment strip", rulesXml.length > rules.length, true);
/*
 * ⚠ **Both channels, each read out of its own element rather than out of the
 * file.** Cloud backup and device transfer are two separate opt-outs and a file
 * excluding only one is silent on the other — so a single `domain="root"`
 * anywhere in the file is the assertion that cannot fail. Measured: delete the
 * `device-transfer` exclusion and a file-wide search still answers `true`.
 * `between` answers the empty string unless both anchors are present and in
 * order, which is what makes the deleted-element case a red rather than a
 * borrowed `ok`.
 */
for (const channel of ["cloud-backup", "device-transfer"] as const) {
  const section = between(rules, `<${channel}>`, `</${channel}>`);
  check(`${channel} was found to read`, section.length > 0, true);
  check(`and ${channel} excludes the whole app-private tree`, /<exclude\s+domain="root"\s*\/>/.test(section), true);
}
/*
 * ⚠ **And the one component that publishes a door into that same directory.**
 * `androidx.core.content.FileProvider` is what hands another app a `content:` URI
 * for a file this one holds, and `file_paths.xml` scopes it to `.` — the whole
 * external and cache trees. `exported="false"` is what keeps that door usable
 * only through a URI this app granted; exported, any app on the phone could ask
 * the provider directly. Tauri's template ships it `false` and nothing here would
 * notice it becoming `true`.
 *
 * Asserted **inside the element**, with the count beside it, because the
 * file-wide form is green in both wrong directions at once: the activity above is
 * legitimately `exported="true"`, and a second, exported provider added below
 * would be covered by this one's `false`.
 */
const provider = /<provider\b[\s\S]*?>/.exec(manifest)?.[0] ?? "";
check("there is exactly one provider to check", (manifest.match(/<provider\b/g) ?? []).length, 1);
check(
  "and the file provider is unexported in the element that names it",
  [/android:name="androidx\.core\.content\.FileProvider"/.test(provider), /android:exported="false"/.test(provider)],
  [true, true],
);
/*
 * ⚠ **And the build type a release is actually built with, read as its own
 * block.** `isMinifyEnabled = true` is the precondition that makes the keep rule
 * below load-bearing rather than decoration. `isDebuggable` is what would make
 * the shipped process attachable with `run-as` and `jdb` — on a phone that means
 * the device key and everything the app can reach, which is the same thing
 * `get-task-allow` is asserted absent for one platform over.
 *
 * Read out of `getByName("release")` rather than out of the file, because the
 * debug block three lines above legitimately sets `isDebuggable = true` and
 * `isJniDebuggable = true`. A file-wide search for either is green whichever
 * block it is in.
 */
const releaseBuild = between(gradleCode, `getByName("release") {`, "kotlinOptions {");
check("the release build type was found to read", releaseBuild.length > 0, true);
check(
  "a release minifies and is not debuggable",
  [/isMinifyEnabled = true/.test(releaseBuild), /isDebuggable/.test(releaseBuild), /isJniDebuggable/.test(releaseBuild)],
  [true, false, false],
);
/*
 * ⚠ **And what a release is signed with — which that file's banner said was
 * asserted here, and was not.** `build.gradle.kts` lists the edits an `init`
 * re-run takes out and says this driver pins each against its code; measured
 * when the fourth was added, a grep for `signingConfig` in this file returned
 * nothing. So the edit deciding whether a release is signed at all rested on the
 * banner alone, which is the shape `ic_launcher` had before this driver read it.
 *
 * ⚠ **The fourth is `enableV1Signing = true`, and losing it has no symptom short
 * of somebody's phone.** Left unset, AGP signs with the JAR scheme only below
 * `minSdk` 24, so the 0.10.1 APK carried v2 alone. It verified, installed on a
 * Pixel, and installed over `adb install` on a OnePlus 13 — whose own installer
 * then refused the same file as invalid. That an OEM installer, parsing the APK
 * before the platform does, wants a JAR signature is the leading hypothesis
 * rather than a measurement; whichever it is, an APK without the pair still
 * builds, signs and verifies. `enableV2Signing` is pinned beside it because the
 * pair is the decision, and AGP's default is not one.
 *
 * Read out of `create("release")` rather than out of the file, so the pair
 * written into some other signing config — a debug one added later — cannot
 * stand in for this one. And the build type's `signingConfig` line is asserted
 * in the same breath because it is what makes the pair load-bearing rather than
 * decoration — `isMinifyEnabled` is the same precondition for the keep rule —
 * and without it a release is not signed at all: AGP writes
 * `app-universal-release-unsigned.apk`, which `ci-release.sh` refuses on the
 * release path rather than on a push.
 */
const releaseSigning = between(gradleCode, `create("release") {`, "buildTypes {");
check("the release signing config was found to read", releaseSigning.length > 0, true);
check(
  "a release is signed by that config, and the config signs v1 beside v2",
  [
    /signingConfig = signingConfigs\.getByName\("release"\)/.test(releaseBuild),
    /^\s*enableV1Signing = true\s*$/m.test(releaseSigning),
    /^\s*enableV2Signing = true\s*$/m.test(releaseSigning),
  ],
  [true, true, true],
);

/* ── Android TLS: three halves of one fact ────────────────────────────────── */

/**
 * ⚠ **"Android TLS works" is three edits in three languages, and each one alone
 * is silent.**
 *
 * `reqwest` 0.13 on this target resolves to rustls with `rustls-platform-verifier`
 * — measured, `cargo tree --target aarch64-linux-android` carries no
 * `openssl-sys` at all — and that crate is the only reason the `/v1` leg honours
 * the same `network_security_config` the webview legs do, user-installed CAs
 * included. What it asks for in return is three things:
 *
 *   1. **The Rust initialises it, from the JNI entry point.** `src/android.rs` in
 *      `rustls-platform-verifier` 0.7.0 opens *"On Android, initialization must be
 *      done before any verification is attempted"*, and its `global()` is an
 *      `.expect("Expect rustls-platform-verifier to be initialized")` — a
 *      **panic**, on the first HTTPS request, out of a build that compiled clean.
 *      Measured 2026-09-19: no init call existed anywhere in this tree.
 *   2. **The Kotlin half is in the APK.** The verifier calls
 *      `org.rustls.platformverifier.CertificateVerifier` over JNI; that class
 *      ships as an `.aar` inside the `rustls-platform-verifier-android` crate, so
 *      `build.gradle.kts` adds the crate's own directory as a Maven repository
 *      and depends on it.
 *   3. **R8 is told to keep it.** Measured 2026-09-19 on the signed release APK
 *      this checkout had already built: with the dependency present and no keep
 *      rule, `outputs/mapping/universalRelease/usage.txt` listed all five
 *      `org.rustls.platformverifier` classes as removed, `classes.dex` carried
 *      none of them, and `libreemoat_native_lib.so` still carried the class name
 *      it was about to `FindClass`. Debug builds were green throughout, because
 *      `isMinifyEnabled` is false there — so it fails only in a build somebody
 *      ships.
 *
 * ⚠ **Asserted as one line, deliberately.** The state a review actually found was
 * 2 and 3 present and 1 absent: an `.aar` and a keep rule protecting a class
 * nothing would ever call, with every gate green. Three separate `ok` lines would
 * have read as two-thirds working; one line reads as the fact it is.
 *
 * ⚠ **And the init is asserted *inside the JNI entry point*, by extraction.** It
 * has to run before anything makes an HTTPS request and it needs a `JNIEnv`,
 * which is exactly what `MainActivity.onCreate` already calls into before
 * `super.onCreate` — the same call the Android context depends on. A pattern over
 * the whole file would pass on an init sitting in a function nothing reaches.
 */
const jniBodies = [...credentialCode.matchAll(/extern\s+"(?:system|C)"\s+fn\s+Java_\w+\([\s\S]*?\n\}/g)].map(
  (match) => match[0],
);
check("the JNI entry point was found to read, and there is one of it", jniBodies.length, 1);
const jniEntry = jniBodies[0] ?? "";
check(
  "Android TLS is one fact: initialised in the JNI entry, in the APK, and kept from R8",
  [
    /rustls_platform_verifier::android::init_\w+\(/.test(jniEntry),
    /implementation\("rustls:rustls-platform-verifier/.test(gradleCode),
    /-keep[^\n]*org\.rustls\.platformverifier/.test(proguardCode),
  ],
  [true, true, true],
);
/*
 * ⚠ **And exactly one copy of the crate in the tree, which is how this pair is
 * most likely to break next.** The init call needs `rustls-platform-verifier`
 * named in `Cargo.toml`; `reqwest` already depends on it transitively. Name a
 * semver-incompatible version and cargo resolves **two**, happily and without a
 * warning — the app then initialises the global of the copy it can see while
 * reqwest's rustls reads the other one's, which is still unset. The symptom is
 * the `.expect` panic the init was added to prevent, out of a build where the
 * init is plainly there.
 *
 * Read off `Cargo.lock`, because the lock is what was actually resolved and the
 * manifest is only what was asked for.
 */
for (const crate of ["rustls-platform-verifier", "rustls-platform-verifier-android"] as const) {
  check(
    `the tree resolves exactly one ${crate}`,
    (cargoLock.match(new RegExp(`^name = "${crate}"$`, "gm")) ?? []).length,
    1,
  );
}
/*
 * ⚠ **And the API level the NDK is asked for is the one Gradle declares.**
 * `minSdk` is part of the clang triple the `native-android` job builds with, and
 * that job's own comment says so in as many words — *"a floor raised there has to
 * be raised here too"* — while nothing compared them. Raise `minSdk` and CI goes
 * on compiling against the older API, which is the direction with no symptom: it
 * links, and the symbols the newer floor promised are the ones it did not use.
 * Lower it and CI compiles against an API the installed app may not have, which
 * fails at `dlopen` on a real phone and nowhere else.
 *
 * Swept as a set rather than matched once, because the triple is written four
 * times in that job — a probe, a message and two exports — and one of them moving
 * alone is the same drift one level down.
 */
const ndkApiLevels = [
  ...new Set(
    [...checkWorkflowCode.matchAll(/aarch64-linux-android(\d+)-clang/g)]
      .map((match) => match[1])
      .filter((level): level is string => level !== undefined),
  ),
];
report(
  "the workflow had comments to take out before the triple was counted",
  checkWorkflowCode.length < checkWorkflow.length,
  `${String(checkWorkflow.length - checkWorkflowCode.length)} chars of prose`,
);
/*
 * The controls, without which the count below is a fact about the corpus rather
 * than about the stripper. Both directions, and both through `yamlCode` itself:
 * a comment naming a triple must contribute nothing, and a real key carrying a
 * trailing comment must still contribute its triple.
 */
check(
  "a comment naming a triple is not counted as one",
  [...yamlCode("      # aarch64-linux-android21-clang\n").matchAll(/aarch64-linux-android(\d+)-clang/g)].length,
  0,
);
check(
  "while a real one survives its own trailing comment",
  [...yamlCode("      clang: aarch64-linux-android24-clang  # the pinned triple\n").matchAll(/aarch64-linux-android(\d+)-clang/g)].map(
    (m) => m[1],
  ),
  ["24"],
);
check("the Android CI leg names exactly one API level", ndkApiLevels.length, 1);
check("and it is the minSdk Gradle declares", ndkApiLevels[0], capture(gradleCode, /^\s*minSdk = (\d+)\s*$/m));

/*
 * ── what the env file already on a computer is allowed to say ──────────────
 *
 * ⚠ **Three answers, written down twice, and a fourth added to one side alone is
 * silent.** `daemon.rs` decides whether `~/.reemoat/daemon.env` names this server,
 * another one, or nothing; `store.ts` branches on the answer to decide between
 * adopting a daemon, refreshing its enrollment code, and buying a machine. A value
 * the page has never heard of falls through every arm and does *nothing* — which
 * is precisely the failure this pair of constants was introduced to end, so
 * leaving it to be caught by reading would be the same bug one level up.
 *
 * Compared as sets off disk, the way `OPENABLE` and the scheme allowlist already
 * are — this file's own precedent for one rule with copies on both sides of the
 * bridge.
 */
/*
 * ── the Android repairs, and the shape of each one's failure ───────────────
 *
 * ⚠ **Everything below is about code no gate in this repository compiled until
 * `native-android` existed, and two of these were live defects at once.** The
 * arm is `#[cfg(target_os = "android")]`, so `cargo clippy --all-targets` on the
 * macOS runner never sees it: `--all-targets` is every *crate* target — lib,
 * bin, tests, examples — on the host, never another platform. What that gap held
 * was a TLS stack that was never initialised and a Kotlin class R8 deleted out of
 * the signed APK. Both compiled clean, and a regex is all that can watch them
 * from here.
 */
check(
  "nothing in the JNI entry point can end the process, and a null is refused before either half",
  [
    (jniEntry.match(/catch_unwind/g) ?? []).length,
    /raw_env\.is_null\(\) \|\| raw_context\.is_null\(\)/.test(jniEntry),
  ],
  [2, true],
);
/*
 * ⚠ **Two guards rather than one, and the count is the assertion.** A panic out
 * of `extern "system"` aborts, and there is a reachable one on each side:
 * `ndk_context::initialize_android_context` ends `assert!(previous.is_none())`
 * and `android-native-keyring-store` exports a second initialiser from this same
 * `.so`. Folded into one guard, that abort would also stop the TLS init — and the
 * store has a documented degraded mode where TLS has none. The window stops at
 * `fn adopt_context`, so a guard *moved* into the helper still leaves this at 1.
 */
check(
  "and the two halves are guarded independently rather than together",
  (between(credentialCode, "fn Java_com_reemoat_app_MainActivity_initNdkContext(", "fn adopt_context").match(
    /catch_unwind/g,
  ) ?? []).length,
  2,
);
/*
 * ⚠ **The store caches its success and retries its failure, and the asymmetry is
 * the point.** It used to hold the whole `Result`, so one `probe()` that ran
 * before the context was adopted told somebody their sign-in would not be kept
 * for the rest of the process — the app went on saying it after the cause was
 * gone. `adopt_context` is the opposite case and states why: a context may be
 * written once, so there the *attempt* is what is remembered.
 */
const androidEntry = between(credentialCode, '#[cfg(target_os = "android")]\nfn entry(', "fn install_default_store");
check(
  "a store that could not be reached is retried, and only the success is remembered",
  [
    androidEntry.length > 0,
    /OnceLock<\(\)>/.test(androidEntry),
    /OnceLock<Result</.test(androidEntry),
  ],
  [true, true, false],
);
/*
 * ⚠ **And the order in the activity, which is the whole of why any of it works.**
 * `initNdkContext` has to run before `super.onCreate` — that is what calls into
 * Rust and reaches both stores — and the library has to be loaded before the
 * `external fun` can resolve at all. Three indices, compared rather than trusted.
 */
const loadAt = activity.indexOf("System.loadLibrary");
const adoptAt = activity.indexOf("initNdkContext(applicationContext)");
const tauriAt = activity.indexOf("super.onCreate");
check(
  "the library loads, then the context is adopted, then Tauri starts",
  [loadAt >= 0, adoptAt > loadAt, tauriAt > adoptAt],
  [true, true, true],
);
/*
 * ⚠ **The renamed `jni` is the major the verifier itself asks for.** `init_with_env`
 * takes a `&mut jni::Env`, a type `jni` 0.21 does not have. Two majors coexist here
 * deliberately — tauri, tao, wry and the keyring store are all on 0.21 — so the one
 * this crate names for the verifier has to track the verifier's own requirement and
 * nothing else. Read out of the vendored manifest rather than written down twice.
 */
const renamedJni = capture(cargoToml, /^jni22 = \{ package = "jni", version = "([0-9.]+)"/m) ?? "";
check(
  "the renamed jni is a 0.22, which is the major the verifier's API is written against",
  renamedJni.startsWith("0.22"),
  true,
);
/*
 * ⚠ **The Gradle distribution is pinned by hash as well as by name, together.**
 * `distributionUrl` is a location: `gradlew` fetches ~130 MB and executes it as
 * this user, so without the sum a redirected answer is arbitrary code in a build
 * whose APK is still signed with the real key. Asserted as a *pair* because a
 * version moved past its sum is a refusal nobody reads as "the second edit was
 * missed".
 */
const wrapperProps = read(`${ANDROID_DIR}/gradle/wrapper/gradle-wrapper.properties`);
const wrapperVersion = capture(wrapperProps, /distributionUrl=.*\/gradle-([0-9.]+)-bin\.zip/);
const wrapperSum = capture(wrapperProps, /distributionSha256Sum=([0-9a-f]{64})/);
check(
  "the Gradle distribution is pinned by version and by hash, together",
  [wrapperVersion !== null, wrapperSum !== null],
  [true, true],
);
/*
 * ⚠ **And the committed wrapper jar is the reviewed one, byte for byte.** It is
 * the one file in this tree no reviewer can read: 59 KB of bytecode that `gradlew`
 * runs before anything else, committed because `gen/android` is. The sum is a
 * change-detector rather than a proof of provenance — it records what was looked
 * at — and a jar that moves without this line moving with it is the thing worth
 * stopping.
 */
const wrapperJarSum = createHash("sha256")
  .update(readFileSync(join(ROOT, `${ANDROID_DIR}/gradle/wrapper/gradle-wrapper.jar`)))
  .digest("hex");
check(
  "and the wrapper jar is the reviewed one, byte for byte",
  wrapperJarSum,
  "e996d452d2645e70c01c11143ca2d3742734a28da2bf61f25c82bdc288c9e637",
);
/*
 * ⚠ **The verifier is pinned and fenced, and the fence is the half that matters.**
 * `latest.release` resolved across `google()` and `mavenCentral()` too, because the
 * root `allprojects` block puts them in scope for this module — so anything
 * published under group `rustls` at a higher version would have replaced the class
 * that checks every certificate this app sees. `exclusiveContent` is what makes the
 * on-disk repository the only one that may serve it; pinning alone does not.
 */
check(
  "the verifier is pinned, read from cargo, and served only by the on-disk repository",
  [
    /implementation\("rustls:rustls-platform-verifier:\$rustlsVersion"\)/.test(gradleCode),
    /latest\.release/.test(gradleCode),
    /exclusiveContent/.test(gradleCode),
    /includeGroup\("rustls"\)/.test(gradleCode),
  ],
  [true, false, true, true],
);
/*
 * ⚠ **Nothing claims a per-build-type cleartext policy the platform ignores.**
 * `android:usesCleartextTraffic` is ignored whenever `android:networkSecurityConfig`
 * is set, on every level at or above this app's `minSdk` — so the attribute read as
 * a deliberate release-build decision while deciding nothing, and the two
 * `manifestPlaceholders` feeding it decided nothing either. The config is the one
 * authority, and it stays attached; `minSdk` is what keeps that true.
 */
check(
  "nothing claims a per-build-type cleartext policy the platform ignores",
  [
    /usesCleartextTraffic/.test(manifest),
    /manifestPlaceholders\[\"usesCleartextTraffic\"\]/.test(gradleCode),
    /android:networkSecurityConfig="@xml\/network_security_config"/.test(application),
    Number(capture(gradleCode, /minSdk = (\d+)/) ?? 0) >= 24,
  ],
  [false, false, true, true],
);
/*
 * ⚠ **The four attributes that keep the device key out of a cloud backup.** An
 * X25519 static lives in this app's private storage; `allowBackup="false"` plus the
 * extraction rules are what stop Auto Backup and `adb backup` carrying it off the
 * device. A future `tauri android init` rewrites this manifest with Tauri's
 * defaults, and every one of these is absent from those.
 */
check(
  "the manifest still carries all four hardening attributes",
  [
    /android:allowBackup="false"/.test(application),
    /android:fullBackupContent="false"/.test(application),
    /android:dataExtractionRules="@xml\/data_extraction_rules"/.test(application),
    /android:networkSecurityConfig="@xml\/network_security_config"/.test(application),
  ],
  [true, true, true, true],
);

/*
 * ⚠ **And the file that last attribute names, which a committed comment already
 * claimed was checked here and which nothing read.**
 *
 * `network_security_config.xml`'s own banner says *"`nativecheck` asserts the
 * attribute and this file as a **pair**, against comment-stripped source"*. A
 * grep for the resource name in this driver returned the two manifest patterns
 * above and nothing else — so what was asserted was that somebody typed a
 * policy, never that the policy says anything. That is the same shape as the
 * `dataExtractionRules` attribute one section up, which is why that one is
 * resolved by name and read: an attribute pointing at a file that excludes
 * nothing is not a build failure.
 *
 * The quiet direction is the one to fear here. An `init` re-run does not touch
 * this file — it removes the attribute that reaches it — and a later edit
 * dropping either clause would leave a build that simply cannot talk to a LAN
 * control plane or to one behind a private CA, reported as the server being down.
 *
 * ⚠ **Both clauses, and the user anchor is pinned as the deliberate decision it
 * is.** Q7.144 is the argument and that file carries the cost leg by leg — the
 * sharpest being `proxy.rs`'s `/v1` calls, which carry the account bearer in an
 * authorization header. It *could* be narrowed to `<debug-overrides>` with one
 * edit and no new resource file, which is the owner's call rather than a
 * measurement; this line is the second edit that call takes, deliberately,
 * because a widening this broad may not change silently in either direction.
 * Comment-stripped, because that file is mostly prose and the prose quotes both
 * clauses at length — including the `<debug-overrides>` block it is not using.
 */
const netsecName = capture(application, /android:networkSecurityConfig="@xml\/(\w+)"/) ?? "";
const netsecPath = `${ANDROID_DIR}/app/src/main/res/xml/${netsecName}.xml`;
check("the network policy the manifest names is a file that is there", existsSync(join(ROOT, netsecPath)), true);
const netsecXml = existsSync(join(ROOT, netsecPath)) ? read(netsecPath) : "";
const netsec = xmlCode(netsecXml);
report(
  "the network policy's markup survived the comment strip",
  netsecXml.length > netsec.length && netsec.includes("<network-security-config>"),
  `${String(netsecXml.length - netsec.length)} characters of prose removed`,
);
const baseConfig = between(netsec, "<base-config", "</base-config>");
check("the base config was found to read", baseConfig.length > 0, true);
check(
  "and it permits cleartext and trusts a user-installed CA, both on purpose",
  [
    /cleartextTrafficPermitted="true"/.test(baseConfig),
    /<certificates\s+src="system"\s*\/>/.test(baseConfig),
    /<certificates\s+src="user"\s*\/>/.test(baseConfig),
  ],
  [true, true, true],
);
/*
 * ⚠ **And everything `tauri android init` rewrites is ignored rather than
 * committed, the one with absolute paths in it first.** `tauri.settings.gradle`
 * holds this machine's `CARGO_HOME`, so it cannot be committed and a clone must
 * regenerate it — which is what `settings.gradle` applying it makes load-bearing.
 * The census is over the two `.gitignore` files rather than over a list here,
 * because a list here would be the third copy.
 */
const genIgnore = read(`${ANDROID_DIR}/.gitignore`) + "\n" + read(`${ANDROID_DIR}/app/.gitignore`);
for (const regenerated of [
  "/tauri.settings.gradle",
  "/tauri.build.gradle.kts",
  "/tauri.properties",
  "/proguard-tauri.pro",
  "/src/main/**/generated",
]) {
  check(`${regenerated} is ignored rather than committed`, genIgnore.includes(regenerated), true);
}
check(
  "and settings.gradle still applies the ignored one, which is what a clone fails on first",
  /apply from: 'tauri\.settings\.gradle'/.test(read(`${ANDROID_DIR}/settings.gradle`)),
  true,
);
/*
 * ⚠ **And not one committed file under `gen/android` writes an absolute path
 * down.** That is the property that decides which half of this tree may be
 * committed at all: a path into somebody's home directory is a file that builds on
 * one machine. Swept over the text files rather than asserted of the four known
 * ones, so a fifth arriving is caught.
 *
 * ⚠ **The exempt set is one of *paths*, built per `.gitignore` with the prefix
 * that file's entries are relative to. It used to be one of bare names too, and
 * the second half was the hole.** `app/.gitignore`'s entries are anchored to
 * `app/`, so `app/tauri.properties` and `app/tauri.build.gradle.kts` matched only
 * through a basename fallback — and a fallback keyed on the basename exempts
 * every file of that name **at any depth**, which is a file somebody adds three
 * directories down inheriting an exemption written for a different file. Anchored
 * per ignore file instead, and the fallback is deleted.
 */
const IGNORE_FILES = [
  [`${ANDROID_DIR}/.gitignore`, ""],
  [`${ANDROID_DIR}/app/.gitignore`, "app/"],
] as const;
const ignoredHere = new Set(
  IGNORE_FILES.flatMap(([file, prefix]) =>
    read(file)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/") && !line.includes("*"))
      .map((line) => `${prefix}${line.slice(1)}`),
  ),
);
report("the exempt set was read as anchored paths", ignoredHere.size > 0, `${String(ignoredHere.size)} paths`);
check(
  "and an ignored basename no longer exempts a file of that name at another depth",
  [ignoredHere.has("app/tauri.properties"), ignoredHere.has("tauri.properties")],
  [true, false],
);

/*
 * The predicate, named so it can be exercised rather than written inline. The two
 * home roots it looks for are spelled in it and deliberately nowhere in this
 * paragraph: the sweep below reads *this repository's own files*, and a comment
 * about a sweep that quotes the swept token is how a file lands on its own
 * offenders list.
 */
const writesAbsolutePath = (text: string): boolean => /\/Users\/|\/home\/[a-z]/.test(text);
/*
 * ⚠ **And the control for it, because an empty list is the passing answer.** A
 * predicate that stopped matching anything reads exactly like a clean tree —
 * "nothing was found" and "nothing can be found" are the same line of output,
 * which is the shape this file's `report` helper exists for everywhere else.
 * Both roots are driven positively and two non-paths negatively, so a widened,
 * narrowed or inverted pattern is red before the walk starts.
 */
check(
  "the absolute-path predicate bites where a path is present and nowhere else",
  [
    writesAbsolutePath('new File("/Users/somebody/.cargo/registry/src")'),
    writesAbsolutePath('new File("/home/somebody/.cargo/registry/src")'),
    writesAbsolutePath("apply from: 'tauri.settings.gradle'"),
    writesAbsolutePath(""),
  ],
  [true, true, false, false],
);

const absolutePaths: string[] = [];
const swept: string[] = [];
const skippedDirs: string[] = [];
const sweepAndroid = (dir: string, within: string): void => {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const here = within === "" ? name : `${within}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) {
      // Gradle's own output, and the `generated` package `init` rewrites.
      if (/^(build|\.gradle|\.kotlin|\.cxx|generated)$/.test(name)) skippedDirs.push(here);
      else sweepAndroid(rel, here);
      continue;
    }
    if (!/\.(kt|kts|gradle|pro|xml|properties)$/.test(name)) continue;
    // Anchored `.gitignore` entries name what a clone regenerates; those are
    // allowed the machine's own paths, and `tauri.settings.gradle` is the reason
    // this distinction exists at all.
    if (ignoredHere.has(here)) continue;
    swept.push(here);
    if (writesAbsolutePath(read(rel))) absolutePaths.push(rel);
  }
};
sweepAndroid(ANDROID_DIR, "");
/*
 * ⚠ **The corpus, reported beside the answer, because every filter above this is
 * silent when it narrows.** The assertion below is an equality against the empty
 * list, so a widened exempt set, an extension dropped from the list, or a
 * directory name added to the skip set each lowers what was looked at without
 * lowering the answer — three edits that read as `ok` and one of which is a
 * one-character change. The three numbers are what makes that visible.
 *
 * ⚠ **And a required-member list beside the count, because a floor cannot see a
 * skipped item.** The members are the files *this driver already reads by
 * literal path* — the manifest, the Gradle script, the keep file, the activity,
 * the wrapper properties, `settings.gradle` and both resources it resolves by
 * name — so they are a second derivation of "what is committed and is text
 * here", written down in the sections above rather than invented for this line.
 * A narrowing that reaches one of them is red here; one that only drops
 * non-members — a directory added to the skip set that holds none of them, an
 * exemption widened past these eight — is visible in the corpus report's three
 * numbers and nowhere else.
 */
const SWEPT_MEMBERS = [
  "app/build.gradle.kts",
  "app/proguard-rules.pro",
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/com/reemoat/app/MainActivity.kt",
  "app/src/main/res/xml/data_extraction_rules.xml",
  "app/src/main/res/xml/network_security_config.xml",
  "gradle/wrapper/gradle-wrapper.properties",
  "settings.gradle",
];
report(
  "the sweep read a corpus rather than nothing",
  swept.length > 0,
  `${String(swept.length)} files, ${String(skippedDirs.length)} directories skipped, ${String(ignoredHere.size)} paths exempt`,
);
check("and every file this driver asserts about by name is in it", SWEPT_MEMBERS.filter((one) => !swept.includes(one)), []);
check("no committed file under gen/android writes an absolute path down", absolutePaths, []);

/* ------------------------------------------------------------------ *
 * The icon, which nothing checked at all
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe icon, at every size a bundle asks for\n");

/**
 * Enough of a PNG reader to answer where the artwork is.
 *
 * ⚠ **All five filter types, rather than assuming zero.** `icons.mjs` writes
 * filter 0 on every row, so a decoder that only knew that one would agree with
 * the generator and with nothing else — and the failure this section exists to
 * catch is somebody replacing a raster by hand, out of an editor that filters
 * adaptively. A decoder narrower than the format is a check that stops biting the
 * moment the file stops being ours.
 */
interface Decoded {
  width: number;
  height: number;
  colour: number;
  depth: number;
  bpp: number;
  px: Buffer;
}

function decodePng(bytes: Buffer): Decoded {
  const byte = (buf: Buffer, at: number): number => buf[at] ?? 0;
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const parts: Buffer[] = [];
  while (at + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = byte(body, 8);
      colour = byte(body, 9);
    }
    if (type === "IDAT") parts.push(body);
    at += 12 + len;
  }
  const bpp = colour === 6 ? 4 : colour === 2 ? 3 : colour === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = byte(raw, read);
    read += 1;
    for (let x = 0; x < stride; x += 1) {
      const cur = byte(raw, read + x);
      const a = x >= bpp ? byte(px, y * stride + x - bpp) : 0;
      const b = y > 0 ? byte(px, (y - 1) * stride + x) : 0;
      const c = x >= bpp && y > 0 ? byte(px, (y - 1) * stride + x - bpp) : 0;
      let value = cur;
      if (filter === 1) value = cur + a;
      else if (filter === 2) value = cur + b;
      else if (filter === 3) value = cur + ((a + b) >> 1);
      else if (filter === 4) {
        const guess = a + b - c;
        const da = Math.abs(guess - a);
        const db = Math.abs(guess - b);
        const dc = Math.abs(guess - c);
        value = cur + (da <= db && da <= dc ? a : db <= dc ? b : c);
      }
      px[y * stride + x] = value & 0xff;
    }
    read += stride;
  }
  return { width, height, colour, depth, bpp, px };
}

/** The smallest box holding every pixel that is not effectively transparent. */
function opaqueBox(img: Decoded): { x: number; y: number; width: number; height: number } {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const alpha = img.bpp === 4 ? (img.px[(y * img.width + x) * 4 + 3] ?? 0) : 255;
      // Eight of 255, so one antialiased edge pixel does not read as absent and a
      // rounding artefact does not read as present.
      if (alpha <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

const png = (rel: string): Decoded => decodePng(readFileSync(join(ROOT, rel)));

/*
 * Apple's grid: an 824×824 squircle in a 1024×1024 canvas. Restated here rather
 * than imported, because `icons.mjs` is JavaScript and this config compiles none —
 * so the two copies are held to each other instead, which is the same shape
 * `OPENABLE` is checked in two sections up.
 */
const MARGIN = 100 / 1024;

/*
 * ⚠ **Every one of these is new, and the reason to say so is that the tree they
 * landed on had none.** Nothing in `nativecheck`, `imagecheck`, `pincheck`,
 * `deploycheck`, `docscheck` or any of the forty `webcheck` files asserted
 * anything about an icon — which is how a badge drawn at 100% of its canvas
 * shipped for the life of the project, and how `packages/native/icon.png` came to
 * be named by a script and never exist.
 */
// `bundle` is the one read at the top of this file; the icon list is its own.
const iconList = (bundle["icon"] ?? []) as string[];
report("the bundle names icons at all", iconList.length > 0, `${String(iconList.length)} entries`);
check(
  "every icon the bundle names exists on disk",
  iconList.filter((rel) => !existsSync(join(ROOT, TAURI_DIR, rel))),
  [],
);

/*
 * The macOS container, parsed rather than trusted. `ic10` is the 1024 the Dock
 * scales from, and the member list is pinned so that dropping the four legacy
 * RGB+mask members is a decision on the record rather than something to infer.
 */
const icns = readFileSync(join(ROOT, TAURI_DIR, "icons/icon.icns"));
const members: string[] = [];
let member: Buffer | null = null;
{
  let cursor = 8;
  while (cursor + 8 <= icns.length) {
    const type = icns.toString("ascii", cursor, cursor + 4);
    const len = icns.readUInt32BE(cursor + 4);
    if (len < 8) break;
    members.push(type);
    if (type === "ic10") member = icns.subarray(cursor + 8, cursor + len);
    cursor += len;
  }
}
check("the icns is an icns", icns.toString("ascii", 0, 4), "icns");
check("and its declared length is its real one", icns.readUInt32BE(4), icns.length);
check(
  "it carries the eight PNG members a macOS 13 floor reads, and no legacy RLE",
  members,
  ["ic11", "ic12", "ic07", "ic08", "ic13", "ic09", "ic14", "ic10"],
);
report("the 1024 member was found", member !== null, `${String(members.length)} members parsed`);

/*
 * ⭐ **The bug this section was written for, stated as a number.** Every raster in
 * this tree had an opaque bounding box equal to its whole canvas — a badge drawn
 * corner to corner, about a quarter larger in linear terms than every icon beside
 * it in the Dock. Apple's grid leaves 9.77% transparent on each side, and that is
 * the entire difference.
 *
 * One pixel of tolerance, because the margin is fractional below 1024 and the
 * edge is antialiased: 128 × 100/1024 is 12.5, and a box can honestly begin at
 * either 12 or 13.
 */
const inset = (rel: string): string => {
  const img = png(rel);
  const box = opaqueBox(img);
  const want = img.width * MARGIN;
  const side = img.width * (1 - 2 * MARGIN);
  const ok = Math.abs(box.x - want) <= 1 && Math.abs(box.y - want) <= 1 && Math.abs(box.width - side) <= 2;
  return ok ? "inset" : `${String(box.width)}x${String(box.height)} at ${String(box.x)},${String(box.y)}`;
};

const macOsRasters = ["icons/icon.png", "icons/128x128@2x.png", "icons/128x128.png", "icons/64x64.png", "icons/32x32.png"];
check(
  "every raster this project generates is inset to that grid",
  macOsRasters.map((name) => `${name} ${inset(`${TAURI_DIR}/${name}`)}`),
  macOsRasters.map((name) => `${name} inset`),
);
if (member !== null) {
  const box = opaqueBox(decodePng(member));
  check("and so is the member the Dock actually draws", [box.x, box.y, box.width, box.height], [100, 100, 824, 824]);
  check(
    "which is the same bytes as the file that looks like the master",
    Buffer.compare(member, readFileSync(join(ROOT, TAURI_DIR, "icons/icon.png"))),
    0,
  );
}

/*
 * ⚠ **Android is neither inset further nor full-bleed, and both halves bite.**
 * Its adaptive foreground is the mark *alone* on transparency at 58% of the frame
 * — a different treatment for a different mask, hand-authored because `tauri icon`
 * does not produce one — while its legacy rasters are correctly opaque edge to
 * edge. `native-packaging.md` records that a `tauri icon` run overwrites the first
 * with the whole badge; this is what would catch that, and `icons.mjs` writes
 * nothing here at all.
 */
const DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
const ART_ASPECT = 170 / 192;
for (const tree of [`${TAURI_DIR}/icons/android`, `${ANDROID_DIR}/app/src/main/res`]) {
  const foreground = DENSITIES.map((density) => {
    const img = png(`${tree}/mipmap-${density}/ic_launcher_foreground.png`);
    const box = opaqueBox(img);
    const share = box.height / img.height;
    const aspect = box.width / box.height;
    return share > 0.57 && share < 0.59 && Math.abs(aspect - ART_ASPECT) < 0.01 ? "the mark, inset to the safe zone" : `${String(box.width)}x${String(box.height)} of ${String(img.width)}`;
  });
  check(`${tree}: the adaptive foreground is the mark alone, not the badge`, foreground, DENSITIES.map(() => "the mark, inset to the safe zone"));
  const legacy = DENSITIES.flatMap((density) =>
    ["ic_launcher.png", "ic_launcher_round.png"].map((name) => {
      const img = png(`${tree}/mipmap-${density}/${name}`);
      const box = opaqueBox(img);
      return box.width === img.width && box.height === img.height ? "full bleed" : `${String(box.width)} of ${String(img.width)}`;
    }),
  );
  check(`${tree}: and the legacy rasters still fill their frame`, [...new Set(legacy)], ["full bleed"]);
}

/*
 * ⚠ **Two committed comments claimed this check and it did not exist.** Both
 * `mipmap-anydpi-v26/ic_launcher.xml` and `values/ic_launcher_background.xml` say
 * in their banners that `nativecheck` pins the `@color` form and the colour it
 * resolves to. A grep for `ic_launcher` in this file returned nothing. So it is
 * written here rather than the claim being softened — and comment-stripped,
 * because both files quote the very strings being looked for, which is the hazard
 * `MainActivity.kt`'s own assertion already records.
 */
const stripXml = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");
for (const tree of [`${TAURI_DIR}/icons/android`, `${ANDROID_DIR}/app/src/main/res`]) {
  const adaptive = stripXml(read(`${tree}/mipmap-anydpi-v26/ic_launcher.xml`));
  const colours = stripXml(read(`${tree}/values/ic_launcher_background.xml`));
  check(
    `${tree}: the launcher's background is a colour, not a mipmap`,
    [
      /<background android:drawable="@color\/ic_launcher_background"\s*\/>/.test(adaptive),
      /@mipmap\/ic_launcher_background/.test(adaptive),
      /<monochrome/.test(adaptive),
    ],
    [true, false, false],
  );
  check(
    `${tree}: and it is the badge colour the browser tab already uses`,
    /<color name="ic_launcher_background">(#[0-9a-f]{6})<\/color>/.exec(colours)?.[1],
    "#1c1a16",
  );
}

/*
 * The mark is one drawing written in three places — `favicon.svg`, `Mark.tsx` and
 * the landing repository's own copy, which is not on this filesystem. Two of the
 * three are here, so the two are held to each other; the generator is the reason
 * there is no fourth, and it is asserted to *read* the first rather than restate
 * it.
 */
const favicon = read("packages/web/public/favicon.svg");
const faviconBars = [...favicon.matchAll(/<rect(?: x="([\d.]+)")?(?: y="([\d.]+)")? width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"\/>/g)].map(
  (m) => [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[4])] as const,
);
const mark = read("packages/web/src/ui/Mark.tsx");
const markBars = [...mark.matchAll(/\{ x: ([\d.]+), y: ([\d.]+), height: ([\d.]+) \}/g)].map(
  (m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const,
);
report("both copies of the mark were read", faviconBars.length === 3 && markBars.length === 3, `${String(faviconBars.length)} and ${String(markBars.length)} bars`);
check("the mark is the same three bars in both places it is drawn", markBars, faviconBars);
check(
  "including the asymmetry nobody may straighten in one copy",
  [/BAR_WIDTH = 50/.test(mark), /BAR_RADIUS = 16\.43/.test(mark), /VIEW_WIDTH = 170/.test(mark), /VIEW_HEIGHT = 192/.test(mark)],
  [true, true, true, true],
);

/*
 * ⚠ **The browser's badge is still full-bleed, and that is the platform masking
 * rather than an oversight.** A tab strip does not mask an icon, so a margin there
 * is a smaller mark for nothing; iOS masks `apple-touch-icon.png` itself, and that
 * file is colour type 2 — it has no alpha channel to carry a margin with. Pinned
 * so that a later pass "fixing the inconsistency" has to read this first.
 */
check("the favicon's badge still fills its viewBox", /<rect width="192" height="192" rx="48"/.test(favicon), true);
check("and the home-screen icon has no alpha to inset with", png("packages/web/public/apple-touch-icon.png").colour, 2);

/*
 * The generator reads the artwork rather than restating it, and states only the
 * two numbers that are Apple's.
 */
const generator = read(`${NATIVE}/scripts/icons.mjs`);
check(
  "the generator derives the mark from the favicon and states only the grid",
  [/favicon\.svg/.test(generator), /100 \/ 1024/.test(generator), /185\.4 \/ 824/.test(generator), /BAR_WIDTH|16\.43/.test(generator)],
  [true, true, true, false],
);
check(
  "and it writes nothing under either Android tree",
  [/icons\/android/.test(generator.replace(/\/\*\*[\s\S]*?\*\//g, "")), /gen\/android/.test(generator.replace(/\/\*\*[\s\S]*?\*\//g, ""))],
  [false, false],
);

/*
 * ⚠ **And the line that would have caught the whole thing.** `package.json` said
 * `tauri icon icon.png` for the life of this package and `packages/native/icon.png`
 * has never existed — a script naming a file that is not there, which nothing
 * looked at because nothing looked at icons. `build-daemon.mjs` is the precedent:
 * its own refusal already names a file this file checks the existence of.
 */
const nativeScripts = (json(`${NATIVE}/package.json`)["scripts"] ?? {}) as Record<string, string>;
const namedFiles = [...new Set(Object.values(nativeScripts).flatMap((line) => line.match(/[\w./-]+\.(?:mjs|png|json)/g) ?? []))];
report("the manifest's scripts name files at all", namedFiles.length > 0, namedFiles.join(" "));
check(
  "and every file a script in this manifest names exists",
  namedFiles.filter((rel) => !existsSync(join(ROOT, NATIVE, rel))),
  [],
);

process.stdout.write("\nthe env file's three answers, on both sides of the bridge\n");
const daemonRs = read(`${TAURI_DIR}/src/daemon.rs`);
const rustConfig = [...daemonRs.matchAll(/pub const CONFIG_[A-Z]+: &str = "([a-z]+)";/g)].map((m) => m[1]);
const pageConfig = [
  ...read("packages/web/src/native.ts")
    .slice(read("packages/web/src/native.ts").indexOf("export const DAEMON_CONFIG"))
    .matchAll(/^\s{2}([a-z]+): "([a-z]+)",$/gm),
].map((m) => m[2]);
check("the host names three", rustConfig.length, 3);
check("and the page mirrors exactly those", [...pageConfig].sort(), [...rustConfig].sort());
/*
 * ⚠ **And the exits the daemon gives, written down in three places.**
 * `scripts/daemon.ts` decides them, `daemon.rs` carries one back, and `store.ts`
 * branches on them — so a renumbering on one side is a store that silently takes
 * no arm at all. The alternative to a number was reading the daemon's log, and a
 * supervisor that greps its child's output is one rewording away from doing
 * nothing quietly; that is the whole reason these exist, so they are pinned.
 */
const daemonTs = read("scripts/daemon.ts");
const nativeTs = read("packages/web/src/native.ts");
for (const [name, constant] of [
  ["codeRefused", "EXIT_CODE_REFUSED"],
  ["controlPlaneUnreachable", "EXIT_CONTROL_PLANE_UNREACHABLE"],
  ["localNetworkBlocked", "EXIT_LOCAL_NETWORK_BLOCKED"],
] as const) {
  const daemonValue = capture(daemonTs, new RegExp(`const ${constant} = (\\d+);`));
  const pageValue = capture(nativeTs, new RegExp(`${name}: (\\d+),`));
  check(`the daemon names ${constant}`, daemonValue !== null, true);
  check(`and the page agrees on ${name}`, pageValue, daemonValue);
}
check(
  "and the daemon still keeps 2 for everything else",
  /process\.exit\(\s*rejected[\s\S]{0,600}:\s*2,?\s*\)/.test(daemonTs),
  true,
);
/*
 * ⚠ **And the app says why macOS refused it, because the daemon cannot.**
 * Measured 2026-09-15 on macOS 15: a daemon started by this app is a child of it,
 * so this app is the responsible process for Local Network Privacy — and until
 * that is granted, reaching a control plane on a private subnet fails with
 * `EHOSTUNREACH` while the same address answers `ping` from a terminal one second
 * later. The key is what makes the system's own prompt say something about
 * Reemoat rather than nothing at all.
 */
check(
  "the bundle asks for the local network in its own words",
  /NSLocalNetworkUsageDescription/.test(read(`${TAURI_DIR}/Info.plist`)),
  true,
);
check("and the config merges that file in", (bundle["macOS"] as Record<string, unknown>)["infoPlist"], "Info.plist");
/*
 * And the key itself is spelled the same on both sides of the *file*, since the
 * shell installer writes it and this reads it back.
 */
check(
  "the fleet is decided by the key install.sh writes",
  /const CONTROL_PLANE_KEY: &str = "REEMOAT_CONTROL_PLANE";/.test(daemonRs),
  true,
);
/*
 * ⚠ **The keys a rewrite is allowed to touch are a closed list of three.** Growing
 * it is how a refreshed enrollment code deletes somebody's `NODE_EXTRA_CA_CERTS`
 * — measured on a real machine 2026-09-15, where that line was the only reason the
 * daemon could reach its control plane at all.
 */
const owned = /const OWNED_KEYS: \[&str; 3\] = \[([^\]]+)\];/.exec(daemonRs)?.[1] ?? "";
/*
 * ⚠ **An announce file is not evidence that a daemon is running.** `announce.ts`
 * removes it on a clean stop and cannot on an unclean one, so a force quit, a
 * crash or a power cut leaves one naming a port nobody is on — and believing it
 * answers `foreign`, the one status the setup flow reads as "somebody else has
 * this covered". Nothing would ever start a daemon again, on a computer whose
 * daemon dies with the app by design.
 */
check("a daemon this app did not start is confirmed to be there", /fn is_alive\(/.test(daemonRs), true);
/*
 * ⚠ **And the probe carries no credential.** `local.rs` reads a file rather than
 * probing precisely because a *meaningful* probe would hand a 300-second bearer to
 * whatever happened to answer. `/health` is the one route below the daemon's auth
 * middleware, so asking it costs nothing — but only while nothing attaches a
 * header to the request, which is why it is written over a raw socket rather than
 * through a configured client.
 */
const probe = /pub fn is_alive\([\s\S]*?\n\}/.exec(daemonRs)?.[0] ?? "";
check("the liveness probe exists to be read", probe.length > 0, true);
check("and it sends no credential", /authorization|Bearer|reqwest/i.test(probe), false);
check("and it asks the one route below the auth gate", /GET \/health/.test(probe), true);
/*
 * ⚠ **And the daemon dies with the app, which is one line and no other evidence.**
 * `Child` does not kill on drop — it detaches — so without an exit hook the daemon
 * is orphaned on every quit, keeps its *own* bundle's runtime and sources, and the
 * next version of this app finds it alive and announced, reads `foreign`, and never
 * starts the daemon it shipped with. Nothing else in this repository can see the
 * absence of a callback: `cargo` compiles either way and no driver runs the app.
 */
/*
 * ⚠ **Read with the comments taken out, and the reason is this assertion's own
 * history.** `/RunEvent::Exit/.test(libRs)` was green on the docblock four lines
 * above the code — the paragraph you have just read names `RunEvent::Exit`, so the
 * check passed whether or not the callback existed. That is the failure the
 * paragraph itself describes, arriving in the thing meant to catch it, and the
 * realistic regression walks straight through it: somebody "corrects" the hook to
 * `ExitRequested` or a window-close handler, keeps `supervisor.stop()`, and both
 * assertions stay green while every quit orphans a daemon.
 *
 * `daemonSrc` above already strips for exactly this; `libRs` is stripped here
 * rather than at its `read` because other assertions in this file are *about* the
 * comment layer, and `flat()` must not run over prose.
 */
const libCode = libRs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("the shell handles its own exit", /matches!\(event, tauri::RunEvent::Exit\)/.test(flat(libCode)), true);
check("and stops the daemon it started there", /supervisor\.stop\(\)/.test(libCode), true);
/*
 * Bounded, because it runs on the way out of the main loop: an unbounded wait
 * hands the daemon's 25-second shutdown budget to the quit gesture.
 */
check("and the stop is bounded rather than open-ended", /const STOP_DEADLINE/.test(daemonRs), true);
/*
 * ⚠ **And a rewrite is refused while a hand-installed service owns the same file.**
 * `deploy/launchd/reemoat.plist.in` sets `KeepAlive` with `ThrottleInterval 10`,
 * so launchd would respawn within ten seconds, source the newly written file and
 * race this app's child for a single-use enrollment code, the database lock and
 * the port. Whichever loses, the code is spent and neither ends up enrolled.
 */
check("a hand-installed service is looked for", /fn managed_unit\(/.test(daemonRs), true);
check(
  "and a rewrite is refused while one owns the file",
  /daemon::managed_unit\(&home\)/.test(read(`${TAURI_DIR}/src/commands.rs`)),
  true,
);
/*
 * ⚠ **And the remedy must clear what the check looks at.** The first one said
 * `launchctl bootout`, which unloads a service and leaves its file — so the check
 * found it again, refused again, and offered the same command: a permanent lockout
 * whose own instructions could not end it. Detection is by file, because
 * `RunAtLoad` means an unloaded plist comes back at the next login, so the remedy
 * has to move the file.
 */
const remedy = /pub fn managed_unit_detail\([\s\S]*?\n\}/.exec(daemonRs)?.[0] ?? "";
check("the remedy exists to be read", remedy.length > 0, true);
check("and it moves the file rather than only unloading it", /mv \{/.test(remedy), true);
/*
 * ⚠ **And a value that could write a second assignment is refused rather than
 * escaped.** The env file is sourced by `run-daemon.sh` with `.`, and every key
 * `parse_env` finds reaches the daemon's environment with no whitelist — so a
 * newline is a second assignment and `NODE_OPTIONS` is code. `parse_env` strips one
 * pair of quotes and does not understand `'\''`, so escaping here would be a
 * second, divergent reading of a file that already has one authoritative reader.
 */
check("values written into the env file are validated", /fn is_writable_value\(/.test(daemonRs), true);
check(
  "and the state command asks before answering foreign",
  /announced\.filter\(\|found\| ours \|\| daemon::is_alive/.test(read(`${TAURI_DIR}/src/commands.rs`)),
  true,
);
check(
  "a rewrite may replace exactly the three keys this app owns",
  owned.split(",").map((k) => k.trim()).filter(Boolean),
  ['"REEMOAT_AUTH"', "CONTROL_PLANE_KEY", '"REEMOAT_ENROLL_CODE"'],
);

/*
 * ⚠ **The log is its own command, and the split is the assertion.** Owner's call,
 * 2026-09-15: the setup notice stopped drawing the daemon's two hundred lines and
 * Settings → Logs draws them instead. The obvious way to feed that screen would
 * have been to widen `DaemonState.detail` to carry the ring whenever there is one
 * — which puts a log on the one-second setup poll and turns a field meaning *what
 * explains this failure* into a log field by accident. So: a second command, and
 * `host_daemon_state`'s running and foreign arms still answer `detail: None`.
 *
 * Both halves, because the first alone would go green over a widened `detail`
 * sitting beside a command nobody calls.
 */
{
  const commandsRs = read(`${TAURI_DIR}/src/commands.rs`);
  check("the log has a command of its own", /pub fn host_daemon_log\(/.test(commandsRs), true);
  check("and the supervisor answers it as lines", /pub fn log_lines\(&self\) -> Vec<String>/.test(daemonRs), true);
  /*
   * ⚠ **And the poll carries no output at all any more.** `DaemonState` had a
   * `detail` field holding the tail, which is what the setup notice drew; the
   * notice draws a sentence now, so the field has no reader and is gone rather
   * than left on the wire for nobody. What the poll asks the ring is a boolean —
   * `printed_anything`, which is the whole of `exited` against `absent`.
   *
   * A negative and a positive, because either alone is satisfied by the wrong
   * thing: no field named `detail` on the struct, and the bit that replaced it.
   */
  check("the poll carries no daemon output", /pub detail:/.test(daemonRs), false);
  check("and asks the ring for a bit instead", /pub fn printed_anything\(&self\) -> bool/.test(daemonRs), true);
  check("which is what tells `exited` from `absent`", /if supervisor\.printed_anything\(\) \{ "exited" \} else \{ "absent" \}/.test(flat(commandsRs)), true);
  check("and the page's mirror of the struct dropped it too", /detail/.test(/export interface DaemonState \{[\s\S]*?\n\}/.exec(read("packages/web/src/native.ts"))?.[0] ?? "x detail"), false);
  /*
   * ⚠ **And it never refuses.** A screen whose whole subject is "what did it say"
   * has no use for a refusal it would have to render instead of the log — every
   * absence is an empty list, and the screen tells them apart from the state it
   * already has. A `Result` here would be a second empty-state vocabulary.
   */
  check("the log command answers a list rather than a result", /pub fn host_daemon_log\(host: State<'_, Host>\) -> Vec<String>/.test(commandsRs), true);
}

/*
 * ⚠ **The payload is not where a coding-agent CLI comes from, and it shipped one
 * anyway.** Measured 2026-09-15: `codex-acp` depends on `@openai/codex`, so npm
 * staged that package and wrote a `.bin/codex` for it, while `--omit=optional`
 * dropped the platform package that implements it — on purpose, because
 * `deploy/agents.sh` installs that CLI from the vendor (Q4.114). `daemon_path`
 * puts the payload's `.bin` first on PATH, which is right for the adapters and
 * wrong for this: `findOnPath("codex")` returned a shim that answers every
 * invocation with `Missing optional dependency`, ahead of the working copy the
 * person had installed. The agent was *listed* — listing asks only whether the
 * CLI resolves — and failed after the first message.
 *
 * Two halves, and the second is what keeps this from rotting: the prune exists,
 * **and** the names it prunes are exactly `AGENT_LOGIN`'s. A fifth agent added in
 * `src/acp/agents.ts` and not in the staging script is this defect back, on the
 * fifth agent, with nothing saying so.
 */
{
  const staging = read(`${NATIVE}/scripts/build-daemon.mjs`);
  check("the payload prunes the agent CLIs it does not ship", /function pruneAgentClis\(\)/.test(staging), true);
  check("and the prune runs", /^pruneAgentClis\(\);$/m.test(staging), true);
  const staged = /const AGENT_CLIS = \[([^\]]*)\]/.exec(staging)?.[1] ?? "";
  const pruning = staged.split(",").map((name) => name.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
  const agentsTs = read("src/acp/agents.ts");
  const login = /export const AGENT_LOGIN[\s\S]*?\n\};/.exec(agentsTs)?.[0] ?? "";
  const commands = [...login.matchAll(/^    command: "([a-z]+)",$/gm)].map((m) => m[1]).sort();
  check("both lists were found", pruning.length > 0 && commands.length > 0, true);
  check("and the payload prunes exactly the CLIs this daemon drives", pruning, commands);
  /*
   * The ordering the prune exists because of. `.bin` first is deliberate — the
   * adapters and the runtime must resolve with no profile at all — so the fix
   * cannot be to move it, and this pins that it was not moved by mistake.
   */
  check("the payload's bin is still first on the daemon's PATH", /parts\.push\(payload\.root\.join\("node_modules"\)\.join\("\.bin"\)/.test(flat(daemonRs)), true);
}

/*
 * ⚠ **Who the daemon is, which `env_clear` took away and which a credential store
 * keys on.** Measured 2026-09-15 on the machine that had it, and it is the
 * sharpest failure this shell has produced: `claude` derives its macOS Keychain
 * *account* from `USER`, falling back to the literal `unknown`. Spawned without
 * it, the agent looked up a credential nobody has, wrote an **empty** one under
 * `unknown` on its first start, and then answered every turn with `OAuth session
 * expired and could not be refreshed` — while the same binary, same `HOME`, same
 * Keychain, worked in a terminal three feet away. Reproduced exactly on
 * `env -i HOME=… PATH=… LANG=…`: refused without `USER`, answered with it.
 *
 * Signing in again could never have fixed it: a sign-in writes the *right*
 * account and the agent kept reading the wrong one.
 *
 * Three assertions, because the interesting part is not that the line exists.
 */
{
  /*
   * ⚠ **Captured from the raw source rather than through {@link flat}, and the
   * `\\s*` is load-bearing.** The body is asserted below by *position* as well as
   * by content, and flattening the whole file would make one index compare across
   * every function before this one. So only the signature is relaxed — rustfmt
   * puts each parameter on its own line once the line passes `max_width` — and
   * `\n    \}` still finds the function's own close, because every block inside
   * it is indented deeper.
   */
  const start = /pub fn start\(\s*&mut self[\s\S]*?\n    \}/.exec(daemonRs)?.[0] ?? "";
  check("the supervisor's spawn was found to read", start.length > 0, true);
  check("it still builds the environment rather than inheriting one", /\.env_clear\(\)/.test(start), true);
  check("and it names who the daemon is", /command\.env\("USER", &name\);/.test(start), true);
  check("in both spellings, because POSIX has two and tools read either", /command\.env\("LOGNAME", &name\);/.test(start), true);
  /*
   * ⚠ **Set *before* the env file is applied, so a `USER=` line there still wins.**
   * That is the rule the certificate pass-through states outright, and it is what
   * keeps an interim workaround somebody wrote into `~/.reemoat/daemon.env` from
   * fighting the fix. Asserted by position, because nothing typed can hold an
   * ordering.
   */
  const named = start.indexOf('command.env("USER", &name);');
  const fromFile = start.indexOf("for (key, value) in env {");
  check("and the env file still wins over it", named > 0 && fromFile > named, true);
  /*
   * The authority, not the inherited value — `commands.rs` takes `HOME` from
   * `app.path().home_dir()` for the same reason, and a stale export from whoever
   * launched the bundle is exactly what this must not reproduce.
   */
  check("the name comes from the system rather than from a variable", /libc::getpwuid\(libc::getuid\(\)\)/.test(daemonRs), true);
  /*
   * The two neighbours caught with it. Neither is measured breaking anything —
   * they are here because the failure was not "claude is unusual", it was "a clean
   * environment is missing what every tool assumes a session has".
   */
  for (const name of ["SHELL", "TMPDIR"]) {
    check(`and ${name} reaches the daemon too`, new RegExp(`"${name}",`).test(start), true);
  }
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
