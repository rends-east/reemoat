import { lstatSync, readlinkSync } from "node:fs";
import { join, posix, sep } from "node:path";
import type { SessionWorkspace } from "./events.js";
import {
  decodePath,
  GitError,
  GIT_MAX_STATUS_BYTES,
  GIT_TIMEOUT_READ_MS,
  GIT_TIMEOUT_STRUCTURAL_MS,
  splitNul,
  type GitExec,
} from "./git.js";
import { atOrUnderResolved } from "./paths.js";
import { probeBinary, probeRealpath, type ProbeOptions } from "./stall.js";

/**
 * What a session changed, and the diff for one file of it.
 *
 * Two things here are the difference between this being useful and it quietly
 * lying, and both are about *hiding* rather than crashing:
 *
 *   - `git status` collapses untracked files under their directory by default, so
 *     an agent that creates `src/api/` with forty files produces one record. Every
 *     status call therefore passes `--untracked-files=all`.
 *   - `git status` is HEAD-relative, so the moment the agent commits, a
 *     HEAD-relative changes API goes blank. Diffs are taken against the commit the
 *     workspace was created from instead.
 */

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "untracked"
  | "ignored"
  | "unmerged";

export interface FileChange {
  /**
   * Relative to `workspace.root`, which is the namespace the whole API uses.
   *
   * **Not "repo-relative, exactly as git emitted it"**, which is what this said
   * and what the parsers really produce: `toWorkspaceRelative` translates on the
   * way out. The two differ only for a plain session opened in a *subdirectory*
   * of a repository, and there the old spelling made every path in this listing
   * unaskable — see `listChanges`.
   */
  path: string;
  /** Renames and copies only. */
  oldPath: string | null;
  status: ChangeStatus;
  /** Porcelain-v2 XY when this file appeared in `status`; null when only in the diff. */
  xy: string | null;
  staged: boolean;
  added: number | null;
  deleted: number | null;
  binary: boolean;
  symlink: boolean;
  submodule: boolean;
  /**
   * git stopped at a directory rather than descending into it.
   *
   * Even `-uall` does this for a directory containing its own `.git`, so an agent
   * that runs `git init` in a subdirectory would otherwise be invisible behind one
   * line. The UI can say "directory (separate repository)" instead of pretending
   * it is one file.
   */
  collapsed: boolean;
  /**
   * False when this row cannot be asked about over the API.
   *
   * Two ways in, and they mean the same thing to a reader: a path that is not
   * valid UTF-8 cannot round-trip a JSON request, and a path `git status`
   * reported as `../…` — a file changed *outside* this session's tree, which
   * only a plain session in a subdirectory can see — is refused by `safeRelPath`
   * as a dot segment. See `outsideTree`.
   */
  addressable: boolean;
}

export type Truncation = { reason: "file_limit" | "output_limit"; limit: number } | null;

export type ChangeSet =
  | { vcs: "none"; supported: false; reason: "not_a_git_repository" | "git_missing"; files: [] }
  | {
      vcs: "git";
      supported: true;
      base: string;
      baseKind: "session" | "head";
      branch: string | null;
      files: FileChange[];
      /** True count before the cap. Null when the byte cap cut the stream. */
      total: number | null;
      truncated: Truncation;
      includeIgnored: boolean;
    };

export interface DiffResult {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  base: string;
  baseKind: "session" | "head";
  kind: "text" | "binary" | "symlink" | "submodule" | "empty";
  patch: string | null;
  symlinkTarget: string | null;
  bytes: number;
  truncated: boolean;
}

export type PathRejection =
  | "empty"
  | "too_long"
  | "nul_byte"
  | "absolute"
  | "backslash"
  | "dot_segment"
  | "empty_segment"
  | "git_dir"
  | "escapes_tree";

export type SafePath =
  | { ok: true; rel: string; full: string }
  | { ok: false; reason: PathRejection };

export const DEFAULT_MAX_CHANGED_FILES = 2_000;
export const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const MAX_PATH_BYTES = 4096;

export interface ListChangesOptions {
  /** Where git runs. Host paths in and out; see `GitExec`. */
  runner: GitExec;
  base: "session" | "head";
  includeIgnored: boolean;
  limit: number;
}

export interface DiffFileOptions {
  /** Where git runs. Host paths in and out; see `GitExec`. */
  runner: GitExec;
  base: "session" | "head";
  contextLines: number;
  maxBytes: number;
}

