import { execFile } from "node:child_process";
import { spawn } from "node:child_process";

/**
 * The only place in this daemon that spawns git.
 *
 * One file, so the rules that make shelling out safe are auditable in one place
 * rather than sprayed across every caller: argv arrays and never a shell string,
 * a scrubbed environment, a timeout on every call, and nothing ever printed —
 * `src/` does not write to stdout or stderr, so failures come back as thrown
 * `GitError`s carrying everything a caller needs to report them.
 *
 * Unlike the event path, these run inside HTTP handlers, so awaiting here is
 * fine. That is worth stating because every other invariant in this codebase is
 * about not awaiting.
 */

export type GitErrorCode = "git_missing" | "git_failed" | "git_timeout" | "git_output_too_large";

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    readonly argv: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunGitOptions {
  /** Passed as `-C <dir>`, never as the child's cwd. See `gitArgs`. */
  dir: string;
  timeoutMs: number;
  maxBytes: number;
  /**
   * Exit codes that are an answer rather than a failure.
   *
   * `git diff --no-index` exits 1 to mean "these differ", which is the success
   * case for every newly created file an agent produces.
   */
  okExitCodes?: readonly number[];
}

export interface GitRun {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  /** Only ever true from `readGitCapped`. */
  truncated: boolean;
}

/* Timeouts, by what the command actually does. A new row for CLAUDE.md's Bounds. */
export const GIT_TIMEOUT_STRUCTURAL_MS = 5_000;
export const GIT_TIMEOUT_LIST_MS = 10_000;
/**
 * `worktree add` runs a checkout: post-checkout hooks, LFS smudge, a large tree.
 *
 * Raised from 30s, and the reason is that this line used to be aspirational. Both
 * of the expensive things it names were *disabled* on this path — hooks by
 * `core.hooksPath=/dev/null` and smudge filters by blanking `GIT_CONFIG_GLOBAL` —
 * so nothing here ever paid for them. Both are live now (see {@link gitEnv}), and
 * a repository with a few hundred megabytes of LFS content would have answered
 * the very first `POST /sessions` with a 504.
 *
 * The failure this bound exists for is a wedged hook, and a wedged hook is just
 * as wedged at 120s as at 30s; a slow-but-correct checkout is the common case and
 * was the one being punished.
 */
export const GIT_TIMEOUT_MUTATE_MS = 120_000;
export const GIT_TIMEOUT_READ_MS = 15_000;

export const GIT_MAX_STRUCTURAL_BYTES = 256 * 1024;
export const GIT_MAX_LIST_BYTES = 1024 * 1024;
export const GIT_MAX_STATUS_BYTES = 8 * 1024 * 1024;

/**
 * Environment for every git invocation.
 *
 * **Still an allowlist, and the reason changed rather than went away.** It was
 * written as confinement: git executes repository-controlled programs, the
 * repository belonged to a tenant, and anything in this environment was handed
 * to code that tenant wrote — measured 2026-07-30, a `post-checkout` hook printed
 * `REEMOAT_TOKEN` in full. There is no tenant now and no boundary here to hold:
 * the agent runs as this uid and could read that variable a dozen other ways.
 *
 * What survives is **determinism**, which was always the other half. This daemon
 * can itself be launched from inside a git hook or a `git rebase --exec`, and in
 * that environment `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and
 * `GIT_OBJECT_DIRECTORY` are all set and every one of them silently retargets a
 * command at a repository we did not mean. An allowlist that simply never adds a
 * `GIT_*` name makes that impossible by construction, which is the same argument
 * `runtime/docker.ts` made for the docker CLI: "the failure mode of a denylist is
 * silent and one-directional".
 *
 * What is **no longer** set here is `GIT_CONFIG_NOSYSTEM` and
 * `GIT_CONFIG_GLOBAL=/dev/null`. Blanking the global config was neutralising the
 * user's own `~/.gitconfig` — and the sharpest cost of that was silent:
 * `filter.lfs.smudge` lives there, so `git worktree add` checked out **LFS
 * pointer files instead of content**, and the agent read
 * `version https://git-lfs.github.com/spec/v1` where a binary should have been.
 * No error, nowhere to look.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Widened along with the fence coming down. Each of these is something the
  // user's own git configuration legitimately needs and none of them can
  // retarget a command:
  //   XDG_CONFIG_HOME  git reads $XDG_CONFIG_HOME/git/config
  //   USER, LOGNAME    a credential helper or hook that identifies the caller
  //   SSH_AUTH_SOCK    an ssh remote reached from a hook
  for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  // Nothing may block waiting for input: these run behind an HTTP request, and a
  // checkout hook that asks for a passphrase would otherwise park until timeout.
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_ASKPASS"] = "";
  env["GIT_PAGER"] = "cat";
  // `--no-optional-locks` applied uniformly. The agent runs git in the same
  // worktree concurrently, and this stops our `status` taking `index.lock` just
  // to write back a refreshed stat cache. Correctness is unaffected — without the
  // cache git falls back to comparing content, it simply does not persist the
  // refresh.
  env["GIT_OPTIONAL_LOCKS"] = "0";
  // A few error classifications below match on git's stderr text. A localised
  // message would silently degrade them to "unknown git failure".
  env["LC_ALL"] = "C";
  return env;
}

/*
 * There is deliberately no `GIT_NO_EXEC_CONFIG` any more.
 *
 * It was a list of `-c` overrides — `core.hooksPath=/dev/null`,
 * `core.fsmonitor=false`, `diff.external=`, `credential.helper=`,
 * `protocol.ext.allow=never`, `core.sshCommand=` — and every word of its
 * justification was an argument about a boundary: the repository was
 * tenant-controlled, git is a program launcher, and a `post-checkout` hook that
 * ran as the daemon's uid was a way out of the container. Measured, real, and
 * gone with the container.
 *
 * On a single-user daemon there is no *out*. The hook, the agent and this process
 * are the same person, and an agent that wanted to run that hook could simply run
 * it. So what the overrides bought became zero, while what they cost stayed:
 *
 *   - `core.hooksPath=/dev/null` stopped the user's own `post-checkout` running
 *     on `git worktree add` — the hook that installs dependencies, or fixes file
 *     modes — so a session started in a tree its owner's tooling considered
 *     half-built, with nothing saying why;
 *   - `diff.external=` made `GET /sessions/:id/changes/diff` disagree with what
 *     the same person sees in their own terminal;
 *   - `credential.helper=` and `core.sshCommand=` existed so the daemon could not
 *     push. Keeping them would make the stated reason for deleting the forge
 *     feature — "on your own machine your own git config and keys already work" —
 *     false, since they are exactly the two settings that make it work.
 *
 * Deleted outright rather than put behind a flag, for the mirror image of the
 * argument that kept the container mandatory: a flag that turns hooks off is a
 * flag that will be on somewhere, breaking somebody's own repository silently.
 * One behaviour, written down.
 */

