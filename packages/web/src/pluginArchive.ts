/* ──────────────────────────────────────────────────────────────────────────
 * Reading a plugin's manifest out of its archive, in the browser, before the
 * archive is sent anywhere.
 *
 * ⚠ **This exists so that consent happens before the daemon acts, and it is the
 * only reason it exists.** `SECURITY.md` says the blast radius is "named before
 * somebody consents to it" and `protocol.ts` used to say the scope list is "shown
 * at install" — neither was true. The old flow picked a file and POSTed it: the
 * archive was unpacked, the manifest validated, the row written and the plugin
 * *started* before a single scope reached a human, who then read them on the row
 * of a plugin already running. The copy above the button said "Read what it may
 * reach before you install it" and there was nothing to read.
 *
 * The decision was that the confirmation has to come **before the daemon unpacks
 * anything**, because after that there is nothing left for a person to decide.
 * That rules out asking the daemon: the manifest is inside the archive, so the
 * only reader that can run before the upload is this one. The cost is that
 * archive-walking logic now exists twice — here and in `src/archive.ts` — and the
 * two are not shared, because `packages/web` is a separate bundle that may not
 * import from `src/` (the same reason `wire.ts` is a hand mirror).
 *
 * ⚠ **What this is NOT is a validator.** It reads leniently and the daemon
 * refuses authoritatively — exactly the split `plugins.ts` uses for a view. A
 * manifest this file misreads is one `parseManifest` will still refuse on
 * arrival; a manifest this file cannot read at all is reported as such rather
 * than guessed at, because a consent screen that invents what it is consenting to
 * is worse than one that admits it does not know.
 *
 * DOM-free on purpose, so `webcheck` can import it. `Blob`, `DecompressionStream`
 * and `Response` are all in Node too, which is what makes that possible.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What a person is shown before they agree to install.
 *
 * Every field is optional-shaped rather than validated: this is a *description*
 * of what the archive claims, and the daemon is what decides whether the claim is
 * a manifest. `scopes` and `net` are raw strings for that reason — a scope this
 * client has not heard of must still be shown, legibly, rather than dropped from
 * the very list it exists to disclose.
 */
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
}

export type ArchivePeek =
  | { kind: "ok"; manifest: ManifestPreview }
  /**
   * The archive could not be read *here*. Never a refusal — the daemon is the
   * authority and may well accept it. It means only that this screen cannot say
   * what the plugin asks for, which is a thing the person deciding needs told.
   */
  | { kind: "unreadable"; reason: string };

/**
 * What this reader will decompress before giving up.
 *
 * Deliberately the daemon's own unpacked ceiling (`PLUGIN_LIMITS.maxUnpackedBytes`)
 * rather than something smaller: a plugin the daemon would accept must be one this
 * screen can describe, or the consent step becomes a second, stricter gate that
 * refuses things the machine would have taken. Restated rather than imported for
 * `wire.ts`'s reason, and it is a bound on *this* reader rather than a claim about
 * the archive.
 */
const MAX_PEEK_BYTES = 8 * 1024 * 1024;

/** A tar header block, and the only two member kinds worth walking into. */
const TAR_BLOCK = 512;

/**
 * How deep `plugin.json` may be. One, matching `findManifestRoot`: an archive of
 * loose members and an archive of one folder are both what somebody who
 * compressed a directory produces, and nothing deeper is searched by the daemon
 * either — so searching deeper here would preview a manifest the daemon will not
 * find.
 */
const MAX_MANIFEST_DEPTH = 1;