/* ------------------------------------------------------------------------- *
 * Listing
 * ------------------------------------------------------------------------- */

export async function listChanges(
  workspace: SessionWorkspace,
  options: ListChangesOptions,
): Promise<ChangeSet> {
  if (!workspace.git) {
    return { vcs: "none", supported: false, reason: "not_a_git_repository", files: [] };
  }
  const { runner } = options;
  const root = workspace.root;
  const base = options.base === "head" ? "HEAD" : workspace.git.baseCommit;

  let byPath: Map<string, FileChange>;
  let truncated: Truncation;
  try {
    /*
     * `git diff <commit>` compares that commit against the *working tree*, so one
     * command covers staged, unstaged and already-committed changes alike. That is
     * what makes the answer survive the agent committing its work.
     *
     * **Both commands speak repo-root-relative here, and `-z` is why.** `git
     * status` is normally cwd-relative (`status.relativePaths` defaults to true)
     * and `-z` turns that off, so with these exact flags the two agree — which is
     * worth writing down because they do *not* agree without it, and a reading
     * that drops `-z` to look at the output by hand sees the opposite. Measured
     * both ways: from a subdirectory, `status --porcelain=v2 -uall` says
     * `kept.txt` and `../top.txt`, while `status --porcelain=v2 -z -uall` says
     * `nested/inner.txt` and `kept.txt`. **`--relative` is therefore not the fix
     * and would be the bug** — it moves only the diff half and splits one file
     * into two rows.
     *
     * What they agree on is still not what the rest of this API means by a path:
     * `safeRelPath`, `requestedPath` and `GET /sessions/:id/files` all resolve
     * against `workspace.root`. `toWorkspaceRelative` below is the one place that
     * gap is closed.
     */
    const raw = await runner.readCapped(
      ["diff", "--raw", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", base],
      readOpts(root),
    );
    byPath = parseDiffRaw(raw.stdout);

    const numstat = await runner.readCapped(
      ["diff", "--numstat", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", base],
      readOpts(root),
    );
    applyNumstat(byPath, numstat.stdout);

    const statusArgs = ["status", "--porcelain=v2", "-z", "--untracked-files=all"];
    // `matching` and never `traditional`: with -uall, traditional enumerates every
    // file inside an ignored directory (6408 records in this very repo, against 2
    // for matching), which hits the byte cap before it tells you anything.
    if (options.includeIgnored) statusArgs.push("--ignored=matching");
    const status = await runner.readCapped(statusArgs, readOpts(root));
    mergeStatus(byPath, status.stdout);

    truncated =
      raw.truncated || numstat.truncated || status.truncated
        ? { reason: "output_limit" as const, limit: GIT_MAX_STATUS_BYTES }
        : null;
  } catch (error) {
    if (error instanceof GitError && error.code === "git_missing") {
      return { vcs: "none", supported: false, reason: "git_missing", files: [] };
    }
    throw error;
  }

  /*
   * git's namespace into this API's, once, on the way out.
   *
   * ⚠ **Everything above is repo-root-relative and everything downstream is
   * workspace-root-relative**, and for a plain session opened in a subdirectory
   * those differ — which made `GET /sessions/:id/changes/diff` and
   * `GET /sessions/:id/files` answer for **nothing at all** on such a session:
   * the listing offered `nested/inner.txt`, `safeRelPath` resolved that under
   * the session root to a file that is not there, and the change-set membership
   * test never matched. Not degraded — absent, and silently, because every other
   * shape of session (worktree, or plain at a repository top) has an empty
   * prefix and was unaffected.
   */
  const prefix = await repoPrefix(runner, root);
  const all = [...byPath.values()]
    .map((change) => toWorkspaceRelative(change, prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  const capped = all.length > options.limit;
  const files = capped ? all.slice(0, options.limit) : all;
  // After the cap, deliberately: this reads bytes off disk, and probing a file
  // the response is about to drop is work nobody asked for. See `markBinary`.
  await markBinary(files, root);
  return {
    vcs: "git",
    supported: true,
    base,
    baseKind: options.base,
    branch: workspace.git.branch,
    files,
    // Null rather than a partial count when the byte cap cut the stream: we
    // genuinely do not know the total, and reporting the partial as the total is
    // the exact lie this codebase refuses everywhere else.
    total: truncated?.reason === "output_limit" ? null : all.length,
    truncated: capped ? { reason: "file_limit", limit: options.limit } : truncated,
    includeIgnored: options.includeIgnored,
  };
}

/**
 * Where `workspace.root` sits inside its repository, as git spells it.
 *
 * `rev-parse --show-prefix` is the canonical answer and the cheap one: `""` at a
 * repository top — every worktree session and every plain session opened at the
 * root, which is the overwhelming majority — and `nested/` one directory down.
 * Asked rather than derived from `workspace.git.repoRoot`, because that field is
 * the **main** worktree and a worktree session's root is deliberately not under
 * it, so subtracting one from the other would be wrong in exactly the case that
 * works today.
 *
 * A failure is `""`, i.e. "assume the root", which is the answer that was
 * implicitly given before this existed. This runs on the listing path and must
 * not be able to turn a working session into an error.
 */
async function repoPrefix(runner: GitExec, root: string): Promise<string> {
  try {
    const run = await runner.readCapped(["rev-parse", "--show-prefix"], {
      dir: root,
      timeoutMs: GIT_TIMEOUT_STRUCTURAL_MS,
      maxBytes: MAX_PATH_BYTES,
    });
    return run.stdout.toString("utf8").trim();
  } catch {
    // A bare repository, a broken gitfile, a timeout. The empty prefix is what
    // every session that works today already has.
    return "";
  }
}

/**
 * One row, renamed from git's namespace into the workspace's.
 *
 * `posix` and never the platform `path`, because these strings came out of git,
 * which uses `/` on every platform — joining them with a Windows separator would
 * produce a path that matches nothing.
 *
 * A file **outside** the tree keeps its `../…` spelling and loses `addressable`:
 * it is a true thing to show, since the agent really did touch something outside
 * its own directory, and it is not a thing anybody can ask about, because
 * `safeRelPath` refuses a `..` segment. That is what `addressable` already means.
 */
function toWorkspaceRelative(change: FileChange, prefix: string): FileChange {
  if (prefix.length === 0) return change;
  const path = posix.relative(prefix, change.path);
  const oldPath = change.oldPath === null ? null : posix.relative(prefix, change.oldPath);
  return {
    ...change,
    path,
    oldPath,
    addressable: change.addressable && !outsideTree(path),
  };
}

function readOpts(dir: string): { dir: string; timeoutMs: number; maxBytes: number } {
  return { dir, timeoutMs: GIT_TIMEOUT_READ_MS, maxBytes: GIT_MAX_STATUS_BYTES };
}

function blank(path: string, addressable: boolean): FileChange {
  return {
    path,
    oldPath: null,
    status: "modified",
    xy: null,
    staged: false,
    added: null,
    deleted: null,
    binary: false,
    symlink: false,
    submodule: false,
    collapsed: false,
    addressable,
  };
}

/**
 * Parses `git diff --raw -z`.
 *
 * Grammar: token 1 is `:<srcMode> <dstMode> <srcSha> <dstSha> <status><score?>`
 * with **no path**; token 2 is the source path; token 3 exists only for R/C and
 * is the destination path.
 *
 * NOTE THE ORDER: this command emits **src then dst**. `status --porcelain=v2`
 * emits the opposite — **new then original**. The two must not share a "read two
 * path tokens" helper, or every rename comes out backwards.
 */
function parseDiffRaw(buffer: Buffer): Map<string, FileChange> {
  const out = new Map<string, FileChange>();
  const tokens = splitNul(buffer);
  let i = 0;
  while (i < tokens.length) {
    const header = tokens[i];
    i += 1;
    if (!header || header.length === 0 || header[0] !== 0x3a /* : */) continue;

    const fields = header.toString("utf8").slice(1).split(" ");
    const srcMode = fields[0] ?? "";
    const dstMode = fields[1] ?? "";
    const code = (fields[4] ?? "").charAt(0);

    const srcToken = tokens[i];
    i += 1;
    if (!srcToken) break;
    const src = decodePath(srcToken);

    let dst = src;
    if (code === "R" || code === "C") {
      const dstToken = tokens[i];
      i += 1;
      if (!dstToken) break;
      dst = decodePath(dstToken);
    }

    const change = blank(dst.path, dst.addressable);
    change.status = rawStatus(code);
    change.oldPath = code === "R" || code === "C" ? src.path : null;
    change.symlink = dstMode === "120000" || (dstMode === "000000" && srcMode === "120000");
    change.submodule = dstMode === "160000" || srcMode === "160000";
    out.set(change.path, change);
  }
  return out;
}

function rawStatus(code: string): ChangeStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    case "U":
      return "unmerged";
    default:
      return "modified";
  }
}

/**
 * Parses `git diff --numstat -z`.
 *
 * Its own asymmetry: a non-rename record is one token
 * `<added>\t<deleted>\t<path>`, while a rename record is `<added>\t<deleted>\t`
 * with a **trailing tab and no path**, followed by the source path and then the
 * destination path as separate tokens. Binary files report `-` for both counts.
 */
function applyNumstat(byPath: Map<string, FileChange>, buffer: Buffer): void {
  const tokens = splitNul(buffer);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i += 1;
    if (!token || token.length === 0) continue;

    const parts = token.toString("utf8").split("\t");
    const addedRaw = parts[0] ?? "";
    const deletedRaw = parts[1] ?? "";
    let path = parts[2] ?? "";

    // Empty third field means a rename: the two paths follow as their own tokens.
    if (path.length === 0) {
      const srcToken = tokens[i];
      i += 1;
      const dstToken = tokens[i];
      i += 1;
      if (!dstToken) break;
      path = decodePath(dstToken).path;
      void srcToken;
    }

    const change = byPath.get(path);
    if (!change) continue;
    const binary = addedRaw === "-" && deletedRaw === "-";
    change.binary = binary;
    change.added = binary ? null : toInt(addedRaw);
    change.deleted = binary ? null : toInt(deletedRaw);
  }
}

function toInt(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Merges `git status --porcelain=v2 -z`.
 *
 * Record grammar, as a stream of NUL-separated tokens rather than lines, because
 * the record types consume different numbers of them:
 *
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                → 1 token
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>     → 2 tokens
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>      → 1 token
 *   ? <path>                                                     → 1 token
 *   ! <path>                                                     → 1 token
 *
 * Under `-z` the `2` record's two pathnames are separated by a NUL rather than
 * the tab used in the non-`-z` form; consume the extra token or every subsequent
 * record shifts by one. And its order is **new path then original path** — the
 * opposite of `diff --raw` above.
 *
 * Fields are split at the first N spaces with the remainder taken whole, because
 * a path containing spaces is entirely ordinary and `split(" ")` would shred it.
 */
/**
 * Fill in `binary` for the untracked records, off the parser and off the loop.
 *
 * Only the untracked and ignored ones: everything else got its answer from
 * `--numstat`, where git reports `-`/`-` for a binary blob, and re-reading those
 * files would be asking the disk a question git already answered.
 *
 * **Sequential rather than `Promise.all`.** Concurrency here is not free — every
 * one of these draws a libuv threadpool slot, which is the resource `stall.ts`
 * exists to protect — and the bound that matters is already the file cap.
 *
 * **What one deadline buys depends on which side of `stallKeyFor` the workspace
 * falls, and this comment used to claim the better half for both.** A *network*
 * mount is remembered by its **mount point**, so a dead server costs one deadline
 * for the whole listing: every later file under it short-circuits on the memory
 * and is permit-gated besides. A *local* path is remembered by **itself** and is
 * not gated at all, so a wedged local filesystem costs a deadline **per file**,
 * up to `options.limit` of them — `DEFAULT_MAX_CHANGED_FILES`, i.e. 2000. Nothing
 * budgets the listing as a whole.
 *
 * `null` from the probe means "could not tell", and it is left as the default
 * `false`. That is what the synchronous version did for an unreadable file, and
 * it is safe for the same reason: `diffFile` `lstat`s again and withholds the
 * content itself, so this only decides what the client *offers*.
 */
async function markBinary(files: readonly FileChange[], root: string): Promise<void> {
  for (const change of files) {
    if (change.collapsed) continue;
    if (change.status !== "untracked" && change.status !== "ignored") continue;
    const answer = await probeBinary(join(root, change.path));
    if (answer === true) change.binary = true;
  }
}

function mergeStatus(byPath: Map<string, FileChange>, buffer: Buffer): void {
  const tokens = splitNul(buffer);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i += 1;
    if (!token || token.length === 0) continue;
    const kind = String.fromCharCode(token[0] ?? 0);
    if (kind === "#") continue;

    if (kind === "?" || kind === "!") {
      const decoded = decodePath(token.subarray(2));
      if (decoded.path.length === 0) continue;
      const change = blank(decoded.path, decoded.addressable);
      change.status = kind === "?" ? "untracked" : "ignored";
      // git stops at a directory that holds its own .git and reports it with a
      // trailing slash, even under -uall.
      change.collapsed = decoded.path.endsWith("/");
      /*
       * An untracked file has no blob, so it never appears in `--numstat` and
       * nothing above can tell us whether it is binary. Left unset it would
       * report every newly created image and archive as ordinary text — and new
       * files are the bulk of what an agent produces.
       *
       * ⚠ **It used to be answered here, with four synchronous syscalls per
       * record.** That put `lstatSync`/`openSync`/`readSync`/`closeSync` on the
       * event loop once per untracked file, inside a parser, on a tree this
       * daemon did not create — up to 2000 files before the cap below even
       * applies, and unbounded on a mount that pauses. It is `markBinary`'s job
       * now: after the cap, so only files somebody will actually see are probed,
       * and through `stall.ts` so a sleeping mount costs one deadline instead of
       * the process.
       */
      byPath.set(decoded.path, change);
      continue;
    }

    if (kind !== "1" && kind !== "2" && kind !== "u") continue;

    // The `2` record's second pathname, consumed *before* anything below can
    // `continue`. Skipping it on a malformed record would shift every following
    // record by one token and silently mis-attribute the rest of the listing.
    let origPath: string | null = null;
    if (kind === "2") {
      const origToken = tokens[i];
      i += 1;
      if (origToken) origPath = decodePath(origToken).path;
    }

    const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const split = splitFields(token, fieldCount);
    if (!split) continue;
    const [fields, pathToken] = split;
    const decoded = decodePath(pathToken);
    if (decoded.path.length === 0) continue;

    const xy = fields[1] ?? "..";
    const change = byPath.get(decoded.path) ?? blank(decoded.path, decoded.addressable);
    change.xy = xy;
    change.staged = xy.charAt(0) !== ".";
    if (kind === "u") change.status = "unmerged";
    if (change.oldPath === null && origPath !== null) change.oldPath = origPath;
    // Modes: mH mI mW are fields 3,4,5 for a `1` record.
    const modeWorktree = kind === "u" ? (fields[6] ?? "") : (fields[5] ?? "");
    if (modeWorktree === "120000") change.symlink = true;
    if (modeWorktree === "160000") change.submodule = true;
    byPath.set(decoded.path, change);
  }
}

/**
 * Whether a translated path lies outside the session's tree.
 *
 * Only reachable for a plain session opened in a subdirectory: a file changed
 * elsewhere in the repository is repo-root-relative on the way in and becomes
 * `../top.txt` once `toWorkspaceRelative` has run. That is a true and useful
 * thing to show — the agent touched something outside its own directory — and
 * it is not a thing anybody can *ask* about, because `safeRelPath` refuses a
 * `..` segment and every route that serves bytes answers `400 invalid_path`.
 *
 * So it is reported with `addressable: false`, which is exactly what that field
 * already means — "this row cannot round-trip a JSON request" — and what a
 * client already draws as a row with no diff button. Widening the field rather
 * than adding a second one, because a reader makes the same decision either way
 * and two flags meaning "you cannot open this" is how one of them gets
 * forgotten.
 */
function outsideTree(path: string): boolean {
  return path === ".." || path.startsWith("../");
}

/** Splits the first `count` space-separated fields, returning the remainder whole. */
function splitFields(token: Buffer, count: number): [string[], Buffer] | null {
  let index = 0;
  const fields: string[] = [];
  let start = 0;
  while (fields.length < count) {
    const space = token.indexOf(0x20, index);
    if (space === -1) return null;
    fields.push(token.subarray(start, space).toString("utf8"));
    start = space + 1;
    index = space + 1;
  }
  return [fields, token.subarray(start)];
}

/* ------------------------------------------------------------------------- *
 * Diffing one file
 * ------------------------------------------------------------------------- */

export async function diffFile(
  workspace: SessionWorkspace,
  change: FileChange,
  options: DiffFileOptions,
): Promise<DiffResult> {
  const { runner } = options;
  const git = workspace.git;
  if (!git) throw new Error("diffFile requires a git workspace");
  const base = options.base === "head" ? "HEAD" : git.baseCommit;
  const root = workspace.root;

  const result: DiffResult = {
    path: change.path,
    oldPath: change.oldPath,
    status: change.status,
    base,
    baseKind: options.base,
    kind: "text",
    patch: null,
    symlinkTarget: null,
    bytes: 0,
    truncated: false,
  };

  const full = join(root, change.path);

  // Symlinks are never content-diffed. `git diff --no-index` *follows* the link,
  // so an agent that does `ln -s ~/.ssh/id_rsa x` would otherwise have the
  // target's bytes served to anyone holding the bearer token. lstat, never stat.
  const stat = safeLstat(full);
  if (stat?.isSymbolicLink()) {
    result.kind = "symlink";
    try {
      result.symlinkTarget = readlinkSync(full);
    } catch {
      // The link vanished between the listing and now; reporting it as a symlink
      // with an unknown target is still more honest than diffing through it.
    }
    return result;
  }
  if (change.submodule) {
    result.kind = "submodule";
    return result;
  }

  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `--unified=${options.contextLines}`];
  let okExitCodes = [0];
  let noIndex = false;

  if (change.status === "untracked" || change.status === "ignored") {
    noIndex = true;
    // No git object exists, so there is nothing to diff against but the file
    // itself. `--no-index` exits **1 when the files differ**, which is the success
    // case for every file an agent creates — treating that as an error is the
    // classic bug here, and it would break the commonest path in the whole API.
    args.push("--no-index", "--", "/dev/null", full);
    okExitCodes = [0, 1];
  } else {
    /*
     * `--relative` so the patch header names the path the caller asked for.
     *
     * `change.path` arrives workspace-relative (`toWorkspaceRelative`), and a
     * pathspec is cwd-relative already, so git finds the right file either way —
     * but without this the *header* comes back repo-root-relative, so a plain
     * session in a subdirectory produced a patch saying `a/nested/inner.txt`
     * about a file the caller asked for as `inner.txt`. A patch whose header
     * names a different path than the request is one `git apply` puts in the
     * wrong place.
     */
    args.push("--relative", "--find-renames", base, "--");
    // Both paths, or git reports an unrelated delete plus an add instead of a
    // rename.
    if (change.oldPath) args.push(change.oldPath);
    args.push(change.path);
  }

  const run = await runner.readCapped(args, {
    dir: root,
    timeoutMs: GIT_TIMEOUT_READ_MS,
    maxBytes: options.maxBytes,
    okExitCodes,
  });

  let patch = run.stdout.toString("utf8");
  if (run.truncated) {
    // Cut at the last complete line, so a truncated patch can never fabricate a
    // final line the file does not have.
    const lastBreak = patch.lastIndexOf("\n");
    patch = lastBreak === -1 ? "" : patch.slice(0, lastBreak + 1);
    result.truncated = true;
  }

  // `--no-index` takes filesystem paths, so its header names the absolute path
  // inside the worktree. Left alone that leaks the daemon's internal layout into
  // every created-file diff and makes the patch un-appliable — which defeats the
  // point of returning the patch on stdout in the first place.
  // `full` is both the path git was handed and the path it printed, because
  // there is one filesystem. This used to look up a translated form first: under
  // the container runner the header carried the path *inside* the container, so
  // matching the host spelling silently never fired and the absolute container
  // path survived into a patch meant to apply anywhere. One namespace, one
  // string, nothing to look up.
  if (noIndex) patch = rewriteNoIndexHeader(patch, change.path);

  if (patch.length === 0) {
    result.kind = "empty";
    return result;
  }
  if (change.binary || /^Binary files .* differ$/m.test(patch)) {
    // Never ship binary bytes through a JSON string.
    result.kind = "binary";
    result.bytes = run.stdout.length;
    return result;
  }

  result.patch = patch;
  result.bytes = Buffer.byteLength(patch, "utf8");
  return result;
}

