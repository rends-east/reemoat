#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AGENT_IDS } from "../src/acp/agents.js";

/**
 * The regression driver for a number written down more than once.
 *
 * **Five subjects, and each widening was deliberate rather than incidental.** This
 * file began as the driver for the agent adapters — three copies each — and it now
 * also holds this project's own version, which has six copies of which five are
 * read here; the plugin API and the one plugin this repository ships; a *list*
 * rather than a number — the platform packages `pnpm install` is told to leave
 * out; and — the newest — the API-key ceiling, written once on each side of the
 * wire. They are one file because they are one question: *do the
 * places a thing is written down agree with each other, and with what is actually
 * there?* The failure mode is identical in every half and is never a crash — it
 * is two copies that disagree while everything compiles. A second driver asking
 * that question about a different noun would be the shape the paragraph below
 * already calls out, arriving one level up.
 *
 * Each agent adapter is pinned in the root `package.json` (what the daemon
 * loads), in `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`, and — the one
 * that matters most — in `node_modules`, which is the only copy that actually
 * runs. The failure when those drift is not a crash: the daemon speaks one version
 * of ACP to an agent built against another, which looks like an agent bug.
 *
 * **Two adapters, and the file is a loop rather than a constant.** That shape is
 * the point: written around a single `ACP` name, adding codex pinned a second
 * adapter in `package.json` and asserted it nowhere — which is precisely the loss
 * the kimi paragraph below records, reintroduced one package over. The list held
 * a third entry for a while, `opencode-ai`, pinned here although it is no adapter
 * at all — opencode ships none, `opencode acp` being a subcommand of the binary a
 * login drives — because the mechanism existed, and declining it would have been
 * electing the kimi loss rather than inheriting it. That entry went with the
 * vendored copies (Q4.114, below); the loop stays a loop, for the reason it became
 * one.
 *
 * **Two checks were deleted with the container image, and only one of them was a
 * loss.**
 *
 * The image used to install `@anthropic-ai/claude-code` so a tenant had a
 * `claude` binary to log in with, and it had to be the same build the adapter
 * drives — the SDK resolves a binary of its own when it is told none, and the two
 * reading different credential formats surfaces as "the login worked and the
 * session says logged out". That check is not merely gone, it is **unnecessary**:
 * with no image, the `claude` a person logs in with is whatever
 * `CLAUDE_CODE_EXECUTABLE` or PATH resolves, and the adapter is handed that same
 * file — `LocalRuntime.launch` writes the variable on every spawn from the copy
 * `chooseCli` picked, so the SDK's own resolution never runs. The property is
 * structural rather than asserted, which is a better outcome than a passing test
 * — written down here so nobody re-adds the check by reflex.
 *
 * kimi was the real loss. Its version was pinned in the image and nowhere else,
 * and once it was resolved from PATH, **nothing recorded which build the
 * measurements in this repository were taken against.**
 *
 * ⚠ **This used to end "there is no mechanism that could pin it", and there is one
 * now — which deliberately does not pin, and which covers all four rather than
 * kimi alone.** `deploy/agents.sh` installs each CLI with its vendor's own
 * installer — or, under `--source npm`, from the registry, for a machine that
 * cannot reach the vendors' hosts — and the daemon re-runs it daily, because the
 * requirement it serves is that a machine nobody thinks about keeps current. So
 * the build is *chosen* rather than unknown, and it is chosen to be the newest,
 * which is a different thing from being recorded. What records it is the running
 * daemon: `AgentCapabilities.cli` carries the version of the build that published
 * a model list and where it came from — `override` for one an operator named,
 * `path` for the copy the script keeps current or one of the operator's own — off
 * `GET /agents/capabilities`. This file pins no CLI, and that is the state rather
 * than a gap in it.
 *
 * **Until Q4.114 `pnpm install` brought three of the four along, and the newest
 * section here is what keeps them out.** `opencode-ai` was a root dependency; a
 * `claude` and a `codex` arrived as *optional platform packages* of the two
 * adapters' own dependencies — `@anthropic-ai/claude-agent-sdk` under
 * `claude-agent-acp`, the `@openai/codex` shim under `codex-acp` — one build per
 * OS and architecture, of which pnpm installs the one that matches. Measured on
 * this repository's own darwin-arm64 checkout: 245 MB, 307 MB and 137 MB, 689 MB
 * of a 907 MB `node_modules`, for three programs `deploy/agents.sh` installs
 * anyway and keeps current from there, while the pinned copy was exactly as old as
 * the release and was never the one that ran once a vendor's copy was on the
 * machine. `opencode-ai` is simply gone from `package.json`. The platform packages
 * are excluded by name, one `'-'` override per package in `pnpm-workspace.yaml` —
 * the workspace file rather than `package.json`'s `pnpm.overrides`, because pnpm
 * 11.17.0 ignores the latter, measured; a `.pnpmfile.cjs` hook also works and was
 * declined as code that runs at install. The adapters stay pinned and installed,
 * and neither can run without a CLI: `claude-agent-acp` reads
 * `CLAUDE_CODE_EXECUTABLE`, else requires the platform package — now absent — else
 * throws, and `codex-acp` does the same with `CODEX_PATH`. The daemon writes the
 * variable on every spawn, and `resolveAgent` refuses before then when there is
 * nothing to write.
 *
 * **Why that list is asserted here rather than trusted: three places have to
 * agree, and two of them are somebody else's.** What the adapters *declare* is the
 * `optionalDependencies` of two packages this repository does not author and
 * re-resolves with every adapter pin; what the workspace *excludes* is a
 * hand-written list, one line per package; what is *on disk* is whatever pnpm made
 * of the two. A
 * platform the vendor adds — a musl build, a new architecture — is a package that
 * rides back in with every other check green, at a few hundred megabytes and with
 * no symptom beyond a slower install; a line left over after the vendor drops one
 * is a pin on nothing, which reads as protection. So the union of what the two
 * declare is compared to the exclusion list in both directions, each direction on
 * its own line because they are different mistakes, and `node_modules/.pnpm` is
 * then read for every declared package — the section's one assertion that reads
 * disk rather than text, for the reason the adapter half gives: every other line
 * compares files to each other and none of them to what an install actually
 * produced. And it is here rather than in a driver of its own because it is this
 * file's question with a list where the number was.
 *
 * **The release half, and why six copies rather than one.** This project's
 * version is in the root `package.json`, in both workspace manifests, in a literal
 * in `packages/control-plane/src/app.ts`, in `src/version.ts`'s `DAEMON_VERSION`,
 * and as the newest dated heading in `CHANGELOG.md`. The `app.ts` literal is a deliberate second copy — a service
 * whose point is having no runtime failure paths does not read a file to learn its
 * own name — and the two workspace manifests were asserted by nothing at all. What
 * makes drift here worse than untidy is that the literal is served as the AGPL
 * section 13 source offer: ship a release without moving it and the offer names a
 * version whose source nobody can fetch, which is a licence failure that looks
 * like compliance.
 *
 * The offer's *other* half is checked here too and was checked nowhere before:
 * `SOURCE_URL` against the repository this workspace says it is. `app.ts` tells a
 * fork to change that constant, and `deploy/ci-release.sh` derives the image's
 * `org.opencontainers.image.source` label from it — so a fork that follows the
 * licence instruction gets a correct label as a side effect, and an unmodified
 * tree cannot drift the two apart.
 *
 * Offline, one process, no network — the same shape as every other driver here:
 *   pnpm pincheck
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

function read(rel: string): string {
  return readFileSync(new URL(rel, root), "utf8");
}

/**
 * The first match of a pattern with one capture group, or null.
 *
 * Null rather than a throw, and the caller checks it: a pattern that stops
 * matching because a file was reformatted must fail as loudly as a version that
 * disagrees. Returning "" or skipping would turn a broken check into a green one,
 * which is the only outcome worse than no check at all.
 */
