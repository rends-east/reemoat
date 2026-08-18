import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";

import { probeExists, probeRealpath } from "./stall.js";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PlainReason, SessionWorkspace } from "./events.js";
import { containedIn, containedInResolved, expandHome } from "./paths.js";
import {
  GitError,
  GIT_MAX_LIST_BYTES,
  GIT_MAX_STATUS_BYTES,
  GIT_MAX_STRUCTURAL_BYTES,
  GIT_TIMEOUT_LIST_MS,
  GIT_TIMEOUT_MUTATE_MS,
  GIT_TIMEOUT_READ_MS,
  GIT_TIMEOUT_STRUCTURAL_MS,
  linesOf,
  splitNul,
  textOf,
  type GitExec,
} from "./git.js";
import { describeError } from "./http.js";

/**
 * Per-session git worktrees.
 *
 * Two agents pointed at one repository fight over one index and one HEAD. A
 * linked worktree gives each its own of both, which is why parallel sessions
 * work at all — that part is git's guarantee, not ours. What is ours is not
 * fighting it, and never destroying work on the way out.
 */

export const DEFAULT_BRANCH_PREFIX = "reemoat";
const BRANCH_SUFFIX_ATTEMPTS = 10;

export interface RepoInfo {
  isRepo: boolean;
  bare: boolean;
  insideWorkTree: boolean;
  /** Absolute `$GIT_DIR`. Differs from `commonDir` exactly when we are in a linked worktree. */
  gitDir: string | null;
  /** Absolute `$GIT_COMMON_DIR`. The repository's identity. */
  commonDir: string | null;
  /** This checkout's root. Null when bare. */
  toplevel: string | null;
  /** The main worktree — where `worktree add`/`remove`/`prune` have to run. */
  mainRoot: string | null;
  linked: boolean;
  /** Null when HEAD is unborn: the repo has no commits and cannot be branched from. */
  headCommit: string | null;
  /** Null when HEAD is detached. */
  headBranch: string | null;
  dirty: { tracked: number; untracked: number } | null;
}

export type WorkspaceWarning =
  | { code: "dirty_source"; message: string; tracked: number; untracked: number }
  | { code: "linked_worktree_source"; message: string; mainRoot: string }
  | { code: "detached_source"; message: string }
  | { code: "branch_renamed"; message: string; requested: string; actual: string };

export type WorktreeErrorCode =
  | "not_a_repo"
  | "unborn_head"
  | "bare_repo_needs_worktree"
  | "branch_in_use"
  | "branch_collision"
  | "branch_namespace_conflict"
  | "invalid_branch"
  | "workspace_path_taken"
  | "worktree_root_unwritable"
  | "outside_worktree_root"
  | "git_missing"
  | "git_failed"
  | "git_timeout"
  | "git_output_too_large";

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
}

export interface WorkspaceStatus {
  mode: SessionWorkspace["mode"];
  root: string;
  /**
   * Does the directory still exist, or could we not tell?
   *
   * `null` is a real answer and not a placeholder. This was a `boolean` filled by
   * `existsSync`, which has no way to say "the path is on a network mount that
   * has stopped replying" — and for a `plain` session this path is the `cwd` the
   * caller chose, so that case is ordinary rather than exotic. Reporting it as
   * `false` told somebody their work had been deleted. Same three-answer shape as
   * `Liveness` and an agent's `loggedIn`, for the same reason.
   */
  exists: boolean | null;
  /**
   * Does `worktree list` still know about it, or could we not tell?
   *
   * Three-valued for the same reason `exists` above is: deciding it needs
   * `realpath` on the paths **git** reported, which are by construction paths
   * this daemon did not create, and `samePath` answers `null` when one of them
   * sits on a mount that has stopped replying. Reporting that as `false` would
   * say a registered worktree had been forgotten.
   */
  registered: boolean | null;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  /** Commits made in this worktree since it branched. */
  commitsAhead: number | null;
  hasRemote: boolean;
  /** Commits reachable from HEAD but from no remote-tracking ref. Null with no remotes. */
  unpushed: number | null;
  dirty: { tracked: number; untracked: number; ignored: number } | null;
  locked: boolean;
}

/**
 * Why a removal did not happen. Every one of these is cured by `force`.
 *
 * The last two are the third answer, and they are refusals rather than a shrug
 * for the same reason `exists` above is three-valued: **a count we could not take
 * is not a count of zero.** `count()` and `countStatus` collapse a timeout, a
 * non-zero exit, oversized output and a parse failure into one `null`, and a
 * caller reading that as "nothing to lose" is how `--delete-branch` came to run
 * `git branch -D` over commits that existed nowhere else.
 */
export type RemoveRefusal =
  | { code: "dirty"; message: string; tracked: number; untracked: number; ignored: number }
  | { code: "unpushed_commits"; message: string; count: number; hasRemote: boolean }
  | { code: "locked"; message: string }
  | { code: "counts_unknown"; message: string; about: "dirty" | "commits" }
  | { code: "remove_refused"; message: string; stderr: string };

