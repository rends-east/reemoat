// A task's code on this machine: its branch's head, the control commit at a run's end, and what the run changed.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffStat } from "@reemoat/board";
import { textOf, type GitExec } from "../git.js";

const GIT_TIMEOUT_MS = 20_000;
/** A fetch from origin or from a bundle may move a whole branch: longer than a status. */
const GIT_FETCH_TIMEOUT_MS = 120_000;
/** The most of a task's code that crosses machines in one move; past it the move needs its person (Q2.269). */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;

export type Bundled = { kind: "bundle"; file: string; size: number; head: string } | { kind: "current"; head: string } | { kind: "refused"; message: string };
const GIT_MAX_BYTES = 4 * 1024 * 1024;
/** Paths kept of one run's diff for the rules: enough to match against, never the whole tree. */
const MAX_DIFF_PATHS = 500;
/** Uncommitted paths a refused move names, so its person knows where to look. */
const MAX_NAMED_PATHS = 5;

export function branchFor(prefix: string, taskId: string): string {
  return `${prefix}/t-${taskId.replace(/^t_/, "")}`;
}

/** A remote's URL as the repository's name, the same on every machine that cloned it: `github.com/owner/repo`. */
export function projectIdentity(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (trimmed.length === 0) return null;
  if (!trimmed.includes("://")) {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    return scp === null ? null : `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") return null;
    const path = parsed.pathname.replace(/^\/+/, "");
    return path.length === 0 ? null : `${parsed.hostname.toLowerCase()}/${path}`;
  } catch {
    // Not a URL git would hand back: no identity, and the holder's path stands in.
    return null;
  }
}

export class TaskCodeOps {
  constructor(private readonly git: GitExec) {}

  private async run(dir: string, args: string[], ok: number[] = [0]) {
    return this.git.run(args, { dir, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES, okExitCodes: ok });
  }

  async head(dir: string): Promise<string | null> {
    try {
      const out = textOf(await this.run(dir, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1])).trim();
      return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
    } catch {
      // Not a repository, or git is gone: there is no head to name.
      return null;
    }
  }

  async identity(dir: string): Promise<string | null> {
    try {
      const url = textOf(await this.run(dir, ["config", "--get", "remote.origin.url"], [0, 1])).trim();
      return url.length === 0 ? null : projectIdentity(url);
    } catch {
      // No remote to read: the caller names the project by its path.
      return null;
    }
  }

  /** `board: <column> #<run> <executor>` over whatever the run left; null when there was nothing, the hook's words when it refused. */
  async controlCommit(dir: string, message: string): Promise<{ head: string | null; refused: string | null }> {
    try {
      const status = textOf(await this.run(dir, ["status", "--porcelain", "--untracked-files=all"])).trim();
      if (status.length === 0) return { head: await this.head(dir), refused: null };
      await this.run(dir, ["add", "-A"]);
      try {
        await this.run(dir, ["commit", "-q", "-m", message]);
      } catch (error) {
        return { head: await this.head(dir), refused: describeGit(error) };
      }
      return { head: await this.head(dir), refused: null };
    } catch (error) {
      return { head: await this.head(dir), refused: describeGit(error) };
    }
  }

  /** What of a worktree's work its branch would not carry to another machine, in words; null when it carries all of it. */
  async unsaved(dir: string, branch: string): Promise<string | null> {
    try {
      const lines = textOf(await this.run(dir, ["status", "--porcelain", "--untracked-files=all"])).split("\n").filter((line) => line.length > 0);
      if (lines.length > 0) {
        const paths = lines.slice(0, MAX_NAMED_PATHS).map((line) => line.slice(3));
        return `${lines.length} file(s) not committed: ${paths.join(", ")}${lines.length > MAX_NAMED_PATHS ? ", …" : ""}`;
      }
      const head = await this.head(dir);
      const tip = await this.branchHead(dir, branch);
      if (head !== tip) return `its worktree is not on the task's branch ${branch}, so the work there is not on it`;
      return null;
    } catch (error) {
      return `its worktree could not be read: ${describeGit(error)}`;
    }
  }

  /** The patch between two commits, cut at a byte bound: what a judge that sees the diff is shown. */
  async diffText(dir: string, from: string, to: string, maxBytes: number): Promise<string | null> {
    try {
      const run = await this.git.readCapped(["diff", "--no-color", "--no-renames", `${from}..${to}`], {
        dir,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes,
      });
      return textOf(run);
    } catch {
      // No diff to show: the judge is shown the rest.
      return null;
    }
  }

  async hasCommit(dir: string, sha: string): Promise<boolean> {
    if (!SHA.test(sha)) return false;
    try {
      return (await this.run(dir, ["cat-file", "-e", `${sha}^{commit}`], [0, 1, 128])).exitCode === 0;
    } catch {
      // Unreadable is absent: the bundle will carry it.
      return false;
    }
  }

  async branchHead(dir: string, branch: string): Promise<string | null> {
    try {
      const out = textOf(await this.run(dir, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], [0, 1])).trim();
      return SHA.test(out) ? out : null;
    } catch {
      // No such branch here yet.
      return null;
    }
  }

  async fetchOrigin(dir: string): Promise<boolean> {
    try {
      await this.git.run(["fetch", "--quiet", "origin"], { dir, timeoutMs: GIT_FETCH_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES });
      return true;
    } catch {
      // Offline or no origin: the bundle carries the whole branch instead.
      return false;
    }
  }

  /** The commits on `branch` past `have`, or the whole branch with no `have`, as one bundle file the caller removes. */
  async bundle(dir: string, branch: string, have: string | null): Promise<Bundled> {
    const head = await this.branchHead(dir, branch);
    if (head === null) return { kind: "refused", message: `this machine holds no branch ${branch}` };
    if (have !== null && have === head) return { kind: "current", head };
    if (have !== null && !(await this.hasCommit(dir, have))) have = null;
    const folder = await mkdtemp(join(tmpdir(), "reemoat-bundle-"));
    const file = join(folder, "task.bundle");
    try {
      await this.git.run(["bundle", "create", "--quiet", file, have === null ? `refs/heads/${branch}` : `${have}..refs/heads/${branch}`], {
        dir,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        maxBytes: GIT_MAX_BYTES,
      });
      const size = (await stat(file)).size;
      if (size > MAX_BUNDLE_BYTES) {
        await rm(folder, { recursive: true, force: true });
        return { kind: "refused", message: `the task's code is ${Math.round(size / 1048576)} MiB, past the ${MAX_BUNDLE_BYTES / 1048576} MiB one move carries` };
      }
      return { kind: "bundle", file, size, head };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      return { kind: "refused", message: describeGit(error) };
    }
  }

  /** The bundle's branch into this repository's own `refs/heads/<branch>`, which nothing here has checked out. */
  async fetchBundle(dir: string, file: string, branch: string): Promise<string | null> {
    try {
      await this.git.run(["fetch", "--quiet", "--no-tags", file, `+refs/heads/${branch}:refs/heads/${branch}`], {
        dir,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        maxBytes: GIT_MAX_BYTES,
      });
      return null;
    } catch (error) {
      return describeGit(error);
    }
  }

  /** The bundle's commits into a worktree that has the branch out: only forward, and only over a clean tree. */
  async fastForward(workdir: string, file: string, branch: string, head: string): Promise<"moved" | "diverged" | "dirty" | { failed: string }> {
    try {
      const status = textOf(await this.run(workdir, ["status", "--porcelain", "--untracked-files=all"])).trim();
      if (status.length > 0) return "dirty";
      await this.git.run(["fetch", "--quiet", "--no-tags", file, `refs/heads/${branch}`], { dir: workdir, timeoutMs: GIT_FETCH_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES });
      const ahead = await this.run(workdir, ["merge-base", "--is-ancestor", "HEAD", head], [0, 1]);
      if (ahead.exitCode !== 0) return "diverged";
      await this.run(workdir, ["merge", "--ff-only", "--quiet", head]);
      return "moved";
    } catch (error) {
      return { failed: describeGit(error) };
    }
  }

  async diffStat(dir: string, from: string, to: string): Promise<DiffStat | null> {
    try {
      const out = textOf(await this.run(dir, ["diff", "--numstat", "--no-renames", `${from}..${to}`]));
      let lines = 0;
      const paths: string[] = [];
      for (const line of out.split("\n")) {
        const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (match === null) continue;
        lines += (match[1] === "-" ? 0 : Number(match[1])) + (match[2] === "-" ? 0 : Number(match[2]));
        if (paths.length < MAX_DIFF_PATHS) paths.push(match[3]!);
      }
      return { files: out.split("\n").filter((line) => line.length > 0).length, lines, paths };
    } catch {
      // A diff that cannot be read says nothing; the rules read every diff fact as false.
      return null;
    }
  }
}

function describeGit(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 2_000);
}