function capture(text: string, pattern: RegExp): string | null {
  const m = pattern.exec(text);
  return m?.[1] ?? null;
}

/**
 * Escaped so a package name can be spliced into a pattern.
 *
 * The patterns used to embed each name pre-escaped by hand, which is fine for one
 * and is a silent hazard for a list: an unescaped `/` or `.` still *matches*, just
 * more loosely than intended, so the check goes on passing while asserting
 * something weaker than it says.
 */
function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * One adapter: a package this repository pins and the daemon spawns as an ACP
 * server.
 *
 * ⚠ **The CLI it drives is deliberately not a field here any more.** It was — a
 * name and one of two resolution shapes — so the loop below could resolve the
 * vendored CLI through its adapter and prove the hop still worked. There is no
 * vendored CLI to reach (Q4.114): the adapter is told where its CLI is on every
 * spawn, and what this file asserts about the packages that used to carry one is
 * the section after the loop, through {@link DECLARERS}. Putting the CLI back
 * on this record would describe a resolution that never happens.
 */
interface Adapter {
  /** The npm name, which is also how it is written down in both files. */
  name: string;
  /** Which agent it adapts. Output only. */
  agent: string;
}

const ADAPTERS: readonly Adapter[] = [
  { name: "@agentclientprotocol/claude-agent-acp", agent: "claude" },
  { name: "@agentclientprotocol/codex-acp", agent: "codex" },
];

