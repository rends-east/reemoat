import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { atOrUnderResolved } from "./paths.js";

/**
 * The kernel's mount table, and which of those filesystems answer over a network.
 *
 * **This exists to answer one question without touching the filesystem: is this
 * path served by something that can stop responding?** `browse.ts` needs that
 * before it probes a directory, because the probe is the thing that costs a
 * libuv threadpool slot permanently when the answer is yes and the server is
 * asleep. Asking the filesystem itself would be circular — `statfs(2)` reports
 * the type *and* queries the server for free space, which is exactly the call
 * that hangs. So the source here is kernel state that is already in memory:
 * `/proc/self/mounts` on Linux, `getmntinfo(3)` via `/sbin/mount` on macOS.
 * Neither performs I/O against the server.
 *
 * **Everything here fails open.** An unreadable mount table, an unknown platform
 * or a `mount` that will not run all produce an empty list, and an empty list
 * means `browse.ts` behaves exactly as it did before this file existed. This is
 * an optimization that bounds a cost, never a boundary — nothing is permitted or
 * refused on the strength of what is in here, so being wrong about a filesystem
 * degrades a listing rather than opening or closing a door.
 *
 * The parsers are pure and exported for that reason: the two formats differ, a
 * machine is only ever one of them, and getting the other one wrong is silent.
 */

export interface MountEntry {
  /** Where it is mounted. Absolute, as the kernel reports it. */
  point: string;
  /** The filesystem type, as the kernel names it: `apfs`, `nfs`, `fuse.sshfs`. */
  type: string;
  /** Whether it is served over a network, and can therefore stop answering. */
  remote: boolean;
}

/**
 * Filesystem types whose server is somewhere else.
 *
 * A list rather than a heuristic, because the two mistakes are not symmetric:
 * calling a local filesystem remote costs a little parallelism in a listing,
 * while calling a remote one local costs the thing this whole file exists to
 * prevent. When in doubt the entry simply is not here and the behaviour is
 * today's.
 */
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

/**
 * FUSE backends that are network clients.
 *
 * FUSE is a transport, not a filesystem, so `fuse.*` cannot be treated as remote
 * wholesale — `fuse.ntfs` and `fuse.gocryptfs` are local disks. Only the
 * backends that actually speak to a server are listed.
 */
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

/** Whether a filesystem of this type is served over a network. */
export function isRemoteType(type: string): boolean {
  const lower = type.trim().toLowerCase();
  if (REMOTE_TYPES.has(lower)) return true;
  const fuse = /^fuse(?:blk)?\.(.+)$/.exec(lower);
  return fuse?.[1] !== undefined && REMOTE_FUSE.has(fuse[1]);
}

/**
 * `/proc/self/mounts`, which is six space-separated fields per line.
 *
 * Paths are octal-escaped by the kernel — a mount point containing a space
 * arrives as `\040` — so they are unescaped here rather than at the call site,
 * where forgetting would silently produce a point that matches nothing.
 */
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

/**
 * `mount(8)` on BSD and macOS: `<device> on <point> (<type>, <options…>)`.
 *
 * The point is taken greedily up to the *final* parenthesised group and the type
 * is the first option in it, because a device or a mount point may itself
 * contain ` on ` or a bracket, while the trailing group is anchored to the end
 * of the line by the format.
 */
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

/** `\040` and friends, as the kernel writes them into `/proc`. */
function unescapeOctal(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
}

/**
 * The mount a path is served by: the longest mount point at or above it.
 *
 * Longest wins because mounts nest — `/` is a mount point too, so a plain "first
 * match" would report every path in the system as being on the root filesystem
 * and a nested mount would never be found. Compared segment-wise through the one
 * containment primitive, so `/mnt/data` does not claim `/mnt/database`.
 *
 * The path must already be resolved. Every caller in `browse.ts` has just been
 * through `realpath`, and resolving here would reintroduce the synchronous
 * filesystem call this file exists to avoid.
 */
export function mountFor(resolvedPath: string, mounts: readonly MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null;
  for (const mount of mounts) {
    if (!atOrUnderResolved(resolvedPath, mount.point)) continue;
    if (best === null || mount.point.length > best.point.length) best = mount;
  }
  return best;
}