/**
 * `-C <dir>` rather than the child's `cwd` option.
 *
 * If the directory has been deleted, spawning with `cwd` fails ENOENT at
 * `chdir` — byte-identical to "git is not installed". With `-C`, a spawn ENOENT
 * means exactly one thing, and a missing directory arrives as a git message on
 * stderr where it can be reported properly.
 *
 * The single chokepoint for both `runGit` and `readGitCapped`. It used to prepend
 * a list of `-c` overrides here as well; see the note above for why there is
 * nothing left to prepend.
 */
export function gitArgs(dir: string, args: readonly string[]): string[] {
  return ["-C", dir, ...args];
}

/**
 * Where git runs, as an interface.
 *
 * The same seam `SessionRuntime` is for the agent, and reserved in the same
 * voice: there is one implementation, `hostGit`, and it runs git as a child of
 * this daemon. It had a second one — `ContainerGit`, which ran every command
 * through `docker exec` inside the tenant's own container, because a
 * `post-checkout` hook in a repository somebody else owned would otherwise
 * execute as the daemon's uid. There is no somebody else now, so that argument
 * and that implementation went together.
 *
 * Kept as an interface because it is one of the four places a confining runtime
 * would have to answer differently, and because the drivers substitute their own.
 *
 * **Every path crossing this interface is a host path**, and there is only one
 * kind of path now. It used to carry `toHost`/`toAgent`, a pair of translators
 * that existed so a container implementation could map between the daemon's
 * namespace and the agent's while everything above — `worktree.ts`, `changes.ts`,
 * `sqlite.ts`, every HTTP response — went on saying what it said. With one
 * filesystem both were the identity function at every call site, and an identity
 * function on an interface is an invitation to write the translation back.
 */
export interface GitExec {
  run(args: readonly string[], options: RunGitOptions): Promise<GitRun>;
  readCapped(args: readonly string[], options: RunGitOptions): Promise<GitRun>;
}

/**
 * git as a child of this daemon — the behaviour that existed before there was an
 * interface, moved rather than changed.
 *
 * Still used, and not only as a fallback: `harness.ts` and every offline driver
 * run in one process with no Docker, and `LocalRuntime` hands them this.
 */
export const hostGit: GitExec = {
  run: runGit,
  readCapped: readGitCapped,
  // Same filesystem on both sides, so there is nothing to translate.
};

