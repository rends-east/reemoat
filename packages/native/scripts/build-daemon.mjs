/**
 * Stages the daemon (runtime, dependencies, source) into `target/Helpers` and `target/daemon`.
 * Its own step rather than a `beforeBuildCommand`: `build.rs` reads both, so every cargo
 * invocation, clippy and test included, needs them first (`pnpm native:stage`).
 *
 * npm builds the tree because the bundler copies no symlink and pnpm's shims bake absolute
 * paths. Versions are the ones the root `pnpm install` chose, read off `node_modules`.
 * `--omit=optional` drops the agents' platform packages (Q4.114) and esbuild's binary, which is
 * added back per target. The runtime is nodejs.org's, checksum-verified: Homebrew's node links
 * Homebrew dylibs.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** An LTS line at or above `engines.node`, which `pincheck` asserts. */
const NODE_VERSION = "v24.21.0";

const NODE_DIST = "https://nodejs.org/dist";

/**
 * Every desktop triple stays, even those that ship no daemon: `nativecheck` asserts each row
 * names an esbuild binary. A Windows triple is refused by name below, as a decision.
 */
const TARGETS = {
  "aarch64-apple-darwin": { dir: "darwin-arm64", archive: "tar.gz", esbuild: "@esbuild/darwin-arm64" },
  "x86_64-apple-darwin": { dir: "darwin-x64", archive: "tar.gz", esbuild: "@esbuild/darwin-x64" },
  "aarch64-unknown-linux-gnu": { dir: "linux-arm64", archive: "tar.gz", esbuild: "@esbuild/linux-arm64" },
  "x86_64-unknown-linux-gnu": { dir: "linux-x64", archive: "tar.gz", esbuild: "@esbuild/linux-x64" },
  "aarch64-pc-windows-msvc": { dir: "win-arm64", archive: "zip", esbuild: "@esbuild/win32-arm64" },
  "x86_64-pc-windows-msvc": { dir: "win-x64", archive: "zip", esbuild: "@esbuild/win32-x64" },
};

/** A devDependency the payload runs under: `src/plugins/runtime.ts` forks a `.ts` file. */
const EXTRA_DEV_DEPS = ["tsx"];

/** No `package.json`: {@link installDependencies} writes the payload's own. */
const SOURCE_TREES = ["src", "scripts", "deploy"];
const SOURCE_FILES = ["tsconfig.json"];

const here = fileURLToPath(new URL(".", import.meta.url));
const nativeRoot = join(here, "..");
const repoRoot = join(nativeRoot, "..", "..");
const tauriRoot = join(nativeRoot, "src-tauri");
// Outside `target/`, which `Swatinem/rust-cache` prunes of unknown contents before saving.
const cacheDir = join(tauriRoot, ".node-cache");
const stageDir = join(tauriRoot, "target", "daemon");
const binariesDir = join(tauriRoot, "binaries");
/**
 * `target/Helpers` because `target/` stands where `Contents/` stands, so one relative path
 * works in a bundle and a dev build. The name is in three more places, which `nativecheck` compares.
 */
const RUNTIME_HELPER = "Reemoat Runtime.app";
const helpersDir = join(tauriRoot, "target", "Helpers");

const triple = process.argv[2] ?? defaultTriple();
const target = TARGETS[triple];
if (target === undefined) {
  fail(`no Node build is mapped for ${triple}. Add it to TARGETS in ${relative(repoRoot, fileURLToPath(import.meta.url))}.`);
}
if (target.archive !== "tar.gz") {
  fail(
    `${triple} is a client-only target: this app carries no daemon there.\n` +
      "  tauri.windows.conf.json removes externalBin and resources, so nothing in that bundle\n" +
      "  would read a payload staged here. docs/NATIVE.md's *What runs where* has the reason,\n" +
      "  and it is not packaging: a bundled daemon cannot be stopped cleanly on Windows.\n" +
      "\n" +
      `  If that ever changes, a ${target.archive} archive is only the first of three\n` +
      "  differences — Windows also puts node.exe at the archive root rather than under bin/,\n" +
      "  and the staged binary needs an .exe suffix. Refusing rather than staging something\n" +
      "  that cannot run.",
  );
}

