/**
 * Delete the parts of pnpm's virtual store the control plane cannot reach.
 *
 * **Why this exists, since a build step that deletes things needs a reason.**
 * `pnpm install --filter @reemoat/control-plane` does not install only that
 * package: pnpm always installs the *workspace root* importer as well, and this
 * repository's root is itself a workspace package (`packages: ['.', 'packages/*']`)
 * whose dependencies are the daemon's. Measured in the image: that pulls
 * `@anthropic-ai/claude-agent-sdk-linux-arm64` at **260 MB**, plus
 * `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod` — into the image of
 * a process that spawns no agent, and that holds the Ed25519 key signing every
 * token in the fleet. Adding codex made that one such binary per agent:
 * `@openai/codex` ships a platform build per architecture, 307 MB of it in this
 * repo's own darwin-arm64 install. `--filter='!.'` does not exclude it,
 * `pnpm deploy` answers `ERR_PNPM_NOTHING_TO_DEPLOY` from the package directory
 * and deploys the root from the workspace root, and `--no-optional` would take
 * esbuild's own platform binary with it and break `tsx`. All four were tried
 * before this was written.
 *
 * **It is a reachability walk, never a blacklist.** Start at the control plane's
 * own `node_modules`, follow every symlink into `.pnpm/<key>`, and recurse
 * through each of those packages' own `node_modules`. What is never reached is
 * what the control plane can never import. A hardcoded list of "things the
 * daemon needs" would rot the first time a dependency moved; this cannot, and if
 * it ever over-prunes the failure is `ERR_MODULE_NOT_FOUND` at the first start,
 * which `pnpm imagecheck` and the container's own HEALTHCHECK both catch
 * immediately rather than subtly.
 *
 * What it deliberately does not do is touch the lockfile, the manifests, or
 * anything pnpm would read again. The install that ran was faithful and frozen;
 * this only removes files from the image afterwards. Running `pnpm install` in
 * the resulting image would restore everything, which is the honest signal that
 * this is a packaging step and not a dependency decision.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const APP = process.argv[2] ?? "/app";
const STORE = join(APP, "node_modules", ".pnpm");
const ROOT_NM = join(APP, "node_modules");
const ENTRY = join(APP, "packages", "control-plane", "node_modules");

/** `.pnpm` directory names that are reachable from the control plane. */
const keep = new Set();

/**
 * Every symlink in one `node_modules`, resolved into the store.
 *
 * Scoped packages nest one level (`@hono/node-server`), so a directory that
 * starts with `@` is descended into rather than resolved. `.bin` holds shims
 * rather than packages and is skipped — the packages it points at are reached
 * through their own links anyway.
 */
function walk(nodeModules) {
  if (!existsSync(nodeModules)) return;
  for (const name of readdirSync(nodeModules)) {
    if (name === ".bin" || name === ".modules.yaml" || name === ".pnpm") continue;
    const path = join(nodeModules, name);
    const candidates = name.startsWith("@")
      ? readdirSync(path).map((inner) => join(path, inner))
      : [path];
    for (const candidate of candidates) {
      let real;
      try {
        if (!lstatSync(candidate).isSymbolicLink()) continue;
        real = realpathSync(candidate);
      } catch {
        // A dangling link is already unreachable; nothing to keep for it.
        continue;
      }
      if (!real.startsWith(`${STORE}/`)) continue;
      const key = real.slice(STORE.length + 1).split("/")[0];
      if (key === undefined || keep.has(key)) continue;
      keep.add(key);
      // That package's own dependencies live beside it in the store.
      walk(join(STORE, key, "node_modules"));
    }
  }
}

walk(ENTRY);

if (keep.size === 0) {
  // Refusing rather than deleting everything: an empty result means the entry
  // point moved, not that the control plane has no dependencies.
  console.error(`prune-store: nothing reachable from ${ENTRY} — refusing to prune`);
  process.exit(1);
}

let removed = 0;
for (const key of readdirSync(STORE)) {
  if (key === "node_modules" || key === "lock.yaml") continue;
  if (keep.has(key)) continue;
  rmSync(join(STORE, key), { recursive: true, force: true });
  removed += 1;
}

/**
 * The root importer's own links, which now dangle.
 *
 * Nothing in the image resolves through them — the four files copied out of the
 * repository root (`token.ts`, `auth.ts`, `cors.ts`, `relay/protocol.ts`) import
 * `node:crypto` and each other and nothing else — but a tree full of broken
 * symlinks is a thing somebody will spend an afternoon on.
 */
let dangling = 0;
for (const name of readdirSync(ROOT_NM)) {
  if (name === ".pnpm" || name === ".modules.yaml") continue;
  const path = join(ROOT_NM, name);
  const candidates = name.startsWith("@")
    ? readdirSync(path).map((inner) => join(path, inner))
    : [path];
  for (const candidate of candidates) {
    if (existsSync(candidate)) continue;
    rmSync(candidate, { recursive: true, force: true });
    dangling += 1;
  }
}

console.log(`prune-store: kept ${keep.size}, removed ${removed} store entries and ${dangling} dangling links`);
