/**
 * Deletes the pnpm store entries unreachable from the control plane's node_modules: a reachability walk, never a blacklist (Q4.114).
 * Over-pruning fails at the first start with ERR_MODULE_NOT_FOUND, which imagecheck and the HEALTHCHECK catch.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const APP = process.argv[2] ?? "/app";
const STORE = join(APP, "node_modules", ".pnpm");
const ROOT_NM = join(APP, "node_modules");
const ENTRY = join(APP, "packages", "control-plane", "node_modules");

const keep = new Set();

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
      walk(join(STORE, key, "node_modules"));
    }
  }
}

walk(ENTRY);

if (keep.size === 0) {
  // An empty result means the entry point moved, not that the control plane has no dependencies.
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
