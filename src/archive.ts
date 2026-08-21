import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflateRaw } from "node:zlib";

import { describeError } from "./http.js";
import { containedIn } from "./paths.js";
import { cancelBody } from "./uploads.js";

/**
 * Taking a codebase off somebody else's machine and putting it on this one.
 *
 * **Every path in an archive is a path somebody else chose**, which is the whole
 * reason this file exists rather than a dozen lines inside `browse.ts`. The rest
 * of this daemon deals in paths a person typed into a picker that only lists what
 * is already here; an archive member is a string a *remote* party wrote, and it is
 * used to create a file. That is the shape of every archive extraction bug ever
 * written, and `paths.ts` says so in as many words: `atOrUnder` "is correct only
 * where the path is **ours** and merely not created yet, and nothing may use it to
 * authorise an action on a path somebody else chose."
 *
 * So containment here is **not** built out of `realpath` comparisons at all. It is
 * built out of refusing, syntactically and before any filesystem call, every
 * member that could name something other than a plain file inside one new
 * directory. {@link safeMemberPath} is that refusal and it is pure — a driver can
 * hold every hostile string ever published against it without a temp directory.
 * What the filesystem half then adds is only `O_EXCL`: nothing here ever opens a
 * path that already exists, so a link planted between the check and the write is
 * an `EEXIST` rather than a write through it.
 *
 * The second property is that **the target is never touched until the whole
 * archive has been read and written successfully.** Extraction goes into a staging
 * directory and arrives by one `rename`, so an import that fails halfway leaves
 * the folder somebody picked exactly as it was. That matters more here than
 * elsewhere: this is the one route that writes into a directory the daemon does
 * not own, where a half-finished write is somebody's project with a hole in it.
 *
 * Two formats, because a person makes one of them by hand. `.tar.gz` is what the
 * export skill produces and is the better archive — headers inline, an explicit
 * type byte per member. `.zip` is what Finder's "Compress" and Windows' "Send to"
 * produce, so refusing it would mean telling somebody their file was wrong when it
 * was the obvious thing to make. They are chosen by magic bytes rather than by
 * filename, because a filename is the least reliable thing in the request.
 */

/**
 * How large the archive itself may be, on the wire.
 *
 * **Deliberately not `MAX_UPLOAD_BYTES`.** That constant's own comment places 25
 * MiB "above any screenshot, below anything that is a transfer rather than an
 * attachment" — and this is the transfer it was drawing a line under. A source
 * tree with no history and no dependencies is a few MiB for almost every project;
 * 50 MiB is the number at which somebody is shipping build output they did not
 * mean to, and the message says so.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * How large it may become once unpacked.
 *
 * A separate bound because compression is the attack: a few hundred KiB of zeros
 * inflates to gigabytes, and a member's *declared* size is written by the same
 * person who wrote the member. This is charged against bytes actually produced by
 * the decompressor, which is the only number that cannot be lied about.
 *
 * 10:1 against the wire bound. Source text gzips at roughly 4:1, so this is
 * generous for anything real and still three orders of magnitude below what a
 * bomb is built to achieve.
 */
export const MAX_IMPORT_UNPACKED_BYTES = 500 * 1024 * 1024;

/**
 * How many members it may have.
 *
 * Bytes cannot see this, which is the same argument `MAX_UPLOADS_PER_SESSION`
 * makes one file over: a hundred thousand empty files is nothing in bytes and is
 * a hundred thousand inodes. A source tree without `node_modules` is rarely past
 * five thousand.
 */
export const MAX_IMPORT_ENTRIES = 20_000;

/** How long one member's path may be. Well past any real one; a bound, not a rule. */
export const MAX_IMPORT_PATH_CHARS = 1024;

/** How deep one member may nest. */
export const MAX_IMPORT_DEPTH = 64;

/**
 * How large a tar extended header (pax `x`, GNU `L`) may be.
 *
 * The only member body this reader buffers whole, so the only one whose declared
 * size becomes an allocation. What it carries is a path, so the bound is
 * {@link MAX_IMPORT_PATH_CHARS} with generous room for the record framing around
 * it — a header past this is not a long name, it is a number chosen to be large.
 */
export const MAX_TAR_HEADER_BYTES = 64 * 1024;

