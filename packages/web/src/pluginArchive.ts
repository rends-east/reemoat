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

/**
 * The one refusal both readers make, written once.
 *
 * The tar walk and the zip walk reach it independently — the zip path returns
 * before it ever gets to `finish` — so it was typed out twice, and two copies of
 * a sentence somebody reads before deciding whether to install something is one
 * rewording away from the two paths refusing the same fact differently.
 */
const TWO_MANIFESTS = "that archive holds more than one plugin.json and nothing can say which one would be installed";

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
 *
 * ⚠ **Exported for one reason: so a driver can hold it against the number the
 * paragraph above says it is.** Nothing compared the two, and the direction that
 * goes wrong is silent — an `archive.ts` that raises `maxUnpackedBytes` leaves this
 * reader as exactly the second, stricter gate that paragraph forbids, and the
 * symptom is a plugin the daemon takes happily arriving on the screen as
 * "unreadable", which reads as a broken archive rather than as a stale constant.
 */
export const MAX_PEEK_BYTES = 8 * 1024 * 1024;

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
  /*
   * The guard `peekZip` already makes, on the path that did not have it — and it
   * is **not** the stricter second gate {@link MAX_PEEK_BYTES}'s own docblock
   * forbids: `PLUGIN_LIMITS.maxBytes` is 2 MiB, so an archive whose *compressed*
   * bytes are already over this ceiling is four times past what the daemon will
   * take on the wire, and nothing that would install is refused here. What it buys
   * is that an oversized pick costs no decompressor at all, rather than one that
   * is built, fed and then abandoned at the charge below.
   */
  if (blob.size > MAX_PEEK_BYTES) return { kind: "unreadable", reason: "that archive is larger than a plugin may be" };
  // Streamed rather than buffered whole, so the ceiling above is a bound on what
  // is ever held rather than a check made after holding it — `unpackArchive`
  // charges its own stream the same way, and for the same reason.
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();

  /*
   * ⚠ **One buffer with a read cursor, and it is a measurement rather than a
   * tidy-up.** This held one `Uint8Array` that was reallocated on every chunk
   * (`held = concat(held, value)`) and re-cut on every member consumed
   * (`held = held.slice(padded)` — `slice` *copies*, it is not `subarray`), so both
   * loops were quadratic in the size of the archive, and the ceiling above is
   * 8 MiB. Measured on the machine this was developed on, medians of five, at that
   * ceiling: **390 ms → 18 ms** for an archive that is one large member, and
   * **42 ms → 15 ms** for one that is 16 thousand header-only ones. Neither shape
   * is exotic — the first is any plugin carrying a bundle, the second is any
   * archive of many small files — and this runs on a phone, on the consent screen,
   * with nothing sent anywhere yet: the one moment somebody is waiting on this
   * reader and on nothing else.
   *
   * `start` is the first unread byte and `end` is one past the last one held, which
   * is why every field below is read at `start + …`. The prefix the walk has
   * consumed is reclaimed only when it is at least as large as what remains, so a
   * compaction never copies more bytes than the cursor already gave back; anything
   * else doubles. Those two together are what make the walk linear rather than
   * merely cheaper.
   */
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
            // Never `held.byteLength` again, or a chunk that fits after compaction
            // but failed the test above allocates a same-sized buffer and asks the
            // same question on the next read.
            let capacity = held.byteLength === 0 ? TAR_BLOCK : held.byteLength * 2;
            while (capacity < live + value.byteLength) capacity *= 2;
            // Always a fresh, unshared buffer, never the chunk itself: a stream
            // chunk's backing store is `ArrayBufferLike` (it may be shared), and
            // everything below indexes into this one as a plain `ArrayBuffer`.
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

      // Walk every whole header (and its body) currently held, and keep the rest.
      for (;;) {
        if (end - start < TAR_BLOCK) break;
        /*
         * ⚠ **The end of a tar is an all-zero block, never an empty name**, and
         * this is `archive.ts:879` transcribed rather than paraphrased. Reading it
         * as "the name field came back empty" made a member named with three
         * spaces terminate this walk while the daemon carried on past it — one
         * header that meant *stop* to the screen somebody consents from and
         * *another member* to the thing installing. Everything after it was
         * described to nobody. `tarString` losing its `.trim()` is the other half.
         */
        if (held.subarray(start, start + TAR_BLOCK).every((byte) => byte === 0)) return finish(best);
        const stem = tarString(held.subarray(start, start + 100));
        const size = tarOctal(held.subarray(start + 124, start + 136));
        // Base-256, which this reader will not guess at. See {@link tarOctal}.
        if (size === null) {
          return {
            kind: "unreadable",
            reason: "that archive uses a binary size field this screen cannot follow",
          };
        }
        const typeflag = String.fromCharCode(held[start + 156] ?? 0);
        const padded = TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
        if (end - start < padded) break;

        /*
         * ⚠ **Two ways this reader used to spell a name differently from the
         * daemon, and both of them were spoofs.**
         *
         * The first is the ustar `prefix` field. `extractTgz` composes
         * `prefix + "/" + stem` when it is set; this read the 100-byte stem alone,
         * so a member with stem `plugin.json` and prefix `sub` previewed as a
         * *root* manifest while the daemon wrote it to `sub/plugin.json` — and a
         * real root `plugin.json` elsewhere in the archive was what actually
         * installed.
         *
         * The second is the pax `x` and GNU `L` long-name headers, which the
         * daemon honours as an override on the member that follows. Carrying that
         * state here would be a second parser to keep in step; refusing is the
         * answer this file already gives for anything it cannot name exactly, and
         * it costs the operator the named "Install without reading it" path rather
         * than a wrong description. `K` and `g` go with them: a linkname override
         * and a global header are both constructs this reader does not follow.
         */
        if (typeflag === "x" || typeflag === "L" || typeflag === "K" || typeflag === "g") {
          return {
            kind: "unreadable",
            reason: "that archive uses extended tar headers this screen cannot follow",
          };
        }
        const prefix = tarString(held.subarray(start + 345, start + 500));
        const name = prefix.length > 0 ? `${prefix}/${stem}` : stem;

        // Plain files only. A directory has no body worth reading and everything
        // else — symlink, hardlink, device — is refused by the daemon anyway, so
        // reading one here could only preview a manifest that will not install.
        // `7` is contiguous, which `unpackArchive` writes out as a file: a
        // typeflag this reader skipped and the daemon accepted was a second way
        // to be shown one manifest and sent another. See {@link isNoise}.
        const spelled = canonical(name) ?? name;
        if ((typeflag === "0" || typeflag === "\0" || typeflag === "7") && isManifestPath(name)) {
          // Depth and the tie are both read off the canonical spelling: two names
          // that reach the same path are the same candidate, not two of them.
          const depth = depthOf(spelled);
          if (best === null || depth < best.depth) {
            // ⚠ **`slice`, and it has to stay one.** The buffer below the cursor
            // is reused and compacted in place, so a `subarray` here would be a
            // view onto bytes a later chunk overwrites — a manifest that changes
            // after it was read is the one failure this whole file exists to
            // prevent, and it would land on the screen rather than in a crash.
            best = { depth, name: spelled, body: held.slice(start + TAR_BLOCK, start + TAR_BLOCK + size), rival: false };
          } else if (depth === best.depth) {
            /*
             * Two candidates at the same depth, and **the name no longer has to
             * differ** for this to be a refusal.
             *
             * Different names are the original case: `findManifestRoot` takes a
             * root `plugin.json`, or the single top-level directory holding one,
             * and answers `null` for anything else — so there is no tie to break
             * here either, and guessing is exactly how this reader comes to
             * describe a manifest that is not the one installed.
             *
             * The *same* canonical name is the case the old `name !== best.name`
             * let through, and it arrived with `canonical`: two members that
             * normalise to one path — `plugin.json` and `./plugin.json` — are two
             * writes to the same file, which the daemon refuses outright because
             * it opens members `O_EXCL`. Describing the first of them would be
             * describing an archive that cannot install.
             */
            best.rival = true;
          }
        }
        start += padded;
        /*
         * ⚠ **No early return on depth 0.** It said "nothing later can beat it",
         * which is true of *depth* and false of the thing that matters: a second
         * root `plugin.json` later in the archive is not a worse candidate, it is
         * the tie `finish` refuses — and stopping here meant it was never seen.
         * The whole archive is walked, which it was going to be anyway on every
         * input that did not happen to put the manifest first.
         */
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

  /*
   * ⚠ **Bounded by the central directory's declared *size*, and walked by
   * signature — never by the entry count.** This read `total entries` at
   * `eocd + 10` and stopped there; `extractZip` reads only `offset` and `size`,
   * hands `readZipMembers` a buffer of exactly `cdSize`, and walks `SIG_CENTRAL`
   * until that buffer ends. So an archive declaring one entry while carrying three
   * inside `cdSize` was read as one member here and as three by the daemon: the
   * consent screen described a benign nested manifest and the machine installed
   * an evil root one holding every scope plus `permission.requested`. Reproduced
   * end-to-end against both readers; the daemon's own `parseManifest` accepts the
   * evil manifest.
   *
   * The count is still read, and disagreement is a refusal rather than a
   * preference: a zip whose header and whose contents describe different archives
   * is one this screen cannot honestly speak for, whichever of the two is "right".
   */
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
    /*
     * ⚠ **Refused rather than read past the directory**, the other half of
     * `archive.ts`'s refusal for the same record. `bytes` is the whole file here,
     * not just the central directory, so an over-declared `nameLen` ran on into
     * the trailing EOCD record and produced `plugin.json` plus four bytes of
     * junk — a name this reader then declined, while the daemon's own read of the
     * same field is bounded by its directory-sized buffer and got `plugin.json`.
     * One manifest on the screen, a different one installed. The count check below
     * cannot see it: the record is counted on both sides.
     */
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
      // See the tar walker: the daemon breaks no tie and refuses a duplicate
      // member outright, so neither of those may be resolved here.
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
  // The zip path reaches `read` without going through `finish`, so the refusal
  // `finish` makes for a tie has to be made here as well.
  if (best.rival) {
    return { kind: "unreadable", reason: TWO_MANIFESTS };
  }

  const method = view.getUint16(best.at + 10, true);
  const compressed = view.getUint32(best.at + 20, true);
  const uncompressed = view.getUint32(best.at + 24, true);
  const local = view.getUint32(best.at + 42, true);
  /*
   * ⚠ **0xffffffff is not a size and not an offset — it is "the real one is in the
   * zip64 extra field", and this reader does not go and get it.** `readZipMembers`
   * does: it reads the extra positionally through `readZip64Extra` and substitutes
   * whichever of the two were saturated, so a member the daemon locates and unpacks
   * correctly is one this reader would slice with a length of four gigabytes or from
   * an offset four gigabytes into an 8 MiB file.
   *
   * Both of those *happen* to land on "unreadable" today — the slice runs to the end
   * of the file and `read` fails on the JSON, or the guard below trips on the local
   * header — and that is the whole argument for making the refusal explicit instead:
   * the safety is an accident of the wrong read producing garbage rather than
   * something parseable, which is exactly what was **not** true of the size field
   * {@link tarOctal} describes: there the wrong read produced a perfectly good
   * manifest at the wrong offset, and it was found by a differential run rather than
   * by anybody reasoning about it.
   *
   * Refusing rather than decoding is the answer this file gives to the `x`, `L`, `K`
   * and `g` headers and to GNU base-256, for the same reason: a second implementation
   * of a decoder is a second thing that has to stay in step with `archive.ts`, and
   * the cost of refusing is the named "Install without reading it" press rather than
   * a wrong description. A saturated *uncompressed* size needs no arm of its own —
   * it is only positional information to `readZip64Extra`, and nothing here reads it
   * except the ceiling one line down, which refuses 0xffffffff on its own terms.
   */
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
    return { kind: "unreadable", reason: TWO_MANIFESTS };
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
  return readManifestText(utf8(body));
}

