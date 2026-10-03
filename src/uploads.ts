import { randomBytes } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type * as acp from "@agentclientprotocol/sdk";

import { containedIn, expandHome, resolveStateRoot } from "./paths.js";
import { describeError } from "./http.js";
import {
  DESCRIBE_TIMEOUT_MS,
  noteStalled,
  probeContext,
  probeFile,
  probeRealpath,
  stallKeyFor,
  type ProbeOptions,
  type StallTarget,
} from "./stall.js";

// Bytes live only on this machine (the relay holds nothing: sendNoTunnel answers rather than queues), in a root disjoint from worktrees.

export interface UploadRow {
  sessionId: string;
  uploadId: string;
  /** Sanitized, a single path segment. Never what the client sent. */
  name: string;
  origName: string;
  mime: string | null;
  bytes: number;
  createdAt: number;
  consumedAt: number | null;
}

/** Synchronous; safe to call from ManagedSession.prompt, which must not await. */
export interface UploadIndex {
  insert(row: UploadRow): void;
  get(sessionId: string, uploadId: string): UploadRow | null;
  markConsumed(sessionId: string, uploadIds: readonly string[], at: number): void;
  listFor(sessionId: string): UploadRow[];
  listSessions(): string[];
  expired(createdBefore: number): UploadRow[];
  remove(sessionId: string, uploadId: string): void;
  removeSession(sessionId: string): void;
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** What a session keeps of the files sent to it; past either bound the oldest one already sent goes (Q2.247). */
export const MAX_SESSION_UPLOAD_BYTES = 1024 * 1024 * 1024;

export const MAX_UPLOADS_PER_SESSION = 100;

/** The images an agent returned, kept for the transcript on a budget of their own, oldest first out (Q2.247). */
export const MAX_AGENT_IMAGES_PER_SESSION = 200;

export const MAX_SESSION_AGENT_IMAGE_BYTES = 256 * 1024 * 1024;

const USER_BUDGET = { count: MAX_UPLOADS_PER_SESSION, bytes: MAX_SESSION_UPLOAD_BYTES } as const;

const AGENT_BUDGET = { count: MAX_AGENT_IMAGES_PER_SESSION, bytes: MAX_SESSION_AGENT_IMAGE_BYTES } as const;

/** One file an agent hands its person through send_file. Its own constant: the download route's cap must stay at or above it (Q2.252). */
export const MAX_SENT_FILE_BYTES = 100 * 1024 * 1024;

/** The files an agent sent, kept on a third budget, oldest first out: they evict neither a person's files nor its own screenshots. */
export const MAX_SENT_FILES_PER_SESSION = 100;

export const MAX_SESSION_SENT_FILE_BYTES = 1024 * 1024 * 1024;

const SENT_BUDGET = { count: MAX_SENT_FILES_PER_SESSION, bytes: MAX_SESSION_SENT_FILE_BYTES } as const;

/** For the whole call, its wait behind another included: under the 60 s an MCP client gives one, past which the model has seen it fail. */
export const SENT_FILE_DEADLINE_MS = 45_000;

/** The id's prefix is the row's kind: `u_` for a file somebody sent, `a_` for an image the agent returned, `f_` for a file it sent on purpose. */
const AGENT_IMAGE_PREFIX = "a_";

const SENT_FILE_PREFIX = "f_";

export function isAgentImage(row: UploadRow): boolean {
  return row.uploadId.startsWith(AGENT_IMAGE_PREFIX);
}

export function isSentFile(row: UploadRow): boolean {
  return row.uploadId.startsWith(SENT_FILE_PREFIX);
}

/** A person's own file: the only kind their budget counts and a new upload may evict. */
function isPersonFile(row: UploadRow): boolean {
  return !isAgentImage(row) && !isSentFile(row);
}

export type Room = { ok: true; evict: UploadRow[] } | { ok: false; full: "count" | "bytes" };

/**
 * What one more file of `bytes` costs a budget: the oldest rows already sent, dropped until it fits. A row nobody has
 * sent yet is never dropped, since a draft names it, so a budget those alone fill refuses instead.
 */
export function roomFor(rows: readonly UploadRow[], bytes: number, budget: { count: number; bytes: number }): Room {
  let count = rows.length;
  let total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const fits = (): boolean => count + 1 <= budget.count && total + bytes <= budget.bytes;
  const sent = rows
    .filter((row) => row.consumedAt !== null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.uploadId < b.uploadId ? -1 : a.uploadId > b.uploadId ? 1 : 0));
  const evict: UploadRow[] = [];
  for (const row of sent) {
    if (fits()) break;
    evict.push(row);
    count -= 1;
    total -= row.bytes;
  }
  if (fits()) return { ok: true, evict };
  return { ok: false, full: count + 1 > budget.count ? "count" : "bytes" };
}

const SNIFF_BYTES = 12;

