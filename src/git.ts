import { execFile } from "node:child_process";
import { spawn } from "node:child_process";

// The only place that spawns git: argv arrays, a scrubbed env, a timeout on every call, failures thrown as GitError, nothing printed.

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
  dir: string;
  timeoutMs: number;
  maxBytes: number;
  /** Exit codes that are an answer, not a failure: diff --no-index exits 1 when the files differ. */
  okExitCodes?: readonly number[];
}

export interface GitRun {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export const GIT_TIMEOUT_STRUCTURAL_MS = 5_000;
export const GIT_TIMEOUT_LIST_MS = 10_000;
// A checkout runs the user's hooks and LFS smudge; this bounds a wedged hook, not a slow checkout.
export const GIT_TIMEOUT_MUTATE_MS = 120_000;
export const GIT_TIMEOUT_READ_MS = 15_000;

export const GIT_MAX_STRUCTURAL_BYTES = 256 * 1024;
export const GIT_MAX_LIST_BYTES = 1024 * 1024;
export const GIT_MAX_STATUS_BYTES = 8 * 1024 * 1024;

/** An allowlist, so no inherited GIT_* name retargets a command; the user's global config stays live for LFS. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  // Nothing may block on input: these run behind an HTTP request.
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_ASKPASS"] = "";
  env["GIT_PAGER"] = "cat";
  // The agent runs git in the same worktree; this stops our status taking index.lock.
  env["GIT_OPTIONAL_LOCKS"] = "0";
  // Callers classify failures by matching git's English stderr.
  env["LC_ALL"] = "C";
  return env;
}

/** Passes -C rather than cwd, so a spawn ENOENT can only mean git is missing. */
export function gitArgs(dir: string, args: readonly string[]): string[] {
  return ["-C", dir, ...args];
}

/** The seam a confining runtime would implement; every path is a host path, with no toHost translation. */
export interface GitExec {
  run(args: readonly string[], options: RunGitOptions): Promise<GitRun>;
  readCapped(args: readonly string[], options: RunGitOptions): Promise<GitRun>;
}

export const hostGit: GitExec = {
  run: runGit,
  readCapped: readGitCapped,
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
        // Without this, execFile resolves the truncated stdout as a success with silently short output.
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

/** Like runGit, but reports truncated at maxBytes instead of throwing. */
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

    // We SIGKILL mid-write at the cap; an unhandled stream error would throw inside an HTTP handler.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxBytes - total;
      // Strictly greater: a chunk that exactly fills the budget lost nothing.
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
      // The non-zero exit is our own kill at the cap, not a git failure.
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

/** Splits at the byte level before decoding, so a non-UTF-8 path can be detected; no trailing empty token. */
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

export function decodePath(token: Buffer): { path: string; addressable: boolean } {
  const path = token.toString("utf8");
  return { path, addressable: Buffer.compare(Buffer.from(path, "utf8"), token) === 0 };
}

export function textOf(run: GitRun): string {
  return run.stdout.toString("utf8").replace(/\n+$/, "");
}

export function linesOf(run: GitRun): string[] {
  return textOf(run)
    .split("\n")
    .filter((line) => line.length > 0);
}
