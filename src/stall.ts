import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import { mountFor, readMounts, type MountEntry } from "./mounts.js";

/**
 * Asking the filesystem a question that might never be answered.
 *
 * **This is one mechanism with one piece of state, and it is shared rather than
 * copied for the same reason `paths.ts` is.** It began inside `browse.ts`,
 * because the directory picker is where a caller-named path first reached a
 * filesystem call — but the property it protects is not about browsing. It is
 * about the whole daemon:
 *
 *   a filesystem call on a path this process did not create can block inside the
 *   kernel for ever, and there is no way to cancel it.
 *
 * Synchronously that stops the event loop, which is every session, every socket
 * and `/health` with it. Asynchronously it costs a libuv threadpool slot for the
 * life of the process. Neither is recoverable, so the only defence is to bound
 * the wait, remember the answer, and refuse the next caller cheaply — which is
 * what `attempt` does and what everything here exists to support.
 *
 * The consumers are `browse.ts`, which listed the paths, and `worktree.ts` and
 * `server.ts`, which ask whether a session's working directory is still there.
 * That last one is the reason this module exists at all: for a `plain` session
 * `workspace.root` **is** the `cwd` the caller chose, so `existsSync` on it was
 * the same event-loop death the picker had already been rewritten to avoid,
 * sitting behind `GET /sessions/:id/changes`.
 *
 * Nothing here is a boundary. Being wrong about a filesystem degrades an answer;
 * it never permits or refuses anything.
 */

/** The subset of {@link BrowseOptions} the paths outside a listing need. */
export interface ProbeOptions {
  probeTimeoutMs?: number;
  /**
   * The mount table to classify against, overriding the cached reading.
   *
   * The same kind of seam as `probeTimeoutMs` and for the same reason: a stalled
   * network mount is the one thing a driver cannot synthesize, and without this
   * every probe in a driver takes the `remote: false` arm — so the mount-keyed
   * memory, the permit gate, and "one stalled server answers for every directory
   * beneath it" were all unreachable from any assertion. Nothing in
   * `scripts/daemon.ts` sets it.
   */
  mounts?: readonly MountEntry[];
}

/**
 * What every filesystem probe in this module needs to know.
 *
 * One object rather than two positional arguments, so that adding the mount
 * table did not leave call sites that pass a deadline and silently forget the
 * bounding it pays for.
 */
export interface ProbeContext {
  timeoutMs: number;
  mounts: readonly MountEntry[];
}

/** The context for one request, reading the (cached) mount table. */
export async function probeContext(options: ProbeOptions): Promise<ProbeContext> {
  return {
    timeoutMs: options.probeTimeoutMs ?? DESCRIBE_TIMEOUT_MS,
    mounts: options.mounts ?? (await readMounts()),
  };
}

/**
 * How long one child directory may take to describe itself.
 *
 * **This exists because a directory can block for ever, and it is not a corner
 * case.** Measured 2026-08-02 on the machine this was written on: `~/OrbStack` is
 * a hard NFS mount, and when its server pauses — the VM sleeping, restarting, or
 * busy — `open()` on it never returns and cannot be interrupted. A `readdirSync`
 * there took the daemon's only thread with it: `/health` accepted the connection
 * and answered nothing, at 0% CPU, until it was killed.
 *
 * Two seconds is far above a local directory and far below a person's patience.
 */
export const DESCRIBE_TIMEOUT_MS = 2_000;

/**
 * How many stalled directories we are willing to remember at once.
 *
 * The set is keyed by a path the *caller* named, so it needs a ceiling like
 * everything else here. Forgetting an entry is safe in the only direction that
 * matters — it is re-probed, which is exactly the behaviour that existed before
 * this map did — but *which* entry is forgotten is not neutral, and it used to
 * be the oldest. The oldest is the mount that has been down longest, i.e. the one
 * still worth remembering; a burst of newly-stalling paths would push it out and
 * the next listing would spend threadpool slots on it again. Read access moves an
 * entry to the back (see {@link isStalled}), so eviction takes the
 * least-recently-*asked-about* one instead.
 */