/**
 * How large the zip central directory may be.
 *
 * The one structure read whole into memory, so it needs its own ceiling: it is
 * sized by the *archive*, not by our entry cap, and a file claiming four million
 * entries would otherwise allocate before anything counted them.
 */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** The largest zip trailer, being the 22-byte EOCD plus the largest comment. */
const MAX_EOCD_SEARCH_BYTES = 22 + 0xffff;

export type ArchiveKind = "zip" | "tgz";

/**
 * Which reader, decided by the first bytes and never by the filename.
 *
 * `PK\x05\x06` and `PK\x07\x08` are a zip too — an empty one and a spanned one —
 * and both are deliberately absent: neither can carry a project, and answering
 * "unsupported" for them is better than a reader that has to explain itself.
 */
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

/**
 * Whether a member names a plain thing inside the new folder, and what it names.
 *
 * **Purely syntactic, and that is the point.** It touches no filesystem, so it is
 * total over every string and a driver can assert it directly; and it runs before
 * anything is created, so the decision is made while there is still nothing to
 * undo. Both readers go through this one function, so zip and tar cannot drift
 * into disagreeing about what is safe.
 *
 * The order matters in one place: the `..` test comes before any joining. A
 * member reading `a/../../x` is **refused rather than resolved**, because
 * resolving it answers a question nobody asked — the archive did not request `x`,
 * it probed for whether this code normalises. Normalising is how every surviving
 * zip-slip works: the check runs on the pretty form and the write runs on the raw
 * one. There is no pretty form here.
 */
export function safeMemberPath(raw: string): MemberPath {
  if (raw.length > MAX_IMPORT_PATH_CHARS) return { ok: false, reason: "path_too_long" };

  // NUL first: every layer below this is C, and a name carrying one is a name
  // that means two different things depending on who reads it.
  for (const unit of raw) {
    const code = unit.codePointAt(0) ?? 0;
    if (code === 0 || code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return { ok: false, reason: "control_char" };
    }
  }

  // Never translated to `/`. A member path is POSIX or it is refused: a zip
  // written on Windows can carry either, and guessing which separator was meant
  // is guessing what the string says.
  if (raw.includes("\\")) return { ok: false, reason: "backslash" };

  if (raw.startsWith("/")) return { ok: false, reason: "absolute_path" };
  // `C:` and `C:/`. Refused as absolute rather than as a name containing a colon,
  // because a colon is legal in a POSIX filename and this is about the prefix.
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, reason: "absolute_path" };

  const dir = raw.endsWith("/");
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "escapes_root" };
    /*
     * `.git` is refused, and it is the one refusal here that is about this
     * product rather than about archives.
     *
     * The daemon runs `git worktree add` on the directory somebody picks, and
     * `git.ts` deletes `GIT_NO_EXEC_CONFIG` on purpose so that a repository's own
     * `post-checkout` and its LFS smudge filters run — as this user. That is a
     * stated decision and it is the right one for a repository *you* cloned. An
     * imported `.git` is not that: it would make "upload a file" mean "the daemon
     * executes what was in that file", with no agent in between and nobody
     * watching, which is the one shape every other path here avoids.
     *
     * Nothing legitimate is lost. The export skill excludes `.git` anyway, and
     * somebody who wants history asks the agent to clone it, which is the
     * existing path and is on screen while it happens.
     */
    /*
     * ⚠ **Case-folded, because the filesystem this runs on is.** The exact-case
     * comparison this replaced was measured passing `.GIT/config` straight
     * through on APFS — where `.GIT` is then reachable as `.git`, `git rev-parse
     * --git-dir` answers `.git`, and `changes.ts`'s own `git status` executes a
     * `core.fsmonitor` out of the imported config. One letter defeated the whole
     * refusal, and the same is true on NTFS.
     */
    if (segment.toLowerCase() === ".git") return { ok: false, reason: "git_directory" };
    segments.push(segment);
  }

  if (segments.length === 0) return { ok: false, reason: "escapes_root" };
  if (segments.length > MAX_IMPORT_DEPTH) return { ok: false, reason: "too_deep" };

  return { ok: true, path: segments.join("/"), dir };
}

