// Reads a plugin's manifest in the browser, so consent comes before the daemon unpacks anything. Lenient, never a validator.

/** What the archive claims, unvalidated: a scope this client does not know is still shown. */
export interface ManifestPreview {
  id: string;
  name: string;
  version: string;
  description: string | null;
  scopes: string[];
  net: string[];
  screen: string | null;
  settings: boolean;
  actions: { id: string; title: string; on: string }[];
  hooks: string[];
  /** The exact strings the daemon's `consentGap` compares, with the whole normalised base URL rather than its origin. */
  adds: string[];
}

const TWO_MANIFESTS = "that archive holds more than one plugin.json and nothing can say which one would be installed";

export type ArchivePeek =
  | { kind: "ok"; manifest: ManifestPreview }
  /** Not a refusal: the daemon may still accept it; this screen just cannot say what it asks for. */
  | { kind: "unreadable"; reason: string };

/** Must equal the daemon's `PLUGIN_LIMITS.maxUnpackedBytes`, or consent becomes a stricter second gate. */
export const MAX_PEEK_BYTES = 8 * 1024 * 1024;

const TAR_BLOCK = 512;

// The daemon's `findManifestRoot` searches no deeper, so neither may this preview.
const MAX_MANIFEST_DEPTH = 1;

export async function peekPluginArchive(blob: Blob): Promise<ArchivePeek> {
  let head: Uint8Array;
  try {
    head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  } catch {
    return { kind: "unreadable", reason: "that file could not be read" };
  }

  try {
    if (head[0] === 0x1f && head[1] === 0x8b) return await peekTarGz(blob);
    if (head[0] === 0x50 && head[1] === 0x4b) return await peekZip(blob);
  } catch (error) {
    return { kind: "unreadable", reason: describe(error) };
  }
  return { kind: "unreadable", reason: "that is not a .tar.gz or a .zip" };
}

async function peekTarGz(blob: Blob): Promise<ArchivePeek> {
  if (blob.size > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that archive is larger than a plugin may be" };
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();

  // One buffer with a read cursor; the consumed prefix is reclaimed only once it is at least what remains, keeping the walk linear.
  let held = new Uint8Array(0);
  let start = 0;
  let end = 0;
  let seen = 0;
  let best: { depth: number; name: string; body: Uint8Array; rival: boolean } | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        seen += value.byteLength;
        if (seen > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that archive is larger than a plugin may be" };
        if (end + value.byteLength > held.byteLength) {
          const live = end - start;
          if (start >= live && live + value.byteLength <= held.byteLength) {
            held.copyWithin(0, start, end);
          } else {
            let capacity = held.byteLength === 0 ? TAR_BLOCK : held.byteLength * 2;
            while (capacity < live + value.byteLength) capacity *= 2;
            const grown = new Uint8Array(capacity);
            grown.set(held.subarray(start, end), 0);
            held = grown;
          }
          end = live;
          start = 0;
        }
        held.set(value, end);
        end += value.byteLength;
      }

      for (;;) {
        if (end - start < TAR_BLOCK) break;
        // The end is an all-zero block, never an empty name: a name of spaces is a member to the daemon.
        if (held.subarray(start, start + TAR_BLOCK).every((byte) => byte === 0)) return finish(best);
        const stem = tarString(held.subarray(start, start + 100));
        const size = tarOctal(held.subarray(start + 124, start + 136));
        if (size === null) {
          return {
            kind: "unreadable",
            reason: "that archive uses a binary size field this screen cannot follow",
          };
        }
        // A negative size would make `padded` 0 and spin this await-free loop forever.
        if (!Number.isSafeInteger(size) || size < 0) {
          return {
            kind: "unreadable",
            reason: "that archive has a member size this screen cannot follow",
          };
        }
        const typeflag = String.fromCharCode(held[start + 156] ?? 0);
        const padded = TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
        if (end - start < padded) break;

        // Spelled as the daemon spells it (ustar prefix); long-name, link and global headers are refused rather than followed.
        if (typeflag === "x" || typeflag === "L" || typeflag === "K" || typeflag === "g") {
          return {
            kind: "unreadable",
            reason: "that archive uses extended tar headers this screen cannot follow",
          };
        }
        const prefix = tarString(held.subarray(start + 345, start + 500));
        const name = prefix.length > 0 ? `${prefix}/${stem}` : stem;

        // `7` (contiguous) counts as a file because the daemon unpacks it as one.
        const spelled = canonical(name) ?? name;
        if ((typeflag === "0" || typeflag === "\0" || typeflag === "7") && isManifestPath(name)) {
          const depth = depthOf(spelled);
          if (best === null || depth < best.depth) {
            // `slice`, never `subarray`: the buffer is compacted in place, so a view would change after it was read.
            best = { depth, name: spelled, body: held.slice(start + TAR_BLOCK, start + TAR_BLOCK + size), rival: false };
          } else if (depth === best.depth) {
            // Any tie is refused: the daemon breaks none, and two members with one canonical path are an O_EXCL clash it refuses.
            best.rival = true;
          }
        }
        start += padded;
        // No early return at depth 0: a later root plugin.json is a tie that must still be seen.
      }

      if (done) return finish(best);
    }
  } finally {
    // Both paths: an early return must not leave the decompressor draining.
    await reader.cancel().catch(() => {
      // Already ended or already errored; there is nothing left to release.
    });
  }
}

