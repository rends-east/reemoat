import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type * as acp from "@agentclientprotocol/sdk";

import { containedIn, expandHome } from "./paths.js";
import { describeError } from "./http.js";

/**
 * Files a person staged for a prompt, and what becomes of them.
 *
 * The bytes live on **this** machine's disk and never anywhere else. That is not
 * incidental: the control plane runs its container `read_only` with one named
 * volume for its own database, and the relay's governing rule is that it holds
 * nothing — `sendNoTunnel` answers immediately rather than queueing, because a
 * queue turns a relay outage into a relay memory leak during the incident it
 * should be surviving. An upload streams browser → relay → tunnel → this file and
 * stops.
 *
 * Two roots, deliberately disjoint. A worktree is a git checkout somebody may
 * remove with `DELETE /sessions/:id/workspace`; an upload is staged input that
 * has to outlive that, and for a `plain` session `workspace.root` is the caller's
 * own repository — writing there would put attachments into somebody's real
 * checkout and into `GET /sessions/:id/changes` as untracked files.
 */

/** One staged file, as the index holds it. */
export interface UploadRow {
  sessionId: string;
  uploadId: string;
  /** Sanitized, a single path segment. Never what the client sent. */
  name: string;
  origName: string;
  mime: string | null;
  bytes: number;
  createdAt: number;
  /** When a prompt named it, or `null` while it is still only staged. */
  consumedAt: number | null;
}

/**
 * The durable index behind an upload root.
 *
 * Declared here and implemented in `store/sqlite.ts`, the same direction
 * `events.ts` declares `EventStore` — the vocabulary belongs with the thing it
 * describes, and the storage engine is what depends on it rather than the other
 * way round.
 *
 * Synchronous throughout, like every other store here: node's SQLite bindings
 * are, so async would buy nothing. Safe to call from `ManagedSession.prompt`,
 * which must not await, because none of it is on the agent's emit path.
 */
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

/** 25 MiB. Above any screenshot, below anything that is a transfer rather than an attachment. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** 100 MiB of staged files per session, consumed or not. */
export const MAX_SESSION_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * An inode ceiling beside the byte one.
 *
 * The byte cap cannot see a hundred thousand one-byte uploads, and each of those
 * is a directory. Two bounds because they bound different things.
 */
export const MAX_UPLOADS_PER_SESSION = 100;

/** How many files may ride one prompt. */
export const MAX_PROMPT_ATTACHMENTS = 10;

/**
 * The largest image sent to the agent as bytes rather than as a link.
 *
 * base64 is 4/3, so 5 MiB raw is ~6.8 MiB inside one JSON-RPC message written to
 * the agent's stdin. Past that the `resource_link` is the whole answer and the
 * agent can open the file itself — which it can, because it runs as this user on
 * this machine.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** 200 bytes. Long enough for anything a person types, short enough to bound the event. */
export const MAX_UPLOAD_NAME_BYTES = 200;

/** A declared mime longer than this is not a mime. */
const MAX_MIME_CHARS = 128;

/**
 * How long a staged file nobody sent survives.
 *
 * Only the unconsumed have a TTL. Once a prompt names an upload it is referenced
 * by a `prompt` event and lives until that session's row is pruned — the only
 * lifetime that matches "this conversation still exists". Keying it on the event
 * would delete files while the session is open, because the log evicts a *prefix*.
 */
const UNCONSUMED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How often the sweep runs.
 *
 * **A timer, and not only the request paths.** `agentauth.ts` learned this with
 * an abandoned pty and the lesson transfers exactly: the state a TTL exists for
 * produces no activity. Somebody who attaches a file and closes the tab makes no
 * further request, so a sweep driven by traffic could never observe the one case
 * it was written for. Five minutes rather than agentauth's one, because a 24-hour
 * TTL does not need minute resolution and each pass reads a directory per session.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Every way a name can be unusable. */
