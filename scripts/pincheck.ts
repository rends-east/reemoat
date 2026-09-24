#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AGENT_IDS } from "../src/acp/agents.js";
import { AIR_ASYNC_TASKS_CAPABILITY, AIR_CLIENT_CAPABILITY } from "../src/acp/asynctasks.js";

/**
 * Driver for numbers written down more than once: adapter pins, this release's version, the platform-package exclusions (Q4.114), the API-key ceiling.
 * It pins no agent CLI on purpose: deploy/agents.sh installs them and AgentCapabilities.cli reports the build that runs.
 */

const root = new URL("../", import.meta.url);
let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

/** Like check, with the measurement printed: for non-vacuity, since a pattern that matches nothing makes a set comparison pass. */
function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

function read(rel: string): string {
  return readFileSync(new URL(rel, root), "utf8");
}

/** Null rather than a throw or an empty string, so a pattern that stops matching fails instead of passing. */
function capture(text: string, pattern: RegExp): string | null {
  const m = pattern.exec(text);
  return m?.[1] ?? null;
}

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** An adapter the daemon spawns as an ACP server. The CLI it drives is not a field: none is vendored (Q4.114). */
interface Adapter {
  name: string;
  agent: string;
}

const ADAPTERS: readonly Adapter[] = [
  { name: "@agentclientprotocol/claude-agent-acp", agent: "claude" },
  { name: "@agentclientprotocol/codex-acp", agent: "codex" },
];

const packageJson = read("package.json");
const workspaceYaml = read("pnpm-workspace.yaml");

process.stdout.write("\nthe ACP adapters, as they are written down\n");

const pinned = new Map<string, string | null>();

for (const adapter of ADAPTERS) {
  const inPackage = capture(packageJson, new RegExp(`"${escapeForRegex(adapter.name)}":\\s*"([^"]+)"`));
  const inWorkspace = capture(workspaceYaml, new RegExp(`'${escapeForRegex(adapter.name)}@([^']+)'`));
  pinned.set(adapter.name, inPackage);

  check(`${adapter.name} is readable in package.json`, inPackage !== null, true);
  check(`${adapter.name} is readable in pnpm-workspace.yaml`, inWorkspace !== null, true);

  if (inPackage !== null && inWorkspace !== null) {
    check(`the release-age exclusion names the pinned ${adapter.agent} adapter`, inWorkspace, inPackage);
    // Exact, not just equal: two consistent ranges would let pnpm and a fresh global install resolve different builds.
    check(`the ${adapter.agent} adapter pin is an exact version`, /^\d+\.\d+\.\d+$/.test(inPackage), true);
  }
}

// minimumReleaseAgeExclude is inert without minimumReleaseAge, so the state is reported rather than implied by a passing check.
process.stdout.write(
  /^\s*minimumReleaseAge\s*:/m.test(workspaceYaml)
    ? "  ok    minimumReleaseAge is set, so those exclusions are load-bearing\n"
    : "  note  minimumReleaseAge is NOT set, so those exclusions currently exclude nothing\n",
);

// Skips only when nothing is installed: inside an install a null resolution is a failure, not a tolerance.
const installed = existsSync(new URL("node_modules", root));
const fromRoot = createRequire(new URL("package.json", root));

process.stdout.write("\nthe adapters actually installed, against the ones written down\n");