const packageJson = read("package.json");
const workspaceYaml = read("pnpm-workspace.yaml");

process.stdout.write("\nthe ACP adapters, as they are written down\n");

/** The pinned version of each adapter, for the second pass to compare against. */
const pinned = new Map<string, string | null>();

for (const adapter of ADAPTERS) {
  const inPackage = capture(packageJson, new RegExp(`"${escapeForRegex(adapter.name)}":\\s*"([^"]+)"`));
  const inWorkspace = capture(workspaceYaml, new RegExp(`'${escapeForRegex(adapter.name)}@([^']+)'`));
  pinned.set(adapter.name, inPackage);

  check(`${adapter.name} is readable in package.json`, inPackage !== null, true);
  check(`${adapter.name} is readable in pnpm-workspace.yaml`, inWorkspace !== null, true);

  if (inPackage !== null && inWorkspace !== null) {
    check(`the release-age exclusion names the pinned ${adapter.agent} adapter`, inWorkspace, inPackage);
    /*
     * And that it is an *exact* version, which nothing asserted. Equality alone is
     * satisfied by two consistent ranges — `^0.63.0` in both files — while pnpm
     * resolves from the lockfile and a fresh `npm i -g` would resolve at install
     * time. That is two different builds with every check green.
     */
    check(`the ${adapter.agent} adapter pin is an exact version`, /^\d+\.\d+\.\d+$/.test(inPackage), true);
  }
}

/*
 * Whether those exclusions exclude anything, which nothing said.
 *
 * `minimumReleaseAgeExclude` without `minimumReleaseAge` is inert — measured,
 * `pnpm config get minimumReleaseAge` answers `undefined` and the setting is in
 * no `.npmrc` — so the assertions above were guarding lines with no effect while
 * this file's header called them "what lets the pin be installed at all". The
 * policy is not switched on here (see the note in `pnpm-workspace.yaml` for what
 * it costs today); what is fixed is that the state is now *reported* instead of
 * being implied by a check that passes either way.
 *
 * Once, not per adapter: it is one setting governing the whole file.
 */
process.stdout.write(
  /^\s*minimumReleaseAge\s*:/m.test(workspaceYaml)
    ? "  ok    minimumReleaseAge is set, so those exclusions are load-bearing\n"
    : "  note  minimumReleaseAge is NOT set, so those exclusions currently exclude nothing\n",
);