export type RemoveWorkspaceResult =
  | { kind: "removed"; branchDeleted: boolean; pruned: boolean; warnings: string[] }
  | { kind: "refused"; refusals: RemoveRefusal[]; status: WorkspaceStatus }
  | { kind: "not_applicable"; reason: "plain_directory" };

export interface CreateWorkspaceOptions {
  /** Absolute, already through `resolveCwd`. */
  cwd: string;
  sessionId: string;
  /** `auto` makes a worktree when it can, `require` insists, `never` opts out. */
  policy: "auto" | "require" | "never";
  worktreeRoot: string;
  branchPrefix: string;
  /** Client-supplied. Sanitized and validated by git, never trusted. */
  branchHint?: string | null;
  /** Where git runs. Host paths in and out; see `GitExec`. */
  runner: GitExec;
}

export interface CreateWorkspaceResult {
  workspace: SessionWorkspace;
  warnings: WorkspaceWarning[];
}

/* ------------------------------------------------------------------------- *
 * Configuration
 * ------------------------------------------------------------------------- */

/**
 * Where per-session worktrees are created.
 *
 * Outside every repository on purpose. Inside one, each worktree would show up
 * as an untracked entry in the *parent's* own changes API and sit in the path of
 * `git clean -xfd`; beside one, we would be writing into a directory we do not
 * own and may not be able to write to. The default is dot-prefixed, so
 * `GET /fs/list` already hides it from the directory picker.
 */
export function resolveWorktreeRoot(spec: string | undefined): string {
  const raw = (spec ?? "").trim();
  if (raw.length === 0) return join(homedir(), ".reemoat", "worktrees");
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    throw new WorktreeError(
      "worktree_root_unwritable",
      `REEMOAT_WORKTREE_ROOT must be an absolute path, got "${raw}"`,
    );
  }
  return expanded;
}

/** Human-readable, plus enough hash to stay unique when two repos share a name. */
function repoKey(mainRoot: string, commonDir: string): string {
  const base = (mainRoot.split(sep).pop() ?? "repo").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
  const hash = createHash("sha256").update(commonDir).digest("hex").slice(0, 8);
  return `${base || "repo"}-${hash}`;
}

/* ------------------------------------------------------------------------- *
 * Inspection
 * ------------------------------------------------------------------------- */

export async function inspectRepo(dir: string, runner: GitExec): Promise<RepoInfo> {
  const empty: RepoInfo = {
    isRepo: false,
    bare: false,
    insideWorkTree: false,
    gitDir: null,
    commonDir: null,
    toplevel: null,
    mainRoot: null,
    linked: false,
    headCommit: null,
    headBranch: null,
    dirty: null,
  };

  // Deliberately separate from the call below. `rev-parse --show-toplevel` dies
  // in a bare repo ("this operation must be run in a work tree"), so a combined
  // invocation would report a perfectly usable bare repo as "not a repo".
  let bare = false;
  let insideWorkTree = false;
  try {
    const probe = linesOf(
      await runner.run(["rev-parse", "--is-bare-repository", "--is-inside-work-tree"], structural(dir)),
    );
    bare = probe[0] === "true";
    insideWorkTree = probe[1] === "true";
  } catch (error) {
    if (error instanceof GitError && error.code === "git_failed") return empty;
    throw error;
  }

  const paths = linesOf(
    await runner.run(
      bare
        ? ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]
        : ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
      structural(dir),
    ),
  );
  const gitDir = paths[0] ?? null;
  const commonDir = paths[1] ?? null;
  const toplevel = bare || !paths[2] ? null : paths[2];

  // `--path-format=absolute` matters: without it `--git-common-dir` answers with a
  // relative ".git", which silently resolves against the wrong directory later.
  const headCommit = await optional(
    runner.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { ...structural(dir), okExitCodes: [0, 1] }),
  );
  const headBranch = await optional(
    runner.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { ...structural(dir), okExitCodes: [0, 1] }),
  );

  const entries = commonDir ? await listWorktrees(dir, runner) : [];
  const mainRoot = entries[0]?.path ?? toplevel;

  let dirty: RepoInfo["dirty"] = null;
  if (!bare) {
    const counts = await countStatus(dir, false, runner);
    dirty = { tracked: counts.tracked, untracked: counts.untracked };
  }

  return {
    isRepo: true,
    bare,
    insideWorkTree,
    gitDir,
    commonDir,
    toplevel,
    mainRoot: mainRoot ?? null,
    // Authoritative: inside a linked worktree, --git-dir is <common>/worktrees/<name>.
    linked: gitDir !== null && commonDir !== null && gitDir !== commonDir,
    headCommit,
    headBranch,
    dirty,
  };
}

