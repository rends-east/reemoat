/**
 * Stage the daemon — runtime, dependencies and source — for embedding in the app.
 *
 * `node scripts/build-daemon.mjs`, from this package. It writes two things and
 * nothing else — the runtime, and the payload:
 *
 *   src-tauri/target/Helpers/Reemoat Runtime.app   the runtime on macOS, as a signed
 *                                                  helper app, for `bundle.macOS.files`
 *   src-tauri/binaries/node-<target-triple>        the runtime for any other triple,
 *                                                  which no overlay ships today
 *   src-tauri/target/daemon/                       the payload, for `bundle.resources`
 *
 * **This is its own step rather than a `beforeBuildCommand`, and that is the one
 * structural thing to know about it.** `build-frontend.mjs` can be a
 * `beforeBuildCommand` because `frontendDist` is read by the *bundler*. The payload
 * and the runtime are not: `tauri-build` copies `bundle.resources` from inside
 * `build.rs` (`copy_resources`), and this crate's own `build.rs` refuses a macOS
 * build whose runtime helper is missing or staged for another architecture — so
 * both are read by **cargo**, and a missing staging directory fails `cargo clippy`,
 * `cargo test` and `tauri build --no-bundle` — all three of which the `native` CI
 * job runs — long before anything is bundled. So this has to run ahead of every
 * cargo invocation, which is what `pnpm native:stage` is for.
 *
 * ## Why npm builds the tree when this repository is a pnpm repository
 *
 * Two independent reasons, both measured on this checkout, and either alone
 * decides it.
 *
 * **A pnpm tree cannot be copied.** `tauri-build`'s `copy_file` refuses anything
 * that is not a regular file, and its walker does not follow links — a symlinked
 * directory reads as a file, `is_file()` answers false, and the build dies with
 * `"… is not a file"`. pnpm's whole layout is symlinks into `.pnpm`.
 *
 * **A pnpm tree cannot be moved.** Its bin shims bake an absolute `NODE_PATH`:
 * this checkout's `node_modules/.bin/claude-agent-acp` exports
 * `/Users/rends/reemoat-prod/app/node_modules/.pnpm/…`. A shim copied into a
 * `.app` names a path on the machine that built it. `deploy/docker/Dockerfile`
 * records the same finding for `tsx` and answers it by installing and running at
 * one path; an app bundle has no such luxury, because the install path and the
 * run path are on different computers.
 *
 * npm produces what is needed instead: a real-file tree with correct nesting and
 * no symlinks outside `.bin` — verified here, not assumed, by
 * {@link assertNoSymlinks} at the end.
 *
 * ⚠ **Versions come from the root `package.json` and the installed tree, never
 * from a range resolved fresh.** `entryVersions` reads each dependency's *actual*
 * installed version out of `node_modules`, so the payload carries what
 * `pnpm install --frozen-lockfile` chose. A `^` resolved by npm against the
 * registry would make the bundled daemon a different program from the one every
 * driver in this repository just checked. It therefore requires that a root
 * `pnpm install` has happened, and says so rather than guessing.
 *
 * ## Three things the payload needs that are not obvious
 *
 * **`tsx` is a runtime dependency even though it is a devDependency.** Nothing
 * here has a build step — running from source under tsx is what a deployment of
 * this *is* — and `src/plugins/runtime.ts` `fork()`s `./runner.ts`, a TypeScript
 * file, at runtime. `deploy/docker/Dockerfile` states the same rule for the same
 * reason ("No --prod, and that is load-bearing rather than lazy"). `typescript`
 * is **not** needed: nothing in `src/` or `scripts/` imports it, and tsx compiles
 * with esbuild.
 *
 * **`--omit=optional`, with esbuild's platform binary added back by hand.** The two
 * ACP adapters pull a coding-agent CLI each as *optional* platform packages —
 * `@anthropic-ai/claude-agent-sdk-*` and `@openai/codex-*`, 552 MB of the two on
 * this architecture — which `pnpm-workspace.yaml`'s `overrides` remove from the
 * pnpm tree and Q4.114 argues at length: `deploy/agents.sh` installs and updates
 * those CLIs from the vendors, and the pinned copy is never the one that runs.
 * npm has no equivalent of pnpm's `'-'`, so the whole optional set is dropped —
 * and `deploy/docker/Dockerfile` already measured what that costs on its own
 * ("`--no-optional` would take esbuild's own platform binary with it and break
 * `tsx`"), so esbuild's binary is named as a direct dependency to bring exactly
 * that one back — per target, in `TARGETS`, because the right package differs by
 * platform and a single constant would ship a `tsx` with no compiler behind it on
 * every target but the one it was written for.
 *
 * **`.bin` is regenerated rather than copied.** npm writes symlinks there, which
 * Tauri cannot copy; pnpm writes shims with absolute paths, which do not move.
 * So this writes its own: three lines, relative, `exec`ing the `node` that sits
 * beside them. That last part is what makes the payload work with an **empty
 * PATH** — `src/acp/agents.ts` spawns `node_modules/.bin/claude-agent-acp` as a
 * command, and a launchd job started by an app has whatever environment the app
 * gave it and no profile.
 *
 * ## The runtime is downloaded, not copied from this machine
 *
 * `process.execPath` here is Homebrew's, and `otool -L` on it names seven
 * Homebrew dylibs (`@rpath/libnode.147.dylib`, `libuv`, `libada`, …). Copying it
 * produces a bundle that runs on the machine that built it and nowhere else. The
 * official build is one self-contained binary against `CoreFoundation`,
 * `Security`, `libc++` and `libSystem`, and it ships npm — which `deploy/agents.sh`
 * needs, since kimi is always installed from the registry and is skipped with a
 * warning when there is no `npm`.
 *
 * The download is checksum-verified against the release's own `SHASUMS256.txt`.
 * It is an executable that will be signed with this project's identity and run as
 * the user; taking it on trust from a redirect is not a thing to do quietly.
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
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The runtime that ships.
 *
 * ⚠ **Written down here and asserted by `pincheck`**, which is the rule every
 * other version in this repository already follows. Node 24 because `package.json`
 * says `engines.node >= 24` — `node:sqlite` is behind a flag on 22, and this
 * daemon's entire store is that module — and because 24 is the active LTS, which
 * is the line a shipped desktop application should be on rather than current.
 */
