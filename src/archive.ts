import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflateRaw } from "node:zlib";

import { describeError } from "./http.js";
import { containedIn } from "./paths.js";
import { cancelBody } from "./uploads.js";

// Every member path is somebody else's: containment is syntactic (safeMemberPath) plus O_EXCL,
// and the target is untouched until one rename publishes the result.

/** A transfer rather than an attachment, so deliberately not MAX_UPLOAD_BYTES. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Charged against bytes the decompressor produced, never against a member's declared size. */
export const MAX_IMPORT_UNPACKED_BYTES = 500 * 1024 * 1024;

export const MAX_IMPORT_ENTRIES = 20_000;

export const MAX_IMPORT_PATH_CHARS = 1024;

export const MAX_IMPORT_DEPTH = 64;

/** The only member body buffered whole, so its declared size needs its own ceiling. */
export const MAX_TAR_HEADER_BYTES = 64 * 1024;

/** Read whole into memory and sized by the archive, so it needs its own ceiling. */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** The largest zip trailer, being the 22-byte EOCD plus the largest comment. */
const MAX_EOCD_SEARCH_BYTES = 22 + 0xffff;

/** Per caller. safeMemberPath's rules are deliberately not parameterised. */
export interface ArchiveLimits {
  /** Bytes on the wire. Charged before each write, so no over-limit chunk lands. */
  maxBytes: number;
  /** Bytes the decompressor may produce, files and header bodies alike. */
  maxUnpackedBytes: number;
  maxEntries: number;
}

export const IMPORT_LIMITS: ArchiveLimits = {
  maxBytes: MAX_IMPORT_BYTES,
  maxUnpackedBytes: MAX_IMPORT_UNPACKED_BYTES,
  maxEntries: MAX_IMPORT_ENTRIES,
};

export const PLUGIN_LIMITS: ArchiveLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxUnpackedBytes: 8 * 1024 * 1024,
  maxEntries: 500,
};

export type ArchiveKind = "zip" | "tgz";

/** Decided by magic bytes, never by filename. */
export function sniffArchive(head: Buffer): ArchiveKind | null {
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return "zip";
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "tgz";
  return null;
}

export type ArchiveRefusal =
  | "absolute_path"
  | "escapes_root"
  | "control_char"
  | "backslash"
  | "not_a_regular_file"
  | "git_directory"
  | "encrypted"
  | "unsupported_method"
  | "unsupported_name_encoding"
  | "too_deep"
  | "path_too_long";

export type MemberPath =
  | { ok: true; path: string; dir: boolean }
  | { ok: false; reason: ArchiveRefusal };

/** Purely syntactic and shared by both readers; .. is refused, never normalised. */
export function safeMemberPath(raw: string): MemberPath {
  if (raw.length > MAX_IMPORT_PATH_CHARS) return { ok: false, reason: "path_too_long" };

  for (const unit of raw) {
    const code = unit.codePointAt(0) ?? 0;
    if (code === 0 || code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return { ok: false, reason: "control_char" };
    }
  }

  // Never translated to a slash: a member path is POSIX or it is refused.
  if (raw.includes("\\")) return { ok: false, reason: "backslash" };

  if (raw.startsWith("/")) return { ok: false, reason: "absolute_path" };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, reason: "absolute_path" };

  const dir = raw.endsWith("/");
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "escapes_root" };
    // .git is refused: its hooks and config would run as this user once the daemon uses the folder.
    // Case-folded: .GIT is .git on APFS and NTFS.
    if (segment.toLowerCase() === ".git") return { ok: false, reason: "git_directory" };
    segments.push(segment);
  }

  if (segments.length === 0) return { ok: false, reason: "escapes_root" };
  if (segments.length > MAX_IMPORT_DEPTH) return { ok: false, reason: "too_deep" };

  return { ok: true, path: segments.join("/"), dir };
}

