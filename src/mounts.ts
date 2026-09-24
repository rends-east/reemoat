import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { atOrUnderResolved } from "./paths.js";

// Which mounts are network-served, read from in-memory kernel state rather than the filesystem; fails open to an empty list.

export interface MountEntry {
  point: string;
  type: string;
  remote: boolean;
}

const REMOTE_TYPES = new Set([
  "9p",
  "afpfs",
  "afs",
  "beegfs",
  "ceph",
  "cifs",
  "davfs",
  "davfs2",
  "ftp",
  "fuseblk.cifs",
  "glusterfs",
  "gpfs",
  "lustre",
  "ncpfs",
  "nfs",
  "nfs3",
  "nfs4",
  "nfsd",
  "smb",
  "smb2",
  "smb3",
  "smbfs",
  "sshfs",
  "webdav",
]);

// FUSE is a transport: only backends that talk to a server count as remote.
const REMOTE_FUSE = new Set([
  "cifs",
  "davfs",
  "gcsfuse",
  "gdrive",
  "glusterfs",
  "rclone",
  "s3fs",
  "sshfs",
  "webdav",
]);

export function isRemoteType(type: string): boolean {
  const lower = type.trim().toLowerCase();
  if (REMOTE_TYPES.has(lower)) return true;
  const fuse = /^fuse(?:blk)?\.(.+)$/.exec(lower);
  return fuse?.[1] !== undefined && REMOTE_FUSE.has(fuse[1]);
}

export function parseLinuxMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const point = fields[1];
    const type = fields[2];
    if (point === undefined || type === undefined || !point.startsWith("/")) continue;
    out.push({ point: unescapeOctal(point), type, remote: isRemoteType(type) });
  }
  return out;
}

export function parseBsdMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const matched = /^.*? on (.*) \(([^)]*)\)\s*$/.exec(line.trimEnd());
    const point = matched?.[1];
    const type = matched?.[2]?.split(",")[0]?.trim();
    if (point === undefined || type === undefined || type.length === 0) continue;
    if (!point.startsWith("/")) continue;
    out.push({ point, type, remote: isRemoteType(type) });
  }
  return out;
}

function unescapeOctal(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
}

/** The longest mount point at or above an already-resolved path. */
export function mountFor(resolvedPath: string, mounts: readonly MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null;
  for (const mount of mounts) {
    if (!atOrUnderResolved(resolvedPath, mount.point)) continue;
    if (best === null || mount.point.length > best.point.length) best = mount;
  }
  return best;
}

const MOUNTS_TTL_MS = 30_000;

let cached: { at: number; entries: MountEntry[] } | null = null;
let reading: Promise<MountEntry[]> | null = null;

export async function readMounts(now: number = Date.now()): Promise<MountEntry[]> {
  if (cached !== null && now - cached.at < MOUNTS_TTL_MS) return cached.entries;
  // One read at a time; the latch clears in finally and a failure resolves to the empty list, or every filesystem route hangs.
  reading ??= loadMounts()
    .catch(() => [] as MountEntry[])
    .then((entries) => {
      cached = { at: Date.now(), entries };
      return entries;
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

async function loadMounts(): Promise<MountEntry[]> {
  try {
    if (process.platform === "linux") {
      return parseLinuxMounts(await readFile("/proc/self/mounts", "utf8"));
    }
    if (process.platform === "darwin" || process.platform.includes("bsd")) {
      return parseBsdMounts(await runMount());
    }
  } catch {
    // Unreadable, absent, or mount would not run: fail open.
  }
  return [];
}

/** Absolute path, so no mount earlier on PATH is ever run; bounded because the process could still wedge. */
function runMount(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/sbin/mount", [], { timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
