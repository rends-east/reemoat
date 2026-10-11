#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GIT_MIN_VERSION, parseGitVersion } from "../src/git.js";

/**
 * Runs `daemoncheck` on the oldest git this daemon claims to work with, built from git's own source.
 * Every other run of that driver is on whatever git the machine has, which is always a new one (Q6.128).
 * Needs a network, a C compiler and zlib's headers, so it is its own CI job and not part of `pnpm check`.
 */

const root = new URL("../", import.meta.url).pathname;
const floor = `${GIT_MIN_VERSION[0]}.${GIT_MIN_VERSION[1]}.0`;
const version = process.argv[2] ?? floor;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write(`usage: pnpm gitfloor [<version>]   (three numbers, as git tags them; default ${floor})\n`);
  process.exit(2);
}

const cache = join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "reemoat-gitfloor");
const prefix = join(cache, version);
const built = join(prefix, "bin", "git");

function versionOf(git: string): string | null {
  try {
    return parseGitVersion(execFileSync(git, ["--version"], { encoding: "utf8" }))?.text ?? null;
  } catch {
    return null;
  }
}

/** The transports, the translations and every script are left out: the drivers clone and fetch between directories only. */
const MAKE_FLAGS = [
  "NO_GETTEXT=1",
  "NO_TCLTK=1",
  "NO_PERL=1",
  "NO_PYTHON=1",
  "NO_CURL=1",
  "NO_EXPAT=1",
  "NO_OPENSSL=1",
  "NO_INSTALL_HARDLINKS=1",
];

/** Two places that publish the same tag, since either answers a 5xx now and then and a cold cache is the only time this runs. */
const SOURCES = [
  `https://github.com/git/git/archive/refs/tags/v${version}.tar.gz`,
  `https://mirrors.edge.kernel.org/pub/software/scm/git/git-${version}.tar.gz`,
];

async function fetchSource(): Promise<Buffer> {
  let last = "";
  for (let round = 1; round <= 3; round += 1) {
    for (const url of SOURCES) {
      process.stdout.write(`fetching ${url}\n`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        last = `${url} answered ${response.status}`;
      } catch (error) {
        last = `${url}: ${error instanceof Error ? error.message : String(error)}`;
      }
      process.stdout.write(`  ${last}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, round * 3_000));
  }
  throw new Error(`the source of git ${version} could not be fetched: ${last}`);
}

async function build(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "gitfloor-"));
  try {
    const tarball = join(work, "git.tar.gz");
    writeFileSync(tarball, await fetchSource());
    const source = join(work, "src");
    mkdirSync(source);
    execFileSync("tar", ["-xzf", tarball, "-C", source, "--strip-components=1"], { stdio: "inherit" });

    process.stdout.write(`building git ${version} into ${prefix}\n`);
    mkdirSync(cache, { recursive: true });
    rmSync(prefix, { recursive: true, force: true });
    const made = spawnSync(
      "make",
      [`-j${availableParallelism()}`, `prefix=${prefix}`, ...MAKE_FLAGS, "install"],
      { cwd: source, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (made.status !== 0) {
      rmSync(prefix, { recursive: true, force: true });
      const tail = `${made.stdout ?? ""}${made.stderr ?? ""}`.trimEnd().split("\n").slice(-30).join("\n");
      throw new Error(`git ${version} did not build${made.error ? ` (${made.error.message})` : ""}:\n${tail}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (versionOf(built) !== version) {
  if (existsSync(prefix)) process.stdout.write(`${prefix} holds no git ${version}; building it again\n`);
  await build();
}
const found = versionOf(built);
if (found !== version) {
  process.stderr.write(`${built} says it is ${found ?? "nothing"}, not ${version}\n`);
  process.exit(1);
}

process.stdout.write(`git ${version} at ${built}\n\n`);
const run = spawnSync("pnpm", ["--silent", "daemoncheck"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: `${join(prefix, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
    GITFLOOR_GIT: version,
  },
});
process.exit(run.status ?? 1);
