#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The regression driver for a number written down more than once.
 *
 * **Two subjects, and the widening is deliberate rather than incidental.** This
 * file began as the driver for the agent adapters — three copies each — and it now
 * also holds this project's own version, which has five. They are one file because
 * they are one question: *do the places a version is written down agree with each
 * other, and with what is actually there?* The failure mode is identical in both
 * halves and is never a crash — it is two numbers that disagree while everything
 * compiles. A second driver asking that question about a different noun would be
 * the shape the paragraph below already calls out, arriving one level up.
 *
 * Each agent adapter is pinned in the root
 * `package.json` (what the daemon loads), in `pnpm-workspace.yaml`'s
 * `minimumReleaseAgeExclude`, and — the one that matters most — in
 * `node_modules`, which is the only copy that actually runs. The failure when
 * those drift is not a crash: the daemon speaks one version of ACP to an agent
 * built against another, which looks like an agent bug.
 *
 * **Two adapters now, and the file is a loop rather than a constant.** That shape
 * is the point: written around a single `ACP` name, adding codex pinned a second
 * adapter in `package.json` and asserted it nowhere — which is precisely the state
 * the kimi paragraph below calls the real loss, reintroduced one package over.
 *
 * **Two checks were deleted with the container image, and only one of them was a
 * loss.**
 *
 * The image used to install `@anthropic-ai/claude-code` so a tenant had a
 * `claude` binary to log in with, and it had to be the same build the adapter
 * drives — the SDK resolves its own binary internally, and the two reading
 * different credential formats surfaces as "the login worked and the session says
 * logged out". That check is not merely gone, it is **unnecessary**: with no
 * image, the `claude` a person logs in with is whatever `CLAUDE_CODE_EXECUTABLE`
 * or PATH resolves, and the SDK resolves the same one for the adapter. The
 * property is now structural rather than asserted, which is a better outcome than
 * a passing test — written down here so nobody re-adds the check by reflex.
 *
 * kimi is the real loss. Its version was pinned in the image and nowhere else,
 * and it is resolved from PATH now, so **nothing records which build the
 * measurements in this repository were taken against.** There is no mechanism
 * that could pin it; see `CLAUDE.md`'s Next section.
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
 * One adapter, and how to reach the CLI it brings with it.
 *
 * The CLI hop is per-adapter because the two packages are laid out differently and
 * neither layout is guessable — see {@link readCliVersion}.
 */
interface Adapter {
  /** The npm name, which is also how it is written down in both files. */
  name: string;
  /** Which agent it adapts. Output only. */
  agent: string;
  /** The CLI it vendors, and which of the two shapes reading its version takes. */
  cli: { name: string; via: "manifest-beside-entry" | "own-package-json" };
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: "@agentclientprotocol/claude-agent-acp",
    agent: "claude",
    cli: { name: "@anthropic-ai/claude-agent-sdk", via: "manifest-beside-entry" },
  },
  {
    name: "@agentclientprotocol/codex-acp",
    agent: "codex",
    cli: { name: "@openai/codex", via: "own-package-json" },
  },
];

/**
 * The version of the CLI an adapter would actually load, or null.
 *
 * Resolved *through* the adapter rather than from here, and both packages are
 * transitive dependencies, so pnpm's strict layout means the root cannot resolve
 * either — the same reason `jose` is in the lockfile and `token.ts` is hand-rolled
 * on node:crypto. Asking the adapter is also the more honest question: the version
 * that matters is the one it would load.
 *
 * **Two shapes, both measured, neither derivable from the other.**
 *
 * `@anthropic-ai/claude-agent-sdk` ships an `exports` map with no `./package.json`
 * and no `./manifest.json`, so every subpath specifier fails
 * ERR_PACKAGE_PATH_NOT_EXPORTED — including the one that reads like the obvious way
 * to do this. What resolves is the bare entry point; the manifest is a file beside
 * it. (The adapter, inversely, exports only `./package.json` and not its own entry,
 * which is why the hops here look wrong until you try the symmetric version.)
 *
 * `@openai/codex` is an ordinary package that exports its own `package.json`, so
 * the direct read works and the manifest dance would fail. It is also a *direct*
 * dependency of its adapter rather than an optional platform variant, which is what
 * makes one resolve enough where claude's needs a candidate list at runtime.
 */
function readCliVersion(adapterPkgPath: string, cli: Adapter["cli"]): string | null {
  const fromAdapter = createRequire(adapterPkgPath);
  let parsed: unknown;
  switch (cli.via) {
    case "manifest-beside-entry": {
      const entry = fromAdapter.resolve(cli.name);
      parsed = JSON.parse(readFileSync(new URL("manifest.json", pathToFileURL(entry)), "utf8"));
      break;
    }
    case "own-package-json": {
      parsed = JSON.parse(readFileSync(fromAdapter.resolve(`${cli.name}/package.json`), "utf8"));
      break;
    }
  }
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}

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
 * resolution hops are what an adapter or CLI bump breaks. In CI it is worse still:
 * `pnpm install --frozen-lockfile` has definitely run by the time this step does,
 * so there the null can only mean the chain is broken.
 *
 * A fresh clone still skips, which is the case the tolerance was written for.
 */
const installed = existsSync(new URL("node_modules", root));

process.stdout.write("\nthe adapters actually installed, against the ones written down\n");

if (!installed) {
  process.stdout.write("  skip  nothing is installed (run pnpm install)\n");
} else {
  const fromRoot = createRequire(new URL("package.json", root));
  for (const adapter of ADAPTERS) {
    let installedAdapter: string | null = null;
    let cliVersion: string | null = null;
    try {
      const adapterPkgPath = fromRoot.resolve(`${adapter.name}/package.json`);
      const adapterPkg: unknown = JSON.parse(readFileSync(adapterPkgPath, "utf8"));
      const adapterVersion = (adapterPkg as { version?: unknown }).version;
      installedAdapter = typeof adapterVersion === "string" ? adapterVersion : null;
      cliVersion = readCliVersion(adapterPkgPath, adapter.cli);
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
    // The CLI hop is kept even with nothing to compare its version *to*, because a
    // broken resolution chain is exactly what an adapter or CLI bump breaks — and
    // `LocalRuntime.resolveLoginBinary` drives the binary it names.
    check(`the ${adapter.agent} CLI the adapter loads is still resolvable`, cliVersion !== null, true);
  }
}

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
 * What *can* go quietly wrong is the reference plugin. `plugins/board` is what
 * `docs/PLUGINS.md` walks through and what somebody trying this feature installs
 * first, and it declares an `api` like any other plugin — so the day
 * `PLUGIN_API_MIN_VERSION` is raised past it, the documented first step stops
 * working, on a machine that is running exactly what the tree says it should.
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

const boardManifest = JSON.parse(read("plugins/board/plugin.json")) as { api?: number; id?: string; version?: string };
check("the reference plugin declares an API version", typeof boardManifest.api === "number", true);
check(
  "and this daemon would still install it",
  apiMin !== null &&
    apiVersion !== null &&
    typeof boardManifest.api === "number" &&
    boardManifest.api >= Number(apiMin) &&
    boardManifest.api <= Number(apiVersion),
  true,
);

/*
 * The id in the manifest is also the directory `docs/PLUGINS.md` tells somebody to
 * `tar -C`, so the two have to agree or the documented command builds an archive
 * the daemon then unpacks under a different name.
 */
check("the reference plugin's id is the directory it lives in", boardManifest.id, "board");

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
