import { realpathSync, statSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { atOrUnderResolved, containedInResolved, expandHome } from "./paths.js";
import {
  attempt,
  DESCRIBE_TIMEOUT_MS,
  stallKeyFor,
  probeContext,
  type ProbeContext,
  type ProbeOptions,
} from "./stall.js";
import { describeError } from "./http.js";

// Re-exported rather than re-implemented: `stall.ts` owns the memory now, and
// `scripts/daemoncheck.ts` reaches these through the module whose behaviour it is
// actually asserting.
export { forgetStalled, isStalled, probeExists, type ProbeOptions } from "./stall.js";

/**
 * Picking where an agent runs, from somewhere else.
 *
 * A client on the other side of a Tailnet cannot be expected to know what paths
 * exist on this machine, so the daemon has to let it look. Only directories are
 * ever listed — an agent runs in a directory — and git repos are flagged because
 * they are almost always the thing being aimed at.
 *
 * **The roots confine BROWSING, and nothing else.** They are not a sandbox: the
 * agent this daemon spawns runs as the daemon's own user and can already read and
 * write anywhere that user can, so confining `cwd` would buy nothing but the
 * illusion of a boundary. What the roots actually buy is a listing that starts at
 * your projects instead of at `/`.
 *
 * That paragraph was the original one, was replaced by its opposite when a daemon
 * began serving several people, and is now back. The intervening version was
 * right for what it described — with one container per person, an unconfined
 * `cwd` meant a worktree outside that person's mount — and both the deployment and
 * the argument have gone. Recording the round trip rather than quietly restoring
 * the text, because "this file used to say the opposite" is the kind of thing a
 * reader should be able to find out.
 *
 * So the asymmetry below is deliberate and worth stating plainly: `GET /fs/list`
 * is confined to the roots, and `resolveCwd`/`makeDir` are not. A picker that
 * starts at `/` is unusable on a phone; a `cwd` that must sit under a root is a
 * fence pretending to be a convenience, and it would stop somebody opening a
 * session in a repository they keep outside `REEMOAT_ROOTS` for no gain at all.
 */

export type PathErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_a_directory"
  | "outside_roots"
  /**
   * A path that is known not to answer. See {@link describe} — this is refused
   * rather than attempted, because attempting it is what costs a threadpool slot
   * that never comes back.
   */
  | "unresponsive";

export class PathError extends Error {
  constructor(
    readonly code: PathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PathError";
  }
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  /** Visible children, or null when the directory could not be read. */
  entries: number | null;
}

export interface DirListing {
  /** The directory listed, or null when these are the roots themselves. */
  path: string | null;
  /** Where "up" goes, or null at a root. */
  parent: string | null;
  roots: string[];
  entries: DirEntry[];
}

export interface BrowseOptions extends ProbeOptions {
  roots: string[];
  showHidden: boolean;
}



/**
 * Resolves the configured browse roots.
 *
 * `REEMOAT_ROOTS` is `PATH`-style, and it is an *optional narrowing*: unset, the
 * picker starts at the daemon user's home. Entries that do not resolve to a
 * directory are dropped rather than fatal — a stale entry in an environment file
 * should not stop the daemon from starting, and the failure it would cause is
 * indistinguishable from a hundred others at that moment.
 *
 * Realpath'd here, which is not tidiness. `withinRoots` resolves the path it is
 * asked about, so a root left unresolved makes every comparison fail on any host
 * where the path traverses a symlink — measured once already, when `/fs/list`
 * answered 403 for the caller's own home on macOS.
 */
export function resolveRoots(spec: string | undefined): string[] {
  const raw = (spec ?? "").split(delimiter).filter((entry) => entry.trim().length > 0);
  const candidates = raw.length > 0 ? raw : [homedir()];
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = realpathSync(expandHome(candidate.trim()));
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
    } catch {
      // Unreadable or missing — not worth failing startup over.
    }
  }
  // Never empty: an empty root list is a picker with nothing in it, which reads
  // as a broken daemon rather than as a narrow configuration.
  return roots.length > 0 ? roots : [homedir()];
}











