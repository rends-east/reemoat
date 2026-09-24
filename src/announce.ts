import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where this daemon listens, for a client on this computer: a file in a 0700 root, so no token is ever spent on a stranger's port. */
export const ANNOUNCE_VERSION = 1;

/** Mirrored as Stored in packages/native/src-tauri/src/local.rs; nativecheck asserts the key sets match. */
export interface LocalAnnounce {
  v: number;
  machineId: string;
  host: string;
  port: number;
  instanceId: string;
  authMode: "signed" | "both";
  controlPlane: string | null;
}

export function announcedControlPlane(stored: string): string | null {
  const trimmed = stored.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function announcePath(root: string): string {
  return join(root, "daemon.json");
}

/** Atomic, best-effort write under the state root, never beside REEMOAT_DB: the app knows only the root (Q7.149, Q7.148). */
export function writeAnnounce(announce: LocalAnnounce, root: string): void {
  const path = announcePath(root);
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // No POSIX modes here; the contents are not secret.
  }
  writeFileSync(tmp, `${JSON.stringify(announce, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // As above.
  }
  renameSync(tmp, path);
}

/** Removes only a file carrying this daemon's instanceId, so a daemon that lost the shared-root race cannot delete the winner's. */
export function removeAnnounce(instanceId: string, root: string): void {
  const path = announcePath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let written: unknown;
  try {
    written = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof written !== "object" || written === null) return;
  if ((written as { instanceId?: unknown }).instanceId !== instanceId) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