/** Only names built from dots and slashes, which address nothing (tar of . writes ./ first); any .. still falls through to the refusal. */
export function isArchiveRoot(raw: string): boolean {
  return raw.split("/").every((segment) => segment.length === 0 || segment === ".");
}

/** Skipped silently: Finder zips carry a parallel __MACOSX tree that would break the single-root rule. */
export function isNoiseMember(path: string): boolean {
  const segments = path.split("/");
  if (segments[0] === "__MACOSX") return true;
  const leaf = segments.at(-1) ?? "";
  return leaf === ".DS_Store" || leaf === "Thumbs.db" || leaf.startsWith("._");
}

export type ArchiveErrorCode = "unreadable" | "unsafe" | "shape" | "empty" | "too_large" | "too_many";

export class ArchiveError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
    /** The refusal, and the member it was about. Only set for `unsafe`. */
    readonly refusal: { reason: ArchiveRefusal; entry: string } | null = null,
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

class Budget {
  constructor(private readonly limits: ArchiveLimits) {}

  entries = 0;
  /** Bytes that reached a file. What the import reports, and never a bound. */
  bytes = 0;
  /** Everything a decompressor emitted, header bodies and padding included. What is bounded. */
  produced = 0;

  countEntry(): void {
    this.entries += 1;
    if (this.entries > this.limits.maxEntries) {
      throw new ArchiveError("too_many", `an archive may not hold more than ${this.limits.maxEntries} files`);
    }
  }

  /** The only ceiling: every byte the decompressor emits counts, header bodies and padding included. */
  countProduced(n: number): void {
    this.produced += n;
    if (this.produced > this.limits.maxUnpackedBytes) {
      throw new ArchiveError("too_large", `an archive may not unpack to more than ${this.limits.maxUnpackedBytes} bytes`);
    }
  }

  countWritten(n: number): void {
    this.bytes += n;
  }
}

/** Charged on actual output, never declared sizes; written says whether the bytes land in a file at this height. */
function counting(budget: Budget, written: boolean): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done): void {
      try {
        budget.countProduced(chunk.length);
        if (written) budget.countWritten(chunk.length);
      } catch (error) {
        done(error as Error);
        return;
      }
      done(null, chunk);
    },
  });
}

async function ensureDir(root: string, rel: string, made: Set<string>): Promise<void> {
  const segments = rel.split("/").filter((s) => s.length > 0);
  let here = root;
  for (const segment of segments) {
    here = join(here, segment);
    if (made.has(here)) continue;
    await mkdir(here, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    });
    made.add(here);
  }
}

/** wx is O_CREAT plus O_EXCL: never follows a symlink and never truncates. */
async function writeMember(
  root: string,
  rel: string,
  made: Set<string>,
  budget: Budget,
  source: Readable,
  inflate: boolean,
): Promise<void> {
  const slash = rel.lastIndexOf("/");
  if (slash > 0) await ensureDir(root, rel.slice(0, slash), made);
  budget.countEntry();

  const full = join(root, rel);
  const handle = await open(full, "wx", 0o600);
  try {
    const stages: (Readable | Transform | Writable)[] = [source];
    if (inflate) stages.push(createInflateRaw());
    stages.push(counting(budget, true));
    stages.push(handle.createWriteStream());
    await pipeline(stages as [Readable, ...Writable[]]);
  } finally {
    await handle.close().catch(() => {
      // Already closed by the stream; a second close is an EBADF.
    });
  }
}

// zip: read from the central directory only; the local header is used just to find where the data starts.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

interface ZipDirectory {
  offset: number;
  size: number;
  entries: number;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** Positional reads, because createReadStream leaves a close listener per member on the shared handle. */
function readRange(handle: FileHandle, start: number, length: number): Readable {
  return Readable.from(
    (async function* () {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let at = start;
      let left = length;
      while (left > 0) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, left), at);
        if (bytesRead === 0) return;
        yield Buffer.from(buffer.subarray(0, bytesRead));
        at += bytesRead;
        left -= bytesRead;
      }
    })(),
  );
}