/**
 * Lists the directories under `path`, or the roots when `path` is null.
 *
 * **Asynchronous throughout, and that is the load-bearing part rather than a
 * modernisation.** Every filesystem call here is made on a path the *caller*
 * named, and some paths do not answer: a stalled network mount blocks `open()`
 * indefinitely. Synchronously that stops the event loop and the whole daemon dies
 * — one browse request kills every session, every socket and `/health` with it.
 * Asynchronously the worst case is that this one request hangs.
 *
 * The residual cost is stated rather than hidden: a call that never returns holds
 * a libuv threadpool slot for the life of the process. There are four by default,
 * so repeated listings of a stalled mount will eventually make *all* async
 * filesystem work stop — but the daemon keeps answering, sessions keep running,
 * and SQLite is untouched because `node:sqlite` is synchronous and never uses the
 * pool. A degraded picker is an enormously better failure than a dead daemon.
 *
 * The path is resolved through `realpath` before it is checked against the roots,
 * so a symlink cannot be used to walk out of them.
 */
export async function listDirs(path: string | null, options: BrowseOptions): Promise<DirListing> {
  const { roots, showHidden } = options;
  const ctx = await probeContext(options);

  if (path === null) {
    return {
      path: null,
      parent: null,
      roots,
      entries: await Promise.all(roots.map((root) => describe(root, basename(root) || root, ctx))),
    };
  }

  // Navigating *into* a directory already known not to answer is refused by
  // `resolveExistingAsync` before it spends a filesystem call — the person
  // tapping that row has just been shown it as unreadable, so "it does not
  // answer" is a better reply than a spinner until the client's own timeout.
  //
  // Async for the same reason as everything else here: `path` came from the
  // caller, and resolving or stat-ing a stalled mount blocks exactly as hard as
  // reading it. Navigating *into* the bad directory has to fail like any other
  // slow request rather than take the daemon with it.
  const real = await resolveExistingAsync(path, ctx);

  // Before any further filesystem call, because it needs none: both sides are
  // resolved, so this is string comparison. Moved above the directory check for
  // that reason — spending a `stat` on a path we are about to refuse is work
  // done on somebody else's say-so, and on a stalled mount it is the expensive
  // kind.
  if (!withinRoots(real, roots)) {
    throw new PathError("outside_roots", `${path} is outside REEMOAT_ROOTS`);
  }

  // **Bounded, and this is the call the module was written for.** These two were
  // the last unbounded filesystem calls on the listing path, which made them the
  // ones that would actually hang: `resolveExistingAsync` above bounds only
  // `realpath`, and an NFS client answers path lookups out of its attribute
  // cache while `READDIR` and `GETATTR` are RPCs to the server. A mount that
  // resolves instantly and then blocks on the next call is not a narrow race, it
  // is the ordinary shape of the stall — and here there was no deadline, no
  // permit and no entry in `stalled`, so the request hung until the client gave
  // up and the slot was gone with nothing remembered to stop the next attempt.
  const target = stallKeyFor(real, ctx.mounts);
  const opened = await attempt(target, ctx, async () =>
    (await stat(real)).isDirectory() ? readdir(real, { withFileTypes: true }) : null,
  );
  if (!opened.answered) {
    throw new PathError("unresponsive", `${path} is not answering`);
  }
  if (opened.value === null) {
    throw new PathError("not_a_directory", `not a directory: ${path}`);
  }

  const candidates: { full: string; name: string; link: boolean }[] = [];
  for (const dirent of opened.value) {
    if (!showHidden && dirent.name.startsWith(".")) continue;
    if (!dirent.isSymbolicLink() && !dirent.isDirectory()) continue;
    candidates.push({ full: join(real, dirent.name), name: dirent.name, link: dirent.isSymbolicLink() });
  }

  // Following the links is `await`ed, and it used to be `realpathSync` +
  // `statSync`. That was the one place the conversion of this module missed, and
  // it is the worst place to miss: a symlink in a listed directory pointing into
  // a stalled mount blocked the *event loop*, which is the whole daemon, not one
  // request. Bounded by the same timer as `describe` for the same reason, and
  // done in the same parallel pass so a slow link costs nothing extra.
  const wanted = (
    await Promise.all(
      candidates.map(async (entry) => {
        if (!entry.link) return entry;
        const target = await follow(entry.full, ctx);
        // A link pointing out of the roots is not a way out of them, and one
        // that does not answer is not a directory we can describe.
        return target !== null && withinRoots(target, roots) ? entry : null;
      }),
    )
  ).filter((entry) => entry !== null);

  // In parallel, because each one is bounded and a home directory has plenty of
  // children — serially at two seconds apiece a single stalled mount would make
  // every listing behind it crawl.
  const entries = await Promise.all(wanted.map((w) => describe(w.full, w.name, ctx)));

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  // At the top of a configured root there is no parent to offer, so the picker
  // does not draw a crumb that then answers 403.
  const atRoot = roots.some((root) => atOrUnderResolved(real, root) && !containedInResolved(real, root));
  return { path: real, parent: atRoot ? null : dirname(real), roots, entries };
}

