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

  // Unreadable is a reason, never a refusal or a guess: the daemon is the authority and takes shapes this reader may not.
  const garbage = await peek(Buffer.from("this is not an archive at all"));
  check("something that is not an archive says so", garbage.kind === "unreadable" ? garbage.reason : garbage, "that is not a .tar.gz or a .zip");
  const broken = await peek(tarOf({ "plugin.json": "{not json" }));
  check("and so does a plugin.json that will not parse", broken.kind === "unreadable" ? broken.reason : broken, "that plugin.json is not valid JSON");

  const bare = await peek(tarOf({ "plugin.json": JSON.stringify({ id: "x", name: "X", version: "1.0.0" }) }));
  check(
    "a plugin that asks for nothing reads as asking for nothing",
    bare.kind === "ok" ? [bare.manifest.scopes, bare.manifest.hooks, bare.manifest.net, bare.manifest.adds] : bare,
    [[], [], [], []],
  );

  // The adds lines are both the disclosure and the value consentGap and consentBroken compare, so the whole address is shown, not an origin.
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
  // Driven against the daemon's own reader: the two packages may not import each other, and what has to hold is that they agree.
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

  // Archives built to be described wrongly: refusing is fine, naming the member as the daemon will is fine, describing a different member is the bug.

  /** `tarOf`, plus the header fields an honest tar writer also uses. */
  const tarWith = (
    members: readonly {
      name: string;
      body: string;
      prefix?: string;
      typeflag?: string;
      /** Raw size-field bytes (e.g. GNU base-256), written over the octal before the checksum is computed. */
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

  const longName = await peek(
    tarWith([
      { name: "././@LongLink", body: "plugin.json\0", typeflag: "L" },
      { name: "decoy.json", body: EVIL },
      { name: "server.js", body: "export {}" },
    ]),
  );
  check("an extended tar header is refused rather than guessed past", longName.kind, "unreadable");

  const twoRoots = await peek(
    tarWith([
      { name: "plugin.json", body: MANIFEST },
      { name: "server.js", body: "export {}" },
      { name: "./plugin.json", body: EVIL },
    ]),
  );
  check("a second root manifest is still a tie, however late it arrives", twoRoots.kind, "unreadable");

  const zipLying = (files: Record<string, string>, declare: number): Buffer => {
    const honest = zipOf(files);
    const end = honest.length - 22;
    honest.writeUInt16LE(declare, end + 8);
    honest.writeUInt16LE(declare, end + 10);
    return honest;
  };

  const miscounted = await peek(
    zipLying({ "wrap/plugin.json": MANIFEST, "plugin.json": EVIL, "server.js": "export {}" }, 1),
  );
  check("a zip whose directory holds more than it declares is refused", miscounted.kind, "unreadable");

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

  // 6b. A regression here hangs this driver rather than failing it: the tar walk holds no await, so no timer can report on it.
  const negativeSize = Buffer.alloc(12);
  negativeSize.write("-0000001000 ", 0, "latin1");
  const negative = await peek(
    tarWith([
      { name: "wrap/plugin.json", body: MANIFEST },
      { name: "wrap/server.js", body: "export {}" },
      { name: "shrink.bin", body: EVIL, sizeField: negativeSize },
      { name: "server.js", body: "export {}" },
    ]),
  );
  check("a negative tar size field is refused rather than walked", negative.kind, "unreadable");

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

  const overrun = await peek(
    zipOverrunning({ "wrap/plugin.json": MANIFEST, "wrap/server.js": "export {}", "plugin.json": EVIL }),
  );
  check("a zip directory entry that runs past the directory is refused", overrun.kind, "unreadable");

  // 9. The same bytes through both real readers, compared: a size field the daemon reads as zero and a tidying reader as octal 3000 splits the two walks.
  {
    const { unpackArchive, PLUGIN_LIMITS } = await import("../../../src/archive.js");
    const { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // packages/web may not import src/, so the peek ceiling is a hand copy of the daemon's; this pins the two together.
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
        // A refusal spelled as a throw is still a refusal.
        return "refused";
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    };

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

    // These shapes exercise the tar cursor's grow and compact paths, and stay inside the daemon's limits so the comparison is about the walk, not the limits.
    const crowded: Record<string, string> = { "plugin.json": MANIFEST };
    for (let i = 0; i < 398; i += 1) crowded[`f${i}.txt`] = `file ${i}\n`;
    // The filler is another manifest, so a stale buffer read finds something believable rather than non-JSON.
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
      // Leniency one way only: this reader may refuse an archive the daemon takes, never describe a different manifest.
      if (said !== "refused" && said !== installed) disagreed.push(`${name}: screen said ${said}, daemon installs ${installed}`);
    }
    check("what the screen describes is what the daemon would install", disagreed, []);

    // The differential reads an overwritten manifest as a refusal: the kept body must be a slice, never a subarray of the compacted buffer.
    const straddled = await peek(straddling);
    check(
      "a manifest read early survives the buffer being reused under it",
      straddled.kind === "ok" ? [straddled.manifest.id, straddled.manifest.scopes] : `unreadable: ${straddled.reason}`,
      ["board", ["sessions.read", "store"]],
    );

    // 10. A saturated zip64 field: this reader refuses while the daemon installs, and both halves are asserted.
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
  check(
    "and a daemon too old to describe its contributions is not a breach",
    consentBroken(shown, { scopes: ["sessions.read"], net: [], contributes: { hooks: ["turn.ended"] } }),
    null,
  );

  const screenSrc = readFileSync(new URL("../src/ui/PluginScreen.tsx", import.meta.url), "utf8");
  report(
    "the view is cleared on a switch and never on a refresh",
    /if \(round === 0\) setView\(null\)/.test(screenSrc),
    "round === 0 guard on setView",
  );
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

  {
    const { MACHINE_GONE } = await import("../src/plugins.js");
    const screen = stripComments(screenSrc);
    const panel = stripComments(panelSrc);

    check("the sentence is about the list rather than about reachability", MACHINE_GONE, "That machine is not in your list any more.");
    check("and it is not the reachability sentence wearing a constant's name", /reachable/.test(MACHINE_GONE), false);

    // Only the four guards that open a block say something; the other daemon-undefined tests return silently or disable a control.
    const guards = [screen, panel].flatMap((src) => src.split("if (daemon === undefined) {").slice(1));
    check("all four guards were found", guards.length, 4);
    check(
      "and every one of them answers with the constant rather than a fifth transcription",
      guards.filter((body) => !body.slice(0, 400).includes("MACHINE_GONE")).length,
      0,
    );
    check(
      "neither screen still draws the reachability sentence",
      [/is not reachable right now/.test(screen), /is not reachable right now/.test(panel)],
      [false, false],
    );
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
    // MachineInstalls and PluginSettings answer the sentence as a row message rather than draw it, so the expected shape is per file.
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

  // Narrow on purpose: a one-line upper-case string export; scripts/ is swept too, so a constant only a driver uses counts as said.
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
        // One hit is the definition itself; anything more is a reader.
        const said = sources.reduce((total, one) => total + (one.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length, 0);
        if (said <= 1) unsaid.push(name);
      }
    }
    check("the sweep found the shape it is looking for", declared.length >= 12, true);
    check("and every sentence this package extracts is one something says", unsaid, []);
  }

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
  report(
    "the archive's version reaches the table, so an import can update",
    /available=\{shown\?\.version \?\? null\}/.test(stripComments(fleetSrc)),
    "MachineInstalls is told what version this file is",
  );
  report(
    "and the signal it is handed is the one the upload uses",
    /daemon\.installPlugin\(file, onProgress, signal\)/.test(stripComments(fleetSrc)),
    "the caller's signal reaches installPlugin verbatim",
  );
  report(
    "and it never mints an abort signal of its own",
    !/new AbortController\(\)/.test(stripComments(fleetSrc)),
    "the signal comes from MachineInstalls, which can therefore cancel it",
  );
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

{
  const React = await import("react");
  (globalThis as Record<string, unknown>)["React"] = React;
  const { createElement: h } = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PluginConsent } = await import("../src/ui/PluginConsent.js");

  const preview = (scopes: string[], hooks: string[]) => ({
    id: "p",
    name: "P",
    version: "1.0.0",
    description: null,
    scopes,
    net: [],
    screen: null,
    settings: false,
    actions: [],
    hooks,
    adds: [],
  });

  const drawn = (scopes: string[], hooks: string[]): string => {
    try {
      return renderToStaticMarkup(h(PluginConsent, { manifest: preview(scopes, hooks) as never }));
    } catch (error) {
      return `threw: ${String(error)}`;
    }
  };

  const known = drawn(["sessions.read"], ["turn.ended"]);
  check("a scope this client knows is drawn in words", known.includes("read your sessions and transcripts"), true);

  const inherited = drawn(["__proto__", "toString", "constructor"], ["__proto__", "valueOf"]);
  report(
    "a scope named after an Object.prototype member does not reach the DOM as one",
    !inherited.startsWith("threw:"),
    inherited.startsWith("threw:") ? inherited.slice(0, 160) : "rendered",
  );
  check("and every one of them is disclosed as its own identifier", [
    inherited.includes("__proto__"),
    inherited.includes("toString"),
    inherited.includes("constructor"),
    inherited.includes("valueOf"),
  ], [true, true, true, true]);
  report(
    "and none of them drew an empty row",
    !/<li[^>]*>\s*<\/li>/.test(inherited),
    "no empty bullet in the rendered card",
  );
}