/** Locate the index, following the zip64 trailer when the 32-bit fields are saturated. */
async function locateCentralDirectory(handle: FileHandle, size: number): Promise<ZipDirectory> {
  const span = Math.min(size, MAX_EOCD_SEARCH_BYTES);
  const tail = await readAt(handle, size - span, span);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("unreadable", "this does not look like a zip file");

  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  const saturated = entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (saturated) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) {
      throw new ArchiveError("unreadable", "this zip needs a zip64 index and does not have one");
    }
    const at = Number(tail.readBigUInt64LE(locator + 8));
    const record = await readAt(handle, at, 56);
    if (record.length < 56 || record.readUInt32LE(0) !== SIG_EOCD64) {
      throw new ArchiveError("unreadable", "this zip's zip64 index is unreadable");
    }
    entries = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }

  if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new ArchiveError("too_many", "this zip's index is larger than this daemon will read");
  }
  if (cdOffset + cdSize > size) throw new ArchiveError("unreadable", "this zip is truncated");
  return { offset: cdOffset, size: cdSize, entries };
}

interface ZipMember {
  path: string;
  dir: boolean;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** Fields are present only when the matching 32-bit field is saturated, in order, so it is read positionally. */
function readZip64Extra(
  extra: Buffer,
  need: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { compressedSize?: number; localOffset?: number } {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + size);
    if (id === 0x0001) {
      let cursor = 0;
      const out: { compressedSize?: number; localOffset?: number } = {};
      if (need.uncompressed && cursor + 8 <= body.length) cursor += 8;
      if (need.compressed && cursor + 8 <= body.length) {
        out.compressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (need.offset && cursor + 8 <= body.length) {
        out.localOffset = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      return out;
    }
    at += 4 + size;
  }
  return {};
}

function readZipMembers(central: Buffer): ZipMember[] {
  const members: ZipMember[] = [];
  let at = 0;
  while (at + 46 <= central.length) {
    if (central.readUInt32LE(at) !== SIG_CENTRAL) break;

    const madeBy = central.readUInt16LE(at + 4);
    const flags = central.readUInt16LE(at + 8);
    const method = central.readUInt16LE(at + 10);
    let compressedSize = central.readUInt32LE(at + 20);
    const uncompressedSize = central.readUInt32LE(at + 24);
    const nameLength = central.readUInt16LE(at + 28);
    const extraLength = central.readUInt16LE(at + 30);
    const commentLength = central.readUInt16LE(at + 32);
    const externalAttributes = central.readUInt32LE(at + 38);
    let localOffset = central.readUInt32LE(at + 42);

    // Refused, not clamped: a clamped name let the browser and the daemon read different members.
    if (at + 46 + nameLength + extraLength + commentLength > central.length) {
      throw new ArchiveError("unreadable", "that zip has a directory entry that runs past the directory");
    }

    const nameBytes = central.subarray(at + 46, at + 46 + nameLength);
    const extra = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const wide = readZip64Extra(extra, {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localOffset === 0xffffffff,
      });
      if (wide.compressedSize !== undefined) compressedSize = wide.compressedSize;
      if (wide.localOffset !== undefined) localOffset = wide.localOffset;
    }

    if ((flags & 0x0001) !== 0) {
      throw new ArchiveError("unsafe", "this zip is encrypted", {
        reason: "encrypted",
        entry: nameBytes.toString("latin1"),
      });
    }

    // A non-UTF-8 name is refused, never guessed: a guessed decoding can collapse distinct names.
    const utf8 = (flags & 0x0800) !== 0;
    if (!utf8 && nameBytes.some((byte) => byte >= 0x80)) {
      throw new ArchiveError("unsafe", "this zip has a member whose name is not UTF-8", {
        reason: "unsupported_name_encoding",
        entry: nameBytes.toString("latin1"),
      });
    }
    const rawName = nameBytes.toString("utf8");

    // The archive root names nothing; checked before safeMemberPath, which would refuse it.
    if (isArchiveRoot(rawName)) continue;

    const safe = safeMemberPath(rawName);
    if (!safe.ok) {
      throw new ArchiveError("unsafe", `this archive has a member this daemon will not write`, {
        reason: safe.reason,
        entry: rawName,
      });
    }
    if (isNoiseMember(safe.path)) continue;

    // Host system 3 is UNIX; only then do the top 16 external-attribute bits hold st_mode.
    const unixMode = (madeBy >> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if ((unixMode & S_IFMT) === S_IFLNK) {
      throw new ArchiveError("unsafe", "this archive has a symbolic link in it", {
        reason: "not_a_regular_file",
        entry: rawName,
      });
    }
    const dir = safe.dir || (unixMode & S_IFMT) === S_IFDIR;

    if (!dir && method !== 0 && method !== 8) {
      throw new ArchiveError("unsafe", `this archive uses a compression this daemon does not read`, {
        reason: "unsupported_method",
        entry: rawName,
      });
    }

    members.push({ path: safe.path, dir, method, compressedSize, localOffset });
  }
  return members;
}

async function zipDataOffset(handle: FileHandle, localOffset: number): Promise<number> {
  const header = await readAt(handle, localOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL) {
    throw new ArchiveError("unreadable", "this zip's index points at something that is not a member");
  }
  return localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

async function extractZip(handle: FileHandle, size: number, root: string, budget: Budget): Promise<void> {
  const directory = await locateCentralDirectory(handle, size);
  const central = await readAt(handle, directory.offset, directory.size);
  const members = readZipMembers(central);
  const made = new Set<string>();

  for (const member of members) {
    if (member.dir) {
      budget.countEntry();
      await ensureDir(root, member.path, made);
      continue;
    }
    const start = await zipDataOffset(handle, member.localOffset);
    if (start + member.compressedSize > size) {
      throw new ArchiveError("unreadable", "this zip is truncated");
    }
    const source = readRange(handle, start, member.compressedSize);
    await writeMember(root, member.path, made, budget, source, member.method === 8);
  }
}

const TAR_BLOCK = 512;

class BlockReader {
  #iterator: AsyncIterator<Buffer>;
  #pending: Buffer = Buffer.alloc(0);
  #ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #fill(min: number): Promise<void> {
    while (this.#pending.length < min && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done === true) {
        this.#ended = true;
        break;
      }
      this.#pending =
        this.#pending.length === 0 ? next.value : Buffer.concat([this.#pending, next.value]);
    }
  }

  /** Exactly `n` bytes, or `null` if the stream ended first. */
  async exact(n: number): Promise<Buffer | null> {
    await this.#fill(n);
    if (this.#pending.length < n) return null;
    const out = this.#pending.subarray(0, n);
    this.#pending = this.#pending.subarray(n);
    return out;
  }

  /** Whatever is to hand, up to `n`. `null` at end of stream. */
  async some(n: number): Promise<Buffer | null> {
    await this.#fill(1);
    if (this.#pending.length === 0) return null;
    const take = Math.min(n, this.#pending.length);
    const out = this.#pending.subarray(0, take);
    this.#pending = this.#pending.subarray(take);
    return out;
  }
}

/** Octal, or GNU base-256 when the top bit is set; read as octal that form gives a plausible wrong number. */
function tarNumber(field: Buffer): number {
  if (field.length > 0 && (field[0]! & 0x80) !== 0) {
    let value = 0n;
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return Number(value);
  }
  const text = field.toString("latin1").replace(/\0.*$/, "").trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function tarString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function paxPath(block: Buffer): string | null {
  // Walked in bytes, because the record length counts bytes, not UTF-16 units.
  let at = 0;
  while (at < block.length) {
    const space = block.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(block.subarray(at, space).toString("latin1"), 10);
    if (!Number.isFinite(length) || length <= 0 || at + length > block.length) break;
    const body = block.subarray(space + 1, at + length);
    const equals = body.indexOf(0x3d);
    if (equals > 0 && body.subarray(0, equals).toString("latin1") === "path") {
      const end = body.length > 0 && body[body.length - 1] === 0x0a ? body.length - 1 : body.length;
      return body.subarray(equals + 1, end).toString("utf8");
    }
    at += length;
  }
  return null;
}

async function extractTgz(source: AsyncIterable<Buffer>, root: string, budget: Budget): Promise<void> {
  const reader = new BlockReader(source);
  const made = new Set<string>();
  let overrideName: string | null = null;

  for (;;) {
    const header = await reader.exact(TAR_BLOCK);
    if (header === null) break;
    if (header.every((byte) => byte === 0)) break;

    const size = tarNumber(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] ?? 0);
    // Refused before arithmetic: tarNumber is forgiving, and a negative size desynchronises the block stream.
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ArchiveError("unreadable", "this archive has a member whose size is not a number");
    }
    const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;

    const readBody = async (): Promise<Buffer> => {
      const body = await reader.exact(size);
      if (body === null) throw new ArchiveError("unreadable", "this archive is truncated");
      if (padding > 0) await reader.exact(padding);
      return body;
    };
    const skipBody = async (): Promise<void> => {
      let left = size + padding;
      while (left > 0) {
        const chunk = await reader.some(left);
        if (chunk === null) throw new ArchiveError("unreadable", "this archive is truncated");
        left -= chunk.length;
      }
    };

    if (typeflag === "x" || typeflag === "L") {
      // Bounded before the declared size becomes an allocation.
      if (size > MAX_TAR_HEADER_BYTES) {
        throw new ArchiveError("unsafe", "this archive has an extended header this daemon will not read", {
          reason: "path_too_long",
          entry: tarString(header.subarray(0, 100)),
        });
      }
      const body = await readBody();
      overrideName = typeflag === "L" ? tarString(body) : paxPath(body);
      continue;
    }
    if (typeflag === "g" || typeflag === "K") {
      await skipBody();
      continue;
    }

    let name = overrideName;
    overrideName = null;
    if (name === null) {
      const prefix = tarString(header.subarray(345, 500));
      const stem = tarString(header.subarray(0, 100));
      name = prefix.length > 0 ? `${prefix}/${stem}` : stem;
    }

    // Only plain files and directories: a symlink is the whole attack.
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5" && typeflag !== "7") {
      await skipBody();
      throw new ArchiveError("unsafe", "this archive has a link or a device node in it", {
        reason: "not_a_regular_file",
        entry: name,
      });
    }

    if (isArchiveRoot(name)) {
      await skipBody();
      continue;
    }

    const safe = safeMemberPath(name);
    if (!safe.ok) {
      await skipBody();
      throw new ArchiveError("unsafe", "this archive has a member this daemon will not write", {
        reason: safe.reason,
        entry: name,
      });
    }
    if (isNoiseMember(safe.path)) {
      await skipBody();
      continue;
    }

    if (typeflag === "5" || safe.dir) {
      budget.countEntry();
      await ensureDir(root, safe.path, made);
      await skipBody();
      continue;
    }

    const slash = safe.path.lastIndexOf("/");
    if (slash > 0) await ensureDir(root, safe.path.slice(0, slash), made);
    budget.countEntry();

    const handle = await open(join(root, safe.path), "wx", 0o600);
    let failed = false;
    try {
      let left = size;
      while (left > 0) {
        const chunk = await reader.some(left);
        if (chunk === null) throw new ArchiveError("unreadable", "this archive is truncated");
        // Written only: the ceiling was already charged on the decompressed stream.
        budget.countWritten(chunk.length);
        await handle.write(chunk);
        left -= chunk.length;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Swallowed only while unwinding: on a clean exit this close may be the first to report a deferred ENOSPC or EDQUOT.
      if (failed) {
        await handle.close().catch(() => {
          // The error that brought us here is the one worth reporting.
        });
      } else {
        await handle.close();
      }
    }
    if (padding > 0) await reader.exact(padding);
  }
}

export interface ImportResult {
  path: string;
  name: string;
  entries: number;
  bytes: number;
}

export interface ImportRequest {
  /** Where to put it. Absolute, and already through `resolveCwd`. */
  target: string;
  /** The archive's own filename, used only when the archive has no single root. */
  name: string;
  body: ReadableStream<Uint8Array>;
}

export type ImportOutcome =
  | { kind: "ok"; result: ImportResult }
  | { kind: "too_large" }
  | { kind: "unsupported" }
  | { kind: "exists"; name: string }
  | { kind: "refused"; error: ArchiveError }
  | { kind: "write_failed"; detail: string };

/** Exactly the name this code generates, because it decides what may be deleted inside somebody's project. */
const STAGING_NAME = /^\.reemoat-import-[0-9a-f]{16}$/;

/** The archive's filename, narrowed to an allowlist, for an archive with no single root. */
export function importFolderName(archiveName: string): string {
  const leaf = basename(archiveName).replace(/\.(tar\.gz|tar\.bz2|tgz|tar|zip)$/i, "");
  return settleFolderName(leaf.trim().replace(/[^A-Za-z0-9._-]/g, "-"));
}

/** Last word on any folder name: no leading dash, no empty or dot name, no .git, capped by code point. No allowlist, so real names survive. */
export function settleFolderName(name: string): string {
  const trimmed = name.trim().replace(/^-+/, "");
  if (trimmed.length === 0 || trimmed === "." || trimmed === ".." || trimmed.toLowerCase() === ".git") {
    return "imported";
  }
  // Never the staging name, or sweepStaleStaging would later delete the published folder.
  if (STAGING_NAME.test(trimmed)) return "imported";
  return [...trimmed].slice(0, 100).join("");
}

/** Old enough that no live import can own it. */
const STALE_STAGING_MS = 60 * 60 * 1000;

/** lstat, then containment, then rm; runs on every path, success included. */
async function discardStaging(staging: string, target: string): Promise<void> {
  try {
    const info = await lstat(staging);
    if (info.isSymbolicLink()) return;
    if (!containedIn(staging, target)) return;
    await rm(staging, { recursive: true, force: true });
  } catch {
    // Already gone or never made; nothing to remove.
  }
}

/** Staging a crashed import left behind, swept on the next import into the same target; a failure here never refuses the import. */
async function sweepStaleStaging(target: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    return;
  }

  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const entry of entries) {
    if (!STAGING_NAME.test(entry)) continue;
    const full = join(target, entry);
    try {
      const info = await lstat(full);
      // lstat, so a symlink wearing the name is neither followed nor removed.
      if (!info.isDirectory()) continue;
      if (info.mtimeMs > cutoff) continue;
      if (!containedIn(full, target)) continue;
      await rm(full, { recursive: true, force: true });
    } catch {
      // Removed meanwhile, or not ours; never worth failing an import over.
    }
  }
}

/** A union: an unrecognised format or an oversized body is something a person did, not a daemon failure. */
export type UnpackOutcome =
  | { kind: "ok"; tree: string; entries: number; bytes: number }
  | { kind: "too_large" }
  | { kind: "unsupported" }
  | { kind: "empty" }
  | { kind: "refused"; error: ArchiveError }
  | { kind: "write_failed"; detail: string };

export interface UnpackRequest {
  /** A directory this daemon just created; the caller makes and removes it, and places it so the final rename stays on one filesystem. */
  staging: string;
  body: ReadableStream<Uint8Array>;
  limits: ArchiveLimits;
}

/** The containment rules shared by import and plugin install. The caller cancels the body, on every path. */
export async function unpackArchive(request: UnpackRequest): Promise<UnpackOutcome> {
  const { staging, limits } = request;
  const archivePath = join(staging, "archive.bin");
  let written = 0;
  let refusal: UnpackOutcome | null = null;

  const sink = await open(archivePath, "wx", 0o600);
  try {
    for await (const chunk of request.body) {
      written += chunk.byteLength;
      if (written > limits.maxBytes) {
        refusal = { kind: "too_large" };
        break;
      }
      await sink.write(chunk);
    }
  } catch (error) {
    refusal = { kind: "write_failed", detail: describeError(error) };
  } finally {
    await sink.close().catch(() => {
      // Already closed, or the descriptor died with the write that failed.
    });
  }

  if (refusal !== null) return refusal;

  const tree = join(staging, "tree");
  const budget = new Budget(limits);

  try {
    await mkdir(tree, { mode: 0o700 });

    const handle = await open(archivePath, "r");
    try {
      const head = await readAt(handle, 0, 4);
      const kind = sniffArchive(head);
      if (kind === null) return { kind: "unsupported" };
      if (kind === "zip") {
        await extractZip(handle, written, tree, budget);
      } else {
        await pipeline(
          handle.createReadStream({ autoClose: false }),
          createGunzip(),
          // Above the tar parsing, the only height that sees header bodies.
          counting(budget, false),
          async (source) => {
            await extractTgz(source as AsyncIterable<Buffer>, tree, budget);
          },
        );
      }
    } finally {
      await handle.close().catch(() => {
        // As above.
      });
    }
  } catch (error) {
    if (error instanceof ArchiveError) return { kind: "refused", error };
    return { kind: "write_failed", detail: describeError(error) };
  }

  if (budget.entries === 0) return { kind: "empty" };
  return { kind: "ok", tree, entries: budget.entries, bytes: budget.bytes };
}

export async function importArchive(request: ImportRequest): Promise<ImportOutcome> {
  const { target } = request;
  const staging = join(target, `.reemoat-import-${randomBytes(8).toString("hex")}`);

  await sweepStaleStaging(target);

  try {
    await mkdir(staging, { mode: 0o700 });
  } catch (error) {
    await cancelBody(request.body);
    return { kind: "write_failed", detail: describeError(error) };
  }

  try {
    const unpacked = await unpackArchive({ staging, body: request.body, limits: IMPORT_LIMITS });
    if (unpacked.kind === "empty") {
      return { kind: "refused", error: new ArchiveError("empty", "there is nothing in this archive") };
    }
    if (unpacked.kind !== "ok") return unpacked;
    const { tree } = unpacked;

    // One top-level directory keeps its own name; otherwise the whole tree takes the archive's filename.
    const top = await readdir(tree, { withFileTypes: true });
    const only = top.length === 1 && top[0]?.isDirectory() === true ? top[0].name : null;
    // Both sources end in settleFolderName; the archive's own folder name is the more hostile one.
    const name = only === null ? importFolderName(request.name) : settleFolderName(only);
    const from = only === null ? tree : join(tree, only);
    const to = join(target, name);

    // Refuse anything already there: rename silently replaces an empty directory. lstat, so a dangling link counts.
    const occupied = await lstat(to).then(
      () => true,
      () => false,
    );
    if (occupied) return { kind: "exists", name };

    try {
      await rename(from, to);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
        return { kind: "exists", name };
      }
      return { kind: "write_failed", detail: describeError(error) };
    }

    return { kind: "ok", result: { path: to, name, entries: unpacked.entries, bytes: unpacked.bytes } };
  } catch (error) {
    if (error instanceof ArchiveError) return { kind: "refused", error };
    return { kind: "write_failed", detail: describeError(error) };
  } finally {
    // Both on every path: an unread body stalls the tunnel, and staging sits inside somebody's folder.
    await cancelBody(request.body);
    await discardStaging(staging, target);
  }
}