/**
 * The same reader, for a `plugin.json` that did not come out of an archive.
 *
 * ⚠ **Exported so the market's consent screen uses this reader and no other.**
 * There the manifest arrives as text from `raw.githubusercontent.com` at the
 * commit the catalogue pinned, and the disclosure drawn from it is the one
 * somebody agrees to. A second reader would be a second set of rules about what
 * an absent `scopes` means and a second wording for "this cannot be read" — on
 * the two screens in this app where those sentences matter most, and where they
 * must agree.
 *
 * The archive walkers reach it through {@link read}, which is the same function
 * with the bytes decoded. Everything the docblock above says about leniency
 * applies unchanged: this fails open into empty values and never invents one.
 */
export function readManifestText(json: string): ArchivePeek {
  let parsed: unknown;
  try {
    // Named `json` rather than `text`, because `text()` is this module's own
    // narrowing helper and a parameter of that name shadows it three lines down.
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
    },
  };
}

/**
 * A member's name as **the daemon will spell it**, or `null` for one this reader
 * may not describe.
 *
 * ⚠ **The half that was missing, and it was a spoof rather than a nuisance.**
 * `safeMemberPath` drops empty and `.` segments before it joins, so the member
 * `plugin.json/.` lands on disk as a root-level regular file `plugin.json` — while
 * this reader compared the raw name, matched neither of its two arms, and left it
 * out of the candidates entirely. An archive holding a benign `wrap/plugin.json`
 * beside an evil `plugin.json/.` therefore showed the benign one under the plain
 * "Install it" button and installed the other. Reproduced end-to-end against both
 * readers, with a zip `unzip -t` and Python's `zipfile` both call well-formed.
 * `./plugin.json/.` is the same trick with one more segment.
 *
 * Backslashes are never translated — `safeMemberPath`'s rule, and for its reason:
 * a member called `a\b/plugin.json` is one name, not two.
 */
