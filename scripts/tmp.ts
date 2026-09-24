import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** Removed at exit. Not realpath'd: on macOS /var is a symlink. */
export function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function sweepTmp(): void {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: this runs at exit after the verdict, and a throw would bury it.
    }
  }
}

process.on("exit", sweepTmp);