const MAX_STALLED_PATHS = 512;

/**
 * Directories that did not answer, and are not to be asked again until they do.
 *
 * **This set is the fix for a real, measured daemon death, and the timeout above
 * is not.** `Promise.race` abandons the loser; it cannot cancel it. A `readdir`
 * on a hard NFS mount whose server has paused is blocked inside the kernel, so
 * the timeout returns a degraded row to the caller while the syscall keeps its
 * libuv threadpool slot **for the life of the process**. There are four slots by
 * default and `describe` spends two per directory, so:
 *
 *   - the listing looked fine, every time;
 *   - two listings of a home directory containing one such mount exhausted the
 *     entire pool;
 *   - from that moment every `await` on `node:fs/promises` anywhere in the
 *     daemon queued for ever — including `resolveCwd`'s `realpath`, which is the
 *     first thing `POST /fs/mkdir` and `POST /sessions` do;
 *   - `/health` needs no filesystem, so the daemon went on reporting itself up
 *     while the browser timed out at 15s with `TimeoutError: signal timed out`.
 *
 * Measured 2026-08-02: `~/OrbStack` is such a mount on the machine this was
 * written on, `REEMOAT_ROOTS` is unset so the picker starts at `homedir()`, and
 * creating a folder from the web UI timed out while browsing appeared to work.
 *
 * So the cost of a stalled directory is paid **once** rather than per listing.
 * The value is the still-pending probe: when the mount comes back the abandoned
 * call finally settles, and settling is what removes the entry. That is why
 * there is no TTL here — a timer would re-arm the leak on a mount that is still
 * down, and the probe itself already knows the answer we would be re-asking for.
 */
const stalled = new Map<string, Promise<unknown>>();

/**
 * What a stall is remembered *as*, which is the whole reason this daemon reads
 * the kernel's mount table.
 *
 * For a network filesystem the answer is the **mount point**, because not
 * answering is a property of the server rather than of one directory on it. Ask
 * `~/OrbStack` and you have learned about everything beneath it: a subsequent
 * listing of forty directories under that mount costs nothing at all, where
 * per-path memory would have spent two threadpool slots on each of them before
 * learning the same fact forty times.
 *
 * For anything local the answer is the path itself, and that distinction is
 * load-bearing rather than tidy. `/` is a mount point too, so keying local paths
 * by their mount would let one unreadable directory mark the entire filesystem
 * as not answering — the picker would go dark, and the cause would be a single
 * bad `readdir`. A local path that hangs is a fact about that path.
 *
 * The mount table is advisory throughout: with no reading of it (an unknown
 * platform, an unreadable table) every key is the path, which is exactly the
 * behaviour that existed before.
 */
export interface StallTarget {
  /** What a stall is remembered as. */
  key: string;
  /** Whether that key names a network filesystem, and so needs a permit. */
  remote: boolean;
}

export function stallKeyFor(resolvedPath: string, mounts: readonly MountEntry[]): StallTarget {
  const mount = mountFor(resolvedPath, mounts);
  if (mount !== null && mount.remote) return { key: mount.point, remote: true };
  return { key: resolvedPath, remote: false };
}

/**
 * Whether `path` is currently known not to answer.
 *
 * Reading is what makes the map an LRU: a hit re-inserts, so `Map`'s insertion
 * order becomes recency of use and the eviction above drops the entry nobody has
 * asked about rather than the one that has been broken longest. Also exported for
 * the drivers.
 */
export function isStalled(path: string): boolean {
  const probe = stalled.get(path);
  if (probe === undefined) return false;
  stalled.delete(path);
  stalled.set(path, probe);
  return true;
}

/** Forget every stalled path. For the drivers, which reuse one process. */
export function forgetStalled(): void {
  stalled.clear();
}