export type UploadNameRejection = "empty" | "nul_byte" | "control_char" | "reserved" | "no_usable_characters";

export type UploadName = { ok: true; name: string } | { ok: false; reason: UploadNameRejection };

/** Windows reserved device names, which are still reserved with an extension. */
const DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Reduce a client-supplied filename to something storable.
 *
 * **This sanitizes where `safeRelPath` refuses, and the difference is the point
 * rather than an inconsistency.** `safeRelPath` guards a read of an existing tree,
 * so a bad path has nothing salvageable in it — the only correct answer is no.
 * Here the file is created inside a directory named by 64 fresh random bits that
 * came into existence a microsecond ago and that nothing else can name, so the
 * name is a **label, not a location**: it decides what a person sees in a chip and
 * in their Downloads folder, and rewriting it is right where refusing would only
 * be obstructive. Containment does not come from this function at all.
 *
 * What is still a refusal is anything that would be *dangerous* rather than ugly.
 * Control characters in particular: this string is echoed into a
 * `Content-Disposition` header on the way back out, and a CR there is response
 * splitting.
 *
 * Pure and exported so `daemoncheck` asserts the rules rather than a paraphrase.
 */
export function sanitizeUploadName(input: string): UploadName {
  if (input.length === 0) return { ok: false, reason: "empty" };
  if (input.includes("\0")) return { ok: false, reason: "nul_byte" };

  // The basename, off both separators. A browser's `File.name` has historically
  // carried a path on some platforms, so this is a legitimate file being given a
  // shorter name rather than an attack being refused — `../../etc/passwd` and
  // `C:\Users\me\b.png` both simply name a file.
  const segments = input.split(/[/\\]/).filter((part) => part.length > 0);
  let name = segments.at(-1) ?? "";
  if (name.length === 0) return { ok: false, reason: "no_usable_characters" };

  // eslint-disable-next-line no-control-regex -- that is precisely the point.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return { ok: false, reason: "control_char" };
  if (name === "." || name === "..") return { ok: false, reason: "reserved" };

  // Windows silently drops these, so a name that round-trips differently there is
  // a name that stops matching what was stored.
  name = name.replace(/[. ]+$/, "");
  if (name.length === 0) return { ok: false, reason: "no_usable_characters" };

  // Rejected on darwin too, on the same reasoning `safeRelPath` gives for
  // refusing `C:` here: the check is free and this daemon will not always run on
  // this platform. Prefixed rather than refused, because it is still a label.
  const stem = name.slice(0, name.indexOf(".") === -1 ? name.length : name.indexOf("."));
  if (DEVICE_NAMES.has(stem.toLowerCase())) name = `_${name}`;

  /*
   * ⚠ **The reserved-name refusal is applied to the *clipped* result, not only to
   * the input, and it has to be.** `clipName` keeps the extension and cuts the
   * stem, and the stem it takes runs to the **last** dot — so a name whose last
   * dot sits at index 1 under a leading dot collapses the stem to `"."`, while a
   * tail too long to be an extension throws the rest away. Measured:
   * `sanitizeUploadName(".." + "a".repeat(300))` returned `{ok: true, name: "."}`
   * — the exact value refused thirty lines above, handed back as accepted.
   *
   * Containment does not come from this function and did not break, so nothing
   * escaped a directory. What it produced is a stored name that is not a name:
   * `"."` resolves to the upload directory itself.
   */
  const clipped = clipName(name);
  if (clipped.length === 0 || clipped === "." || clipped === "..") {
    return { ok: false, reason: "reserved" };
  }

  return { ok: true, name: clipped };
}

/**
 * Shorten a name to the byte cap, keeping its extension.
 *
 * A **third** answer beside this codebase's existing two, and it is worth saying
 * why. `clip` appends `…[truncated N bytes]`, which is right for prose nobody
 * types and wrong for a name — the same asymmetry the command-name cap already
 * draws. But a command name is *refused* when it is too long, because a command
 * is invoked by sending it and a clipped one is broken rather than shorter. A
 * filename is neither invoked nor read as prose: it is a label, and a shortened
 * label still names the right file. Safe only because the response echoes the
 * original, so nothing is silently lost.
 */