function defaultTriple() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-${process.platform}`;
}

function fail(message) {
  process.stderr.write(`build-daemon: ${message}\n`);
  process.exit(1);
}

function step(message) {
  process.stdout.write(`  ${message}\n`);
}

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", ...options });
  if (done.error) fail(`${command} could not be run: ${done.error.message}`);
  if (done.status !== 0) fail(`${command} ${args.join(" ")} exited ${done.status}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Valid only if the binary is there: a pruner or an interrupted `tar` can leave the directory empty. */
function fetchRuntime() {
  const name = `node-${NODE_VERSION}-${target.dir}`;
  const archive = join(cacheDir, `${name}.${target.archive}`);
  const extracted = join(cacheDir, name);
  const binary = join(extracted, "bin", "node");
  if (existsSync(binary)) {
    step(`runtime ${NODE_VERSION} ${target.dir} (cached)`);
    return extracted;
  }
  if (existsSync(extracted)) {
    step(`cached runtime at ${relative(repoRoot, extracted)} has no bin/node — refetching`);
    rmSync(extracted, { recursive: true, force: true });
  }
  mkdirSync(cacheDir, { recursive: true });

  const url = `${NODE_DIST}/${NODE_VERSION}/${name}.${target.archive}`;
  step(`downloading ${url}`);
  run("curl", ["-fsSL", "--retry", "3", "-o", archive, url]);

  const sums = join(cacheDir, `SHASUMS256-${NODE_VERSION}.txt`);
  run("curl", ["-fsSL", "--retry", "3", "-o", sums, `${NODE_DIST}/${NODE_VERSION}/SHASUMS256.txt`]);
  const wanted = readFileSync(sums, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === `${name}.${target.archive}`)?.[0];
  if (wanted === undefined) fail(`SHASUMS256.txt for ${NODE_VERSION} does not list ${name}.${target.archive}`);
  const got = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (got !== wanted) fail(`checksum mismatch for ${name}.${target.archive}\n  expected ${wanted}\n  got      ${got}`);
  step(`checksum ok (${got.slice(0, 16)}…)`);

  run("tar", ["xzf", archive, "-C", cacheDir]);
  if (!existsSync(binary)) fail(`${archive} did not extract a runtime to ${extracted}`);
  return extracted;
}

/** At the installed versions: a payload built from ranges is not the program the drivers checked. */
function entryVersions() {
  const manifest = readJson(join(repoRoot, "package.json"));
  // Workspace packages are copied by `copySource`: the registry has none, and `file:` installs a symlink.
  const names = [...Object.keys(manifest.dependencies ?? {}), ...EXTRA_DEV_DEPS].filter(
    (name) => !name.startsWith("@reemoat/"),
  );
  const pinned = {};
  for (const name of names) {
    const installed = join(repoRoot, "node_modules", name, "package.json");
    if (!existsSync(installed)) {
      fail(`${name} is not installed. Run \`pnpm install\` at the repository root first.`);
    }
    pinned[name] = readJson(installed).version;
  }
  const esbuild = target.esbuild;
  // The one range: npm resolves it against the esbuild tsx brings.
  pinned[esbuild] = "*";
  return pinned;
}

/** With the bundled npm, so platform binaries are picked for the build being staged. */
function installDependencies(runtime, versions) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  // Derived from the repository's, so `type: "module"` cannot be lost.
  const manifest = readJson(join(repoRoot, "package.json"));
  delete manifest.devDependencies;
  delete manifest.scripts;
  manifest.dependencies = versions;
  writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const node = join(runtime, "bin", "node");
  const npm = join(runtime, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  step("installing payload dependencies");
  run(node, [npm, "install", "--omit=optional", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: stageDir,
    env: { ...process.env, PATH: `${join(runtime, "bin")}:${process.env.PATH ?? ""}` },
  });
}

/**
 * pnpm's `patchedDependencies`, applied to this npm tree too (Q6.121).
 * `GIT_CEILING_DIRECTORIES`: inside this checkout `git apply` reads paths against the repository root and silently skips them.
 */
function applyPatches() {
  const lines = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "patchedDependencies:");
  if (start < 0) return;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s+'?((?:@[^/\s']+\/)?[^@\s']+)@([^'\s]+)'?:\s*(\S+)\s*$/.exec(line);
    if (entry === null) fail(`pnpm-workspace.yaml: unreadable patchedDependencies line ${JSON.stringify(line.trim())}`);
    const [, name, version, patch] = entry;
    const dir = ["node_modules", ...name.split("/")].join("/");
    const installed = readJson(join(stageDir, dir, "package.json")).version;
    if (installed !== version) fail(`${name} is patched at ${version}, but the payload installed ${installed}`);
    step(`patching ${name}@${version}`);
    run("git", ["apply", "-p1", `--directory=${dir}`, join(repoRoot, patch)], {
      cwd: stageDir,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(stageDir) },
    });
  }
}

