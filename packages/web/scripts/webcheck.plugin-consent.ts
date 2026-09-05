import { readFileSync, readdirSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhat somebody is shown before a plugin is sent anywhere\n");
{
  const { peekPluginArchive, MAX_PEEK_BYTES } = await import("../src/pluginArchive.js");
  const { consentBroken } = await import("../src/plugins.js");
  const { gzipSync, deflateRawSync, crc32 } = await import("node:zlib");

  const MANIFEST = JSON.stringify({
    id: "board",
    name: "Task board",
    version: "0.3.0",
    api: 2,
    description: "One card per session.",
    scopes: ["sessions.read", "store"],
    net: ["api.example.com"],
    contributes: {
      screen: { title: "Board" },
      settings: true,
      actions: [{ id: "advance", title: "Move card on", on: "session" }],
      hooks: ["turn.ended"],
    },
  });

  /*
   * Two archive writers, small enough to read, and separate from the import
   * section's for its reason: that one exists to write archives no honest tool
   * would produce, and coupling a consent screen's happy path to a fixture whose
   * job is to be malformed would be reading the wrong thing.
   */
  const tarOf = (files: Record<string, string>): Buffer => {
    const parts: Buffer[] = [];
    for (const [name, body] of Object.entries(files)) {
      const data = Buffer.from(body, "utf8");
      const head = Buffer.alloc(512);
      head.write(name, 0, "utf8");
      head.write("000644 \0", 100);
      head.write("000000 \0", 108);
      head.write("000000 \0", 116);
      head.write(data.length.toString(8).padStart(11, "0") + " ", 124);
      head.write("00000000000 ", 136);
      head.write("        ", 148);
      head.write("0", 156);
      head.write("ustar\0", 257);
      head.write("00", 263);
      let sum = 0;
      for (const byte of head) sum += byte;
      head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      parts.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
  };

  const zipOf = (files: Record<string, string>): Buffer => {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let at = 0;
    for (const [name, body] of Object.entries(files)) {
      const raw = Buffer.from(body, "utf8");
      const packed = deflateRawSync(raw);
      const named = Buffer.from(name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(raw), 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(named.length, 26);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(crc32(raw), 16);
      entry.writeUInt32LE(packed.length, 20);
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt16LE(named.length, 28);
      entry.writeUInt32LE(at, 42);
      locals.push(local, named, packed);
      central.push(entry, named);
      at += local.length + named.length + packed.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(at, 16);
    return Buffer.concat([Buffer.concat(locals), directory, end]);
  };

  const peek = (bytes: Buffer): ReturnType<typeof peekPluginArchive> =>
    peekPluginArchive(new Blob([bytes as unknown as BlobPart]));

  const flat = await peek(tarOf({ "plugin.json": MANIFEST, "server.js": "export {}" }));
  check(
    "a .tar.gz says what the plugin asks for, before anything is sent",
    flat.kind === "ok" ? [flat.manifest.id, flat.manifest.scopes, flat.manifest.net] : flat,
    ["board", ["sessions.read", "store"], ["api.example.com"]],
  );
  check(
    "including what it will be told, which asks for no scope at all",
    flat.kind === "ok" ? [flat.manifest.hooks, flat.manifest.screen, flat.manifest.settings] : flat,
    [["turn.ended"], "Board", true],
  );

  const folded = await peek(tarOf({ "board/plugin.json": MANIFEST, "board/server.js": "export {}" }));
  check("an archive holding one folder reads the same", folded.kind === "ok" ? folded.manifest.id : folded, "board");

  const zipped = await peek(zipOf({ "plugin.json": MANIFEST, "server.js": "export {}" }));
  check("and a .zip does too, since the daemon takes both", zipped.kind === "ok" ? zipped.manifest.id : zipped, "board");

  const deep = await peek(tarOf({ "a/b/plugin.json": MANIFEST }));
  check(
    "nothing deeper than the daemon itself will look for",
    deep.kind,
    "unreadable",
  );

  /*
   * ⚠ **Unreadable is never a refusal, and it may never be a guess.** The daemon
   * is the authority and takes shapes this reader may not, so refusing here would
   * make the browser a second and stricter gate. What it may not do is invent —
   * hence a reason, and a caller that draws the reason rather than an empty list.
   */
  const garbage = await peek(Buffer.from("this is not an archive at all"));
  check("something that is not an archive says so", garbage.kind === "unreadable" ? garbage.reason : garbage, "that is not a .tar.gz or a .zip");
  const broken = await peek(tarOf({ "plugin.json": "{not json" }));
  check("and so does a plugin.json that will not parse", broken.kind === "unreadable" ? broken.reason : broken, "that plugin.json is not valid JSON");

  /*
   * A manifest declaring nothing must read as declaring nothing, never as
   * unreadable: "it asks for nothing" is a true and useful thing to show, and
   * conflating it with "I cannot tell" would put the weakest plugin behind the
   * scariest sentence.
   */
  const bare = await peek(tarOf({ "plugin.json": JSON.stringify({ id: "x", name: "X", version: "1.0.0" }) }));
  check(
    "a plugin that asks for nothing reads as asking for nothing",
    bare.kind === "ok" ? [bare.manifest.scopes, bare.manifest.hooks, bare.manifest.net, bare.manifest.adds] : bare,
    [[], [], [], []],
  );

  /*
   * ⚠ **The two lines that are the disclosure *and* the comparison, which is the
   * whole reason they are strings rather than objects.** `consentGap` on the daemon
   * and `consentBroken` on the way back are set differences over exactly these, so
   * what a person reads and what is checked are one value — there is no second
   * rendering of the same fact to drift. It is also why the *whole* address appears
   * rather than an origin: a plugin showing `https://api.groq.com` and shipping
   * `https://api.groq.com/../evil` would pass an origin comparison.
   *
   * Read leniently, like everything else here: this reader may fail to describe an
   * archive and may never invent one, and what it must not do is *under*-report.
   */
  const adding = await peek(
    tarOf({
      "plugin.json": JSON.stringify({
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        api: 5,
        scopes: ["harness", "system"],
        contributes: {
          harnesses: [{ id: "gemini", name: "Gemini", command: "gemini", args: ["acp"] }],
          systems: [{ id: "groq", name: "Groq", baseUrl: "https://api.groq.com/anthropic" }],
        },
      }),
    }),
  );
  check(
    "what a plugin adds is one line each, and the line names the argv and the address",
    adding.kind === "ok" ? adding.manifest.adds : adding,
    ["harness gemini runs gemini acp", "system groq sends keys to https://api.groq.com/anthropic"],
  );
  /*
   * ⚠ **A provider with no endpoint says so rather than being left out.** Its key
   * box is its own harness's, so nothing is sent anywhere by the daemon — but a
   * blank in a disclosure reads as an absence, and this is the one place a person
   * finds out the plugin adds a provider at all.
   */
  const native = await peek(
    tarOf({
      "plugin.json": JSON.stringify({
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        api: 5,
        scopes: ["system"],
        contributes: { systems: [{ id: "zen", name: "Zen" }] },
      }),
    }),
  );
  check(
    "a provider this daemon sends nothing to still appears",
    native.kind === "ok" ? native.manifest.adds : native,
    ["system zen sends keys to nowhere"],
  );
  /*
   * ⚠ **The address is normalised here because it is normalised there, and this
   * caught a real defect** — a manifest writing `https://api.groq.com/anthropic/`,
   * which is the ordinary way somebody writes a base URL, produced one string here
   * and another in `parseManifest`, so `consentGap` answered *"that commit asks for
   * more than was shown"* about a plugin that had asked for exactly what was shown.
   * An alarm that cries wolf is the one failure this whole path is written against.
   *
   * Driven against the daemon's own reader rather than against a literal, which is
   * the only form of this assertion that cannot drift: the two functions are in two
   * packages that may not import each other, and what has to hold is that they agree.
   */
  {
    const { parseManifest } = await import("../../../src/plugins/manifest.js");
    const { addedLines } = await import("../../../src/plugins/source.js");
    const { readManifestText } = await import("../src/pluginArchive.js");
    const differed: string[] = [];
    for (const baseUrl of [
      "https://api.groq.com/anthropic/",
      "https://api.groq.com/a/../evil",
      "https://api.groq.com",
      "http://127.0.0.1:11434/v1/",
    ]) {
      const json = JSON.stringify({
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        api: 5,
        scopes: ["system"],
        contributes: {
          systems: [
            {
              id: "groq",
              name: "Groq",
              apiType: "anthropic",
              baseUrl,
              authHeader: { name: "authorization", prefix: "Bearer " },
              models: [{ id: "m", name: "M" }],
            },
          ],
        },
      });
      const parsed = parseManifest(json);
      if (!parsed.ok) {
        differed.push(`${baseUrl}: refused`);
        continue;
      }
      const here = readManifestText(json);
      const drawn = here.kind === "ok" ? here.manifest.adds : ["unreadable"];
      if (JSON.stringify(drawn) !== JSON.stringify(addedLines(parsed.manifest))) differed.push(baseUrl);
    }
    check("what this screen draws is the string the daemon compares, address for address", differed, []);
  }

  /*
   * ⚠ **The ceiling is charged against what the decompressor produced**, not
   * against what arrived — the whole point being that a few kilobytes on the wire
   * must not become eight megabytes in a phone's tab.
   */
  const bomb = (() => {
    const head = Buffer.alloc(512);
    const data = Buffer.alloc(12 * 1024 * 1024, 0x41);
    head.write("filler.bin", 0, "utf8");
    head.write("000644 \0", 100);
    head.write("000000 \0", 108);
    head.write("000000 \0", 116);
    head.write(data.length.toString(8).padStart(11, "0") + " ", 124);
    head.write("00000000000 ", 136);
    head.write("        ", 148);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const byte of head) sum += byte;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return gzipSync(Buffer.concat([head, data, Buffer.alloc(1024)]));
  })();
  check(
    "a small archive that unpacks to a large one is stopped at the ceiling",
    (await peek(bomb)).kind === "unreadable",
    true,
  );

  /* ---------------------------------------------------------------- *
   * Archives built to be described wrongly.
   *
   * ⚠ **Every fixture above is an archive an honest tool would produce, and that
   * is why this whole class was invisible.** `tarOf` writes a name at offset 0
   * and nothing else; `zipOf` declares a truthful entry count. So four ways for
   * this reader to spell a member's name differently from `src/archive.ts` sat
   * unasserted, and each of them is the same defect: the consent screen describes
   * one manifest and the machine installs another. All four were reproduced
   * end-to-end against both readers before these were written.
   *
   * The rule they pin is one sentence, and it is `isNoise`'s: **leniency may say
   * "I cannot read this"; it may never describe the wrong manifest.** So two
   * outcomes are correct here and a third is not — refusing is fine, naming the
   * member the way the daemon will is fine, and quietly showing a different
   * member is the bug.
   * ---------------------------------------------------------------- */

  /** `tarOf`, plus the header fields an honest tar writer also uses. */
  const tarWith = (
    members: readonly {
      name: string;
      body: string;
      prefix?: string;
      typeflag?: string;
      /**
       * The twelve raw bytes of the size field, for a fixture that has to spell a
       * size the way an archiver would rather than the way this helper does —
       * which today means GNU base-256. Written over the octal below, so the
       * padding and the checksum are still computed the same way.
       */
      sizeField?: Buffer;
    }[],
  ): Buffer => {
    const parts: Buffer[] = [];
    for (const member of members) {
      const data = Buffer.from(member.body, "utf8");
      const head = Buffer.alloc(512);
      head.write(member.name, 0, "utf8");
      head.write("000644 \0", 100);
      head.write("000000 \0", 108);
      head.write("000000 \0", 116);
      head.write(data.length.toString(8).padStart(11, "0") + " ", 124);
      if (member.sizeField !== undefined) member.sizeField.copy(head, 124, 0, 12);
      head.write("00000000000 ", 136);
      head.write("        ", 148);
      head.write(member.typeflag ?? "0", 156);
      head.write("ustar\0", 257);
      head.write("00", 263);
      // The field this reader did not read. `extractTgz` composes
      // `prefix + "/" + stem`, which is how a tar carries a path over 100 bytes.
      if (member.prefix !== undefined) head.write(member.prefix, 345, "utf8");
      let sum = 0;
      for (const byte of head) sum += byte;
      head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      parts.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
  };

  const EVIL = JSON.stringify({
    id: "evil",
    name: "Evil",
    version: "1.0.0",
    api: 1,
    scopes: ["sessions.read", "sessions.write", "files.read", "store"],
    contributes: { hooks: ["permission.requested"] },
  });

  // 1. The ustar prefix. Stem `plugin.json`, prefix `sub` — a *nested* member that
  //    read as a root one, so the real root manifest beside it never won.
  const prefixed = await peek(
    tarWith([
      { name: "plugin.json", body: EVIL, prefix: "sub" },
      { name: "plugin.json", body: MANIFEST },
      { name: "server.js", body: "export {}" },
    ]),
  );
  check(
    "a member's ustar prefix is part of its name, so the root manifest is the root one",
    prefixed.kind === "ok" ? prefixed.manifest.id : `unreadable: ${prefixed.kind}`,
    "board",
  );

  // 2. The long-name headers. Refused rather than followed: carrying the override
  //    would be a second parser to keep in step with `extractTgz`.
  const longName = await peek(
    tarWith([
      { name: "././@LongLink", body: "plugin.json\0", typeflag: "L" },
      { name: "decoy.json", body: EVIL },
      { name: "server.js", body: "export {}" },
    ]),
  );
  check("an extended tar header is refused rather than guessed past", longName.kind, "unreadable");

  // 3. The early return that used to stop at the first depth-0 candidate, so a
  //    second root manifest later in the archive was never seen.
  const twoRoots = await peek(
    tarWith([
      { name: "plugin.json", body: MANIFEST },
      { name: "server.js", body: "export {}" },
      { name: "./plugin.json", body: EVIL },
    ]),
  );
  check("a second root manifest is still a tie, however late it arrives", twoRoots.kind, "unreadable");

  /** `zipOf`, with the freedom to lie in the end record the way `zipOf` cannot. */
  const zipLying = (files: Record<string, string>, declare: number): Buffer => {
    const honest = zipOf(files);
    const end = honest.length - 22;
    honest.writeUInt16LE(declare, end + 8);
    honest.writeUInt16LE(declare, end + 10);
    return honest;
  };

  // 4. The entry count. `extractZip` reads only the directory's offset and size
  //    and walks by signature, so a forged count hid two of three members here.
  const miscounted = await peek(
    zipLying({ "wrap/plugin.json": MANIFEST, "plugin.json": EVIL, "server.js": "export {}" }, 1),
  );
  check("a zip whose directory holds more than it declares is refused", miscounted.kind, "unreadable");

  // 5. The dot segments `safeMemberPath` drops before it joins. `plugin.json/.`
  //    is a root-level regular file to the daemon and was invisible here.
  const dotted = await peek(
    zipOf({ "wrap/plugin.json": MANIFEST, "wrap/server.js": "export {}", "plugin.json/.": EVIL, "server.js": "export {}" }),
  );
  check(
    "a name that normalises to the root manifest is read as the root manifest",
    dotted.kind === "ok" ? dotted.manifest.id : `unreadable: ${dotted.kind}`,
    "evil",
  );
  check(
    "and what it asks for is what the machine would be asked to grant",
    dotted.kind === "ok" ? dotted.manifest.scopes : null,
    ["sessions.read", "sessions.write", "files.read", "store"],
  );

  // 6. The GNU base-256 size field. `tarNumber` decodes it and `tarOctal` stripped
  //    it to nothing and read zero, so this walk advanced one block instead of
  //    past the member and resumed inside somebody's file body — where a synthetic
  //    root manifest and a zero block are cheap to plant. Refused, like the long
  //    names above, rather than decoded a second time.
  const base256 = Buffer.alloc(12);
  base256[0] = 0x80;
  base256.writeUInt32BE(Buffer.byteLength(EVIL, "utf8"), 8);
  const binarySize = await peek(
    tarWith([
      { name: "wrap/plugin.json", body: MANIFEST },
      { name: "wrap/server.js", body: "export {}" },
      { name: "big.bin", body: EVIL, sizeField: base256 },
      { name: "server.js", body: "export {}" },
    ]),
  );
  check("a binary tar size field is refused rather than read as zero", binarySize.kind, "unreadable");

  // 7. The member named with spaces. `tarString` trimmed and an empty name ended
  //    the walk, so this stopped where `extractTgz` carried on — and everything
  //    after it was described to nobody. The end of a tar is an all-zero block.
  const spacedName = await peek(
    tarWith([
      { name: "wrap/plugin.json", body: MANIFEST },
      { name: "wrap/server.js", body: "export {}" },
      { name: "   ", body: "not a terminator" },
      { name: "plugin.json", body: EVIL },
      { name: "server.js", body: "export {}" },
    ]),
  );
  check(
    "a member named with spaces does not end the walk, so the root manifest still wins",
    spacedName.kind === "ok" ? spacedName.manifest.id : `unreadable: ${spacedName.kind}`,
    "evil",
  );
  check(
    "and it is that manifest's scopes on the screen",
    spacedName.kind === "ok" ? spacedName.manifest.scopes : null,
    ["sessions.read", "sessions.write", "files.read", "store"],
  );

  /** `zipOf`, with the last directory record claiming a name that runs off the end. */
  const zipOverrunning = (files: Record<string, string>): Buffer => {
    const honest = zipOf(files);
    const end = honest.length - 22;
    const cdOffset = honest.readUInt32LE(end + 16);
    const cdSize = honest.readUInt32LE(end + 12);
    let at = cdOffset;
    let last = cdOffset;
    while (at + 46 <= cdOffset + cdSize && honest.readUInt32LE(at) === 0x02014b50) {
      last = at;
      at += 46 + honest.readUInt16LE(at + 28) + honest.readUInt16LE(at + 30) + honest.readUInt16LE(at + 32);
    }
    honest.writeUInt16LE(honest.readUInt16LE(last + 28) + 4, last + 28);
    return honest;
  };

  // 8. The over-declared central-directory name. `central` is directory-sized on
  //    the daemon so `subarray` clamped and it read `plugin.json`; this slices the
  //    same field out of the whole file and ran into the trailing end record,
  //    getting four bytes of junk on the name and declining it. Both refuse now.
  const overrun = await peek(
    zipOverrunning({ "wrap/plugin.json": MANIFEST, "wrap/server.js": "export {}", "plugin.json": EVIL }),
  );
  check("a zip directory entry that runs past the directory is refused", overrun.kind, "unreadable");

  /*
   * 9. The size field the daemon reads as octal and this reader tidied.
   *
   * ⚠ **The first eight cases each pin one reader against a literal, and a literal
   * keeps agreeing with a rule that has moved.** This one runs the same bytes
   * through *both* real readers and compares, which is the only shape that can see
   * a divergence nobody thought to hand-write a case for — and it is how this one
   * was found, after five had been.
   *
   * The field is `0x0000003000`. `tarNumber` hands the whole thing to `parseInt`,
   * which stops at the `x` and reads 0; this reader stripped every non-octal byte
   * first and read 0o3000 = 1536. Zero advances the walk one block and 1536
   * advances it four, so from that member on the two are reading headers at
   * different offsets — the screen described `benign` while the daemon installed
   * `evil` with six scopes and a `permission.requested` hook. Neither reader checks
   * the header checksum, so the field costs nothing to plant.
   */
  {
    const { unpackArchive, PLUGIN_LIMITS } = await import("../../../src/archive.js");
    const { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    /*
     * ⚠ **The ceiling this reader stops at is the daemon's own, restated by hand,
     * and until now nothing held the two together.** `MAX_PEEK_BYTES`'s own docblock
     * calls it "the daemon's own unpacked ceiling (`PLUGIN_LIMITS.maxUnpackedBytes`)
     * rather than something smaller", because a plugin the daemon would accept must
     * be one this screen can describe — and the copy is there for `wire.ts`'s reason,
     * that `packages/web` may not import from `src/`. This block already holds both
     * files open, so the claim costs one line to check.
     *
     * The direction that goes wrong is silent and it is a *raise* over there: this
     * reader then becomes exactly the second, stricter gate that paragraph forbids,
     * and the symptom on the phone is an archive the machine takes happily arriving
     * as "unreadable" — which reads as a broken download rather than as a stale
     * constant. Lowering `maxUnpackedBytes` is the harmless direction and fails here
     * too, on purpose: one number, asserted, beats two that agree today.
     */
    check("the consent screen's ceiling is the daemon's own", MAX_PEEK_BYTES, PLUGIN_LIMITS.maxUnpackedBytes);

    /** `findManifestRoot`'s rule, restated: the tree, or one directory inside it. */
    const daemonInstalls = async (bytes: Buffer): Promise<string> => {
      const staging = mkdtempSync(join(tmpdir(), "peek-parity-"));
      try {
        const out = await unpackArchive({
          staging,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(bytes));
              controller.close();
            },
          }),
          limits: PLUGIN_LIMITS,
        });
        if (out.kind !== "ok") return "refused";
        let at: string | null = existsSync(join(out.tree, "plugin.json")) ? out.tree : null;
        if (at === null) {
          const top = readdirSync(out.tree, { withFileTypes: true });
          const only = top.length === 1 && top[0]?.isDirectory() === true ? top[0].name : null;
          at = only !== null && existsSync(join(out.tree, only, "plugin.json")) ? join(out.tree, only) : null;
        }
        if (at === null) return "refused";
        const read = JSON.parse(readFileSync(join(at, "plugin.json"), "utf8")) as { id?: unknown };
        return String(read.id ?? "?");
      } catch {
        // A refusal spelled as a throw is still a refusal, and this comparison only
        // cares which manifest the daemon would name.
        return "refused";
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    };

    /*
     * One member whose size the two readers disagree about, and a body holding two
     * manifests — the daemon's at offset 0, because it reads the size as 0 and
     * takes the next block as a header, and this reader's at 1536, because it read
     * 0o3000. Both are real, checksummed tar members; the only crafted byte is the
     * size field. Measured before the fix: the screen said `board` with no scopes
     * while the daemon installed `evil` with four and a `permission.requested`
     * hook.
     */
    const head = (name: string, size: number, sizeField?: Buffer): Buffer => {
      const h = Buffer.alloc(512);
      h.write(name, 0, "utf8");
      h.write("000644 \0", 100);
      h.write("000000 \0", 108);
      h.write("000000 \0", 116);
      h.write(size.toString(8).padStart(11, "0") + " ", 124);
      if (sizeField !== undefined) sizeField.copy(h, 124, 0, 12);
      h.write("00000000000 ", 136);
      h.write("        ", 148);
      h.write("0", 156);
      h.write("ustar\0", 257);
      h.write("00", 263);
      let sum = 0;
      for (const byte of h) sum += byte;
      h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      return h;
    };
    const one = (name: string, body: string): Buffer => {
      const data = Buffer.from(body, "utf8");
      return Buffer.concat([head(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
    };
    // Exactly 1536, so what this reader lands on is the member after it.
    const forDaemon = Buffer.concat([one("plugin.json", EVIL), Buffer.alloc(512)]);
    const inner = Buffer.concat([forDaemon, one("plugin.json", MANIFEST), one("server.js", "export {}"), Buffer.alloc(1024)]);
    const tidied = Buffer.alloc(12);
    tidied.write("0x0000003000", 0, "latin1");
    const crafted = gzipSync(
      Buffer.concat([head("pad.bin", inner.length, tidied), inner, Buffer.alloc((512 - (inner.length % 512)) % 512), Buffer.alloc(1024)]),
    );

    /*
     * ⚠ **Three shapes that exist because the tar walk is a cursor over one reused
     * buffer now**, and not one of the fixtures above is big enough to notice.
     * `peekTarGz` held a single `Uint8Array` reallocated on every chunk and re-cut on
     * every member consumed; it grows by doubling and compacts in place, and the
     * archives that can tell those two apart are the ones where the buffer is reused
     * *under* the walk. Every archive in this comparison fitted in the first
     * allocation, so the whole rewrite was covered by a differential that never left
     * it.
     *
     * Counted against the reader in this tree, with both branches instrumented: the
     * four hundred members compact 24 times and grow the buffer once, the straddled
     * manifest grows it 8 times and compacts once, and the large one grows 9 and
     * compacts once. A shape that exercises neither branch pins nothing here, which
     * is the whole of what was wrong with the five rows this list started as.
     *
     * The same four hundred members go through as a **zip** as well, which walks a
     * directory rather than a cursor and so exercises none of the above: it is here
     * because a member count is the one thing both readers hold an opinion about,
     * and the forged-count case above (4) only ever drove a count of three.
     *
     * All four sit inside the daemon's own limits on purpose — 500 entries, 2 MiB
     * on the wire, 8 MiB unpacked — because a fixture past any of them makes the
     * right-hand side "refused" and turns this into a comparison about limits rather
     * than about the walk.
     */
    const crowded: Record<string, string> = { "plugin.json": MANIFEST };
    for (let i = 0; i < 398; i += 1) crowded[`f${i}.txt`] = `file ${i}\n`;
    /*
     * The filler is *another manifest*, repeated, rather than a megabyte of one
     * letter: what a stale read of the buffer would find has to be something a
     * reader could believe, or this fixture only ever proves that garbage is not
     * JSON. `EVIL` is the same decoy the spelling cases above plant.
     */
    const decoy = EVIL.repeat(Math.ceil(1_500_000 / EVIL.length));
    const straddling = tarOf({
      "wrap/a.bin": decoy,
      "wrap/plugin.json": MANIFEST,
      "wrap/b.bin": decoy,
      "wrap/server.js": "export {}",
    });

    const cases: [string, Buffer][] = [
      ["a size field the two spelled differently", crafted],
      ["four hundred members", tarOf(crowded)],
      ["a manifest with a megabyte and a half either side of it", straddling],
      ["one large enough to be reallocated several times", tarOf({ "plugin.json": MANIFEST, "bundle.js": "x".repeat(3_000_000), "assets.bin": "y".repeat(2_500_000) })],
      ["four hundred members in a zip", zipOf(crowded)],
      ["the plainest archive there is", tarOf({ "plugin.json": MANIFEST, "server.js": "export {}" })],
      ["one folded into a directory", tarOf({ "board/plugin.json": MANIFEST, "board/server.js": "export {}" })],
      ["noise beside a real one", tarOf({ "__MACOSX/plugin.json": EVIL, "real/plugin.json": MANIFEST, "real/server.js": "export {}" })],
      ["a zip", zipOf({ "plugin.json": MANIFEST, "server.js": "export {}" })],
    ];

    const disagreed: string[] = [];
    for (const [name, bytes] of cases) {
      const screen = await peek(bytes);
      const said = screen.kind === "ok" ? screen.manifest.id : "refused";
      const installed = await daemonInstalls(bytes);
      /*
       * Leniency in exactly one direction: this reader may say it cannot describe
       * an archive the daemon would take — that costs the named "Install without
       * reading it" press. It may never describe a *different* manifest, which is
       * the whole of what the consent screen is for.
       */
      if (said !== "refused" && said !== installed) disagreed.push(`${name}: screen said ${said}, daemon installs ${installed}`);
    }
    check("what the screen describes is what the daemon would install", disagreed, []);

    /*
     * ⚠ **The half of that the differential cannot see, and the reason is its own
     * leniency rule.** `said !== "refused"` is what lets this reader admit it cannot
     * describe an archive the daemon would take — and a manifest that was read
     * correctly and then *overwritten* comes back as exactly that, a refusal, so the
     * comparison above waves it through while the screen has stopped being able to
     * say what anybody is installing.
     *
     * The buffer below the cursor is compacted in place (`copyWithin`) as later
     * members arrive, so the body kept for the winning candidate has to be a `slice`
     * and may never be a `subarray` — a view onto bytes a later chunk overwrites is
     * a manifest that changes after it was read. Measured against this fixture with
     * that one call changed back: `unreadable: that plugin.json is not valid JSON`,
     * because the compaction that runs while `wrap/b.bin` is walked copies live
     * bytes over the region the view still points at. It does not come back as
     * `evil` and could not — the view is exactly the winning manifest's length and
     * the decoy is longer — which is why this is a literal check rather than another
     * row in `cases`.
     */
    const straddled = await peek(straddling);
    check(
      "a manifest read early survives the buffer being reused under it",
      straddled.kind === "ok" ? [straddled.manifest.id, straddled.manifest.scopes] : `unreadable: ${straddled.reason}`,
      ["board", ["sessions.read", "store"]],
    );

    /*
     * 10. The zip64 saturated fields — and this one is inside the block rather than
     *     beside the eight literals above because the load-bearing half of it is
     *     what the *daemon* answers, which needs the harness.
     *
     * ⚠ **0xffffffff in a central-directory record is not a size and not an offset.**
     * It means "the real one is in the zip64 extra field", `readZipMembers` goes and
     * gets it through `readZip64Extra`, and this reader does not — so the machine
     * locates and unpacks a member this screen would slice with a length of four
     * gigabytes, or from an offset four gigabytes into an 8 MiB file.
     *
     * Both already answered "unreadable" before there was an arm for it, and that is
     * the whole argument for adding one rather than leaving it. Measured against a
     * copy of this reader with the arm taken out, on these exact two fixtures: a
     * saturated *offset* gives "that zip's entry does not point at a file", and a
     * saturated *compressed size* gives "Trailing junk found after the end of the
     * compressed stream" — a raw zlib string reaching a consent screen through
     * `describe(error)`, about an archive the daemon installs perfectly. The safety
     * was an accident of what the wrong read happened to decode to, which is exactly
     * what was **not** true of the size field case 9 is about: there the wrong read
     * produced a perfectly good manifest at the wrong offset.
     *
     * So each is asserted with the daemon's own answer beside it: this reader
     * refuses in the one sentence it chose, and the machine takes the archive. That
     * pair is what a *deliberate* leniency looks like, and it is the only shape that
     * would notice this becoming a refusal on both sides — a plugin nobody can
     * install rather than one nobody can preview.
     */
    const zip64Of = (saturate: "compressed" | "offset"): Buffer => {
      const raw = Buffer.from(MANIFEST, "utf8");
      const packed = deflateRawSync(raw);
      const named = Buffer.from("plugin.json", "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      // 45 is the version zip64 needs, and it is what an archiver writes here.
      local.writeUInt16LE(45, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(raw), 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(named.length, 26);
      /*
       * The extra carries only the fields the record saturated, in the order the
       * format fixes — original size, compressed size, offset — which is why
       * `readZip64Extra` reads it positionally off the same three booleans. One
       * saturated field is one 8-byte body.
       */
      const extra = Buffer.alloc(12);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(saturate === "compressed" ? packed.length : 0), 4);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(45, 6);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(crc32(raw), 16);
      entry.writeUInt32LE(saturate === "compressed" ? 0xffffffff : packed.length, 20);
      // Uncompressed stays honest in both: it is positional input to the extra and
      // nothing else here reads it, so saturating it would only move the goalposts.
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt16LE(named.length, 28);
      entry.writeUInt16LE(extra.length, 30);
      entry.writeUInt32LE(saturate === "offset" ? 0xffffffff : 0, 42);
      const locals = Buffer.concat([local, named, packed]);
      const directory = Buffer.concat([entry, named, extra]);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(1, 8);
      end.writeUInt16LE(1, 10);
      end.writeUInt32LE(directory.length, 12);
      end.writeUInt32LE(locals.length, 16);
      return Buffer.concat([locals, directory, end]);
    };

    const wideSize = await peek(zip64Of("compressed"));
    check(
      "a zip64 compressed size is refused rather than followed",
      wideSize.kind === "unreadable" ? wideSize.reason : `ok: ${wideSize.manifest.id}`,
      "that zip uses zip64 fields this screen cannot follow",
    );
    check("and it is an archive the daemon installs, which is why refusing is the whole answer", await daemonInstalls(zip64Of("compressed")), "board");

    const wideOffset = await peek(zip64Of("offset"));
    check(
      "a zip64 local offset is refused in the same sentence",
      wideOffset.kind === "unreadable" ? wideOffset.reason : `ok: ${wideOffset.manifest.id}`,
      "that zip uses zip64 fields this screen cannot follow",
    );
    check("and the daemon installs that one too", await daemonInstalls(zip64Of("offset")), "board");
  }

  /*
   * ...and the half that does not depend on this reader having been right.
   *
   * Four spellings diverged before anybody looked; `consentBroken` is what catches
   * the fifth. It compares only *gained* authority, because a reader that was
   * generous costs nobody anything and a reader that was blind costs the operator
   * the whole point of the screen.
   */
  const shown = { scopes: ["sessions.read"], net: [], hooks: ["turn.ended"], adds: [] };
  check(
    "a plugin that installed exactly what it showed says nothing",
    consentBroken(shown, { scopes: ["sessions.read"], net: [], contributes: { hooks: ["turn.ended"] } }),
    null,
  );
  check(
    "one that gained a scope says so",
    consentBroken(shown, { scopes: ["sessions.read", "sessions.write"], net: [], contributes: { hooks: ["turn.ended"] } }),
    "That plugin asked for more than this screen showed: sessions.write. Remove it unless you know why.",
  );
  check(
    "a host and a hook are named too, and in one sentence",
    consentBroken(shown, {
      scopes: ["sessions.read"],
      net: ["exfil.example.com"],
      contributes: { hooks: ["turn.ended", "permission.requested"] },
    }),
    "That plugin asked for more than this screen showed: network access to exfil.example.com; permission.requested. Remove it unless you know why.",
  );
  check(
    "and a plugin that ended up with less than it showed is not a broken consent",
    consentBroken(shown, { scopes: [], net: [], contributes: { hooks: [] } }),
    null,
  );
  /*
   * ⚠ **The fourth compared field, and the two largest things this screen can
   * show.** A harness is a program the machine will run as its owner on every
   * session started with it; a provider is a host a key pasted here is sent to. A
   * row that came back holding one the screen did not draw is exactly what this
   * function exists to catch, and it was the one gap the three above could not see
   * — `consentGap` on the daemon refuses first, and this is the half that does not
   * depend on having predicted the failure.
   */
  check(
    "a plugin that came back adding an agent nobody was shown says so, and names what it runs",
    consentBroken(shown, {
      scopes: ["sessions.read"],
      net: [],
      contributes: {
        hooks: ["turn.ended"],
        harnesses: [{ id: "gemini", command: "gemini", args: ["acp"] }],
        systems: [{ id: "groq", baseUrl: "https://api.groq.com/anthropic" }],
      },
    }),
    "That plugin asked for more than this screen showed: harness gemini runs gemini acp; " +
      "system groq sends keys to https://api.groq.com/anthropic. Remove it unless you know why.",
  );
  check(
    "and one that came back with exactly what was drawn says nothing",
    consentBroken(
      { ...shown, adds: ["harness gemini runs gemini acp"] },
      {
        scopes: ["sessions.read"],
        net: [],
        contributes: { hooks: ["turn.ended"], harnesses: [{ id: "gemini", command: "gemini", args: ["acp"] }] },
      },
    ),
    null,
  );
  /*
   * ⚠ **Absent on the installed side must mean *none*, not *unknown*.** A daemon
   * older than this tab sends no such field — and it also refuses a manifest that
   * declares one, so "it did not say" and "there are none" really are the same fact
   * there. Reading absence as unknown and refusing would take every install on
   * every un-updated machine down over a field they cannot send.
   */
  check(
    "and a daemon too old to describe its contributions is not a breach",
    consentBroken(shown, { scopes: ["sessions.read"], net: [], contributes: { hooks: ["turn.ended"] } }),
    null,
  );

  /* ---------------------------------------------------------------- *
   * The rules that live only in a component, asserted against its source.
   *
   * `webcheck` has no DOM, so these are read the way `Composer.tsx`'s are. Each
   * one fails silently and in a direction nobody would notice from a screenshot,
   * which is why a source assertion is worth more here than it looks.
   * ---------------------------------------------------------------- */
  const screenSrc = readFileSync(new URL("../src/ui/PluginScreen.tsx", import.meta.url), "utf8");
  report(
    "the view is cleared on a switch and never on a refresh",
    /if \(round === 0\) setView\(null\)/.test(screenSrc),
    "round === 0 guard on setView",
  );
  /*
   * ⚠ **This was `/if \(live && round === 0\) setError/` and the guard has widened
   * by exactly one clause — the property it protects is unchanged and the sentence
   * it was written under is the one that expired.** A *clock* tick that fails still
   * leaves the board alone, which is the whole rule: on the `spoke` screen the
   * clock keeps running, so `round === 0` is false for every tick after the first
   * and a failed refresh must not replace what somebody is reading with an error.
   * What that spelling also refused was a read a **person** asked for: press Try
   * again on a screen that has ticked once, and the retry failed in silence.
   * `asked` is the second clause, and the pair is asserted rather than the arm,
   * since without the press detection the retry can go quiet again with this
   * report still green.
   */
  report(
    "a failed tick leaves what is on screen",
    /if \(live && \(round === 0 \|\| asked\)\) setError/.test(screenSrc),
    "round === 0 || asked guard on setError",
  );
  report(
    "while a read somebody asked for reports at any round",
    /const asked = attempt !== askedFor\.current;/.test(screenSrc),
    "the press is detected from `attempt` moving, not inferred from `round`",
  );
  report("and it only ticks while somebody is looking", /if \(document\.hidden\) return/.test(screenSrc), "document.hidden");
  report(
    "a tick that lands during a read is dropped rather than queued",
    /if \(reading\.current > 0\) return/.test(screenSrc),
    "in-flight guard",
  );
  report(
    "and an answer for a plugin somebody has navigated away from is not drawn",
    /liveRoute\.current !== issuedFor/.test(screenSrc),
    "route identity on the action answer",
  );

  const panelSrc = readFileSync(new URL("../src/ui/settings/PluginsPanel.tsx", import.meta.url), "utf8");
  report(
    "nothing is sent from the picker: the file goes to the manifest reader first",
    /onChange=\{\(event\) => \{[\s\S]{0,400}?choose\(file\)/.test(panelSrc) && !/onChange=[\s\S]{0,400}?send\(file\)/.test(panelSrc),
    "the picker calls choose(), not send()",
  );
  report(
    "and an archive nobody could read takes a second, named press",
    /Install without reading it/.test(panelSrc),
    "the unreadable path is a separate control",
  );

  /* ---------------------------------------------------------------- *
   * The sentence both of these screens say when the machine has gone
   *
   * ⚠ **A constant nothing imports is not a de-duplication, and it is worse than
   * the transcription it replaced: the reader who finds it stops looking.**
   * `MACHINE_GONE` shipped exported, with a docblock written in the present tense
   * about a wiring that had not happened — `grep` found one hit, the definition —
   * while both screens went on hand-writing *"That machine is not reachable right
   * now."* at all four of their `daemonFor` guards. That sentence was also the
   * wrong one: `store.daemonFor` answers `undefined` **only** where the machine is
   * absent from the listing (`daemons` and `connections` are written and dropped
   * together), so it is a grant revoked in another tab or a machine retired, and
   * waking the host does not touch it. An unreachable machine keeps its client and
   * says so through `machine.reach`. So the old wording named a remedy — wait for
   * it, wake it — for a state that remedy does not reach.
   * ---------------------------------------------------------------- */
  {
    const { MACHINE_GONE } = await import("../src/plugins.js");
    const screen = stripComments(screenSrc);
    const panel = stripComments(panelSrc);

    check("the sentence is about the list rather than about reachability", MACHINE_GONE, "That machine is not in your list any more.");
    check("and it is not the reachability sentence wearing a constant's name", /reachable/.test(MACHINE_GONE), false);

    /*
     * ⚠ **Every guard that *says* something says this**, swept over the two files
     * rather than counted per file. Three more `daemon === undefined` tests exist
     * across them and are deliberately not in scope: two `return` without a word and
     * one only disables a control, so there is no sentence to be wrong. The ones
     * opening a block are the four the docblock is about, and the count is asserted
     * so that a fifth arriving with its own wording fails here rather than joining
     * the drift silently.
     */
    const guards = [screen, panel].flatMap((src) => src.split("if (daemon === undefined) {").slice(1));
    check("all four guards were found", guards.length, 4);
    check(
      "and every one of them answers with the constant rather than a fifth transcription",
      guards.filter((body) => !body.slice(0, 400).includes("MACHINE_GONE")).length,
      0,
    );
    /*
     * The negatives, off the stripped source for the reason every negative here is:
     * both files quote the old sentence in a ⚠ paragraph explaining that it expired,
     * and an unstripped read would let that paragraph satisfy the very check written
     * to keep it out of the screen.
     */
    check(
      "neither screen still draws the reachability sentence",
      [/is not reachable right now/.test(screen), /is not reachable right now/.test(panel)],
      [false, false],
    );
    // Named rather than filtered on the text itself, so a failure prints which
    // screen went back to typing it out instead of a whole component.
    check(
      "nor transcribes the new one beside the constant it imports",
      [
        ["PluginScreen.tsx", screen] as const,
        ["PluginsPanel.tsx", panel] as const,
      ]
        .filter(([, src]) => src.includes(MACHINE_GONE))
        .map(([name]) => name),
      [],
    );
    /*
     * ⚠ **And the words are the ones five machine screens draw on the same fact**,
     * which is the claim that makes this a constant rather than a sixth wording.
     * Those five transcribed the string for a release after the constant existed,
     * and the assertion here was that the literal appeared in each — which is
     * exactly the check that lets a copy stand: it was green over five hand-typed
     * copies and would have stayed green had the constant been deleted (review
     * D7). So it is inverted. Each screen has to **import** the constant from
     * `plugins.ts`, **draw** it as an expression, and hold **no** copy of the words
     * — read with comments stripped, since `MachineSection` quotes the sentence in
     * a comment about the order a retire leaves the screen in. Three lists rather
     * than one boolean so a failure names which half came apart on which screen.
     *
     * ⚠ **And two more answer it rather than draw it.** `MachineInstalls` and
     * `PluginSettings` put the sentence on a machine's own row as a `message`
     * when `daemonFor` comes back empty mid-act, so `{MACHINE_GONE}` was never
     * the shape there — which is how they stayed the last two transcriptions for
     * a release after the five above were swept (review D7's leftover). The
     * shape rides with the file rather than being one regex for all, so a screen
     * that answers rather than draws is not a screen this pin cannot reach.
     */
    const SAME_FACT = [
      ["ui/settings/MachineSection.tsx", /\{MACHINE_GONE\}/],
      ["ui/settings/MachineSystemsSection.tsx", /\{MACHINE_GONE\}/],
      ["ui/settings/MachineAgentsSection.tsx", /\{MACHINE_GONE\}/],
      ["ui/settings/MachinePluginsSection.tsx", /\{MACHINE_GONE\}/],
      ["ui/AgentBuilder.tsx", /\{MACHINE_GONE\}/],
      ["ui/plugins/MachineInstalls.tsx", /message: MACHINE_GONE\b/],
      ["ui/plugins/PluginSettings.tsx", /message: MACHINE_GONE\b/],
    ] as const;
    const notImporting: string[] = [];
    const notDrawing: string[] = [];
    const stillTranscribing: string[] = [];
    for (const [file, shape] of SAME_FACT) {
      const src = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
      const name = file.slice(file.lastIndexOf("/") + 1);
      if (!/import \{[^}]*\bMACHINE_GONE\b[^}]*\} from "(\.\.\/)+plugins";/.test(src)) notImporting.push(name);
      if (!shape.test(src)) notDrawing.push(name);
      if (src.includes(MACHINE_GONE)) stillTranscribing.push(name);
    }
    check("every screen that says the same thing imports the one constant", notImporting, []);
    check("and draws or answers it, in its own screen's shape", notDrawing, []);
    check("and holds no copy of the words beside it", stillTranscribing, []);
    /*
     * ⚠ **And the line that names the machine is the same wording, by
     * function.** `PluginSettings`' excluded list says the fact once per machine
     * with the name as the subject — a copy the check above cannot see, since
     * the constant's own subject is "That machine" (E-sweep's review). So the
     * constant is `machineGone("That machine")` with a full stop, the list is
     * `machineGone(name)`, and the fragment the two share appears in no screen.
     */
    const { machineGone } = await import("../src/plugins.js");
    check("the constant is the named form's answer for an unnamed machine", MACHINE_GONE, `${machineGone("That machine")}.`);
    const fragment = machineGone("").trim();
    const stillSpelling: string[] = [];
    for (const [file] of SAME_FACT) {
      const src = stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
      if (src.includes(fragment)) stillSpelling.push(file.slice(file.lastIndexOf("/") + 1));
    }
    check("and the fragment the two wordings share is spelled on no screen", stillSpelling, []);
    const pluginSettings = stripComments(readFileSync(new URL("../src/ui/plugins/PluginSettings.tsx", import.meta.url), "utf8"));
    check(
      "and the list that names each machine takes the function",
      [/import \{[^}]*\bmachineGone\b[^}]*\} from "\.\.\/\.\.\/plugins";/.test(pluginSettings), /gone\.map\(\(id\) => machineGone\(nameOf\(id\)\)\)/.test(pluginSettings)],
      [true, true],
    );
  }

  /* ---------------------------------------------------------------- *
   * A string this app exports and nothing says
   *
   * ⚠ **The defect above generalises, and it is the one shape this driver is best
   * placed to catch**: a sentence extracted into a constant *and left unimported*
   * reads, to every later reader, as the place that sentence lives — so the screens
   * still hand-writing it are invisible, and a wording change made here changes
   * nothing anywhere. Nothing typed can see it: an unused export is a perfectly
   * legal module surface, and `tsc` says nothing about one.
   *
   * Narrow on purpose — a single-line `export const NAME = "…";` under an
   * upper-case name, which is how this package writes a shared sentence — and
   * counted, because a pattern that matches nothing passes silently. `scripts/` is
   * swept alongside `src/`, so a constant that exists **for this driver** is not a
   * finding: that is `daemonReadable`'s standing posture, and it is the deliberate
   * hole in this sweep rather than an oversight.
   * ---------------------------------------------------------------- */
  {
    const sources: string[] = [];
    const collect = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) collect(child);
        else if (/\.tsx?$/.test(entry.name)) sources.push(stripComments(readFileSync(child, "utf8")));
      }
    };
    collect(new URL("../src/", import.meta.url));
    collect(new URL("../scripts/", import.meta.url));

    const declared: string[] = [];
    const unsaid: string[] = [];
    for (const text of sources) {
      for (const found of text.matchAll(/^export const ([A-Z][A-Z0-9_]*) = "[^"]*";$/gm)) {
        const name = found[1] ?? "";
        declared.push(name);
        // Every file including the one that declares it, so a constant used only on
        // the line below its own definition still counts as said. One hit is the
        // definition itself; anything above that is a reader.
        const said = sources.reduce((total, one) => total + (one.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length, 0);
        if (said <= 1) unsaid.push(name);
      }
    }
    check("the sweep found the shape it is looking for", declared.length >= 12, true);
    check("and every sentence this package extracts is one something says", unsaid, []);
  }

  /*
   * ⚠ **The same gate on the path that reaches a whole fleet, which is the one
   * that did not have it.** `plugins.md`: an archive that cannot be read says so,
   * and the way past is a separate, named press. `PluginsPanel` above kept that
   * and was pinned; `InstalledList` drew its machine multi-select for an
   * unreadable archive too, so every box was an ordinary install and the
   * `consentBroken` check on the way back was skipped along with it — the wider
   * blast radius with the weaker gate. This file was read by no driver at all,
   * which is how it stayed that way.
   */
  const fleetSrc = readFileSync(new URL("../src/ui/plugins/InstalledList.tsx", import.meta.url), "utf8");
  report(
    "the fleet-wide import charges that press too",
    /Install without reading it/.test(fleetSrc),
    "the unreadable path is a separate control here as well",
  );
  report(
    "and draws no machine list until it has been paid",
    /peek\.kind === "ok" \|\| unread/.test(fleetSrc),
    "MachineInstalls is gated on a readable archive or the named press",
  );
  /*
   * ⚠ **The archive's own version reaches the table, or an import cannot update
   * anything.** Without `available`, `isBehind` is false on every row, so no row
   * draws Update and the bar's Update is dead — leaving Remove as the only route to
   * a newer copy, and Remove takes `plugin_data` with it: the destructive path as
   * the only path, on the screen whose entire purpose is putting a build onto a
   * fleet.
   */
  report(
    "the archive's version reaches the table, so an import can update",
    /available=\{shown\?\.version \?\? null\}/.test(stripComments(fleetSrc)),
    "MachineInstalls is told what version this file is",
  );
  /*
   * ⚠ **The signal has to reach the request, not merely exist as a parameter.**
   * The first version of this asserted only that no controller was minted here,
   * which a caller satisfies by taking the parameter and then dropping it — and
   * that is exactly what happened one file over, where a two-parameter closure was
   * silently assignable to a four-parameter `InstallAct`. So this pins the whole
   * expression: the signal this closure was handed is the signal the upload gets.
   */
  report(
    "and the signal it is handed is the one the upload uses",
    /daemon\.installPlugin\(file, onProgress, signal\)/.test(stripComments(fleetSrc)),
    "the caller's signal reaches installPlugin verbatim",
  );
  /*
   * ⚠ **A caller here may not construct its own controller.** This read
   * `new AbortController().signal` — built and dropped on one expression, so
   * nothing could ever abort it — which is the defect `PluginsPanel` describes in
   * the past tense one file over while keeping a real one in a ref. The screen
   * that reaches a *whole fleet* had it, so the wider blast radius carried the
   * weaker control. The signal is the fourth argument of `InstallAct` now and
   * `MachineInstalls` owns one per machine.
   */
  report(
    "and it never mints an abort signal of its own",
    // Comments stripped: the docblock at the call site quotes the old expression
    // verbatim, which is the point of it, and an assertion that its own
    // explanation trips is an assertion nobody can write the explanation for.
    !/new AbortController\(\)/.test(stripComments(fleetSrc)),
    "the signal comes from MachineInstalls, which can therefore cancel it",
  );
  /*
   * ⚠ **The foot is inert while the fan-out runs.** Neither control was gated —
   * `busy` lives inside `MachineInstalls` and this component could not see it — so
   * "Done", a word that reads as *finish*, unmounted the component mid-flight:
   * every remaining upload continued invisibly and every answer, a
   * `ConsentBrokenError` naming a gained scope included, landed on nothing.
   */
  /*
   * ⚠ **Every button in the foot's confirming branch, sliced and counted against
   * itself.** Counting `disabled={sending}` twice is satisfied by writing it twice
   * anywhere; what matters is that no `<Button>` in that branch lacks it. The
   * slice runs from the ternary's else-arm to the end of the row, so a third
   * control added there fails until it is gated too.
   */
  const foot = (() => {
    const src = stripComments(fleetSrc);
    const start = src.indexOf('phase.kind !== "confirming" ?');
    return start < 0 ? "" : src.slice(start, src.indexOf("</div>", start));
  })();
  const footButtons = foot.match(/<Button[^>]*>/g) ?? [];
  report(
    "and its foot cannot abandon an act in flight",
    footButtons.length >= 3 &&
      footButtons.filter((b) => /disabled=/.test(b)).length === footButtons.length &&
      /onBusyChange=\{setSending\}/.test(stripComments(fleetSrc)),
    "every control in the foot is gated, and the busy flag is lifted from MachineInstalls",
  );
}
