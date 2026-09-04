import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import {
  importFolderName,
  isArchiveRoot,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_PATH_CHARS,
  MAX_IMPORT_UNPACKED_BYTES,
  safeMemberPath,
  settleFolderName,
} from "../src/archive.js";
import { forgetStalled, isStalled, listDirs, makeDir, PathError, probeExists, resolveCwd } from "../src/browse.js";
import { isRemoteType, mountFor, parseBsdMounts, parseLinuxMounts, readMounts } from "../src/mounts.js";
import { atOrUnder, atOrUnderResolved, containedIn, containedInResolved } from "../src/paths.js";
import { WebSocketServer } from "ws";
import { RelayTunnel, announcedAgentClis } from "../src/relay/tunnel.js";
import { DAEMON_VERSION } from "../src/version.js";
import { AGENT_CLIS_HEADER, DAEMON_VERSION_HEADER, RELAY_PROTOCOL_VERSION, formatAgentClis } from "../src/relay/protocol.js";
import type { AgentCliChoice } from "../src/runtime/types.js";
import { check } from "./daemoncheck.env.js";
import { sandbox, users, tokenWith, tokenFor, registry, app, get } from "./daemoncheck.fixtures.js";

/* ------------------------------------------------------------------ *
 * Importing a codebase
 *
 * The guard here is unlike every other one in this file, because this is the
 * only route that takes a *path* from somebody else and creates a file at it.
 * Everywhere else a path is either one this daemon made or one a person picked
 * out of a listing of what already exists; an archive member is a string written
 * by whoever built the archive, and `paths.ts` is explicit that none of the
 * containment primitives may be used to authorise an action on one.
 *
 * So the assertions below come in pairs on purpose: the refusal, and then that
 * **nothing was created** — including no staging directory. A refusal that
 * leaves half a tree behind is not a refusal, and the second half is the one
 * that would rot silently.
 *
 * The archives are built here rather than shelled out to `zip` and `tar`, for
 * two reasons: neither is guaranteed on a CI box, and neither will *produce*
 * most of what needs testing — GNU tar refuses to write a `../` member at all,
 * which is exactly the member worth being sure about.
 * ------------------------------------------------------------------ */