export async function listWorktrees(dir: string, runner: GitExec): Promise<WorktreeEntry[]> {
  const run = await runner.run(["worktree", "list", "--porcelain", "-z"], {
    dir,
    timeoutMs: GIT_TIMEOUT_LIST_MS,
    maxBytes: GIT_MAX_LIST_BYTES,
  });

  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  const flush = (): void => {
    if (current) out.push(current);
    current = null;
  };

  // With -z each attribute is NUL-terminated and the blank line that separates
  // records becomes an empty token.
  for (const token of splitNul(run.stdout)) {
    const line = token.toString("utf8");
    if (line.length === 0) {
      flush();
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);

    switch (key) {
      case "worktree":
        flush();
        current = {
          // The agent's side, like everything else git prints.
          path: value,
          head: null,
          branch: null,
          detached: false,
          bare: false,
          locked: false,
          lockedReason: null,
          prunable: false,
        };
        break;
      case "HEAD":
        if (current) current.head = value;
        break;
      case "branch":
        if (current) current.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        if (current) current.detached = true;
        break;
      case "bare":
        if (current) current.bare = true;
        break;
      case "locked":
        if (current) {
          current.locked = true;
          current.lockedReason = value.length > 0 ? value : null;
        }
        break;
      case "prunable":
        if (current) current.prunable = true;
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------------- *
 * Creation
 * ------------------------------------------------------------------------- */

export async function createWorkspace(options: CreateWorkspaceOptions): Promise<CreateWorkspaceResult> {
  const warnings: WorkspaceWarning[] = [];
  const { runner } = options;
  const plain = (reason: PlainReason): CreateWorkspaceResult => ({
    workspace: {
      mode: "plain",
      root: options.cwd,
      requestedCwd: options.cwd,
      git: null,
      plainReason: reason,
      createdAt: Date.now(),
    },
    warnings,
  });

  if (options.policy === "never") {
    const info = await safeInspect(options.cwd, options.runner);
    if (info?.bare) {
      throw new WorktreeError(
        "bare_repo_needs_worktree",
        "this is a bare repository, so there is no working tree for an agent to run in",
      );
    }
    // A plain session on a git repo still records the base commit, so the changes
    // API has exactly one code path rather than two.
    return {
      workspace: {
        mode: "plain",
        root: options.cwd,
        requestedCwd: options.cwd,
        git:
          info?.isRepo && info.commonDir && info.mainRoot && info.headCommit
            ? {
                repoRoot: info.mainRoot,
                commonDir: info.commonDir,
                branch: info.headBranch,
                createdBranch: false,
                baseCommit: info.headCommit,
              }
            : null,
        plainReason: "not_requested",
        createdAt: Date.now(),
      },
      warnings,
    };
  }

  let info: RepoInfo;
  try {
    info = await inspectRepo(options.cwd, options.runner);
  } catch (error) {
    if (error instanceof GitError && error.code === "git_missing") {
      if (options.policy === "require") throw asWorktreeError(error);
      return plain("git_missing");
    }
    throw asWorktreeError(error);
  }

  if (!info.isRepo) {
    if (options.policy === "require") {
      throw new WorktreeError("not_a_repo", `${options.cwd} is not inside a git repository`);
    }
    return plain("not_a_repo");
  }
  if (info.headCommit === null) {
    // `git worktree add` needs a commit to branch from. Reported as its own case
    // rather than surfacing a raw git failure.
    if (options.policy === "require") {
      throw new WorktreeError(
        "unborn_head",
        "this repository has no commits yet, so there is nothing to branch a worktree from",
      );
    }
    return plain("unborn_head");
  }

  const repoRoot = info.mainRoot;
  const commonDir = info.commonDir;
  if (!repoRoot || !commonDir) {
    if (options.policy === "require") {
      throw new WorktreeError("not_a_repo", "could not locate the repository's main worktree");
    }
    return plain("not_a_repo");
  }

  if (info.linked) {
    warnings.push({
      code: "linked_worktree_source",
      message:
        `${options.cwd} is itself a linked worktree; branching from its HEAD and ` +
        `registering the new worktree against ${repoRoot}`,
      mainRoot: repoRoot,
    });
  }
  if (info.headBranch === null) {
    warnings.push({
      code: "detached_source",
      message: "the source checkout has a detached HEAD; branching from the commit it points at",
    });
  }

  // The whole point of a worktree is that it starts from a *commit*, so anything
  // uncommitted here is not in it. Warn loudly; never refuse — refusing would
  // make the common case (a dirty checkout) unusable.
  if (info.dirty && info.dirty.tracked + info.dirty.untracked > 0) {
    warnings.push({
      code: "dirty_source",
      message:
        `${repoRoot} has ${info.dirty.tracked} uncommitted change(s) and ${info.dirty.untracked} ` +
        "untracked file(s). A worktree branches from a commit, so none of that is in this session.",
      tracked: info.dirty.tracked,
      untracked: info.dirty.untracked,
    });
  }

  const repoDir = join(options.worktreeRoot, repoKey(repoRoot, commonDir));
  const root = join(repoDir, options.sessionId);
  if (existsSync(root)) {
    throw new WorktreeError(
      "workspace_path_taken",
      `${root} already exists; a previous session was not cleaned up`,
      { path: root },
    );
  }

  // Checked before the checkout, not only before the `rm`.
  //
  // `removeWorkspace` has always asserted containment before it will delete
  // anything; creation asserted nothing, and the asymmetry was the bug. This is
  // **self-protection** rather than a boundary: the agent runs as this user and
  // can write under the worktree root regardless, so what the check guards is the
  // one `rmSync` in this codebase, not the agent. `repoKey` is
  // `<basename>-<sha256(commonDir)[0:8]>` — computable
  // by an agent that has seen its own worktree's gitfile. Replacing that one
  // directory with a symlink redirected the next session's checkout anywhere the
  // daemon could write. `existsSync(root)` never caught it, because the leaf is
  // a fresh session id.
  //
  // `lstat` rather than `atOrUnder` for the parent: the question is whether this
  // component *is* a link, and a resolving check would follow it and answer
  // about the target.
  if (existsSync(repoDir)) {
    let link = false;
    try {
      link = lstatSync(repoDir).isSymbolicLink();
    } catch {
      // Vanished between the two calls. The containment check below still runs,
      // and `worktree add` will fail honestly if it is genuinely unusable.
    }
    if (link) {
      throw new WorktreeError(
        "outside_worktree_root",
        "the worktree directory for this repository is a symlink and was not followed",
        { path: repoDir },
      );
    }
  }
  /*
   * Both sides in **one namespace**, which `containedIn` cannot manage here.
   *
   * That helper resolves each side and falls back to the literal string when
   * `realpath` throws — right where a path is merely not created yet, and wrong
   * when only *one* of the two is in that state, which is exactly this call. The
   * leaf is a fresh session id, so it always throws and is compared as written,
   * while the root beside it resolves fully. On any host whose worktree root
   * traverses a symlink — `/tmp` on macOS, `~/.reemoat` moved onto another disk
   * with a link left behind — the two answers are in different namespaces, the
   * prefix test fails, and **every** session creation is refused with an error
   * accusing the daemon's own configured root of being outside itself. The same
   * defect `browse.ts` already fixed, which `resolveWorktreeRoot` never adopted.
   *
   * So the deepest component that *exists* is resolved, and the components that
   * do not exist yet are appended to that answer. `relative`/`join` rather than
   * `slice`, because a root with a trailing separator would otherwise splice two
   * path components into one.
   *
   * Still synchronous, and still allowed to be: these are the daemon's own
   * directories, which is the exception `stall.ts` states — nothing here is a
   * path a caller named.
   */
  const anchor = existsSync(repoDir) ? repoDir : options.worktreeRoot;
  const candidate = join(realpathQuiet(anchor), relative(anchor, root));
  if (!containedInResolved(candidate, realpathQuiet(options.worktreeRoot))) {
    throw new WorktreeError(
      "outside_worktree_root",
      `${root} is outside the managed worktree root`,
      { path: root, worktreeRoot: options.worktreeRoot },
    );
  }

  const branch = await pickBranch(options, repoRoot, warnings, runner);
  // Resolved to a sha before the add, never the string "HEAD": that closes the
  // race where the source checkout's HEAD moves between here and the checkout,
  // and makes baseCommit provably the commit this tree started from.
  const baseCommit = info.headCommit;

  try {
    await runner.run(
      // --no-track/--no-guess-remote so behaviour does not depend on the user's
      // worktree.guessRemote or branch.autoSetupMerge.
      ["worktree", "add", "--no-track", "--no-guess-remote", "-b", branch, "--", root, baseCommit],
      { dir: repoRoot, timeoutMs: GIT_TIMEOUT_MUTATE_MS, maxBytes: GIT_MAX_LIST_BYTES },
    );
  } catch (error) {
    throw classifyAddFailure(error, branch, options.branchPrefix, root);
  }

  // Re-checked against the real filesystem now that the directory exists. The
  // test above is about the path we were going to use; this one is about the
  // tree that actually got created, and only `realpath` can tell us a component
  // was a link all along.
  if (!containedIn(root, options.worktreeRoot)) {
    throw new WorktreeError(
      "outside_worktree_root",
      `${root} resolved outside the managed worktree root once created`,
      { path: root, worktreeRoot: options.worktreeRoot },
    );
  }

  return {
    workspace: {
      mode: "worktree",
      root,
      requestedCwd: options.cwd,
      git: { repoRoot, commonDir, branch, createdBranch: true, baseCommit },
      plainReason: null,
      createdAt: Date.now(),
    },
    warnings,
  };
}

/**
 * Picks a branch name nothing else is using.
 *
 * Session ids are eight random hex characters, so the default collides only if a
 * previous session with the same id left its branch behind. A client-supplied
 * name is the case that really collides, and it gets a bounded suffix search
 * rather than either silently adopting someone else's branch or spinning.
 */
async function pickBranch(
  options: CreateWorkspaceOptions,
  repoRoot: string,
  warnings: WorkspaceWarning[],
  runner: GitExec,
): Promise<string> {
  const hint = options.branchHint?.trim();
  let requested: string;
  if (hint && hint.length > 0) {
    try {
      await runner.run(["check-ref-format", "--branch", hint], structural(repoRoot));
    } catch {
      throw new WorktreeError("invalid_branch", `"${hint}" is not a valid git branch name`);
    }
    requested = hint;
  } else {
    requested = `${options.branchPrefix}/${options.sessionId}`;
  }

  for (let attempt = 1; attempt <= BRANCH_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? requested : `${requested}-${attempt}`;
    const taken = await exists(repoRoot, `refs/heads/${candidate}`, runner);
    if (!taken) {
      if (candidate !== requested) {
        warnings.push({
          code: "branch_renamed",
          message: `branch ${requested} already exists; used ${candidate} instead`,
          requested,
          actual: candidate,
        });
      }
      return candidate;
    }
  }

  throw new WorktreeError(
    "branch_collision",
    `${requested} and ${BRANCH_SUFFIX_ATTEMPTS - 1} suffixed variants all already exist`,
    { requested },
  );
}

async function exists(repoRoot: string, ref: string, runner: GitExec): Promise<boolean> {
  const run = await runner.run(["show-ref", "--verify", "--quiet", "--", ref], {
    ...structural(repoRoot),
    okExitCodes: [0, 1],
  });
  return run.exitCode === 0;
}

function classifyAddFailure(error: unknown, branch: string, prefix: string, root: string): WorktreeError {
  if (!(error instanceof GitError)) return asWorktreeError(error);
  const stderr = error.stderr;
  if (/is already checked out at|is already used by worktree/i.test(stderr)) {
    return new WorktreeError(
      "branch_in_use",
      `branch ${branch} is already checked out in another worktree`,
      { branch, stderr: stderr.trim() },
    );
  }
  if (/cannot lock ref|would clobber existing tag|not a valid (branch|ref) name/i.test(stderr)) {
    return new WorktreeError(
      "branch_namespace_conflict",
      `could not create branch ${branch}: a ref named "${prefix}" already exists, which blocks ` +
        `"${prefix}/…". Set REEMOAT_BRANCH_PREFIX to something else.`,
      { branch, stderr: stderr.trim() },
    );
  }
  if (/already exists/i.test(stderr)) {
    return new WorktreeError("workspace_path_taken", `${root} already exists`, { path: root });
  }
  return asWorktreeError(error);
}

/* ------------------------------------------------------------------------- *
 * Status and removal
 * ------------------------------------------------------------------------- */

export async function inspectWorkspace(workspace: SessionWorkspace, runner: GitExec): Promise<WorkspaceStatus> {
  const base: WorkspaceStatus = {
    mode: workspace.mode,
    root: workspace.root,
    // Bounded and remembered, never `existsSync`: see `stall.ts`. Synchronously
    // this call stopped the event loop for the whole daemon whenever the
    // session's directory sat on a mount that had stopped answering.
    exists: await probeExists(workspace.root),
    registered: false,
    branch: workspace.git?.branch ?? null,
    baseCommit: workspace.git?.baseCommit ?? null,
    headCommit: null,
    commitsAhead: null,
    hasRemote: false,
    unpushed: null,
    dirty: null,
    locked: false,
  };
  if (workspace.mode !== "worktree" || !workspace.git) return base;

  const entries = await listWorktrees(workspace.git.repoRoot, runner).catch(() => [] as WorktreeEntry[]);
  // Sequentially rather than a `find` over a `Promise.all`, because every probe
  // costs a libuv threadpool slot and the match usually lands on the literal
  // comparison in `samePath` without touching the filesystem at all. A candidate
  // that did not answer is remembered as unknown rather than skipped: if none of
  // the others matches, "not registered" is a claim we have no basis for.
  let entry: WorktreeEntry | undefined;
  let unknownCandidate = false;
  for (const candidate of entries) {
    const same = await samePath(candidate.path, workspace.root);
    if (same === true) {
      entry = candidate;
      break;
    }
    if (same === null) unknownCandidate = true;
  }
  base.registered = entry !== undefined ? true : unknownCandidate ? null : false;
  base.locked = entry?.locked ?? false;
  // `!== true`, so "could not tell" takes the same path as "gone": both mean we
  // must not go on to run git *inside* that directory, and both leave the branch
  // and its commits perfectly countable from `repoRoot`, which is ours and local.
  if (base.exists !== true) {
    // The checkout is gone but the branch is not, and the commits on it are still
    // in the object database. Counting them from `repoRoot` is what keeps the
    // unpushed-commits refusal answerable here — without it `removeWorkspace`
    // reaches `branch -D` with `null` for both counts and nothing to refuse on,
    // which is how a `--delete-branch` on a directory somebody already `rm`ed
    // destroys the only copy of that work.
    await countFromRepo(base, workspace.git, runner);
    return base;
  }

  // Everything below is best-effort on purpose. The directory can exist and yet
  // no longer be a usable worktree — the repo moved, the admin dir was pruned out
  // of band, the `.git` file is stale — and `rev-parse` then exits 128 rather
  // than the 1 we tolerate. Letting that throw would take `GET .../workspace` and
  // `DELETE .../workspace?force=1` down with it, so the one state the recovery
  // path exists for would be the one state it cannot recover from.
  base.headCommit = await optional(
    runner.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      ...structural(workspace.root),
      okExitCodes: [0, 1],
    }),
  ).catch(() => null);

  base.dirty = await countStatus(workspace.root, true, runner).catch(() => null);

  base.commitsAhead = await count(workspace.root, ["rev-list", "--count", `${workspace.git.baseCommit}..HEAD`], runner);

  const remotes: string[] = await runner.run(["remote"], structural(workspace.root))
    .then(linesOf)
    .catch(() => []);
  base.hasRemote = remotes.length > 0;
  if (base.hasRemote) {
    // Reachability from *any* remote-tracking ref, which is the real "would I
    // lose this" question. Never `@{upstream}` — that throws when unset, which is
    // exactly the case we most need an answer for.
    base.unpushed = await count(workspace.root, ["rev-list", "--count", "HEAD", "--not", "--remotes"], runner);
  }

  return base;
}

/**
 * Fills in the commit counts from the main worktree, for a checkout that is gone.
 *
 * Everything here is best-effort for the same reason the in-worktree path is: a
 * branch that no longer exists is a legitimate answer, not a failure. But the
 * counts are left `null` only when we genuinely could not tell, never as a side
 * effect of the directory being missing — a `null` here reads as "cannot tell"
 * to `removeWorkspace`, which is the one place it must not silently mean "zero".
 */
async function countFromRepo(
  base: WorkspaceStatus,
  git: NonNullable<SessionWorkspace["git"]>,
  runner: GitExec,
): Promise<void> {
  if (!git.branch) return;
  const ref = `refs/heads/${git.branch}`;
  if (!(await exists(git.repoRoot, ref, runner).catch(() => false))) return;

  base.headCommit = await optional(
    runner.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      ...structural(git.repoRoot),
      okExitCodes: [0, 1],
    }),
  ).catch(() => null);

  base.commitsAhead = await count(git.repoRoot, ["rev-list", "--count", `${git.baseCommit}..${ref}`], runner);

  const remotes: string[] = await runner.run(["remote"], structural(git.repoRoot)).then(linesOf).catch(() => []);
  base.hasRemote = remotes.length > 0;
  if (base.hasRemote) {
    base.unpushed = await count(git.repoRoot, ["rev-list", "--count", ref, "--not", "--remotes"], runner);
  }
}