/** An image type read off a file's first bytes, for one that arrived declaring none or only bytes. */
export function sniffImageMime(head: Uint8Array): string | null {
  const at = (offset: number, signature: readonly number[]): boolean =>
    signature.every((byte, i) => head[offset + i] === byte);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

export const MAX_PROMPT_ATTACHMENTS = 10;

export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Separate from MAX_UPLOAD_BYTES: its base64 pre-check runs on the agent's emit path, so raising the upload cap must not raise this. */
export const MAX_AGENT_IMAGE_BYTES = 25 * 1024 * 1024;

/** A cost bound, not a security one: it blocks briefly and never escalates, like the control plane's WRITE_THROTTLE. */
export const UPLOAD_RATE_BYTES = 300 * 1024 * 1024;

export const UPLOAD_RATE_WINDOW_MS = 5 * 60 * 1000;

export interface UploadCharge {
  at: number;
  bytes: number;
}

/** The wait lasts until the oldest entry leaves the window (at least 1ms); a spent budget is refused. */
export function uploadRateVerdict(
  entries: readonly UploadCharge[],
  now: number,
): { kept: UploadCharge[]; waitMs: number } {
  const floor = now - UPLOAD_RATE_WINDOW_MS;
  const kept = entries.filter((entry) => entry.at > floor);
  let total = 0;
  for (const entry of kept) total += entry.bytes;
  if (total < UPLOAD_RATE_BYTES) return { kept, waitMs: 0 };
  return { kept, waitMs: Math.max(1, kept[0]!.at + UPLOAD_RATE_WINDOW_MS - now) };
}

export const MAX_UPLOAD_NAME_BYTES = 200;

const MAX_MIME_CHARS = 128;

// Only an unsent upload expires by age; a sent one stays until its session goes or its budget needs the room (roomFor).
const UNCONSUMED_TTL_MS = 24 * 60 * 60 * 1000;

const SWEEP_INTERVAL_MS = 5 * 60_000;

export type UploadNameRejection = "empty" | "nul_byte" | "control_char" | "reserved" | "no_usable_characters";

export type UploadName = { ok: true; name: string } | { ok: false; reason: UploadNameRejection };

const DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Sanitizes rather than refuses: the name is a label inside a fresh random directory, not a location; controls stay refused (Content-Disposition). */
export function sanitizeUploadName(input: string): UploadName {
  if (input.length === 0) return { ok: false, reason: "empty" };
  if (input.includes("\0")) return { ok: false, reason: "nul_byte" };

  const segments = input.split(/[/\\]/).filter((part) => part.length > 0);
  let name = segments.at(-1) ?? "";
  if (name.length === 0) return { ok: false, reason: "no_usable_characters" };

  // eslint-disable-next-line no-control-regex -- that is precisely the point.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return { ok: false, reason: "control_char" };
  if (name === "." || name === "..") return { ok: false, reason: "reserved" };

  // Windows drops trailing dots and spaces, so the stored name would stop matching.
  name = name.replace(/[. ]+$/, "");
  if (name.length === 0) return { ok: false, reason: "no_usable_characters" };

  const stem = name.slice(0, name.indexOf(".") === -1 ? name.length : name.indexOf("."));
  if (DEVICE_NAMES.has(stem.toLowerCase())) name = `_${name}`;

  // Re-checked after clipping: clipName can reduce a name to a dot.
  const clipped = clipName(name);
  if (clipped.length === 0 || clipped === "." || clipped === "..") {
    return { ok: false, reason: "reserved" };
  }

  return { ok: true, name: clipped };
}

/** Half a surrogate pair is no character: SQLite stores U+FFFD for it, so the transcript's name and the stored one would differ. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The label of a file an agent sent. The agent chose it, so what could disguise an extension in the transcript or the
 * save panel (bidi and zero-width characters) or end a header (controls) is dropped rather than refused.
 */
export function sentFileName(path: string): string {
  const base = (path.split(/[/\\]/).filter((part) => part.length > 0).at(-1) ?? "").replace(LONE_SURROGATE, "");
  // eslint-disable-next-line no-control-regex -- stripping them is the job.
  const visible = base.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
  const safe = sanitizeUploadName(visible);
  return safe.ok ? safe.name : "file";
}

function clipName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_UPLOAD_NAME_BYTES) return name;

  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 17 ? name.slice(dot) : "";
  const budget = MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(ext, "utf8");

  // By code point: a cut through a surrogate pair left half an emoji, which SQLite stores as U+FFFD and a header refuses.
  const points = Array.from(name.slice(0, dot > 0 ? dot : name.length));
  let bytes = Buffer.byteLength(points.join(""), "utf8");
  while (points.length > 0 && bytes > budget) bytes -= Buffer.byteLength(points.pop() ?? "", "utf8");
  return `${points.join("")}${ext}`;
}

