#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Regression driver for the native shell's configuration (tauri.conf.json, capabilities, commands.rs, gen/android): offline, and deliberately runs no cargo. */

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

function capture(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1] ?? null;
}

/** Both anchors must be present and in order, else "": `slice` reads a missing end (-1) as counting from the end and silently widens. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start < 0 || end < 0 || end <= start) return "";
  return source.slice(start, end);
}

/** Rust with rustfmt's line breaks undone, so a pattern matches the code however it wraps. For code only, never for comment prose. */
function flat(rust: string): string {
  return rust
    .replace(/\s+/g, " ")
    .replace(/ ?\. ?/g, ".")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
}

/** Rust without comments: an assertion about code must not be satisfied by prose quoting it. `//` is anchored at line start so `https://` literals survive. */
function rustCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** Kotlin without comments. The block strip is line-anchored because build.gradle.kts globs contain slash-star sequences an unanchored strip would eat. */
function kotlinCode(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function xmlCode(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

/** JSON names of a serde struct body: the `serde(rename)` on the line above a field, else its Rust name. Walked line by line so it cannot answer a superset. */
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

/** Anchored at exactly two spaces so docblock lines are never read as fields. */
function tsInterfaceKeys(body: string): string[] {
  return [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1] ?? "").sort();
}

const NATIVE = "packages/native";
const TAURI_DIR = `${NATIVE}/src-tauri`;
const CONF = `${TAURI_DIR}/tauri.conf.json`;

process.stdout.write("\nthe frontend, and where it comes from\n");

const conf = json(CONF);
const build = (conf["build"] ?? {}) as Record<string, unknown>;
const app = (conf["app"] ?? {}) as Record<string, unknown>;
const bundle = (conf["bundle"] ?? {}) as Record<string, unknown>;

check("tauri.conf.json names a frontendDist", typeof build["frontendDist"], "string");
const dist = String(build["frontendDist"]);
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
const devUrl = build["devUrl"];
check(
  "the dev URL is a loopback dev server and nothing else",
  typeof devUrl === "string" && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(devUrl),
  true,
);

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
// `lib.rs` builds this window itself to attach `on_navigation`; with `create` true there would be two, one unguarded.
check("and the configuration leaves creating it to Rust", main["create"], false);
check(
  "no window is pointed at a remote URL",
  windows.filter((w) => typeof w["url"] === "string" && /^https?:/i.test(String(w["url"]))),
  [],
);

// Tauri intercepts OS file drops unless this is false, which silently breaks the composer and importer drops.
check("OS file drops still reach the webview", main["dragDropEnabled"], false);

// This global is the whole bridge, read through `native.ts` in the `TelegramWebviewProxy` idiom; the web package depends on no @tauri-apps package.
check("the bridge global is injected", app["withGlobalTauri"], true);
const webManifest = json("packages/web/package.json");
check(
  "and the web package depends on no @tauri-apps package",
  [...Object.keys(webManifest["dependencies"] ?? {}), ...Object.keys(webManifest["devDependencies"] ?? {})].filter(
    (name) => name.startsWith("@tauri-apps/"),
  ),
  [],
);

process.stdout.write("\nthe policy this document carries, since no server sends it one\n");

const security = (app["security"] ?? {}) as Record<string, unknown>;
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
// `blob:` for ImagePreview's fetched bytes, `https:` for plugin icons from origins known only at runtime.
check("img-src is self, blob and https", (directives.get("img-src") ?? []).sort(), ["'self'", "blob:", "https:"]);
// The relay origin arrives per machine at runtime, so only its scheme can be bound; the control plane must not appear, since `/v1/*` goes over IPC.
const connect = directives.get("connect-src") ?? [];
check("connect-src reaches a relay over both of its schemes", ["https:", "wss:"].every((s) => connect.includes(s)), true);
check(
  "and carries nothing but schemes and self",
  connect.filter((s) => s !== "'self'" && !/^[a-z][a-z0-9+.-]*:$/.test(s)),
  [],
);
check("no source anywhere is a wildcard", policy.includes("*"), false);
check("and eval is never allowed", /unsafe-eval/.test(policy), false);

process.stdout.write("\nwhat the webview is allowed to reach\n");

const capDir = join(ROOT, TAURI_DIR, "capabilities");
const caps = readdirSync(capDir).filter((f) => f.endsWith(".json"));
check("there are capability files to check", caps.length >= 1, true);

const granted: string[] = [];
for (const file of caps) {
  const cap = JSON.parse(readFileSync(join(capDir, file), "utf8")) as Record<string, unknown>;
  check(`${file} names the windows it applies to`, cap["windows"], ["main"]);
  check(`${file} grants nothing to a remote origin`, Object.hasOwn(cap, "remote"), false);
  check(`${file} says why it is what it is`, typeof cap["description"] === "string", true);
  for (const permission of (cap["permissions"] ?? []) as unknown[]) {
    granted.push(typeof permission === "string" ? permission : JSON.stringify(permission));
  }
}
// Pinned exact and empty: app commands need no entry, and a JS permission for a Rust-driven plugin would open it to a page rendering agent output.
check("the granted permission set is empty", granted.sort(), []);
check(
  "and no plugin the Rust side drives is reachable from the page",
  granted.filter((p) => /^(dialog|clipboard-manager|opener|http|fs|shell|updater):/.test(p)),
  [],
);
check("no permission is a wildcard", granted.filter((p) => p.includes("*")), []);

process.stdout.write("\nthe schemes a link may open, from both sides\n");

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

process.stdout.write("\nthe announcement, from both sides of it\n");

// `src/announce.ts` writes daemon.json and `local.rs` reads it, across languages, so a renamed field fails nowhere else (Q7.148).
{
  const ts = read("src/announce.ts");
  const rs = read("packages/native/src-tauri/src/local.rs");

  const written = capture(ts, /export interface LocalAnnounce \{([\s\S]*?)\n\}/);
  check("the daemon's side of the shape was readable", written !== null, true);
  const writtenKeys = [...(written ?? "").matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1] ?? "").sort();

  const stored = capture(rs, /struct Stored \{([\s\S]*?)\n\}/);
  check("and the shell's side of it", stored !== null, true);
  const readJsonKeys = rustJsonKeys(stored ?? "");

  check("both sides were found to have fields", [writtenKeys.length > 0, readJsonKeys.length > 0], [true, true]);
  check("and the daemon writes exactly what the shell reads", writtenKeys, readJsonKeys);

  check(
    "the version the daemon stamps is the version the shell accepts",
    capture(ts, /export const ANNOUNCE_VERSION = (\d+);/),
    capture(rs, /const ANNOUNCE_VERSION: u32 = (\d+);/),
  );

  check("the daemon names the control plane it enrolled with", writtenKeys.includes("controlPlane"), true);
  check(
    "and the shell reads it with a default, so an older daemon's file still parses",
    /#\[serde\(default\)\]\s*#\[serde\(rename = "controlPlane"\)\]\s*control_plane: Option<String>,/.test(stored ?? ""),
    true,
  );
  const localCode = flat(rustCode(rs));
  check(
    "and compares it through the one normalizer",
    /pub fn for_another_server\(&self, origin: &str\) -> bool \{ match self\.control_plane\.as_deref\(\) \{ None => false, Some\(raw\) => !crate::config::normalize_origin\(raw\)\.is_ok_and\(\|named\| named == origin\)/.test(localCode),
    true,
  );
  const pageDaemon = capture(rs, /pub struct LocalDaemon \{([\s\S]*?)\n\}/);
  check("while the page's own answer carries no control plane", rustJsonKeys(pageDaemon ?? ""), ["base", "instanceId", "machineId"]);
  const stateBody = flat(rustCode(between(commandsRs, "pub fn host_daemon_state(", "pub fn host_daemon_start(")));
  check("the state command was found to read", stateBody.length > 0, true);
  check("and reads the announcement with its control plane", /local::read_announced\(&root\.dir\)/.test(stateBody), true);
  const probed = stateBody.indexOf("daemon::is_alive(");
  const compared = stateBody.indexOf("found.for_another_server(&origin)");
  check("and compares it with this server, after the probe", [probed > 0, compared > probed], [true, true]);
  check("onto the state as a flag", /state\.stranger = stranger;/.test(stateBody), true);
  check("while the status is still decided by the file and the probe alone", /let mut state = match \(announced, ours\) \{/.test(stateBody), true);
}

// `Boot` has no `rename_all`, so a camelCase field missing its own `rename` reaches the page as undefined with every other check green.

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

  const renames = [...(boot ?? "").matchAll(/serde\(rename = "(\w+)"\)/g)].length;
  check(
    "the reader is actually reading renames rather than assuming them",
    renames > 0 && hostKeys.some((key) => /[A-Z]/.test(key)),
    true,
  );
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
  check("the strip had something to remove", bootDecl.length > bootCode.length, true);

  // `claimed` seeds `localMachineId` on a cold launch: read for this boot's account, and never proven by a probe, which would delay the first paint.
  const bootBody = flat(rustCode(between(commandsRs, "pub fn host_boot(", "pub fn host_device_dh(")));
  check("the boot command was found to read", bootBody.length > 0, true);
  check(
    "it reads this app's claim for the account it boots on",
    /let claimed = scope\.as_deref\(\)\.and_then\(\|scope\| daemon::read_claim\(&host\.config_dir, scope\)\);/.test(bootBody),
    true,
  );
  check("and hands it over as the field", /\bclaimed,\s*\}/.test(bootBody), true);
  check("without proving a daemon to do it", /is_alive|read_announced|local::read|announce_roots/.test(bootBody), false);
  // The credential crosses the bridge once per page load, for this webview's account only (Q1.651, Q5.120).
  check(
    "it hands the credential over only on this page load's first boot",
    /let credential = scope\.as_deref\(\)\.filter\(\|_\| seat\.hand\)\.and_then\(credential::read\);/.test(bootBody),
    true,
  );
  check("and reads it exactly once", bootBody.split("credential::read").length - 1, 1);
  check("about the seat the host holds for the calling webview", bootBody.split("host.boot(webview.label())").length - 1, 1);
  const hostBoot = between(flat(rustCode(commandsRs)), "fn boot(&self, label: &str) -> Option<BootSeat> {", "fn seat_as(");
  check(
    "and the one-shot is the host's: a generation per page load, the credential handed once, nothing while rebinding",
    [
      /if seat\.rebinding \{ return Some\(BootSeat \{ slot: seat\.slot\.clone\(\), generation: None, hand: false, rebinding: true, \}\);/.test(hostBoot),
      /let generation = seat\.generation\.get_or_insert_with\(new_generation\)\.clone\(\);/.test(hostBoot),
      /let hand = !seat\.handed; seat\.handed = true;/.test(hostBoot),
    ],
    [true, true, true],
  );
}

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
      // Not exported, so the pattern must not require `export`.
      page: () => tsInterfaceKeys(capture(nativeTs, /\binterface CpAnswer \{([\s\S]*?)\n\}/) ?? ""),
    },
    {
      what: "a sign-in the host bound",
      source: commandsRs,
      struct: "Bound",
      page: () => tsInterfaceKeys(capture(nativeTs, /export interface NativeBound \{([\s\S]*?)\n\}/) ?? ""),
    },
    {
      what: "an account in the drawer",
      source: commandsRs,
      struct: "AccountSummary",
      page: () => tsInterfaceKeys(capture(nativeTs, /export interface NativeAccountSummary \{([\s\S]*?)\n\}/) ?? ""),
    },
    {
      what: "the accounts on this computer",
      source: commandsRs,
      struct: "AccountList",
      page: () => tsInterfaceKeys(capture(nativeTs, /export interface NativeAccountList \{([\s\S]*?)\n\}/) ?? ""),
    },
    {
      what: "an account move",
      source: commandsRs,
      struct: "AccountMove",
      page: () => tsInterfaceKeys(capture(nativeTs, /export interface NativeAccountMove \{([\s\S]*?)\n\}/) ?? ""),
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

    // Read as (json, rust) pairs rather than "has a capital": `AccountMove`'s `reload_page` renamed to `reload` has none.
    const renamed = [...(body ?? "").matchAll(/serde\(rename = "(\w+)"\)\]\s*pub (\w+):/g)].map(
      (m) => [m[1] ?? "", m[2] ?? ""] as const,
    );
    report(
      `${payload.what}: the reader is reading renames rather than assuming them`,
      renamed.length > 0 &&
        renamed.every(([json, rust]) => hostKeys.includes(json) && (json === rust || !hostKeys.includes(rust))),
      renamed.length === 0
        ? "no rename in the struct at all"
        : `${renamed.length}: ${renamed.map(([json, rust]) => `${rust} → ${json}`).join(", ")}`,
    );

    const decl =
      capture(payload.source, new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*pub struct ${payload.struct} \\{[\\s\\S]*?\\n\\})`)) ?? "";
    const code = decl
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    check(`${payload.what}: and each field still needs its own rename`, /#\[serde\([^)]*rename_all/.test(code), false);
    check(`${payload.what}: and the struct is still serialized`, /derive\([^)]*Serialize/.test(decl), true);
  }
}

process.stdout.write("\nthe commands, declared against registered\n");

const libRs = read(`${TAURI_DIR}/src/lib.rs`);

// Both forms of the attribute: `(async)` takes arguments, and the attribute rather than the signature is the fact (`host_cp` is an async fn under a bare one).
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
check("every command the Rust declares is registered", declared.filter((c) => !registered.includes(c)), []);
check("and every command registered is declared", registered.filter((c) => !declared.includes(c)), []);
const strayCommands: string[] = [];
for (const file of readdirSync(join(ROOT, TAURI_DIR, "src"))) {
  if (file === "commands.rs" || !file.endsWith(".rs")) continue;
  if (new RegExp(COMMAND_ATTR).test(readFileSync(join(ROOT, TAURI_DIR, "src", file), "utf8"))) strayCommands.push(file);
}
check("and every command lives in commands.rs", strayCommands, []);

// The host decides which account a command is about, from the calling webview; no command takes an account, origin or scope (Q1.651).
{
  // Stripped the same way as `commandsCode` below, so the two cannot read the file differently.
  const accountCode = commandsRs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  const blocks = accountCode.split(/(?=#\[tauri::command)/).slice(1);
  const nameOf = (block: string): string => /pub (?:async )?fn ([a-z0-9_]+)/.exec(block)?.[1] ?? "?";
  const byName = new Map(blocks.map((block) => [nameOf(block), block] as const));
  const bodyOf = (name: string): string => {
    const block = byName.get(name) ?? "";
    const at = block.search(/pub (?:async )?fn /);
    const end = block.indexOf("\n}", at);
    return at < 0 || end < 0 ? "" : flat(block.slice(at, end + 2));
  };
  const blockOf = (name: string): string => flat(byName.get(name) ?? "");
  const paramsOf = (name: string): string => /pub (?:async )?fn [a-z0-9_]+\(([^)]*)\)/.exec(bodyOf(name))?.[1] ?? "";

  const SCOPED = [
    "host_account_add",
    "host_account_confirm",
    "host_account_forget",
    "host_account_switch",
    "host_accounts",
    "host_cp",
    "host_credential_clear",
    "host_credential_set",
    "host_daemon_log",
    "host_daemon_start",
    "host_daemon_state",
    "host_daemon_stop",
    "host_device_clear",
    "host_device_dh",
    "host_device_key_reset",
    "host_device_set",
    "host_local_daemon",
    "host_set_server",
  ];
  const SURFACING = ["host_copy_text", "host_open_external", "host_pick_folder", "host_save_file", "host_set_theme"];
  const BOOT = ["host_boot"];
  check(
    "every command is one kind: seat-scoped, surfacing, or the boot that issues the generation",
    declared.filter((name) => ![...SCOPED, ...SURFACING, ...BOOT].includes(name)),
    [],
  );
  check(
    "and every seat-scoped one takes the calling webview and the request its document sent",
    SCOPED.filter((name) => !/webview: tauri::Webview, request: tauri::ipc::Request<'_>/.test(paramsOf(name))),
    [],
  );
  check(
    "and resolves its account through the host, from those two alone",
    SCOPED.filter((name) => !bodyOf(name).includes("host.seat(&webview, &request)")),
    [],
  );
  check(
    "no command takes an account, an origin, a scope or a label",
    declared.filter(
      (name) => name !== "host_account_switch" && /\b(?:account|origin|scope|label|server|user|key)\s*:/.test(paramsOf(name)),
    ),
    [],
  );
  check(
    "but the switch names its target — a key from the list, or null for back",
    /\baccount: Option<String>/.test(paramsOf("host_account_switch")),
    true,
  );
  check(
    "only the boot and a confirm read a sign-in out of the keyring",
    // `credential::read` as a name rather than a call: `host_boot` passes it as a function.
    blocks.filter((block) => /credential::read(?![_a-z])/.test(block)).map(nameOf).sort(),
    ["host_account_confirm", "host_boot"],
  );
  check(
    "and what a confirm answers has no field that could carry one back",
    rustJsonKeys(capture(commandsRs, /pub struct Bound \{([\s\S]*?)\n\}/) ?? "credential: x").filter((key) =>
      /credential|token|secret|value/i.test(key),
    ),
    [],
  );
  // Every account's daemon runs from launch to quit, so an account change stops none, while removing an account stops its own (Q7.149).
  check(
    "switching, adding, binding, confirming and choosing a server stop no daemon",
    ["host_account_switch", "host_account_add", "host_account_confirm", "host_credential_set", "host_set_server"].filter(
      (name) => /supervisor|stop_all|\.stop\(\)/.test(blockOf(name)),
    ),
    [],
  );
  check(
    "while removing an account stops its own",
    [/host\.supervisor_if\(&root\)/.test(bodyOf("host_account_forget")), /supervisor\.stop\(\);/.test(bodyOf("host_account_forget"))],
    [true, true],
  );
  check(
    "a hidden account's page can neither move the screen nor put anything on it",
    ["host_account_switch", "host_account_add", ...SURFACING].filter((name) => !bodyOf(name).includes("require_shown(")),
    [],
  );
  check(
    "the add refuses at the cap",
    [
      /pub const MAX_ACCOUNTS: usize = 10;/.test(read(`${TAURI_DIR}/src/accounts.rs`)),
      /accounts::MAX_ACCOUNTS/.test(bodyOf("host_account_add")),
      /MAX_ACCOUNTS/.test(between(flat(rustCode(read(`${TAURI_DIR}/src/config.rs`))), "pub fn bind_account(", "pub fn claim_bare(")),
    ],
    [true, true, true],
  );
  // The generation binds a command to a document rather than a label; its header name is written in Rust and in `native.ts`, so they are compared (Q5.120).
  const hostCode = flat(accountCode);
  const header = capture(accountCode, /const GENERATION_HEADER: &str = "([a-z-]+)";/);
  check("the generation rides one header", header, "reemoat-generation");
  check("and the page sends that header", new RegExp(`"${header ?? "?"}"`).test(rustCode(read("packages/web/src/native.ts"))), true);
  const seatBody = between(hostCode, "fn seat(&self,", "fn boot(&self");
  check(
    "a command is refused unless its document presents the seat's generation, and never mid-rebind",
    [
      /\.get\(GENERATION_HEADER\)/.test(seatBody),
      /\(Some\(held\), Some\(sent\)\) if !seat\.rebinding && held == sent => \{ Ok\(\(label, seat\.slot\.clone\(\)\)\) \}/.test(seatBody),
      /_ => Err\(stale\(\)\),/.test(seatBody),
    ],
    [true, true, true],
  );
  check(
    "a page load retires the generation and ends a rebind",
    /pub fn page_loaded\(&self, label: &str\) \{ if let Ok\(mut seats\) = self\.seats\.lock\(\) \{ if let Some\(seat\) = seats\.get_mut\(label\) \{ seat\.generation = None; seat\.handed = false; seat\.rebinding = false; \} \} \}/.test(hostCode),
    true,
  );
  check(
    "and moving a webview to another account makes its document stale that instant",
    /pub fn move_seat\(&self, label: &str, slot: Slot\) \{ if let Ok\(mut seats\) = self\.seats\.lock\(\) \{ if let Some\(seat\) = seats\.get_mut\(label\) \{ seat\.slot = slot; seat\.generation = None; seat\.handed = false; seat\.rebinding = true; \} \} \}/.test(hostCode),
    true,
  );
  // Bare commands and `on_page_load` run on the main thread, which an account change holds `changing` across, so none may wait on it.
  const bare = blocks.filter((block) => block.startsWith("#[tauri::command]") && !/pub async fn/.test(block)).map(nameOf).sort();
  check("the main thread runs only these commands", bare, ["host_copy_text", "host_open_external"]);
  check(
    "and neither they nor a page load ever wait on an account change",
    [...bare.map(blockOf), between(hostCode, "pub fn page_loaded(", "fn seat(&self,"), flat(rustCode(libRs))].filter((code) =>
      /lock_changing|changing\.lock/.test(code),
    ).length,
    0,
  );
}

// Comments stripped before counting because `commands.rs` quotes both attribute forms; the census must exceed the bare count.
const commandsCode = commandsRs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const bareAttrs = (commandsCode.match(/#\[tauri::command\]/g) ?? []).length;
const argAttrs = (commandsCode.match(/#\[tauri::command\([^)]*\)\]/g) ?? []).length;
report(
  "the census reaches the argument form of the attribute, not only the bare one",
  argAttrs > 0 && declared.length > bareAttrs,
  `${declared.length} commands, ${argAttrs} of them declared with arguments`,
);

// A desktop-only API must sit behind a cfg naming the mobile platforms it is missing on; nothing here compiles for Android, so the list is named by hand.
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

// `PICKS_FOLDER` (a `cfg!`) and the `#[cfg]` on the function state one condition twice; a mismatch draws a control the shell refuses.
const picksFolder = /pub const PICKS_FOLDER: bool = cfg!\(([\s\S]*?)\);/.exec(commandsCode)?.[1] ?? "";
report("the folder capability is declared as a constant", picksFolder.length > 0, picksFolder);
check(
  "and the capability it announces is the condition its implementation is gated on",
  `#[cfg(${picksFolder})]`,
  MOBILE_GATE,
);
const newSession = read("packages/web/src/ui/NewSession.tsx");
check(
  "the page asks the shell what it can do rather than guessing from the platform",
  [/nativeBoot\(\)\?\.picksFolder === true/.test(newSession), /hostPlatform\(/.test(newSession), /platform === "android"/.test(newSession)],
  [true, false, false],
);

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

const bridgeRaw = read("packages/web/src/native.ts");
const bridge = rustCode(bridgeRaw);
report(
  "the bridge's code survived the comment strip",
  bridgeRaw.length > bridge.length && bridge.includes("host_boot"),
  `${String(bridgeRaw.length - bridge.length)} characters of prose removed`,
);
// Split per function so "does this call ask first" is answered inside the function making the call.
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
// The split breaks only at `function`, so an arrow wrapper is absorbed into the previous block; the literal must precede that block's first closing brace.
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
// The gate awaits `hostReady` and reads the declared capability: `nativeBoot()` is null before boot and `hostPlatform()` maps android to "other".
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
// Only an explicit `false` refuses; an unsettled (null) payload must fall back, or the local route breaks.
check(
  "while an unsettled payload falls back rather than refusing",
  [/boot === null/.test(gateBody), /inNativeShell\(\)/.test(gateBody), /\?\.canHostDaemon === true/.test(gateBody)],
  [true, true, false],
);

// A command waiting on a platform panel must be `(async)`: the panel's result arrives through the main event loop a bare command would block.
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

process.stdout.write("\nthe versions, and the six that stay six\n");

const rootManifest = json("package.json");
const rootVersion = String(rootManifest["version"]);
const confVersion = conf["version"];

// A path, not a number: a literal would be a seventh version site that `pincheck` never reads.
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
// Same major only: the CLI and the crates are released on separate lines.
check(
  "the CLI and both crates are the same major",
  [cliPin, cratePin, buildPin].map((v) => (v ?? "").split(".")[0]),
  ["2", "2", "2"],
);
const lockedTauri = capture(read(`${TAURI_DIR}/Cargo.lock`), /\nname = "tauri"\nversion = "([^"]+)"\n/);
check("Cargo.lock is committed and readable", lockedTauri !== null, true);
check("and the locked tauri is the one Cargo.toml asks for", lockedTauri, cratePin);
const tauriLines = [...cargoToml.matchAll(/^(\[[^\n]+\])\n(?:[^[\n][^\n]*\n)*?tauri = \{ version = "([^"]+)", features = \[([^\]]*)\] \}$/gm)].map(
  (m) => [m[1], m[2], m[3]],
);
check(
  "tauri's unstable feature is enabled for the macOS target alone, at the one pin",
  tauriLines,
  [
    ["[target.'cfg(target_os = \"macos\")'.dependencies]", cratePin, '"unstable"'],
    ["[dependencies]", cratePin, ""],
  ],
);
const MEASURED_TAURI = ["2.11.5", "2.11.4"];
check(
  "and the lock holds tauri and tauri-runtime-wry at the pair the multi-webview arm was built against",
  [lockedTauri, capture(read(`${TAURI_DIR}/Cargo.lock`), /\nname = "tauri-runtime-wry"\nversion = "([^"]+)"\n/)],
  MEASURED_TAURI,
);

process.stdout.write("\nwhere this package sits, and the three things that depend on it\n");

const workspace = read("pnpm-workspace.yaml");
// Excluding this package keeps Tauri off daemon hosts, keeps a Tauri bump from recreating the relay, and keeps the image building (Q4.114).
check("the root workspace excludes this package", /^\s*-\s*'!packages\/native'\s*$/m.test(workspace), true);
// pnpm finds its root by searching upwards, so this package needs its own pnpm-workspace.yaml.
const ownRoot = read(`${NATIVE}/pnpm-workspace.yaml`);
check("and this package is its own pnpm root", /^\s*-\s*'\.'\s*$/m.test(ownRoot), true);
check(
  "which lists itself and nothing else",
  [...ownRoot.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]),
  ["."],
);
check("so the root lockfile holds no importer for it", read("pnpm-lock.yaml").includes("packages/native"), false);

check("no .dockerignore line allows this package into the build context", /^!packages\/native/m.test(read(".dockerignore")), false);
check("and no Dockerfile stage copies it", read("deploy/docker/Dockerfile").includes("packages/native"), false);

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

// docscheck must skip `target`, or every build fingerprint enters its symbol corpus and stale symbols resolve.
const docscheckCode = read("scripts/docscheck.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");
const skipDir = capture(docscheckCode, /const SKIP_DIR = \/\^\(([^)]+)\)\$\//);
check("docscheck's directory skip was readable", skipDir !== null, true);
check("and it still skips this package's Rust build tree", (skipDir ?? "").split("|").includes("target"), true);
check("and `gen` is not, which is what makes gen/android reachable", (skipDir ?? "").split("|").includes("gen"), false);
const skipPath = capture(docscheckCode, /const SKIP_PATH =\s*(\/[^\n]+\/);/);
check("docscheck's path skip was readable", skipPath !== null, true);
check(
  "and it still refuses the two trees this package generates",
  ["schemas", "apple"].filter((d) => !(skipPath ?? "").includes(d)),
  [],
);
const sourceExt = capture(docscheckCode, /const SOURCE_EXT = \/\\\.\(([^)]+)\)\$\//);
check("docscheck's extension list was readable", sourceExt !== null, true);
check("and it reads Rust", (sourceExt ?? "").split("|").includes("rs"), true);
// Not `toml`: a corpus of dependency names would let a stale symbol resolve.
check("and not a manifest of dependency names", (sourceExt ?? "").split("|").includes("toml"), false);

const gitignore = read(".gitignore");
check(
  "and neither tree is tracked",
  [`${TAURI_DIR}/target/`, `${TAURI_DIR}/gen/schemas/`].filter((p) => !gitignore.includes(p)),
  [],
);

process.stdout.write("\nthe daemon this app carries, and where it is allowed to sit\n");

const STAGE = "packages/native/scripts/build-daemon.mjs";
const stage = read(STAGE);

// The runtime is a helper app in Contents/Helpers (signed as nested code, kept out of the Dock) and the JS payload a resource; never an `externalBin`.
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
// The map form: a list entry's `..` becomes a literal `_up_` segment and `daemon.rs` would find nothing.
check("the payload is a resource, by the map form", bundle["resources"], { "target/daemon/": "daemon" });
// Staged under `target/`, which docscheck's `SKIP_DIR` already skips; anywhere else a copy of src/ would enter its symbol corpus.
const stageDest = Object.keys((bundle["resources"] ?? {}) as Record<string, unknown>)[0] ?? "";
check("and it is staged under target/, which both sweeps already skip", stageDest.startsWith("target/"), true);
check("the staging script is where the config expects it", existsSync(join(ROOT, STAGE)), true);
// Staged by its own step, not `beforeBuildCommand`: `build.rs` reads the payload in every cargo build, clippy and test included.
check(
  "the root exposes a staging step",
  /"native:stage":\s*"pnpm --dir packages\/native run stage"/.test(read("package.json")),
  true,
);
const nativePkg = read(`${NATIVE}/package.json`);
check("the package defines it", /"stage":\s*"node scripts\/build-daemon\.mjs"/.test(nativePkg), true);
for (const script of ["dev", "build"] as const) {
  check(
    `\`${script}\` stages before it reaches cargo`,
    new RegExp(`"${script}":\\s*"node scripts/build-daemon\\.mjs && tauri `).test(nativePkg),
    true,
  );
}
// Never copied from the local node, which links Homebrew dylibs.
check("the runtime is fetched from nodejs.org", /const NODE_DIST = "https:\/\/nodejs\.org\/dist"/.test(stage), true);
check("and verified against the release's own manifest", /SHASUMS256\.txt/.test(stage) && /checksum mismatch/.test(stage), true);
check("the runtime cache is validated by the binary, not the directory", /existsSync\(binary\)/.test(stage), true);
check("and a directory that lost its binary is refetched", /rmSync\(extracted, \{ recursive: true, force: true \}\)/.test(stage), true);
check(
  "and it does not live where rust-cache prunes",
  /const cacheDir = join\(tauriRoot, "\.node-cache"\)/.test(stage),
  true,
);
check("and it is gitignored under its new name", /^packages\/native\/src-tauri\/\.node-cache\/$/m.test(gitignore), true);
// The cache path is written in `build-daemon.mjs` and in `check.yml`; a mismatch silently re-downloads on every run.
const checkWorkflow = read(".github/workflows/check.yml");
/** `check.yml` without comments (a whole-line `#`, or a `#` after whitespace outside quotes); named so the controls below exercise it. */
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
// The bundler copies no symlink, so the staging script's own `assertNoSymlinks` must stay.
check("the payload refuses to contain a symlink", /function assertNoSymlinks/.test(stage), true);
// The payload's `.bin/node` is a shim to the helper four levels up, never a second copy of the runtime.
check(
  "the runtime is placed once and reached by a shim",
  new RegExp(
    `for candidate in "\\$basedir/\\.\\./\\.\\./\\.\\./\\.\\./Helpers/\\$\\{RUNTIME_HELPER\\}/Contents/MacOS/node"`,
  ).test(stage) && !/cpSync\(node, join\(binDir/.test(stage),
  true,
);
// The shim ends in a refusal: a PATH lookup would find the shim itself (`.bin` is first on the daemon's PATH) and loop.
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
// The helper name is written in four files and compared here: a mismatch builds, signs and starts no daemon.
check(
  "the helper's name is one string in the config, the staging script, build.rs and daemon.rs",
  [
    capture(stageCode, /const RUNTIME_HELPER = "([^"]+)";/),
    capture(rustCode(read(`${TAURI_DIR}/build.rs`)), /const RUNTIME_HELPER: &str = "([^"]+)";/),
    capture(rustCode(read(`${TAURI_DIR}/src/daemon.rs`)), /pub const RUNTIME_HELPER: &str = "([^"]+)";/),
  ],
  [RUNTIME_HELPER, RUNTIME_HELPER, RUNTIME_HELPER],
);
// The staging step signs the helper: the bundler seals it as found, and `codesign --verify --deep` then refuses the app.
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
// `build.rs` reads the staged runtime's CPU type, since a fixed path would ship the wrong architecture; both arms are pinned.
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
// `--omit=optional` keeps the adapters' platform CLIs out of the payload (Q4.114).
check("optional dependencies are dropped from the payload", /"--omit=optional"/.test(stage), true);
// Counted per platform, so a new target without an esbuild binary fails.
const triples = [...stage.matchAll(/"([a-z0-9_]+-[a-z0-9-]+)":\s*\{\s*dir:/g)].map((m) => m[1]);
const withEsbuild = [...stage.matchAll(/esbuild:\s*"(@esbuild\/[a-z0-9-]+)"/g)].map((m) => m[1]);
check("more than one platform is described", triples.length > 1, true);
check("and every one of them names an esbuild binary", withEsbuild.length, triples.length);
// `@reemoat/protocol` is a workspace symlink the bundler cannot copy, so its manifest and src are copied as a real directory; without them the shipped daemon dies at start.
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
// Value imports only: `import type` is erased and requires nothing at runtime.
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
check(
  "the staged runtime is gitignored",
  /^packages\/native\/src-tauri\/binaries\/$/m.test(read(".gitignore")) &&
    /^packages\/native\/src-tauri\/target\/$/m.test(read(".gitignore")),
  true,
);

process.stdout.write("\nwhat shipping this would take, and what is switched off until then\n");

check("the identifier is not Tauri's placeholder", conf["identifier"] !== "com.tauri.dev", true);
// No `dmg` by default: `bundle_dmg.sh` drives Finder over AppleScript and times out wherever nobody is logged in.
check(
  "the disk image is not bundled by default",
  ((bundle["targets"] ?? []) as string[]).includes("dmg"),
  false,
);
check("but an app bundle is", ((bundle["targets"] ?? []) as string[]).includes("app"), true);
// Tauri merges `tauri.<platform>.conf.json` over the base (RFC 7386, read by cargo too), so an overlay may set only `OVERLAY_KEYS`.
process.stdout.write("\nthe platform overlays, and what one may say\n");
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
// No macOS overlay: the base file is the macOS shape.
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
  const overlayBundle = (overlay["bundle"] ?? {}) as Record<string, unknown>;
  check(`and ${name} carries no daemon payload`, [overlayBundle["externalBin"], overlayBundle["resources"]], [
    null,
    null,
  ]);
  check(`and ${name} never asks for a disk image`, ((overlayBundle["targets"] ?? []) as string[]).includes("dmg"), false);
}
check(
  "the desktop overlays name their bundler and the mobile ones name none",
  overlays.map((name) => ((json(`${TAURI_DIR}/${name}`)["bundle"] as Record<string, unknown>)["targets"] ?? null)),
  [null, null, ["deb", "appimage"], ["nsis"]],
);
check(
  "the Windows refusal in build-daemon.mjs names a file that is there",
  /tauri\.windows\.conf\.json removes externalBin/.test(stageCode) &&
    overlays.includes("tauri.windows.conf.json"),
  true,
);
const mac = (bundle["macOS"] ?? {}) as Record<string, unknown>;
check("the hardened runtime is on", mac["hardenedRuntime"], true);
check("an entitlements file is named", typeof mac["entitlements"], "string");
check("and it exists", existsSync(join(ROOT, TAURI_DIR, String(mac["entitlements"]))), true);
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
// `get-task-allow` would let another process attach a debugger to the daemon; Node ships it and it must never be copied.
check(
  "and never the debug entitlement Node ships with",
  read(`${TAURI_DIR}/entitlements-node.plist`).includes("get-task-allow</key>"),
  false,
);
// No plist comment may hold a double hyphen: `plutil` accepts it but codesign refuses the file.
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
// 13.0 because `SMAppService`, the opt-in login item macOS removes with the app, needs it.
check("the macOS floor is where the opt-in service starts", mac["minimumSystemVersion"], "13.0");
// No signing identity in the repository: signing is driven by the `APPLE_*` environment variables.
check("no signing identity is committed", mac["signingIdentity"], null);
check("and no notarization provider is either", mac["providerShortName"], null);

