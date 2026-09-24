// Not a boundary: containment lives in the daemon's `safeRelPath`; this only avoids sending a `..` or drawing a dead button.

/** `null` unless `path` is strictly under `root` at a separator: `/w` is not a root of `/workspace/a`. */
export function relativeTo(root: string, path: string): string | null {
  if (root.length === 0 || path.length === 0) return null;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;

  let rel: string;
  if (path.startsWith("/")) {
    if (path === base) return null;
    if (!path.startsWith(`${base}/`)) return null;
    rel = path.slice(base.length + 1);
  } else {
    rel = path;
  }

  if (rel.length === 0) return null;
  if (rel.endsWith("/")) return null;
  for (const segment of rel.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
  }
  return rel;
}

/** Cuts the longest matching daemon root to `~`; under no root, or with no roots yet, falls back to `shortPath`. */
export function displayCwd(cwd: string, roots: readonly string[]): string {
  const path = cwd.trim();
  if (path.length === 0) return path;
  const match = matchRoot(path, roots);
  if (match === null) return shortPath(path);
  return match.rel.length === 0 ? "~" : `~/${match.rel}`;
}

/** Drops only the `~/` marker, never the levels below the root: those tell rows apart. */
export function folderLabel(cwd: string, roots: readonly string[]): string {
  const shown = displayCwd(cwd, roots);
  return shown.startsWith("~/") ? shown.slice(2) : shown;
}

function matchRoot(cwd: string, roots: readonly string[]): { base: string; rel: string } | null {
  const path = cwd.trim();
  if (path.length === 0) return null;
  let best: { base: string; rel: string } | null = null;
  for (const root of roots) {
    const base = root.endsWith("/") ? root.slice(0, -1) : root;
    if (base.length === 0) continue;
    if (path === base) return { base, rel: "" };
    const rel = relativeTo(base, path);
    if (rel === null) continue;
    if (best === null || rel.length < best.rel.length) best = { base, rel };
  }
  return best;
}

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/** The first crumb reads `~` but addresses the absolute root (Q3.441); empty under no root. */
export function pathCrumbs(cwd: string, roots: readonly string[]): readonly Crumb[] {
  const match = matchRoot(cwd, roots);
  if (match === null) return [];
  const crumbs: Crumb[] = [{ label: "~", path: match.base }];
  let walked = match.base;
  if (match.rel.length > 0) {
    for (const part of match.rel.split("/")) {
      walked = `${walked}/${part}`;
      crumbs.push({ label: part, path: walked });
    }
  }
  return crumbs;
}

export function shortPath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/** Named from the path because the daemon does not expose `Content-Disposition` cross-origin. */
export function filenameFor(rel: string): string | null {
  if (rel.length === 0 || rel.endsWith("/")) return null;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.length === 0 ? null : name;
}

/** A download offer only for a whitespace-free span inside the workspace that this session touched. */
export function downloadablePath(span: string, root: string, touched: ReadonlySet<string>): string | null {
  const text = span.trim();
  if (text.length === 0 || text.length > 4096) return null;
  if (/\s/.test(text)) return null;

  const absolute = text.startsWith("/")
    ? text
    : `${root.endsWith("/") ? root.slice(0, -1) : root}/${text}`;
  if (!touched.has(absolute)) return null;

  return relativeTo(root, absolute);
}

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