if (!installed) {
  process.stdout.write("  skip  nothing is installed (run pnpm install)\n");
} else {
  for (const adapter of ADAPTERS) {
    let installedAdapter: string | null = null;
    try {
      const adapterPkg: unknown = JSON.parse(readFileSync(fromRoot.resolve(`${adapter.name}/package.json`), "utf8"));
      const adapterVersion = (adapterPkg as { version?: unknown }).version;
      installedAdapter = typeof adapterVersion === "string" ? adapterVersion : null;
    } catch {
      // Left null and asserted on below.
    }
    // The only assertion that reads what runs rather than comparing files to each other.
    check(`the installed ${adapter.agent} adapter is the pinned one`, installedAdapter, pinned.get(adapter.name));
  }

  // Asks the adapter's own gate whether the capability this daemon sends is accepted: a rename or bump fails silently on the wire (Q5.114).
  // The negative case proves the gate is a gate.
  const air: unknown = await import("@agentclientprotocol/claude-agent-acp/dist/air-extension.js").catch(
    () => null,
  );
  const gate = (air as { clientSupportsAirCapability?: (caps: unknown, capability: string) => boolean } | null)
    ?.clientSupportsAirCapability;
  const named = (air as { AIR_ASYNC_TASKS_CAPABILITY?: unknown } | null)?.AIR_ASYNC_TASKS_CAPABILITY;
  if (gate === undefined) {
    check("the installed claude adapter still has an AIR capability gate to ask", gate !== undefined, true);
  } else {
    check(
      "the adapter accepts the background-task capability this daemon actually sends",
      gate({ _meta: AIR_CLIENT_CAPABILITY }, AIR_ASYNC_TASKS_CAPABILITY),
      true,
    );
    check("and it is still spelled the way this daemon spells it", named, AIR_ASYNC_TASKS_CAPABILITY);
    check(
      "while a declaration with no version is refused, which is why the version is asserted",
      gate({ _meta: { jetbrains: { air: { capabilities: [AIR_ASYNC_TASKS_CAPABILITY] } } } }, AIR_ASYNC_TASKS_CAPABILITY),
      false,
    );
  }
}

/** A package an adapter depends on whose optionalDependencies are a CLI's platform builds; reached through the adapter, since pnpm's strict layout hides it from the root. */
interface Declarer {
  name: string;
  adapter: string;
  agent: string;
  manifest: "nearest-above-entry" | "exported";
}

const DECLARERS: readonly Declarer[] = [
  {
    name: "@anthropic-ai/claude-agent-sdk",
    adapter: "@agentclientprotocol/claude-agent-acp",
    agent: "claude",
    manifest: "nearest-above-entry",
  },
  {
    name: "@openai/codex",
    adapter: "@agentclientprotocol/codex-acp",
    agent: "codex",
    manifest: "exported",
  },
];

/**
 * The platform packages a declarer names, or null where the chain is broken.
 * The SDK's exports map hides its package.json, so that manifest is found by walking up from the entry to the one with its name.
 */
function readDeclaredPlatforms(declarer: Declarer): Record<string, string> | null {
  const fromAdapter = createRequire(fromRoot.resolve(`${declarer.adapter}/package.json`));
  let manifestPath: string | null = null;
  switch (declarer.manifest) {
    case "exported": {
      manifestPath = fromAdapter.resolve(`${declarer.name}/package.json`);
      break;
    }
    case "nearest-above-entry": {
      let dir = dirname(fromAdapter.resolve(declarer.name));
      for (;;) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
          const named = (JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown }).name;
          if (named === declarer.name) {
            manifestPath = candidate;
            break;
          }
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      break;
    }
  }
  if (manifestPath === null) return null;
  const declared = (JSON.parse(readFileSync(manifestPath, "utf8")) as { optionalDependencies?: unknown }).optionalDependencies;
  if (typeof declared !== "object" || declared === null) return null;
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(declared)) {
    if (typeof spec !== "string") return null;
    out[name] = spec;
  }
  return out;
}

/** The overrides block of pnpm-workspace.yaml, or null. Read from the workspace file only: pnpm ignores pnpm.overrides in package.json (Q4.114). */
function readOverrides(yaml: string): Map<string, string> | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (start === -1) return null;
  const out = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\s*$/.test(line) || /^\s+#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s+'([^']+)':\s*'([^']*)'\s*$/.exec(line);
    // An indented non-entry line is reported as unreadable rather than skipped, so the comparison fails on it.
    out.set(entry?.[1] ?? `unreadable: ${line.trim()}`, entry?.[2] ?? "");
  }
  return out;
}

/** The node_modules/.pnpm directory prefix for a spec, or null. An alias is stored under the name it aliases, so its version is kept. */
function pnpmDirPrefix(name: string, spec: string): string | null {
  if (!spec.startsWith("npm:")) return `${name.replaceAll("/", "+")}@`;
  const real = spec.slice("npm:".length);
  const at = real.lastIndexOf("@");
  if (at <= 0) return null;
  const version = real.slice(at + 1);
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  return `${real.slice(0, at).replaceAll("/", "+")}@${version}`;
}