/**
 * How many probes may be in flight against network filesystems at once.
 *
 * The memory above bounds the cost of a stalled mount to one probe *after* the
 * first has timed out. This bounds it before that, which is the case the memory
 * cannot reach: `listDirs` fires every child in one `Promise.all`, so a
 * directory holding twenty network mounts issues forty blocking calls
 * simultaneously and none of them has timed out yet. Two at a time means a
 * pathological listing costs two slots rather than forty, and the rest
 * short-circuit on the memory by the time they run.
 *
 * Only network paths are gated. Local directories are the overwhelming majority
 * of any listing and answer in microseconds; serialising those would trade a
 * failure that needs a stalled server for a slowdown that needs only a large
 * home directory.
 */
const MAX_REMOTE_PROBES = 2;

let remoteInFlight = 0;
const remoteWaiting: (() => void)[] = [];

/**
 * Run `probe` holding one of the {@link MAX_REMOTE_PROBES} permits.
 *
 * Released when the *bounded wait* ends, not when the filesystem call does —
 * and that is the point rather than a compromise. A call that has timed out has
 * already marked its mount, so whatever was queued behind it will short-circuit
 * instead of probing. Waiting for the real settlement would mean a permit is
 * held for as long as the slot is, and the gate would deadlock on exactly the
 * stalled mount it exists to survive.
 */