/** Always `attachment`, never `inline`; the ASCII fallback drops quotes, backslashes and controls (a CR ends the header). */
export function contentDispositionFor(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the job.
  const ascii = name.replace(/[\u0000-\u001f\u007f-\u009f"\\]/g, "").replace(/[^\x20-\x7e]+/g, "_");
  const fallback = ascii.length > 0 ? ascii : "download";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function resolveUploadRoot(spec: string | undefined, root: string = resolveStateRoot(undefined)): string {
  const raw = (spec ?? "").trim();
  if (raw.length === 0) return join(root, "uploads");
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    throw new Error(`REEMOAT_UPLOAD_ROOT must be an absolute path, got "${raw}"`);
  }
  return expanded;
}

/** Guards the rm below: an id shaped like ../escape must remove nothing. */
function safeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== "." &&
    value !== ".."
  );
}

export function inlinesImage(mime: string | null, bytes: number, caps: { image: boolean }): boolean {
  if (!caps.image) return false;
  if (mime === null || !mime.startsWith("image/")) return false;
  return bytes <= MAX_INLINE_IMAGE_BYTES;
}

/** `null` when none was declared, `undefined` when it is malformed. */
export function parseMime(header: string | undefined): string | null | undefined {
  const raw = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (raw.length === 0) return null;
  if (raw.length > MAX_MIME_CHARS) return undefined;
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(raw) ? raw : undefined;
}

export interface ReceiveRequest {
  name: string;
  origName: string;
  mime: string | null;
  body: ReadableStream<Uint8Array>;
}

export type ReceiveResult =
  | { kind: "ok"; row: UploadRow; sessionBytes: number; sessionCount: number }
  | { kind: "too_large" }
  /** `used` is what files not yet sent hold: nothing else can refuse, since a sent one is dropped to make room. */
  | { kind: "quota"; used: number }
  | { kind: "too_many" }
  | { kind: "rate"; retryAfterMs: number }
  | { kind: "write_failed"; detail: string };

export type ResolveResult = { ok: true; rows: UploadRow[] } | { ok: false; missing: string };

export type KeepFileResult =
  | { kind: "ok"; row: UploadRow }
  | { kind: "missing" }
  | { kind: "denied" }
  | { kind: "not_a_file" }
  /** The daemon's own `/proc` entry: its environment holds this machine's token. */
  | { kind: "daemon_process" }
  /** The filesystem did not answer: a stalled mount, never a missing file. */
  | { kind: "unresponsive" }
  | { kind: "too_large"; limit: number }
  | { kind: "rate"; retryAfterMs: number }
  | { kind: "cancelled" }
  /** `kept` said no: the session went while the copy ran, so nothing was kept. */
  | { kind: "withdrawn" }
  | { kind: "timed_out" }
  | { kind: "failed"; detail: string };

export interface KeepFileOptions extends ProbeOptions {
  signal?: AbortSignal | null;
  deadlineMs?: number;
  /**
   * Called once the copy is whole, in the same synchronous block as the row's insert: false keeps nothing, and whatever true
   * records (the transcript's event) lands with the row or not at all, ahead of any eviction (Q2.253).
   */
  kept?: (row: UploadRow) => boolean;
}

const COPY_CHUNK_BYTES = 1024 * 1024;

type CopyStop = "cancelled" | "timed_out";

/** A source call still out this long at the deadline is a stall rather than a slow copy: remembered, and answered as one. */
const STALLED_CALL_MS = DESCRIBE_TIMEOUT_MS;

export interface UploadsOptions {
  root: string;
  index: UploadIndex;
  onWarning: (detail: string) => void;
}

export class Uploads {
  private stopped = false;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly recent = new Map<string, UploadCharge[]>();
  /** What an agent sent, charged apart: its loop may not answer a person's upload with 429. */
  private readonly recentSent = new Map<string, UploadCharge[]>();
  /** The tail of each session's send_file calls: one copy at a time, charged and bounded in the order they came. */
  private readonly sending = new Map<string, Promise<void>>();

  private constructor(
    private readonly root: string,
    private readonly index: UploadIndex,
    private readonly onWarning: (detail: string) => void,
  ) {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private rateWait(sessionId: string, now: number, charges: Map<string, UploadCharge[]> = this.recent): number {
    const entries = charges.get(sessionId);
    if (entries === undefined) return 0;
    const { kept, waitMs } = uploadRateVerdict(entries, now);
    if (kept.length === 0) charges.delete(sessionId);
    else charges.set(sessionId, kept);
    return waitMs;
  }

  private charge(sessionId: string, bytes: number, now: number, charges: Map<string, UploadCharge[]> = this.recent): void {
    const entries = charges.get(sessionId);
    if (entries === undefined) charges.set(sessionId, [{ at: now, bytes }]);
    else entries.push({ at: now, bytes });
  }

  static async open(options: UploadsOptions): Promise<Uploads> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked and ignored for an existing directory, hence the chmod.
    await chmod(options.root, 0o700).catch(() => {
      // A filesystem without POSIX modes is no reason to refuse to start.
    });

    const uploads = new Uploads(options.root, options.index, options.onWarning);
    await uploads.reconcile();
    return uploads;
  }