/**
 * Whether a member names the archive's own root rather than anything inside it.
 *
 * **`tar -czf x.tar.gz .` writes `./` as its first member**, and that is one of
 * the two ordinary ways a person makes an archive of a directory. It was refused,
 * and the whole archive with it: `safeMemberPath` drops `.` segments, finds
 * nothing left, and answers `escapes_root` — the same verdict it gives
 * `a/../../x`. So the most common honest archive there is came back carrying the
 * message written for a traversal attempt, with nothing imported and no way to
 * tell from the error that the archive was fine.
 *
 * A **skip** rather than a refusal, because there is genuinely nothing to do: the
 * member names the directory being extracted into, which already exists. Same
 * shape as {@link isNoiseMember}, and deliberately beside it.
 *
 * ⚠ **Checked before `safeMemberPath`, and it may not become a hole.** It answers
 * `true` only for a name built entirely from `.` and separators, and no such name
 * can address anything — so skipping one creates nothing, whatever its length. A
 * `..` anywhere makes it `false`: `".."`, `"./.."` and `"a/.."` all fall through
 * to the refusal that was always theirs, and so does any name carrying a real
 * segment or a control character.
 *
 * Measured on both writers: bsdtar emits `./`, while Info-ZIP normalises the
 * prefix away before writing its central directory, so `zip -r x.zip .` never had
 * this problem. The check is wired into both readers regardless, because which of
 * them can produce the member is a fact about today's tools rather than a rule.
 */
export function isArchiveRoot(raw: string): boolean {
  return raw.split("/").every((segment) => segment.length === 0 || segment === ".");
}

/**
 * Members that are noise rather than content, skipped without comment.
 *
 * Not a safety rule — a correctness one, and it is load-bearing for the
 * single-root rule below. Finder's "Compress" writes a parallel `__MACOSX/` tree
 * of AppleDouble resource forks beside the folder you compressed, so *every* zip
 * made on a Mac has two top-level directories. Refusing those archives as
 * ambiguously shaped would be refusing the most likely archive there is.
 */
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

/* ------------------------------------------------------------------ *
 * Writing members out
 *
 * Shared by both readers, so that the two formats cannot come to disagree about
 * how a file reaches disk. Everything below writes only inside a directory this
 * daemon created moments earlier, which is what lets these calls be ordinary:
 * the rule about bounding filesystem calls is about paths somebody else named,
 * and by this point every path has been through `safeMemberPath` and is rooted
 * in a staging directory with a random name.
 * ------------------------------------------------------------------ */

/** What has been produced so far, against what may be. */
class Budget {
  entries = 0;
  /** Bytes that reached a file. What the import reports, and never a bound. */
  bytes = 0;
  /** Everything a decompressor emitted, header bodies and padding included. What is bounded. */
  produced = 0;

  countEntry(): void {
    this.entries += 1;
    if (this.entries > MAX_IMPORT_ENTRIES) {
      throw new ArchiveError("too_many", `an archive may not hold more than ${MAX_IMPORT_ENTRIES} files`);
    }
  }

  /**
   * Charge bytes a decompressor produced, whether or not any of them reach a file.
   *
   * ⚠ **The ceiling is charged here and nowhere else**, and the distinction from
   * {@link countWritten} is the whole guard rather than bookkeeping. Charging only
   * bytes on their way into a file left every other consumer of the tar stream
   * free: a pax or GNU long-name header body, a skipped `g` header, a refused
   * member's drain, and block padding. Measured, that was not a small gap — a 204
   * KiB archive declaring one 200 MiB pax header drove 2.2 GB of resident memory
   * and three minutes of synchronous `Buffer.concat` on the one event loop that
   * owns every session, and finished by reporting the archive *empty*, because
   * `bytes` had never been touched.
   */
  countProduced(n: number): void {
    this.produced += n;
    if (this.produced > MAX_IMPORT_UNPACKED_BYTES) {
      throw new ArchiveError("too_large", `an archive may not unpack to more than ${MAX_IMPORT_UNPACKED_BYTES} bytes`);
    }
  }

  /**
   * Charge bytes on their way into a file, which is the number the import reports.
   *
   * No ceiling of its own: everything counted here has already been charged
   * against {@link countProduced}, and a second bound on a subset of the same
   * bytes would only be a second place to get the arithmetic wrong.
   */
  countWritten(n: number): void {
    this.bytes += n;
  }
}