async function withRemotePermit<T>(run: () => Promise<T>): Promise<T> {
  // `while`, not `if`, and the difference is the whole bound. Releasing does
  // `remoteInFlight--` and *then* resolves a waiter, which only schedules that
  // waiter's continuation — so a caller arriving synchronously in between sees a
  // count below the ceiling, skips the queue, and increments. The woken waiter
  // then increments too, and the ceiling is exceeded by one more on every such
  // handoff. Re-checking on wake is what makes the number in the name true.
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

/**
 * Run a probe, holding a permit only if it is aimed at a network filesystem.
 *
 * The flag comes from {@link stallKeyFor}, which is the same decision that chose
 * the key, rather than from a second lookup — a path gated as remote but
 * remembered as local would spend permits and learn nothing from them.
 *
 * With no mount table nothing is remote, so nothing is gated and this is a
 * straight call. That is the fail-open path, and it is the one taken on any
 * platform whose table cannot be read.
 */
function gated<T>(target: StallTarget, run: () => Promise<T>): Promise<T> {
  return target.remote ? withRemotePermit(run) : run();
}

/**
 * One bounded, gated, remembered filesystem probe. **Every probe in this module
 * goes through here, and the ordering inside it is the entire mechanism.**
 *
 * The three steps have to happen in this order and they did not:
 *
 *   1. **The permit is taken before the call is dispatched.** Every caller used
 *      to build the promise — `const probe = realpath(path)` — and only then
 *      `await gated(...)`. An async function runs synchronously to its first
 *      `await`, so the blocking call was already submitted to libuv by the time
 *      the permit was requested, and `MAX_REMOTE_PROBES` rationed only who was
 *      allowed to *wait* for a slot already spent. `listDirs` fans out over every
 *      child at once, so a directory holding twenty network mounts issued forty
 *      blocking calls in one synchronous burst — the exact number the gate was
 *      written to reduce to two. `start` is a thunk for that reason: it is not a
 *      style preference, it is what makes the permit mean anything.
 *
 *   2. **The memory is re-read after the permit is granted, not only before.**
 *      All N callers check `stalled` in the same burst, before any of them has
 *      had the chance to time out, so all N queue. Without this second check each
 *      pair then burns the full deadline in turn and a listing of twenty stalled
 *      directories takes twenty seconds instead of two — past the web client's
 *      own 15s timeout, which it reads as the machine being unreachable. The
 *      comment on `MAX_REMOTE_PROBES` claimed "the rest short-circuit on the
 *      memory by the time they run"; this is the line that makes that true.
 *
 *   3. **The still-pending probe is what gets remembered**, so the entry clears
 *      when the mount comes back. See {@link markStalled}.
 */
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

/**
 * Remember that `path` did not answer, until `probe` says otherwise.
 *
 * `finally` rather than `then`: the interesting settlement is often a rejection
 * (the mount came back as `ESTALE`, or the directory was removed while we were
 * blocked on it), and that still means the path is answering again.
 */
function markStalled(path: string, probe: Promise<unknown>): void {
  if (stalled.size >= MAX_STALLED_PATHS) {
    const oldest = stalled.keys().next();
    if (!oldest.done) stalled.delete(oldest.value);
  }
  stalled.set(path, probe);
  void probe
    .catch(() => undefined)
    .finally(() => {
      // Only if it is still ours: an eviction above may have handed the key back
      // to a later probe of the same path, and clearing that one would re-arm
      // the leak this whole mechanism exists to bound.
      if (stalled.get(path) === probe) stalled.delete(path);
    });
}

/**
 * Race a probe against {@link DESCRIBE_TIMEOUT_MS}.
 *
 * Shared by {@link describe} and {@link follow} because they need the same three
 * things and getting any of them wrong is silent: the timer is unref'd (a
 * directory that never answers must not hold the process open at shutdown, and
 * the promise it races never settles to clear it), the timeout is distinguished
 * from a legitimate `null` answer by the wrapper rather than a sentinel value,
 * and the caller gets the *pending* probe back so it can be remembered.
 */
async function bounded<T>(
  probe: Promise<T>,
  timeoutMs: number,
): Promise<{ answered: true; value: T } | { answered: false }> {
  // A deadline of zero has already passed, and saying so with a settled promise
  // rather than `setTimeout(…, 0)` is what makes it mean that: a timer is
  // clamped to 1ms and loses to a local `realpath`, so the drivers would be
  // asserting the *healthy* path while claiming to assert the stalled one.
  // A microtask beats any filesystem completion, which is a macrotask.
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

/**
 * Does this path exist, with **"could not tell" as a real third answer**?
 *
 * `null` is not a convenience. `existsSync` has two answers and the callers that
 * used it were reading the missing third one as `false`: a session whose working
 * directory sits on a network mount that has stopped replying is not a session
 * whose directory was deleted, and `409 workspace_missing` for it is a confident
 * lie about somebody's work. The same reasoning `Liveness` already carries for a
 * process, and `loggedIn: boolean | null` for an agent — this codebase keeps
 * making the same distinction because collapsing it keeps producing the same
 * class of wrong answer.
 *
 * Bounded and remembered like every other probe here, so a workspace on a dead
 * mount costs one deadline rather than one per request, and the routes behind it
 * stay answerable.
 */
export async function probeExists(path: string, options: ProbeOptions = {}): Promise<boolean | null> {
  const ctx = await probeContext(options);
  // Normalized for the same reason `browse.ts` normalizes before keying: this is
  // a path from a database row that originally came from a request, and two
  // spellings of one directory must not be two entries in the memory.
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, () =>
    stat(path).then(
      () => true,
      () => false,
    ),
  );
  return answer.answered ? answer.value : null;
}

/** Where a path really points, or that there is nothing there to point anywhere. */
export type PathResolution = { kind: "path"; value: string } | { kind: "missing" };

/**
 * `realpath`, bounded — with the same third answer as everything else here.
 *
 * **`paths.ts`'s `resolved()` is the synchronous form of this, and the callers
 * that reach it with a path somebody else named are the hazard.** That helper is
 * `realpathSync` in a `try`, which is correct where the path is *ours* (a
 * worktree we are about to create) and is an uninterruptible event-loop stop
 * where it is not: `changes.ts` resolved `<workspace.root>/<the caller's
 * ?path=>`, and `GET /worktrees` resolves every path git reports, which by
 * construction includes worktrees this daemon never made. On a hard NFS mount
 * whose server has paused, either one takes every session, every socket and
 * `/health` with it at 0% CPU.
 *
 * `missing` rather than a throw, because every caller here treats "there is
 * nothing at this path" as an ordinary answer it turns into its own refusal —
 * and because a rejected promise would make the three answers two again.
 */
export async function probeRealpath(path: string, options: ProbeOptions = {}): Promise<PathResolution | null> {
  const ctx = await probeContext(options);
  // Normalized before keying, for the reason `probeExists` gives: this string
  // came off a request or out of git, and two spellings of one directory must
  // not become two entries in the memory.
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, () =>
    realpath(path).then(
      (value): PathResolution => ({ kind: "path", value }),
      // ENOENT, ENOTDIR, EACCES, ELOOP — all of them mean the same thing to
      // every caller: there is nothing here to place inside or outside a tree.
      (): PathResolution => ({ kind: "missing" }),
    ),
  );
  return answer.answered ? answer.value : null;
}

