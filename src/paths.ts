import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Expands a leading ~ followed by / or the platform separator; purely syntactic, never touches the disk. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * REEMOAT_HOME or ~/.reemoat: one database per machine, account and server, so each account gets its own root (Q7.148, Q7.149).
 * Refuses a relative path and the home directory itself; the agent toolchain does not live here.
 */
export function resolveStateRoot(spec: string | undefined): string {
  const raw = (spec ?? "").trim();
  if (raw.length === 0) return join(homedir(), ".reemoat");
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    throw new Error(`REEMOAT_HOME must be an absolute path, got "${raw}"`);
  }
  // Resolved, so a trailing separator or a dot segment cannot slip past the refusal.
  if (resolve(expanded) === resolve(homedir())) {
    throw new Error(`REEMOAT_HOME may not be your home directory itself, got "${raw}"`);
  }
  return expanded;
}

/** Realpath, or the path as written when it does not exist yet; it names a path and never decides containment. */
export function resolved(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/** Segment-wise, on two paths the caller has already realpath'd, so a sibling sharing a prefix is not inside. */
export function containedInResolved(path: string, root: string): boolean {
  return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function atOrUnderResolved(path: string, root: string): boolean {
  return path === root || containedInResolved(path, root);
}

export function containedIn(path: string, root: string): boolean {
  return containedInResolved(resolved(path), resolved(root));
}

export function atOrUnder(path: string, root: string): boolean {
  return atOrUnderResolved(resolved(path), resolved(root));
}

// atOrUnder is right only for a path that is ours and not yet created; never to authorise a path somebody else chose.