const NODE_VERSION = "v24.21.0";

/** Where the official build comes from. */
const NODE_DIST = "https://nodejs.org/dist";

/**
 * Which build to fetch, per Rust target triple.
 *
 * On macOS the runtime is staged into one helper whatever the triple —
 * `bundle.macOS.files` names a fixed path — so the triple is no longer in the
 * file's name, and `build.rs` is what refuses a helper staged for the other
 * architecture by reading the Mach-O header of the binary itself. Any other
 * triple keeps the `<name>-<target-triple>` file an `externalBin` resolves.
 *
 * ⚠ **This project is not macOS-only, and this table is where that stops being a
 * comment and starts being work.** `docs/NATIVE.md` lists macOS, Windows and Linux
 * as supported and iOS and Android as prepared. What is macOS-arm64-only is *this
 * checkout* — a Homebrew toolchain with no `rustup`, so there is one target
 * installed — and conflating "what this machine can build" with "what this app
 * targets" is exactly the mistake that makes a cross-platform product accumulate
 * macOS-shaped decisions.
 *
 * So every desktop triple is named here with the archive it needs, and the one
 * shape this script cannot unpack is refused **by name**.
 *
 * ⚠ **That refusal is a decision now rather than an unfinished job, and the
 * distinction matters to whoever reads it next.** Windows ships as a *client*
 * build — `tauri.windows.conf.json` carries no `externalBin` and no `resources`,
 * so nothing there would read a payload staged for it — and the reason is older
 * than packaging: `docs/NATIVE.md`'s *What runs where* refuses Windows as a daemon
 * **host** because there is no way to stop a bundled daemon cleanly there, and
 * `deploy/install.sh` has no supervisor to install into either. The three
 * differences a Windows payload would have to answer are recorded in the refusal
 * below, so that they are still written down on the day somebody changes that.
 *
 * The rows stay in this table regardless. `pnpm nativecheck` counts them and
 * asserts every one names an esbuild binary — an assertion that would go vacuous
 * the moment the table described one platform.
 */
