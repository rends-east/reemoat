/**
 * Every temporary directory a driver makes, and the one place that removes them.
 *
 * The drivers build sandboxes with `mkdtempSync` — a fake HOME, a git repository
 * to worktree, an upload root, a directory outside the browse roots — and until
 * this module existed almost none of them removed one. Measured on the machine
 * this was written on: 1297 leftover directories under `$TMPDIR`, 15 GB, all of
 * it written by `pnpm daemoncheck`, `pnpm relaycheck` and `pnpm deploycheck`
 * over the runs of a few weeks. Nothing failed, which is why nobody noticed:
 * every run made a fresh `mkdtemp` name, so a leaked directory never collided
 * with the next one and the leak had no symptom until the disk did.
 *
 * The removal is on `process.on("exit")` rather than at the end of each case
 * because a driver that fails calls `process.exit(1)` from wherever it noticed,
 * and a `rmSync` at the bottom of the file would then be the one line the failure
 * skipped — the runs that leak the most are exactly the ones that failed. `exit`
 * runs for both, and it is synchronous-only, which `rmSync` already is.
 *
 * What this does **not** cover is a kill: a driver killed with SIGKILL, or one
 * whose process is torn down without unwinding, still leaves its directories
 * behind. That is accepted rather than solved — the fix would be a signal handler
 * per driver, and the leak that mattered was the ordinary passing run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every directory `tmp` has handed out and `sweepTmp` has not yet removed. */
const made: string[] = [];

/**
 * `mkdtempSync(join(tmpdir(), prefix))`, plus the bookkeeping that gets it
 * removed. The returned path is the raw one; a caller that needs it resolved
 * still wraps it in `realpathSync` itself, since on macOS `/var` is a symlink to
 * `/private/var` and some assertions compare paths as strings.
 */
export function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * Remove everything `tmp` made, and forget it. Idempotent by draining the list,
 * so the handful of call sites that also remove a directory mid-run — because
 * the case *is* about what happens after it is gone — cost nothing here.
 */
export function sweepTmp(): void {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort, and deliberately silent: this runs during exit, after the
      // driver has already printed its verdict and set the exit code. A throw
      // here would replace a clean PASS/FAIL summary with a stack trace about a
      // directory nothing is going to read again.
    }
  }
}

process.on("exit", sweepTmp);