/*
 * **The skip is conditional on there being no install to read.**
 *
 * It used to be unconditional: a null manifest printed `skip`, and this driver
 * still printed `all green` and exited 0. That is the outcome the note above
 * `capture` calls the only one worse than no check at all, arrived at by the other
 * door — and it lands on precisely the change this exists to police, since the
 * resolution hops are what an adapter bump breaks. In CI it is worse still:
 * `pnpm install --frozen-lockfile` has definitely run by the time this step does,
 * so there the null can only mean the chain is broken.
 *
 * A fresh clone still skips, which is the case the tolerance was written for. The
 * same condition governs the disk half of the next section, for the same reason.
 */
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
      // Left null and asserted on below. Inside the `installed` branch a broken
      // chain is a failure, not a tolerance — that is the whole point of the
      // condition above.
    }
    // The strongest assertion here, and the only one that reads disk rather than
    // text: every check above compares files to each other and none of them to what
    // runs, so a lockfile resolving 0.62.x under a `package.json` reading 0.63.0
    // passed all of them.
    check(`the installed ${adapter.agent} adapter is the pinned one`, installedAdapter, pinned.get(adapter.name));
  }
}

// ------------------------------ the CLIs this repository deliberately does not install

/**
 * A package an adapter depends on whose `optionalDependencies` are the platform
 * builds of a CLI — the ones `pnpm-workspace.yaml` removes by name.
 *
 * Reached *through* the adapter rather than from here: both are transitive
 * dependencies, so pnpm's strict layout means the root cannot resolve either — the
 * same reason `jose` is in the lockfile and `token.ts` is hand-rolled on
 * node:crypto. Asking the adapter is also the more honest question, since the
 * declaration that matters is the one the installed adapter would pull in.
 */
interface Declarer {
  /** The npm name of the declaring package — the one that *stays* installed. */
  name: string;
  /** The adapter it is resolved through, and which agent that adapter is for. */
  adapter: string;
  agent: string;
  /**
   * How to reach its `package.json`, which is not the same for the two — see
   * {@link readDeclaredPlatforms}.
   */
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
 * The platform packages a declarer names, as `name → spec`, or null where the
 * chain to its manifest is broken.
 *
 * **Two shapes, both measured, neither derivable from the other.**
 *
 * `@anthropic-ai/claude-agent-sdk` ships an `exports` map with no `./package.json`,
 * so the subpath that reads like the obvious way to do this fails
 * ERR_PACKAGE_PATH_NOT_EXPORTED. What resolves is the bare entry point, and the
 * manifest is found by walking *up* from it to the nearest `package.json` whose
 * `name` is the package's. Today the entry is `sdk.mjs` at the package root, so the
 * first directory is the answer; the walk is for the day an `exports` map points
 * into `dist/`, and the name test is for the `package.json` a build tool drops into
 * such a directory to set `type` — a manifest, but not the one with the
 * declarations on it.
 *
 * `@openai/codex` is an ordinary package that exports its own `package.json`, so
 * the direct read works and the walk would be a longer way to the same file.
 *
 * ⚠ **What each declares is also not the same shape, and the disk check has to
 * know.** The SDK names its platforms outright — `"@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.257"`
 * under the 0.73.0 pin (0.3.220 under 0.63.0) — while codex names *aliases*:
 * `"@openai/codex-darwin-arm64": "npm:@openai/codex@0.152.1-darwin-arm64"` under
 * codex-acp 1.8.0 (0.145.0 under 1.1.9), six
 * prerelease-suffixed versions of the shim's own name. Both spellings are the
 * keys `pnpm-workspace.yaml` overrides, so the comparison of lists is by key; where
 * the two part is {@link pnpmDirPrefix}.
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

/**
 * The `overrides:` block of `pnpm-workspace.yaml`, as `name → replacement`, or
 * null when there is no such block.
 *
 * Hand-parsed for the reason the rest of this file reads YAML with a regex: the
 * root has no YAML dependency and is not getting one for a driver. The block's
 * shape is one `  'name': 'value'` per line at two spaces, ending at the first
 * line that is not indented — a top-level key or a comment at column 0, which is
 * what follows it today. Comments and blank lines *inside* the block are skipped
 * rather than ending it, so a line explaining one entry does not silently halve
 * the list.
 *
 * Read from the workspace file and not from `package.json`, because that is the
 * only place the setting works: `pnpm.overrides` in `package.json` is ignored by
 * pnpm 11.17.0, measured while placing the block (Q4.114). A parser that also
 * accepted the manifest would accept a block that removes nothing.
 */
function readOverrides(yaml: string): Map<string, string> | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (start === -1) return null;
  const out = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\s*$/.test(line) || /^\s+#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s+'([^']+)':\s*'([^']*)'\s*$/.exec(line);
    // A line that is indented and is not an entry is a block this parser does not
    // understand — reported as an entry it cannot read rather than skipped, so the
    // comparison below fails on it instead of quietly running on a shorter list.
    out.set(entry?.[1] ?? `unreadable: ${line.trim()}`, entry?.[2] ?? "");
  }
  return out;
}