  pathFor(row: UploadRow): string {
    return join(this.root, row.sessionId, row.uploadId, row.name);
  }

  find(sessionId: string, uploadId: string): UploadRow | null {
    return this.index.get(sessionId, uploadId);
  }

  /** The byte counter here is the only bound on a request body anywhere in this system. */
  async receive(sessionId: string, request: ReceiveRequest): Promise<ReceiveResult> {
    if (!safeSegment(sessionId)) {
      await cancelBody(request.body);
      return { kind: "write_failed", detail: "unusable session id" };
    }

    const before = roomFor(this.sentFiles(sessionId), 0, USER_BUDGET);
    if (!before.ok) {
      await cancelBody(request.body);
      return before.full === "count" ? { kind: "too_many" } : { kind: "quota", used: this.unsentBytes(sessionId) };
    }

    // Before the body is read, so a refusal streams nothing.
    const wait = this.rateWait(sessionId, Date.now());
    if (wait > 0) {
      await cancelBody(request.body);
      return { kind: "rate", retryAfterMs: wait };
    }

    const unsent = this.unsentBytes(sessionId);

    const uploadId = `u_${randomBytes(8).toString("hex")}`;
    const dir = join(this.root, sessionId, uploadId);
    const full = join(dir, request.name);

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {
        // As above: modes are best effort, the containment is the path.
      });
    } catch (error) {
      await cancelBody(request.body);
      return { kind: "write_failed", detail: describeError(error) };
    }

    let written = 0;
    const head = new Uint8Array(SNIFF_BYTES);
    let outcome: ReceiveResult | null = null;
    // `wx` is O_CREAT|O_EXCL: never follows a link, never truncates.
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(full, "wx", 0o600);
    } catch (error) {
      await this.discard(dir);
      await cancelBody(request.body);
      return { kind: "write_failed", detail: describeError(error) };
    }

    try {
      for await (const chunk of request.body) {
        if (written < SNIFF_BYTES) head.set(chunk.subarray(0, SNIFF_BYTES - written), written);
        written += chunk.byteLength;
        if (written > MAX_UPLOAD_BYTES) {
          outcome = { kind: "too_large" };
          break;
        }
        // Only files not yet sent can hold the budget: every sent one can be dropped for this.
        if (unsent + written > MAX_SESSION_UPLOAD_BYTES) {
          outcome = { kind: "quota", used: unsent };
          break;
        }
        await handle.write(chunk);
      }
    } catch (error) {
      outcome = { kind: "write_failed", detail: describeError(error) };
    } finally {
      await handle.close().catch(() => {
        // Already closed, or the descriptor died with the write that failed.
      });
    }

    if (written > 0) this.charge(sessionId, written, Date.now());

    if (outcome !== null) {
      await this.discard(dir);
      // Cancel after unlinking, and always (see cancelBody).
      await cancelBody(request.body);
      return outcome;
    }

    // Planned again from the rows as they stand now: concurrent uploads all passed the first check.
    const room = roomFor(this.sentFiles(sessionId), written, USER_BUDGET);
    if (!room.ok) {
      await this.discard(dir);
      return room.full === "count" ? { kind: "too_many" } : { kind: "quota", used: this.unsentBytes(sessionId) };
    }

    // A pasted file can arrive declaring only bytes; the agent is handed an image only under an image type.
    const declared = request.mime;
    const mime =
      declared === null || declared === "application/octet-stream"
        ? (sniffImageMime(head.subarray(0, Math.min(written, SNIFF_BYTES))) ?? declared)
        : declared;

    // The row is the commit point, and bytes without one are swept; what it displaces goes after it.
    const row: UploadRow = {
      sessionId,
      uploadId,
      name: request.name,
      origName: request.origName,
      mime,
      bytes: written,
      createdAt: Date.now(),
      consumedAt: null,
    };
    try {
      this.index.insert(row);
    } catch (error) {
      await this.discard(dir);
      return { kind: "write_failed", detail: describeError(error) };
    }
    for (const old of room.evict) await this.drop(old);

    const kept = this.sentFiles(sessionId);
    return {
      kind: "ok",
      row,
      sessionBytes: kept.reduce((sum, one) => sum + one.bytes, 0),
      sessionCount: kept.length,
    };
  }

  /** Every file somebody sent to this session, sent yet or not; what an agent returned or sent is budgeted apart. */
  private sentFiles(sessionId: string): UploadRow[] {
    return this.index.listFor(sessionId).filter(isPersonFile);
  }

  private unsentBytes(sessionId: string): number {
    return this.sentFiles(sessionId)
      .filter((row) => row.consumedAt === null)
      .reduce((sum, row) => sum + row.bytes, 0);
  }

  /** The row first, so nothing can resolve a file that is being removed; a crash in between leaves bytes the next open sweeps. */
  private forgetRow(row: UploadRow): boolean {
    try {
      this.index.remove(row.sessionId, row.uploadId);
      return true;
    } catch (error) {
      this.onWarning(`could not drop an old upload row: ${describeError(error)}`);
      return false;
    }
  }

  private async drop(row: UploadRow): Promise<void> {
    if (this.forgetRow(row)) await this.discard(join(this.root, row.sessionId, row.uploadId));
  }

  /** Runs on the agent's emit path, so the write is fire-and-forget; the row is inserted already consumed. */
  keepAgentImage(sessionId: string, mime: string, data: string): UploadRow | null {
    if (!safeSegment(sessionId)) return null;

    // Refused rather than clipped: a clipped mime is a wrong type.
    const declared = parseMime(mime);
    if (declared === undefined || declared === null) return null;

    // Refused from the encoded length, before decoding: this is the emit path.
    if (data.length > Math.ceil((MAX_AGENT_IMAGE_BYTES * 4) / 3)) return null;

    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return null;
    if (bytes.length > MAX_AGENT_IMAGE_BYTES) return null;
    // Its own budget, never the files somebody sent: what an agent returns may not refuse a person's attachment.
    const room = roomFor(this.index.listFor(sessionId).filter(isAgentImage), bytes.length, AGENT_BUDGET);
    if (!room.ok) return null;

    const uploadId = `${AGENT_IMAGE_PREFIX}${randomBytes(8).toString("hex")}`;
    const name = `image-${uploadId.slice(2, 10)}${extensionForMime(declared)}`;
    const row: UploadRow = {
      sessionId,
      uploadId,
      name,
      origName: name,
      mime: declared,
      bytes: bytes.length,
      createdAt: Date.now(),
      consumedAt: Date.now(),
    };

    try {
      this.index.insert(row);
    } catch (error) {
      this.onWarning(`could not record an agent image: ${describeError(error)}`);
      return null;
    }

    void this.writeAgentImage(row, bytes);
    // Rows now, so the next image in the same tool result plans against them; directories off the emit path, since discard lstats.
    const gone = room.evict.filter((old) => this.forgetRow(old));
    if (gone.length > 0) {
      setImmediate(() => {
        for (const old of gone) void this.discard(join(this.root, old.sessionId, old.uploadId));
      });
    }
    return row;
  }

  /** send_file: one file copied as it is now, in the caller's own words on every refusal. One at a time per session (Q2.252). */
  async keepAgentFile(sessionId: string, sourcePath: string, options: KeepFileOptions = {}): Promise<KeepFileResult> {
    if (!safeSegment(sessionId)) return { kind: "failed", detail: "unusable session id" };
    const deadlineAt = Date.now() + (options.deadlineMs ?? SENT_FILE_DEADLINE_MS);
    const previous = this.sending.get(sessionId) ?? Promise.resolve();
    // The wait in line counts against this call's own deadline and signal; giving up there copies nothing.
    const run = settledOrStopped(previous, options.signal ?? null, deadlineAt).then((stopped) =>
      stopped === null ? this.copyAgentFile(sessionId, sourcePath, options, deadlineAt) : { kind: stopped },
    );
    // Behind both: a call that gave up in line must not let the next one start beside the copy ahead of it.
    const tail = Promise.allSettled([previous, run]).then(() => undefined);
    this.sending.set(sessionId, tail);
    try {
      return await run;
    } catch (error) {
      return { kind: "failed", detail: describeError(error) };
    } finally {
      if (this.sending.get(sessionId) === tail) this.sending.delete(sessionId);
    }
  }

  private async copyAgentFile(
    sessionId: string,
    sourcePath: string,
    options: KeepFileOptions,
    deadlineAt: number,
  ): Promise<KeepFileResult> {
    const signal = options.signal ?? null;
    // Functions, so the compiler does not carry a first answer past the awaits below.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) return { kind: "cancelled" };
    if (Date.now() >= deadlineAt) return { kind: "timed_out" };

    const wait = this.rateWait(sessionId, Date.now(), this.recentSent);
    if (wait > 0) return { kind: "rate", retryAfterMs: wait };

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<CopyStop>((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), Math.max(1, deadlineAt - Date.now()));
      timer.unref();
      onAbort = () => resolve("cancelled");
      // Added straight after the check above, so no abort falls between the two.
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The call still out on the agent's path, so a lost race can tell a stall from a slow copy.
    let outstanding: { call: Promise<unknown>; since: number } | null = null;
    // A call on a mount that stalls never returns: the race gives the caller back, never the thread.
    const within = <T>(work: Promise<T>): Promise<{ value: T } | CopyStop> => {
      const call = { call: work, since: Date.now() };
      outstanding = call;
      return Promise.race([
        work.then((value) => {
          if (outstanding === call) outstanding = null;
          return { value };
        }),
        stop,
      ]);
    };

    const uploadId = `${SENT_FILE_PREFIX}${randomBytes(8).toString("hex")}`;
    const dir = join(this.root, sessionId, uploadId);
    const name = sentFileName(sourcePath);
    let source: FileHandle | null = null;
    let target: FileHandle | null = null;
    let made = false;
    let written = 0;
    const head = new Uint8Array(SNIFF_BYTES);
    let stallAt: StallTarget | null = null;

    const outcome = await (async (): Promise<KeepFileResult | null> => {
      // Probes first, raced like every call below: a path the agent named may sit on a mount that never answers.
      const context = await within(probeContext(options));
      if (typeof context === "string") return { kind: context };
      const probing = { ...options, mounts: context.value.mounts };
      const resolved = await within(probeRealpath(sourcePath, probing));
      if (typeof resolved === "string") return { kind: resolved };
      if (resolved.value === null) return { kind: "unresponsive" };
      if (resolved.value.kind === "missing") return realpathRefusal(resolved.value.code);
      const real = resolved.value.value;
      if (daemonProcessPath(real)) return { kind: "daemon_process" };
      stallAt = stallKeyFor(real, context.value.mounts);
      const probed = await within(probeFile(real, probing));
      if (typeof probed === "string") return { kind: probed };
      if (probed.value === null) return { kind: "unresponsive" };
      if (probed.value.kind !== "file") return { kind: "not_a_file" };
      if (probed.value.size > MAX_SENT_FILE_BYTES) return { kind: "too_large", limit: MAX_SENT_FILE_BYTES };

      // O_NONBLOCK: a FIFO swapped in after the probe would park this open for ever. O_NOFOLLOW: the path is already resolved.
      const opening = open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
        (error: unknown): KeepFileResult => {
          // Only here is a missing path the agent's: past this line ENOENT is about this daemon's own store.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return { kind: "missing" };
          if (code === "EACCES" || code === "EPERM") return { kind: "denied" };
          if (code === "ELOOP" || code === "EISDIR") return { kind: "not_a_file" };
          return { kind: "failed", detail: describeError(error) };
        },
      );
      const opened = await within(opening);
      if (typeof opened === "string") {
        void opening.then((handle) => {
          // The open that lost the race still has to be closed, whenever it answers.
          if (!("kind" in handle)) void handle.close().catch(() => {});
        });
        return { kind: opened };
      }
      if ("kind" in opened.value) return opened.value;
      const reading = opened.value;
      source = reading;
      const info = await within(reading.stat());
      if (typeof info === "string") return { kind: info };
      if (!info.value.isFile()) return { kind: "not_a_file" };
      if (info.value.size > MAX_SENT_FILE_BYTES) return { kind: "too_large", limit: MAX_SENT_FILE_BYTES };

      await mkdir(dir, { recursive: true, mode: 0o700 });
      made = true;
      await chmod(dir, 0o700).catch(() => {
        // Best effort, as everywhere else here.
      });
      // `wx` is O_CREAT|O_EXCL: never follows a link, never truncates.
      target = await open(join(dir, name), "wx", 0o600);

      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const read = await within(reading.read(buffer, 0, buffer.length, null));
        if (typeof read === "string") return { kind: read };
        const count = read.value.bytesRead;
        if (count === 0) return null;
        if (written < SNIFF_BYTES) head.set(buffer.subarray(0, Math.min(count, SNIFF_BYTES - written)), written);
        written += count;
        // Counted, not trusted from the stat: the file may still be growing.
        if (written > MAX_SENT_FILE_BYTES) return { kind: "too_large", limit: MAX_SENT_FILE_BYTES };
        await writeAll(target, buffer.subarray(0, count));
      }
    })().catch((error: unknown): KeepFileResult => ({ kind: "failed", detail: describeError(error) }));

    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    // Not awaited: a close on the mount that just stalled must not hold the caller either.
    void (source as FileHandle | null)?.close().catch(() => {
      // Nothing to do about a descriptor that will not close.
    });
    await (target as FileHandle | null)?.close().catch(() => {
      // Already closed with the failing write.
    });
    if (written > 0) this.charge(sessionId, written, Date.now(), this.recentSent);

    let refused: KeepFileResult | null = outcome ?? (aborted() ? { kind: "cancelled" } : null);
    // Out since before the probe's own bound: the mount is not answering, and the next call there is refused without a thread.
    const still = outstanding as { call: Promise<unknown>; since: number } | null;
    const stalledOn = stallAt as StallTarget | null;
    if (refused?.kind === "timed_out" && still !== null && Date.now() - still.since >= STALLED_CALL_MS) {
      if (stalledOn !== null) noteStalled(stalledOn, still.call);
      refused = { kind: "unresponsive" };
    }
    if (refused !== null) {
      if (made) await this.discard(dir);
      return refused;
    }

    // Synchronous from the plan to the insert and `kept`, so no other caller's row comes between them and nothing is half kept.
    const now = Date.now();
    const row: UploadRow = {
      sessionId,
      uploadId,
      name,
      origName: name,
      mime: sniffImageMime(head.subarray(0, Math.min(written, SNIFF_BYTES))),
      bytes: written,
      createdAt: now,
      // Already sent: nothing waits to name it in a prompt, so no sweep may take it for a stale draft.
      consumedAt: now,
    };
    let room: Room;
    let inserted = false;
    let wanted = true;
    try {
      room = roomFor(this.index.listFor(sessionId).filter(isSentFile), written, SENT_BUDGET);
      if (room.ok) {
        this.index.insert(row);
        inserted = true;
        // After the insert, so whatever `kept` records names a row that exists; before the eviction, so a no evicts nothing.
        wanted = options.kept?.(row) ?? true;
        if (!wanted) {
          this.index.remove(sessionId, uploadId);
          inserted = false;
        }
      }
    } catch (error) {
      if (inserted) this.forgetRow(row);
      await this.discard(dir);
      return { kind: "failed", detail: describeError(error) };
    }
    if (!wanted) {
      await this.discard(dir);
      return { kind: "withdrawn" };
    }
    if (!room.ok) {
      await this.discard(dir);
      return { kind: "failed", detail: "no room left for another sent file" };
    }
    const gone = room.evict.filter((old) => this.forgetRow(old));
    for (const old of gone) await this.discard(join(this.root, old.sessionId, old.uploadId));
    return { kind: "ok", row };
  }

  private async writeAgentImage(row: UploadRow, bytes: Buffer): Promise<void> {
    const dir = join(this.root, row.sessionId, row.uploadId);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {
        // Best effort, as everywhere else here.
      });
      const handle = await open(join(dir, row.name), "wx", 0o600);
      try {
        await handle.write(bytes);
      } finally {
        await handle.close().catch(() => {
          // Already closed with the failing write.
        });
      }
    } catch (error) {
      this.onWarning(`could not store an agent image: ${describeError(error)}`);
      try {
        this.index.remove(row.sessionId, row.uploadId);
      } catch {
        // Nothing further to do; reconciliation at the next open drops the row.
      }
    }
  }

  resolve(sessionId: string, uploadIds: readonly string[]): ResolveResult {
    const rows: UploadRow[] = [];
    for (const id of uploadIds) {
      const row = this.index.get(sessionId, id);
      if (row === null) return { ok: false, missing: id };
      rows.push(row);
    }
    return { ok: true, rows };
  }

  markConsumed(sessionId: string, uploadIds: readonly string[]): void {
    try {
      this.index.markConsumed(sessionId, uploadIds, Date.now());
    } catch (error) {
      this.onWarning(`could not mark uploads consumed: ${describeError(error)}`);
    }
  }

  /** Every file gets a file:// resource_link; an image block is added on top when the agent takes images. */
  async blocksFor(rows: readonly UploadRow[], caps: { image: boolean }): Promise<acp.ContentBlock[]> {
    const blocks: acp.ContentBlock[] = [];
    for (const row of rows) {
      const full = this.pathFor(row);
      const uri = pathToFileURL(full).href;
      blocks.push({
        type: "resource_link",
        uri,
        name: row.name,
        mimeType: row.mime,
        size: row.bytes,
      });

      if (!inlinesImage(row.mime, row.bytes, caps)) continue;
      try {
        const data = await readFile(full);
        blocks.push({ type: "image", data: data.toString("base64"), mimeType: row.mime ?? "image/png", uri });
      } catch (error) {
        this.onWarning(`could not inline ${row.name}: ${describeError(error)}`);
      }
    }
    return blocks;
  }

  async forgetSession(sessionId: string): Promise<void> {
    if (!safeSegment(sessionId)) {
      this.onWarning(`refusing to remove uploads for an unusable session id`);
      return;
    }
    await this.discard(join(this.root, sessionId));
    this.recent.delete(sessionId);
    this.recentSent.delete(sessionId);
    try {
      this.index.removeSession(sessionId);
    } catch (error) {
      this.onWarning(`could not clear upload rows: ${describeError(error)}`);
    }
  }

  async forgetSessions(sessionIds: readonly string[]): Promise<void> {
    for (const id of sessionIds) await this.forgetSession(id);
  }

  /** Only files nobody sent: what a prompt event names must survive a workspace removal. */
  async forgetUnconsumed(sessionId: string): Promise<void> {
    if (!safeSegment(sessionId)) {
      this.onWarning(`refusing to remove uploads for an unusable session id`);
      return;
    }
    let rows: UploadRow[];
    try {
      rows = this.index.listFor(sessionId).filter((row) => row.consumedAt === null);
    } catch (error) {
      this.onWarning(`could not list staged uploads: ${describeError(error)}`);
      return;
    }
    for (const row of rows) {
      await this.discard(join(this.root, row.sessionId, row.uploadId));
      try {
        this.index.remove(row.sessionId, row.uploadId);
      } catch (error) {
        this.onWarning(`could not drop a staged upload row: ${describeError(error)}`);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
  }

  /** Refuses a symlink and anything outside the root: an upload id is guessable from a transcript. */
  private async discard(dir: string): Promise<void> {
    let real: ReturnType<typeof lstatSync>;
    try {
      real = lstatSync(dir);
    } catch {
      return;
    }
    if (real.isSymbolicLink()) {
      this.onWarning(`refusing to remove ${dir}: it is a symlink`);
      return;
    }
    if (!containedIn(dir, this.root)) {
      this.onWarning(`refusing to remove ${dir}: outside the upload root`);
      return;
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      this.onWarning(`could not remove ${dir}: ${describeError(error)}`);
    }
  }

  private async reconcile(): Promise<void> {
    // Sessions with an uncheckable row are skipped below: removing the row would make its bytes look orphaned.
    const unsure = new Set<string>();
    for (const sessionId of this.index.listSessions()) {
      for (const row of this.index.listFor(sessionId)) {
        try {
          lstatSync(this.pathFor(row));
        } catch (error) {
          // Only ENOENT/ENOTDIR may delete: a transient error must not destroy intact files.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            this.index.remove(row.sessionId, row.uploadId);
            continue;
          }
          unsure.add(sessionId);
          this.onWarning(`could not check ${this.pathFor(row)}: ${describeError(error)}`);
        }
      }
    }

    let sessions: string[];
    try {
      sessions = await readdir(this.root);
    } catch (error) {
      this.onWarning(`could not read the upload root: ${describeError(error)}`);
      return;
    }
    for (const sessionId of sessions) {
      if (!safeSegment(sessionId)) continue;
      if (unsure.has(sessionId)) continue;
      const known = new Set(this.index.listFor(sessionId).map((row) => row.uploadId));
      let entries: string[];
      try {
        entries = await readdir(join(this.root, sessionId));
      } catch {
        continue;
      }
      for (const uploadId of entries) {
        if (known.has(uploadId)) continue;
        await this.discard(join(this.root, sessionId, uploadId));
      }
      if (entries.length > 0 && known.size === 0) await this.discard(join(this.root, sessionId));
    }
  }

  private async sweep(): Promise<void> {
    if (this.stopped) return;
    // A session that stopped sending is asked no more, so its old charges would otherwise stay until a restart.
    const now = Date.now();
    for (const charges of [this.recent, this.recentSent]) {
      for (const sessionId of [...charges.keys()]) this.rateWait(sessionId, now, charges);
    }
    let expired: UploadRow[];
    try {
      expired = this.index.expired(Date.now() - UNCONSUMED_TTL_MS);
    } catch (error) {
      this.onWarning(`upload sweep failed: ${describeError(error)}`);
      return;
    }
    for (const row of expired) {
      if (this.stopped) return;
      await this.discard(join(this.root, row.sessionId, row.uploadId));
      try {
        this.index.remove(row.sessionId, row.uploadId);
      } catch (error) {
        this.onWarning(`could not drop an expired upload row: ${describeError(error)}`);
      }
    }
  }
}