// `REEMOAT_DEFAULT_SERVER` is compiled in by `option_env!` and set by no file here; `release.yml` forwards a repository variable (Q4.127).
const configRs = flat(read(`${TAURI_DIR}/src/config.rs`));
check(
  "the default server comes from the environment at compile time",
  /option_env!\("REEMOAT_DEFAULT_SERVER"\)/.test(configRs),
  true,
);
check("and nothing hard-codes one beside it", /const DEFAULT_SERVER: Option<&str> = Some\(/.test(configRs), false);
// One normalizer, or a suggested and a typed server become two credential keys.
check("the suggestion goes through the one normalizer", /normalize_origin\(DEFAULT_SERVER\?\)/.test(configRs), true);
check(
  "cargo is told to notice the variable changing",
  /cargo:rerun-if-env-changed=REEMOAT_DEFAULT_SERVER/.test(read(`${TAURI_DIR}/build.rs`)),
  true,
);
const shellRs = flat(read(`${TAURI_DIR}/src/lib.rs`));
check("the first-run seat reads the chosen server", /config::read_server\(&dir\)/.test(shellRs), true);
check("and every account, through the one reader", /config::read_accounts\(&dir, &\|origin\| credential::read\(origin\)\.is_some\(\)\);/.test(shellRs), true);
const startupCode = ["lib", "seats"].map((file) => flat(rustCode(read(`${TAURI_DIR}/src/${file}.rs`)))).join("\n");
check(
  "and never writes one at startup",
  /read_or_seed_server|write_server|write_stored|config::(?:bind|show|forget|rename)_account|\bset_bound\(|\bset_signed_in\(|materialize_accounts|set_legacy_root_holder|claim_bare/.test(startupCode),
  false,
);
{
  const configCode = flat(rustCode(read(`${TAURI_DIR}/src/config.rs`)));
  const reader = between(configCode, "pub fn read_accounts(", "pub fn materialize_accounts(");
  check("the account reader was found to read", reader.length > 0, true);
  check("and it writes nothing — the derivation included", /write_stored|fs::write|fs::rename|accounts_mut/.test(reader), false);
}
check("the suggestion is its own function", /pub fn default_server\(\) -> Option<String>/.test(configRs), true);
check("and it writes nothing", /fn default_server[\s\S]{0,200}write_server/.test(configRs), false);
const commandsSrc = flat(read(`${TAURI_DIR}/src/commands.rs`));
check("the suggestion crosses the bridge under its own name", /rename = "defaultServer"/.test(commandsSrc), true);
check("and the chosen server is still a separate field", /pub server: Option<String>/.test(commandsSrc), true);
// This file is exempt from the sweep because its own fixtures are setters.
const FORWARD = "REEMOAT_DEFAULT_SERVER: ${{ vars.REEMOAT_DEFAULT_SERVER }}";
const RELEASE_YML = ".github/workflows/release.yml";
const isSetter = (file: string, line: string): boolean =>
  /REEMOAT_DEFAULT_SERVER\s*[=:]\s*\S/.test(line) && !(file === RELEASE_YML && line.trim() === FORWARD);
check(
  "the one line allowed is the forward, verbatim, in release.yml — and every other way of setting it is a setter",
  [
    isSetter(RELEASE_YML, `          ${FORWARD}`),
    isSetter(".github/workflows/check.yml", `          ${FORWARD}`),
    isSetter(RELEASE_YML, "          REEMOAT_DEFAULT_SERVER: https://app.example"),
    isSetter(RELEASE_YML, "          REEMOAT_DEFAULT_SERVER: ${{ secrets.REEMOAT_DEFAULT_SERVER }}"),
    isSetter(RELEASE_YML, "          REEMOAT_DEFAULT_SERVER: ${{ vars.REEMOAT_DEFAULT_SERVER || 'https://app.example' }}"),
    isSetter("deploy/ci-release.sh", "export REEMOAT_DEFAULT_SERVER=https://app.example"),
    isSetter(`${TAURI_DIR}/build.rs`, '    println!("cargo:rustc-env=REEMOAT_DEFAULT_SERVER=https://app.example");'),
    isSetter(`${NATIVE}/scripts/build-frontend.mjs`, 'process.env.REEMOAT_DEFAULT_SERVER = "https://app.example";'),
    isSetter(`${TAURI_DIR}/build.rs`, '    println!("cargo:rerun-if-env-changed=REEMOAT_DEFAULT_SERVER");'),
  ],
  [false, true, true, true, true, true, true, true, false],
);
const sweptFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter((file) => file.length > 0 && !file.endsWith(".md") && file !== "scripts/nativecheck.ts")
  .filter((file) => existsSync(join(ROOT, file)) && statSync(join(ROOT, file)).isFile());
const setters: string[] = [];
for (const file of sweptFiles) {
  read(file)
    .split("\n")
    .forEach((line, index) => {
      if (isSetter(file, line)) setters.push(`${file}:${index + 1}`);
    });
}
report("the sweep reads every tracked file that is not prose", sweptFiles.length > 100, `${sweptFiles.length} files`);
check(
  "including every place a build could be handed one",
  [
    "package.json",
    `${NATIVE}/package.json`,
    `${TAURI_DIR}/tauri.conf.json`,
    `${TAURI_DIR}/build.rs`,
    `${NATIVE}/scripts/build-daemon.mjs`,
    "deploy/ci-release.sh",
    ".github/workflows/check.yml",
    RELEASE_YML,
  ].filter((file) => !sweptFiles.includes(file)),
  [],
);
check("and no file in this repository gives it a value; the one forward of a repository variable is not one", setters, []);
{
  const release = read(RELEASE_YML);
  const lines = release.slice(release.indexOf("\njobs:\n")).split("\n");
  const forwards: string[] = [];
  const readers = new Set<string>();
  let job = "";
  for (const line of lines) {
    const head = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (head) job = head[1] ?? "";
    if (line.trim() === FORWARD) forwards.push(job);
    if (line.includes("vars.REEMOAT_DEFAULT_SERVER")) readers.add(job);
  }
  check("release.yml forwards the repository variable to both app jobs and nowhere else", forwards, ["app", "app-android"]);
  check("and no other job reads the variable at all", [...readers].sort(), ["app", "app-android"]);
}

// `write_stored` is the single writer of server.json, which can hold the device key in plaintext, so its mode is asserted here as well as by `cargo test`.
const writeStored = between(configRs, "fn write_stored(", "pub fn read_device(");
check("the writer behind the fallback was found to read", writeStored.length > 0, true);
// Mode set at creation; a `set_permissions` afterwards leaves a race.
check("the file is created with an explicit 0600", /options\.mode\(0o600\);/.test(writeStored), true);
check("and through OpenOptions rather than fs::write", /fs::OpenOptions::new\(\)/.test(writeStored), true);
check("and fs::write appears nowhere in it", /fs::write\(/.test(writeStored), false);
check(
  "and narrowed again on the handle, against a umask with owner bits",
  /file\.set_permissions\(fs::Permissions::from_mode\(0o600\)\)/.test(writeStored),
  true,
);
check(
  "and the directory is narrowed on every write",
  /fs::set_permissions\(dir, fs::Permissions::from_mode\(0o700\)\)/.test(writeStored),
  true,
);
// A rename onto a fresh inode narrows files earlier builds created at 0644.
check("and the narrowed file replaces the old inode by rename", /fs::rename\(&tmp, &target\)/.test(writeStored), true);

const keyFallback = between(configRs, "pub fn write_device_key_fallback(", "pub fn erase_device_key_fallback(");
check("the fallback writer was found to read", keyFallback.length > 0, true);
check("a device key is written through that one writer", /write_stored\(dir, &stored\)/.test(keyFallback), true);
check("and never by a writer of its own", /fs::(write|OpenOptions|File)/.test(keyFallback), false);

// `read_stored`'s arms in source order, each with what it authorizes; read comment-stripped because config.rs states each rule in prose.
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
  "ErrorKind::NotFound => true",
  "ErrorKind::IsADirectory => true",
  // Not UTF-8: no errno and never transient, so it is quarantined rather than frozen.
  "ErrorKind::InvalidData => quarantine(dir)",
  // A read failure with an errno says nothing about the bytes: neither moved nor replaced.
  "Err(_) => false",
  "Ok(parsed) => true",
  "Err(_) => quarantine(dir)",
]);
// A failed quarantine must not authorize the overwrite.
check("the quarantine answers whether the bytes are actually aside", /fn quarantine\(dir: &Path\) -> bool/.test(configCode), true);
check("and its rename is read rather than discarded", /let _ = fs::rename\(/.test(configCode), false);
// The lookbehind keeps `discard_quarantine(dir);` from matching.
check("and no caller drops that answer on the floor", /(?<!\w)quarantine\(dir\);/.test(configCode), false);
// A keyring promotion (`erase_device_key_fallback`) must reach no quarantine; only a re-key (`give_up_device_key`) discards it, after the write lands.
const eraseKey = between(configCode, "pub fn erase_device_key_fallback(", "pub fn give_up_device_key(");
check("the statement a promotion reaches was found to read", eraseKey.length > 0, true);
check("promoting a key to the keyring rewrites server.json and nothing else", /discard_quarantine/.test(eraseKey), false);
const giveUp = between(configCode, "pub fn give_up_device_key(", "pub fn normalize_origin(");
check("the statement a re-key reaches was found to read", giveUp.length > 0, true);
check(
  "giving up a file-held key drops the copy it supersedes, after the write that landed",
  /erase_device_key_fallback\(dir, scope\)\?; discard_quarantine\(dir, scope\); Ok\(\(\)\)/.test(giveUp),
  true,
);
// Guarded by a read of the bytes in the same statement, so re-keying one server never deletes another's recoverable key.
check(
  "and the removal is guarded by what those bytes name, in the same statement",
  /fn discard_quarantine\(dir: &Path, scope: &str\) \{ if !quarantine_is_only_about\(dir, scope\) \{ return; \} let _ = fs::remove_file\(unreadable_file\(dir\)\); \}/.test(
    configCode,
  ),
  true,
);
check(
  "and no other statement in the module reaches for it",
  configCode.replace(giveUp, "").split("discard_quarantine(").length - 1,
  1,
);
const deviceCode = flat(
  read(`${TAURI_DIR}/src/device.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
const resetKey = between(deviceCode, "pub fn reset_key(", "pub fn diffie_hellman(");
check("the re-key was found to read", resetKey.length > 0, true);
check("a re-key gives up the quarantined copy too", /config::give_up_device_key\(dir, scope\)/.test(resetKey), true);
const storeSecret = between(deviceCode, "fn store_secret(", "pub fn ensure_key(");
check("the promotion was found to read", storeSecret.length > 0, true);
check("and a promotion takes the other door", /config::erase_device_key_fallback\(dir, scope\)/.test(storeSecret), true);
check("and only that one", /give_up_device_key/.test(storeSecret), false);


// Adopting a server keeps the previous origin's credential (Q7.148) and never erases its device id.
const setServer = flat(read(`${TAURI_DIR}/src/commands.rs`));
const setServerBody = between(setServer, "pub fn host_set_server(", "pub async fn host_credential_set(");
check("the sweep can see host_set_server at all", setServerBody.length > 0, true);
check("adopting a server keeps the previous one's sign-in", /credential::erase/.test(setServerBody), false);
check("and never the device recorded for it", /erase_device/.test(setServerBody), false);
// Only a pending seat's server moves: an account is its origin and user id (Q3.643).
const setServerCode = between(
  flat(rustCode(read(`${TAURI_DIR}/src/commands.rs`))),
  "pub fn host_set_server(",
  "pub async fn host_credential_set(",
);
check(
  "and only a pending seat's server moves",
  /let Slot::Pending \{ origin: held \} = slot else \{ return Err\(pending_seat\(/.test(setServerCode),
  true,
);
check("and it touches no credential", /credential::/.test(setServerCode), false);
check(
  "and server.json is written only on a first run, with no account at all",
  /if host\.roster\(\)\.accounts\.is_empty\(\) \{ config::write_server\(&host\.config_dir, &origin\)\?; \}/.test(setServerCode),
  true,
);
// A switch stops no daemon: one supervisor per server lets the other fleet's turns go on (Q7.148).
check("and leaves the previous server's daemon running", /supervisor|stop_all|\.stop\(\)/.test(setServerBody), false);

// Each account gets its own state root and supervisor, and daemon commands resolve the root from the calling webview's account (Q7.148, Q7.149).
{
  const commandsRs = read(`${TAURI_DIR}/src/commands.rs`);
  check(
    "the host keeps a supervisor per state root, each behind a lock of its own",
    /pub supervisors: Mutex<BTreeMap<String, Arc<Mutex<daemon::Supervisor>>>>/.test(commandsRs),
    true,
  );
  check("and the one-slot field is gone", /pub supervisor: Mutex</.test(commandsRs), false);
  check("and so is the one current server", /pub server: Mutex</.test(commandsRs), false);
  const flatCommands = flat(rustCode(commandsRs));
  const ROOT_CALL = /slot\.root\(&home, host\.holder\(\)\.as_deref\(\)\)/;
  const bodies: [string, string, RegExp][] = [
    ["host_daemon_state", "pub fn host_daemon_start", ROOT_CALL],
    ["host_daemon_start", "pub fn host_daemon_stop", ROOT_CALL],
    ["host_daemon_stop", "pub fn host_daemon_log", /host\.supervisor_if\(&root\)/],
    ["host_daemon_log", "fn write_private", /host\.supervisor_if\(&root\)/],
    [
      "host_local_daemon",
      "pub fn host_set_server",
      /daemon::announce_roots\(&home, own\.as_ref\(\)\.map\(\|root\| root\.dir\.as_path\(\)\), !guest\)/,
    ],
  ];
  check(
    "and every command about the daemon here asks which root this account has",
    bodies.filter(([name, next, pattern]) => !pattern.test(between(flatCommands, `pub fn ${name}`, next))),
    [],
  );
  const start = between(flatCommands, "pub fn host_daemon_start", "pub fn host_daemon_stop");
  const locked = start.indexOf("let _roots = daemon::lock_roots();");
  check(
    "a start holds the root lock from the root's choice through the spawn",
    [locked > 0, locked < start.indexOf("slot.root("), locked < start.indexOf(".start(&payload")],
    [true, true, true],
  );
  check(
    "and records which origin was handed the empty legacy root before writing into it",
    start.indexOf("config::set_legacy_root_holder(&host.config_dir, &origin)?;") > 0 &&
      start.indexOf("config::set_legacy_root_holder(") < start.indexOf("write_private(&env_file"),
    true,
  );
  check(
    "none of them reads a home as if it were a root",
    /local::read\(&home\)|config_state\(&home/.test(flatCommands),
    false,
  );

  // Three root arms: a pending seat none, a legacy seat and its server's owner the server's own, every other account `servers/<server>@<user id>` (Q7.149).
  const accountsCode = flat(rustCode(read(`${TAURI_DIR}/src/accounts.rs`)));
  check(
    "a legacy seat and its server's owner share the server's own root",
    /Slot::Legacy \{ origin \} \| Slot::Account \{ origin, owner: true,\.\.\} => Some\(daemon::owner_root\(home, origin, holder\)\)/.test(accountsCode),
    true,
  );
  check(
    "and every other account has a root of its own",
    /Slot::Account \{ origin, user, owner: false,? \} => Some\(daemon::guest_root\(home, origin, user\)\)/.test(accountsCode),
    true,
  );
  check("and a pending seat has none", /Slot::Pending \{\.\.\} => None, Slot::Legacy/.test(accountsCode), true);
  // The module above its tests: they write `machine.json` by hand, as fixtures.
  const daemonSource = read(`${TAURI_DIR}/src/daemon.rs`);
  const daemonCode = flat(rustCode(daemonSource.slice(0, daemonSource.indexOf("#[cfg(test)]\nmod tests"))));
  const guest = between(daemonCode, "pub fn guest_root(", "pub fn announce_roots(");
  check(
    "a guest's root is named <server>@<user id> and is never the legacy one",
    [/format!\("\{\}@\{user\}", server_slug\(origin\)\)/.test(guest), /legacy: false,/.test(guest)],
    [true, true],
  );
  check(
    "a user id may carry neither a scope's # nor a guest root's @",
    /\.all\(\|b\| b\.is_ascii_alphanumeric\(\) \|\| b == b'_' \|\| b == b'-'\)/.test(between(accountsCode, "pub fn is_user_id(", "pub fn clamp_name(")),
    true,
  );
  check(
    "and a guest is answered its own announcement alone",
    /\} else if include_legacy \{ vec!\[own\.to_path_buf\(\), legacy\] \} else \{ vec!\[own\.to_path_buf\(\)\] \}/.test(
      between(daemonCode, "pub fn announce_roots(", "static ROOT_LOCK"),
    ),
    true,
  );
  check(
    "claims are written one at a time, and by rename rather than truncation",
    [
      /static CLAIM_LOCK: std::sync::Mutex<\(\)>/.test(daemonCode),
      /pub fn write_claim\(dir: &Path, scope: &str, machine_id: &str\) -> Result<\(\), String> \{ let _held = CLAIM_LOCK\.lock\(\)/.test(daemonCode),
      /pub fn move_claim\(dir: &Path, from: &str, to: &str\) -> Result<\(\), String> \{ let _held = CLAIM_LOCK\.lock\(\)/.test(daemonCode),
      /std::fs::write\(claim_file/.test(daemonCode),
      /crate::config::temp_name\("machine\.json"\)/.test(daemonCode),
    ],
    [true, true, true, false, true],
  );
  check(
    "and every account's daemon is started at launch under the root lock, adopting only",
    [
      /pub fn start_configured_at_launch\(/.test(daemonCode),
      /let _held = lock_roots\(\); if config_state\(&root\.dir, Some\(origin\)\) != CONFIG_HERE \{ continue; \}/.test(
        between(daemonCode, "pub fn start_configured_at_launch(", "pub fn ensure_root("),
      ),
      /enroll|write_claim|env_rewritten|env_contents/.test(between(daemonCode, "pub fn start_configured_at_launch(", "pub fn ensure_root(")),
    ],
    [true, true, false],
  );
  const copiers = readdirSync(join(ROOT, TAURI_DIR, "src"))
    .filter((file) => file.endsWith(".rs") && file !== "device.rs")
    .filter((file) => /copy_key\(/.test(rustCode(read(`${TAURI_DIR}/src/${file}`))));
  check("a device key is copied from one place", copiers, ["accounts.rs"]);
  check(
    "and only where the device was proved this account's",
    /if claimed\.device && matches!\(device::copy_key\(origin, scope\), Ok\(true\)\) \{ let _ = credential::erase_device_key\(origin\); \}/.test(accountsCode),
    true,
  );
}

// `seats.rs` builds every webview from `main`'s config with `on_navigation(is_our_own)`; any other builder loses the drop setting and the navigation guard.
{
  const seatsCode = flat(rustCode(read(`${TAURI_DIR}/src/seats.rs`)));
  check(
    "every account's child webview is main's configuration, guarded",
    /tauri::webview::WebviewBuilder::from_config\(&seat\)\.on_navigation\(is_our_own\)\.auto_resize\(\)/.test(seatsCode),
    true,
  );
  check(
    "and so is the one window of the single-webview arm",
    /tauri::WebviewWindowBuilder::from_config\(app, config\)\?\.on_navigation\(is_our_own\)\.build\(\)\?;/.test(seatsCode),
    true,
  );
  const sources = readdirSync(join(ROOT, TAURI_DIR, "src")).filter((file) => file.endsWith(".rs"));
  const codeOf = (file: string): string => flat(rustCode(read(`${TAURI_DIR}/src/${file}`)));
  check(
    "no webview anywhere is built any other way, nor handed a script",
    sources.filter((file) => /WebviewBuilder::new\(|Webview::builder\(|WebviewWindowBuilder::new\(|\.initialization_script\(/.test(codeOf(file))),
    [],
  );
  check(
    "and nothing but seats.rs builds, adds or configures one",
    sources.filter((file) => /(?:WebviewWindowBuilder|WebviewBuilder|WindowBuilder)::from_config\(|\.add_child\(/.test(codeOf(file))),
    ["seats.rs"],
  );
  check(
    "one window, a webview per account — on macOS, by one constant",
    /#\[cfg\(target_os = "macos"\)\] pub const MULTI_WEBVIEW: bool = true;/.test(seatsCode),
    true,
  );
  // Hide before show: a platform that packs children would otherwise draw two half-height pages.
  const present = between(seatsCode, "fn present(", "fn close(");
  check(
    "a switch hides every other account before it shows one",
    present.indexOf("webview.hide()") > 0 && present.indexOf("webview.hide()") < present.indexOf("target.show()"),
    true,
  );
  // `seats.rs` holds no lock: webview calls wait on the main thread, which takes `seats` for every page load.
  check("and the file that makes every webview call holds no lock across one", /\.lock\(\)/.test(seatsCode), false);
  // `Webview::close` alone leaves the page running, so WebKit's `_close` is queued first.
  const close = between(seatsCode, "fn close(", "fn end_page(");
  check(
    "a closed account's page is ended before its webview is closed",
    close.indexOf("end_page(&webview);") > 0 && close.indexOf("end_page(&webview);") < close.indexOf("webview.close()"),
    true,
  );
  check(
    "by WebKit's own teardown, asked for rather than assumed",
    /respondsToSelector: sel!\(_close\)\]; if answers\.as_bool\(\) \{ let _: \(\) = msg_send!\[view, _close\];/.test(seatsCode),
    true,
  );

  const libCodeFlat = flat(rustCode(libRs));
  check(
    "a page load retires its document's generation",
    [
      /\.on_page_load\(\|webview, payload\| \{ if matches!\(payload\.event\(\), tauri::webview::PageLoadEvent::Started\) \{/.test(libCodeFlat),
      /host\.page_loaded\(webview\.label\(\)\);/.test(libCodeFlat),
    ],
    [true, true],
  );
  check(
    "and the launch opens every account and starts every set-up daemon, off the main thread",
    [
      /seats::open_at_launch\(app, &config, &roster, server\)\?;/.test(libCodeFlat),
      /std::thread::spawn\(move \|\| \{[\s\S]*?daemon::start_configured_at_launch\(/.test(libCodeFlat),
      /WebviewWindowBuilder|WebviewBuilder/.test(libCodeFlat),
    ],
    [true, true, false],
  );
}

// `host_cp` sends a credential only to the seat's own server, and only for an account (Q5.116, Q5.120).
{
  const cp = between(flat(rustCode(commandsRs)), "pub async fn host_cp(", "pub fn host_copy_text(");
  check("the control-plane leg was found to read", cp.length > 0, true);
  check(
    "a server being tried is sent no credential",
    /Some\(candidate\) => \{ if proxy::carries_credential\(&req\.headers\) \{ return Err\(/.test(cp),
    true,
  );
  check(
    "and neither is a sign-in with no account",
    /None => \{ if matches!\(slot, Slot::Pending \{\.\.\}\) && proxy::carries_credential\(&req\.headers\) \{ return Err\(pending_seat\(/.test(cp),
    true,
  );
  check("and every other call goes to the seat's own server", [/slot\.origin\(\)/.test(cp), /host\.origin\(/.test(cp)], [true, false]);
  check(
    "the refusal folds a header name the way the proxy forwards it",
    /pub fn carries_credential\(headers: &\[\(String, String\)\]\) -> bool \{ headers\.iter\(\)\.any\(\|\(name, _\)\| name\.eq_ignore_ascii_case\("authorization"\)\) \}/.test(
      flat(rustCode(read(`${TAURI_DIR}/src/proxy.rs`))),
    ),
    true,
  );
  // Quarantine keys are per `<origin>#<user id>`; the bare origin counts only for an inherited device.
  const configFlat = flat(rustCode(read(`${TAURI_DIR}/src/config.rs`)));
  const scan = between(configFlat, "fn quarantine_is_only_about(dir: &Path, scope: &str) -> bool {", "fn is_scheme_byte(");
  check(
    "the quarantine a Re-key discards is read per account",
    [/if end < bytes\.len\(\) && bytes\[end\] == b'#'/.test(scan), /account\.key\(\) == scope && account\.inherited/.test(scan)],
    [true, true],
  );
}

const daemonSrc = flat(
  read(`${TAURI_DIR}/src/daemon.rs`)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""),
);
check("the daemon's PATH is joined with the platform's separator", /std::env::join_paths\(/.test(daemonSrc), true);
check("and never with a POSIX literal", /parts\.join\(":"\)/.test(daemonSrc), false);
check("and the user's own PATH is split the same way", /std::env::split_paths\(/.test(daemonSrc), true);
check("Homebrew is named once, on the platform it was measured on", (daemonSrc.match(/\/opt\/homebrew\/bin/g) ?? []).length, 1);
check("and no fallback names Linuxbrew", /linuxbrew/i.test(daemonSrc), false);
// Unix only by decision: Git Bash and MSYS2 set `SHELL` to a shell that knows nothing of the Windows PATH.
check("the login-shell probe refuses where it cannot mean anything", /if !cfg!\(unix\) \{/.test(daemonSrc), true);
// No updater until a keypair exists: a build shipped with no public key can never be updated in place.
check("no updater artifacts are produced", bundle["createUpdaterArtifacts"], false);
check("and no updater is configured", Object.hasOwn((conf["plugins"] ?? {}) as object, "updater"), false);
check("the licence travels with the bundle", typeof bundle["licenseFile"], "string");
check(
  "and it is this repository's own",
  resolve(ROOT, TAURI_DIR, String(bundle["licenseFile"])),
  resolve(ROOT, "LICENSE"),
);
check("an iOS floor is decided rather than defaulted", typeof ((bundle["iOS"] ?? {}) as Record<string, unknown>)["minimumSystemVersion"], "string");
check("and an Android one", typeof ((bundle["android"] ?? {}) as Record<string, unknown>)["minSdkVersion"], "number");
check("no Apple development team is committed", ((bundle["iOS"] ?? {}) as Record<string, unknown>)["developmentTeam"], null);
// `keyring` v1 has no mobile store and fails only at run time: Android uses `android-native-keyring-store`, iOS is a `compile_error!` until its arm is written.
const credentialRs = read(`${TAURI_DIR}/src/credential.rs`);
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
const cargoCode = cargoToml
  .split("\n")
  .map((line) => line.replace(/#.*$/, ""))
  .join("\n");
check("the manifest's code survived the comment strip", cargoToml.length > cargoCode.length, true);
check(
  "the Android store is named in the manifest, and keyring is kept off that target",
  [
    /^android-native-keyring-store = /m.test(cargoCode),
    /\[target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies\]/.test(cargoToml),
  ],
  [true, true],
);
// No `openssl`: on Android `reqwest` resolves to rustls with the platform verifier.
check("and no vendored OpenSSL, which the Android tree does not use", /openssl/.test(cargoCode), false);
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

// gen/android is committed but regenerated by `tauri android init`, and no compiler here sees a JNI or manifest mismatch, so it is read as text.

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
check("the Gradle script's code survived the comment strip", gradleKts.length > gradleCode.length, true);
check(
  "and the keep file's did, without taking the rule with it",
  proguard.length > proguardCode.length && proguardCode.trim().length > 0,
  true,
);

const KOTLIN_MAIN = `${ANDROID_DIR}/app/src/main/java/com/reemoat/app/MainActivity.kt`;
const activityRaw = read(KOTLIN_MAIN);
const activity = kotlinCode(activityRaw);
check("the activity's code survived the comment strip", activityRaw.length > activity.length, true);

const kotlinPackage = capture(activity, /^package ([A-Za-z_][\w.]*)\s*$/m);
const kotlinClass = capture(activity, /^class (\w+)\s*:/m);
check("the activity names a package", kotlinPackage !== null, true);
check("and a class", kotlinClass !== null, true);
// `tauri android init` writes by directory, so the file must sit where its package says.
check(
  "and the file sits in the directory that package names",
  KOTLIN_MAIN,
  `${ANDROID_DIR}/app/src/main/java/${(kotlinPackage ?? "").split(".").join("/")}/${kotlinClass}.kt`,
);

/** The symbol the JVM looks for, by JNI mangling (an inner `_` becomes `_1`); overloaded methods and `$` are not handled. */
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
// Every type an `external fun` signature names must be imported: nothing here compiles Kotlin, and init drops `Context`.
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

/** Every `Java_` export in src/, tolerant of attribute lists and of both the "system" and "C" ABIs. */
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
// A `fn Java_…` that lost its `extern` shows up here, so the failure does not read as a Kotlin mistake.
check("and no Java_ function in this crate is one the census could not see", looseSymbols.sort(), exportedSymbols);
// Each export needs `no_mangle` (or the JVM finds nothing) and the android cfg (desktop has no `jni`).
check("and each of them is unmangled and Android-only", unexported, []);

const loadedLibrary = capture(activity, /System\.loadLibrary\("(\w+)"\)/);
check("the activity loads a library by name", loadedLibrary !== null, true);
check("and it is the one this crate's [lib] produces", capture(cargoCode, /^\[lib\]\s*\nname = "(\w+)"/m), loadedLibrary);
check(
  "which is built as a shared object Android can load",
  (capture(cargoCode, /crate-type = \[([^\]]*)\]/) ?? "").includes(`"cdylib"`),
  true,
);

// Tauri overrides `handleBackNavigation` to false, which makes Back finish the activity; it is set true exactly once.
check(
  "the activity takes back navigation back from Tauri's override",
  /override val handleBackNavigation: Boolean = true/.test(activity),
  true,
);
check("and the property is written down exactly once, in code", (activity.match(/handleBackNavigation/g) ?? []).length, 1);
check(
  "the identifier, both Gradle names and the Kotlin package are one string",
  [
    conf["identifier"],
    capture(gradleCode, /^\s*namespace = "([\w.]+)"\s*$/m),
    capture(gradleCode, /^\s*applicationId = "([\w.]+)"\s*$/m),
  ],
  [kotlinPackage, kotlinPackage, kotlinPackage],
);

// Auto Backup and `adb backup` would copy server.json, which can hold the device private key, off the phone; the three attributes cover different API levels.
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
const rulesName = capture(application, /android:dataExtractionRules="@xml\/(\w+)"/) ?? "";
const rulesPath = `${ANDROID_DIR}/app/src/main/res/xml/${rulesName}.xml`;
check("the rules the manifest names are a file that is there", existsSync(join(ROOT, rulesPath)), true);
const rulesXml = existsSync(join(ROOT, rulesPath)) ? read(rulesPath) : "";
const rules = xmlCode(rulesXml);
check("the rules' markup survived the comment strip", rulesXml.length > rules.length, true);
// Each channel read from its own element: a file-wide `domain="root"` passes with one exclusion deleted.
for (const channel of ["cloud-backup", "device-transfer"] as const) {
  const section = between(rules, `<${channel}>`, `</${channel}>`);
  check(`${channel} was found to read`, section.length > 0, true);
  check(`and ${channel} excludes the whole app-private tree`, /<exclude\s+domain="root"\s*\/>/.test(section), true);
}
// The FileProvider must stay unexported, asserted inside its element since the activity is legitimately exported.
const provider = /<provider\b[\s\S]*?>/.exec(manifest)?.[0] ?? "";
check("there is exactly one provider to check", (manifest.match(/<provider\b/g) ?? []).length, 1);
check(
  "and the file provider is unexported in the element that names it",
  [/android:name="androidx\.core\.content\.FileProvider"/.test(provider), /android:exported="false"/.test(provider)],
  [true, true],
);
// Read from the release block: the debug block legitimately sets `isDebuggable`.
const releaseBuild = between(gradleCode, `getByName("release") {`, "kotlinOptions {");
check("the release build type was found to read", releaseBuild.length > 0, true);
check(
  "a release minifies and is not debuggable",
  [/isMinifyEnabled = true/.test(releaseBuild), /isDebuggable/.test(releaseBuild), /isJniDebuggable/.test(releaseBuild)],
  [true, false, false],
);
// `enableV1Signing` beside v2: some OEM installers refuse a v2-only APK.
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

// Android TLS needs the verifier init in the JNI entry, the Kotlin `.aar` in Gradle and an R8 keep rule; asserted as one line since each alone is silent.
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
// Exactly one copy in the lock: two versions would initialise one global while reqwest reads the other.
for (const crate of ["rustls-platform-verifier", "rustls-platform-verifier-android"] as const) {
  check(
    `the tree resolves exactly one ${crate}`,
    (cargoLock.match(new RegExp(`^name = "${crate}"$`, "gm")) ?? []).length,
    1,
  );
}
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

check(
  "nothing in the JNI entry point can end the process, and a null is refused before either half",
  [
    (jniEntry.match(/catch_unwind/g) ?? []).length,
    /raw_env\.is_null\(\) \|\| raw_context\.is_null\(\)/.test(jniEntry),
  ],
  [2, true],
);
// Two `catch_unwind` guards: a panic out of `extern "system"` aborts, and the keyring init must not stop the TLS init.
check(
  "and the two halves are guarded independently rather than together",
  (between(credentialCode, "fn Java_com_reemoat_app_MainActivity_initNdkContext(", "fn adopt_context").match(
    /catch_unwind/g,
  ) ?? []).length,
  2,
);
// The store caches only its success: a probe before the context was adopted must not stick.
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
const loadAt = activity.indexOf("System.loadLibrary");
const adoptAt = activity.indexOf("initNdkContext(applicationContext)");
const tauriAt = activity.indexOf("super.onCreate");
check(
  "the library loads, then the context is adopted, then Tauri starts",
  [loadAt >= 0, adoptAt > loadAt, tauriAt > adoptAt],
  [true, true, true],
);
// The renamed `jni` tracks the verifier's major (0.22); tauri and the keyring store stay on 0.21.
const renamedJni = capture(cargoToml, /^jni22 = \{ package = "jni", version = "([0-9.]+)"/m) ?? "";
check(
  "the renamed jni is a 0.22, which is the major the verifier's API is written against",
  renamedJni.startsWith("0.22"),
  true,
);
// `gradlew` fetches and executes the distribution, so it is pinned by version and hash together.
const wrapperProps = read(`${ANDROID_DIR}/gradle/wrapper/gradle-wrapper.properties`);
const wrapperVersion = capture(wrapperProps, /distributionUrl=.*\/gradle-([0-9.]+)-bin\.zip/);
const wrapperSum = capture(wrapperProps, /distributionSha256Sum=([0-9a-f]{64})/);
check(
  "the Gradle distribution is pinned by version and by hash, together",
  [wrapperVersion !== null, wrapperSum !== null],
  [true, true],
);
// The wrapper jar is unreadable bytecode that runs first, so its hash records the reviewed one.
const wrapperJarSum = createHash("sha256")
  .update(readFileSync(join(ROOT, `${ANDROID_DIR}/gradle/wrapper/gradle-wrapper.jar`)))
  .digest("hex");
check(
  "and the wrapper jar is the reviewed one, byte for byte",
  wrapperJarSum,
  "e996d452d2645e70c01c11143ca2d3742734a28da2bf61f25c82bdc288c9e637",
);
// `exclusiveContent` makes the on-disk repository the only one that may serve the verifier; pinning alone does not.
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
// `usesCleartextTraffic` is ignored whenever `networkSecurityConfig` is set, at every level from `minSdk` 24.
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

// The network policy file is read, not only its attribute; cleartext and user CAs are both deliberate (Q7.144).
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
// Everything `tauri android init` rewrites is gitignored; `tauri.settings.gradle` holds machine paths and a clone regenerates it.
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
// No committed file under gen/android may write an absolute path; exemptions are anchored per .gitignore, never by basename.
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

// The home roots are spelled only in the predicate, or this file would land on its own offenders list.
const writesAbsolutePath = (text: string): boolean => /\/Users\/|\/home\/[a-z]/.test(text);
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
      if (/^(build|\.gradle|\.kotlin|\.cxx|generated)$/.test(name)) skippedDirs.push(here);
      else sweepAndroid(rel, here);
      continue;
    }
    if (!/\.(kt|kts|gradle|pro|xml|properties)$/.test(name)) continue;
    if (ignoredHere.has(here)) continue;
    swept.push(here);
    if (writesAbsolutePath(read(rel))) absolutePaths.push(rel);
  }
};
sweepAndroid(ANDROID_DIR, "");
// The corpus size and a required-member list, because an empty offenders list is also what a narrowed sweep answers.
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

process.stdout.write("\nthe icon, at every size a bundle asks for\n");

/** Enough of a PNG reader to find the artwork; all five filter types, since a hand-edited raster may filter adaptively. */
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

function opaqueBox(img: Decoded): { x: number; y: number; width: number; height: number } {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const alpha = img.bpp === 4 ? (img.px[(y * img.width + x) * 4 + 3] ?? 0) : 255;
      // Eight of 255, so an antialiased edge reads as present and a rounding artefact does not.
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

// Apple's grid: an 824x824 squircle in a 1024 canvas, restated because `icons.mjs` is JavaScript.
const MARGIN = 100 / 1024;

const iconList = (bundle["icon"] ?? []) as string[];
report("the bundle names icons at all", iconList.length > 0, `${String(iconList.length)} entries`);
check(
  "every icon the bundle names exists on disk",
  iconList.filter((rel) => !existsSync(join(ROOT, TAURI_DIR, rel))),
  [],
);

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

// One pixel of tolerance: the margin is fractional below 1024 and the edge is antialiased.
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

// The mark's share of the shape a person sees, on every platform that masks: the favicon's `scale` of its own badge. Q4.128.
const favicon = read("packages/web/public/favicon.svg");
const MARK_SHARE = Number(capture(favicon, /scale\(([\d.]+)\)/) ?? "NaN");
report("the mark's share was read off the favicon", MARK_SHARE > 0.6 && MARK_SHARE < 0.8, String(MARK_SHARE));
// Android's adaptive layer is 108dp, a launcher's mask shows the centre 72dp, and only the centre 66dp circle survives every mask.
const ADAPTIVE_DP = 108;
const VIEWPORT_DP = 72;
const SAFE_DP = 66;
const DENSITIES: Record<string, number> = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const ART_ASPECT = 170 / 192;

/** The light mark's box, whatever it sits on: #f9f8f6 on #1c1a16 or on nothing. */
function markBox(img: Decoded): { x: number; y: number; width: number; height: number } {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const at = (y * img.width + x) * img.bpp;
      const alpha = img.bpp === 4 ? (img.px[at + 3] ?? 0) : 255;
      if (alpha <= 8 || (img.px[at] ?? 0) <= 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** "ok", or what the mark measured against the side of the shape it should be that share of. Two pixels: an antialiased edge on each end. */
const markShare = (img: Decoded, visible: number): string => {
  const box = markBox(img);
  const want = MARK_SHARE * visible;
  return Math.abs(box.height - want) <= 2 ? "ok" : `${String(box.height)}px, want ${want.toFixed(1)}`;
};

const RES = `${ANDROID_DIR}/app/src/main/res`;
const ANDROID_TREES = [`${TAURI_DIR}/icons/android`, RES];
check(
  "the Dock's tile holds the mark at the favicon's share",
  markShare(png(`${TAURI_DIR}/icons/icon.png`), 1024 * (1 - 2 * MARGIN)),
  "ok",
);
for (const tree of ANDROID_TREES) {
  const foreground = Object.entries(DENSITIES).map(([density, d]) => {
    const img = png(`${tree}/mipmap-${density}/ic_launcher_foreground.png`);
    const box = opaqueBox(img);
    const centre = img.width / 2;
    let reach = 0;
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        if ((img.px[(y * img.width + x) * 4 + 3] ?? 0) <= 8) continue;
        const dx = Math.max(Math.abs(x - centre), Math.abs(x + 1 - centre));
        const dy = Math.max(Math.abs(y - centre), Math.abs(y + 1 - centre));
        reach = Math.max(reach, Math.hypot(dx, dy));
      }
    }
    const faults = [
      img.width === ADAPTIVE_DP * d && img.height === img.width ? "" : `canvas ${String(img.width)}`,
      img.bpp === 4 ? "" : "no alpha",
      markShare(img, VIEWPORT_DP * d) === "ok" ? "" : `of the ${String(VIEWPORT_DP)}dp mask: ${markShare(img, VIEWPORT_DP * d)}`,
      Math.abs(box.width / box.height - ART_ASPECT) < 0.03 ? "" : `aspect ${(box.width / box.height).toFixed(3)}`,
      Math.abs(box.x + box.width / 2 - centre) <= 1 && Math.abs(box.y + box.height / 2 - centre) <= 1 ? "" : "off centre",
      reach <= (SAFE_DP / 2) * d ? "" : `reaches ${(reach / d).toFixed(1)}dp of ${String(SAFE_DP / 2)}`,
    ].filter(Boolean);
    return faults.length === 0 ? "the mark, at the Dock's share of the mask" : `${density}: ${faults.join(", ")}`;
  });
  check(
    `${tree}: the adaptive foreground is the mark alone, at the Dock's share of the 72dp mask and inside the safe circle`,
    foreground,
    Object.keys(DENSITIES).map(() => "the mark, at the Dock's share of the mask"),
  );
  const legacy = Object.entries(DENSITIES).flatMap(([density, d]) =>
    ["ic_launcher.png", "ic_launcher_round.png"].map((name) => {
      const rel = `${tree}/mipmap-${density}/${name}`;
      const img = png(rel);
      const box = opaqueBox(img);
      // Ten percent in from the corner of the badge's box: inside a 22.5% corner, outside a circle.
      const corner = img.px[((box.y + Math.round(box.height / 10)) * img.width + box.x + Math.round(box.width / 10)) * 4 + 3] ?? 0;
      const shape = name === "ic_launcher.png" ? corner > 8 : corner <= 8;
      const faults = [
        img.width === 48 * d ? "" : `canvas ${String(img.width)}`,
        inset(rel) === "inset" ? "" : inset(rel),
        markShare(img, img.width * (1 - 2 * MARGIN)) === "ok" ? "" : markShare(img, img.width * (1 - 2 * MARGIN)),
        shape ? "" : "the wrong shape",
      ].filter(Boolean);
      return faults.length === 0 ? "the Dock's tile" : `${density}/${name}: ${faults.join(", ")}`;
    }),
  );
  check(`${tree}: and the legacy rasters are the Dock's tile, square and round`, [...new Set(legacy)], ["the Dock's tile"]);
}
check(
  "and the two Android trees are the same bytes, file for file",
  Object.keys(DENSITIES).flatMap((density) =>
    ["ic_launcher_foreground.png", "ic_launcher.png", "ic_launcher_round.png"]
      .map((name) => `mipmap-${density}/${name}`)
      .filter((rel) => Buffer.compare(readFileSync(join(ROOT, ANDROID_TREES[0] ?? "", rel)), readFileSync(join(ROOT, RES, rel))) !== 0),
  ),
  [],
);

const stripXml = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");
for (const tree of ANDROID_TREES) {
  const adaptive = stripXml(read(`${tree}/mipmap-anydpi-v26/ic_launcher.xml`));
  const colours = stripXml(read(`${tree}/values/ic_launcher_background.xml`));
  check(
    `${tree}: the launcher is the mark over a colour, and Android 13 tints the same mark`,
    [
      /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\s*\/>/.test(adaptive),
      /<background android:drawable="@color\/ic_launcher_background"\s*\/>/.test(adaptive),
      /<monochrome android:drawable="@mipmap\/ic_launcher_foreground"\s*\/>/.test(adaptive),
      /@mipmap\/ic_launcher_(?:background|monochrome)/.test(adaptive),
    ],
    [true, true, true, false],
  );
  check(
    `${tree}: and it is the badge colour the browser tab already uses`,
    /<color name="ic_launcher_background">(#[0-9a-f]{6})<\/color>/.exec(colours)?.[1],
    "#1c1a16",
  );
}

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

// The browser badge stays full-bleed: a tab strip does not mask, and iOS masks the alpha-less touch icon itself.
check("the favicon's badge still fills its viewBox", /<rect width="192" height="192" rx="48"/.test(favicon), true);
check("and the home-screen icon has no alpha to inset with", png("packages/web/public/apple-touch-icon.png").colour, 2);

const generator = read(`${NATIVE}/scripts/icons.mjs`);
check(
  "the generator derives the mark from the favicon and states only the grids",
  [
    /favicon\.svg/.test(generator),
    /100 \/ 1024/.test(generator),
    /185\.4 \/ 824/.test(generator),
    /\(108 - 72\) \/ 2 \/ 108/.test(generator),
    /BAR_WIDTH|16\.43/.test(generator),
  ],
  [true, true, true, true, false],
);
// It draws both Android trees and writes no XML: the launcher XMLs stay hand-authored, since `tauri icon` rewriting them was the defect.
const generatorCode = rustCode(generator);
check(
  "and it writes both Android trees' rasters and no launcher XML",
  [/"icons\/android"/.test(generatorCode), /"gen\/android\/app\/src\/main\/res"/.test(generatorCode), /\.xml/.test(generatorCode)],
  [true, true, false],
);

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
// The daemon's exit codes are decided in `scripts/daemon.ts`, carried by `daemon.rs` and branched on by `store.ts`.
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
// The key makes macOS's Local Network prompt name Reemoat; the app, as parent, is the responsible process.
check(
  "the bundle asks for the local network in its own words",
  /NSLocalNetworkUsageDescription/.test(read(`${TAURI_DIR}/Info.plist`)),
  true,
);
check("and the config merges that file in", (bundle["macOS"] as Record<string, unknown>)["infoPlist"], "Info.plist");
check(
  "the fleet is decided by the key install.sh writes",
  /const CONTROL_PLANE_KEY: &str = "REEMOAT_CONTROL_PLANE";/.test(daemonRs),
  true,
);
// A rewrite touches exactly three keys; more would delete lines like `NODE_EXTRA_CA_CERTS`.
const owned = /const OWNED_KEYS: \[&str; 3\] = \[([^\]]+)\];/.exec(daemonRs)?.[1] ?? "";
// A stale announce file survives a crash, so a daemon this app did not start must be probed before it reads as `foreign`.
check("a daemon this app did not start is confirmed to be there", /fn is_alive\(/.test(daemonRs), true);
const probe = /pub fn is_alive\([\s\S]*?\n\}/.exec(daemonRs)?.[0] ?? "";
check("the liveness probe exists to be read", probe.length > 0, true);
check("and it sends no credential", /authorization|Bearer|reqwest/i.test(probe), false);
check("and it asks the one route below the auth gate", /GET \/health/.test(probe), true);
// Exit on `RunEvent::Exit` stops every supervisor: all signalled, then reaped against one deadline (Q7.148).
const libCode = libRs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("the shell handles its own exit", /matches!\(event, tauri::RunEvent::Exit\)/.test(flat(libCode)), true);
check("and stops every daemon it started there", /daemon::stop_all\(/.test(libCode), true);
{
  const stopAllBy = /fn stop_all_by<[\s\S]*?\n\}/.exec(daemonRs)?.[0] ?? "";
  check("the quit's stop was found to read", stopAllBy.length > 0, true);
  check(
    "signalled together, under one deadline",
    /\.signal\(\);[\s\S]*?\}[\s\S]*?\.reap_by\(deadline\);/.test(stopAllBy) && !/\.stop\(\)/.test(stopAllBy),
    true,
  );
  check("and stop_all is that, one deadline out", /pub fn stop_all<[\s\S]*?stop_all_by\(supervisors, std::time::Instant::now\(\) \+ STOP_DEADLINE\);/.test(flat(daemonRs)), true);
}
check("and the stop is bounded rather than open-ended", /const STOP_DEADLINE/.test(daemonRs), true);
// A hand-installed launchd unit would respawn, source the rewritten file and race this app's child for the enrollment code.
check("a hand-installed service is looked for", /fn managed_unit\(/.test(daemonRs), true);
check(
  "and a rewrite is refused while one owns the file",
  /daemon::managed_unit\(&home\)/.test(read(`${TAURI_DIR}/src/commands.rs`)),
  true,
);
// Only the legacy root can be sourced by a unit, so only it is refused.
check(
  "and only for the one root a unit can source",
  /root\.legacy && !enroll_code\.is_empty\(\) && env_file\.exists\(\)/.test(flat(read(`${TAURI_DIR}/src/commands.rs`))),
  true,
);
check(
  "and a fresh computer's legacy root is not handed over beside a leftover unit",
  /holds_no_daemon\(&legacy\) && managed_unit\(home\)\.is_none\(\)/.test(flat(daemonRs)),
  true,
);
// The remedy moves the plist: detection is by file and `RunAtLoad` reloads an unloaded one.
const remedy = /pub fn managed_unit_detail\([\s\S]*?\n\}/.exec(daemonRs)?.[0] ?? "";
check("the remedy exists to be read", remedy.length > 0, true);
check("and it moves the file rather than only unloading it", /mv \{/.test(remedy), true);
// Values are validated rather than escaped: the file is sourced, and `parse_env` is its one reader.
check("values written into the env file are validated", /fn is_writable_value\(/.test(daemonRs), true);
check(
  "and the state command asks before answering foreign",
  /announced\.filter\(\|found\| ours \|\| daemon::is_alive/.test(flat(read(`${TAURI_DIR}/src/commands.rs`))),
  true,
);
check(
  "a rewrite may replace exactly the three keys this app owns",
  owned.split(",").map((k) => k.trim()).filter(Boolean),
  ['"REEMOAT_AUTH"', "CONTROL_PLANE_KEY", '"REEMOAT_ENROLL_CODE"'],
);

// The log has its own command; `DaemonState` carries no log on the one-second poll.
{
  const commandsRs = read(`${TAURI_DIR}/src/commands.rs`);
  check("the log has a command of its own", /pub fn host_daemon_log\(/.test(commandsRs), true);
  check("and the supervisor answers it as lines", /pub fn log_lines\(&self\) -> Vec<String>/.test(daemonRs), true);
  check("the poll carries no daemon output", /pub detail:/.test(daemonRs), false);
  check("and asks the ring for a bit instead", /pub fn printed_anything\(&self\) -> bool/.test(daemonRs), true);
  check("which is what tells `exited` from `absent`", /if supervisor\.printed_anything\(\) \{ "exited" \} else \{ "absent" \}/.test(flat(commandsRs)), true);
  check("and the page's mirror of the struct dropped it too", /detail/.test(/export interface DaemonState \{[\s\S]*?\n\}/.exec(read("packages/web/src/native.ts"))?.[0] ?? "x detail"), false);
  check("the log command answers a list rather than a result", /pub fn host_daemon_log\([^)]*\) -> Vec<String>/.test(commandsRs), true);
}

// The payload prunes the agent CLIs `deploy/agents.sh` installs (Q4.114), and the pruned names must equal `AGENT_LOGIN`'s.
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
  // `.bin` stays first on the daemon's PATH so the adapters and runtime resolve with no profile.
  check("the payload's bin is still first on the daemon's PATH", /parts\.push\(payload\.root\.join\("node_modules"\)\.join\("\.bin"\)/.test(flat(daemonRs)), true);
}

// `claude` keys its Keychain account on `USER`, so the cleared environment must set it.
{
  // Captured from raw source, not `flat`, because the body is also asserted by position.
  const start = /pub fn start\(\s*&mut self[\s\S]*?\n    \}/.exec(daemonRs)?.[0] ?? "";
  check("the supervisor's spawn was found to read", start.length > 0, true);
  check("it still builds the environment rather than inheriting one", /\.env_clear\(\)/.test(start), true);
  check("and it names who the daemon is", /command\.env\("USER", &name\);/.test(start), true);
  check("in both spellings, because POSIX has two and tools read either", /command\.env\("LOGNAME", &name\);/.test(start), true);
  // Set before the env file is applied, so a `USER=` line there still wins.
  const named = start.indexOf('command.env("USER", &name);');
  const fromFile = start.indexOf("for (key, value) in env {");
  check("and the env file still wins over it", named > 0 && fromFile > named, true);
  // Root, server and port are set at spawn after the env file and never written into it (Q7.148).
  const spawnAt = start.indexOf("command.env(STATE_ROOT_KEY, &spawn.root);");
  check("the root, the server and the port are decided at spawn, after the env file", spawnAt > fromFile && fromFile > 0, true);
  check("the server is the host's own origin", /command\.env\(CONTROL_PLANE_KEY, &spawn\.control_plane\);/.test(start), true);
  // The kernel's port only for a root of its own: `~/.reemoat`'s daemon stays on 7887 (Q1.22).
  check("the port is the kernel's, for a root of its own", /if spawn\.ephemeral_port \{\s*command\.env\(PORT_KEY, "0"\);/.test(start), true);
  check(
    "and only a root of its own gets it",
    /ephemeral_port: !root\.legacy,/.test(read(`${TAURI_DIR}/src/commands.rs`)),
    true,
  );
  check(
    "the host sets the name the daemon reads",
    [/const STATE_ROOT_KEY: &str = "REEMOAT_HOME";/.test(daemonRs), /process\.env\["REEMOAT_HOME"\]/.test(daemonTs)],
    [true, true],
  );
  check("the name comes from the system rather than from a variable", /libc::getpwuid\(libc::getuid\(\)\)/.test(daemonRs), true);
  for (const name of ["SHELL", "TMPDIR"]) {
    check(`and ${name} reaches the daemon too`, new RegExp(`"${name}",`).test(start), true);
  }
}

process.stdout.write("\nwhat a keystroke becomes\n");
{
  // WebKit rewrites `"`, `--` and a text replacement as they are typed unless these read NO; registered, never set, so a person's own toggle still wins (Q3.647).
  const lib = rustCode(read(`${TAURI_DIR}/src/lib.rs`));
  const named = capture(lib, /const VERBATIM_TYPING: \[&std::ffi::CStr; 4\] = \[([^\]]*)\]/) ?? "";
  check(
    "the four substitutions WebKit reads first are named",
    [...named.matchAll(/c"(\w+)"/g)].map((m) => m[1]).sort(),
    [
      "WebAutomaticDashSubstitutionEnabled",
      "WebAutomaticQuoteSubstitutionEnabled",
      "WebAutomaticSpellingCorrectionEnabled",
      "WebAutomaticTextReplacementEnabled",
    ],
  );
  const body = flat(between(lib, "fn leave_typing_alone()", "pub fn run()"));
  check("the function was found", body !== "", true);
  check(
    "and every one is registered off",
    [/numberWithBool: Bool::NO\]/.test(body), /let values = vec!\[off; keys\.len\(\)\];/.test(body), /registerDefaults: table\]/.test(body)],
    [true, true, true],
  );
  check("never written, which would outrank a person's own choice", /setBool|setObject/.test(body), false);
  check("and spell checking itself is left alone, since a mark alters nothing", /WebContinuousSpellChecking/.test(lib), false);
  check(
    "macOS only, where these keys mean something",
    [/#\[cfg\(target_os = "macos"\)\] const VERBATIM_TYPING/.test(flat(lib)), /#\[cfg\(target_os = "macos"\)\] fn leave_typing_alone\(\)/.test(flat(lib))],
    [true, true],
  );
  // The web process is handed the state when it starts, so this must run before any webview is built.
  check(
    "before anything else the shell does",
    /pub fn run\(\) \{ #\[cfg\(target_os = "macos"\)\] leave_typing_alone\(\); tauri::Builder::default\(\)/.test(flat(lib)),
    true,
  );
  check("and cargo test asks Foundation that it held", /fn a_keystroke_is_left_as_typed\(\)/.test(lib), true);
}

process.stdout.write("\nthe window's theme, and the ink behind the page\n");
{
  // The switch's theme is the window's, set in one place in Rust; a declared one would be a second answer (Q3.671).
  check("the window declares no theme of its own", Object.keys(main).filter((key) => key === "theme"), []);

  const blockAt = (text: string, head: string): string => {
    const at = text.indexOf(head);
    const end = at < 0 ? -1 : text.indexOf("\n}", at);
    return end < 0 ? "" : text.slice(at, end);
  };
  const css = read("packages/web/src/index.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const pageInk = (head: string): string | null => capture(blockAt(css, head), /--color-ink:\s*(#[0-9a-f]{6});/i)?.toLowerCase() ?? null;
  const seatsCode = rustCode(read(`${TAURI_DIR}/src/seats.rs`));
  const hostInk = (name: string): string | null => {
    const m = new RegExp(`const ${name}: Color = Color\\(0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0x([0-9a-f]{2}), 0xff\\);`).exec(seatsCode);
    return m === null ? null : `#${m[1]}${m[2]}${m[3]}`;
  };
  const inks = {
    light: [hostInk("LIGHT_INK"), pageInk("@theme {")],
    dark: [hostInk("DARK_INK"), pageInk(':root[data-theme="dark"] {')],
  };
  report(
    "both inks were read, off seats.rs and off index.css",
    [...inks.light, ...inks.dark].every((ink) => ink !== null) && inks.light[1] !== inks.dark[1],
    `light ${inks.light.join(" / ")}, dark ${inks.dark.join(" / ")}`,
  );
  check("the window's light ink is the page's", inks.light[0], inks.light[1]);
  check("and its dark ink is the dark palette's", inks.dark[0], inks.dark[1]);
  check("and tauri.conf.json's declared background is the light one", String(main["backgroundColor"]).toLowerCase(), inks.light[1]);
  const rustSources = readdirSync(join(ROOT, TAURI_DIR, "src")).filter((file) => file.endsWith(".rs"));
  const rustOf = (file: string): string => flat(rustCode(read(`${TAURI_DIR}/src/${file}`)));
  check(
    "a colour is written down in one Rust file",
    rustSources.filter((file) => /Color\(0x[0-9a-f]{2}/.test(rustOf(file))),
    ["seats.rs"],
  );

  const pageNames = [...(capture(rustCode(read("packages/web/src/theme.ts")), /export type Theme = ([^;]+);/) ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const parse = capture(rustOf("config.rs"), /pub fn parse\(name: &str\) -> Option<Theme> \{ match name \{ ([^}]*)\}/) ?? "";
  const hostNames = [...parse.matchAll(/"(\w+)" => Some\(Theme::\w+\)/g)].map((m) => m[1]);
  report("the page's theme names were read", pageNames.length === 2, pageNames.join(", "));
  check("and the host accepts exactly those, refusing the rest", [hostNames.sort(), /_ => None,/.test(parse)], [pageNames.sort(), true]);

  // The page says its theme at every boot and every show, so an unchanged one is neither written nor applied.
  const commandsFlat = flat(rustCode(commandsRs));
  check(
    "the command writes and applies a change and nothing else",
    /let wrote = config::write_theme\(&host\.config_dir, theme\); if !matches!\(wrote, Ok\(false\)\) \{ seats::show_theme\(&webview\.window\(\), theme\); \}/.test(commandsFlat),
    true,
  );
  const writeTheme = between(rustOf("config.rs"), "pub fn write_theme(", "#[cfg(test)]");
  check(
    "and the writer returns before a write where the file already says it, without writing the accounts era down",
    [/if stored\.replaceable && theme_of\(&stored\) == theme \{ return Ok\(false\); \}/.test(writeTheme), /accounts_mut|materialize/.test(writeTheme)],
    [true, false],
  );
  const libFlat = flat(rustCode(libRs));
  check(
    "a launch builds the window in the stored theme, and writes none",
    [/let theme = config::read_theme\(&dir\);/.test(libFlat), /\.map\(\|config\| seats::themed\(&config, theme\)\)/.test(libFlat), /write_theme/.test(startupCode)],
    [true, true, false],
  );
  // Light by default, on the owner's word (Q3.670): the window always carries the switch's theme, so the system's never reaches a page.
  check(
    "the window is always in a theme of the switch's, and nothing listens for the system's",
    [
      /themed\.theme = Some\(to_tauri\(theme\)\);/.test(seatsCode.replace(/\s+/g, " ")),
      /Some\("dark"\) => Theme::Dark, _ => Theme::Light,/.test(rustOf("config.rs")),
      rustSources.filter((file) => /ThemeChanged/.test(rustOf(file))),
    ],
    [true, true, []],
  );
  // tao's app-wide call leaves the window's cached theme stale on macOS and its own preference in place on Linux.
  check(
    "and every theme is set on the window rather than app-wide",
    rustSources.flatMap((file) => [...rustOf(file).matchAll(/(\w+)\.set_theme\(/g)].map((m) => `${file}: ${m[1]}`)),
    ["seats.rs: window"],
  );
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