process.stdout.write("\nthe CLIs this repository deliberately does not install\n");

const overrides = readOverrides(workspaceYaml);
check("the overrides block of pnpm-workspace.yaml is readable at all", overrides !== null, true);
const overrideEntries = [...(overrides ?? new Map<string, string>()).entries()];
const excluded = overrideEntries
  .filter(([, replacement]) => replacement === "-")
  .map(([name]) => name)
  .sort();
check(
  "every override in it removes a package rather than pinning one",
  overrideEntries.filter(([, replacement]) => replacement !== "-").map(([name, replacement]) => `${name}: ${replacement}`),
  [],
);
check("the block excludes something at all", excluded.length >= 1, true);

if (!installed) {
  process.stdout.write("  skip  nothing is installed, so what the adapters declare cannot be read (run pnpm install)\n");
} else {
  const declared = new Map<string, string>();
  let readable = true;
  for (const declarer of DECLARERS) {
    let platforms: Record<string, string> | null = null;
    try {
      platforms = readDeclaredPlatforms(declarer);
    } catch {
      // Left null and asserted on below; the message names which hop failed.
    }
    check(`${declarer.name} is reachable through the ${declarer.agent} adapter and declares its platforms`, platforms !== null, true);
    if (platforms === null) {
      readable = false;
      continue;
    }
    check(`and ${declarer.agent}'s declaration names at least one platform`, Object.keys(platforms).length >= 1, true);
    for (const [name, spec] of Object.entries(platforms)) declared.set(name, spec);
  }

  if (readable) {
    const declaredNames = [...declared.keys()].sort();
    // Two directions, two lines: a download that came back, and an exclusion guarding nothing.
    check(
      "every platform package the adapters declare is excluded from the install",
      declaredNames.filter((name) => !excluded.includes(name)),
      [],
    );
    check(
      "every exclusion names a platform package an adapter still declares",
      excluded.filter((name) => !declared.has(name)),
      [],
    );

    const storeUrl = new URL("node_modules/.pnpm/", root);
    check("node_modules/.pnpm is there to be read", existsSync(storeUrl), true);
    const store = existsSync(storeUrl) ? readdirSync(storeUrl) : [];
    const prefixes = declaredNames.map((name) => [name, pnpmDirPrefix(name, declared.get(name) ?? "")] as const);
    check(
      "every declared platform spec is one this driver can look for on disk",
      prefixes.filter(([, prefix]) => prefix === null).map(([name]) => `${name}: ${declared.get(name) ?? ""}`),
      [],
    );
    check(
      "none of the excluded platform packages is under node_modules/.pnpm",
      prefixes.flatMap(([, prefix]) => (prefix === null ? [] : store.filter((entry) => entry.startsWith(prefix)))),
      [],
    );
  }
}

// The CLIs' npm names are read off deploy/agents.sh and held equal to AGENT_IDS, so the pattern cannot rot into matching nothing.
const agentsSh = read("deploy/agents.sh");
const cliPackages = new Map<string, string>();
for (const m of agentsSh.matchAll(/\bensure_npm ([a-z]+) (\S+) "/g)) {
  if (m[1] !== undefined && m[2] !== undefined) cliPackages.set(m[1], m[2]);
}
check("deploy/agents.sh names an npm package for each of the five", [...cliPackages.keys()].sort(), [...AGENT_IDS].sort());
const manifest = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
check(
  "none of those CLIs is a dependency of the root package.json",
  [...cliPackages.values()]
    .sort()
    .flatMap((pkg) => dependencySections.filter((section) => manifest[section]?.[pkg] !== undefined).map((section) => `${pkg} in ${section}`)),
  [],
);

process.stdout.write("\nthis release, as it is written down\n");

const webPkg = read("packages/web/package.json");
const cpPkg = read("packages/control-plane/package.json");
const appTs = read("packages/control-plane/src/app.ts");
const changelog = read("CHANGELOG.md");

const VERSION_IN_MANIFEST = /"version":\s*"([^"]+)"/;

const rootVersion = capture(packageJson, VERSION_IN_MANIFEST);
check("the root version is readable at all", rootVersion !== null, true);
check("the root version is an exact version", /^\d+\.\d+\.\d+$/.test(rootVersion ?? ""), true);