process.stdout.write("\nimporting a codebase\n");
{
  const pad512 = (n: number): number => (512 - (n % 512)) % 512;

  interface Member {
    name: string;
    data?: Buffer;
    dir?: boolean;
    /** tar typeflag; zip reads `mode` instead. */
    type?: string;
    link?: string;
    /** Unix st_mode for zip's external attributes: 0o120777 is a symlink. */
    mode?: number;
    method?: number;
    encrypted?: boolean;
    /** Raw name bytes, which also clears the UTF-8 flag. */
    rawName?: Buffer;
    /**
     * A tar size field that disagrees with the bytes that follow it.
     *
     * The whole point of a header field somebody else wrote: every archive this
     * driver builds honestly is one the reader could have trusted. Only a member
     * that *declares* more than it carries exercises the bound.
     */
    declaredSize?: number;
  }

  const tarHeader = (name: string, size: number, type: string, link = ""): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write("000755 \0", 100);
    h.write("000000 \0", 108);
    h.write("000000 \0", 116);
    h.write(size.toString(8).padStart(11, "0") + " ", 124);
    h.write("00000000000 ", 136);
    h.write("        ", 148); // spaces while the checksum is summed over the block
    h.write(type, 156);
    h.write(link.slice(0, 100), 157, "utf8");
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };

  const buildTarGz = (members: Member[]): Buffer => {
    const parts: Buffer[] = [];
    for (const m of members) {
      const type = m.type ?? (m.dir === true ? "5" : "0");
      const data = m.dir === true || type === "2" || type === "1" ? Buffer.alloc(0) : (m.data ?? Buffer.alloc(0));
      parts.push(tarHeader(m.name, m.declaredSize ?? data.length, type, m.link ?? ""));
      if (data.length > 0) parts.push(data, Buffer.alloc(pad512(data.length)));
    }
    parts.push(Buffer.alloc(1024)); // the two zero blocks that end an archive
    return gzipSync(Buffer.concat(parts));
  };

  /** A pax `x` header carrying `path=`, then the member it renames. */
  const paxMember = (realPath: string, data: Buffer): Member[] => {
    const make = (len: number): string => `${len} path=${realPath}\n`;
    let len = make(0).length;
    for (let i = 0; i < 4; i += 1) len = make(len).length;
    return [
      { name: "PaxHeader/x", type: "x", data: Buffer.from(make(len), "utf8") },
      { name: "short-stand-in", type: "0", data },
    ];
  };

  const buildZip = (members: Member[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const m of members) {
      const nameStr = m.dir === true && !m.name.endsWith("/") ? `${m.name}/` : m.name;
      const name = m.rawName ?? Buffer.from(nameStr, "utf8");
      const raw = m.dir === true ? Buffer.alloc(0) : (m.data ?? Buffer.alloc(0));
      const method = m.method ?? (raw.length === 0 ? 0 : 8);
      const body = method === 8 ? deflateRawSync(raw) : raw;
      const flags = (m.rawName ? 0 : 0x0800) | (m.encrypted === true ? 0x0001 : 0);

      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(flags, 6);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(crc32(raw), 14);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, body);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(((3 << 8) | 20) >>> 0, 4); // "made by" UNIX, so the mode is read
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(flags, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(crc32(raw), 16);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE((((m.mode ?? (m.dir === true ? 0o040755 : 0o100644)) << 16) >>> 0), 38);
      ch.writeUInt32LE(offset, 42);
      centrals.push(ch, name);
      offset += 30 + name.length + body.length;
    }
    const local = Buffer.concat(locals);
    const central = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(members.length, 8);
    eocd.writeUInt16LE(members.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    return Buffer.concat([local, central, eocd]);
  };

  let box = 0;
  /** A fresh empty directory to import into, so no case can see another's leavings. */
  const target = (): string => {
    const dir = join(users, "u_alice", `import-${box++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const send = async (
    into: string,
    archive: Buffer,
    name = "a.zip",
  ): Promise<{ status: number; body: any; left: string[] }> => {
    const res = await app.fetch(
      new Request(`http://d/fs/import?path=${encodeURIComponent(into)}&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
        body: new Uint8Array(archive),
        // Node refuses a streaming request body without it, and this is what a
        // browser sends too.
        duplex: "half",
      } as RequestInit),
    );
    return { status: res.status, body: await res.json(), left: readdirSync(into).sort() };
  };

  const good: Member[] = [
    { name: "app/", dir: true },
    { name: "app/src/", dir: true },
    { name: "app/src/index.js", data: Buffer.from("console.log(1)\n") },
    { name: "app/README.md", data: Buffer.from("# app\n") },
  ];

  /* The happy path, both formats, because they are two separate readers. */
  for (const [label, archive, name] of [
    ["a zip", buildZip(good), "app.zip"],
    ["a tar.gz", buildTarGz(good), "app.tar.gz"],
  ] as const) {
    const into = target();
    const out = await send(into, archive, name);
    check(`${label} unpacks`, out.status, 201);
    check(`${label} lands as the one folder the archive named`, out.body.import.name, "app");
    check(`${label} answers the path the picker walks into`, out.body.import.path, join(into, "app"));
    check(`${label} wrote the file that was in it`, readFileSync(join(into, "app/src/index.js"), "utf8"), "console.log(1)\n");
    check(`${label} counted the members rather than reporting zero`, out.body.import.entries > 0, true);
    check(`${label} left no staging directory behind`, out.left, ["app"]);
  }

  /* Every refusal, and its second half: that nothing was created. */
  const refusals: [string, Buffer, string, number, string][] = [
    ["a member that climbs out of the tree", buildZip([...good, { name: "app/../../out.txt", data: Buffer.from("x") }]), "escapes_root", 400, "archive_unsafe"],
    ["the same member in a tar", buildTarGz([...good, { name: "app/../../out.txt", data: Buffer.from("x") }]), "escapes_root", 400, "archive_unsafe"],
    ["an absolute member", buildZip([...good, { name: "/tmp/out.txt", data: Buffer.from("x") }]), "absolute_path", 400, "archive_unsafe"],
    ["a zip symlink, by its mode bits", buildZip([...good, { name: "app/link", mode: 0o120777, data: Buffer.from("/etc") }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a tar symlink, by its typeflag", buildTarGz([...good, { name: "app/link", type: "2", link: "/etc" }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a tar hardlink", buildTarGz([...good, { name: "app/hard", type: "1", link: "/etc/passwd" }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a device node", buildTarGz([...good, { name: "app/dev", type: "3" }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a .git the daemon would run hooks out of", buildZip([...good, { name: "app/.git/hooks/post-checkout", data: Buffer.from("#!/bin/sh\n") }]), "git_directory", 400, "archive_unsafe"],
    /*
     * ⚠ **The case variants, and they are not pedantry.** The exact-case
     * comparison these replaced was measured letting `.GIT/config` through, on
     * the APFS this is developed on — where the imported directory is then
     * reachable as `.git`, `git rev-parse --git-dir` answers `.git`, and the
     * `git status` in `changes.ts` runs the `core.fsmonitor` out of it. Both
     * readers, because the refusal is shared and a regression could reach either.
     */
    ["the same .git spelled .GIT, which APFS does not tell apart", buildZip([...good, { name: "app/.GIT/config", data: Buffer.from("[core]\n") }]), "git_directory", 400, "archive_unsafe"],
    ["and .Git in a tar", buildTarGz([...good, { name: "app/.Git/config", data: Buffer.from("[core]\n") }]), "git_directory", 400, "archive_unsafe"],
    /*
     * The one member body read whole rather than streamed, so the one whose
     * declared size becomes an allocation. Declared 200 MiB, carries nothing:
     * unbounded, this exact archive was measured at 2.2 GB resident and three
     * minutes of synchronous copying with the event loop stopped throughout,
     * and it finished by calling the archive *empty*.
     */
    ["a pax header that declares more than this daemon will hold", buildTarGz([{ name: "app/", dir: true }, { name: "PaxHeader/x", type: "x", data: Buffer.from("x"), declaredSize: 200 * 1024 * 1024 }]), "path_too_long", 400, "archive_unsafe"],
    ["and the GNU long-name header beside it", buildTarGz([{ name: "app/", dir: true }, { name: "././@LongLink", type: "L", data: Buffer.from("x"), declaredSize: 200 * 1024 * 1024 }]), "path_too_long", 400, "archive_unsafe"],
    ["an encrypted member", buildZip([...good, { name: "app/s", data: Buffer.from("x"), encrypted: true }]), "encrypted", 400, "archive_unsafe"],
    ["a compression this daemon does not read", buildZip([...good, { name: "app/b", data: Buffer.from("x"), method: 12 }]), "unsupported_method", 400, "archive_unsafe"],
    ["a name that is not UTF-8", buildZip([...good, { name: "x", rawName: Buffer.from([0x61, 0xff]), data: Buffer.from("x") }]), "unsupported_name_encoding", 400, "archive_unsafe"],
  ];
  for (const [label, archive, reason, status, code] of refusals) {
    const into = target();
    const out = await send(into, archive);
    check(`${label} is refused`, out.status, status);
    check(`and says which member and why`, [out.body.error.code, out.body.error.detail?.reason], [code, reason]);
    check(`and nothing at all was created`, out.left, []);
  }

  {
    const into = target();
    const out = await send(into, Buffer.from("this is not an archive at all"));
    check("something that is not an archive is refused", out.status, 400);
    check("on its bytes rather than its filename", out.body.error.code, "unsupported_archive");
    check("and left nothing behind", out.left, []);
  }

  {
    const into = target();
    const out = await send(into, buildZip([...good, { name: "__MACOSX/", dir: true }, { name: "__MACOSX/app/._x", data: Buffer.from("junk") }]));
    check("Finder's resource-fork tree does not count as a second root", out.status, 201);
    check("so the folder is still the real one", out.left, ["app"]);
  }

  {
    const into = target();
    const deep = "app/" + "a-long-segment-".repeat(9) + "end.txt";
    const out = await send(into, buildTarGz([{ name: "app/", dir: true }, ...paxMember(deep, Buffer.from("pax"))]), "app.tar.gz");
    check("a pax extended header is read rather than refused", out.status, 201);
    check("and the member takes the name the pax record gave it", readFileSync(join(into, deep), "utf8"), "pax");
    check("rather than the short stand-in beside it", existsSync(join(into, "app/short-stand-in")), false);
  }

  {
    const into = target();
    const out = await send(into, buildZip([{ name: "a.txt", data: Buffer.from("x") }, { name: "b.txt", data: Buffer.from("y") }]), "my-thing.zip");
    check("loose members at the root are gathered under the archive's own name", out.body.import.name, "my-thing");
    check("and that is the one folder in the target", out.left, ["my-thing"]);
  }

  /*
   * The containment gate itself, held against strings rather than archives.
   *
   * `safeMemberPath` is pure precisely so this is possible — its docblock says a
   * driver "can hold every hostile string ever published against it without a
   * temp directory" — and four of its eleven refusals had no assertion anywhere,
   * because reaching them through a built archive is awkward and reaching them
   * here is one line each.
   */
  {
    const rows: [string, string, string | null][] = [
      ["a plain member is allowed through", "app/src/index.ts", null],
      ["a NUL in a name", "app/a\0b.ts", "control_char"],
      ["and any other control character", "app/ab.ts", "control_char"],
      ["a backslash, never translated to a slash", "app\\b.ts", "backslash"],
      ["deeper than this daemon will nest", `${"a/".repeat(MAX_IMPORT_DEPTH + 1)}f.ts`, "too_deep"],
      ["exactly at the depth bound is still fine", `${"a/".repeat(MAX_IMPORT_DEPTH - 1)}f.ts`, null],
      ["longer than this daemon will read", "a".repeat(MAX_IMPORT_PATH_CHARS + 1), "path_too_long"],
      ["exactly at the length bound is still fine", "a".repeat(MAX_IMPORT_PATH_CHARS), null],
      [".git by any spelling — this one lower", "app/.git/config", "git_directory"],
      ["this one upper", "app/.GIT/config", "git_directory"],
      ["and this one mixed", "app/.GiT/config", "git_directory"],
      ["`..` refused rather than resolved", "app/../../x", "escapes_root"],
    ];
    for (const [label, raw, reason] of rows) {
      const verdict = safeMemberPath(raw);
      check(label, verdict.ok ? null : verdict.reason, reason);
    }

    /*
     * The archive's own root, which is a skip and not a refusal.
     *
     * `tar -czf x.tar.gz .` writes `./` first, and `safeMemberPath` answers
     * `escapes_root` for it — correctly, on its own terms: every segment dropped,
     * nothing left, the same shape as `a/../../x`. So one of the two ordinary ways
     * to make an archive was refused whole, under the message meant for a
     * traversal attempt. The line between the two is what this table is.
     */
    const roots: [string, string, boolean][] = [
      ["what bsdtar writes for the directory itself", "./", true],
      ["and the bare form", ".", true],
      ["a name that is only separators", "//", true],
      ["an empty name", "", true],
      ["but `..` is not a root, it is a climb", "..", false],
      ["nor is it one behind a dot", "./..", false],
      ["nor after a real segment", "app/..", false],
      ["a real member is not a root", "./app/index.ts", false],
      ["and neither is a name that merely starts with a dot", ".git", false],
    ];
    for (const [label, raw, want] of roots) check(label, isArchiveRoot(raw), want);
  }

  {
    /*
     * The whole archive, the way `tar -czf x.tar.gz .` actually arrives — the
     * `./` member first, then everything under it. Driven rather than left to the
     * pure table, because what broke was not the predicate but the reader
     * throwing on the first member and taking the archive with it.
     */
    const into = target();
    const out = await send(
      into,
      buildTarGz([
        { name: "./", dir: true },
        { name: "./src/", dir: true },
        { name: "./README.md", data: Buffer.from("# app\n") },
        { name: "./src/index.js", data: Buffer.from("console.log(1)\n") },
      ]),
      "myproj.tar.gz",
    );
    check("an archive of `.` is imported rather than refused", out.status, 201);
    check("its members are loose at the root, so it takes the archive's name", out.body.import.name, "myproj");
    check("and the root member is not counted as one", out.body.import.entries, 3);
    check("the nested file arrived", readFileSync(join(into, "myproj/src/index.js"), "utf8"), "console.log(1)\n");
    check("and no folder was made for the dot itself", readdirSync(join(into, "myproj")).sort(), ["README.md", "src"]);
    // The other half of the same rule: a name the *folder* takes, which is the
    // one place a query parameter becomes a directory.
    check("a folder named .git is refused whatever its case", importFolderName(".GIT.zip"), "imported");
    check("and so is the lowercase one", importFolderName(".git.tar.gz"), "imported");
  }

  /*
   * The last word on a folder name, which the *archive's* own choice used to skip.
   *
   * Both sources reach `settleFolderName` now; only the query parameter also gets
   * `importFolderName`'s allowlist in front of it. The pair of tables below is
   * that split: what must be settled either way, and what must survive when the
   * name came out of the archive rather than off the wire.
   */
  {
    const settled: [string, string, string][] = [
      ["a leading dash, which is what makes a name an option", "-rf", "rf"],
      ["several of them", "---exclude=x", "exclude=x"],
      ["a name that is nothing but dashes", "---", "imported"],
      ["an empty name", "", "imported"],
      ["a lone dot", ".", "imported"],
      ["two of them", "..", "imported"],
      [".git by any spelling, here too", ".GIT", "imported"],
      ["a name longer than anybody meant", "a".repeat(200), "a".repeat(100)],
      /*
       * ⚠ A hazard the sweeper created rather than one it found. `sweepStaleStaging`
       * deletes anything under the target wearing this exact name and older than an
       * hour, on the reasoning that only this daemon ever generates one. Publishing
       * an archive's folder under it would make that false — and the folder would be
       * deleted by the next import into the same directory, an hour after somebody
       * was told it existed.
       */
      ["a name this daemon would later mistake for its own litter", ".reemoat-import-00112233445566aa", "imported"],
      ["but only the exact shape of it", ".reemoat-import-nothex", ".reemoat-import-nothex"],
    ];
    for (const [label, raw, want] of settled) check(label, settleFolderName(raw), want);

    /*
     * And what it must NOT do, which is why this is not `importFolderName`.
     * Running the allowlist over an archive's own folder would answer `My-Project`
     * and turn every non-Latin name into a row of dashes — a worse answer than the
     * question deserves, and one nobody asked for.
     */
    check("a space is not a threat", settleFolderName("My Project"), "My Project");
    check("nor is an alphabet", settleFolderName("проект"), "проект");
    check("a cap never splits a surrogate pair", [...settleFolderName("🙂".repeat(200))].length, 100);
  }

  {
    const into = target();
    const out = await send(into, buildTarGz([{ name: "-rf/", dir: true }, { name: "-rf/a.txt", data: Buffer.from("x") }]), "app.tar.gz");
    check("an archive may not publish a folder that is an option", out.status, 201);
    check("the dash is taken off rather than the import refused", out.body.import.name, "rf");
    check("and that is what is on disk", out.left, ["rf"]);
  }

  /*
   * ⚠ **Litter from a run that never reached its `finally`.**
   *
   * `discardStaging` cleans up on every path the process survives, and an OOM is
   * not one — which the unbounded extended header above made reachable. Swept on
   * the way in, because staging lives inside a target this daemon only learns
   * about when somebody names it, so the next import is the one moment the path
   * is known. Three narrowings, one case each.
   */
  {
    const into = target();
    const hex = (n: string) => join(into, `.reemoat-import-${n}`);
    const old = Date.now() / 1000 - 7200;

    const stale = hex("00112233445566aa");
    mkdirSync(stale);
    writeFileSync(join(stale, "archive.bin"), "half an import");
    utimesSync(stale, old, old);

    const fresh = hex("00112233445566bb");
    mkdirSync(fresh);

    // Wearing the name but not a directory: `lstat` says so, and it is neither
    // followed nor removed.
    const elsewhere = join(into, "not-staging");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "mine");
    symlinkSync(elsewhere, hex("00112233445566cc"));

    // Shaped almost right, which is the whole reason the test is exact.
    const notOurs = join(into, ".reemoat-import-nothex");
    mkdirSync(notOurs);
    utimesSync(notOurs, old, old);

    const out = await send(into, buildZip(good));
    check("an import still succeeds with litter in the folder", out.status, 201);
    check("a stale staging directory is swept", existsSync(stale), false);
    check("one too young to be litter is left alone", existsSync(fresh), true);
    check("a symlink wearing the name is not followed", readFileSync(join(elsewhere, "keep.txt"), "utf8"), "mine");
    check("nor removed", existsSync(hex("00112233445566cc")), true);
    check("and a name this daemon never generates is not ours to delete", existsSync(notOurs), true);
  }

  /*
   * ⚠ **Two imports in flight at once, which is the assertion the 409 never had.**
   *
   * The guard used to read `importing` and then `await resolveCwd` before writing
   * it, so every request that arrived during that suspension read `false` — the
   * bound did not hold for the case the route's own docblock is about, which is
   * the 256 streams the relay allows arriving together. Firing without awaiting
   * is what tells the two apart: serialised, this passes either way.
   */
  {
    const first = target();
    const second = target();
    const [a, b] = await Promise.all([send(first, buildZip(good)), send(second, buildZip(good))]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check("two imports at once: one is taken", statuses, [201, 409]);
    const refused = a.status === 409 ? a : b;
    check("and the other is told the machine is busy", refused.body.error.code, "import_busy");
    check("and the refused one created nothing", refused.left, []);
    // The flag is released rather than wedged: a third import after both settle
    // must still be accepted, or the route is dead for the daemon's whole life.
    const third = target();
    check("a later import still works", (await send(third, buildZip(good))).status, 201);
  }

  {
    const into = target();
    await send(into, buildZip(good));
    const again = await send(into, buildZip(good));
    check("a second import of the same name is refused", again.status, 409);
    check("with a code the client can act on", again.body.error.code, "import_exists");
    check("and the first one is untouched", readFileSync(join(into, "app/README.md"), "utf8"), "# app\n");
    check("and no staging directory survived the refusal", again.left, ["app"]);
  }

  {
    // The destination already being a symlink is the case `rename` answers
    // `ENOTDIR` to rather than `EEXIST`, and the one where getting it wrong means
    // writing through somebody's link.
    const into = target();
    mkdirSync(join(into, "elsewhere"));
    symlinkSync(join(into, "elsewhere"), join(into, "app"));
    const out = await send(into, buildZip(good));
    check("a destination that is already a symlink is refused", out.status, 409);
    check("rather than written through", existsSync(join(into, "elsewhere/README.md")), false);
  }

  {
    const into = target();
    /*
     * Built from one buffer repeated rather than a single half-gigabyte member,
     * so the *driver* does not need the memory the daemon is refusing to spend.
     * Zeros deflate to almost nothing, so the archive stays far under the wire
     * bound — which is the point: this refusal has to come from the unpacked
     * counter, not from the one on the way in.
     */
    const slab = Buffer.alloc(50 * 1024 * 1024);
    const slabs: Member[] = [{ name: "app/", dir: true }];
    for (let i = 0; i * slab.length <= MAX_IMPORT_UNPACKED_BYTES; i += 1) {
      slabs.push({ name: `app/zeros-${i}`, data: slab });
    }
    const bomb = buildZip(slabs);
    check("and the bomb itself is small enough to be accepted on the wire", bomb.length < MAX_IMPORT_BYTES, true);
    const out = await send(into, bomb);
    check("a bomb is refused on the bytes it actually produced", out.status, 413);
    check("rather than on the size it declared", out.body.error.code, "import_unpacked_too_large");
    check("and left nothing behind", out.left, []);
  }

  {
    const into = target();
    const many: Member[] = [{ name: "app/", dir: true }];
    for (let i = 0; i <= MAX_IMPORT_ENTRIES; i += 1) many.push({ name: `app/f${i}`, data: Buffer.alloc(0) });
    const out = await send(into, buildZip(many));
    check("more members than the ceiling is refused", out.status, 413);
    check("because a byte cap cannot see an inode", out.body.error.code, "import_too_many_entries");
    check("and left nothing behind", out.left, []);
  }

  {
    const into = target();
    const res = await app.fetch(
      new Request(`http://d/fs/import?path=${encodeURIComponent(into)}&name=a.zip`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-length": String(MAX_IMPORT_BYTES + 1) },
        body: new Uint8Array(buildZip(good)),
        duplex: "half",
      } as RequestInit),
    );
    check("an over-size archive is refused on the header", res.status, 413);
    check("before any of it is read", ((await res.json()) as any).error.code, "import_too_large");
    check("and nothing was created", readdirSync(into), []);
  }

  {
    // The exemption is a predicate over both streaming routes now, so the thing
    // worth pinning is that it is still *narrow*: every other POST is bounded.
    const into = target();
    const res = await app.fetch(
      new Request("http://d/fs/mkdir", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ parent: into, name: "x".repeat(2 * 1024 * 1024) }),
      }),
    );
    check("a route that is not a streaming one is still bounded at 1 MiB", res.status, 413);
    const big = await send(into, buildZip(good));
    check("while the import route takes a body past that bound", big.status, 201);
  }

  {
    const into = target();
    const res = await app.fetch(
      new Request(`http://d/fs/import?path=${encodeURIComponent(into)}&name=a.zip`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenWith("u_alice", ["session:read"])}` },
        body: new Uint8Array(buildZip(good)),
        duplex: "half",
      } as RequestInit),
    );
    check("a read-only grant may not import", res.status, 403);
    check("and nothing was created", readdirSync(into), []);
  }
}

/* ------------------------------------------------------------------ *
 * A directory that does not answer
 *
 * The failure this guards against was measured on 2026-08-02 and is the reason
 * `stalled` exists: `~/OrbStack` is a hard NFS mount inside the default browse
 * root, `describe`'s timeout bounds the *response* while libuv cannot cancel the
 * *work*, and each abandoned `readdir` keeps a threadpool slot for the life of
 * the process. Two listings of that home directory exhausted the default pool of
 * four, after which every `await` on `node:fs/promises` in the daemon queued for
 * ever — so `POST /fs/mkdir` and `POST /sessions` never answered and the browser
 * gave up at 15s with `TimeoutError: signal timed out`, while `/health`, which
 * touches no files, went on reporting the daemon up.
 *
 * A stalled mount is the one thing a driver cannot synthesize, which is what
 * `probeTimeoutMs` is for: at 0 the deadline fires before any filesystem call
 * can complete, so the *decision* is exercised on a perfectly healthy disk and
 * nothing is left wedged. What is asserted is the decision — refuse, remember,
 * and let the pending probe clear the memory when it settles.
 * ------------------------------------------------------------------ */

process.stdout.write("\na directory that does not answer\n");
{
  forgetStalled();
  const home = join(users, "u_alice");

  check("nothing is stalled to begin with", isStalled(home), false);

  // A deadline of 0 cannot be met by a syscall that has to cross a thread, so
  // this is the stall path taken against a directory that is in fact fine.
  let code: string | null = null;
  try {
    await resolveCwd(home, { probeTimeoutMs: 0 });
  } catch (error) {
    code = error instanceof PathError ? error.code : String(error);
  }
  check("a path that misses its deadline is refused", code, "unresponsive");
  check("and it is not reported as missing, which would be a lie", code === "not_found", false);
  check("and it is remembered, so the next caller spends nothing", isStalled(home), true);

  // The refusal is immediate and needs no filesystem call at all. This is the
  // half that turns one lost slot into exactly one, rather than one per attempt
  // — and a person whose folder did not appear taps the button again.
  const before = Date.now();
  let second: string | null = null;
  try {
    await makeDir(home, "never-created");
  } catch (error) {
    second = error instanceof PathError ? error.code : String(error);
  }
  check("a second attempt is refused without touching the disk", second, "unresponsive");
  check("immediately, rather than at the client's own timeout", Date.now() - before < 100, true);
  check("and nothing was created", existsSync(join(home, "never-created")), false);

  // The still-pending probe is the re-arm: when the mount answers again, the
  // memory clears itself. A TTL would re-arm the leak on a mount that is still
  // down, which is why there is not one.
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("the memory clears itself once the probe settles", isStalled(home), false);
  check("so the path works again with no intervention", await resolveCwd(home), home);

  // A listing of a path that will not answer refuses on the same deadline, and
  // that is the whole point: before this, it queued behind a syscall that never
  // returns, held the request open until the client gave up, and spent three
  // more slots doing it.
  forgetStalled();
  let listCode: string | null = null;
  try {
    await listDirs(home, { roots: [users], showHidden: false, probeTimeoutMs: 0 });
  } catch (error) {
    listCode = error instanceof PathError ? error.code : String(error);
  }
  check("a listing that misses its deadline refuses too", listCode, "unresponsive");
  forgetStalled();

  // And the healthy listing is unchanged, which is the half that says the
  // deadline has not been put in front of ordinary use.
  const healthy = await listDirs(home, { roots: [users], showHidden: false });
  check("while a healthy listing is untouched", healthy.path, home);
  // The non-emptiness is its own line, the same shape the live mount table gets
  // below: `every` on an empty array is `true`, so a listing that came back with
  // no children at all would have passed the line under this one while proving
  // the opposite of what it claims.
  check("and it found children to describe", healthy.entries.length > 0, true);
  check("and still describes them", healthy.entries.every((e) => e.entries !== null), true);
}

/* The status a stalled path earns, which is not the one a missing path earns.
 * A client that read "not answering" as "gone" would prune a perfectly good
 * recent-directory row for a mount that is merely asleep. */
{
  const stalledStatus = await app.fetch(
    new Request("http://d/fs/list?path=" + encodeURIComponent(join(users, "u_alice", "proj")), {
      headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    }),
  );
  check("a healthy listing is still a 200", stalledStatus.status, 200);
}

/* ------------------------------------------------------------------ *
 * The kernel's mount table
 *
 * Read so that a stall on a network filesystem is remembered as the *mount*
 * rather than as one directory on it: ask `~/OrbStack` once and every directory
 * beneath it is answered for free, where per-path memory would spend two
 * threadpool slots learning the same fact about each of them.
 *
 * The parsers are the part that cannot be checked by running this on one
 * machine — a host is only ever Linux or BSD, and getting the other format
 * wrong is silent — so both are driven from text here.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * a workspace on a filesystem that stopped answering
 *
 * The picker was not the only route reaching a caller-named path. For a `plain`
 * session `workspace.root` *is* the `cwd` that was asked for, and `server.ts`
 * checked it with `existsSync` in front of `GET /sessions/:id/changes` — a
 * synchronous filesystem call, on somebody else's path, reachable with
 * `session:read`. On a stalled mount that stops the event loop, which is the
 * whole daemon and not one request; `browse.ts` had already been rewritten to
 * avoid exactly this, which is why the mechanism lives in `stall.ts` now rather
 * than inside the module that first needed it.
 *
 * The other half is that "gone" and "did not answer" stopped being the same
 * answer. Telling somebody their working directory no longer exists, when what
 * happened is that a NAS went to sleep, is a confident lie about their work.
 * ------------------------------------------------------------------ */

process.stdout.write("\na workspace on a filesystem that stopped answering\n");
{
  const live = join(users, "u_alice", "proj");
  check("a directory that answers says so", await probeExists(live), true);
  check("and one that is genuinely absent says that", await probeExists(join(users, "u_alice", "no-such-dir")), false);
  // The third answer, forced with a deadline that has already passed — the same
  // seam `listDirs` uses, because a real stalled mount is the one thing a driver
  // cannot synthesize.
  check("a deadline that has passed is neither", await probeExists(live, { probeTimeoutMs: 0 }), null);

  // That probe left the path in the memory, so the route below is answered from
  // it without touching the disk at all. This is the behaviour that matters: the
  // cost is paid once, not once per request.
  check("and the path is remembered as not answering", isStalled(live), true);

  const changes = await get("/sessions/s_one/changes", "u_alice");
  check("the changes route refuses rather than hanging", changes.status, 503);
  check("with a code that does not claim the work is gone", changes.body.error.code, "workspace_unresponsive");
  const diff = await get("/sessions/s_one/changes/diff?path=notes.txt", "u_alice");
  check("and so does the diff route", diff.status, 503);

  // A session whose directory really is missing still gets the 409 it always
  // got: the two answers are distinct, which is the entire point of the third.
  forgetStalled();
  const changesLive = await get("/sessions/s_one/changes", "u_alice");
  check("once it answers again, so does the route", changesLive.status, 200);
}

/* ------------------------------------------------------------------ *
 * one stalled server answers for everything beneath it
 *
 * The parsers below are covered; what was not covered is the reason they exist.
 * `stallKeyFor` keys a path on a network filesystem by its **mount point**, so
 * probing one directory under a dead NAS teaches the daemon about every other —
 * and a local path keys by itself, because `/` is a mount point too and keying
 * local paths by their mount would let one unreadable directory mark the entire
 * filesystem as not answering.
 *
 * Without the `mounts` seam every probe in this driver took the `remote: false`
 * arm, so the whole payoff of reading the kernel's table was asserted nowhere.
 * ------------------------------------------------------------------ */

process.stdout.write("\none stalled server answers for everything beneath it\n");
{
  forgetStalled();
  const nas = join(sandbox, "nas");
  const inside = join(nas, "project");
  const sibling = join(nas, "other");
  mkdirSync(inside, { recursive: true });
  mkdirSync(sibling, { recursive: true });

  // A synthetic table: this sandbox directory declared an NFS mount, plus the
  // root filesystem underneath it so "longest match wins" is actually exercised.
  const mounts = [
    { point: "/", type: "apfs", remote: false },
    { point: nas, type: "nfs", remote: true },
  ];

  // One probe, against one directory, with a deadline that has already passed.
  // Navigating *into* it is refused rather than degraded: a listing of a
  // directory we cannot resolve has nothing to show, and saying so beats a
  // spinner until the client's own timeout.
  const listCode = await listDirs(inside, { roots: [sandbox], showHidden: false, probeTimeoutMs: 0, mounts }).then(
    () => "ok",
    (error: unknown) => (error as { code?: string }).code,
  );
  check("navigating into it is refused", listCode, "unresponsive");

  // What was learned is the *mount*, not the directory.
  check("the mount point is what is remembered", isStalled(nas), true);
  check("and not the directory that was asked about", isStalled(inside), false);

  // Which is the whole point: a sibling under the same dead server costs nothing.
  check("so a sibling under it is already known", isStalled(nas), true);
  const cwdCode = await resolveCwd(sibling, { mounts }).then(
    () => "ok",
    (error: unknown) => (error as { code?: string }).code,
  );
  check("and is refused without touching the disk", cwdCode, "unresponsive");

  // A local path that hangs is a fact about that path and nothing else, or one
  // bad `readdir` would mark the entire filesystem as not answering.
  forgetStalled();
  const localDir = join(sandbox, "plainly-local");
  mkdirSync(localDir, { recursive: true });
  await resolveCwd(localDir, { probeTimeoutMs: 0, mounts }).catch(() => undefined);
  check("a local path is remembered as itself", isStalled(localDir), true);
  check("and never as the filesystem it sits on", isStalled("/"), false);
  forgetStalled();
}

process.stdout.write("\nthe mount table\n");
{
  const linux = parseLinuxMounts(
    [
      "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
      "/dev/sda1 / ext4 rw,relatime 0 0",
      "server:/export /mnt/nas nfs4 rw,relatime 0 0",
      "//host/share /mnt/win\\040share cifs rw 0 0",
      "garbage",
    ].join("\n"),
  );
  check("procfs yields one entry per mount", linux.length, 4);
  check("with the point and the type off the right fields", [linux[1]?.point, linux[1]?.type], ["/", "ext4"]);
  check("a local filesystem is not remote", linux[1]?.remote, false);
  check("nfs4 is", linux[2]?.remote, true);
  // The kernel octal-escapes a space, and a point that keeps the escape matches
  // nothing at all — which would silently disable the bounding for that mount.
  check("an escaped space in a mount point is decoded", linux[3]?.point, "/mnt/win share");
  check("and cifs is remote too", linux[3]?.remote, true);

  const bsd = parseBsdMounts(
    [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "OrbStack:/OrbStack on /Users/rends/OrbStack (nfs, nodev, nosuid, noatime, mounted by rends)",
      "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
      "",
    ].join("\n"),
  );
  check("mount(8) yields one entry per line", bsd.length, 3);
  check("the point is what follows ` on `", bsd[1]?.point, "/Users/rends/OrbStack");
  check("and the type is the first option", bsd[1]?.type, "nfs");
  check("apfs is local", bsd[0]?.remote, false);
  check("the measured OrbStack mount is remote", bsd[1]?.remote, true);

  check("sshfs over fuse is remote", isRemoteType("fuse.sshfs"), true);
  // FUSE is a transport, not a filesystem. Treating `fuse.*` as remote wholesale
  // would degrade an ordinary local disk.
  check("but ntfs over fuse is not", isRemoteType("fuse.ntfs"), false);
  check("an unknown type is not assumed remote", isRemoteType("madeup"), false);

  // Longest wins, because `/` is a mount point too — first-match would report
  // every path in the system as being on the root filesystem.
  const table = bsd;
  check("a path picks the deepest mount above it", mountFor("/Users/rends/OrbStack/x", table)?.point, "/Users/rends/OrbStack");
  check("and an unrelated path picks the root", mountFor("/Users/rends/code", table)?.point, "/");
  // Segment-wise, through the one containment primitive: a sibling that merely
  // shares a prefix is not on that mount.
  check("a sibling sharing a prefix is not on it", mountFor("/Users/rends/OrbStackOther", table)?.point, "/");
  check("nothing matches when the table is empty", mountFor("/anything", []), null);

  // And the real table on this machine, which is the only thing that proves the
  // platform dispatch and the reading path work at all.
  const live = await readMounts();
  check("the live table is readable on this platform", live.length > 0, true);
  check("and every entry is an absolute path", live.every((m) => m.point.startsWith("/")), true);
  check("the root filesystem is in it", live.some((m) => m.point === "/"), true);
}

/* The containment primitive the browse path now uses directly.
 *
 * `atOrUnderResolved` is the segment-wise comparison with the resolving step
 * lifted out, because both sides arrive resolved and `realpathSync` on a
 * caller-supplied path is exactly what this module must not do on the event
 * loop. It is the same rule, so it has to answer the same way — above all on
 * the prefix case that a bare `startsWith` gets wrong. */
{
  check("a root is at-or-under itself", atOrUnderResolved("/wt/proj", "/wt/proj"), true);
  check("but is not contained in itself", containedInResolved("/wt/proj", "/wt/proj"), false);
  check("a child is both", containedInResolved("/wt/proj/src", "/wt/proj"), true);
  // The one that a prefix test merges, and the guard on the only `rmSync` in
  // the codebase is downstream of it.
  check("a sibling sharing a prefix is neither", containedInResolved("/wt/proj-old", "/wt/proj"), false);
  check("nor at-or-under it", atOrUnderResolved("/wt/proj-old", "/wt/proj"), false);
  check("a trailing separator on the root changes nothing", containedInResolved("/wt/proj/src", "/wt/proj/"), true);
  // The resolving variants must agree with the pure ones on paths that need no
  // resolving, or the split has introduced the drift it exists to prevent.
  check("the resolving variant agrees on a real path", atOrUnder(users, users), atOrUnderResolved(users, users));
  check("and on a real child", containedIn(join(users, "u_alice"), users), containedInResolved(join(users, "u_alice"), users));
}

const worktrees = await get("/worktrees", "u_alice");
// The registry's own policy root, which is the same one `createWorkspace` uses —
// they disagreed once, and the containment check that guards the only `rmSync`
// in the codebase then refused every time while the route reported success.
check("the worktree root reported is the one sessions are created under", worktrees.body.root, registry.workspacePolicy.worktreeRoot);

const health = (await (await app.fetch(new Request("http://d/health"))).json()) as Record<string, unknown>;
check("health still answers without a token", health.ok, true);
check("and still carries the clock, which is what it is for", typeof health.time, "number");
check("but no longer counts other people's sessions", "sessions" in health, false);
check("nor how long one has been blocked", "blocked" in health, false);
/*
 * What this daemon is, on the one route a client can read before it holds a
 * token — which is the client that most needs to know, `packages/web` shipping
 * inside the control plane's image and therefore arriving newer than the daemon
 * it is pointed at every Tuesday.
 *
 * Asserted here rather than nowhere: `pincheck` said this literal could only be
 * read off the file because "no offline driver starts a daemon and a relay
 * together", which is true and is not the claim — this route needs no relay, and
 * this driver has been fetching the object three lines up all along.
 *
 * `version` against the constant and `protocol` against the negotiation's own
 * maximum, because that is the pair a client uses to tell an old machine from a
 * new one without either of them branching on it.
 */
check("health names the build this daemon is", health.version, DAEMON_VERSION);
check("and the tunnel protocol it speaks", health.protocol, RELAY_PROTOCOL_VERSION);

/* ------------------------------------------------------------------ *
 * A relay URL this daemon cannot dial
 *
 * `relaycheck` owns the tunnel's protocol; what is driven here is the one thing
 * about it that is not about the relay at all — whether a daemon whose
 * `REEMOAT_CP_RELAY_URL` is wrong still runs. `tunnel.ts`'s header promises a
 * relay that is down, unreachable or rejecting costs nothing but log lines, and
 * this was the input that broke that promise before any socket was involved.
 *
 * `target.protocol = "ws:"` is a **silent no-op** for a scheme the URL spec does
 * not call special, so `htps://relay.example` — which `new URL` accepts, and
 * which `enroll.ts` and the control plane's own validation both accept for the
 * same reason — kept its scheme, fell through the guard that looked like it had
 * normalized it, and threw out of `new WebSocket` *outside* the try. There is no
 * `uncaughtException` handler in `scripts/daemon.ts`, and under a unit carrying
 * `KeepAlive`/`RunAtLoad` that is a permanent crash loop whose every pass re-runs
 * `restore()` and auto-resume, spawning agents that are killed seconds later.
 *
 * Every assertion below is written so a regression fails a *line* rather than
 * taking the process down: the throw is caught here and reported as a value,
 * because the whole subject of this section is a throw nobody caught.
 * ------------------------------------------------------------------ */

process.stdout.write("\na relay URL this daemon cannot dial\n");
{
  const dialFrom = async (relayUrl: string): Promise<{ threw: string | null; events: string[] }> => {
    const events: string[] = [];
    let threw: string | null = null;
    let tunnel: RelayTunnel | null = null;
    try {
      tunnel = RelayTunnel.start({
        relayUrl,
        tunnelKey: "tk_daemoncheck",
        // Never reached on any path this section drives, and deliberately a port
        // nothing here is listening on: a refusal must happen before a socket.
        local: { host: "127.0.0.1", port: 1 },
        onEvent: (kind, detail) => void events.push(`${kind} ${detail}`),
      });
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await tunnel?.stop();
    return { threw, events };
  };

  const mistyped = await dialFrom("htps://relay.example");
  check("a mistyped scheme does not throw out of start()", mistyped.threw, null);
  check("it is reported as a refusal instead", mistyped.events.map((line) => line.split(" ")[0]), ["rejected"]);
  // Naming the scheme rather than saying "unusable", because the whole content of
  // this failure is one letter in an env file somebody has to find.
  check("naming the scheme it would not dial", mistyped.events[0]?.includes("htps"), true);
  check("and nothing was ever dialled", mistyped.events.some((line) => line.startsWith("connecting")), false);

  // The arm that already existed, kept as the control: a refusal that swallowed
  // everything would pass the three lines above without the guard meaning a thing.
  const unparseable = await dialFrom("not a url at all");
  check("a URL that does not parse is refused the same way", unparseable.events.map((line) => line.split(" ")[0]), ["rejected"]);

  /*
   * And the other half of the same edit: `ws`/`wss` were **added** to the allowed
   * set, because a relay URL already stored in that form is what an older
   * enrollment wrote and it still has to dial. Without this line the guard could
   * be "fixed" by refusing everything that is not http/https, which would take the
   * fleet off the network rather than off the crash loop.
   */
  const wsForm = await dialFrom("ws://127.0.0.1:1");
  check("a URL already stored in ws form is dialled rather than refused", wsForm.threw, null);
  check("and it really reached the dial", wsForm.events[0]?.split(" ")[0], "connecting");
  check("keeping the scheme it arrived with", wsForm.events[0]?.includes("ws://127.0.0.1:1"), true);
}

/* ------------------------------------------------------------------ *
 * What the daemon announces about its CLIs, and off what
 *
 * `relaycheck` owns the far end — the header read, bounded, written to the row,
 * answered by the fleet route. What is driven here is the daemon's half, which
 * that driver reaches only as a value it hands in: that the inventory is read off
 * `agentCli`, the same choice a launch resolves through, so the report names the
 * build a session would get; that a harness with no CLI is left out rather than
 * sent as anything; and that a daemon with nothing to announce sends **no
 * header**, which is what makes it indistinguishable on the wire from one older
 * than the header — the property the whole "optional on the reader" rule rests
 * on. The last two are read off a bare WebSocket server rather than believed
 * from the function, because the function's answer and the header's presence
 * are two edits apart.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the daemon announces about its CLIs\n");
{
  const runtimeWith = (choices: Record<string, AgentCliChoice | null>): { agentCli: (agent: string) => Promise<AgentCliChoice | null> } => ({
    agentCli: async (agent: string) => choices[agent] ?? null,
  });
  const choice = (version: string | null): AgentCliChoice => ({ path: "/usr/local/bin/x", version, source: "path" });

  check(
    "the inventory is read off agentCli, one entry per harness that has a CLI",
    await announcedAgentClis(runtimeWith({ claude: choice("2.1.259"), codex: choice(null), kimi: null, opencode: choice("1.0.0") })),
    { claude: "2.1.259", codex: null, opencode: "1.0.0" },
  );
  check(
    "a version the grammar would refuse is sent as unknown rather than sent and refused whole",
    await announcedAgentClis(runtimeWith({ claude: choice("2.1.259 (Claude Code)") })),
    { claude: null },
  );
  check("a machine with no CLI for any harness announces nothing", await announcedAgentClis(runtimeWith({})), {});
  check("in the order the harnesses ship, which is the order the header carries", Object.keys(await announcedAgentClis(runtimeWith({ opencode: choice("1"), claude: choice("2") }))), ["claude", "opencode"]);

  /*
   * The wire. A bare `ws` server standing in for the relay, reading the upgrade
   * request's headers and nothing else — the handshake completes so the tunnel
   * believes it connected, and is torn down at once.
   */
  const heard = async (options: { agentClis?: () => Promise<Record<string, string | null>> }): Promise<Record<string, string | undefined>> => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const { port } = server.address() as { port: number };
    const headers = new Promise<Record<string, string | undefined>>((resolve) => {
      server.on("connection", (socket, request) => {
        const seen = {
          version: request.headers[DAEMON_VERSION_HEADER],
          clis: request.headers[AGENT_CLIS_HEADER],
        } as Record<string, string | undefined>;
        socket.terminate();
        resolve(seen);
      });
    });
    const tunnel = RelayTunnel.start({ relayUrl: `ws://127.0.0.1:${port}`, tunnelKey: "tk_daemoncheck", local: { host: "127.0.0.1", port: 1 }, ...options });
    const timeout = new Promise<Record<string, string | undefined>>((resolve) => setTimeout(() => resolve({ timeout: "yes" }), 5_000).unref());
    const seen = await Promise.race([headers, timeout]);
    await tunnel.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return seen;
  };

  const announced = await heard({ agentClis: async () => ({ claude: "2.1.259", codex: null }) });
  check("the daemon's build rides the handshake", announced["version"], DAEMON_VERSION);
  check("and the inventory rides beside it, in the header's compact form", announced["clis"], formatAgentClis({ claude: "2.1.259", codex: null }));
  check("which is what the far end reads back", announced["clis"], "claude=2.1.259;codex=-");

  const empty = await heard({ agentClis: async () => ({}) });
  check("a daemon with no CLI to name sends no header at all, not an empty one", empty["clis"], undefined);
  check("while still saying what build it is", empty["version"], DAEMON_VERSION);

  const unwired = await heard({});
  check("and a tunnel started with nothing to announce sends none either", unwired["clis"], undefined);
}
