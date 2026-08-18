import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * A leading `~` as this daemon's own home directory.
 *
 * Here rather than in each caller because there were **three** copies with
 * **two** behaviours: `browse.ts`, `resolveWorktreeRoot` and `resolveUploadRoot`,
 * of which only the last also accepted a literal `~/` on a host where `sep` is
 * not `/` — while `resolveUploadRoot`'s own comment claimed it did "the same `~`
 * expansion as `resolveWorktreeRoot`". Three implementations of a rule is how a
 * comment ends up describing a sibling rather than the code under it, which is
 * the same argument this file already makes for `containedIn`.
 *
 * The surviving behaviour is the widest of the three: `~/` is taken as well as
 * `~${sep}`, because an operator typing a path into an env file writes the
 * separator they know rather than the one this platform reports.
 *
 * Purely syntactic. Nothing here touches the filesystem, so it is safe on a path
 * somebody else named — the callers decide what to resolve, and `stall.ts` owns
 * that.
 */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Containment, in the only form that is safe to make a decision on.
 *
 * Lived in `worktree.ts` as a private helper guarding the one `rmSync` in this
 * codebase, and is shared rather than copied — a second implementation of this
 * that drifted from the first would be a rule that holds in one place and not
 * the other. Its two surviving consumers are that `rmSync` guard and the browse
 * roots; neither is a boundary any more, and both are still wrong if they merge
 * two directories that merely share a prefix.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 *   1. **Both sides go through `realpath` first.** A symlink planted inside a
 *      tree can point anywhere — `ln -s /etc evil` — and a textual prefix test
 *      says `<root>/evil/passwd` is inside the root. It is not. Resolving first
 *      is what makes the answer about the actual file.
 *
 *   2. **The comparison is segment-wise, never a bare `startsWith`.** With a
 *      plain prefix test `/wt/proj` contains `/wt/proj-old`, so one directory
 *      being a prefix of another silently merges them — and the caller here is
 *      the guard on the only `rmSync` in the codebase. Appending the separator
 *      before comparing is the whole fix, and `pnpm daemoncheck` asserts exactly
 *      that pair.
 *
 * A path that cannot be resolved is compared as written. That is deliberate:
 * these are also called on paths that do not exist yet (a worktree about to be
 * created), and refusing to answer would turn "not yet there" into "outside".
 */
function resolved(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * The comparison itself, on two paths the caller has **already resolved**.
 *
 * Split out rather than copied, which is the whole point of this file: the
 * segment-wise rule is written once and the resolving variants below are one
 * line each on top of it. A caller reaching for this is asserting it has done
 * property 1 already — it is not a way to skip it.
 *
 * `browse.ts` is that caller. `listDirs` has just `await realpath`'d the path it
 * is about to check, and `resolveRoots` realpaths every root at startup for
 * exactly this reason, so re-resolving both sides through `realpathSync` was
 * pure cost — and not the harmless kind. It is a *synchronous* filesystem call
 * on a caller-supplied path, on the event loop, in the one module that was
 * rewritten to keep a stalled network mount from taking the daemon with it.
 */
export function containedInResolved(path: string, root: string): boolean {
  return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** {@link containedInResolved}, but the root is inside itself. */
export function atOrUnderResolved(path: string, root: string): boolean {
  return path === root || containedInResolved(path, root);
}

/** Strictly inside `root`. The root is not contained in itself. */
export function containedIn(path: string, root: string): boolean {
  return containedInResolved(resolved(path), resolved(root));
}

/**
 * Inside `root`, or `root` itself.
 *
 * The variant a containment decision about a legitimate starting point wants: a
 * session started at the top of a configured root is fine, while the same path
 * is not something to `rm`.
 */
export function atOrUnder(path: string, root: string): boolean {
  return atOrUnderResolved(resolved(path), resolved(root));
}

/*
 * `atOrUnderReal` used to live here, with `resolvedThroughParents` beside it.
 *
 * It was `atOrUnder` for a path that does not exist yet **and is not trusted**,
 * and the distinction was not academic: given a root and a symlink planted inside
 * it — `ln -s /etc <root>/link` — the path `<root>/link/passwd` does not exist, so
 * `realpath` throws, so `atOrUnder` compares the literal string, finds the prefix
 * and says yes. The caller then created `/etc/passwd`.
 *
 * Deleted with its last caller rather than kept for a future one. A security
 * primitive with no callers and forty lines of symlink reasoning reads as live
 * policy to whoever finds it next, and the measurement is preserved in
 * `CLAUDE.md`, where it is read as history. Reinstating it is twenty lines.
 *
 * What survives is the rule it existed to make sayable: `atOrUnder` is correct
 * where the path is **ours** and merely not created yet, such as a worktree about
 * to be made, and nothing may use it to authorise an action on a path somebody
 * else chose.
 */