/**
 * Resolve a symlink to a directory, or `null` if it is neither.
 *
 * Bounded and stall-aware exactly like {@link describe}, with one honest
 * difference: **the stall is keyed by the link, not by what it points at.**
 *
 * What can hang is the target, so the target is what a reader would expect to be
 * remembered — and an earlier version of this comment said it was. It is not,
 * because learning the target *is* the call that hangs: `realpath` is the probe.
 * Keying on the link is therefore the only answer available without a second
 * syscall, and it is the conservative one — the entry is narrower than the truth,
 * so a stalled mount reached only through symlinks is re-probed once per link
 * rather than once per mount, and each of those is bounded and gated like any
 * other. What it is not is silent: a link is classified by the mount its own
 * path sits on, so a link in a local directory is treated as local and does not
 * take a remote permit.
 */
async function follow(link: string, ctx: ProbeContext): Promise<string | null> {
  const target = stallKeyFor(link, ctx.mounts);
  const answer = await attempt(target, ctx, () =>
    // `.catch` on the whole chain, not just on `realpath`: a `stat` that rejects
    // inside the success arm would otherwise reject the probe, and this runs
    // inside a `Promise.all` — one bad link would fail the entire listing.
    realpath(link)
      .then(async (resolvedTarget) => ((await stat(resolvedTarget)).isDirectory() ? resolvedTarget : null))
      .catch(() => null),
  );
  return answer.answered ? answer.value : null;
}



/**
 * Turns whatever a client typed into an absolute directory this daemon can use.
 *
 * Accepts `~`, because that is what you actually want to type on a phone, and it
 * means the daemon user's home — this daemon is one person's, and their home is
 * the only thing `~` could sensibly name.
 *
 * **Not confined**, and that is the whole of the change: what is checked is that
 * the path exists and is a directory, which are questions about whether the
 * request can be carried out rather than about whether it is allowed. The agent
 * that will run there is a child of this process with this process's uid, so a
 * `cwd` it was refused is a `cwd` it can reach with one `cd`.
 */
export async function resolveCwd(input: string, options: ProbeOptions = {}): Promise<string> {
  const expanded = expandHome(input.trim());
  if (expanded.length === 0) throw new PathError("invalid_path", "cwd must not be empty");
  if (!isAbsolute(expanded)) {
    throw new PathError("invalid_path", `cwd must be an absolute path, got "${input}"`);
  }
  // Async for the same reason `listDirs` is, and this is the path that decides
  // where an agent runs: `POST /sessions` with a cwd inside a stalled mount would
  // otherwise block the event loop before the session existed to explain it.
  const ctx = await probeContext(options);
  const real = await resolveExistingAsync(expanded, ctx);
  // Bounded too, and it was not. `resolveExistingAsync` bounds `realpath`; this
  // is the *next* call on the same path, and on NFS the first can be served from
  // the attribute cache while this one is an RPC to a server that has stopped
  // answering. Unbounded here, `POST /sessions` and `POST /fs/mkdir` hung for
  // ever and lost a threadpool slot per attempt — which is the per-attempt leak
  // the whole `stalled` mechanism exists to convert into a cost paid once.
  // The thunk absorbs its own errno rather than letting it out: everything this
  // module throws is a `PathError`, and `POST /sessions` reaches here, so a raw
  // `EACCES` escaping would be a 500 with no `error.code` for every client that
  // keys on one. `null` is "could not stat it", which after a successful realpath
  // means it went away underneath us.
  const answer = await attempt(stallKeyFor(real, ctx.mounts), ctx, () =>
    stat(real).then(
      (info) => info.isDirectory(),
      () => null,
    ),
  );
  if (!answer.answered) {
    throw new PathError("unresponsive", `${input} is not answering`);
  }
  if (answer.value === null) {
    throw new PathError("not_found", `${input} could not be read`);
  }
  if (!answer.value) {
    throw new PathError("not_a_directory", `not a directory: ${input}`);
  }
  return real;
}

