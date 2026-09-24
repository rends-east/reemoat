// Hand mirror of the catalogue service's catalogue.ts (private repository); manifest types come from wire.ts. DOM-free for webcheck.

import type { ManifestPreview } from "./pluginArchive";
import type { PluginContributions } from "./wire";

/** Not negotiated: a document above this schema is refused whole rather than partially read. */
export const CATALOGUE_SCHEMA = 1;

/** Every key is present with a nullable value; use ?? and never || here, since archiveBytes may be 0. */
export interface CatalogueSource {
  kind: "github";
  repo: string;
  commit: string;
  browse: string;
  manifest: string;
  manifestRaw: string;
  archive: string;
  archiveName: string;
  archiveBytes: number | null;
  icon: string | null;
  /** Informational, never a gate: GitHub tarballs are not byte-stable, and the pin is the commit. */
  sha256Seen: string | null;
}

/** scopes, net and contributes are derived from the pinned plugin.json; no free text lives here, so the consent screen cannot be lied to. */
export interface CatalogueEntry {
  id: string;
  name: string;
  description: string | null;
  version: string;
  api: number;
  scopes: readonly string[];
  net: readonly string[];
  contributes: PluginContributions;
  source: CatalogueSource;
  homepage: string | null;
  author: string | null;
  license: string | null;
  categories: readonly string[];
  publishedAt: string;
}