/**
 * Rewrites a `--no-index` patch header to workspace-relative paths.
 *
 * Only the header block, and only up to the first hunk marker, so a content line
 * that happens to contain the same text cannot be rewritten along with it.
 *
 * ⚠ **The `---`/`+++` lines were matched by prefix and the prefix is not always
 * there.** They were tested with `startsWith("--- a/")` / `startsWith("+++ b/")`,
 * and git **C-quotes a path** containing a non-ASCII byte, a `"` or a `\` — the
 * line then reads `+++ "b/…"`, which matches neither. Measured against real git
 * on `réz"me.txt`:
 *
 * ```
 * diff --git "a/r\303\251z\"me.txt" "b/r\303\251z\"me.txt"
 * --- /dev/null
 * +++ "b/<the daemon's absolute path>"
 * ```
 *
 * The `diff --git` line was rewritten (it is replaced outright, not matched), so
 * the patch came out **self-contradicting**: one header line naming the relative
 * path, the next naming the absolute one — un-appliable, and leaking the
 * daemon's layout in exactly the header this function exists to clean.
 *
 * **So the two path lines are replaced outright too**, the way `diff --git`
 * already was, rather than string-substituted inside whatever git printed. Three
 * things fall out. Quoting stops mattering, because nothing is parsed. The `$&`
 * hazard goes with the `String.replace` — a file named `a$&b.txt` used to splice
 * the absolute path back in through a string replacement's expansion, and there
 * is no replacement left to expand. And the header can no longer half-agree with
 * itself, because one value writes all three lines.
 *
 * `/dev/null` is the one side that must survive: `diffFile` invokes `--no-index`
 * with exactly `/dev/null` and the file, so precisely one of the pair is a real
 * path and the other has to stay as it is or the patch stops describing a
 * creation.
 */
