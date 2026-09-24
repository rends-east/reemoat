import { lstat, open, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import { mountFor, readMounts, type MountEntry } from "./mounts.js";

// A filesystem call on a path this process did not create can block in the kernel for ever: bound the wait, remember the stall, refuse the next caller cheaply.

export interface ProbeOptions {
  probeTimeoutMs?: number;
  mounts?: readonly MountEntry[];
}

export interface ProbeContext {
  timeoutMs: number;
  mounts: readonly MountEntry[];
}

export async function probeContext(options: ProbeOptions): Promise<ProbeContext> {
  return {
    timeoutMs: options.probeTimeoutMs ?? DESCRIBE_TIMEOUT_MS,
    mounts: options.mounts ?? (await readMounts()),
  };
}

export const DESCRIBE_TIMEOUT_MS = 2_000;

const MAX_STALLED_PATHS = 512;

// The value is the still-pending probe; its settling clears the entry, so there is no TTL (a timer would re-arm the leak).
const stalled = new Map<string, Promise<unknown>>();

/** A network path is keyed by its mount point; a local path by itself, or one bad directory would mark all of `/` stalled. */
export interface StallTarget {
  key: string;
  remote: boolean;
}

export function stallKeyFor(resolvedPath: string, mounts: readonly MountEntry[]): StallTarget {
  const mount = mountFor(resolvedPath, mounts);
  if (mount !== null && mount.remote) return { key: mount.point, remote: true };
  return { key: resolvedPath, remote: false };
}

/** A hit re-inserts, so the map is an LRU for markStalled's eviction. */
export function isStalled(path: string): boolean {
  const probe = stalled.get(path);
  if (probe === undefined) return false;
  stalled.delete(path);
  stalled.set(path, probe);
  return true;
}

export function forgetStalled(): void {
  stalled.clear();
}

const MAX_REMOTE_PROBES = 2;

let remoteInFlight = 0;
const remoteWaiting: (() => void)[] = [];

/** Released when the bounded wait ends, not the syscall: holding it longer deadlocks on the very mount it guards. */
async function withRemotePermit<T>(run: () => Promise<T>): Promise<T> {
  // `while`, not `if`: a synchronous arrival between release and wake would otherwise exceed the ceiling.
  while (remoteInFlight >= MAX_REMOTE_PROBES) {
    await new Promise<void>((resolve) => remoteWaiting.push(resolve));
  }
  remoteInFlight++;
  try {
    return await run();
  } finally {
    remoteInFlight--;
    remoteWaiting.shift()?.();
  }
}

function gated<T>(target: StallTarget, run: () => Promise<T>): Promise<T> {
  return target.remote ? withRemotePermit(run) : run();
}

/** `start` is a thunk so the permit is taken before the call is dispatched; the memory is re-read once the permit is held. */
export async function attempt<T>(
  target: StallTarget,
  ctx: ProbeContext,
  start: () => Promise<T>,
): Promise<{ answered: true; value: T } | { answered: false; known: boolean }> {
  if (isStalled(target.key)) return { answered: false, known: true };
  return gated(target, async () => {
    if (isStalled(target.key)) return { answered: false, known: true };
    const probe = start();
    const answer = await bounded(probe, ctx.timeoutMs);
    if (answer.answered) return answer;
    markStalled(target.key, probe);
    return { answered: false, known: false };
  });
}

function markStalled(path: string, probe: Promise<unknown>): void {
  if (stalled.size >= MAX_STALLED_PATHS) {
    const oldest = stalled.keys().next();
    if (!oldest.done) stalled.delete(oldest.value);
  }
  stalled.set(path, probe);
  void probe
    .catch(() => undefined)
    .finally(() => {
      // Only if still ours: an eviction may have handed the key to a later probe of the same path.
      if (stalled.get(path) === probe) stalled.delete(path);
    });
}

async function bounded<T>(
  probe: Promise<T>,
  timeoutMs: number,
): Promise<{ answered: true; value: T } | { answered: false }> {
  // A settled promise rather than a zero timer: a timer clamps to 1ms and loses to a local realpath.
  if (timeoutMs <= 0) {
    return Promise.race([probe.then((value) => ({ answered: true as const, value })), Promise.resolve({ answered: false as const })]);
  }

  let timer: NodeJS.Timeout | undefined;
  const bail = new Promise<{ answered: false }>((resolve) => {
    timer = setTimeout(() => resolve({ answered: false }), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([probe.then((value) => ({ answered: true as const, value })), bail]);
  } finally {
    clearTimeout(timer);
  }
}

/** `null` means could not tell (a stalled mount), never missing. */
export async function probeExists(path: string, options: ProbeOptions = {}): Promise<boolean | null> {
  const ctx = await probeContext(options);
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, () =>
    stat(path).then(
      () => true,
      () => false,
    ),
  );
  return answer.answered ? answer.value : null;
}

export type PathResolution = { kind: "path"; value: string } | { kind: "missing" };

export async function probeRealpath(path: string, options: ProbeOptions = {}): Promise<PathResolution | null> {
  const ctx = await probeContext(options);
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, () =>
    realpath(path).then(
      (value): PathResolution => ({ kind: "path", value }),
      (): PathResolution => ({ kind: "missing" }),
    ),
  );
  return answer.answered ? answer.value : null;
}

export type BuildProbe = { kind: "file"; key: string } | { kind: "missing" };

/** Catches a CLI replaced under a running daemon: resolved path plus dev/inode/size/ctime (installers may keep mtime). */
export async function probeBuild(path: string, options: ProbeOptions = {}): Promise<BuildProbe | null> {
  const ctx = await probeContext(options);
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, async (): Promise<BuildProbe> => {
    try {
      const real = await realpath(path);
      const info = await stat(real);
      return { kind: "file", key: `${real}\0${info.dev}:${info.ino}:${info.size}:${info.ctimeMs}` };
    } catch {
      return { kind: "missing" };
    }
  });
  return answer.answered ? answer.value : null;
}

export type FileProbe = { kind: "file"; size: number } | { kind: "other" };

/** lstat, never stat: a symlink is refused by shape, so `other` covers links, directories and devices alike. */
export async function probeFile(path: string, options: ProbeOptions = {}): Promise<FileProbe | null> {
  const ctx = await probeContext(options);
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, () =>
    lstat(path).then(
      (info): FileProbe => (info.isFile() ? { kind: "file", size: info.size } : { kind: "other" }),
      (): FileProbe => ({ kind: "other" }),
    ),
  );
  return answer.answered ? answer.value : null;
}

export async function probeText(path: string, maxBytes: number, options: ProbeOptions = {}): Promise<string | null> {
  const stat = await probeFile(path, options);
  if (stat === null || stat.kind !== "file" || stat.size > maxBytes) return null;
  const ctx = await probeContext(options);
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, () =>
    readFile(path, "utf8").then(
      (text): string | null => text,
      (): string | null => null,
    ),
  );
  return answer.answered ? answer.value : null;
}

/** Callers read `null` as not binary: diffFile withholds content itself. */
export async function probeBinary(path: string, options: ProbeOptions = {}): Promise<boolean | null> {
  const ctx = await probeContext(options);
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, async () => {
    let handle: FileHandle | undefined;
    try {
      const info = await lstat(path);
      if (!info.isFile()) return false;
      handle = await open(path, "r");
      const buffer = Buffer.allocUnsafe(Math.min(8000, info.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } catch {
      return false;
    } finally {
      // Not awaited: a hanging close must not hold the caller.
      void handle?.close().catch(() => {});
    }
  });
  return answer.answered ? answer.value : null;
}