/**
 * Realpath, off the event loop and on a deadline. See the note on `listDirs`.
 *
 * **Bounded, and that is what keeps the write paths alive.** This is the first
 * filesystem call `POST /fs/mkdir` and `POST /sessions` make, through
 * `resolveCwd`, and it had no deadline at all: pointed at a stalled mount it
 * never returned, so the route never answered, the client gave up at its own 15s
 * and the slot was gone for good. A `realpath` that takes longer than
 * {@link DESCRIBE_TIMEOUT_MS} on a path that exists is a mount that has stopped
 * answering, not a slow disk.
 *
 * Remembered as stalled on the way out, so the *next* caller is refused before
 * it spends a slot rather than after. That is the whole difference between one
 * lost slot and one lost slot per attempt — and a person whose folder did not
 * appear taps the button again.
 */
async function resolveExistingAsync(path: string, ctx: ProbeContext): Promise<string> {
  // **Normalized first, and that is not tidiness.** This is the one place a key
  // is derived from a path the caller wrote rather than from one `realpath` has
  // returned, and `mountFor` compares segment-wise against the literal string.
  // Unnormalized, every spelling of the same stalled directory — `/mnt/nas/x`,
  // `/mnt/nas/./x`, `//mnt/nas/x`, `/mnt/nas/../nas/x` — is a key the memory has
  // never seen, so each one is admitted, probes afresh, times out, and leaves a
  // libuv slot blocked in the kernel for the life of the process. `/fs/list` is
  // reachable through the relay by anybody holding a grant, so that is a handful
  // of requests to exhaust the pool while `/health` reports the daemon up.
  // `resolve` is pure string work — no filesystem call, which is the whole
  // constraint this module is written under.
  const normalized = resolve(path);
  // Still best effort on a path not yet resolved: a mount reached *through* a
  // symlink is keyed by the path instead, because this is the call that would
  // resolve it. Advisory either way — being wrong costs the older, per-path
  // behaviour and nothing else.
  const target = stallKeyFor(normalized, ctx.mounts);

  const answer = await attempt(target, ctx, () =>
    realpath(path).catch((error: unknown) => ({ failed: error })),
  );
  if (!answer.answered) {
    throw new PathError(
      "unresponsive",
      answer.known ? `${path} is not answering` : `${path} did not answer in ${ctx.timeoutMs}ms`,
    );
  }
  const value = answer.value;
  if (typeof value !== "string") {
    const error = value.failed;
    throw new PathError(
      "not_found",
      `${path}: ${describeError(error)}`,
    );
  }
  return value;
}

/**
 * Containment, through the one shared primitive.
 *
 * This used to be a local textual test that resolved neither side, which made it
 * the third implementation of containment in the codebase and the only one that
 * could disagree with the other two. `src/paths.ts` exists precisely to stop
 * that — "a second implementation of this that drifted from the first would be a
 * boundary that exists in one place and not the other."
 *
 * The drift was real and fail-closed: the caller passed an unresolved root while
 * `resolveExisting` returns a realpath'd path, so on any host whose root
 * traverses a symlink — `/srv` linked elsewhere, or anything under macOS `/var` —
 * every path in the user's *own* tree failed this test. `GET /fs/list` answered
 * `403 outside_roots` for their home while `POST /sessions` accepted the
 * identical path. The directory picker was dead and the error blamed the wrong
 * thing. `resolveRoots` realpaths its answers for that reason.
 *
 * Kept even though nothing here is a boundary any more: it is what makes the
 * listing start where it was configured to start, and a picker that wanders out
 * of its roots by following one symlink is a bug either way.
 *
 * **Both sides arrive resolved, so this resolves neither.** `resolveRoots`
 * realpaths every root at startup and every caller here passes a path that has
 * just been through `realpath` — so the resolving variant was doing two
 * `realpathSync` calls per root per candidate, which is a *synchronous*
 * filesystem call on a caller-supplied path in the module rewritten to keep a
 * stalled mount off the event loop. The property above is unchanged; it is
 * satisfied before the call rather than inside it.
 */
function withinRoots(resolvedPath: string, roots: string[]): boolean {
  return roots.some((root) => atOrUnderResolved(resolvedPath, root));
}