/**
 * How `node_modules/.pnpm` would spell a package's directory, from its declared
 * spec — or null for a spec this driver cannot turn into a name.
 *
 * pnpm stores every package as `<name>@<version>` with `/` written `+`, and a
 * peer suffix after `_` where there is one — so a *prefix* is what is matched.
 * For a plain spec the version is left off: the name alone is unambiguous
 * (`@anthropic-ai+claude-agent-sdk-darwin-arm64@` prefixes nothing else) and a
 * check that named the version would go green on a stale one.
 *
 * ⚠ **An alias is stored under the name it aliases, not the key.** In the lockfile
 * this repository had before the exclusion, `@openai/codex-darwin-arm64` resolved
 * to `'@openai/codex@0.145.0-darwin-arm64'`, so the directory was
 * `@openai+codex@0.145.0-darwin-arm64` — a pattern built from the key would have
 * matched nothing while 307 MB sat there. For an alias the version is therefore
 * kept, because the aliased name on its own is the shim that *is* installed.
 */
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
/*
 * The block is documented as removals and nothing else, and a key mapped to
 * anything but `-` is the wrong kind of line for this list: a platform package
 * *pinned* rather than removed is installed at that version, and it would drop out
 * of `excluded` above and read below as a package the adapters declare and the
 * workspace does not exclude — true, and not the sentence that finds the typo.
 */
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
      // Left null and asserted on below: inside the `installed` branch a chain
      // that does not resolve is the failure, and the message names which hop.
    }
    check(`${declarer.name} is reachable through the ${declarer.agent} adapter and declares its platforms`, platforms !== null, true);
    if (platforms === null) {
      readable = false;
      continue;
    }
    // A floor, because an empty declaration would make the list comparison below
    // report every line as stale — true, and the wrong diagnosis.
    check(`and ${declarer.agent}'s declaration names at least one platform`, Object.keys(platforms).length >= 1, true);
    for (const [name, spec] of Object.entries(platforms)) declared.set(name, spec);
  }

  if (readable) {
    const declaredNames = [...declared.keys()].sort();
    // Two directions, two lines, because they are two different mistakes: the
    // first is a download that came back, the second is a line guarding nothing.
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
    // A spec this driver cannot spell as a directory would make the disk check
    // pass vacuously for that package, which is the outcome the header calls worse
    // than no check.
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

/*
 * And the direct dependencies, where the fourth used to be.
 *
 * The four CLIs are read off `deploy/agents.sh` — the `ensure_npm <agent> <package>`
 * calls, which is the one place their npm names are written down — rather than
 * restated here, for the reason this file gives everywhere: a second list drifts.
 * The agents found are then held equal to `AGENT_IDS`, so the pattern cannot rot
 * into matching nothing and passing. `@openai/codex` is a dependency of its
 * adapter and is meant to be — that is the shim the platform packages hang off,
 * and it is what stays installed — so the assertion is about the *root* manifest
 * only, where `opencode-ai` sat until Q4.114.
 */
const agentsSh = read("deploy/agents.sh");
const cliPackages = new Map<string, string>();
for (const m of agentsSh.matchAll(/\bensure_npm ([a-z]+) (\S+) "/g)) {
  if (m[1] !== undefined && m[2] !== undefined) cliPackages.set(m[1], m[2]);
}
check("deploy/agents.sh names an npm package for each of the four", [...cliPackages.keys()].sort(), [...AGENT_IDS].sort());
const manifest = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
check(
  "none of those CLIs is a dependency of the root package.json",
  [...cliPackages.values()]
    .sort()
    .flatMap((pkg) => dependencySections.filter((section) => manifest[section]?.[pkg] !== undefined).map((section) => `${pkg} in ${section}`)),
  [],
);

// ---------------------------------------------------- this release, in six places

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

/*
 * And the daemon's own literal, the sixth and the newest.
 *
 * It exists so a machine can say what it is running: the relay records it off the
 * tunnel handshake and `cpctl admin fleet` reads it back. A fleet inventory that
 * reports the wrong number is worse than no inventory, because a staged rollout
 * is planned from it — "nothing is below v2 any more" is the sentence that
 * decides whether the floor can be raised, and it has to be true.
 *
 * Unlike the control plane's, this one is not also asserted through a served
 * response: no offline driver starts a daemon and a relay together, so the file
 * is the only place to read it.
 */
check(
  "the daemon names the version the workspace is at",
  capture(read("src/version.ts"), /^export const DAEMON_VERSION = "([^"]+)";$/m),
  rootVersion,
);

/*
 * The changelog, read the way `deploy/ci-release.sh` reads it.
 *
 * Both this and that script parse the same headings, so the shape is a contract
 * rather than a convention and `CHANGELOG.md` says so at the top. `[Unreleased]`
 * is asserted to exist for one reason: it is what makes "the newest *released*
 * entry" unambiguous. Without it, a release in progress and a release that shipped
 * are the same line, and the extraction below would hand a release its successor's
 * notes.
 */
const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/gm)]
  .map((m) => m[1])
  .filter((v): v is string => v !== undefined);

