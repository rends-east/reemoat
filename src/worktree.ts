import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";

import { probeExists, probeRealpath } from "./stall.js";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PlainReason, SessionWorkspace } from "./events.js";
import { containedIn, containedInResolved, expandHome, resolveStateRoot } from "./paths.js";
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

export const DEFAULT_BRANCH_PREFIX = "reemoat";
const BRANCH_SUFFIX_ATTEMPTS = 10;

export interface RepoInfo {
  isRepo: boolean;
  bare: boolean;
  insideWorkTree: boolean;
  gitDir: string | null;
  commonDir: string | null;
  toplevel: string | null;
  /** The main worktree — where `worktree add`/`remove`/`prune` have to run. */
  mainRoot: string | null;
  linked: boolean;
  headCommit: string | null;
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
  /** `null` means could not tell (a stalled mount), never deleted; `registered` is three-valued the same way. */
  exists: boolean | null;
  registered: boolean | null;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  commitsAhead: number | null;
  hasRemote: boolean;
  /** Commits reachable from HEAD but from no remote-tracking ref. Null with no remotes. */
  unpushed: number | null;
  dirty: { tracked: number; untracked: number; ignored: number } | null;
  locked: boolean;
}

/** Why a removal did not happen; `force` cures every one, and a count we could not take is never read as zero. */
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
  policy: "auto" | "require" | "never";
  worktreeRoot: string;
  branchPrefix: string;
  branchHint?: string | null;
  runner: GitExec;
}

export interface CreateWorkspaceResult {
  workspace: SessionWorkspace;
  warnings: WorkspaceWarning[];
}

/** Outside every repository, or each worktree shows as untracked in the parent; defaults to `worktrees` under the state root (Q7.148). */
export function resolveWorktreeRoot(spec: string | undefined, root: string = resolveStateRoot(undefined)): string {
  const raw = (spec ?? "").trim();
  if (raw.length === 0) return join(root, "worktrees");
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

  // Separate from the call below: `--show-toplevel` dies in a bare repo, which would then read as not a repo.
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

  // With -z the blank line between records becomes an empty token.
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
    // A plain session on a repo still records the base commit, so the changes API has one code path.
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

  // Warn, never refuse: a dirty checkout is the common case.
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

  // Refuse a symlinked repo directory before the checkout: repoKey is guessable, and a link would redirect the checkout the guarded rmSync later deletes.
  if (existsSync(repoDir)) {
    let link = false;
    try {
      link = lstatSync(repoDir).isSymbolicLink();
    } catch {
      // Vanished between the calls; the containment check below still runs.
    }
    if (link) {
      throw new WorktreeError(
        "outside_worktree_root",
        "the worktree directory for this repository is a symlink and was not followed",
        { path: repoDir },
      );
    }
  }
  // Resolve the deepest existing component and append the rest, so both sides share one namespace under a symlinked root.
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
  // A sha, never HEAD: the source checkout's HEAD may move before the add.
  const baseCommit = info.headCommit;

  try {
    await runner.run(
      // Independent of the user's worktree.guessRemote and branch.autoSetupMerge.
      ["worktree", "add", "--no-track", "--no-guess-remote", "-b", branch, "--", root, baseCommit],
      { dir: repoRoot, timeoutMs: GIT_TIMEOUT_MUTATE_MS, maxBytes: GIT_MAX_LIST_BYTES },
    );
  } catch (error) {
    throw classifyAddFailure(error, branch, options.branchPrefix, root);
  }

  // Re-checked once created: only realpath can reveal a component that was a link all along.
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

export async function inspectWorkspace(workspace: SessionWorkspace, runner: GitExec): Promise<WorkspaceStatus> {
  const base: WorkspaceStatus = {
    mode: workspace.mode,
    root: workspace.root,
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
  // Sequential, since the literal match usually costs no probe; an unanswered candidate leaves `registered` unknown.
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
  // Could-not-tell takes the gone path: never run git inside it, and the branch is still countable from repoRoot.
  if (base.exists !== true) {
    await countFromRepo(base, workspace.git, runner);
    return base;
  }

  // Best-effort: a directory that is no longer a usable worktree must not break the routes that exist to recover it.
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
    // Reachable from no remote-tracking ref; never @{upstream}, which throws when unset.
    base.unpushed = await count(workspace.root, ["rev-list", "--count", "HEAD", "--not", "--remotes"], runner);
  }

  return base;
}

/** For a checkout that is gone; `null` counts mean could-not-tell to removeWorkspace, never zero. */
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
  runner: GitExec;
  workspace: SessionWorkspace;
  worktreeRoot: string;
  force: boolean;
  deleteBranch: boolean;
}

export async function removeWorkspace(options: RemoveWorkspaceOptions): Promise<RemoveWorkspaceResult> {
  const { workspace, runner } = options;
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
    // Present but git status did not answer is not clean: refuse rather than let the guarded rm delete it.
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
    if (options.deleteBranch) {
      const orphaned = status.hasRemote ? status.unpushed : status.commitsAhead;
      // `null` is could-not-tell, never zero; gated on createdBranch because no other branch is deleted below.
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
    // Fall through: the prune handles an already-gone directory and the guarded rm a partial removal.
  }

  // git declining a tree that holds work is a refusal, not a partial removal; every other failure falls through to the rm and prune.
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

  // `null` must not delete: never run the rm on a path we could not stat.
  const present = await probeExists(workspace.root);
  if (present === null) {
    warnings.push(
      `${workspace.root} did not answer, so it was left in place; the worktree registration was pruned`,
    );
  }
  if (present === true) {
    // Only inside the managed root: never delete a directory we did not create.
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
    warnings.push(`could not tell whether ${workspace.root} is still registered as a worktree`);
  }

  let branchDeleted = false;
  // Never a branch we did not create: that is where somebody else's commits live.
  if (options.deleteBranch && workspace.git.createdBranch && workspace.git.branch) {
    try {
      // -D, not -d: the unpushed check above already decided, and -d would judge against the main checkout's branch.
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

function structural(dir: string): { dir: string; timeoutMs: number; maxBytes: number } {
  return { dir, timeoutMs: GIT_TIMEOUT_STRUCTURAL_MS, maxBytes: GIT_MAX_STRUCTURAL_BYTES };
}

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
    return null;
  }
}

function realpathQuiet(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Same directory, or `null` when a path git reported did not answer (never false); the literal match costs no probe. */
async function samePath(a: string, b: string): Promise<boolean | null> {
  if (a === b) return true;
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