/**
 * A pass-through that charges the budget as bytes actually appear.
 *
 * **Charged here rather than from the header, which is the whole guard.** A zip
 * member declares its uncompressed size and a tar member declares its length, and
 * in both cases the declaration was written by whoever built the archive. Only
 * the decompressor's own output is a number nobody else chose.
 *
 * `written` because the two formats attach this at different heights. In zip it
 * sits inside one member's own pipeline, so everything through it is that
 * member's content and counts as both produced and written. In tar it sits on the
 * whole gunzip stream — above the header parsing, which is the only place it can
 * see a header body at all — so what passes through it is produced, and
 * `extractTgz` says separately which of it landed in a file.
 */
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

/** Create every level of `rel` under `root`, once each. */
async function ensureDir(root: string, rel: string, made: Set<string>): Promise<void> {
  const segments = rel.split("/").filter((s) => s.length > 0);
  let here = root;
  for (const segment of segments) {
    here = join(here, segment);
    if (made.has(here)) continue;
    // `recursive` is deliberately absent: each level is created explicitly so an
    // EEXIST is visible rather than absorbed. Ours to begin with, so the only
    // EEXIST possible is a directory this same import already made — which the
    // memo above has usually already answered.
    await mkdir(here, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    });
    made.add(here);
  }
}

/**
 * Write one member, from a stream, refusing to overwrite anything.
 *
 * `"wx"` is `O_CREAT | O_EXCL`, which is the same flag `Uploads.receive` opens
 * with and is doing the same job twice over: it never follows a symlink and never
 * truncates, so a member that collides with something already there — including a
 * link an earlier member somehow planted — fails rather than writes through it.
 */
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
      // Already closed by the stream on the happy path; a second close is an
      // EBADF that says nothing.
    });
  }
}

/* ------------------------------------------------------------------ *
 * zip
 *
 * Read from the **central directory** and from nowhere else. A zip states every
 * member twice — once in a local header beside the data, once in the index at the
 * end — and the two are allowed to disagree because nothing checks them against
 * each other. Every extractor that has ever been walked past a check was walked
 * past it by validating one copy and reading the other, so the local header is
 * consulted for exactly one thing: how long its own name and extra fields are,
 * which is the only way to know where the data starts.
 * ------------------------------------------------------------------ */

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

/**
 * One member's compressed bytes, as a stream, without attaching to the handle.
 *
 * `handle.createReadStream` would be the obvious thing and is the wrong one here:
 * every call registers a `close` listener on the shared `FileHandle`, so a zip of
 * twenty thousand members registers twenty thousand of them. Node says so at
 * eleven — `MaxListenersExceededWarning`, which is how this was found — and the
 * warning is the least of it, since none of them is released until the whole
 * import is over. Reading positionally has no such bookkeeping.
 *
 * The chunk buffer is reused and therefore copied on the way out: a consumer that
 * holds a chunk past the next `read` would otherwise see it change underneath.
 */
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

/**
 * The zip64 extra field, read positionally.
 *
 * Its members are present **only** when the corresponding 32-bit field is
 * saturated, and always in this order, so the cursor advances by whichever ones
 * were actually needed. Reading it as fixed-offset is the classic way to get a
 * garbage offset out of a valid archive.
 */
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

    const nameBytes = central.subarray(at + 46, at + 46 + nameLength);
    const extra = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    at += 46 + nameLength + extraLength + commentLength;

    // Read before the cursor moved, never by subtracting it back: the zip64 extra
    // is positional, so which fields it holds depends on which of these three were
    // saturated, and recovering that from an advanced offset is one field-length
    // change away from reading the wrong number.
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const wide = readZip64Extra(extra, {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localOffset === 0xffffffff,
      });
      if (wide.compressedSize !== undefined) compressedSize = wide.compressedSize;
      if (wide.localOffset !== undefined) localOffset = wide.localOffset;
    }

    // Bit 0 is encryption. Refused rather than attempted, because the alternative
    // is writing a file full of ciphertext and calling the import a success.
    if ((flags & 0x0001) !== 0) {
      throw new ArchiveError("unsafe", "this zip is encrypted", {
        reason: "encrypted",
        entry: nameBytes.toString("latin1"),
      });
    }

    /*
     * Bit 11 says the name is UTF-8. Without it the name is CP437, and it is
     * **refused** rather than decoded as UTF-8 anyway.
     *
     * Guessing an encoding for a string that is about to become a path is how a
     * check passes on one string while a file is created at another: the bytes
     * that fail to decode become U+FFFD, several distinct names collapse onto one,
     * and the collision is silent. Pure ASCII is the same in both, so this only
     * ever refuses a genuinely ambiguous name.
     */
    const utf8 = (flags & 0x0800) !== 0;
    if (!utf8 && nameBytes.some((byte) => byte >= 0x80)) {
      throw new ArchiveError("unsafe", "this zip has a member whose name is not UTF-8", {
        reason: "unsupported_name_encoding",
        entry: nameBytes.toString("latin1"),
      });
    }
    const rawName = nameBytes.toString("utf8");

    // The archive's own root names nothing to create. Before the refusal, because
    // to that one it looks like a member that resolved to nothing — see
    // `isArchiveRoot`.
    if (isArchiveRoot(rawName)) continue;

    const safe = safeMemberPath(rawName);
    if (!safe.ok) {
      throw new ArchiveError("unsafe", `this archive has a member this daemon will not write`, {
        reason: safe.reason,
        entry: rawName,
      });
    }
    if (isNoiseMember(safe.path)) continue;

    // The high byte of "version made by" is the host system; 3 is UNIX, and only
    // then do the top 16 bits of the external attributes hold a st_mode.
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