function rewriteNoIndexHeader(patch: string, rel: string): string {
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.startsWith("@@")) break;
    if (line.startsWith("diff --git ")) {
      lines[i] = `diff --git a/${rel} b/${rel}`;
    } else if (line.startsWith("--- ") && line !== "--- /dev/null") {
      lines[i] = `--- a/${rel}`;
    } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      lines[i] = `+++ b/${rel}`;
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * Path safety
 * ------------------------------------------------------------------------- */

/**
 * Constrains a client-supplied path to the session's tree.
 *
 * This is the one genuine attack surface in the changes API, and it is not about
 * confining the *agent*: there is no sandbox, the agent runs as this user, and the
 * browse roots narrow a listing rather than a process. It is about not turning
 * this route into an arbitrary-file-read for anyone holding a bearer token, which
 * is a separate question and would still be one if the agent were perfectly caged.
 *
 * **This half touches no filesystem at all**, and that is now structural rather
 * than incidental: it used to end with two `realpathSync` calls on a path the
 * caller named, which is the one thing `stall.ts` exists to prevent. See
 * {@link probeContained}, which is the other half and is async for that reason.
 *
 * The caller applies one more rule on top: for `changes/diff` the path must
 * appear in the freshly recomputed change set. These are defence in depth behind
 * that, not a replacement for it — that rule depends on a parser, and a parser is
 * code that can have bugs.
 */
