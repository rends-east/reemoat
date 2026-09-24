import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type * as acp from "@agentclientprotocol/sdk";

import { containedIn, expandHome, resolveStateRoot } from "./paths.js";
import { describeError } from "./http.js";

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
  bytesFor(sessionId: string): number;
  countFor(sessionId: string): number;
  markConsumed(sessionId: string, uploadIds: readonly string[], at: number): void;
  listFor(sessionId: string): UploadRow[];
  listSessions(): string[];
  expired(createdBefore: number): UploadRow[];
  remove(sessionId: string, uploadId: string): void;
  removeSession(sessionId: string): void;
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const MAX_SESSION_UPLOAD_BYTES = 1024 * 1024 * 1024;

export const MAX_UPLOADS_PER_SESSION = 100;

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

// Only unconsumed uploads expire: a consumed one lives as long as its session row, since the log evicts a prefix.
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

function clipName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_UPLOAD_NAME_BYTES) return name;

  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 17 ? name.slice(dot) : "";
  const budget = MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(ext, "utf8");

  let stem = name.slice(0, dot > 0 ? dot : name.length);
  while (stem.length > 0 && Buffer.byteLength(stem, "utf8") > budget) stem = stem.slice(0, -1);
  return `${stem}${ext}`;
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
  | { kind: "quota"; used: number }
  | { kind: "too_many" }
  | { kind: "rate"; retryAfterMs: number }
  | { kind: "write_failed"; detail: string };

export type ResolveResult = { ok: true; rows: UploadRow[] } | { ok: false; missing: string };

export interface UploadsOptions {
  root: string;
  index: UploadIndex;
  onWarning: (detail: string) => void;
}

export class Uploads {
  private stopped = false;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly recent = new Map<string, UploadCharge[]>();

  private constructor(
    private readonly root: string,
    private readonly index: UploadIndex,
    private readonly onWarning: (detail: string) => void,
  ) {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private rateWait(sessionId: string, now: number): number {
    const entries = this.recent.get(sessionId);
    if (entries === undefined) return 0;
    const { kept, waitMs } = uploadRateVerdict(entries, now);
    if (kept.length === 0) this.recent.delete(sessionId);
    else this.recent.set(sessionId, kept);
    return waitMs;
  }

  private charge(sessionId: string, bytes: number, now: number): void {
    const entries = this.recent.get(sessionId);
    if (entries === undefined) this.recent.set(sessionId, [{ at: now, bytes }]);
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

    if (this.index.countFor(sessionId) >= MAX_UPLOADS_PER_SESSION) {
      await cancelBody(request.body);
      return { kind: "too_many" };
    }

    // Before the body is read, so a refusal streams nothing.
    const wait = this.rateWait(sessionId, Date.now());
    if (wait > 0) {
      await cancelBody(request.body);
      return { kind: "rate", retryAfterMs: wait };
    }

    const priorBytes = this.index.bytesFor(sessionId);

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
        written += chunk.byteLength;
        if (written > MAX_UPLOAD_BYTES) {
          outcome = { kind: "too_large" };
          break;
        }
        if (priorBytes + written > MAX_SESSION_UPLOAD_BYTES) {
          outcome = { kind: "quota", used: priorBytes };
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

    // Re-checked: concurrent uploads all passed the first check.
    const settledBytes = this.index.bytesFor(sessionId);
    if (settledBytes + written > MAX_SESSION_UPLOAD_BYTES) {
      await this.discard(dir);
      return { kind: "quota", used: settledBytes };
    }
    if (this.index.countFor(sessionId) >= MAX_UPLOADS_PER_SESSION) {
      await this.discard(dir);
      return { kind: "too_many" };
    }

    // Last: the row is the commit point, and bytes without one are swept.
    const row: UploadRow = {
      sessionId,
      uploadId,
      name: request.name,
      origName: request.origName,
      mime: request.mime,
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

    return {
      kind: "ok",
      row,
      sessionBytes: this.index.bytesFor(sessionId),
      sessionCount: this.index.countFor(sessionId),
    };
  }

  /** Runs on the agent's emit path, so the write is fire-and-forget; the row is inserted already consumed. */
  keepAgentImage(sessionId: string, mime: string, data: string): UploadRow | null {
    if (!safeSegment(sessionId)) return null;
    if (this.index.countFor(sessionId) >= MAX_UPLOADS_PER_SESSION) return null;

    // Refused rather than clipped: a clipped mime is a wrong type.
    const declared = parseMime(mime);
    if (declared === undefined || declared === null) return null;

    // Refused from the encoded length, before decoding: this is the emit path.
    if (data.length > Math.ceil((MAX_AGENT_IMAGE_BYTES * 4) / 3)) return null;

    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return null;
    if (bytes.length > MAX_AGENT_IMAGE_BYTES) return null;
    if (this.index.bytesFor(sessionId) + bytes.length > MAX_SESSION_UPLOAD_BYTES) return null;

    const uploadId = `a_${randomBytes(8).toString("hex")}`;
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
    return row;
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