/** A tree, not a bundle: `schema.sql` and `deploy/agents.sh` are read relative to their importers. */
function copySource(runtime) {
  for (const tree of SOURCE_TREES) {
    cpSync(join(repoRoot, tree), join(stageDir, tree), { recursive: true, dereference: true });
  }
  for (const file of SOURCE_FILES) {
    cpSync(join(repoRoot, file), join(stageDir, file));
  }

  // `deploy/agents.sh` installs kimi and the `REEMOAT_AGENT_SOURCE=npm` arm through npm.
  cpSync(join(runtime, "lib", "node_modules", "npm"), join(stageDir, "node_modules", "npm"), {
    recursive: true,
    dereference: true,
  });

  // A real directory, after npm has finished pruning `node_modules`. `pincheck` holds the two declarations
  // of `@noble/*` to one version. Only the sources: its own `node_modules` is pnpm links.
  const protocol = join(stageDir, "node_modules", "@reemoat", "protocol");
  mkdirSync(protocol, { recursive: true });
  cpSync(join(repoRoot, "packages", "protocol", "package.json"), join(protocol, "package.json"));
  cpSync(join(repoRoot, "packages", "protocol", "src"), join(protocol, "src"), {
    recursive: true,
    dereference: true,
  });
}

/** A shim, not a link (the bundler copies no symlink) or a second 122 MB copy of the runtime. */
function placeRuntime(runtime) {
  const node = join(runtime, "bin", "node");

  // Paths quoted: the helper's name has a space. No PATH fallback: `daemon_path` puts this
  // directory first on PATH, so `exec node` would re-exec this shim for ever.
  const binDir = join(stageDir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "node"),
    `#!/bin/sh\n` +
      `# Generated by packages/native/scripts/build-daemon.mjs.\n` +
      `# The runtime itself is the one in the ${RUNTIME_HELPER} helper; this only finds it.\n` +
      `basedir=$(dirname "$0")\n` +
      `for candidate in "$basedir/../../../../Helpers/${RUNTIME_HELPER}/Contents/MacOS/node" "$basedir/../../../node"; do\n` +
      `  [ -x "$candidate" ] && exec "$candidate" "$@"\n` +
      `done\n` +
      `echo "reemoat: the bundled Node runtime was not found beside this payload" >&2\n` +
      `exit 127\n`,
  );
  chmodSync(join(binDir, "node"), 0o755);

  if (triple.endsWith("-apple-darwin")) {
    stageHelper(node);
  } else {
    mkdirSync(binariesDir, { recursive: true });
    const external = join(binariesDir, `node-${triple}`);
    cpSync(node, external);
    chmodSync(external, 0o755);
  }
  step(`runtime placed once (${(statSync(node).size / 1e6).toFixed(0)} MB), reached by a shim in the payload`);
}

/**
 * A helper bundle with `LSUIElement`, or every process npm titles became a Dock tile of
 * Reemoat.app (native-packaging.md). Signed here: the bundler copies it unsigned.
 */