export function safeRelPath(root: string, input: string): SafePath {
  if (input.length === 0) return { ok: false, reason: "empty" };
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES) return { ok: false, reason: "too_long" };
  if (input.includes("\0")) return { ok: false, reason: "nul_byte" };
  // Windows-shaped inputs are rejected even on darwin: the check is free and the
  // daemon will not always run here.
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.startsWith("\\\\")) {
    return { ok: false, reason: "absolute" };
  }
  if (input.includes("\\")) return { ok: false, reason: "backslash" };

  const segments = input.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: "empty_segment" };
    if (segment === "." || segment === "..") return { ok: false, reason: "dot_segment" };
    // git never reports a path inside .git, so this only fires on a crafted
    // request — and serving .git/config would leak remote URLs and the
    // credential helper configuration. Case-insensitively, because the default
    // filesystem on this platform is, so `.GIT/config` resolves to the same file.
    if (segment.toLowerCase() === ".git") return { ok: false, reason: "git_dir" };
  }

  const rel = segments.join("/");
  const full = join(root, rel);
  if (full !== `${root}${sep}${rel}`) return { ok: false, reason: "escapes_tree" };

  return { ok: true, rel, full };
}

/**
 * The containment answer that needs the filesystem, with **"could not tell" as a
 * real third answer**.
 *
 * This was the tail of {@link safeRelPath} and it was two `realpathSync` calls —
 * on `<workspace.root>/<whatever the caller typed>`. That is precisely the
 * event-loop death `stall.ts` documents, reached by a route nobody had counted:
 * for a `plain` session `workspace.root` **is** the `cwd` the caller named, so
 * `GET /sessions/:id/files?path=OrbStack/x` blocked inside the kernel on a hard
 * NFS mount whose server had paused, taking every session, every socket and
 * `/health` with it at 0% CPU. `workspaceReady` could not save it: it probes the
 * root, which answers instantly, while the stall is on a mount *underneath* it.
 * An agent reaches the same call with one `ln -s /mnt/nas nas` inside its own
 * worktree.
 *
 * So both resolutions go through `attempt`: bounded, permit-gated, and remembered
 * per mount point, so a workspace containing a dead server costs one deadline
 * rather than one per request.
 *
 * Two answers are *not* refusals and both are the behaviour the synchronous
 * version had:
 *
 *   - The **parent** is resolved, never the file. A symlink whose target is
 *     outside the tree is a legitimate changed file — git tracks the link rather
 *     than what it points at — and resolving the leaf would reject exactly the
 *     case the symlink handling elsewhere in this module reports safely.
 *   - A path that does not resolve at all is `true`. That is a "not there"
 *     answer, not a traversal, and the caller says so with a better code: the
 *     change-set membership check for `changes/diff`, `serveFile`'s
 *     `not_a_regular_file` for `files`.
 */