const TARGETS = {
  "aarch64-apple-darwin": { dir: "darwin-arm64", archive: "tar.gz", esbuild: "@esbuild/darwin-arm64" },
  "x86_64-apple-darwin": { dir: "darwin-x64", archive: "tar.gz", esbuild: "@esbuild/darwin-x64" },
  "aarch64-unknown-linux-gnu": { dir: "linux-arm64", archive: "tar.gz", esbuild: "@esbuild/linux-arm64" },
  "x86_64-unknown-linux-gnu": { dir: "linux-x64", archive: "tar.gz", esbuild: "@esbuild/linux-x64" },
  "aarch64-pc-windows-msvc": { dir: "win-arm64", archive: "zip", esbuild: "@esbuild/win32-arm64" },
  "x86_64-pc-windows-msvc": { dir: "win-x64", archive: "zip", esbuild: "@esbuild/win32-x64" },
};

/**
 * The runtime dependency set, by name.
 *
 * Read from the root `package.json` rather than listed, so a dependency added to
 * the daemon reaches the payload without anybody remembering this file. `tsx` is
 * the one devDependency that is a runtime dependency; see the header.
 */
const EXTRA_DEV_DEPS = ["tsx"];

/**
 * What is copied out of the repository, verbatim.
 *
 * `package.json` is deliberately **not** here: the payload's manifest is written
 * by {@link installDependencies} from the repository's, with the dependency list
 * replaced by the resolved one. Copying the repository's over it afterwards would
 * leave npm's `node_modules` described by a manifest naming ranges it did not
 * install, and would put a `devDependencies` block in a tree that has none.
 */
const SOURCE_TREES = ["src", "scripts", "deploy"];
const SOURCE_FILES = ["tsconfig.json"];

const here = fileURLToPath(new URL(".", import.meta.url));
const nativeRoot = join(here, "..");
const repoRoot = join(nativeRoot, "..", "..");
const tauriRoot = join(nativeRoot, "src-tauri");
/*
 * ⚠ **Outside `target/`, and it was inside it.** `Swatinem/rust-cache` treats
 * every subdirectory of `target/` as a build profile and cleans what it does not
 * recognise before saving — so a green CI run saved `node-cache/` with the
 * directory tree intact and the 130 MB binary gone, and the next run restored
 * that shell, read it as a cache, and died two functions later on
 * `spawnSync … ENOENT`.
 *
 * The docblock on {@link fetchRuntime} used to argue for `target/` on the grounds
 * that `cargo clean` then discards it, *"which is the right trade for a 50 MB
 * archive"*. That trade was priced without knowing another tool owns that
 * directory. It is reversed here: `cargo clean` no longer discards the runtime —
 * delete this directory by hand for that — and in exchange the download happens
 * when {@link NODE_VERSION} moves rather than on every CI run.
 *
 * `fetchRuntime` validates by the binary regardless, so this is the cost fix and
 * that is the correctness one. Neither replaces the other.
 */