async function peekZip(blob: Blob): Promise<ArchivePeek> {
  if (blob.size > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that archive is larger than a plugin may be" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const floor = Math.max(0, bytes.byteLength - (0xffff + 22));
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { kind: "unreadable", reason: "that zip has no central directory" };

  // Walked by signature within the declared `cdSize`, as the daemon does; an entry count that disagrees is refused.
  const declared = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdStart = view.getUint32(eocd + 16, true);
  const cdEnd = Math.min(bytes.byteLength, cdStart + cdSize);
  let at = cdStart;
  let seen = 0;
  let best: { depth: number; name: string; at: number; rival: boolean } | null = null;

  while (at + 46 <= cdEnd && view.getUint32(at, true) === 0x02014b50) {
    seen += 1;
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    // The daemon's read of this record stops at the directory's end, so running past it would read a different name.
    if (at + 46 + nameLen + extraLen + commentLen > cdEnd) {
      return {
        kind: "unreadable",
        reason: "that zip has a directory entry that runs past the directory",
      };
    }
    const raw = utf8(bytes.subarray(at + 46, at + 46 + nameLen));
    const name = canonical(raw) ?? raw;
    if (isManifestPath(raw)) {
      const depth = depthOf(name);
      if (best === null || depth < best.depth) best = { depth, name, at, rival: false };
      else if (depth === best.depth) best.rival = true;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (seen !== declared) {
    return {
      kind: "unreadable",
      reason: "that zip's directory does not hold the number of entries it declares",
    };
  }
  if (best === null) return finish(null);
  // This path skips `finish`, so it makes the tie refusal itself.
  if (best.rival) {
    return { kind: "unreadable", reason: TWO_MANIFESTS };
  }

  const method = view.getUint16(best.at + 10, true);
  const compressed = view.getUint32(best.at + 20, true);
  const uncompressed = view.getUint32(best.at + 24, true);
  const local = view.getUint32(best.at + 42, true);
  // 0xffffffff means the real value is in the zip64 extra field, which this reader refuses rather than decodes.
  if (compressed === 0xffffffff || local === 0xffffffff) {
    return { kind: "unreadable", reason: "that zip uses zip64 fields this screen cannot follow" };
  }
  if (uncompressed > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that plugin.json is implausibly large" };
  if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== 0x04034b50) {
    return { kind: "unreadable", reason: "that zip's entry does not point at a file" };
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const raw = bytes.slice(start, start + compressed);

  if (method === 0) return read(raw);
  if (method !== 8) return { kind: "unreadable", reason: "that zip uses a compression this browser cannot read" };
  // Charged per chunk: the declared uncompressed size bounds nothing against a deflate bomb.
  const inflating = new Blob([raw as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = inflating.getReader();
  let held = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        if (held.byteLength + value.byteLength > MAX_PEEK_BYTES) {
          return { kind: "unreadable", reason: "that plugin.json is implausibly large" };
        }
        held = concat(held, value);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {
      // Already ended or already errored; there is nothing left to release.
    });
  }
  return read(held);
}

function finish(best: { body: Uint8Array; rival: boolean } | null): ArchivePeek {
  if (best === null) return { kind: "unreadable", reason: "that archive has no plugin.json at its top level" };
  if (best.rival) {
    return { kind: "unreadable", reason: TWO_MANIFESTS };
  }
  return read(best.body);
}

function read(body: Uint8Array): ArchivePeek {
  return readManifestText(utf8(body));
}

/** Exported so the market's consent screen reads a bare plugin.json by these same rules. Fails open, never invents. */
export function readManifestText(json: string): ArchivePeek {
  let parsed: unknown;
  try {
    // Named `json` because a `text` parameter would shadow the module's `text` helper.
    parsed = JSON.parse(json);
  } catch {
    return { kind: "unreadable", reason: "that plugin.json is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "unreadable", reason: "that plugin.json is not an object" };
  }
  const source = parsed as Record<string, unknown>;
  const contributes = (source["contributes"] ?? {}) as Record<string, unknown>;
  const screen = (contributes["screen"] ?? null) as Record<string, unknown> | null;

  return {
    kind: "ok",
    manifest: {
      id: text(source["id"]),
      name: text(source["name"]),
      version: text(source["version"]),
      description: typeof source["description"] === "string" ? source["description"] : null,
      scopes: strings(source["scopes"]),
      net: strings(source["net"]),
      screen: screen !== null && typeof screen === "object" ? text(screen["title"]) || null : null,
      settings: contributes["settings"] === true,
      actions: Array.isArray(contributes["actions"])
        ? (contributes["actions"] as unknown[]).flatMap((one) => {
            if (one === null || typeof one !== "object") return [];
            const action = one as Record<string, unknown>;
            return [{ id: text(action["id"]), title: text(action["title"]), on: text(action["on"]) }];
          })
        : [],
      hooks: strings(contributes["hooks"]),
      adds: [
        ...readContributedRows(contributes["harnesses"], (one) => {
          const argv = [text(one["command"]), ...strings(one["args"])].filter((word) => word.length > 0);
          return `harness ${text(one["id"])} runs ${argv.join(" ")}`;
        }),
        ...readContributedRows(contributes["systems"], (one) => {
          return `system ${text(one["id"])} sends keys to ${normalUrl(one["baseUrl"])}`;
        }),
      ],
    },
  };
}

// Normalised as `parseManifest` stores it, so the line shown is the string `consentGap` compares.
function normalUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "nowhere";
  try {
    const url = new URL(raw);
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function readContributedRows(raw: unknown, line: (one: Record<string, unknown>) => string): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((one) => (one === null || typeof one !== "object" ? [] : [line(one as Record<string, unknown>)]));
}

/** The name as the daemon's `safeMemberPath` spells it, or null where the daemon refuses it. Backslashes stay literal. */
function canonical(name: string): string | null {
  const out: string[] = [];
  for (const segment of name.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") return null;
    out.push(segment);
  }
  return out.length === 0 ? null : out.join("/");
}

function isManifestPath(name: string): boolean {
  const clean = canonical(name);
  if (clean === null || isNoise(clean)) return false;
  return clean === "plugin.json" || (clean.endsWith("/plugin.json") && depthOf(clean) <= MAX_MANIFEST_DEPTH);
}

/** Must match the daemon's `isNoiseMember`: counting a member it discards describes a different archive. */
function isNoise(path: string): boolean {
  const segments = path.split("/");
  if (segments[0] === "__MACOSX") return true;
  const leaf = segments.at(-1) ?? "";
  return leaf === ".DS_Store" || leaf === "Thumbs.db" || leaf.startsWith("._");
}

function depthOf(name: string): number {
  return name.replace(/\/+$/, "").split("/").length - 1;
}

/** No trim, as in archive.ts's `tarString`: a name of spaces is a member there, not an end marker. */
function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8(end < 0 ? bytes : bytes.subarray(0, end));
}

/** A transcription of archive.ts's `tarNumber`, or null for GNU base-256, which is refused rather than decoded. */
function tarOctal(bytes: Uint8Array): number | null {
  if (((bytes[0] ?? 0) & 0x80) !== 0) return null;
  let latin1 = "";
  for (const byte of bytes) latin1 += String.fromCharCode(byte);
  const text = latin1.replace(/\0.*$/, "").trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function concat(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  // A fresh buffer, never the chunk: a stream chunk's backing store may be shared.
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