/** Null once `previous` settles, else whichever stop comes first; never rejects, `previous` being the queue's own tail. */
function settledOrStopped(previous: Promise<unknown>, signal: AbortSignal | null, deadlineAt: number): Promise<CopyStop | null> {
  if (signal?.aborted === true) return Promise.resolve("cancelled");
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined = undefined;
    const finish = (stopped: CopyStop | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(stopped);
    };
    const onAbort = (): void => finish("cancelled");
    timer = setTimeout(() => finish("timed_out"), Math.max(1, deadlineAt - Date.now()));
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => finish(null),
      () => finish(null),
    );
  });
}

/** Only ENOENT and ENOTDIR are a missing file: EACCES under a closed folder told the model there was nothing there. */
function realpathRefusal(code: string | undefined): KeepFileResult {
  if (code === undefined || code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
  if (code === "EACCES" || code === "EPERM") return { kind: "denied" };
  if (code === "ELOOP") return { kind: "failed", detail: "its symbolic links go round in a loop" };
  if (code === "ENAMETOOLONG") return { kind: "failed", detail: "the path is longer than this system allows" };
  return { kind: "failed", detail: code };
}

/** Linux's view of this process, which `/proc/self` resolves to: its `environ` holds the daemon's own token. */
function daemonProcessPath(real: string): boolean {
  const own = `/proc/${process.pid}`;
  return real === own || real.startsWith(`${own}/`);
}

/** A write may take fewer bytes than it was offered. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let offset = 0; offset < chunk.length; ) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten === 0) throw new Error("the store took no bytes");
    offset += bytesWritten;
  }
}

function extensionForMime(mime: string): string {
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const subtype = type.startsWith("image/") ? type.slice("image/".length) : "";
  if (subtype === "jpeg") return ".jpg";
  if (subtype === "svg+xml") return ".svg";
  return /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ".bin";
}

/** Call on every refusing path: an unread body parks the sender at the relay's window, and the next valve closes the whole tunnel. */
export async function cancelBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (!body) return;
  await body.cancel().catch(() => {
    // The client hung up first, which is the ordinary way this happens.
  });
}