check("the CHANGELOG has an Unreleased section to distinguish shipped from pending", /^## \[Unreleased\]$/m.test(changelog), true);
check("the CHANGELOG's newest released entry is the version being shipped", releases[0] ?? null, rootVersion);

/*
 * And that they descend, which catches an entry appended to the bottom.
 *
 * Compared as number triples rather than as strings: `0.10.0` sorts before `0.9.0`
 * lexically, so a string sort here would start failing at the tenth minor and the
 * failure would read as a changelog that is out of order when it is not.
 */
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

/*
 * The section 13 source offer, against the repository this workspace claims.
 *
 * `.git` is stripped and the `git+` prefix required, so this reads
 * `repository.url` and never `bugs.url` two lines under it — which is the same
 * string today and is not the same field, and a check that would accept either is
 * a check that stops noticing when one of them moves.
 */
const sourceUrl = capture(appTs, /^const SOURCE_URL = "([^"]+)";$/m);
const repoUrl = capture(packageJson, /"url":\s*"git\+([^"]+?)(?:\.git)?"/);
check("the source offer's URL is readable at all", sourceUrl !== null, true);
check("the source offer names the repository this workspace says it is", sourceUrl, repoUrl);

/*
 * The version half of that same offer is asserted in `relaycheck` and deliberately
 * not re-read here.
 *
 * That driver asserts it through the **served, unauthenticated response** — it
 * starts a control plane, calls `GET /v1/instance` and compares what came back to
 * `package.json`. Reading the constant here instead would be strictly weaker and
 * would be the second copy this file exists to argue against. What this assertion
 * buys is only that deleting that check cannot quietly leave `app.ts` unchecked:
 * it fails here, naming where the real one lives.
 */
const relaycheckSrc = read("scripts/relaycheck.ts");
check(
  "the served version is still asserted where relaycheck asserts it",
  relaycheckSrc.includes("naming the version it is actually running"),
  true,
);
process.stdout.write("  note  app.ts's VERSION literal is checked by relaycheck, against the response rather than the file\n");