/** Where a member's bytes actually start, which only its local header knows. */
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
    // An empty member has no bytes at all, and a read stream over an empty range
    // is a stream that never ends on some platforms.
    const source = readRange(handle, start, member.compressedSize);
    await writeMember(root, member.path, made, budget, source, member.method === 8);
  }
}

/* ------------------------------------------------------------------ *
 * tar.gz
 *
 * Sequential, which makes it the better of the two formats for this job: a
 * member's type is one byte in a header that sits immediately before its data,
 * so there is no second copy of anything to disagree with.
 *
 * The complication is entirely pax. macOS ships bsdtar, which writes an extended
 * header ahead of members whose metadata does not fit the 1979 layout — long
 * paths above all — and does so routinely rather than rarely. An extractor that
 * refuses type `x` therefore refuses most archives made on a Mac, which is most
 * archives. So `x` and GNU's older `L` are both read, for the one field that
 * matters here: what the next member is actually called.
 * ------------------------------------------------------------------ */

const TAR_BLOCK = 512;

/** A pull reader over the gunzip stream. */
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

/**
 * A numeric header field.
 *
 * Octal in a NUL- or space-terminated field, except that GNU writes sizes above
 * 8 GiB as base-256 with the top bit of the first byte set. The second form is
 * rare and cheap to read, and mistaking it for octal produces a plausible small
 * number rather than an error.
 */
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

/**
 * The `path` record of a pax extended header.
 *
 * Records are `<length> <key>=<value>\n`, where the length counts itself. Only
 * `path` is read; everything else in there is ownership, timestamps and Mac
 * resource-fork bookkeeping, none of which this import applies.
 */