/**
 * How long a reading of the mount table is reused.
 *
 * Mounts appear and disappear while a daemon runs — that is the whole premise,
 * since a VM waking up is what un-stalls one. Short enough that a new NAS is
 * noticed within a listing or two, long enough that a phone polling the picker
 * does not spawn `mount` every time.
 */
const MOUNTS_TTL_MS = 30_000;

let cached: { at: number; entries: MountEntry[] } | null = null;
let reading: Promise<MountEntry[]> | null = null;
/** Bumped by {@link forgetMounts}, so an in-flight read cannot write back over it. */
let generation = 0;

/**
 * The mount table, cached.
 *
 * Asynchronous and never on the critical path for correctness: a caller that
 * cannot wait for it, or that gets an empty list, simply loses the bounding this
 * provides. On Linux the read is of `procfs`, which is kernel memory and cannot
 * block; on macOS it is a short-lived child process, which uses libuv's process
 * handling rather than the threadpool, so it cannot consume the resource it is
 * protecting.
 *
 * `now` is injectable so the drivers can age the cache without sleeping.
 */
export async function readMounts(now: number = Date.now()): Promise<MountEntry[]> {
  if (cached !== null && now - cached.at < MOUNTS_TTL_MS) return cached.entries;
  // One reading at a time: a listing calls this once, but several listings can
  // be in flight, and spawning `mount` per request is what the cache is for.
  //
  // **The latch is cleared in `finally`, and never left holding a failure.** It
  // used to be reset inside the success arm of `.then`, which made this memo a
  // single point of total failure for every filesystem route in the daemon: one
  // `loadMounts()` that rejected, or simply never settled, and `reading` held
  // that promise for the life of the process — so `probeContext` never resolved
  // and `GET /fs/list`, `POST /fs/mkdir` and `POST /sessions` all hung, while
  // `/health`, which touches no files, went on reporting the daemon up. That is
  // the exact failure this module was added to bound, one layer above it, in the
  // file whose header promises everything here fails open. `loadMounts` cannot
  // reject today; it was one `await` outside its own `try` away from it.
  //
  // `catch` as well as `finally`, so the promise every waiter is holding still
  // resolves — to the documented empty list, which means "behave as this daemon
  // did before this file existed" rather than "fail the request".
  // Captured before the read starts, and compared after it: `forgetMounts` bumps
  // it, so a read that was already in flight when somebody dropped the cache
  // still resolves for its own waiters but does not write its now-superseded
  // answer back over a fresher one.
  const epoch = generation;
  reading ??= loadMounts()
    .catch(() => [] as MountEntry[])
    .then((entries) => {
      // Stamped on completion, not on the first caller's arrival: a read that
      // took a second was otherwise already a second old when it was cached.
      if (epoch === generation) cached = { at: Date.now(), entries };
      return entries;
    })
    .finally(() => {
      if (epoch === generation) reading = null;
    });
  return reading;
}

/**
 * Drop the cache. For the drivers, and for a caller that knows mounts moved.
 *
 * Drops the in-flight read as well as the settled one. Clearing only `cached`
 * left a read that was already running to write its pre-forget answer back
 * afterwards — so the caller who asked to forget got the stale table anyway, and
 * it was then cached for a fresh TTL. For a driver that is a flaky assertion;
 * for the real caller it is a function that silently does nothing.
 */
export function forgetMounts(): void {
  generation++;
  cached = null;
  reading = null;
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
    // Unreadable, absent, or a `mount` that would not run. Failing open means
    // behaving exactly as this daemon did before this file existed.
  }
  return [];
}

/**
 * `/sbin/mount` with no arguments, which prints the table and exits.
 *
 * An absolute path rather than a bare name, for the same reason the unit files
 * put the system directories first in `PATH`: this is a child process of the
 * daemon that runs your agents, and a `mount` picked up from a writable
 * directory earlier on `PATH` would be somebody else's program.
 *
 * Bounded, because `getmntinfo` is kernel state but the binary around it is
 * still a process that could wedge for its own reasons.
 */
function runMount(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/sbin/mount", [], { timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