check("@reemoat/web names the version the workspace is at", capture(webPkg, VERSION_IN_MANIFEST), rootVersion);
check(
  "@reemoat/control-plane names the version the workspace is at",
  capture(cpPkg, VERSION_IN_MANIFEST),
  rootVersion,
);

// The one manifest that leaves the repository: build-daemon.mjs copies it into the app's daemon payload.
const protocolPkg = read("packages/protocol/package.json");
check(
  "@reemoat/protocol names the version the workspace is at",
  capture(protocolPkg, VERSION_IN_MANIFEST),
  rootVersion,
);

check(
  "the daemon names the version the workspace is at",
  capture(read("src/version.ts"), /^export const DAEMON_VERSION = "([^"]+)";$/m),
  rootVersion,
);

// Parsed the way deploy/ci-release.sh parses it; [Unreleased] keeps the newest released entry unambiguous.
const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/gm)]
  .map((m) => m[1])
  .filter((v): v is string => v !== undefined);

check("the CHANGELOG has an Unreleased section to distinguish shipped from pending", /^## \[Unreleased\]$/m.test(changelog), true);
check("the CHANGELOG's newest released entry is the version being shipped", releases[0] ?? null, rootVersion);

// Compared as number triples: 0.10.0 sorts before 0.9.0 as a string.
const asTriple = (v: string): number[] => v.split(".").map(Number);
const descending = [...releases].sort((a, b) => {
  const [x, y] = [asTriple(a), asTriple(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
});
check("every CHANGELOG heading is a version, and they descend", releases, descending);

// Reads repository.url only, never bugs.url, which is the same string today.
const sourceUrl = capture(appTs, /^const SOURCE_URL = "([^"]+)";$/m);
const repoUrl = capture(packageJson, /"url":\s*"git\+([^"]+?)(?:\.git)?"/);
check("the source offer's URL is readable at all", sourceUrl !== null, true);
check("the source offer names the repository this workspace says it is", sourceUrl, repoUrl);

// The served version is asserted by relaycheck against the response; this fails only if that check disappears.
const relaycheckSrc = read("scripts/relaycheck.ts");
check(
  "the served version is still asserted where relaycheck asserts it",
  relaycheckSrc.includes("naming the version it is actually running"),
  true,
);
process.stdout.write("  note  app.ts's VERSION literal is checked by relaycheck, against the response rather than the file\n");

// The native shell's two version fields are not release sites; nativecheck asserts them, and this fails if it stops.
const nativecheckSrc = read("scripts/nativecheck.ts");
check(
  "the native shell's two version fields are still asserted where nativecheck asserts them",
  [
    nativecheckSrc.includes("tauri.conf.json's version is a path rather than a literal"),
    nativecheckSrc.includes("and it is the inert one"),
  ],
  [true, true],
);
process.stdout.write("  note  the native shell's version fields are checked by nativecheck; neither is a release site\n");


process.stdout.write("\nthe crypto primitives, declared twice so the payload resolves them\n");

// The app's daemon payload gets its @noble packages from the root manifest only, so the root and @reemoat/protocol must declare the same set at the same exact version.
const NOBLE_ENTRY = /"(@noble\/[a-z-]+)":\s*"([^"]+)"/g;
const nobleFrom = (manifest: string): Map<string, string> =>
  new Map([...manifest.matchAll(NOBLE_ENTRY)].map((m) => [m[1] ?? "", m[2] ?? ""]));

const rootNoble = nobleFrom(packageJson);
const protocolNoble = nobleFrom(protocolPkg);

report(
  "both manifests were found to declare @noble packages",
  rootNoble.size > 0 && protocolNoble.size > 0,
  `${rootNoble.size} on the root manifest, ${protocolNoble.size} on @reemoat/protocol`,
);
check(
  "the two manifests name the same @noble packages",
  [...rootNoble.keys()].sort(),
  [...protocolNoble.keys()].sort(),
);
check(
  "and every one of them is pinned to one version across both",
  [...rootNoble]
    .filter(([name, version]) => protocolNoble.get(name) !== version)
    .map(([name, version]) => `${name}: ${version} on the root, ${protocolNoble.get(name) ?? "absent"} on @reemoat/protocol`)
    .sort(),
  [],
);
check(
  "and pinned exactly rather than by range",
  [...rootNoble, ...protocolNoble]
    .filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version))
    .map(([name, version]) => `${name} ${version}`)
    .sort(),
  [],
);
// build-daemon.mjs states the rule beside the code that depends on it; this fails if that pointer is reworded away.
check(
  "and the staging script still says where that rule lives",
  /`pincheck` holds the two declarations/.test(read("packages/native/scripts/build-daemon.mjs")),
  true,
);