/** What a path turned out to be, when we could find out at all. */
export type FileProbe = { kind: "file"; size: number } | { kind: "other" };

/**
 * Is this path a regular file, and how big — with the same third answer.
 *
 * `lstat`, never `stat`, and that is the whole security content of this
 * function. A symlink has to be refused by **shape** rather than by where it
 * points: `changes.ts` records the measurement for the diff route — an agent
 * doing `ln -s ~/.ssh/id_rsa x` inside its own workspace would otherwise have
 * the target's bytes served to anyone holding the bearer token — and a route
 * that serves raw bytes for any path under the workspace is the general case of
 * exactly that. `kind: "other"` therefore covers symlinks, directories, fifos,
 * sockets and devices in one answer, because the caller's response to all of
 * them is identical and a finer type would invite a caller to allow one.
 *
 * ⚠ **This used to carve out an exception for `changes.ts`'s synchronous `lstat`
 * "on paths git has just reported, i.e. inside a repository git has already
 * walked", and that exception is withdrawn.** It did not survive being read
 * twice: git having listed a path a moment ago says nothing about whether the
 * *next* syscall returns — a mount that pauses in between takes the event loop
 * with it — and for a `plain` session the root git walked is itself a directory
 * the caller named. Even with every mount healthy it was four blocking calls per
 * untracked file, inline, up to the file cap. `probeBinary` at the foot of this
 * file is where that work went; `safeLstat` and `readlinkSync` in `changes.ts`
 * are what is left, and they run on the diff route's single already-contained
 * path rather than once per record.
 *
 * `null` for "could not tell", so a file on a sleeping mount is a `503` rather
 * than a confident 404 about somebody's work.
 */
export async function probeFile(path: string, options: ProbeOptions = {}): Promise<FileProbe | null> {
  const ctx = await probeContext(options);
  const answer = await attempt(stallKeyFor(resolve(path), ctx.mounts), ctx, () =>
    lstat(path).then(
      (info): FileProbe => (info.isFile() ? { kind: "file", size: info.size } : { kind: "other" }),
      // Missing, unreadable, or a component that is not a directory. All of them
      // are "not a regular file we can serve", and the route says so the same way.
      (): FileProbe => ({ kind: "other" }),
    ),
  );
  return answer.answered ? answer.value : null;
}

/**
 * git's own binary heuristic — a NUL byte in the first 8000 bytes — asked
 * through the deadline.
 *
 * ⚠ **This was four synchronous syscalls in `changes.ts`**, `lstatSync` +
 * `openSync` + `readSync` + `closeSync`, run once per untracked record while
 * parsing git's output. The exemption written into `probeFile`'s docblock said
 * that was acceptable because those are "paths git has just reported, i.e.
 * inside a repository git has already walked" — and that reasoning does not hold
 * up twice over. git having listed a path a moment ago says nothing about
 * whether the *next* syscall returns: a network mount that pauses in between
 * takes the event loop with it, and for a `plain` session the workspace root is
 * a directory the caller named rather than one this daemon created. Even with
 * every mount healthy it was up to 2000 files × 4 blocking calls inline, on the
 * loop that also carries every session, every socket and `/health`.
 *
 * `null` for "could not tell", which the caller reports as *not* binary — the
 * same answer the synchronous version gave for an unreadable file, and safe for
 * the same reason: `diffFile` re-`lstat`s and withholds content itself, so this
 * is a hint about what to offer rather than a decision about what to serve.
 */
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
      // Unreadable or vanished since git listed it. "Not binary" is the safe
      // answer for the reason above.
      return false;
    } finally {
      // Deliberately not awaited into the answer: a close that hangs must not
      // hold the caller, and the deadline above has already been spent.
      void handle?.close().catch(() => {});
    }
  });
  return answer.answered ? answer.value : null;
}