export async function probeContained(
  root: string,
  full: string,
  options: ProbeOptions = {},
): Promise<boolean | null> {
  const answer = await probeRequestable(root, full, options);
  if (answer === null) return null;
  return answer === "ok";
}

/**
 * Whether a caller-named path may be served: contained, **and** not reaching
 * into a `.git` directory once the links are followed.
 *
 * ⚠ **`safeRelPath` refuses a `.git` segment and that refusal is purely
 * syntactic** — it reads the string the caller typed. Its own comment gives the
 * reason as a security rule ("serving `.git/config` would leak remote URLs and
 * the credential helper configuration"), and a single symlink walked straight
 * past it: with `g -> .git` anywhere in the tree — committed in a repository
 * somebody cloned, or made once by an agent during ordinary work —
 * `?path=g/config` contains no `.git` segment to refuse, and `probeContained`
 * then answered `true`, because `.git` really *is* inside the workspace. Both
 * checks passed and the bytes went out to any `session:read` grant.
 *
 * So the test is re-run on the **resolved** path, and it lives here because this
 * is the only function that holds one: `probeContained` resolved the parent,
 * compared it, and threw the answer away. Doing it in `server.ts` instead would
 * mean a second `probeRealpath` of the same parent on every download.
 *
 * `O_NOFOLLOW` on the open cannot help and is not meant to: it governs the leaf,
 * so it refuses `?path=g` and says nothing about `?path=g/config`, where the
 * link is an interior segment.
 *
 * The three answers `probeContained` had are preserved and one is split, so the
 * caller can still tell "did not answer" from "no" — and now also tell which
 * "no" it is, because those are different sentences to put on a screen.
 */
