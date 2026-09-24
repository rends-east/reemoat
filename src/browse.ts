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

export { forgetStalled, isStalled, probeExists, type ProbeOptions } from "./stall.js";

// The roots confine browsing only, never cwd, since the agent runs as this uid: GET /fs/list is confined, resolveCwd and makeDir are not.

export type PathErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_a_directory"
  | "outside_roots"
  /** Known not to answer: refused rather than attempted, since attempting costs a threadpool slot for good. */
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
  entries: number | null;
}

export interface DirListing {
  path: string | null;
  parent: string | null;
  roots: string[];
  entries: DirEntry[];
}

export interface BrowseOptions extends ProbeOptions {
  roots: string[];
  showHidden: boolean;
}



/** Resolves REEMOAT_ROOTS (PATH-style, default home), dropping non-directories; realpath'd so withinRoots compares resolved paths. */
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
  return roots.length > 0 ? roots : [homedir()];
}











/** Async and bounded throughout: every path is caller-named, and a stalled mount must not block the event loop. */
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

  const real = await resolveExistingAsync(path, ctx);

  if (!withinRoots(real, roots)) {
    throw new PathError("outside_roots", `${path} is outside REEMOAT_ROOTS`);
  }

  // Bounded: NFS answers realpath from its cache while READDIR and GETATTR go to the server.
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

  // Links are followed async and bounded: a link into a stalled mount must not block the event loop.
  const wanted = (
    await Promise.all(
      candidates.map(async (entry) => {
        if (!entry.link) return entry;
        const target = await follow(entry.full, ctx);
        return target !== null && withinRoots(target, roots) ? entry : null;
      }),
    )
  ).filter((entry) => entry !== null);

  const entries = await Promise.all(wanted.map((w) => describe(w.full, w.name, ctx)));

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const atRoot = roots.some((root) => atOrUnderResolved(real, root) && !containedInResolved(real, root));
  return { path: real, parent: atRoot ? null : dirname(real), roots, entries };
}

// The stall is keyed by the link, not its target, because resolving the target is the call that hangs.
async function follow(link: string, ctx: ProbeContext): Promise<string | null> {
  const target = stallKeyFor(link, ctx.mounts);
  const answer = await attempt(target, ctx, () =>
    realpath(link)
      .then(async (resolvedTarget) => ((await stat(resolvedTarget)).isDirectory() ? resolvedTarget : null))
      .catch(() => null),
  );
  return answer.answered ? answer.value : null;
}



/** Accepts ~ and requires an existing absolute directory; deliberately not confined to the roots. */
export async function resolveCwd(input: string, options: ProbeOptions = {}): Promise<string> {
  const expanded = expandHome(input.trim());
  if (expanded.length === 0) throw new PathError("invalid_path", "cwd must not be empty");
  if (!isAbsolute(expanded)) {
    throw new PathError("invalid_path", `cwd must be an absolute path, got "${input}"`);
  }
  const ctx = await probeContext(options);
  const real = await resolveExistingAsync(expanded, ctx);
  // Bounded too: on NFS the stat can hang after realpath answered from cache. Errors become null so only PathError escapes.
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

/** Bounded realpath; a timeout is remembered as stalled, so the next caller is refused before spending a slot. */
async function resolveExistingAsync(path: string, ctx: ProbeContext): Promise<string> {
  // Normalized first: the stall key is compared as a string, and each unnormalized spelling would probe afresh and leak a slot.
  const normalized = resolve(path);
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

function withinRoots(resolvedPath: string, roots: string[]): boolean {
  return roots.some((root) => atOrUnderResolved(resolvedPath, root));
}

/** Both answers are bounded by {@link DESCRIBE_TIMEOUT_MS}; a timeout degrades to entries null and isGitRepo false. */
async function describe(path: string, name: string, ctx: ProbeContext): Promise<DirEntry> {
  const degraded: DirEntry = { name, path, isGitRepo: false, entries: null };
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

/** Creates exactly one directory: name must be a single segment, and nothing is created recursively. */
export async function makeDir(parent: string, name: string, options: ProbeOptions = {}): Promise<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new PathError("invalid_path", "a folder needs a name");
  if (trimmed === "." || trimmed === "..") {
    throw new PathError("invalid_path", `"${trimmed}" is not a folder name`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new PathError("invalid_path", "a folder name cannot contain a path separator");
  }

  const base = await resolveCwd(parent, options);
  const target = join(base, trimmed);

  // Bounded: mkdir is an RPC no cache can serve, so it can hang after realpath and stat answered.
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