function paxPath(block: Buffer): string | null {
  let at = 0;
  const text = block.toString("utf8");
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isFinite(length) || length <= 0 || at + length > text.length) break;
    const record = text.slice(space + 1, at + length).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") return record.slice(equals + 1);
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
    // Two of these end the archive; one is enough to stop reading. A run of zeros
    // is also what a truncated stream looks like, and stopping is right for both.
    if (header.every((byte) => byte === 0)) break;

    const size = tarNumber(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] ?? 0);
    /*
     * Refused before it is arithmetic. `tarNumber` answers for a field somebody
     * else wrote and is deliberately forgiving — a negative octal parses (`-1`
     * measured), a malformed one truncates to a plausible number (`0000000012x`
     * → 10), and the base-256 form reaches past `Number.MAX_SAFE_INTEGER`. A
     * negative size makes `padding` non-zero and desynchronises the block stream
     * from that member on, so every name after it is read out of the middle of
     * somebody's file.
     */
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
      /*
       * ⚠ **The one member whose body is read whole, so it is the one that needs
       * a ceiling of its own.** Everything else here streams; this is buffered to
       * a single `Buffer` at the size the header declares, and that number was
       * written by whoever built the archive. Unbounded, a 204 KiB archive
       * declaring 200 MiB here was measured at 2.2 GB resident and three minutes
       * of synchronous copying, with the whole daemon — every session, every
       * socket, the tunnel — stopped for the duration.
       *
       * `MAX_IMPORT_PATH_CHARS` is what the body is *for*, so the bound is that
       * plus room for the records around it. A header past this is not a long
       * path, it is a claim about memory.
       */
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

    // Everything but a plain file and a directory. A symlink here is the whole
    // attack — write `x -> /`, then write `x/etc/thing` — and a device node or a
    // fifo is something an archive of somebody's source has no business carrying.
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5" && typeflag !== "7") {
      await skipBody();
      throw new ArchiveError("unsafe", "this archive has a link or a device node in it", {
        reason: "not_a_regular_file",
        entry: name,
      });
    }

    // As in the zip reader, and this is the one that matters: `tar -czf x.tar.gz .`
    // puts `./` first, so without this the very next line refused the archive.
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
        // Written only. The ceiling was charged on the stream above, where the
        // bytes came out of the decompressor — counting again here would charge
        // every file twice and refuse an archive at half the stated bound.
        budget.countWritten(chunk.length);
        await handle.write(chunk);
        left -= chunk.length;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      /*
       * Swallowed only while already unwinding, and the asymmetry with
       * `writeMember` is the point rather than an inconsistency.
       *
       * There, the write stream has already closed the descriptor by the time the
       * `finally` runs, so every close is a second one and an `EBADF` says
       * nothing. Here nothing else closes it, so this call is the *first* — and on
       * a filesystem that reports a deferred write error at close, which is what
       * `ENOSPC` and `EDQUOT` over NFS do, it is the only place that error is ever
       * going to appear. Catching it unconditionally would publish a truncated
       * file inside a `201`.
       *
       * So: while unwinding, the close error is noise hiding the real one — a
       * budget overrun would surface as `import_write_failed` (503) instead of
       * `import_unpacked_too_large` (413). On the way out clean, it *is* the real
       * one and must be allowed to fail the import.
       */
      if (failed) {
        await handle.close().catch(() => {
          // The descriptor died with the write that failed; the error that
          // brought us here is the one worth reporting.
        });
      } else {
        await handle.close();
      }
    }
    if (padding > 0) await reader.exact(padding);
  }
}

/* ------------------------------------------------------------------ *
 * The import itself
 * ------------------------------------------------------------------ */