const cacheDir = join(tauriRoot, ".node-cache");
const stageDir = join(tauriRoot, "target", "daemon");
const binariesDir = join(tauriRoot, "binaries");
/**
 * The helper app the runtime lives in on macOS, and where it is staged.
 *
 * ⚠ **`target/Helpers`, because `target/` stands where `Contents/` stands.** The
 * payload is `Contents/Resources/daemon` in a bundle and `target/<profile>/daemon`
 * in a development build — two levels below each — so one relative path reaches
 * the runtime from the payload in both, and one reaches it from the executable:
 * `<exe>/../../Helpers/…` is `Contents/Helpers` beside `Contents/MacOS`, and
 * `target/Helpers` beside `target/<profile>`. A development build with another
 * target directory gets its copy from `build.rs`, the way `tauri-build` copies
 * an `externalBin` into the profile directory.
 *
 * The name is written down in three more places — `bundle.macOS.files` in
 * `tauri.conf.json`, `daemon.rs` and `build.rs` — and `nativecheck` compares all
 * four, because a helper staged under one name and looked for under another is a
 * bundle that builds, signs and then starts no daemon.
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

/**
 * The triple this machine builds for when nothing says otherwise.
 *
 * Derived rather than defaulted to macOS, because a default that names one
 * platform is how a cross-platform project quietly becomes a single-platform one.
 */
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