function stageHelper(node) {
  const helper = join(helpersDir, RUNTIME_HELPER);
  const contents = join(helper, "Contents");
  rmSync(helper, { recursive: true, force: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  cpSync(join(tauriRoot, "runtime", "Info.plist"), join(contents, "Info.plist"));
  cpSync(node, join(contents, "MacOS", "node"));
  chmodSync(join(contents, "MacOS", "node"), 0o755);
  signHelper(helper);
}

/**
 * With the bundler's `APPLE_SIGNING_IDENTITY`, else ad-hoc. `APPLE_CERTIFICATE` alone is refused:
 * the bundler imports it only during `tauri build`, after this runs.
 */
function signHelper(helper) {
  if (process.platform !== "darwin") {
    fail(`${triple} is staged as a signed helper app, and only macOS has codesign. Stage it on a Mac.`);
  }
  const identity = process.env.APPLE_SIGNING_IDENTITY || "-";
  if (identity === "-" && process.env.APPLE_CERTIFICATE) {
    fail(
      "APPLE_CERTIFICATE is set and APPLE_SIGNING_IDENTITY is not.\n" +
        "  The bundler imports that certificate into its own keychain during tauri build, after\n" +
        "  this step has run, so the runtime would be signed ad-hoc inside a Developer ID app and\n" +
        "  notarization would refuse it. Import the certificate into a keychain on the search list\n" +
        "  and export APPLE_SIGNING_IDENTITY with its name.",
    );
  }
  run("codesign", [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    "--entitlements",
    join(tauriRoot, "entitlements-node.plist"),
    identity === "-" ? "--timestamp=none" : "--timestamp",
    helper,
  ]);
  run("codesign", ["--verify", "--strict", helper]);
  step(`runtime helper signed ${identity === "-" ? "ad-hoc" : `as ${identity}`} with entitlements-node.plist`);
}

/** npm's `.bin` symlinks become relative shims. */
function regenerateShims() {
  const binDir = join(stageDir, "node_modules", ".bin");
  let written = 0;
  for (const name of readdirSync(binDir)) {
    const path = join(binDir, name);
    if (!lstatSync(path).isSymbolicLink()) continue;
    const targetPath = readlinkSync(path);
    rmSync(path);
    writeFileSync(
      path,
      `#!/bin/sh\n` +
        `# Generated by packages/native/scripts/build-daemon.mjs. Relative on purpose.\n` +
        `basedir=$(dirname "$0")\n` +
        `exec "$basedir/node" "$basedir/${targetPath}" "$@"\n`,
    );
    chmodSync(path, 0o755);
    written += 1;
  }

  // Beside `node`: `deploy/agents.sh` takes the node beside npm as the runtime.
  writeFileSync(
    join(binDir, "npm"),
    `#!/bin/sh\n` +
      `# Generated by packages/native/scripts/build-daemon.mjs. Relative on purpose.\n` +
      `basedir=$(dirname "$0")\n` +
      `exec "$basedir/node" "$basedir/../npm/bin/npm-cli.js" "$@"\n`,
  );
  chmodSync(join(binDir, "npm"), 0o755);
  step(`regenerated ${written} bin shim${written === 1 ? "" : "s"}, plus npm`);
}

/** `AGENT_LOGIN[*].command`'s set, which `nativecheck` compares. */
const AGENT_CLIS = ["claude", "kimi", "codex", "opencode", "grok", "cursor-agent"];

/**
 * npm writes a `.bin/codex` whose platform package `--omit=optional` dropped, and `.bin` is
 * first on the daemon's PATH, so it shadowed the person's own CLI (Q4.114). A denylist: what
 * the adapters need may be renamed.
 */
function pruneAgentClis() {
  const binDir = join(stageDir, "node_modules", ".bin");
  const pruned = [];
  for (const name of AGENT_CLIS) {
    const path = join(binDir, name);
    if (!existsSync(path)) continue;
    rmSync(path);
    pruned.push(name);
  }
  step(pruned.length === 0 ? "no agent CLI shims to prune" : `pruned ${pruned.join(", ")} from .bin`);
}

/** A symlink would fail `build.rs` as "is not a file", read as a broken Rust build. */
function assertNoSymlinks() {
  const offenders = [];
  const sweep = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) offenders.push(relative(stageDir, path));
      else if (entry.isDirectory()) sweep(path);
    }
  };
  sweep(stageDir);
  if (offenders.length > 0) {
    fail(
      `the payload holds ${offenders.length} symlink(s), which the bundler cannot copy:\n` +
        `${offenders.slice(0, 10).map((p) => `    ${p}`).join("\n")}` +
        `${offenders.length > 10 ? `\n    … and ${offenders.length - 10} more` : ""}`,
    );
  }
}

function payloadSize() {
  let bytes = 0;
  const sweep = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sweep(path);
      else if (entry.isFile()) bytes += statSync(path).size;
    }
  };
  sweep(stageDir);
  return bytes;
}

process.stdout.write(`build-daemon: staging for ${triple}\n`);
const runtime = fetchRuntime();
installDependencies(runtime, entryVersions());
applyPatches();
copySource(runtime);
placeRuntime(runtime);
regenerateShims();
pruneAgentClis();
assertNoSymlinks();
process.stdout.write(
  `  payload ${(payloadSize() / 1e6).toFixed(0)} MB at ${relative(repoRoot, stageDir)}\n`,
);