export interface ImportResult {
  /** The absolute path of the folder that now exists. */
  path: string;
  /** Its name, which the client shows and which the picker walks into. */
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

/**
 * A staging directory this daemon left behind, by the only name it ever gives one.
 *
 * Exact rather than a prefix test, because what this decides is whether something
 * inside somebody's own project may be deleted. `randomBytes(8).toString("hex")`
 * is sixteen hex characters and nothing else ever is.
 */
const STAGING_NAME = /^\.reemoat-import-[0-9a-f]{16}$/;

/**
 * The folder to make when the archive does not name one.
 *
 * Somebody who selects a project's *contents* and compresses those gets an
 * archive whose members sit at the root. Refusing that would be correct and
 * unhelpful, so the archive's own filename becomes the folder, minus whatever
 * extension it was carrying.
 *
 * An allowlist rather than a list of things to strip: this string arrives in a
 * query parameter and becomes a directory name, and the set of characters that
 * are fine in one is small and easy to write down.
 */
export function importFolderName(archiveName: string): string {
  const leaf = basename(archiveName).replace(/\.(tar\.gz|tar\.bz2|tgz|tar|zip)$/i, "");
  return settleFolderName(leaf.trim().replace(/[^A-Za-z0-9._-]/g, "-"));
}

/**
 * The last word on any name this import is about to make a directory out of.
 *
 * **Split out of {@link importFolderName} because the archive names the folder
 * too, and that path had none of this.** When an archive holds exactly one
 * top-level directory it keeps its own name — the ordinary case, somebody
 * compressed a folder — and that name went to `rename` untouched. It is the
 * *more* hostile of the two sources, not the less: the query parameter is at
 * least a string somebody typed, while this one was chosen by whoever built the
 * archive. Measured, `tar -czf x.tar.gz -- -rf` published a folder called `-rf`
 * into somebody's project, where it is argv to every glob an agent expands.
 *
 * What it deliberately does **not** do is apply `importFolderName`'s allowlist.
 * That one narrows a query parameter down to characters that are certainly fine
 * in a directory name; running it over an archive's own folder would rewrite
 * `My Project` to `My-Project` and every non-Latin name to a row of dashes, which
 * is a worse answer than the question deserves. Everything here already came
 * through `safeMemberPath` — no separator, no `..`, no control character, no
 * `.git` — so what is left to settle is the leading `-` that makes a name an
 * option, the empty and dot-only names `rename` would answer strangely, and a
 * length nobody meant.
 *
 * Sliced by code point rather than by UTF-16 unit, so a cap never lands in the
 * middle of a surrogate pair and leaves a lone half in a filename.
 */
export function settleFolderName(name: string): string {
  const trimmed = name.trim().replace(/^-+/, "");
  if (trimmed.length === 0 || trimmed === "." || trimmed === ".." || trimmed.toLowerCase() === ".git") {
    return "imported";
  }
  /*
   * ⚠ **And never this daemon's own staging name**, which is a hazard the sweeper
   * created and only this line closes. `sweepStaleStaging` deletes anything under
   * the target matching {@link STAGING_NAME} and older than an hour, on the
   * reasoning that nothing else ever wears that name. An archive whose top-level
   * folder is called `.reemoat-import-<16 hex>` would make that false: it would be
   * published under its own name, sit there, and be deleted by the next import
   * into the same folder — the daemon removing something it had itself put there
   * and told somebody about.
   */
  if (STAGING_NAME.test(trimmed)) return "imported";
  return [...trimmed].slice(0, 100).join("");
}

/**
 * How long one may sit before it is somebody's litter rather than somebody's import.
 *
 * The route serialises imports and both ends are bounded — 50 MiB in, 500 MiB out
 * — so no honest import is still running an hour later. Generous on purpose: the
 * cost of waiting too long is a directory nobody looks at, and the cost of not
 * waiting long enough is deleting a live import's staging out from under it.
 */
const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * Remove a directory this import created.
 *
 * The third `rm` in this codebase, and guarded like the other two rather than on
 * the strength of having just made it: `lstat` so a link is refused rather than
 * followed, then containment, then the removal. It runs on **every** path
 * including the successful one, which is what keeps a `.reemoat-import-*`
 * directory from being something a person ever has to see.
 */
async function discardStaging(staging: string, target: string): Promise<void> {
  try {
    const info = await lstat(staging);
    if (info.isSymbolicLink()) return;
    if (!containedIn(staging, target)) return;
    await rm(staging, { recursive: true, force: true });
  } catch {
    // Already gone, or never made. Either way there is nothing to remove and
    // nothing a caller could do about it.
  }
}

/**
 * Remove staging directories a previous import did not live to clean up.
 *
 * **`discardStaging` runs in a `finally`, and a `finally` is exactly what an OOM
 * and a `SIGKILL` do not reach** — which is not hypothetical here, since the
 * unbounded extended header this file now refuses was measured taking the whole
 * process past two gigabytes. Every crashed import left an `archive.bin` of up to
 * `MAX_IMPORT_BYTES` plus a half-written `tree/` sitting inside somebody's
 * repository, where it shows up as untracked and gets committed. `Uploads` has a
 * sweeper for the same reason; this had nothing.
 *
 * Swept here, on the way in, rather than on a timer: staging lives inside the
 * *target*, which is an arbitrary directory this daemon learns about only when
 * somebody names it, so there is no set of places a timer could walk. The next
 * import into the same folder is the one moment the path is known again.
 *
 * Three narrowings, because this deletes inside a directory the daemon does not
 * own: the name must be exactly what this code generates, `lstat` must say
 * directory — so a symlink wearing the name is neither followed nor removed — and
 * it must be old enough that no live import could own it. Failure is silent by
 * design; a leftover directory must never be the reason an import is refused.
 */
async function sweepStaleStaging(target: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    // Unreadable, or gone between the caller's resolve and here. The import
    // itself is about to fail on the same directory and say so properly.
    return;
  }

  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const entry of entries) {
    if (!STAGING_NAME.test(entry)) continue;
    const full = join(target, entry);
    try {
      const info = await lstat(full);
      // `lstat`, so a symlink answers `false` here rather than being followed to
      // whatever it points at. Same rule as `discardStaging`, one line over.
      if (!info.isDirectory()) continue;
      if (info.mtimeMs > cutoff) continue;
      if (!containedIn(full, target)) continue;
      await rm(full, { recursive: true, force: true });
    } catch {
      // Removed by something else between the listing and the removal, or not
      // ours to touch. Neither is worth failing an import over.
    }
  }
}