export function runGit(args: readonly string[], options: RunGitOptions): Promise<GitRun> {
  const argv = gitArgs(options.dir, args);
  const ok = options.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      argv,
      {
        env: gitEnv(),
        timeout: options.timeoutMs,
        // SIGTERM alone is not enough; this repo already learned that from the
        // agent kill path.
        killSignal: "SIGKILL",
        maxBuffer: options.maxBytes,
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const errText = stderr.toString("utf8");
        if (err && err.code === "ENOENT") {
          reject(new GitError("git_missing", argv, null, errText, "git is not installed or not on PATH"));
          return;
        }
        if (err && err.killed === true) {
          reject(
            new GitError("git_timeout", argv, null, errText, `git ${args[0] ?? ""} exceeded ${options.timeoutMs}ms`),
          );
          return;
        }
        // execFile hands back the *truncated* stdout with a string `code` and
        // `killed` unset, so without this the checks below fall through to
        // `exitCode = 0` and it resolves successfully with silently short output.
        // A short `worktree list` parses cleanly into a shorter list, which would
        // quietly report live worktrees as unregistered.
        if (err && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(
            new GitError(
              "git_output_too_large",
              argv,
              null,
              errText,
              `git ${args[0] ?? ""} produced more than ${options.maxBytes} bytes`,
            ),
          );
          return;
        }
        const exitCode = typeof err?.code === "number" ? err.code : 0;
        if (err && !ok.includes(exitCode)) {
          reject(new GitError("git_failed", argv, exitCode, errText, describeFailure(args, exitCode, errText)));
          return;
        }
        resolve({ stdout, stderr: errText, exitCode, truncated: false });
      },
    );
  });
}

/**
 * Like `runGit`, but stops reading at `maxBytes` and says so.
 *
 * Uses `spawn` rather than `execFile` — still an argv array, still no shell —
 * because honest truncation is impossible with `execFile`: exceeding `maxBuffer`
 * throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and discards everything collected
 * so far. Only `status` and `diff` need this, and for those "here is the first
 * 8 MiB, and there was more" is a far better answer than an error.
 */
export function readGitCapped(args: readonly string[], options: RunGitOptions): Promise<GitRun> {
  const argv = gitArgs(options.dir, args);
  const ok = options.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn("git", argv, { env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let errText = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new GitError("git_timeout", argv, null, errText, `git ${args[0] ?? ""} exceeded ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref();

    // We SIGKILL this child ourselves the moment the byte cap is hit, which can
    // leave it mid-write and surface as an error on our read side. An unhandled
    // 'error' on a stream is a thrown exception, and this runs inside an HTTP
    // handler in a daemon that owns live agent subprocesses — the same reason
    // `acp/client.ts` swallows EPIPE on the agent's stdin.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxBytes - total;
      // Strictly greater: a final chunk that exactly fills the budget lost
      // nothing, and reporting it as truncated would make a complete listing
      // claim `total: null` and a complete diff claim it was cut short.
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, Math.max(room, 0)));
        total = options.maxBytes;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errText.length < 8192) errText += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new GitError("git_missing", argv, null, errText, "git is not installed or not on PATH"));
        return;
      }
      reject(new GitError("git_failed", argv, null, errText, error.message));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      // We killed it ourselves once the cap was hit, so the non-zero exit is ours
      // rather than git's and must not be reported as a failure.
      if (truncated) {
        resolve({ stdout, stderr: errText, exitCode: 0, truncated: true });
        return;
      }
      if (signal !== null) {
        reject(new GitError("git_failed", argv, null, errText, `git ${args[0] ?? ""} died on ${signal}`));
        return;
      }
      const exitCode = code ?? 0;
      if (!ok.includes(exitCode)) {
        reject(new GitError("git_failed", argv, exitCode, errText, describeFailure(args, exitCode, errText)));
        return;
      }
      resolve({ stdout, stderr: errText, exitCode, truncated: false });
    });
  });
}

function describeFailure(args: readonly string[], exitCode: number, stderr: string): string {
  const first = stderr.split("\n").find((line) => line.trim().length > 0) ?? "";
  return `git ${args.slice(0, 2).join(" ")} exited ${exitCode}${first ? `: ${first.trim()}` : ""}`;
}

/**
 * Splits a NUL-terminated stream at the byte level.
 *
 * Never decodes before splitting: a path is bytes, and decoding first would turn
 * an invalid UTF-8 sequence into a replacement character before we have had the
 * chance to notice the path cannot round-trip.
 *
 * A trailing NUL produces no final empty token, which is what git emits.
 */
export function splitNul(buffer: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0) continue;
    out.push(buffer.subarray(start, i));
    start = i + 1;
  }
  if (start < buffer.length) out.push(buffer.subarray(start));
  return out;
}

/**
 * Decodes one path token, reporting whether it survives the round trip.
 *
 * A path that is not valid UTF-8 cannot come back through a JSON query parameter
 * as the same bytes, so the diff route has to refuse it by name rather than
 * quietly diff a different file.
 */
export function decodePath(token: Buffer): { path: string; addressable: boolean } {
  const path = token.toString("utf8");
  return { path, addressable: Buffer.compare(Buffer.from(path, "utf8"), token) === 0 };
}

/** Reads stdout as text with trailing newlines removed. */
export function textOf(run: GitRun): string {
  return run.stdout.toString("utf8").replace(/\n+$/, "");
}

/** Reads stdout as a list of non-empty lines. */
export function linesOf(run: GitRun): string[] {
  return textOf(run)
    .split("\n")
    .filter((line) => line.length > 0);
}