export async function probeRequestable(
  root: string,
  full: string,
  options: ProbeOptions = {},
): Promise<"ok" | "escapes_tree" | "git_dir" | null> {
  const parent = full.slice(0, full.lastIndexOf(sep)) || root;
  const realRoot = await probeRealpath(root, options);
  if (realRoot === null) return null;
  if (realRoot.kind === "missing") return "ok";
  const realParent = await probeRealpath(parent, options);
  if (realParent === null) return null;
  if (realParent.kind === "missing") return "ok";
  // `atOrUnderResolved` rather than a second prefix test written out here: both
  // sides have just been resolved, so this is the pre-resolved variant's whole
  // reason for existing, and the segment-wise rule stays written down once.
  if (!atOrUnderResolved(realParent.value, realRoot.value)) return "escapes_tree";
  return reachesGitDir(realRoot.value, realParent.value) ? "git_dir" : "ok";
}

/**
 * Whether a resolved directory sits at or under a `.git` of its own.
 *
 * Only the part **below the root** is examined, because the root's own absolute
 * path is not the caller's doing: a workspace that legitimately lives under
 * `~/src/.git-backups/x` would otherwise be unservable in its entirety.
 *
 * Case-insensitively, for `safeRelPath`'s reason — the default filesystem on
 * this platform is, so `.GIT` resolves to the same directory.
 */
function reachesGitDir(realRoot: string, realParent: string): boolean {
  if (realParent === realRoot) return false;
  const below = realParent.startsWith(realRoot + sep) ? realParent.slice(realRoot.length + 1) : realParent;
  return below.split(sep).some((segment) => segment.toLowerCase() === ".git");
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    // Deleted files are entirely normal here — they still have a diff.
    return null;
  }
}