/** `spawnSync` that refuses to continue past a failure. */
function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: "inherit", ...options });
  if (done.error) fail(`${command} could not be run: ${done.error.message}`);
  if (done.status !== 0) fail(`${command} ${args.join(" ")} exited ${done.status}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* ── the runtime ─────────────────────────────────────────────────────────── */

/**
 * The official Node build, downloaded once and kept.
 *
 * Cached beside the crate rather than under `target/` — see {@link cacheDir} for
 * which tool made that necessary — so it survives `cargo clean` and is refetched
 * only when {@link NODE_VERSION} moves.
 *
 * ⚠ **A cache is valid only if the thing it caches is there, and this asked the
 * directory instead.** `existsSync(extracted)` answered `true` for a directory
 * that had been emptied, so this reported *(cached)* and handed back a tree with
 * no `bin/node` in it — and the failure surfaced two functions later as
 * `spawnSync … ENOENT` on a path whose own name says "cache", which reads as a
 * corrupt download rather than as a cache that was never checked.
 *
 * Two ways in, and the second is why this is a bug rather than a CI quirk.
 * `Swatinem/rust-cache` **prunes `target/`** before saving it, so a green run
 * saves the directory without its 130 MB binary and the *next* run restores the
 * shell — which is exactly what happened, and the run that broke was the first
 * one to restore a cache the run before it had poisoned. And locally: `run()`
 * aborts the whole script on a non-zero exit, so an interrupted `tar` leaves a
 * partial directory behind that every later run then trusts.
 *
 * So the question is asked of the **file that is about to be executed**, and a
 * directory that cannot answer it is removed rather than worked around. That
 * makes this self-healing against any pruner, any interrupted extraction, and
 * anything else that takes the contents without taking the name.
 */
function fetchRuntime() {
  const name = `node-${NODE_VERSION}-${target.dir}`;
  const archive = join(cacheDir, `${name}.${target.archive}`);
  const extracted = join(cacheDir, name);
  // The one file everything downstream needs: `placeRuntime` copies it to
  // `binaries/`, and `installDependencies` spawns it to run npm.
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

  // Verified against the release's own manifest before anything is extracted.
  // This binary is signed with this project's identity and runs as the user.
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
  // Asked of the binary rather than the directory, for the reason above: an
  // archive that produced a name and no contents must fail here, loudly, rather
  // than two functions later as an ENOENT on a path called "cache".
  if (!existsSync(binary)) fail(`${archive} did not extract a runtime to ${extracted}`);
  return extracted;
}

/* ── the payload ─────────────────────────────────────────────────────────── */

/**
 * Every runtime dependency, at the version actually installed.
 *
 * Refuses rather than guessing when the root install has not happened: a payload
 * built from ranges is a different program from the one the drivers checked.
 */
function entryVersions() {
  const manifest = readJson(join(repoRoot, "package.json"));
  /*
   * ⚠ **A workspace package is skipped here and copied by {@link copySource}
   * instead.** `node_modules/@reemoat/protocol` is a link into this repository, so
   * the loop below would read its version and pin `"@reemoat/protocol": "0.9.0"`
   * into the payload manifest — a package the registry has never heard of, and
   * npm fails on it. `file:` is not the way out either: npm satisfies a `file:`
   * dependency with a symlink, and the audit at the end of this script refuses
   * every symlink in the payload because the bundler cannot copy one.
   */
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
  // A range, deliberately, and the only one here: this package is chosen *by*
  // esbuild's own version, which is a transitive dependency of tsx and therefore
  // not ours to pin. npm resolves it against the esbuild that lands beside it.
  pinned[esbuild] = "*";
  return pinned;
}

/**
 * Install the payload's dependencies with the runtime that will run them.
 *
 * The bundled npm rather than this machine's, so the platform binaries npm picks
 * are the ones for the build being staged rather than the ones for whatever is on
 * PATH here.
 */
function installDependencies(runtime, versions) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  /*
   * The repository's own manifest, with the dependency list replaced by what is
   * actually being installed — rather than a manifest invented here.
   *
   * ⚠ **`type: "module"` is the field that matters and the reason this is a
   * derivation rather than a literal.** Every relative import in `src/` ends in
   * `.js` under `verbatimModuleSyntax`; a payload whose manifest lost that field
   * would have Node treat the whole tree as CommonJS and fail at the first
   * import, a long way from here. Deriving it means the payload cannot disagree
   * with the repository about what kind of package this is.
   *
   * `devDependencies` and `scripts` go: nothing in the payload runs `pnpm`, and a
   * `scripts` block naming drivers that are not shipped is a manifest describing
   * a tree that does not exist.
   */
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
    // The bundled runtime first, so any install script a dependency runs sees the
    // same node the payload will.
    env: { ...process.env, PATH: `${join(runtime, "bin")}:${process.env.PATH ?? ""}` },
  });
}

/**
 * The repository's own files, and the runtime beside them.
 *
 * `src/store/schema.sql` and `deploy/agents.sh` ride along inside their trees and
 * have to: `store/sqlite.ts` reads the first as `new URL("./schema.sql",
 * import.meta.url)`, and `agentupdate.ts` resolves the second from its own file
 * URL through `PACKAGE_ROOT`. Both are why the payload is a tree rather than a
 * bundle.
 */
function copySource(runtime) {
  for (const tree of SOURCE_TREES) {
    cpSync(join(repoRoot, tree), join(stageDir, tree), { recursive: true, dereference: true });
  }
  for (const file of SOURCE_FILES) {
    cpSync(join(repoRoot, file), join(stageDir, file));
  }

  /*
   * npm's own tree, and it earns its place rather than riding along.
   *
   * `deploy/agents.sh` installs kimi from the registry **always** — `kimi upgrade`
   * without a TTY prints the manual command and exits 0 having installed nothing,
   * so shelling out to it would report success for ever — and the whole
   * `REEMOAT_AGENT_SOURCE=npm` arm, which is a firewalled machine's only route,
   * runs through it too. Without npm that script skips them with a warning
   * (`agents.sh:507`), which is a degraded machine nobody is told about.
   *
   * Into `node_modules/npm`, so the shim written beside `node` in `.bin` reaches
   * it by the same relative rule as every other shim.
   */
  cpSync(join(runtime, "lib", "node_modules", "npm"), join(stageDir, "node_modules", "npm"), {
    recursive: true,
    dereference: true,
  });

  /*
   * The workspace package, as a **real directory** rather than a link.
   *
   * `@reemoat/protocol` holds the Noise handshake the daemon speaks to an app, and
   * it is source-only like everything else here — the payload runs under `tsx`,
   * which transpiles a `.ts` entry out of `node_modules` exactly as it does one out
   * of `src/`. Measured, because the two are not obviously the same: a bundler that
   * skipped `node_modules` for speed would have failed here and nowhere else.
   *
   * It lands after {@link installDependencies} on purpose — npm owns
   * `node_modules` until it has finished, and a directory written before it would
   * be pruned. `@noble/*` are declared on the repository's own manifest as well as
   * on this package's, so npm installs them flat at the payload root and Node
   * finds them by walking up from here; `pincheck` holds the two declarations to
   * one version.
   *
   * Only the manifest and the sources. Copying the package whole would follow its
   * `node_modules` — every entry of which is a pnpm link — and `dereference` would
   * turn each into a full copy of a tree the payload root already has.
   */
  const protocol = join(stageDir, "node_modules", "@reemoat", "protocol");
  mkdirSync(protocol, { recursive: true });
  cpSync(join(repoRoot, "packages", "protocol", "package.json"), join(protocol, "package.json"));
  cpSync(join(repoRoot, "packages", "protocol", "src"), join(protocol, "src"), {
    recursive: true,
    dereference: true,
  });
}

