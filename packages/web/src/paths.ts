/**
 * Paths, as the browser sees them.
 *
 * The daemon speaks absolute paths — a `file_change` carries whatever the agent
 * wrote, and a `FileLocation` carries wherever the tool looked — while
 * `GET /sessions/:id/files` takes a path relative to the workspace root. These
 * two functions are the join between them.
 *
 * No `node:path`: this runs in a browser, and the separator is always `/` because
 * the only paths reaching here came out of a daemon that already normalized them.
 *
 * **Neither of these is a boundary.** The daemon contains the path itself with
 * `safeRelPath`, and that is where containment actually lives. What refusing here
 * buys is that this client never hands a `..` to a route on the strength of the
 * route rejecting it — and that a button is not drawn for something that cannot
 * work.
 */

/**
 * Express `path` relative to `root`, or `null` if it is not underneath it.
 *
 * The separator check is the part that earns the function: `("/w",
 * "/workspace/a")` has to be `null`, and a bare `startsWith` says it is `a`. That
 * is the same hole `paths.ts` on the daemon side spends a docblock on, one
 * language over.
 */
export function relativeTo(root: string, path: string): string | null {
  if (root.length === 0 || path.length === 0) return null;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;

  let rel: string;
  if (path.startsWith("/")) {
    // The root itself is a directory, not a file, so it is never downloadable.
    if (path === base) return null;
    if (!path.startsWith(`${base}/`)) return null;
    rel = path.slice(base.length + 1);
  } else {
    // Already relative. Passed through rather than rejected, because an agent
    // that reports a repo-relative path is reporting the thing we want.
    rel = path;
  }

  if (rel.length === 0) return null;
  // A trailing slash names a directory.
  if (rel.endsWith("/")) return null;
  for (const segment of rel.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
  }
  return rel;
}

/**
 * A working directory as somebody would say it out loud.
 *
 * ⚠ **Reported from a phone**, against a pinned row reading
 * `…/rends/2026-07-tare-r…` on the title *and* `claude · …/rends/2026-07-ta…`
 * underneath it: the same absolute path, truncated twice, two thirds of it spent
 * on `/Users/rends` — which is where every session on that machine lives and
 * therefore tells nobody anything.
 *
 * The old answer was `shortPath`, which keeps the last **two** segments
 * unconditionally. `folderNames` in `groups.ts` had already written down why that
 * is wrong — "always two segments is a wall of `Users/rends`" — and went to some
 * length to avoid it for folder headers, while the rows themselves went on doing
 * exactly that.
 *
 * **The prefix to cut is the daemon's own `REEMOAT_ROOTS`**, which defaults to
 * the home directory and is what `/fs/roots` already serves to the directory
 * picker. That is a fact the daemon states rather than one this client works out:
 * a home directory guessed from `/Users/<x>` or `/home/<x>` would be a rule about
 * one operating system's conventions applied to somebody else's machine, and this
 * codebase refuses that kind of guess everywhere else on this wire.
 *
 * **The longest matching root wins**, because roots may nest (`~` and
 * `~/work`) and the more specific one is the one that says more.
 *
 * Two degradations, both deliberate and both silent. A path under **no** root —
 * `cwd` is not confined, so this is ordinary rather than exotic — falls back to
 * `shortPath`, i.e. exactly what every row drew before this existed. And an empty
 * `roots` does the same, which is what an older daemon, an unreachable one, or a
 * listing that has not landed yet all look like.
 */
export function displayCwd(cwd: string, roots: readonly string[]): string {
  const path = cwd.trim();
  if (path.length === 0) return path;
  let best: string | null = null;
  for (const root of roots) {
    const base = root.endsWith("/") ? root.slice(0, -1) : root;
    if (base.length === 0) continue;
    // The root itself, which `relativeTo` answers `null` for — correctly, since
    // it has no *relative* part. Here it is the whole answer.
    if (path === base) return "~";
    const rel = relativeTo(base, path);
    if (rel === null) continue;
    if (best === null || rel.length < best.length) best = rel;
  }
  return best === null ? shortPath(path) : `~/${best}`;
}

/**
 * The last two segments of a path, with a leading ellipsis.
 *
 * The fallback {@link displayCwd} reaches for when a directory is under none of
 * the daemon's roots — at which point there is no prefix anybody agreed on to
 * cut, and two segments is the most that fits a row.
 */
export function shortPath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * What to call the file a person just downloaded.
 *
 * Derived from the path we asked for rather than read off `Content-Disposition`,
 * and that is forced rather than lazy: the daemon sends no
 * `Access-Control-Expose-Headers`, so on a cross-origin response a browser only
 * exposes the CORS-safelisted headers and `content-disposition` is not one of
 * them. `content-length` is, which is why the size check works and this does not.
 *
 * The upside is that no RFC 5987 parser has to exist in a browser.
 */
export function filenameFor(rel: string): string | null {
  if (rel.length === 0 || rel.endsWith("/")) return null;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.length === 0 ? null : name;
}

/**
 * Is this inline code span a file this session produced, and can we fetch it?
 *
 * **Two filters, and the first one does nearly all the work.** Measured across
 * every session in one real database: agent prose contained 55 path-shaped
 * strings, of which 4 were inside their session's workspace. One session printed
 * 39 paths and would show no button at all, because none of them were its own.
 * That is the answer to "won't this clutter the transcript" — it is the
 * containment test, not a guess about intent, that keeps it quiet.
 *
 * The second filter — the path is one this session actually touched, from a
 * `file_change` or a tool call's `locations` — added nothing on that sample and
 * is kept anyway, cheaply: it guards the case the sample does not contain, a
 * workspace that is a large shared directory where an agent name-drops paths it
 * never opened. Saying it is unproven is more useful than pretending it earned
 * its place.
 *
 * **Deliberately boring about what looks like a path**, because the span is a
 * string an agent chose and inline code holds commands far more often than
 * filenames. Anything with whitespace is refused outright, which removes almost
 * every command in one rule.
 *
 * This decides whether to offer a *download*. It says nothing about whether the
 * agent wanted the file **displayed** — that is a different question with a
 * different answer, and guessing it from a path is how a transcript becomes a
 * wall of images.
 */
export function downloadablePath(span: string, root: string, touched: ReadonlySet<string>): string | null {
  const text = span.trim();
  if (text.length === 0 || text.length > 4096) return null;
  // A command, a sentence, or a flag. Not a path we are willing to act on.
  if (/\s/.test(text)) return null;

  /*
   * A bare filename counts, and requiring a slash was wrong.
   *
   * Measured against a real transcript: the agent wrote the two full paths *and*
   * referred to the same files again as `ffmpeg-claude.png`, and only the former
   * became buttons. The slash was standing in for "this looks like a path", which
   * is a job `touched` already does properly — `npm` is not in the set and
   * `ffmpeg-claude.png` is. Leaning on the membership test instead makes the
   * shorter, more natural reference work and rejects no more commands than before.
   */

  // `touched` holds what the daemon reported, which is absolute. A relative span
  // is resolved against the root before it can be compared with them.
  const absolute = text.startsWith("/")
    ? text
    : `${root.endsWith("/") ? root.slice(0, -1) : root}/${text}`;
  if (!touched.has(absolute)) return null;

  return relativeTo(root, absolute);
}

/** Bytes, for a chip. Short enough to sit next to a filename on a phone. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