export async function peekPluginArchive(blob: Blob): Promise<ArchivePeek> {
  let head: Uint8Array;
  try {
    head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  } catch {
    // A `File` whose backing store went away — the user moved or deleted it
    // between choosing it and this read. Nothing to recover, and the upload would
    // fail for the same reason.
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

/* ── tar.gz ──────────────────────────────────────────────────────────────── */

async function peekTarGz(blob: Blob): Promise<ArchivePeek> {
  // Streamed rather than buffered whole, so the ceiling above is a bound on what
  // is ever held rather than a check made after holding it — `unpackArchive`
  // charges its own stream the same way, and for the same reason.
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();

  let held = new Uint8Array(0);
  let seen = 0;
  let best: { depth: number; name: string; body: Uint8Array; rival: boolean } | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        seen += value.byteLength;
        if (seen > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that archive is larger than a plugin may be" };
        held = concat(held, value);
      }

      // Walk every whole header (and its body) currently held, and keep the rest.
      for (;;) {
        if (held.byteLength < TAR_BLOCK) break;
        const name = tarString(held.subarray(0, 100));
        // Two zero blocks end a tar; one is enough to know there is no more.
        if (name.length === 0) return finish(best);
        const size = tarOctal(held.subarray(124, 136));
        const typeflag = String.fromCharCode(held[156] ?? 0);
        const padded = TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
        if (held.byteLength < padded) break;

        // Plain files only. A directory has no body worth reading and everything
        // else — symlink, hardlink, device — is refused by the daemon anyway, so
        // reading one here could only preview a manifest that will not install.
        // `7` is contiguous, which `unpackArchive` writes out as a file: a
        // typeflag this reader skipped and the daemon accepted was a second way
        // to be shown one manifest and sent another. See {@link isNoise}.
        if ((typeflag === "0" || typeflag === "\0" || typeflag === "7") && isManifestPath(name)) {
          const depth = depthOf(name);
          if (best === null || depth < best.depth) {
            best = { depth, name, body: held.slice(TAR_BLOCK, TAR_BLOCK + size), rival: false };
          } else if (depth === best.depth && name !== best.name) {
            // Two candidates the daemon would have to choose between, and it does
            // not: `findManifestRoot` takes a root `plugin.json`, or the single
            // top-level directory holding one, and answers `null` for anything
            // else. So there is no tie to break here either — guessing is exactly
            // how this reader comes to describe a manifest that is not the one
            // installed.
            best.rival = true;
          }
        }
        held = held.slice(padded);
        // Depth 0 is the shallowest there is, so nothing later can beat it.
        if (best?.depth === 0) return finish(best);
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

/* ── zip ─────────────────────────────────────────────────────────────────── */

async function peekZip(blob: Blob): Promise<ArchivePeek> {
  if (blob.size > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that archive is larger than a plugin may be" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record is last, after a comment of up to 64 KiB.
  // Scanned backwards because that is where it is, and bounded because a file
  // that is not a zip must not cost a whole-file scan.
  const floor = Math.max(0, bytes.byteLength - (0xffff + 22));
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { kind: "unreadable", reason: "that zip has no central directory" };

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  let best: { depth: number; name: string; at: number; rival: boolean } | null = null;

  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const name = utf8(bytes.subarray(at + 46, at + 46 + nameLen));
    if (isManifestPath(name)) {
      const depth = depthOf(name);
      if (best === null || depth < best.depth) best = { depth, name, at, rival: false };
      // See the tar walker: the daemon breaks no tie, so neither may this.
      else if (depth === best.depth && name !== best.name) best.rival = true;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (best === null) return finish(null);
  // The zip path reaches `read` without going through `finish`, so the refusal
  // `finish` makes for a tie has to be made here as well.
  if (best.rival) {
    return { kind: "unreadable", reason: "that archive holds more than one plugin.json and nothing can say which one would be installed" };
  }

  const method = view.getUint16(best.at + 10, true);
  const compressed = view.getUint32(best.at + 20, true);
  const uncompressed = view.getUint32(best.at + 24, true);
  if (uncompressed > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that plugin.json is implausibly large" };
  const local = view.getUint32(best.at + 42, true);
  if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== 0x04034b50) {
    return { kind: "unreadable", reason: "that zip's entry does not point at a file" };
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const raw = bytes.slice(start, start + compressed);

  if (method === 0) return read(raw);
  if (method !== 8) return { kind: "unreadable", reason: "that zip uses a compression this browser cannot read" };
  /*
   * ⚠ **Charged per chunk, never after the body is whole.** `uncompressed` above
   * is the size the archive declares about itself, so checking it and then
   * calling `.arrayBuffer()` bounded nothing: a member declaring a hundred bytes
   * can inflate to gigabytes, and at the 8 MiB compressed ceiling a routine ratio
   * is enough to take the tab down. The victim is whoever is *evaluating* an
   * untrusted archive — the person this screen exists to protect, before anything
   * has been sent anywhere. `peekTarGz` already charges its stream this way, and
   * `net.fetch` says the same thing in `src/plugins/api.ts`.
   */
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

/* ── shared ──────────────────────────────────────────────────────────────── */

function finish(best: { body: Uint8Array; rival: boolean } | null): ArchivePeek {
  if (best === null) return { kind: "unreadable", reason: "that archive has no plugin.json at its top level" };
  if (best.rival) {
    return { kind: "unreadable", reason: "that archive holds more than one plugin.json and nothing can say which one would be installed" };
  }
  return read(best.body);
}

/**
 * The manifest, read for display.
 *
 * ⚠ **Every narrowing here fails open**, `plugins.ts`'s rule on a third schedule:
 * a field of the wrong type becomes its empty value and nothing throws, because a
 * screen that refused to draw would send somebody back to installing blind. What
 * it may never do is *invent* — an absent `scopes` shows as an empty list, which
 * the caller draws as "it asks for nothing", and that is the truth about a
 * manifest with no scopes.
 */
function read(body: Uint8Array): ArchivePeek {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8(body));
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
    },
  };
}

function isManifestPath(name: string): boolean {
  // Backslashes are never translated — `safeMemberPath`'s rule, and for its
  // reason: a member called `a\b/plugin.json` is one name, not two.
  const clean = name.replace(/\/+$/, "");
  if (isNoise(clean)) return false;
  return clean === "plugin.json" || (clean.endsWith("/plugin.json") && depthOf(clean) <= MAX_MANIFEST_DEPTH);
}

/**
 * The members `unpackArchive` throws away, refused here for the same reason it
 * skips them — and this is the half that had to agree.
 *
 * ⚠ **A reader that counts a member the daemon discards is not lenient, it is
 * describing a different archive.** Measured: an archive holding both
 * `__MACOSX/plugin.json` and `real/plugin.json` showed *no scopes at all* on the
 * consent screen while the daemon dropped `__MACOSX` as noise, resolved `real/`,
 * and installed and started a manifest declaring every scope plus
 * `permission.requested` — which together are enough to answer every permission
 * an agent raises on the machine. Leniency is allowed to say "I cannot read
 * this"; it is never allowed to describe the wrong manifest, because the whole
 * point of this file is that nothing is sent until somebody has read what the
 * plugin asks for.
 *
 * Kept as a copy of `isNoiseMember` rather than shared, because `packages/web`
 * may not import from `src/` — `wire.ts`'s standing reason.
 */
function isNoise(path: string): boolean {
  const segments = path.split("/");
  if (segments[0] === "__MACOSX") return true;
  const leaf = segments.at(-1) ?? "";
  return leaf === ".DS_Store" || leaf === "Thumbs.db" || leaf.startsWith("._");
}

function depthOf(name: string): number {
  return name.replace(/\/+$/, "").split("/").length - 1;
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8(end < 0 ? bytes : bytes.subarray(0, end)).trim();
}

function tarOctal(bytes: Uint8Array): number {
  const parsed = Number.parseInt(tarString(bytes).replace(/[^0-7]/g, ""), 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function concat(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  // Always a fresh buffer, never the chunk itself: a stream chunk's backing store
  // is `ArrayBufferLike` (it may be shared), and every reader below indexes into
  // it as a plain `ArrayBuffer`.
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