/**
 * The `node` the payload runs, and the shims that find it.
 *
 * A shim inside `node_modules/.bin` rather than a link to the real runtime: the
 * other shims resolve it as `$basedir/node`, which is what makes the payload
 * independent of PATH, and a relative link out of `Resources` into `Helpers`
 * would be a symlink — the one thing the bundler cannot copy.
 */
function placeRuntime(runtime) {
  const node = join(runtime, "bin", "node");

  /*
   * ⚠ **One copy of the runtime, and this used to be two.**
   *
   * The payload needs a `node` inside `node_modules/.bin` for two separate
   * consumers: the package shims test `[ -x "$basedir/node" ]` before falling back
   * to PATH, and `deploy/agents.sh` resolves the runtime as
   * `$(dirname -- "$(command -v npm)")/node` — the node *beside* npm. The obvious
   * way to satisfy both is to copy the binary there, and that is what this did:
   * **122 MB, byte-identical to the bundled runtime, shipped twice**, taking the
   * projected bundle from 244 MiB to 360 MiB.
   *
   * A symlink is what this wants and is exactly what cannot be used — the bundler
   * refuses to copy anything that is not a regular file, which is the constraint
   * this whole script is shaped around. So: a shim, which is a regular file, and
   * which finds the one real copy.
   *
   * It probes **two** relative paths, and the first serves the bundle and a
   * development build alike, because {@link helpersDir} is staged where it is for
   * exactly that:
   *
   *   bundle  Contents/Resources/daemon/node_modules/.bin → ../../../../Helpers/Reemoat Runtime.app/…/node
   *   dev     target/<profile>/daemon/node_modules/.bin   → the same four levels up, to target/Helpers
   *   other   an `externalBin` beside the executable      → ../../../node
   *
   * The second is where `tauri-build` puts an `externalBin` in a development
   * build, and it is what the layout was on every platform before the runtime
   * moved into the helper. No overlay ships a runtime today, so nothing reaches
   * it; it stays so that a platform which does is not broken by this one's move.
   *
   * ⚠ **The first path has a space in it**, which is why every candidate is quoted
   * in the list and at the `exec`. A bare word would split at `Reemoat` and exec
   * nothing, and the refusal below would then blame the staging.
   *
   * ⚠ **There is no third guess, and the line that used to be one was a
   * self-exec.** It read `exec node "$@"`, and this comment claimed *"PATH is then
   * the honest last word"*. It is not. `daemon_path` in `src-tauri/src/daemon.rs`
   * puts **this very directory first** on the daemon's `PATH`, deliberately and for
   * a reason of its own — `deploy/agents.sh` resolves the runtime as the node
   * *beside* npm, and both live here. So a PATH lookup for `node` finds this shim
   * and re-execs it, for ever, on any layout where both probes above miss. That is
   * the case a `.deb` or an AppImage would have been, and the loop would have been
   * reported as a daemon that hangs at startup.
   *
   * A payload that cannot find its runtime is a staging bug. Saying so is the only
   * honest last word.
   */
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
 * The runtime on macOS: an application bundle of its own, nested in the app and
 * signed before the app around it is.
 *
 * ⚠ **A bundle because of the Dock, and the mechanism is LaunchServices, not
 * Node.** libuv registers a process with LaunchServices when `process.title` is
 * set, and npm sets one — `npm exec chrome-devtools-mcp@latest` — for every MCP
 * server an agent starts through `npx`. The main bundle of a binary is found from
 * its path, so for `Reemoat.app/Contents/MacOS/node` it was Reemoat.app, which
 * carries no `LSUIElement`: every such process became a Foreground application of
 * `com.reemoat.app`, and with no icon of its own the Dock drew a blank "exec"
 * tile for it. Measured with `lsappinfo` on 0.10.1, same bytes each time:
 *
 *   Reemoat.app/Contents/MacOS/node, process.title set       type="Foreground"
 *   the same, no process.title                               not registered
 *   Homebrew's node, process.title set                       type="BackgroundOnly"
 *   Contents/Helpers/Reemoat Runtime.app/…/node, title set   type="UIElement"
 *
 * So the runtime gets a bundle whose `Info.plist` says `LSUIElement`, and the
 * app's own `Info.plist` is left alone — `LSUIElement` there would take Reemoat's
 * own Dock icon away. `src-tauri/runtime/Info.plist` is the committed half and
 * this assembles the rest around it.
 *
 * ⚠ **Signed here because the bundler will not, and it has to be before the
 * bundler seals the app.** tauri-bundler 2.11 signs the app, its frameworks and
 * its `externalBin` entries — all with the *app's* entitlements file — and copies
 * `bundle.macOS.files` verbatim, before sealing. So a helper that arrives
 * unsigned is sealed over as it is, and `codesign --verify --deep --strict`
 * refuses the app: *"In subcomponent: …/Helpers/Reemoat Runtime.app"*, measured.
 * Signed here, inside out, with the runtime's own entitlements — which is also
 * the nested pass `entitlements-node.plist` has been waiting for since it was
 * written, and it runs on every build rather than only on a signed one.
 */
function stageHelper(node) {
  const helper = join(helpersDir, RUNTIME_HELPER);
  const contents = join(helper, "Contents");
  // From nothing, every time: a helper left by a previous run carries a
  // signature over bytes this run is about to replace.
  rmSync(helper, { recursive: true, force: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  cpSync(join(tauriRoot, "runtime", "Info.plist"), join(contents, "Info.plist"));
  cpSync(node, join(contents, "MacOS", "node"));
  chmodSync(join(contents, "MacOS", "node"), 0o755);
  signHelper(helper);
}

/**
 * Sign the helper as a bundle — its `Info.plist` bound, its executable under the
 * hardened runtime with `entitlements-node.plist` — and verify it.
 *
 * **The identity is the bundler's own variable**, `APPLE_SIGNING_IDENTITY`, so a
 * build carries one identity from the inside out; with none set, both halves are
 * ad-hoc. `--timestamp` goes with a real identity because notarization refuses a
 * Developer ID signature without a secure timestamp, and never with `-`, which
 * cannot carry one.
 *
 * ⚠ **`APPLE_CERTIFICATE` alone is refused.** With that variable the bundler
 * imports the certificate into a keychain of its own *during* `tauri build`,
 * which does not exist yet when this runs — so the app would be signed with the
 * Developer ID and the runtime inside it ad-hoc, and notarization would reject
 * the pair after the whole build had run. Import the certificate into a keychain
 * on the search list first and name it in `APPLE_SIGNING_IDENTITY`.
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

/**
 * Replace every `.bin` entry with a relative shim.
 *
 * npm writes symlinks here. The bundler cannot copy one, and a `.app` is not a
 * place a symlink to a sibling package survives being signed and moved anyway.
 * What replaces them is the smallest thing that works, and deliberately not a
 * copy of pnpm's — that one carries an absolute `NODE_PATH` and 40 lines of
 * Windows handling for a payload that ships on macOS.
 */
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

  /*
   * And one npm does not write for us, because npm did not install itself.
   *
   * ⚠ **This is what makes `deploy/agents.sh` correct on an app-installed
   * machine, and it is subtler than "npm is on PATH".** That script resolves the
   * runtime as `$(dirname -- "$(command -v npm)")/node` — the node *beside* npm —
   * so npm and node have to live in one directory or it finds a different Node
   * than the one running the daemon. Putting this shim in `.bin`, where `node`
   * already is, satisfies both halves with one entry on PATH.
   */
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

/**
 * The coding-agent CLIs, which this payload deliberately does not ship.
 *
 * `AGENT_LOGIN[*].command` in `src/acp/agents.ts` is the list; `nativecheck`
 * reads both and asserts they are the same set, because a sixth agent added
 * there and not here is this whole defect back on the sixth agent.
 */
const AGENT_CLIS = ["claude", "kimi", "codex", "opencode", "grok"];

/**
 * Take the agent CLIs' shims back out of `.bin`.
 *
 * ⚠ **Measured 2026-09-15, and it is the second half of `--omit=optional`.**
 * `codex-acp` depends on `@openai/codex`, so npm stages that package *and* writes
 * a `.bin/codex` for it — while the platform package that actually implements it
 * (`@openai/codex-darwin-arm64`, 250 MB) is dropped on purpose, because
 * `deploy/agents.sh` installs and updates that CLI from the vendor and the pinned
 * copy is never the one meant to run (Q4.114). So the payload shipped a `codex`
 * that answers every invocation with `Error: Missing optional dependency
 * @openai/codex-darwin-arm64`.
 *
 * ⚠ **And it shipped it *first on PATH*.** `daemon_path` in `daemon.rs` puts this
 * directory ahead of the user's own PATH — which is right for the adapters and
 * the runtime, the things that must resolve with no profile at all — so
 * `findOnPath("codex")` in the daemon returned the broken shim in front of the
 * working `~/.local/bin/codex` the person had installed themselves. The visible
 * symptom is the one the owner reported: the agent is *listed*, because listing
 * asks only whether the CLI resolves, and the failure lands after the first
 * message. Worse, `spawnPlan` then writes that path into `CODEX_PATH`, so the
 * override exists to point the adapter at the broken copy.
 *
 * **An allowlist would be wrong here.** `.bin` has to keep whatever npm wrote for
 * the adapters and the runtime — `claude-agent-acp`, `codex-acp`, `tsx`, `node`,
 * `npm` — and naming those exhaustively means a transitive rename breaks the
 * payload silently. What this file actually knows is narrower and stable: **the
 * payload is not where a coding-agent CLI comes from.** So the four names are
 * refused and everything else npm wrote stays.
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

/**
 * The assertion this whole file exists to be able to make.
 *
 * A symlink anywhere under the payload is a `cargo build` that fails with
 * `"… is not a file"`, and it fails in `build.rs` — so it would be reported as a
 * broken Rust build rather than as a packaging mistake. Caught here, where the
 * message can say what actually happened.
 */
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

/* ── main ────────────────────────────────────────────────────────────────── */

process.stdout.write(`build-daemon: staging for ${triple}\n`);
const runtime = fetchRuntime();
installDependencies(runtime, entryVersions());
copySource(runtime);
placeRuntime(runtime);
regenerateShims();
pruneAgentClis();
assertNoSymlinks();
process.stdout.write(
  `  payload ${(payloadSize() / 1e6).toFixed(0)} MB at ${relative(repoRoot, stageDir)}\n`,
);