/**
 * Take an archive off the wire and make it a folder.
 *
 * The ordering is the safety, and it is worth reading in one go:
 *
 *   1. A staging directory is made **inside the target**, with a random name.
 *      Everything below it is therefore a path this daemon created, which is what
 *      lets the rest of this function make ordinary filesystem calls — the rule
 *      about bounding them is about paths somebody else named. It sits inside the
 *      target rather than beside the worktree and upload roots for two reasons:
 *      the final `rename` is then within one filesystem by construction, where a
 *      root under `~/.reemoat` would be an `EXDEV` copy for anybody whose projects
 *      live on another volume; and a third remover tree would owe
 *      `scripts/daemon.ts` a proof that it nests with neither of the other two.
 *   2. The body is written out, counted **before** each write, so at most one
 *      over-limit chunk is ever in memory and none of it reaches the disk.
 *   3. The format is decided by the first bytes, never by the filename.
 *   4. Members are written under `tree/`, never into the target.
 *   5. One `rename` publishes the result. **Nothing in the target is touched until
 *      that line**, so an import that fails at any point above leaves the folder
 *      somebody picked exactly as it was.
 *   6. The staging directory goes, on every path.
 */
export async function importArchive(request: ImportRequest): Promise<ImportOutcome> {
  const { target } = request;
  const staging = join(target, `.reemoat-import-${randomBytes(8).toString("hex")}`);

  // Before anything is created, so a folder that has collected litter from a
  // crashed run is cleaned by the next honest import into it rather than by hand.
  await sweepStaleStaging(target);

  try {
    await mkdir(staging, { mode: 0o700 });
  } catch (error) {
    await cancelBody(request.body);
    return { kind: "write_failed", detail: describeError(error) };
  }

  try {
    const archivePath = join(staging, "archive.bin");
    let written = 0;
    let refusal: ImportOutcome | null = null;

    const sink = await open(archivePath, "wx", 0o600);
    try {
      for await (const chunk of request.body) {
        written += chunk.byteLength;
        if (written > MAX_IMPORT_BYTES) {
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
    await mkdir(tree, { mode: 0o700 });
    const budget = new Budget();

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
          // Above the tar parsing rather than inside it, which is the only height
          // that sees a header body. See `Budget.countProduced`.
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

    if (budget.entries === 0) {
      return { kind: "refused", error: new ArchiveError("empty", "there is nothing in this archive") };
    }

    /*
     * What to publish, decided by what was actually written rather than by
     * re-walking the members.
     *
     * One directory and nothing else is the ordinary case — somebody compressed a
     * folder — and it keeps its own name. Anything else means the archive had
     * loose members at its root, and the whole `tree` becomes the folder under the
     * archive's filename. Both are a single `rename`.
     */
    const top = await readdir(tree, { withFileTypes: true });
    const only = top.length === 1 && top[0]?.isDirectory() === true ? top[0].name : null;
    // Both sources through the same last word. `only` is the archive's own choice
    // and used to reach `rename` untouched — see `settleFolderName` for what that
    // let an archive publish into somebody's project.
    const name = only === null ? importFolderName(request.name) : settleFolderName(only);
    const from = only === null ? tree : join(tree, only);
    const to = join(target, name);

    /*
     * Asked before the rename, and the answer is refusal for **anything** already
     * at that name.
     *
     * `rename(2)` is not uniform here and the exceptions run the wrong way:
     * measured on macOS, a destination that is a file or a symlink fails
     * `ENOTDIR`, a non-empty directory fails `ENOTEMPTY`, and an **empty
     * directory succeeds** — implicitly `rmdir`ing it. That last one loses no
     * data, but it is a removal of a directory this daemon did not create, which
     * is precisely the thing it is not allowed to decide to do. So the question is
     * asked once, plainly, and every kind of answer is the same refusal.
     *
     * `lstat` rather than `stat`, so a dangling link is still "something is
     * there". The race between this and the rename is left to the mapping below,
     * which is the backstop rather than the rule.
     */
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

    return { kind: "ok", result: { path: to, name, entries: budget.entries, bytes: budget.bytes } };
  } catch (error) {
    if (error instanceof ArchiveError) return { kind: "refused", error };
    return { kind: "write_failed", detail: describeError(error) };
  } finally {
    // Both on every path. The body because a refusal that stops reading parks the
    // sender against the relay's window and takes the machine's whole tunnel down
    // with it; the staging directory because it is inside somebody's own folder.
    await cancelBody(request.body);
    await discardStaging(staging, target);
  }
}