/**
 * One row of a listing: is it a repository, and how much is in it.
 *
 * Both answers cost a filesystem call on a path somebody else named, so both are
 * behind {@link DESCRIBE_TIMEOUT_MS}. `entries: null` already meant "could not be
 * read" and both clients render it as `?` or omit it, so a directory that does
 * not answer in time degrades into exactly the shape that already existed rather
 * than needing a new one.
 *
 * `isGitRepo` falls back to `false` on a timeout, which is the safe direction:
 * the flag is a hint that makes a repository easier to spot in a long list, and
 * claiming one that never answered would be worse than not flagging it.
 */
async function describe(path: string, name: string, ctx: ProbeContext): Promise<DirEntry> {
  const degraded: DirEntry = { name, path, isGitRepo: false, entries: null };
  // Known not to answer: return the same shape the timeout would have produced,
  // having spent nothing. On a network mount `key` is the mount point, so one
  // stalled server answers for every directory beneath it. See {@link stalled}
  // for why this is the load-bearing half and the timeout is not, and
  // {@link attempt} for why the probe is not started until the permit is held.
  const target = stallKeyFor(path, ctx.mounts);
  const answer = await attempt(target, ctx, async () => {
    const [count, git] = await Promise.all([
      readdir(path).then(
        (items) => items.length,
        // One unreadable directory deep in ~/Library must not fail the listing.
        () => null,
      ),
      stat(join(path, ".git")).then(
        () => true,
        () => false,
      ),
    ]);
    return { name, path, isGitRepo: git, entries: count };
  });
  return answer.answered ? answer.value : degraded;
}

/**
 * Creates one directory.
 *
 * `parent` + `name`, never a whole path, and `name` is validated as a single
 * segment. That is kept even with no boundary to protect, because it is not a
 * containment check: it is what makes "create a folder called X" mean one thing.
 * A `name` of `a/b/c` from a picker is a typo, and answering it by creating three
 * directories is a worse reading than refusing.
 *
 * Not recursive, for the same reason. One directory at a time is what a picker
 * asks for, and `mkdir -p` on a path somebody typed on a phone is how four of
 * them appear silently.
 */
export async function makeDir(parent: string, name: string, options: ProbeOptions = {}): Promise<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new PathError("invalid_path", "a folder needs a name");
  if (trimmed === "." || trimmed === "..") {
    throw new PathError("invalid_path", `"${trimmed}" is not a folder name`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new PathError("invalid_path", "a folder name cannot contain a path separator");
  }

  // Resolved exactly as starting a session there would be, so a folder can never
  // be created somewhere a session could not then run.
  const base = await resolveCwd(parent, options);
  const target = join(base, trimmed);

  // **Bounded, and `mkdir` is the sharpest case in the file.** Async already kept
  // it off the event loop, but nothing kept it off the threadpool for ever: a
  // directory creation is an unconditional RPC — it cannot be served from any
  // cache — so a mount that answered `realpath` and `stat` a microsecond earlier
  // can block here indefinitely. The route's own note says a person whose folder
  // did not appear "taps the button again", and every tap cost a permanent slot
  // with nothing remembered to refuse the next one.
  const ctx = await probeContext(options);
  const key = stallKeyFor(base, ctx.mounts);
  const made = await attempt(key, ctx, () =>
    mkdir(target).then(
      () => null,
      (error: unknown) => ({ failed: error }),
    ),
  );
  if (!made.answered) {
    throw new PathError("unresponsive", `${parent} is not answering`);
  }
  const failure = made.value;
  if (failure !== null) {
    const code = (failure.failed as { code?: string }).code;
    if (code !== "EEXIST") {
      throw new PathError("invalid_path", `could not create ${trimmed}: ${String(failure.failed)}`);
    }
    // Already there is not a failure for a picker: the caller wanted a folder of
    // that name to exist and one does. Answering with it lets them carry on into
    // it, which is what they were going to do anyway.
    const existing = await attempt(key, ctx, () =>
      stat(target).then(
        (info) => info.isDirectory(),
        () => null,
      ),
    );
    if (!existing.answered) {
      throw new PathError("unresponsive", `${parent} is not answering`);
    }
    if (existing.value !== true) {
      throw new PathError("invalid_path", `${trimmed} exists and is not a folder`);
    }
  }
  return target;
}