process.stdout.write("\nthe API-key ceiling, on both sides of the wire\n");

/*
 * `MAX_KEYS_PER_USER` is the control plane's refusal — `409 key_limit` on
 * `POST /v1/me/keys` — and `MAX_KEYS` on the keys screen is the same number
 * **mirrored rather than fetched**, so a tap at the ceiling is refused on the
 * screen instead of opening a leaf only to be told no. Mirrored on purpose: a
 * wire addition for a number that has never moved buys nothing (review D11).
 * What the mirror costs is a second copy, and a second copy is this file's
 * whole subject — until this section no driver read both, so the screen could
 * refuse at ten while the control plane allowed twelve, or worse the other way
 * round, with `typecheck` and `webcheck` green. Both are read by the exact
 * declaration, `capture`'s rule: a reformat that hides one fails here rather
 * than passing an empty comparison.
 */
const keysSection = read("packages/web/src/ui/settings/KeysSection.tsx");
const keyCeilingServer = capture(appTs, /^const MAX_KEYS_PER_USER = (\d+);$/m);
const keyCeilingScreen = capture(keysSection, /^const MAX_KEYS = (\d+);$/m);
check("the control plane's key ceiling is readable at all", keyCeilingServer !== null, true);
check("and so is the keys screen's mirror of it", keyCeilingScreen !== null, true);
check("the keys screen refuses at the number the control plane refuses at", keyCeilingScreen, keyCeilingServer);


process.stdout.write("\nthe plugin API, and the one plugin in this repository\n");

/*
 * **There is no second copy of the plugin API version to pin, and that is the
 * point of this section rather than a gap in it.**
 *
 * `packages/web/src/wire.ts` mirrors the plugin *shapes* by hand, as it mirrors
 * the session event union, but it deliberately holds **no** `PLUGIN_API_VERSION`
 * of its own: the client reads the number off `GET /plugins`, so there is nothing
 * to drift. Adding a constant there in order to have something to compare would
 * be manufacturing the second copy this whole file exists to argue against.
 *
 * What *can* go quietly wrong is a plugin this repository ships. `plugins/board`
 * is what `docs/PLUGINS.md` walks through and what somebody trying this feature
 * installs first, and it declares an `api` like any other plugin — so the day
 * `PLUGIN_API_MIN_VERSION` is raised past it, the documented first step stops
 * working, on a machine that is running exactly what the tree says it should.
 *
 * ⚠ **Swept over every directory under `plugins/`, though there is one today, and
 * it was written around the one constant `"board"`.** That is this file's own
 * recorded mistake one subject over: `ADAPTERS` is a loop *because* the version
 * check was written around a single constant and therefore pinned the second
 * adapter nowhere. The same trap was open here, and a second plugin is a thing
 * this tree has already had once — so the loop goes in while the answer is still
 * "one", rather than after somebody has found out. A **floor** under the count
 * comes with it, because finding nothing to check must not read as finding
 * nothing wrong.
 */
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

/*
 * The id in the manifest is also the directory `docs/PLUGINS.md` tells somebody to
 * `tar -C`, so the two have to agree or the documented command builds an archive
 * the daemon then unpacks under a different name.
 */
check(
  "and each one's id is the directory it lives in",
  manifests.filter(([name, one]) => one.id !== name).map(([name, one]) => `${name}: ${String(one.id)}`),
  [],
);
/*
 * And the entry point, which is the other half of what the daemon refuses at
 * install (`entry_missing`) and the only part of a shipped plugin a manifest check
 * cannot see. Cheap here and expensive to find otherwise: a plugin with no
 * `server.js` parses perfectly, installs nowhere, and says so only on the machine
 * somebody is trying it on.
 */
check(
  "and each one has an entry point beside its manifest",
  shipped.filter((name) => !existsSync(new URL(`plugins/${name}/server.js`, root))),
  [],
);

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