process.stdout.write("\nthe API-key ceiling, on both sides of the wire\n");

// MAX_KEYS on the keys screen mirrors MAX_KEYS_PER_USER rather than fetching it, so the two must agree.
const keysSection = read("packages/web/src/ui/settings/KeysSection.tsx");
const keyCeilingServer = capture(appTs, /^const MAX_KEYS_PER_USER = (\d+);$/m);
const keyCeilingScreen = capture(keysSection, /^const MAX_KEYS = (\d+);$/m);
check("the control plane's key ceiling is readable at all", keyCeilingServer !== null, true);
check("and so is the keys screen's mirror of it", keyCeilingScreen !== null, true);
check("the keys screen refuses at the number the control plane refuses at", keyCeilingScreen, keyCeilingServer);


process.stdout.write("\nthe plugin API, and the one plugin in this repository\n");

// There is no second copy of the plugin API version; what breaks is a shipped plugin once PLUGIN_API_MIN_VERSION passes it. Swept over every directory, with a floor.
const protocolTs = read("src/plugins/protocol.ts");
const apiVersion = capture(protocolTs, /^export const PLUGIN_API_VERSION = (\d+);$/m);
const apiMin = capture(protocolTs, /^export const PLUGIN_API_MIN_VERSION = (\d+);$/m);
check("the plugin API version is readable at all", apiVersion !== null, true);
check("and so is the floor under it", apiMin !== null, true);
check(
  "the floor is not above the ceiling",
  apiMin !== null && apiVersion !== null && Number(apiMin) <= Number(apiVersion),
  true,
);

const shipped = readdirSync(new URL("plugins/", root), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
check("this repository ships a plugin at all", shipped.length >= 1, true);

const manifests = shipped.map(
  (name) => [name, JSON.parse(read(`plugins/${name}/plugin.json`)) as { api?: number; id?: string }] as const,
);
check(
  "every plugin this repository ships declares an API version",
  manifests.filter(([, one]) => typeof one.api !== "number").map(([name]) => name),
  [],
);
check(
  "and this daemon would still install each of them",
  manifests
    .filter(
      ([, one]) =>
        apiMin === null ||
        apiVersion === null ||
        typeof one.api !== "number" ||
        one.api < Number(apiMin) ||
        one.api > Number(apiVersion),
    )
    .map(([name]) => name),
  [],
);

// The id is also the directory docs/PLUGINS.md tells somebody to tar -C.
check(
  "and each one's id is the directory it lives in",
  manifests.filter(([name, one]) => one.id !== name).map(([name, one]) => `${name}: ${String(one.id)}`),
  [],
);
check(
  "and each one has an entry point beside its manifest",
  shipped.filter((name) => !existsSync(new URL(`plugins/${name}/server.js`, root))),
  [],
);

process.stdout.write("\nthe Node the native shell ships, against the floor this repository sets\n");

// The staged Node is the one the shipped daemon runs, and node:sqlite needs 24, so engines.node is a hard floor here. Major only.
const stageSrc = read("packages/native/scripts/build-daemon.mjs");
const stagedNode = capture(stageSrc, /const NODE_VERSION = "v(\d+)\.\d+\.\d+";/);
check("the staging script pins a Node version", stagedNode !== null, true);
const enginesFloor = capture(read("package.json"), /"node":\s*">=(\d+)"/);
check("and package.json states a floor", enginesFloor !== null, true);
check(
  "and the runtime that ships is not below it",
  stagedNode !== null && enginesFloor !== null && Number(stagedNode) >= Number(enginesFloor),
  true,
);
// An even major is LTS: the runtime inside a shipped app cannot be updated by its user.
check("and it is an LTS line", stagedNode !== null && Number(stagedNode) % 2 === 0, true);

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