function canonical(name: string): string | null {
  const out: string[] = [];
  for (const segment of name.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    // The daemon refuses rather than normalising, so this must not describe it.
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

/**
 * A NUL-terminated tar field, as text.
 *
 * ⚠ **No `.trim()`, and its absence is the whole of this function.** `archive.ts`
 * does not trim, and a name of three spaces is therefore a *member* to the daemon
 * and was the *empty string* here — which the walk below read as the terminating
 * zero block. So the browser stopped at that member and the daemon walked past it,
 * and every member after it was invisible on the screen somebody consents from
 * while being perfectly visible to the thing doing the installing. Trimming is
 * also what made the size field's base-256 spelling look like ordinary text; see
 * {@link tarOctal}.
 *
 * The only reader either side has to agree with is the other one, so this is a
 * transcription of `archive.ts`'s `tarString` rather than a tidier version of it.
 */
function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8(end < 0 ? bytes : bytes.subarray(0, end));
}

/**
 * A tar numeric field, or `null` for one this reader will not guess at.
 *
 * ⚠ **`null` for GNU base-256, because guessing produced a different archive.**
 * When bit 7 of the first byte is set the field is not octal text at all — it is
 * a big-endian integer, which `archive.ts`'s `tarNumber` decodes and this stripped
 * to nothing and read as zero. A size of zero advances the walk by one block
 * instead of past the member, so the next "header" it read was 512 bytes of
 * somebody's *file body* — where a synthetic root `plugin.json` and a zero block
 * are cheap to plant. The screen then showed that manifest and the daemon
 * installed the real one further down.
 *
 * Refusing rather than decoding is the same answer this file already gives to the
 * `x`, `L`, `K` and `g` headers a few lines up, for the same reason: a second
 * implementation of a decoder is a second thing that has to stay in step, and the
 * cost of refusing is the named "Install without reading it" press rather than a
 * wrong description of what somebody is about to run.
 *
 * ⚠ **The octal branch is a transcription rather than a cleanup, and the cleanup
 * was the sixth divergence.** This read `tarString(bytes).replace(/[^0-7]/g, "")`
 * — strip everything that is not an octal digit, then parse what is left — while
 * `tarNumber` hands `parseInt` the whole field and lets it stop at the first byte
 * that is not one. The two disagree on any field holding a non-octal byte *before*
 * a digit: for `0x0000003000` the daemon stops at the `x` and reads **0**, and
 * stripping read **1536**. A size of zero advances the walk by one block and a
 * size of 1536 advances it by four, so from that member on the two readers are
 * reading headers at different offsets — the same desync the base-256 case above
 * describes, reached through the branch that was supposed to be the safe one.
 * Neither reader checks the header checksum, so the field costs nothing to plant.
 *
 * So: latin1 (a high byte later in the field is one character here as it is
 * there), the same `\0` cut, the same `trim()`, the same `parseInt`. `archive.ts`
 * is the only reader this one has to agree with, and agreement is spelled by
 * copying it.
 */
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