/** Fails closed on a missing or mistyped required field, but tolerates unknown fields at every depth (webcheck pins both). */
export type CatalogueRead =
  | { kind: "ok"; entries: CatalogueEntry[] }
  | { kind: "too_new"; schema: number }
  | { kind: "malformed"; reason: string }
  | { kind: "unreachable"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

function readContributes(raw: unknown): PluginContributions {
  const source = isObject(raw) ? raw : {};
  const screen = source["screen"];
  const title = isObject(screen) ? text(screen["title"]) : null;
  return {
    screen: title === null ? null : { title },
    settings: source["settings"] === true,
    actions: Array.isArray(source["actions"])
      ? source["actions"].flatMap((one) => {
          if (!isObject(one)) return [];
          const id = text(one["id"]);
          const label = text(one["title"]);
          const on = one["on"];
          if (id === null || label === null || (on !== "session" && on !== "screen")) return [];
          return [{ id, title: label, on }];
        })
      : [],
    // Cast rather than filtered: an unknown hook must still reach the disclosure.
    hooks: strings(source["hooks"]) as PluginContributions["hooks"],
  };
}

// Same expression as REPO in src/plugins/source.ts; it also keeps a slash from adding a path segment to the derived URLs.
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const COMMIT = /^[0-9a-f]{40}$/;

const FORGE_HOST = "github.com";
const RAW_HOST = "raw.githubusercontent.com";

/** Parsed rather than prefix-matched, so userinfo or look-alike hosts cannot pass; host includes the port. */
function hostedUrl(value: unknown, host: string): string | null {
  const raw = text(value);
  if (raw === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" && parsed.host === host ? raw : null;
}

function readSource(raw: unknown): CatalogueSource | null {
  if (!isObject(raw) || raw["kind"] !== "github") return null;
  const repo = text(raw["repo"]);
  const commit = text(raw["commit"]);
  const archive = text(raw["archive"]);
  if (repo === null || !REPO.test(repo) || commit === null || !COMMIT.test(commit) || archive === null) {
    return null;
  }
  // The only installable shape is plugin.json at the repository root (findManifestRoot looks one wrapper directory deep).
  const manifestRaw = `https://${RAW_HOST}/${repo}/${commit}/plugin.json`;
  // Derived, and an entry spelling it differently is dropped: these bytes are the permission list somebody agrees to.
  if (text(raw["manifestRaw"]) !== manifestRaw) return null;
  const bytes = raw["archiveBytes"];
  return {
    kind: "github",
    repo,
    commit,
    // Person-facing links must stay on github.com; any other value falls back to the derived address.
    browse: hostedUrl(raw["browse"], FORGE_HOST) ?? `https://${FORGE_HOST}/${repo}/tree/${commit}`,
    manifest: hostedUrl(raw["manifest"], FORGE_HOST) ?? `https://${FORGE_HOST}/${repo}/blob/${commit}/plugin.json`,
    manifestRaw,
    archive,
    archiveName: text(raw["archiveName"]) ?? `${repo}-${commit}.tar.gz`,
    archiveBytes: typeof bytes === "number" && Number.isFinite(bytes) ? bytes : null,
    icon: hostedUrl(raw["icon"], RAW_HOST),
    sha256Seen: text(raw["sha256Seen"]),
  };
}

/** null for an entry this build cannot read in full; never a partial entry. */
export function readEntry(raw: unknown): CatalogueEntry | null {
  if (!isObject(raw)) return null;
  const id = text(raw["id"]);
  const name = text(raw["name"]);
  const version = text(raw["version"]);
  const api = raw["api"];
  const source = readSource(raw["source"]);
  if (id === null || name === null || version === null || typeof api !== "number" || source === null) return null;
  return {
    id,
    name,
    description: text(raw["description"]),
    version,
    api,
    scopes: strings(raw["scopes"]),
    net: strings(raw["net"]),
    contributes: readContributes(raw["contributes"]),
    source,
    homepage: text(raw["homepage"]),
    author: text(raw["author"]),
    license: text(raw["license"]),
    categories: strings(raw["categories"]),
    publishedAt: text(raw["publishedAt"]) ?? "",
  };
}

export function readCatalogue(raw: unknown): CatalogueRead {
  if (!isObject(raw)) return { kind: "malformed", reason: "that is not a catalogue" };
  const schema = raw["schema"];
  if (typeof schema !== "number") return { kind: "malformed", reason: "that catalogue names no schema" };
  if (schema > CATALOGUE_SCHEMA) return { kind: "too_new", schema };
  const plugins = raw["plugins"];
  if (!Array.isArray(plugins)) return { kind: "malformed", reason: "that catalogue has no list of plugins" };
  return { kind: "ok", entries: plugins.map(readEntry).filter((one): one is CatalogueEntry => one !== null) };
}

/** An entry this build cannot read is ok with no entries, not malformed. */
export function readOne(raw: unknown): CatalogueRead {
  if (!isObject(raw)) return { kind: "malformed", reason: "that is not a plugin" };
  const schema = raw["schema"];
  if (typeof schema !== "number") return { kind: "malformed", reason: "that answer names no schema" };
  if (schema > CATALOGUE_SCHEMA) return { kind: "too_new", schema };
  const entry = readEntry(raw["plugin"]);
  return { kind: "ok", entries: entry === null ? [] : [entry] };
}

export function readVersions(raw: unknown): CatalogueRead {
  if (!isObject(raw)) return { kind: "malformed", reason: "that is not a version list" };
  const schema = raw["schema"];
  if (typeof schema !== "number") return { kind: "malformed", reason: "that answer names no schema" };
  if (schema > CATALOGUE_SCHEMA) return { kind: "too_new", schema };
  const versions = raw["versions"];
  if (!Array.isArray(versions)) return { kind: "malformed", reason: "that answer has no versions" };
  return { kind: "ok", entries: versions.map(readEntry).filter((one): one is CatalogueEntry => one !== null) };
}

/** Fallback disclosure, used only when the manifest at the pinned commit could not be read. */
export function previewOf(entry: CatalogueEntry): ManifestPreview {
  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    description: entry.description,
    scopes: [...entry.scopes],
    net: [...entry.net],
    screen: entry.contributes.screen?.title ?? null,
    settings: entry.contributes.settings,
    actions: entry.contributes.actions.map((action) => ({ id: action.id, title: action.title, on: action.on })),
    hooks: [...entry.contributes.hooks],
    // Empty on purpose: contributed harnesses and providers come only from the pinned plugin.json, and the daemon's consentGap refuses an undisclosed one.
    adds: [],
  };
}

/** Numeric per component, since a string compare puts 0.10.0 before 0.9.0; an unparseable part counts as zero. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value.split(".").map((one) => {
      const parsed = Number.parseInt(one, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isNewer(catalogue: string, installed: string): boolean {
  return compareVersions(catalogue, installed) > 0;
}

export const CATALOGUE_TIMEOUT_MS = 15_000;

export function catalogueEndpoint(base: string, path: string): string {
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
}

/** Never sends a credential, and caching is left to the browser: ETag is unreadable cross-origin and If-None-Match forces a preflight. */
export async function fetchCatalogue(
  base: string,
  path: string,
  read: (raw: unknown) => CatalogueRead,
): Promise<CatalogueRead> {
  let response: Response;
  let url: string;
  try {
    url = catalogueEndpoint(base, path);
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return {
      kind: "unreachable",
      reason: response.status === 404 ? "the catalogue has no such plugin" : `the catalogue answered ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
  return read(body);
}

export const CATALOGUE_PATHS = {
  list: "api/plugins/list",
  get: (id: string): string => `api/plugins/get/${encodeURIComponent(id)}`,
  versions: (id: string): string => `api/plugins/versions/${encodeURIComponent(id)}`,
} as const;

export function catalogueNotice(read: CatalogueRead): string | null {
  switch (read.kind) {
    case "ok":
      return read.entries.length === 0 ? "There is nothing in the catalogue yet." : null;
    case "too_new":
      return "This catalogue is newer than this app. Nothing here can be read safely until the app is updated.";
    case "malformed":
      return `The catalogue could not be read: ${read.reason}.`;
    case "unreachable":
      return `The catalogue could not be reached: ${read.reason}.`;
  }
}
