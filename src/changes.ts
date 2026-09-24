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

// What a session changed: diffed against its base commit so a commit does not blank it, and with -uall so a new directory is not one row.

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
  /** Relative to workspace.root, not the repository root; see toWorkspaceRelative. */
  path: string;
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
  /** git stopped at a directory holding its own .git, even under -uall. */
  collapsed: boolean;
  /** False when the row cannot be requested: not valid UTF-8, or outside the session's tree. */
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
  runner: GitExec;
  base: "session" | "head";
  includeIgnored: boolean;
  limit: number;
}

export interface DiffFileOptions {
  runner: GitExec;
  base: "session" | "head";
  contextLines: number;
  maxBytes: number;
}

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
    // With -z both commands print repo-root-relative paths; adding --relative here would move only the diff half.
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
    // matching, never traditional: traditional enumerates every file under an ignored directory and hits the byte cap.
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

  // Everything above is repo-root-relative and everything downstream workspace-relative; they differ for a plain session in a subdirectory.
  const prefix = await repoPrefix(runner, root);
  const all = [...byPath.values()]
    .map((change) => toWorkspaceRelative(change, prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  const capped = all.length > options.limit;
  const files = capped ? all.slice(0, options.limit) : all;
  // After the cap: probing reads the disk, and rows about to be dropped are not worth it.
  await markBinary(files, root);
  return {
    vcs: "git",
    supported: true,
    base,
    baseKind: options.base,
    branch: workspace.git.branch,
    files,
    // Null rather than a partial count when the byte cap cut the stream.
    total: truncated?.reason === "output_limit" ? null : all.length,
    truncated: capped ? { reason: "file_limit", limit: options.limit } : truncated,
    includeIgnored: options.includeIgnored,
  };
}

// Asked of git rather than derived from repoRoot, which names the main worktree; a failure means the repository top.
async function repoPrefix(runner: GitExec, root: string): Promise<string> {
  try {
    const run = await runner.readCapped(["rev-parse", "--show-prefix"], {
      dir: root,
      timeoutMs: GIT_TIMEOUT_STRUCTURAL_MS,
      maxBytes: MAX_PATH_BYTES,
    });
    return run.stdout.toString("utf8").trim();
  } catch {
    return "";
  }
}

// posix because git uses / everywhere. A path outside the tree keeps its ../ spelling and loses addressable.
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

// Paths come src then dst, the opposite of status --porcelain=v2: do not share a path-reading helper.
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

// A rename record is the counts plus a trailing tab, then src and dst as separate tokens; a binary file reports - for both counts.
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

// Only untracked and ignored rows (numstat answered the rest), sequentially to spare the threadpool; an unknown answer leaves binary false.
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
      // A directory holding its own .git is reported with a trailing slash, even under -uall.
      change.collapsed = decoded.path.endsWith("/");
      // An untracked file never appears in numstat; markBinary fills in binary after the cap.
      byPath.set(decoded.path, change);
      continue;
    }

    if (kind !== "1" && kind !== "2" && kind !== "u") continue;

    // Consume the 2 record's second path before any continue, or every later record shifts by one token.
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

function outsideTree(path: string): boolean {
  return path === ".." || path.startsWith("../");
}

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

  // Symlinks are never content-diffed: --no-index follows the link and would serve its target's bytes. lstat, never stat.
  const stat = safeLstat(full);
  if (stat?.isSymbolicLink()) {
    result.kind = "symlink";
    try {
      result.symlinkTarget = readlinkSync(full);
    } catch {
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
    // --no-index exits 1 when the files differ, which is the success case for a new file.
    args.push("--no-index", "--", "/dev/null", full);
    okExitCodes = [0, 1];
  } else {
    // --relative so the patch header names the workspace-relative path the caller asked for.
    args.push("--relative", "--find-renames", base, "--");
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
    // Cut at the last complete line so a truncated patch never invents a final line.
    const lastBreak = patch.lastIndexOf("\n");
    patch = lastBreak === -1 ? "" : patch.slice(0, lastBreak + 1);
    result.truncated = true;
  }

  // --no-index headers name the absolute path: rewrite them so the patch applies and hides the daemon's layout.
  if (noIndex) patch = rewriteNoIndexHeader(patch, change.path);

  if (patch.length === 0) {
    result.kind = "empty";
    return result;
  }
  if (change.binary || /^Binary files .* differ$/m.test(patch)) {
    result.kind = "binary";
    result.bytes = run.stdout.length;
    return result;
  }

  result.patch = patch;
  result.bytes = Buffer.byteLength(patch, "utf8");
  return result;
}

// Replaces the path lines outright rather than matching them, since git C-quotes some paths; a /dev/null side is kept.
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

/** Syntactic containment of a client-supplied path; touches no filesystem (probeContained is the resolved half). */
export function safeRelPath(root: string, input: string): SafePath {
  if (input.length === 0) return { ok: false, reason: "empty" };
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES) return { ok: false, reason: "too_long" };
  if (input.includes("\0")) return { ok: false, reason: "nul_byte" };
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.startsWith("\\\\")) {
    return { ok: false, reason: "absolute" };
  }
  if (input.includes("\\")) return { ok: false, reason: "backslash" };

  const segments = input.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: "empty_segment" };
    if (segment === "." || segment === "..") return { ok: false, reason: "dot_segment" };
    // Serving .git/config would leak remotes and credential config; case-insensitive for case-insensitive filesystems.
    if (segment.toLowerCase() === ".git") return { ok: false, reason: "git_dir" };
  }

  const rel = segments.join("/");
  const full = join(root, rel);
  if (full !== `${root}${sep}${rel}`) return { ok: false, reason: "escapes_tree" };

  return { ok: true, rel, full };
}

/** Resolved containment through stall.ts, null when the filesystem did not answer; resolves the parent, not the leaf, and a missing path is true. */
export async function probeContained(
  root: string,
  full: string,
  options: ProbeOptions = {},
): Promise<boolean | null> {
  const answer = await probeRequestable(root, full, options);
  if (answer === null) return null;
  return answer === "ok";
}

/** Contained, and not inside a .git once links are followed: a g -> .git symlink passes safeRelPath. */
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
  if (!atOrUnderResolved(realParent.value, realRoot.value)) return "escapes_tree";
  return reachesGitDir(realRoot.value, realParent.value) ? "git_dir" : "ok";
}

// Only the part below the root counts: the root's own path is not the caller's doing.
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