function clipName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_UPLOAD_NAME_BYTES) return name;

  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 17 ? name.slice(dot) : "";
  const budget = MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(ext, "utf8");

  // Cut on a character boundary rather than a byte one: slicing a Buffer would
  // split a multi-byte codepoint and leave a replacement character in a name.
  let stem = name.slice(0, dot > 0 ? dot : name.length);
  while (stem.length > 0 && Buffer.byteLength(stem, "utf8") > budget) stem = stem.slice(0, -1);
  return `${stem}${ext}`;
}

/**
 * A `Content-Disposition` value that always saves and never injects.
 *
 * Two halves per RFC 6266: a quoted ASCII fallback for anything old, and
 * `filename*=UTF-8''` for the real name. The fallback strips `"` and `\` because
 * they end the quoted string, and strips controls because a CR or LF ends the
 * *header* — and this is reachable with a filename an **agent** chose, on the
 * workspace download route, where `safeRelPath` has rejected NUL but not CR.
 * `sanitizeUploadName` refuses controls on the way in; this is the other door.
 *
 * Always `attachment`. Never `inline`: see the header block in `server.ts` for
 * why a renderable response on this origin is a credential leak rather than an
 * XSS.
 */
export function contentDispositionFor(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the job.
  // A *run* of non-ASCII collapses to one `_`, rather than one per UTF-16 code
  // unit — an emoji is a surrogate pair, so per-unit substitution turns a
  // one-character name into `__` and a Cyrillic word into a row of underscores.
  // Only the legacy half is affected; the real name rides `filename*` below.
  const ascii = name.replace(/[\u0000-\u001f\u007f-\u009f"\\]/g, "").replace(/[^\x20-\x7e]+/g, "_");
  const fallback = ascii.length > 0 ? ascii : "download";
  // RFC 5987: percent-encode everything outside attr-char. `encodeURIComponent`
  // leaves `!'()*` alone, which are attr-char anyway apart from `'()*`; encoding
  // them too is harmless and keeps the value unambiguous.
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Where uploads live.
 *
 * `paths.ts`'s one `expandHome`, and the same absolute-path refusal as
 * `resolveWorktreeRoot`, because an operator who sets one will set the other the
 * same way. Dot-prefixed by default for the same reason too: `GET /fs/list`
 * hides it, so the directory picker does not offer somebody their own staging
 * area as a `cwd`.
 */
export function resolveUploadRoot(spec: string | undefined): string {
  const raw = (spec ?? "").trim();
  if (raw.length === 0) return join(homedir(), ".reemoat", "uploads");
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    throw new Error(`REEMOAT_UPLOAD_ROOT must be an absolute path, got "${raw}"`);
  }
  return expanded;
}

/**
 * Is this safe to use as one path component?
 *
 * Session ids come from the registry and never from a request, so this is
 * self-protection in exactly the sense `worktree.ts` means it: what it guards is
 * the `rm` below. A id shaped like `../escape` must remove nothing.
 */
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

/**
 * Whether this file is sent to the agent as bytes as well as as a link.
 *
 * Pure, and shared by `blocksFor` and by the `inlined` flag recorded on the
 * prompt event — one decision read twice rather than two that can disagree. It
 * takes no I/O, which is what lets the event be appended synchronously on a path
 * that must not await.
 */
export function inlinesImage(mime: string | null, bytes: number, caps: { image: boolean }): boolean {
  if (!caps.image) return false;
  if (mime === null || !mime.startsWith("image/")) return false;
  return bytes <= MAX_INLINE_IMAGE_BYTES;
}

/** A mime the client declared, or `undefined` when it declared something malformed. */
export function parseMime(header: string | undefined): string | null | undefined {
  const raw = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (raw.length === 0) return null;
  if (raw.length > MAX_MIME_CHARS) return undefined;
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(raw) ? raw : undefined;
}

export interface ReceiveRequest {
  /** Already through `sanitizeUploadName`. */
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

  private constructor(
    private readonly root: string,
    private readonly index: UploadIndex,
    private readonly onWarning: (detail: string) => void,
  ) {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // Housekeeping is never a reason for the process to stay alive.
    this.sweepTimer.unref();
  }

  /**
   * Open the root and reconcile it against the index.
   *
   * Async because of the reconciliation, which is what makes "the row is the
   * commit point" true rather than aspirational: a daemon killed mid-upload
   * leaves bytes with no row, and a database restored from a backup leaves rows
   * with no bytes. Both are resolved here, before anything can be served.
   */
  static async open(options: UploadsOptions): Promise<Uploads> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode applies only to directories it actually created and is
    // masked by the umask besides, so an upgrade into an existing 0755 directory
    // would keep the old bits. The same correction `openStores` carries.
    await chmod(options.root, 0o700).catch(() => {
      // A filesystem with no POSIX modes is not a reason to refuse to start —
      // `openStores` tolerates exactly this for the database itself.
    });

    const uploads = new Uploads(options.root, options.index, options.onWarning);
    await uploads.reconcile();
    return uploads;
  }

  /** The absolute path of a stored upload. */
  pathFor(row: UploadRow): string {
    return join(this.root, row.sessionId, row.uploadId, row.name);
  }

  /**
   * One upload, by the pair that identifies it.
   *
   * Both halves, always. An id belonging to another session reads as missing
   * rather than as forbidden — the same rule `sessionOf` follows one level up,
   * and what lets the routes answer without deciding between a 403 and a leak.
   */
  find(sessionId: string, uploadId: string): UploadRow | null {
    return this.index.get(sessionId, uploadId);
  }

  /**
   * Stream a body to disk, refusing past the limits.
   *
   * The byte counter here is the **only** bound on a request body anywhere in
   * this system: nothing in `src/`, the relay or the control plane configures a
   * body limit, and the relay pipes bodies straight through without buffering.
   * The route refuses a truthful `Content-Length` before calling this, so what is
   * left for the counter is chunked bodies and clients that lie.
   */
  async receive(sessionId: string, request: ReceiveRequest): Promise<ReceiveResult> {
    if (!safeSegment(sessionId)) {
      await cancelBody(request.body);
      return { kind: "write_failed", detail: "unusable session id" };
    }

    if (this.index.countFor(sessionId) >= MAX_UPLOADS_PER_SESSION) {
      await cancelBody(request.body);
      return { kind: "too_many" };
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
      // Cancelled like every other refusal here, and for the reason spelled out
      // below: a body nobody reads parks the sender against the relay's window
      // and the valve above it closes the whole tunnel for this machine.
      await cancelBody(request.body);
      return { kind: "write_failed", detail: describeError(error) };
    }

    let written = 0;
    let outcome: ReceiveResult | null = null;
    // `wx` is O_CREAT|O_EXCL: it never follows a link and never truncates. Inside
    // a directory a microsecond old that nothing else can name, the only way it
    // fails is a colliding id, which is a bug rather than a race to absorb.
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
        // Checked *before* the write, so at most one chunk past the limit is ever
        // in memory and none of it reaches the disk.
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

    if (outcome !== null) {
      await this.discard(dir);
      /*
       * Cancel **after** unlinking, and never not at all.
       *
       * The relay's per-stream HTTP/2 window is granted on consumption, so a
       * reader that simply stops parks the sender at 256 KiB with the browser
       * waiting. The next valve above that is the tunnel's 8 MiB socket-buffer
       * check, and it closes the **whole tunnel for this machine** rather than
       * this one request — every other session on it goes with it. Cancelling
       * releases the stream cleanly instead.
       */
      await cancelBody(request.body);
      return outcome;
    }

    /*
     * The limits, **again**, against what the index says now.
     *
     * The checks at the top of this method are read-then-write across every
     * `await` in the body loop, so on their own they are per-request bounds
     * rather than per-session ones: N concurrent uploads all sample the same
     * `priorBytes` and the same count, all pass, and all write. The relay allows
     * 256 concurrent streams per tunnel, so "100 MiB per session" was a number
     * one client could exceed by two orders of magnitude.
     *
     * Re-reading here costs nothing — the file is already on disk and this is
     * two synchronous queries — and it bounds the overshoot to the requests
     * genuinely in flight rather than leaving it open. The first check is kept
     * because it is the one that refuses *before* a phone spends its uplink.
     *
     * Not airtight, and the residue is written down rather than implied: two
     * uploads that finish between one another's re-read still both commit. The
     * airtight form is a conditional `INSERT … WHERE (SELECT SUM(bytes)…) + ? <=
     * ?` inside the store, which is a change to `UploadIndex` and to both of its
     * implementations; this closes the unbounded case without one.
     */
    const settledBytes = this.index.bytesFor(sessionId);
    if (settledBytes + written > MAX_SESSION_UPLOAD_BYTES) {
      await this.discard(dir);
      return { kind: "quota", used: settledBytes };
    }
    if (this.index.countFor(sessionId) >= MAX_UPLOADS_PER_SESSION) {
      await this.discard(dir);
      return { kind: "too_many" };
    }

    // Last, and deliberately: the row is the commit point. Bytes without one are
    // swept, which is what makes a crash mid-upload leave nothing serveable.
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
      // From the index rather than `priorBytes + written`: the re-read above is
      // what this session actually holds, and a client showing remaining room
      // should be told the truth rather than this request's arithmetic.
      sessionBytes: this.index.bytesFor(sessionId),
      sessionCount: this.index.countFor(sessionId),
    };
  }

  /**
   * Keep an image the agent handed back, instead of dropping it.
   *
   * **Synchronous in, asynchronous out**, and that shape is forced. The caller is
   * `session.ts`'s content-block renderer, which runs inside the agent's own RPC
   * handler — the emit path, which must never await. So this mints the id and
   * returns it immediately, and the write happens on its own. If the write fails
   * the download 404s and a warning is logged; the alternative, awaiting here,
   * would block the agent behind this daemon's disk.
   *
   * The row is inserted **already consumed**: it is referenced by an event the
   * moment it exists, so the unconsumed TTL must not reach it. What bounds it
   * instead is the same per-session ceiling user uploads have — an agent that
   * returns a thousand screenshots spends the session's budget and then stops
   * being able to, which is the honest failure.
   */
  keepAgentImage(sessionId: string, mime: string, data: string): UploadRow | null {
    if (!safeSegment(sessionId)) return null;
    if (this.index.countFor(sessionId) >= MAX_UPLOADS_PER_SESSION) return null;

    /*
     * **The agent's declared type is bounded here, and it was not.**
     *
     * `truncateEvent`'s `tool_call_update` arm spreads `images` through
     * untouched and justifies it by saying the field is bounded at ingest —
     * "the mime is the agent's declared one". This is that ingest, and until
     * this line the string was whatever the agent sent. ACP types `mimeType` as
     * a string and says nothing about its length, so a multi-megabyte one walked
     * an event past the 128 KiB per-event cap with nothing willing to shrink it,
     * and the log evicts a *prefix* — one malformed block would drop the
     * operator's own conversation. Exactly what `MAX_PARENT_ID_CHARS` exists to
     * prevent, one field over.
     *
     * The same `parseMime` the upload route uses, so there is one answer to what
     * a mime is rather than two. Refused rather than clipped: a clipped mime is
     * not a shorter type, it is a wrong one, and both `extensionForMime` and the
     * client's preview allowlist read it. The degradation is the documented one
     * — no ref, so the block renders as `[image]`.
     */
    const declared = parseMime(mime);
    if (declared === undefined || declared === null) return null;

    /*
     * The size is refused from the *encoded* length, before decoding.
     *
     * This runs inside the agent's notification handler — the emit path — so a
     * synchronous allocation of whatever the agent sent belongs here even less
     * than an await would. The quota test used to sit after `Buffer.from`, which
     * meant a 500 MiB image was fully decoded and then discarded. base64 is 4/3,
     * so the encoded length is a cheap upper bound on the decoded one.
     */
    if (data.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3)) return null;

    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return null;
    if (bytes.length > MAX_UPLOAD_BYTES) return null;
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

    // Fire and forget, deliberately. See the docblock: this is the emit path.
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
      // The row is already on the event, so the honest outcome is a download that
      // 404s rather than a transcript that lies about having had the image.
      this.onWarning(`could not store an agent image: ${describeError(error)}`);
      try {
        this.index.remove(row.sessionId, row.uploadId);
      } catch {
        // Nothing further to do; the sweep's reconciliation will find it.
      }
    }
  }

  /**
   * Look up the uploads a prompt named.
   *
   * Synchronous, so the prompt route can refuse before any state moves — and
   * keyed on the pair, so an id belonging to another session is missing rather
   * than forbidden. There is nothing to leak and nothing to decide.
   */
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
      // The prompt has already been accepted; failing it now would be worse than
      // an upload that expires on the unconsumed TTL while still referenced.
      this.onWarning(`could not mark uploads consumed: ${describeError(error)}`);
    }
  }

  /**
   * The content blocks these files become.
   *
   * Every attachment gets a `resource_link` and that is the block that is never
   * wrong: ACP requires every agent to support `text` and `resource_link`, which
   * is exactly why the composer's paperclip needs no capability gate. `file://`
   * rather than an HTTP URL, because the agent runs as this user on this machine
   * and can open the path — an HTTP URL would need a token it does not have.
   *
   * An `image` block is added on top when the agent said it takes one. On top
   * rather than instead: the link is what lets the agent re-read the file with
   * its own tools, and dropping it would make an inlined image the one attachment
   * the agent cannot open.
   */
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
        // The file went away between the upload and the prompt. The link is still
        // in the prompt and the agent will report it cannot read it, which is a
        // better outcome than failing the whole turn.
        this.onWarning(`could not inline ${row.name}: ${describeError(error)}`);
      }
    }
    return blocks;
  }

  /** Everything staged for one session, rows and bytes. */
  async forgetSession(sessionId: string): Promise<void> {
    if (!safeSegment(sessionId)) {
      this.onWarning(`refusing to remove uploads for an unusable session id`);
      return;
    }
    await this.discard(join(this.root, sessionId));
    try {
      this.index.removeSession(sessionId);
    } catch (error) {
      this.onWarning(`could not clear upload rows: ${describeError(error)}`);
    }
  }

  async forgetSessions(sessionIds: readonly string[]): Promise<void> {
    for (const id of sessionIds) await this.forgetSession(id);
  }

  /**
   * Only the files nobody sent, for a session that is staying.
   *
   * **The distinction this draws is the one at the top of this file.** A worktree
   * is a git checkout somebody may remove; an upload is staged input that has to
   * outlive that, which is the entire reason the two roots are disjoint. So
   * `DELETE /sessions/:id/workspace` may reclaim what was never sent — a file
   * somebody attached and then abandoned — and must not touch what a `prompt`
   * event names, because the session row and its transcript both survive the
   * removal. Deleting those produced the one thing this design is against: a
   * transcript describing a file that cannot be fetched, from an ordinary
   * cleanup action.
   *
   * The consumed ones keep the lifetime `schema.sql` states for them: no TTL,
   * gone when the session row is pruned.
   */
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

  /**
   * Remove a directory under the root, and nothing else.
   *
   * The **second** `rm` site in this codebase, and every rule the first one wrote
   * is copied here on purpose rather than approximately. `containedIn` resolves
   * both sides through `realpath` before comparing segment-wise, and the
   * `lstat` refusal above it is the mirror of `worktree.ts`'s: a symlink where a
   * session's directory should be would redirect this removal anywhere the daemon
   * can write, and an upload id is guessable from a transcript.
   */
  private async discard(dir: string): Promise<void> {
    let real: ReturnType<typeof lstatSync>;
    try {
      real = lstatSync(dir);
    } catch {
      // Never created, or already gone. Both are the state we wanted.
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

  /** Drop rows with no bytes, and bytes with no row. */
  private async reconcile(): Promise<void> {
    /*
     * Sessions where a row could not be checked, and which are therefore left
     * entirely alone below.
     *
     * See the errno test in the loop: "could not tell" must not become "gone" in
     * either direction. Dropping the row is one half of that and skipping the
     * directory pass is the other, because that pass derives `known` from the
     * index — so a row we declined to remove is fine, but a row we *did* remove
     * on a bad answer would make its bytes unknown and get them deleted.
     */
    const unsure = new Set<string>();
    for (const sessionId of this.index.listSessions()) {
      for (const row of this.index.listFor(sessionId)) {
        try {
          lstatSync(this.pathFor(row));
        } catch (error) {
          /*
           * **Only "it is not there" may delete anything.**
           *
           * This was a bare `catch`, so EACCES, EIO, ETIMEDOUT and EMFILE — a
           * briefly unresponsive mount, a mode change, descriptor exhaustion at
           * boot — all read as ENOENT. The row went, and the second pass then
           * saw its bytes as unknown and `rm -rf`'d them: one transient error at
           * startup permanently destroying intact files, with every `prompt`
           * event that names them 404ing for ever.
           *
           * The same three-answer rule the rest of this codebase follows.
           * `probeExists` returns `true | false | null` and `removeWorkspace`
           * refuses to `rm` on `null` because "the one `rmSync` must never run
           * against a path we could not even stat". This is the second `rm` site
           * and it now says the same thing.
           */
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            // Genuinely gone. The row would otherwise describe an attachment
            // that cannot be downloaded and would go on spending the budget.
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
      // A session with a row we could not check: `known` would be missing an
      // entry we have no evidence against, and acting on it deletes bytes.
      if (unsure.has(sessionId)) continue;
      const known = new Set(this.index.listFor(sessionId).map((row) => row.uploadId));
      let entries: string[];
      try {
        entries = await readdir(join(this.root, sessionId));
      } catch {
        // Not a directory, or unreadable. Left alone rather than guessed at.
        continue;
      }
      for (const uploadId of entries) {
        if (known.has(uploadId)) continue;
        // Bytes with no row: an upload interrupted between the write and the
        // insert, which is exactly what the commit-point ordering produces.
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

/** A file extension for a declared image type. Narrow, because the input is. */
function extensionForMime(mime: string): string {
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const subtype = type.startsWith("image/") ? type.slice("image/".length) : "";
  if (subtype === "jpeg") return ".jpg";
  if (subtype === "svg+xml") return ".svg";
  return /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ".bin";
}

/**
 * Release a request body this daemon is not going to read.
 *
 * **Never not at all**, on any path that refuses. The relay's per-stream HTTP/2
 * window is granted on consumption, so a reader that simply stops parks the
 * sender at 256 KiB with the browser waiting; the next valve above that is the
 * tunnel's 8 MiB socket-buffer check, and it closes the **whole tunnel for this
 * machine** rather than this one request — every other session on it goes too.
 * Cancelling releases the stream cleanly instead.
 *
 * A function rather than an inline `.catch` at each site because there are eight
 * of them across this file and `server.ts`, and the one that gets forgotten is
 * the one that takes the fleet down.
 */
export async function cancelBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (!body) return;
  await body.cancel().catch(() => {
    // The client hung up first, which is the ordinary way this happens.
  });
}