export interface RemoveWorkspaceOptions {
  /** Where git runs. Host paths in and out; see `GitExec`. */
  runner: GitExec;
  workspace: SessionWorkspace;
  /** For the containment assertion before any filesystem removal. */
  worktreeRoot: string;
  force: boolean;
  deleteBranch: boolean;
}

export async function removeWorkspace(options: RemoveWorkspaceOptions): Promise<RemoveWorkspaceResult> {
  const { workspace, runner } = options;
  // A plain session runs in a directory the client chose. We did not create it
  // and we will not remove it.
  if (workspace.mode !== "worktree" || !workspace.git) {
    return { kind: "not_applicable", reason: "plain_directory" };
  }

  const status = await inspectWorkspace(workspace, runner);
  const refusals: RemoveRefusal[] = [];

  if (!options.force) {
    const dirty = status.exists ? status.dirty : null;
    if (dirty && dirty.tracked + dirty.untracked > 0) {
      refusals.push({
        code: "dirty",
        message:
          `${workspace.root} has ${dirty.tracked} uncommitted change(s) and ` +
          `${dirty.untracked} untracked file(s)`,
        tracked: dirty.tracked,
        untracked: dirty.untracked,
        ignored: dirty.ignored,
      });
    }
    // The directory is there and `git status` did not answer, which is a
    // different sentence from "it is clean" — and the one that used to be read as
    // it. `countStatus` returns `null` for a 15s timeout on a large tree and for a
    // stale `.git` gitfile alike, so the refusal above silently did not fire and
    // the guarded `rmSync` below deleted work nobody had been told about.
    // `exists !== true` is deliberately not this case: there is nothing there to
    // hold changes, and refusing would make the state this path exists to clean
    // up the one it cannot.
    if (status.exists === true && status.dirty === null) {
      refusals.push({
        code: "counts_unknown",
        message: `could not tell whether ${workspace.root} holds uncommitted work`,
        about: "dirty",
      });
    }
    if (status.locked) {
      refusals.push({ code: "locked", message: `${workspace.root} is locked` });
    }
    // Only a concern when the branch is going away with the worktree: removing a
    // worktree on its own never loses a commit.
    if (options.deleteBranch) {
      const orphaned = status.hasRemote ? status.unpushed : status.commitsAhead;
      // `?? 0` here was the whole defect: `count()` answers `null` for a timed-out
      // `rev-list`, a 128 from a stale gitfile and an unparseable number alike, so
      // "could not tell" became "nothing to lose" and `branch -D` ran over commits
      // that exist in no other ref and on no remote. Gated on the branch actually
      // being at risk, because a branch we did not create is never deleted below
      // and refusing on its behalf would be a refusal that changes nothing.
      if (orphaned === null && workspace.git.createdBranch && workspace.git.branch) {
        refusals.push({
          code: "counts_unknown",
          message:
            `could not tell how many commits on ${status.branch} exist nowhere else, and ` +
            `deleting the branch would be irreversible`,
          about: "commits",
        });
      } else if (orphaned !== null && orphaned > 0) {
        refusals.push({
          code: "unpushed_commits",
          message: status.hasRemote
            ? `${orphaned} commit(s) on ${status.branch} are not on any remote`
            : `${orphaned} commit(s) on ${status.branch} exist nowhere else — this repo has no remotes`,
          count: orphaned,
          hasRemote: status.hasRemote,
        });
      }
    }
  }

  if (refusals.length > 0) return { kind: "refused", refusals, status };

  const warnings: string[] = [];
  const repoRoot = workspace.git.repoRoot;
  const removeArgs = ["worktree", "remove"];
  // A locked worktree needs the flag twice.
  if (options.force) removeArgs.push("--force");
  if (options.force && status.locked) removeArgs.push("--force");
  removeArgs.push("--", workspace.root);

  let removeError: unknown = null;
  try {
    await runner.run(removeArgs, { dir: repoRoot, timeoutMs: GIT_TIMEOUT_MUTATE_MS, maxBytes: GIT_MAX_LIST_BYTES });
  } catch (error) {
    removeError = error;
    warnings.push(describeError(error));
    // Fall through: the prune below handles the case where the directory was
    // already gone, and the guarded rm handles a partial removal.
  }

  /*
   * **git refusing is not a partial removal, and the fall-through above treated
   * it as one.** `git worktree remove` without `--force` declines when the tree
   * holds modified or untracked files; that failure was pushed onto `warnings`
   * and execution carried straight on to the guarded `rmSync(recursive, force)`,
   * which deleted exactly the work git had just declined to delete — and the
   * route answered `200 {removed: true}`. So a caller who deliberately did not
   * pass `force` got the forced behaviour, with the refusal reduced to a warning
   * nobody had to read.
   *
   * Recognised by git's own stderr rather than by the failure existing at all,
   * on the same reasoning as `classifyAddFailure`: every *other* way this call
   * can fail — a stale gitfile, an unregistered directory, half-written admin
   * metadata — is precisely what the guarded rm and the prune are there to clean
   * up, and refusing on those would make the recovery path unreachable in the one
   * state it exists for.
   *
   * Returning here skips the prune, which has nothing to do: a worktree git has
   * just declined to remove is by definition still registered and still present.
   */
  if (removeError !== null && !options.force) {
    const stderr = removeError instanceof GitError ? removeError.stderr : "";
    if (/contains modified or untracked files|use --force/i.test(stderr)) {
      return {
        kind: "refused",
        refusals: [
          {
            code: "remove_refused",
            message: `git will not remove ${workspace.root} while it holds work`,
            stderr: stderr.trim(),
          },
        ],
        status,
      };
    }
  }

  // Three answers, and the third one must not delete anything. `null` is "the
  // filesystem did not reply in time", which is precisely when guessing is worst:
  // the guarded `rm` below is the only one in this codebase, and running it
  // against a path we could not even stat is the opposite of the caution every
  // other line here is written with.
  const present = await probeExists(workspace.root);
  if (present === null) {
    warnings.push(
      `${workspace.root} did not answer, so it was left in place; the worktree registration was pruned`,
    );
  }
  if (present === true) {
    // Only ever inside the root we manage. We never delete a directory we did not
    // create, whatever a stale record claims.
    if (containedIn(workspace.root, options.worktreeRoot)) {
      try {
        rmSync(workspace.root, { recursive: true, force: true });
      } catch (error) {
        warnings.push(`could not remove ${workspace.root}: ${describeError(error)}`);
      }
    } else {
      warnings.push(
        `${workspace.root} is outside the managed worktree root (${options.worktreeRoot}) and was left alone`,
      );
    }
  }

  // Unconditional, on every path including the ones that already failed. This is
  // what makes "leaves no stale git metadata" true rather than hoped-for: it
  // covers a directory deleted out of band, a `worktree add` we SIGKILLed on
  // timeout leaving half-written metadata, and a `remove` that bailed part-way.
  let pruned = false;
  try {
    await runner.run(["worktree", "prune", "--expire=now"], {
      dir: repoRoot,
      timeoutMs: GIT_TIMEOUT_LIST_MS,
      maxBytes: GIT_MAX_LIST_BYTES,
    });
    pruned = true;
  } catch (error) {
    warnings.push(`prune failed: ${describeError(error)}`);
  }

  const remaining = await listWorktrees(repoRoot, runner).catch(() => [] as WorktreeEntry[]);
  let stillRegistered = false;
  let unknownRemaining = false;
  for (const entry of remaining) {
    const same = await samePath(entry.path, workspace.root);
    if (same === true) {
      stillRegistered = true;
      break;
    }
    if (same === null) unknownRemaining = true;
  }
  if (stillRegistered) {
    warnings.push(`${workspace.root} is still registered as a worktree`);
  } else if (unknownRemaining) {
    // "Could not tell" gets its own sentence rather than silence: a path that did
    // not answer is exactly when a stale registration is most likely, and the
    // caller reads these warnings to decide whether to look.
    warnings.push(`could not tell whether ${workspace.root} is still registered as a worktree`);
  }

  let branchDeleted = false;
  // Never a branch we did not create: that is where somebody else's commits live.
  if (options.deleteBranch && workspace.git.createdBranch && workspace.git.branch) {
    try {
      // -D rather than -d: we have already made the unpushed decision above with
      // better information than -d has, and -d would refuse a branch merged into
      // baseCommit but not into whatever the main checkout happens to be on.
      await runner.run(["branch", "-D", "--", workspace.git.branch], {
        dir: repoRoot,
        timeoutMs: GIT_TIMEOUT_STRUCTURAL_MS,
        maxBytes: GIT_MAX_STRUCTURAL_BYTES,
      });
      branchDeleted = true;
    } catch (error) {
      warnings.push(`could not delete branch ${workspace.git.branch}: ${describeError(error)}`);
    }
  }

  return { kind: "removed", branchDeleted, pruned, warnings };
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function structural(dir: string): { dir: string; timeoutMs: number; maxBytes: number } {
  return { dir, timeoutMs: GIT_TIMEOUT_STRUCTURAL_MS, maxBytes: GIT_MAX_STRUCTURAL_BYTES };
}

/** Counts porcelain-v2 records without parsing them. */
async function countStatus(
  dir: string,
  includeIgnored: boolean,
  runner: GitExec,
): Promise<{ tracked: number; untracked: number; ignored: number }> {
  const args = ["status", "--porcelain=v2", "-z", "--untracked-files=all"];
  if (includeIgnored) args.push("--ignored=matching");
  const run = await runner.readCapped(args, {
    dir,
    timeoutMs: GIT_TIMEOUT_READ_MS,
    maxBytes: GIT_MAX_STATUS_BYTES,
  });

  let tracked = 0;
  let untracked = 0;
  let ignored = 0;
  const tokens = splitNul(run.stdout);
  for (let i = 0; i < tokens.length; i += 1) {
    const kind = tokens[i]?.[0];
    if (kind === 0x31 /* 1 */ || kind === 0x75 /* u */) tracked += 1;
    else if (kind === 0x32 /* 2 */) {
      tracked += 1;
      i += 1; // a rename record spans two NUL-separated tokens
    } else if (kind === 0x3f /* ? */) untracked += 1;
    else if (kind === 0x21 /* ! */) ignored += 1;
  }
  return { tracked, untracked, ignored };
}

async function count(dir: string, args: readonly string[], runner: GitExec): Promise<number | null> {
  try {
    const value = Number.parseInt(textOf(await runner.run(args, structural(dir))), 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    // A missing ref or an unborn branch is an answer of "cannot tell", not a
    // failure worth aborting the whole inspection for.
    return null;
  }
}

async function optional(run: Promise<{ stdout: Buffer; exitCode: number }>): Promise<string | null> {
  const result = await run;
  if (result.exitCode !== 0) return null;
  const value = result.stdout.toString("utf8").trim();
  return value.length > 0 ? value : null;
}

async function safeInspect(dir: string, runner: GitExec): Promise<RepoInfo | null> {
  try {
    return await inspectRepo(dir, runner);
  } catch {
    // Callers that reach here already have a non-git answer to fall back on.
    return null;
  }
}

/**
 * `realpath`, falling back to the path as written.
 *
 * The same rule `paths.ts` states for `resolved()`, kept local because the one
 * caller needs the two halves *separately* — resolve the ancestor that exists,
 * then rebuild the leaf on top of it — which a helper that resolves whole paths
 * cannot express.
 */
function realpathQuiet(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not created yet, or a component that is not a directory. Compared as
    // written, which is what the caller wants for a path it is about to make.
    return path;
  }
}

/**
 * Are these two paths the same directory — **with "could not tell" as a real
 * third answer**?
 *
 * This was `realpathSync(a) === realpathSync(b)`, and `a` is the one path in this
 * file that this daemon certainly did **not** create: it comes out of `git
 * worktree list` on the caller's own repository, so `git worktree add ~/nas/x`
 * on a mount whose server then pauses made an uninterruptible event-loop stop out
 * of `GET /sessions/:id/workspace` and `DELETE .../workspace` alike — every
 * session, every socket and `/health` with it, at 0% CPU. That is the invariant
 * `stall.ts` exists for, and `GET /worktrees` in `server.ts` had already fixed
 * the byte-identical pattern with the same probe.
 *
 * The literal comparison stays first, so the ordinary case — git printing back
 * exactly the path we asked it to create — costs no filesystem call at all.
 *
 * `missing` is `false`, which is what the `catch` this replaced answered and is
 * right: a path with nothing at it is not the same directory as one that exists.
 * `null` is the answer that did not exist before — the filesystem did not reply —
 * and it is emphatically not `false`. Both callers take it as "could not tell",
 * the same distinction `count()` and `exists` already carry in this file.
 */
async function samePath(a: string, b: string): Promise<boolean | null> {
  if (a === b) return true;
  // `a` first: it is the untrusted one, so a stalled mount is answered without
  // spending a second probe on the path we do own.
  const left = await probeRealpath(a);
  if (left === null) return null;
  const right = await probeRealpath(b);
  if (right === null) return null;
  if (left.kind === "missing" || right.kind === "missing") return false;
  return left.value === right.value;
}


export function asWorktreeError(error: unknown): WorktreeError {
  if (error instanceof WorktreeError) return error;
  if (error instanceof GitError) {
    return new WorktreeError(error.code, error.message, { stderr: error.stderr.trim() });
  }
  return new WorktreeError("git_failed", describeError(error));
}
