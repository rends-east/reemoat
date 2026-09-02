import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import type { PluginRuntime } from "../src/plugins/runtime.js";
import type { PluginRecordStore } from "../src/plugins/store.js";
import { SessionRegistry } from "../src/registry.js";
import { openStores } from "../src/store/sqlite.js";
import { tmp } from "./tmp.js";
import { check, report, retain } from "./daemoncheck.env.js";
import { tarOf, bodyOf, watchedBody, stallingBody } from "./daemoncheck.bodies.js";


process.stdout.write("\ninstalling a plugin, and updating one\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const manifestOf = (patch: Record<string, unknown> = {}): string =>
    JSON.stringify({
      id: "board",
      name: "Task board",
      version: "0.1.0",
      api: 1,
      scopes: ["store"],
      contributes: { settings: true, actions: [{ id: "save", title: "Save", on: "screen" }], hooks: ["turn.ended"] },
      ...patch,
    });

  /** A plugin whose `server.js` answers everything out of its own store. */
  const SERVER = `
    export async function settings(ctx) {
      const held = await ctx.store.get("v");
      return { title: null, blocks: [{ type: "text", text: String(held ?? "unset"), tone: "default" }] };
    }
    export async function action(ctx, event) {
      await ctx.store.set("v", event.form?.v ?? "set");
      return { kind: "toast", text: "saved", tone: "default" };
    }
    export async function hook(ctx, event) {
      await ctx.store.set("last", event.hook);
    }
  `;

  const root = tmp("plugin-root-");
  const stores = openStores({ path: join(tmp("plugin-db-"), "d.db"), instanceId: "i_plugins" });
  const registry = new SessionRegistry(stores.events, stores.sessions);
  const warnings: string[] = [];
  /**
   * What an uninstall swept, recorded so it can be asserted.
   *
   * ⚠ **The handle is optional on `PluginHostOptions` for the drivers' sake and is
   * load-bearing in production** — so both arms have to be driven, and this block
   * is the one that has it. A contributed harness's pasted key lands in
   * `agent_credentials` under `<pluginId>:<id>` and a contributed provider's in
   * `system_credentials` under the same shape; neither table is touched by
   * `prune()`, so what is left behind by skipping this is not litter — it is a
   * third party's API key in a plaintext column that nothing lists and nothing
   * collects.
   */
  const swept: string[] = [];
  const host = await PluginHost.open({
    root: join(root, "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
    onWarning: (detail) => warnings.push(detail),
    timeouts: { start: 3_000, invoke: 3_000 },
    secrets: { forgetPrefix: (prefix) => swept.push(prefix) },
  });

  const install = (files: Record<string, string>, name = "p.tar.gz"): ReturnType<typeof host.install> =>
    host.install({ body: bodyOf(tarOf(files)), name });

  const first = await install({ "plugin.json": manifestOf(), "server.js": SERVER });
  check("a plugin installs", first.kind === "ok" ? [first.summary.id, first.summary.version, first.replaced] : first, [
    "board",
    "0.1.0",
    null,
  ]);
  check("and it is running", host.list().map((one) => [one.id, one.state, one.enabled]), [["board", "running", true]]);

  /*
   * A directory rather than loose members, which is what somebody who compresses
   * a folder produces. Both shapes have to work — the one thing `findManifestRoot`
   * exists for — and nothing deeper than one level is searched.
   */
  const nested = await install({ "board/plugin.json": manifestOf({ version: "0.1.1" }), "board/server.js": SERVER });
  check("an archive holding one folder is the same plugin", nested.kind === "ok" ? nested.replaced : nested, "0.1.0");

  /* ---------------------------------------------------------------- *
   * What an update keeps, which is the whole of what makes it an update.
   * ---------------------------------------------------------------- */
  const plugin = host.find("board");
  if (plugin === null) throw new Error("the plugin vanished");
  await plugin.invoke("action", "save", { action: "save", form: { v: "kept" } });
  const before = await plugin.invoke("view", "settings", {});
  check(
    "a plugin can write to its own store and read it back",
    before.kind === "view" ? before.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  const updated = await install({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER });
  check("installing the same id again is an update", updated.kind === "ok" ? updated.replaced : updated, "0.1.1");
  check("and the row is the new version", host.list().map((one) => one.version), ["0.2.0"]);
  const after = await host.find("board")?.invoke("view", "settings", {});
  check(
    "what it stored survived the update",
    after?.kind === "view" ? after.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );
  check(
    "the old version's directory is gone",
    [existsSync(join(root, "plugins", "board", "0.1.1")), existsSync(join(root, "plugins", "board", "0.2.0"))],
    [false, true],
  );

  // Reinstalling the same version is how somebody iterates on a plugin they are
  // writing. It used to fail `ENOTEMPTY`, because the guard on the removal was
  // comparing an unresolved root against a path that did not exist yet.
  const again = await install({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER });
  check("reinstalling the same version works", again.kind, "ok");

  /* ---------------------------------------------------------------- *
   * A refusal changes nothing, which is the second half of every one of them.
   * ---------------------------------------------------------------- */
  const refusals: [string, Record<string, string>, string][] = [
    ["no manifest at all", { "server.js": SERVER }, "manifest_missing"],
    ["no server.js beside it", { "plugin.json": manifestOf({ version: "9.9.9" }) }, "entry_missing"],
    ["a manifest that is not JSON", { "plugin.json": "{", "server.js": SERVER }, "manifest_unreadable"],
    ["an id this daemon will not make a directory of", { "plugin.json": manifestOf({ id: "A B" }), "server.js": SERVER }, "manifest_invalid"],
    ["an api from the future", { "plugin.json": manifestOf({ api: 99, version: "9.9.9" }), "server.js": SERVER }, "plugin_api_too_new"],
  ];
  for (const [name, files, code] of refusals) {
    const answer = await install(files);
    check(name, answer.kind === "refused" ? answer.code : answer.kind, code);
  }
  check(
    "and after every one of them the machine is exactly as it was",
    [host.list().map((one) => [one.id, one.version, one.state]), existsSync(join(root, "plugins", "board", "9.9.9"))],
    [[["board", "0.2.0", "running"]], false],
  );

  const empty = await host.install({ body: bodyOf(gzipSync(Buffer.alloc(1024))), name: "empty.tar.gz" });
  check("an archive with nothing in it", empty.kind === "refused" ? empty.code : empty.kind, "archive_empty");
  const junk = await host.install({ body: bodyOf(Buffer.from("not an archive")), name: "x.tar.gz" });
  check("something that is not an archive", junk.kind === "refused" ? junk.code : junk.kind, "unsupported_archive");

  /* ---------------------------------------------------------------- *
   * The archive reader's own refusals, in this route's vocabulary.
   *
   * ⚠ **`unpackArchive` is shared with `POST /fs/import` and the codes are not.**
   * One unpacker, one set of containment rules — `..` refused rather than
   * normalised, the ceiling charged against what the decompressor produced — and
   * then each caller translates an `ArchiveError` into its own namespace: an
   * import answers `archive_too_large` where a plugin answers
   * `plugin_unpacked_too_large`. The import section drives every one of these
   * *shapes* already; what it cannot drive is `archiveCode`, which is the whole
   * translation and which nothing reached.
   *
   * `PLUGIN_LIMITS` is the other half of the same argument: 2 MiB on the wire,
   * 8 MiB unpacked and 500 members, against the import's 50 MiB / 500 MiB /
   * 20,000. The same archive is refused at wildly different sizes depending on
   * which door it arrived at, which is exactly why the numbers are a parameter and
   * nothing in `safeMemberPath` is.
   *
   * Four arms rather than five: `ArchiveError("empty")` is raised only inside
   * `importArchive`, so the `archive_empty` arm of `archiveCode` is unreachable
   * from here — `unpackArchive` reports an empty archive as a *kind* and `install`
   * answers that itself, which is the case two assertions up.
   * ---------------------------------------------------------------- */
  const { PLUGIN_LIMITS } = await import("../src/archive.js");

  /**
   * A tar whose header lies about how long its member is.
   *
   * ⚠ **Every archive `tarOf` writes is one the reader could have trusted**, which
   * is why none of them can reach `archive_unreadable`: the size field is computed
   * from the bytes that follow it. Only a member *declaring* more than it carries
   * walks the reader off the end of the stream, and a size field somebody else
   * wrote is the entire reason that arm exists. The import section's own builder
   * makes the same point with its `declaredSize`, and it is deliberately not
   * borrowed — that one exists to write archives no honest tool produces.
   */
  const lyingTarGz = (): Buffer => {
    const head = Buffer.alloc(512);
    head.write("plugin.json", 0, "utf8");
    head.write("000644 \0", 100);
    head.write("000000 \0", 108);
    head.write("000000 \0", 116);
    // Four kilobytes promised; five hundred and twelve bytes follow.
    head.write((4096).toString(8).padStart(11, "0") + " ", 124);
    head.write("00000000000 ", 136);
    head.write("        ", 148);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const byte of head) sum += byte;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return gzipSync(Buffer.concat([head, Buffer.alloc(512, 0x7a)]));
  };

  const crowded: Record<string, string> = {};
  for (let index = 0; index <= PLUGIN_LIMITS.maxEntries; index += 1) crowded[`f${index}.txt`] = "x";
  const archiveRefusals: [string, Buffer, string][] = [
    ["a member that climbs out of the tree", tarOf({ "plugin.json": manifestOf(), "../escaped.txt": "x" }), "archive_unsafe"],
    ["more members than a plugin has", tarOf(crowded), "plugin_too_many_entries"],
    [
      "one that unpacks past what a plugin may be",
      tarOf({ "plugin.json": manifestOf(), "big.js": "x".repeat(PLUGIN_LIMITS.maxUnpackedBytes + 1) }),
      "plugin_unpacked_too_large",
    ],
    ["one this daemon cannot read to the end", lyingTarGz(), "archive_unreadable"],
  ];
  for (const [name, bytes, code] of archiveRefusals) {
    const answer = await host.install({ body: bodyOf(bytes), name: "p.tar.gz" });
    check(name, answer.kind === "refused" ? answer.code : answer.kind, code);
  }
  /*
   * The second half of every one of them, and `readdirSync` rather than an
   * `existsSync` per case: three of those four are refused *after* members have
   * already been written, so what has to be true is that the plugin root holds
   * nothing but the plugin that was there — no staging directory, no partial tree
   * under a name nobody will look for again.
   */
  check(
    "and after every one of those the machine is exactly as it was",
    [host.list().map((one) => [one.id, one.version, one.state]), readdirSync(join(root, "plugins"))],
    [[["board", "0.2.0", "running"]], ["board"]],
  );

  /* ---------------------------------------------------------------- *
   * One install at a time, for the whole daemon.
   *
   * Q7.97's argument for `POST /fs/import` verbatim: this is a route with **no
   * accounting that outlives the request** — an installed plugin is charged
   * against nothing once it has landed — and the relay allows 256 concurrent
   * streams, so a per-request size cap cannot see what a hundred of them do to a
   * disk. The bound has to be on arrival, and a person installs a plugin about as
   * often as they install anything.
   *
   * The version is the one already there, so whichever of the two wins leaves the
   * machine where the cases below expect to find it — and the losing body is
   * cancelled rather than read, which is what keeps a refusal from parking a
   * sender against the relay's window.
   * ---------------------------------------------------------------- */
  const contended = tarOf({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER });
  const overlapping = await Promise.all([
    host.install({ body: bodyOf(contended), name: "a.tar.gz" }),
    host.install({ body: bodyOf(contended), name: "b.tar.gz" }),
  ]);
  check(
    "two at once, and exactly one of them is turned away",
    overlapping.map((one) => one.kind).sort(),
    ["busy", "ok"],
  );
  check("the one that landed is still the only plugin", host.list().map((one) => [one.id, one.version]), [["board", "0.2.0"]]);

  /* ---------------------------------------------------------------- *
   * A throw *after* the row is written, which is the window the rollback
   * exists for and the one nothing reached.
   *
   * ⚠ **`target` carries the version, so the incumbent is only ever moved aside
   * on a reinstall of the version already there** — which is the documented way
   * somebody iterates on a plugin they are writing, not a rare race. On that path
   * `aside` is the running plugin's own directory and `published` is the same
   * path, so destroying `aside` before the last fallible statement meant a throw
   * from `seed` ran a catch that discarded the new tree and found the old one
   * already gone: both trees lost, the row naming a directory that is not there,
   * the plugin permanently failed.
   *
   * A registry whose `list()` throws is how `seed` is made to fail, and `seed`
   * is not an invented source — the catch's own docblock names it.
   * ---------------------------------------------------------------- */
  {
    let listThrows = false;
    const shaky = {
      watchSessions: () => () => {},
      list: () => {
        if (listThrows) throw new Error("the registry was being torn down");
        return [];
      },
      get: () => undefined,
      /*
       * ⚠ **Present because `syncContributions` calls through it, and the cast
       * above is why nothing else says so.** `PluginHostOptions.registry` is a
       * `SessionRegistry`, so a fixture that omits a member the host reaches for is
       * a `TypeError` at run time and green at `typecheck` — the same trap
       * `describe` on the ask-runner fakes already records.
       */
      sessionRuntime: { forgetStartRefusal: () => {}, forgetAvailability: () => {} },
    } as unknown as SessionRegistry;

    const shakyStores = openStores({ path: join(tmp("plugin-shaky-db-"), "d.db"), instanceId: "i_shaky" });
    const shakyRoot = join(tmp("plugin-shaky-root-"), "plugins");
    const shakyHost = await PluginHost.open({
      root: shakyRoot,
      records: shakyStores.plugins,
      data: shakyStores.pluginData,
      registry: shaky,
      api: { git: hostGit },
      timeouts: { start: 3_000, invoke: 3_000 },
    });
    const put = (files: Record<string, string>): ReturnType<typeof shakyHost.install> =>
      shakyHost.install({ body: bodyOf(tarOf(files)), name: "p.tar.gz" });

    await put({ "plugin.json": manifestOf({ version: "2.0.0" }), "server.js": SERVER });
    shakyStores.pluginData.set("board", "card:1", JSON.stringify({ keep: true }));

    listThrows = true;
    const blown = await put({ "plugin.json": manifestOf({ version: "2.0.0" }), "server.js": SERVER });
    listThrows = false;

    check(
      "a reinstall that throws after the row is written is refused",
      blown.kind === "refused" ? blown.code : blown.kind,
      "plugin_write_failed",
    );
    /*
     * Id and version, and that it is not `failed` — deliberately not `running`.
     * The rollback restarts the incumbent with `void existing.ensureStarted(...)`,
     * so `install` answers without waiting to find out: at this instant the state
     * is `starting`, and asserting `running` here would be pinning the scheduler
     * rather than the recovery. (That the answer goes out before the restart is
     * known to have worked is its own open question, and a separate one.)
     */
    const back = shakyHost.list().map((one) => [one.id, one.version, one.state !== "failed"]);
    check("and the plugin somebody was iterating on is still there, and not failed", back, [["board", "2.0.0", true]]);
    // The half that used to be gone: the row named this directory and nothing was
    // in it, so every start burned a budget on ENOENT.
    check("with the tree its row names", existsSync(join(shakyRoot, "board", "2.0.0")), true);
    check("and nothing moved aside left behind", readdirSync(join(shakyRoot, "board")), ["2.0.0"]);
    check("and its data untouched", shakyStores.pluginData.keys("board", ""), ["card:1"]);

    /*
     * The other half of the same catch. A **first** install that fails is
     * documented to leave nothing — and it left the `plugin_data` rows, which
     * afterwards nothing can reach: no row and no directory means `installed()`
     * is false on both halves, so `DELETE /plugins/:id` answers 404 and
     * `dropPlugin` is unreachable for good. They then reappear under the next
     * install of that id, because `plugin_data` is keyed by id rather than by
     * version.
     */
    shakyStores.pluginData.set("ghost", "card:9", JSON.stringify({ stale: true }));
    listThrows = true;
    const fresh = await put({ "plugin.json": manifestOf({ id: "ghost", version: "1.0.0" }), "server.js": SERVER });
    listThrows = false;
    check(
      "a first install that throws after the row is written is refused too",
      fresh.kind === "refused" ? fresh.code : fresh.kind,
      "plugin_write_failed",
    );
    check(
      "and leaves nothing — the row, the tree and the data",
      [
        shakyStores.plugins.has("ghost"),
        existsSync(join(shakyRoot, "ghost")),
        shakyStores.pluginData.keys("ghost", "").length,
      ],
      [false, false, 0],
    );

    /*
     * The third arm, and the one where "first install" was a **guess**.
     *
     * ⚠ **`install` asked `this.live` whether a plugin was installed, and `remove`
     * asks `records.has`.** `PluginRecordStore.has`'s own docblock is about exactly
     * the state where the two disagree: a row whose `manifest_json` this build
     * cannot validate is reported and skipped, so `list` omits it and `get` answers
     * `null` — and `live` is filled from `list`. A daemon downgraded under a plugin
     * declaring a newer `api` is in that state, which is the case `remove` was
     * given `has` for in the first place.
     *
     * So `existing` read `null` over a plugin that was installed, a throw after
     * `records.put` took the first-install arm, and `dropPlugin` destroyed data an
     * update was promised to keep. Simulated here by hiding the row from `list` and
     * `get` while leaving it under `has`, which is what that build sees.
     */
    const hidden = new Set<string>();
    const veiled: PluginRecordStore = {
      list: () => shakyStores.plugins.list().filter((one) => !hidden.has(one.id)),
      get: (id) => (hidden.has(id) ? null : shakyStores.plugins.get(id)),
      has: (id) => shakyStores.plugins.has(id),
      put: (record) => shakyStores.plugins.put(record),
      setEnabled: (id, enabled, now) => shakyStores.plugins.setEnabled(id, enabled, now),
      remove: (id) => shakyStores.plugins.remove(id),
    };
    const veiledRoot = join(tmp("plugin-veiled-root-"), "plugins");
    {
      const first = await PluginHost.open({
        root: veiledRoot,
        records: veiled,
        data: shakyStores.pluginData,
        registry: shaky,
        api: { git: hostGit },
        timeouts: { start: 3_000, invoke: 3_000 },
      });
      await first.install({
        body: bodyOf(tarOf({ "plugin.json": manifestOf({ id: "veiled", version: "1.0.0" }), "server.js": "export async function settings() { return { title: null, blocks: [] }; }" })),
        name: "p.tar.gz",
      });
      shakyStores.pluginData.set("veiled", "card:7", JSON.stringify({ keep: true }));
      await first.shutdown();
    }

    // Reopened with the row present but unreadable, which is what a downgrade is.
    hidden.add("veiled");
    const veiledHost = await PluginHost.open({
      root: veiledRoot,
      records: veiled,
      data: shakyStores.pluginData,
      registry: shaky,
      api: { git: hostGit },
      timeouts: { start: 3_000, invoke: 3_000 },
    });
    // `find`, not `list().length`: this record store is shared with `shakyHost`
    // above, so its rows are in here too. The question is about this one id.
    check("a row this build cannot read is not a plugin it knows about", veiledHost.find("veiled"), null);
    check("but the store still says one is installed under that id", veiled.has("veiled"), true);

    listThrows = true;
    const overIt = await veiledHost.install({
      body: bodyOf(tarOf({ "plugin.json": manifestOf({ id: "veiled", version: "2.0.0" }), "server.js": SERVER })),
      name: "p.tar.gz",
    });
    listThrows = false;
    check(
      "an install over it that throws after the row is written is refused",
      overIt.kind === "refused" ? overIt.code : overIt.kind,
      "plugin_write_failed",
    );
    check("and the data it was never told about is still there", shakyStores.pluginData.keys("veiled", ""), ["card:7"]);
    await veiledHost.shutdown();

    await shakyHost.shutdown();
    shakyStores.close();
  }

  /*
   * ...and the sentence above about the losing body, now asserted rather than
   * asserted-in-prose. Two paths, because they cancel in two different places:
   * the busy arm cancels before it returns (`install`'s first statement), and a
   * refusal cancels in the `finally` that covers every other exit.
   */
  {
    const held = stallingBody(tarOf({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER }));
    const flight = host.install({ body: held.body, name: "held.tar.gz" });
    const turned = watchedBody(tarOf({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER }));
    const busy = await host.install({ body: turned.body, name: "turned.tar.gz" });
    check(
      "an install turned away for busy is released rather than left parked",
      [busy.kind, turned.state.cancelled, turned.state.pulled],
      ["busy", true, 0],
    );
    held.release();
    await flight;

    /*
     * ⚠ **A refusal that stops *mid-stream*, which is the only kind that has
     * anything left to release.** `manifest_missing` and its neighbours are
     * decided after the whole archive has been unpacked, so by then the body has
     * ended on its own and `cancelBody` is correctly a no-op — asserting a cancel
     * there would pin the wrong thing. The reachable case is the ceiling:
     * `unpackArchive` stops reading at `PLUGIN_LIMITS.maxBytes` and refuses, and
     * everything the sender still has queued is what parks against the relay's
     * window if nobody releases it.
     */
    let sent = 0;
    const endless = { cancelled: false };
    const flood = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        endless.cancelled = true;
      },
    });
    const answer = await host.install({ body: flood, name: "endless.tar.gz" });
    check(
      "and one refused while the sender was still sending is released mid-stream",
      [answer.kind === "refused" ? answer.code : answer.kind, endless.cancelled, sent > 0],
      ["plugin_too_large", true, true],
    );
  }

  /* ---------------------------------------------------------------- *
   * An update that will not start puts everything back.
   *
   * The most important case here: a person pushing a broken update to a machine
   * they are not sitting in front of must end up with the plugin they had, not
   * with none.
   * ---------------------------------------------------------------- */
  const broken = await install({
    "plugin.json": manifestOf({ version: "0.3.0" }),
    "server.js": 'throw new Error("this plugin is broken");',
  });
  check("a plugin that throws on load is refused", broken.kind === "refused" ? broken.code : broken.kind, "plugin_start_failed");
  report(
    "and the refusal says what the plugin said",
    broken.kind === "refused" && broken.message.includes("this plugin is broken"),
    broken.kind === "refused" ? broken.message.slice(0, 60) : broken.kind,
  );
  check("the old version is still the installed one", host.list().map((one) => one.version), ["0.2.0"]);
  check("its directory was not touched", existsSync(join(root, "plugins", "board", "0.2.0")), true);
  check("and the broken one left nothing behind", existsSync(join(root, "plugins", "board", "0.3.0")), false);
  const survived = await host.find("board")?.invoke("view", "settings", {});
  check(
    "the plugin that was there is running again",
    survived?.kind === "view" ? survived.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  /* ---------------------------------------------------------------- *
   * The same refusal, at the version that is already installed.
   *
   * ⚠ **The case above passes for a reason that is not the rule.** It pushes
   * 0.3.0 over 0.2.0, so the two live in different directories and the rollback
   * has somewhere to roll back *to*. Reinstalling the version that is already
   * there is the documented way to iterate on a plugin somebody is writing —
   * `docs/PLUGINS.md` opens on it — and there the destination *is* the running
   * plugin's own directory. Clearing it first destroyed the working copy and
   * then removed the broken one on top, leaving a row naming a version whose
   * tree was gone and a plugin that could not be started again. Measured before
   * `install` moved the old tree aside instead: "Cannot find module
   * .../board/0.2.0/server.js".
   * ---------------------------------------------------------------- */
  const clobber = await install({
    "plugin.json": manifestOf({ version: "0.2.0" }),
    "server.js": 'throw new Error("broken at the same version");',
  });
  check("a broken build at the installed version is refused", clobber.kind === "refused" ? clobber.code : clobber.kind, "plugin_start_failed");
  check("the tree it would have replaced is still there", existsSync(join(root, "plugins", "board", "0.2.0", "server.js")), true);
  check("and nothing was left lying beside it", readdirSync(join(root, "plugins", "board")), ["0.2.0"]);
  const clobbered = await host.find("board")?.invoke("view", "settings", {});
  check(
    "the plugin that was there is still the one running",
    clobbered?.kind === "view" ? clobbered.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  /* ---------------------------------------------------------------- *
   * And the same again for a plugin somebody has switched off.
   *
   * ⚠ **`enabled` used to gate the whole proof.** A disabled plugin's update was
   * committed without the new build ever having run: the row was rewritten and
   * the previous version's directory removed, so re-enabling it was the first
   * anybody heard it was broken, with nothing to go back to. The build is now
   * started whatever the switch says and stopped again straight after, which is
   * what the third case here is for — a *good* update to a disabled plugin must
   * still be off when it lands.
   * ---------------------------------------------------------------- */
  /*
   * `setEnabled` answers `"busy"` while an install holds the daemon-wide mutex —
   * see the case at the end of this section. None of the calls below is racing
   * one, so a `"busy"` here would be a defect rather than a state to assert
   * around: it is turned into `null` so the existing `?.` reads on, and the
   * dedicated case is what proves the refusal actually happens.
   */
  const switched = async (id: string, on: boolean) => {
    const answer = await host.setEnabled(id, on);
    return answer === "busy" ? null : answer;
  };
  check("switching it off before an update", (await switched("board", false))?.enabled, false);
  const offBroken = await install({
    "plugin.json": manifestOf({ version: "0.4.0" }),
    "server.js": 'throw new Error("broken while switched off");',
  });
  check("a broken update is refused even for a plugin that would not have run", offBroken.kind === "refused" ? offBroken.code : offBroken.kind, "plugin_start_failed");
  check("the row still names the version that works", host.list().map((one) => [one.version, one.enabled]), [["0.2.0", false]]);
  check("whose tree is still there", existsSync(join(root, "plugins", "board", "0.2.0", "server.js")), true);
  check("and the broken one left nothing behind", existsSync(join(root, "plugins", "board", "0.4.0")), false);
  const offGood = await install({ "plugin.json": manifestOf({ version: "0.5.0" }), "server.js": SERVER });
  check("a good update to a switched-off plugin lands", offGood.kind === "ok" ? offGood.replaced : offGood, "0.2.0");
  check("and is still switched off, at the new version", host.list().map((one) => [one.version, one.state, one.enabled]), [["0.5.0", "stopped", false]]);
  check("with what it kept", stores.pluginData.keys("board", "").length > 0, true);
  check("switching it back on", (await switched("board", true))?.state, "running");

  /* ---------------------------------------------------------------- *
   * Switching one off, and removing it.
   * ---------------------------------------------------------------- */
  check("switching it off", (await switched("board", false))?.enabled, false);
  check("and it stops", host.list().map((one) => one.state), ["stopped"]);
  check("a plugin that is off will not draw", await host.find("board")?.invoke("view", "settings", {}).then(
    () => "drew",
    (error: unknown) => (error as { code?: string }).code ?? "threw",
  ), "plugin_unavailable");
  check("switching it back on", (await switched("board", true))?.enabled, true);
  const revived = await host.find("board")?.invoke("view", "settings", {});
  check(
    "and it still has what it kept",
    revived?.kind === "view" ? revived.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  /* ---------------------------------------------------------------- *
   * One mutation at a time, for the whole daemon.
   *
   * The mutex used to cover installs against each other and nothing else, so a
   * `DELETE` landing while an archive was still being read took the row, the
   * directory and every `plugin_data` key — and the install then re-created the
   * row and left the plugin running with its data gone, answering `replaced:
   * null` because `existing` had been captured before the removal. Both halves
   * are asserted: that the mutation is refused while the install holds the flag,
   * and that what the plugin kept is still there when the install lands.
   * ---------------------------------------------------------------- */
  {
    const stalled = stallingBody(tarOf({ "plugin.json": manifestOf({ version: "0.6.0" }), "server.js": SERVER }));
    const flight = host.install({ body: stalled.body, name: "board.tgz" });
    check("a remove during an install is refused rather than run", await host.remove("board"), "busy");
    check("and so is a switch", await host.setEnabled("board", false), "busy");
    stalled.release();
    const landed = await flight;
    check("and the install it was racing still lands", landed.kind === "ok" ? landed.replaced : landed.kind, "0.5.0");
    check("with what the plugin kept", stores.pluginData.keys("board", "").length > 0, true);
    check("and the switch is answerable again", (await switched("board", true))?.enabled, true);
  }

  /*
   * ⚠ **What an *update* must not sweep, asserted before the remove that must.**
   * The two are one rule seen from either end: "an update keeps what the plugin
   * kept" is what makes an update an update, and a saved key is more of that than
   * a board's cards are. It holds by construction — the update path never calls
   * `doRemove` — and the whole value of this line is that the construction is now
   * pinned rather than being a thing somebody has to notice.
   */
  swept.length = 0;
  await install({
    "plugin.json": manifestOf({
      version: "9.0.0",
      api: 5,
      scopes: ["harness"],
      contributes: { harnesses: [{ id: "gemini", name: "Gemini", command: "gemini", args: ["acp"] }] },
    }),
    "server.js": SERVER,
  });
  check("an update sweeps no credentials at all", swept, []);

  check("removing one that is not there", await host.remove("nothing"), false);
  check("removing one that is", await host.remove("board"), true);
  check("takes its row", host.list(), []);
  check("its directory", existsSync(join(root, "plugins", "board")), false);
  // Its data goes with it, and only here — an update keeps it, which is the pair
  // this assertion makes with the one above.
  check("and everything it kept", stores.pluginData.keys("board", ""), []);
  /*
   * ⚠ **Everything under its namespace, out of *both* credential tables.** A
   * harness's pasted key and a provider's key are the same namespaced id in two
   * different stores, and one sweep that reached only one of them would leave a
   * secret with no listing to find it on and no `prune()` to collect it.
   *
   * ⚠ **A prefix, not the manifest's own list of ids** — and that was the defect.
   * The ids were read off `records.get(id)`, which answers `null` for a row this
   * build cannot re-validate, while `installed()` deliberately asks `records.has`
   * so `doRemove` proceeds for exactly that row: a daemon downgraded under a plugin
   * declaring a newer `api` removed the row and the data and swept nothing. A
   * prefix needs no manifest, so it cannot be defeated by one being unreadable —
   * and it also catches a slot an *earlier* version of the plugin declared and this
   * one does not.
   */
  check("and everything under its namespace, out of both credential tables", swept, ["board:"]);

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}

process.stdout.write("\nwhat a plugin root's litter is, and what is not\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");

  /*
   * ⚠ **`install`'s `finally` is exactly what an OOM and a `SIGKILL` do not
   * reach**, and this file took `importArchive`'s staging pattern without taking
   * the sweeper that answers it. Nothing on this side collected what was left:
   * `open` builds `live` from the record store rather than by walking the root,
   * `list` never sees a directory nobody has a row for, and `installed` probes
   * `join(root, id)` for an id `manifest.ts` will not let begin with a dot. Every
   * daemon killed mid-install left up to `PLUGIN_LIMITS.maxBytes` of
   * `archive.bin` plus up to eight megabytes of unpacked tree under a name
   * nothing would ever look for again.
   *
   * ⚠ **Two shapes at two depths, and that is the whole reason this descends.**
   * Staging is `<root>/.reemoat-plugin-<16 hex>`; the tree a rollback moves aside
   * is `<root>/<id>/<version>.replaced-<8 hex>`. A sweep of the root alone
   * collects the larger of the two and leaves the one that holds a whole working
   * plugin — and that one now has a second producer as well as a crash, since the
   * failed-rollback arm of `install` leaves it deliberately rather than lying
   * about where the tree is.
   *
   * The root is laid out by hand rather than by driving installs into it, because
   * what is being asserted is a decision about names and ages taken on the way
   * *in*, before a single record is read. `utimesSync` is the whole of the clock
   * this needs: the sweep reads `Date.now()` on purpose and there is no seam to
   * hold, which is the same argument `doShutdown`'s deadline makes one section
   * down.
   */
  const root = realpathSync(tmp("plugin-litter-"));
  /** Two hours back, so an hour's cutoff is past whichever way a filesystem rounds. */
  const old = Date.now() / 1000 - 7_200;
  const made = (...parts: string[]): string => {
    const full = join(root, ...parts);
    mkdirSync(full, { recursive: true });
    return full;
  };

  const staleStaging = made(".reemoat-plugin-00112233445566aa");
  writeFileSync(join(staleStaging, "archive.bin"), "half an install");
  const freshStaging = made(".reemoat-plugin-00112233445566bb");
  // Shaped almost right, which is the whole reason `STAGING_NAME` is exact rather
  // than a prefix test.
  const oddStaging = made(".reemoat-plugin-nothex");

  /** A directory this daemon never named, and a link wearing a name it does. */
  const elsewhere = made("not-staging");
  writeFileSync(join(elsewhere, "keep.txt"), "mine");
  const linkStaging = join(root, ".reemoat-plugin-00112233445566cc");
  symlinkSync(elsewhere, linkStaging);

  const published = made("board", "0.1.0");
  writeFileSync(join(published, "server.js"), "the version somebody has installed");
  const deepReplaced = made("board", "0.1.0", "nested.replaced-11223344");
  const staleReplaced = made("board", "1.0.0.replaced-aabbccdd");
  writeFileSync(join(staleReplaced, "server.js"), "the tree a rollback moved aside");
  const freshReplaced = made("board", "2.0.0.replaced-ccddeeff");
  const oddReplaced = made("board", "3.0.0.replaced-nothex");
  const deepStaging = made("board", ".reemoat-plugin-00112233445566dd");

  // Aged last, after every write: creating an entry bumps the *parent's* mtime, so
  // a directory aged before its contents exist is a fresh directory again.
  for (const path of [staleStaging, oddStaging, staleReplaced, oddReplaced, deepReplaced, deepStaging, published]) {
    utimesSync(path, old, old);
  }
  /*
   * `lutimes` rather than `utimes`, and the difference decides what the assertion
   * is worth: ageing *through* the link would age the directory it points at and
   * leave the link itself seconds old, so what saved it would be the mtime test
   * rather than `lstat().isDirectory()` — and the case would pass while the
   * narrowing it is named for was doing nothing.
   */
  lutimesSync(linkStaging, old, old);

  const stores = openStores({ path: join(tmp("plugin-litter-db-"), "d.db"), instanceId: "i_litter" });
  const registry = new SessionRegistry(stores.events, stores.sessions);
  const warnings: string[] = [];
  const host = await PluginHost.open({
    root,
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
    onWarning: (detail) => warnings.push(detail),
  });

  check("a stale staging directory is swept", existsSync(staleStaging), false);
  check("and so is a tree a rollback moved aside, two levels down", existsSync(staleReplaced), false);
  check("one of each still inside the cutoff is left alone", [existsSync(freshStaging), existsSync(freshReplaced)], [true, true]);
  check("a name that is not exactly ours is not ours to delete", [existsSync(oddStaging), existsSync(oddReplaced)], [true, true]);
  check("a symlink wearing the name is not followed", readFileSync(join(elsewhere, "keep.txt"), "utf8"), "mine");
  check("nor removed", existsSync(linkStaging), true);
  check("the version somebody actually has installed is untouched", existsSync(join(published, "server.js")), true);
  /*
   * ⚠ **The half with no symptom.** Every assertion above still passes for a sweep
   * that walked the whole tree — and such a sweep deletes a plugin's own files the
   * moment an author ships one called `something.replaced-deadbeef`. `install`
   * writes staging at the root and nowhere else, and moves a tree aside one level
   * below an id and nowhere else; anything wearing either name at any other depth
   * is somebody's directory rather than this daemon's litter.
   */
  check("nothing three levels down is even looked at", existsSync(deepReplaced), true);
  check("nor is a staging name anywhere but the root", existsSync(deepStaging), true);
  check("and what it removed is what somebody is told about, once each", warnings.length, 2);
  report(
    "each naming the directory it took and why it was there",
    warnings.every((one) => one.includes("left behind by an install that did not finish")) &&
      warnings.some((one) => one.includes(staleStaging)) &&
      warnings.some((one) => one.includes(staleReplaced)),
    warnings.join(" · ") || "nothing reported",
  );

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}

process.stdout.write("\nshutting a plugin host down, with somebody still sending\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");

  const manifestText = (): string =>
    JSON.stringify({ id: "board", name: "Task board", version: "1.0.0", api: 1, scopes: [], contributes: {} });
  const SERVER = "export async function settings() { return { title: null, blocks: [] }; }";
  const archive = (): Buffer => tarOf({ "plugin.json": manifestText(), "server.js": SERVER });
  const parsed = parseManifest(manifestText());
  if (!parsed.ok) throw new Error(parsed.message);
  const manifest = parsed.manifest;

  /** Long enough for a `void`ed start or a resolved promise to have been observed. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  /* ---------------------------------------------------------------- *
   * A second shutdown is the same shutdown.
   *
   * ⚠ **This was an early-return latch (`if (this.stopped) return; this.stopped =
   * true;`), and the deviation from `this.x ??= this.doX()` was behavioural rather
   * than cosmetic.** A second `await host.shutdown()` resolved *immediately* while
   * the first was still inside `plugin.stop()` on live children — so a caller that
   * awaited it had no guarantee any child was down, which is the one guarantee this
   * method exists to make. `scripts/daemon.ts` is that caller, and what follows it
   * there is `registry.shutdown()` and `stores.close()`.
   *
   * The identity is the cheap half and is asserted first; the behaviour below is
   * the one that fails against the latch for the reason the latch was wrong.
   * ---------------------------------------------------------------- */
  {
    let stops = 0;
    let release = (): void => {};
    /** A child that goes down only when this driver says so, which is the whole fixture. */
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime: PluginRuntime = {
      launch(options) {
        return Promise.resolve({
          send(message) {
            if (message.t === "init") queueMicrotask(() => options.onMessage({ t: "ready" }));
            return true;
          },
          async stop() {
            await held;
            stops += 1;
          },
          recentLogs: () => [],
        });
      },
    };

    const stores = openStores({ path: join(tmp("plugin-idiom-db-"), "d.db"), instanceId: "i_idiom" });
    stores.plugins.put({
      id: "board",
      version: "1.0.0",
      manifest,
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: null,
    });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const host = await PluginHost.open({
      root: join(tmp("plugin-idiom-root-"), "plugins"),
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      runtime,
      timeouts: { start: 200, invoke: 200 },
    });
    await settle();
    check("the plugin this host holds is up", host.list().map((one) => one.state), ["running"]);

    const first = host.shutdown();
    check("a second shutdown is the same promise", host.shutdown() === first, true);
    let firstAnswered = false;
    void first.then(() => {
      firstAnswered = true;
    });
    const second = host.shutdown();
    let secondAnswered = false;
    void second.then(() => {
      secondAnswered = true;
    });
    await settle();
    check(
      "and neither of them resolves while a child is still going down",
      [firstAnswered, secondAnswered, stops],
      [false, false, 0],
    );
    release();
    await second;
    check("both of them resolve once it is", [firstAnswered, secondAnswered, stops], [true, true, 1]);

    await registry.shutdown();
    stores.close();
  }

  /* ---------------------------------------------------------------- *
   * And it does not wait for ever, which the loop it replaces did.
   * ---------------------------------------------------------------- */
  {
    const stores = openStores({ path: join(tmp("plugin-bound-db-"), "d.db"), instanceId: "i_bound" });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const warnings: string[] = [];
    const host = await PluginHost.open({
      root: join(tmp("plugin-bound-root-"), "plugins"),
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      onWarning: (detail) => warnings.push(detail),
      timeouts: { start: 200, invoke: 200 },
    });

    /*
     * ⚠ **A body that charges bytes and never charges time**, which is the whole of
     * why the drain needed a deadline. `install` claims the daemon-wide mutex and
     * then awaits `unpackArchive`, whose `for await (const chunk of request.body)`
     * counts what arrives against `PLUGIN_LIMITS.maxBytes` and counts nothing at
     * all against the clock — so a client trickling two megabytes a byte at a time
     * holds the mutex for as long as it likes. This is that client with the
     * trickle turned all the way down: the stream is opened, the first `pull` is
     * asked for, and no chunk is ever produced.
     */
    const trickle = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    const parked = host.install({ body: trickle, name: "trickle.tar.gz" });
    // Nothing will ever settle this, and an install left with no handler is an
    // unhandled rejection three sections later if anything ever does.
    void parked.then(
      () => {},
      () => {},
    );
    // And kept reachable for the rest of the run, or the descriptor it is parked
    // on is collected and takes the process down — see {@link retain}. **The
    // stream has to be held, not just the promise**: a pending promise does not
    // keep the frame that would settle it alive, while `trickle` holds the read
    // request whose reaction *is* that frame, and the frame holds the handle.
    retain(trickle, parked);
    await settle();

    /*
     * ⚠ **Raced against a bell rather than simply awaited, because what is being
     * pinned is a hang.** The loop this replaces was `while (this.installing) await
     * new Promise((r) => setTimeout(r, 10))` with no second condition, so a driver
     * that only awaited `shutdown()` would sit here until somebody killed it
     * instead of printing a FAIL — and a red nobody can read is a red nobody acts
     * on. Twelve seconds because the bound is a few, and because
     * `scripts/daemon.ts` gives the whole of this, `registry.shutdown()` and
     * `stores.close()` twenty-five between them.
     */
    let bell: NodeJS.Timeout | undefined;
    const started = Date.now();
    const outcome = await Promise.race([
      host.shutdown().then(() => "shut down" as const),
      new Promise<"still waiting">((resolve) => {
        bell = setTimeout(() => resolve("still waiting"), 12_000);
      }),
    ]);
    clearTimeout(bell);
    const elapsed = Date.now() - started;
    check("a shutdown behind a body that never produces a chunk is not held by it", outcome, "shut down");
    /*
     * ⚠ **The deadline is read off the sentence rather than mirrored here.**
     * `SHUTDOWN_MUTATION_WAIT_MS` is module-private — deliberately, it is not
     * configuration — so the one place its value reaches this side is the warning
     * it writes on the way past. Deriving the expectation from that is what keeps
     * this an assertion about the *property* rather than about the number, which
     * is `report`'s own reason for existing.
     *
     * Both directions, because only one of them is about the fix: a wait that had
     * been **deleted** rather than bounded would write the same sentence and take
     * no time at all, and the drain is what keeps a child from being forked after
     * `live` has been emptied.
     */
    const said = warnings.find((one) => one.includes("shutting down without waiting"));
    const bound = Number(/after (\d+)ms/.exec(said ?? "")?.[1] ?? Number.NaN);
    report(
      "and it says so, naming the deadline it gave up at",
      said !== undefined,
      said ?? `${warnings.length} warnings, none of them this`,
    );
    report(
      "and it waited that long rather than less, or longer",
      Number.isFinite(bound) && elapsed >= bound - 200 && elapsed < bound + 2_000,
      `${elapsed}ms against the ${bound}ms it names`,
    );

    /*
     * ⚠ **What the bound gives back, refused at the door.** An install admitted
     * after this point would fork a child that no `stop()` here will reach — which
     * is exactly what `shuttingDown` is for, and it is a barrier only because the
     * `??=` above assigns before anything can ask.
     */
    const turned = watchedBody(archive());
    const after = await host.install({ body: turned.body, name: "after.tar.gz" });
    check(
      "and nothing new is admitted after it",
      [after.kind === "refused" ? after.code : after.kind, turned.state.cancelled],
      ["shutting_down", true],
    );

    await registry.shutdown();
    stores.close();
  }

  /* ---------------------------------------------------------------- *
   * One mutation at a time, swept over all four of them.
   *
   * ⚠ **Swept rather than asserted one call site at a time, because what is being
   * pinned is `exclusive` rather than any of its callers.** The two checks and the
   * `try`/`finally` were written out verbatim twice, and a claim that exists in two
   * copies is a claim one of them will be missing — which is not hypothetical for
   * this one: it had exactly one copy when it was called `installing`, `remove` and
   * `setEnabled` had none, and a measured `DELETE` landing mid-upload dropped the
   * row and every `plugin_data` key of a plugin the install then re-created.
   * `install` and `installFromSource` are deliberately *outside* the helper — their
   * two-stage check is a check that claims nothing — so a sweep is the only shape
   * that covers both kinds at once.
   * ---------------------------------------------------------------- */
  {
    /** A child that comes up at once and goes down at once: the lock is the subject here. */
    const runtime: PluginRuntime = {
      launch(options) {
        return Promise.resolve({
          send(message) {
            if (message.t === "init") queueMicrotask(() => options.onMessage({ t: "ready" }));
            return true;
          },
          stop: () => Promise.resolve(),
          recentLogs: () => [],
        });
      },
    };
    const stores = openStores({ path: join(tmp("plugin-lock-db-"), "d.db"), instanceId: "i_lock" });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const host = await PluginHost.open({
      root: join(tmp("plugin-lock-root-"), "plugins"),
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      runtime,
      timeouts: { start: 200, invoke: 200 },
      // No network is reached: what the address is built out of is the routes
      // section's assertion, and what this one is about is the claim
      // `installFromSource` makes *before* it fetches anything.
      fetchArchive: () => Promise.resolve(new Response(new Uint8Array(archive()), { status: 200 })),
    });
    const source = { kind: "github", repo: "rends-east/reemoat-board", commit: "b".repeat(40) } as const;

    /** Four mutations in one vocabulary, so the sweep reads as a table. */
    const answerOf = (answer: unknown): string => {
      if (answer === "busy") return "busy";
      if (typeof answer === "object" && answer !== null && "kind" in answer) {
        const outcome = answer as { kind: string; code?: string };
        return outcome.kind === "refused" ? (outcome.code ?? "refused") : outcome.kind;
      }
      return String(answer);
    };
    const mutations: [string, () => Promise<unknown>][] = [
      ["remove", () => host.remove("board")],
      ["a switch", () => host.setEnabled("board", false)],
      ["an install", () => host.install({ body: watchedBody(archive()).body, name: "rival.tar.gz" })],
      ["one from a commit", () => host.installFromSource(source, null)],
    ];
    const sweep = async (): Promise<[string, string][]> => {
      const answers: [string, string][] = [];
      // Serially, so what each one is answering about is the state this driver put
      // the host in rather than about whichever of its neighbours got there first.
      for (const [name, run] of mutations) answers.push([name, answerOf(await run())]);
      return answers;
    };

    const held = stallingBody(archive());
    const flight = host.install({ body: held.body, name: "held.tar.gz" });
    check(
      "every mutation refuses while another holds the lock",
      await sweep(),
      mutations.map(([name]) => [name, "busy"]),
    );
    held.release();
    check("and the one that was holding it lands", (await flight).kind, "ok");
    /*
     * The flag is released rather than wedged. Written as `report` over the sweep
     * rather than as four expected answers, because what each of them *does* once
     * it is let through is four other sections' subject — this one is only asking
     * that none of them is still saying "busy".
     */
    const afterwards = await sweep();
    report(
      "and every one of them is answerable again",
      afterwards.every(([, answer]) => answer !== "busy"),
      afterwards.map(([name, answer]) => `${name}: ${answer}`).join(", "),
    );

    /*
     * ⚠ **And a shutdown refuses all four, in two vocabularies.** `exclusive`
     * answers `"busy"` for a shutdown as well as for a rival mutation — at the
     * moment a machine is going away, "try again" is exactly as true as it is for
     * the other one — while the two that check for themselves say what is actually
     * happening, because they are the two a person is watching an upload against.
     */
    await host.shutdown();
    check("and a shutdown refuses all four", await sweep(), [
      ["remove", "busy"],
      ["a switch", "busy"],
      ["an install", "shutting_down"],
      ["one from a commit", "shutting_down"],
    ]);

    await registry.shutdown();
    stores.close();
  }
}

process.stdout.write("\na rollback that cannot put the tree back, and one that cannot remove one\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");

  const manifestText = (): string =>
    JSON.stringify({ id: "board", name: "Task board", version: "1.0.0", api: 1, scopes: [], contributes: {} });
  const SERVER = "export async function settings() { return { title: null, blocks: [] }; }";
  const archive = (): Buffer => tarOf({ "plugin.json": manifestText(), "server.js": SERVER });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  /**
   * A child that starts on cue, so that a launch which should **not** happen is a
   * number rather than an absence.
   *
   * `PluginRuntime`'s reason again: what has to be true below is that the rollback
   * did not fork anything against a path that is not there, and a real `fork`
   * answers that with a `Cannot find module` several hundred milliseconds later —
   * a sentence about Node's resolver, arriving after the assertion.
   */
  const counting = (): { runtime: PluginRuntime; launches: () => number } => {
    let launches = 0;
    return {
      launches: () => launches,
      runtime: {
        launch(options) {
          launches += 1;
          return Promise.resolve({
            send(message) {
              if (message.t === "init") queueMicrotask(() => options.onMessage({ t: "ready" }));
              return true;
            },
            stop: () => Promise.resolve(),
            recentLogs: () => [],
          });
        },
      },
    };
  };

  /* ---------------------------------------------------------------- *
   * The tree could not be put back, and the row says so rather than lying.
   *
   * ⚠ **A rollback that could not roll back used to be a `warn` and nothing else,
   * and the two statements after it then made the machine lie.** The row was
   * restored naming `<id>/<version>`; the tree was still sitting at
   * `<version>.replaced-…`; and `ensureStarted` forked a child against an entry
   * point that is not there — so `GET /plugins` showed the plugin `running` for as
   * long as the fork took, then `failed` with `Cannot find module`. Nothing
   * anywhere named the tree that was left, and the person reading the row had no
   * way to reach the one line that would have said so.
   * ---------------------------------------------------------------- */
  {
    const pluginRoot = join(realpathSync(tmp("plugin-unrestored-")), "plugins");
    const stores = openStores({ path: join(tmp("plugin-unrestored-db-"), "d.db"), instanceId: "i_unrestored" });
    let puts = 0;
    /*
     * ⚠ **The row refused and the tree carried off in one act, because that is the
     * only shape a driver can produce.** What `install` is guarding against is a
     * `rename(aside, target)` that fails — EACCES on a mount that went read-only,
     * EIO on a disk answering badly — and neither is something a driver can ask a
     * filesystem for portably. Taking the *source* away is the same failure by the
     * other door: `rename` answers ENOENT, `unrestored` comes back non-null, and
     * the arm under test is the one that runs. The throw is what gets `install`
     * into its catch at all; the rename is what makes the catch's own recovery
     * fail. `put` is the hook because it is the last statement before the tail of
     * the `try`, and because a database refusing a write is the throw the catch's
     * own docblock names first.
     */
    const records: PluginRecordStore = {
      list: () => stores.plugins.list(),
      get: (id) => stores.plugins.get(id),
      has: (id) => stores.plugins.has(id),
      setEnabled: (id, enabled, now) => stores.plugins.setEnabled(id, enabled, now),
      remove: (id) => stores.plugins.remove(id),
      put: (record) => {
        puts += 1;
        if (puts !== 2) {
          stores.plugins.put(record);
          return;
        }
        const holder = join(pluginRoot, "board");
        const moved = readdirSync(holder).find((one) => one.includes(".replaced-"));
        if (moved !== undefined) renameSync(join(holder, moved), join(holder, "carried-off"));
        throw new Error("the database would not take the row");
      },
    };

    const counted = counting();
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const host = await PluginHost.open({
      root: pluginRoot,
      records,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      runtime: counted.runtime,
      timeouts: { start: 200, invoke: 200 },
    });
    const put = (): ReturnType<typeof host.install> => host.install({ body: bodyOf(archive()), name: "p.tar.gz" });

    check("a plugin installs", (await put()).kind, "ok");
    stores.pluginData.set("board", "card:1", JSON.stringify({ keep: true }));
    const launchedBefore = counted.launches();

    /*
     * The same version again, which is the only path on which anything is moved
     * aside at all: `target` carries the version, so `aside` is non-null exactly
     * when somebody is reinstalling what is already there — the documented way to
     * iterate on a plugin they are writing rather than a rare race.
     */
    const blown = await put();
    // The restart the old arm fired is `void`ed, so a driver that read the row in
    // the same tick would find it `stopped` and pass either way.
    await settle();
    check(
      "an update whose row will not land is refused",
      blown.kind === "refused" ? blown.code : blown.kind,
      "plugin_write_failed",
    );
    /*
     * *Kept*, because the row is the only thing on this machine that can say any of
     * this: removing it would leave a plugin whose files are demonstrably still
     * under the root with nothing in `GET /plugins` naming it, and the whole of
     * what somebody would be told is one `onWarning` line in a log nobody is
     * reading.
     */
    check(
      "the row is still there rather than silently dropped",
      [records.has("board"), host.list().map((one) => one.id)],
      [true, ["board"]],
    );
    /*
     * ⚠ **`failed` rather than started, and that is the second half of the
     * choice.** `entryFor` resolves `<id>/<version>/server.js`, which is precisely
     * the path the `rename` failed to produce — so `ensureStarted` here forks a
     * child against a missing module and puts a sentence about Node's resolver on
     * the row where a sentence about what this daemon did belongs. `drain` holds a
     * `failed` plugin rather than restarting it, and `setEnabled(true)` is still
     * the way to ask for another attempt once somebody has moved the directory
     * back by hand.
     */
    check("and it does not claim the plugin is running", host.list().map((one) => one.state), ["failed"]);
    const failure = host.find("board")?.failure ?? "";
    report(
      "its failure names both the path its row promises and the one the tree is at",
      failure.includes(join(pluginRoot, "board", "1.0.0")) && failure.includes(".replaced-"),
      failure || "nothing on the row",
    );
    /*
     * One launch, and it is the new build's own — the incumbent is not started
     * again. The budget is deliberately not returned either, unlike the arm where
     * the tree *did* go back: there is nothing here to spend it on.
     */
    report(
      "and nothing was started against the path that is not there",
      counted.launches() - launchedBefore === 1,
      `${counted.launches() - launchedBefore} launches, of which the build that failed is one`,
    );

    // `remove` still works either way, which is what makes keeping the row cost
    // nothing — and it is the second half of "kept rather than dropped".
    check("it can still be uninstalled", await host.remove("board"), true);
    check(
      "with nothing of it left",
      [records.has("board"), existsSync(join(pluginRoot, "board")), stores.pluginData.keys("board", "")],
      [false, false, []],
    );

    await host.shutdown();
    await registry.shutdown();
    stores.close();
  }

  /* ---------------------------------------------------------------- *
   * An `rm` that fails inside the rollback, which used to take the rollback with it.
   *
   * ⚠ **Four of `discard`'s eight callers are inside a rollback, and the throw was
   * the only one of its three failure modes that was not already a `warn`.** A path
   * outside the root and a filesystem that will not answer are both reported and
   * returned from; an `rm` that threw came straight back out of `install`'s catch,
   * so `install` **rejected** instead of returning an `InstallOutcome`, the
   * incumbent never went back into `live`, and its tree was never renamed back —
   * a filesystem failure during recovery producing exactly the state the recovery
   * exists to prevent. `force: true` already swallows ENOENT, so what is left is
   * EPERM, EBUSY and EIO: a file somebody else has open, a mount going away
   * underneath, a disk answering badly.
   * ---------------------------------------------------------------- */
  if (process.getuid?.() === 0) {
    // A mode of 0o500 refuses root nothing, so the only way to reach the failure
    // here would be to fake it — and a driver that fakes the thing it is asserting
    // answers "is this covered?" with a false yes.
    process.stdout.write("  skip  running as root, for whom a read-only directory is not a refusal\n");
  } else {
    const pluginRoot = join(realpathSync(tmp("plugin-unremovable-")), "plugins");
    const holder = join(pluginRoot, "board");
    let bite = false;
    /*
     * `seed` is the throw the install catch's own docblock names, and it is the one
     * hook a driver has *between* `records.put` and the end of the `try` — the
     * window in which `wrote` is already true and `published` and `aside` are both
     * set. What it does on the way past is take the write bit off the one directory
     * the rollback is about to need.
     */
    const shaky = {
      watchSessions: () => () => {},
      list: () => {
        if (!bite) return [];
        bite = false;
        chmodSync(holder, 0o500);
        throw new Error("the registry was being torn down");
      },
      get: () => undefined,
      /*
       * ⚠ **Present because `syncContributions` calls through it, and the cast
       * above is why nothing else says so.** `PluginHostOptions.registry` is a
       * `SessionRegistry`, so a fixture that omits a member the host reaches for is
       * a `TypeError` at run time and green at `typecheck` — the same trap
       * `describe` on the ask-runner fakes already records.
       */
      sessionRuntime: { forgetStartRefusal: () => {}, forgetAvailability: () => {} },
    } as unknown as SessionRegistry;

    const stores = openStores({ path: join(tmp("plugin-unremovable-db-"), "d.db"), instanceId: "i_unremovable" });
    const counted = counting();
    const warnings: string[] = [];
    const host = await PluginHost.open({
      root: pluginRoot,
      records: stores.plugins,
      data: stores.pluginData,
      registry: shaky,
      api: { git: hostGit },
      onWarning: (detail) => warnings.push(detail),
      runtime: counted.runtime,
      timeouts: { start: 200, invoke: 200 },
    });
    const put = (): ReturnType<typeof host.install> => host.install({ body: bodyOf(archive()), name: "p.tar.gz" });
    check("a plugin installs", (await put()).kind, "ok");
    const incumbent = host.find("board");

    /*
     * ⚠ **A `discard` that fails necessarily leaves the destination occupied, so
     * the `rename` after it cannot succeed either** — the two are reached by one
     * act and each assertion below names its own half. What separates them is that
     * before the `rm` was wrapped, *none* of the lines after it ran at all.
     */
    bite = true;
    const outcome = await put().then(
      (answer) => (answer.kind === "refused" ? answer.code : answer.kind),
      () => "threw",
    );
    // Put back before anything is asserted, so a FAIL below does not also leave a
    // directory `sweepTmp` cannot remove.
    chmodSync(holder, 0o700);
    await settle();

    check("an rm that fails inside a rollback is a refusal rather than a throw", outcome, "plugin_write_failed");
    report(
      "and the failure is reported rather than swallowed",
      warnings.some((one) => one.startsWith(`could not remove ${join(holder, "1.0.0")}`)),
      warnings.join(" · ") || "nothing reported",
    );
    /*
     * ⚠ **The identity, not merely the presence.** `install` put its own
     * `LivePlugin` into `live` well before the throw and nothing takes it out on
     * the way past — so a `find` that only asked for non-null answered `true` about
     * the build that failed, sitting in `live` under the incumbent's id with the
     * incumbent unreachable from anywhere.
     */
    check("the incumbent is the plugin this host still holds", host.find("board") === incumbent, true);
    check(
      "and its row still names the version somebody installed, without claiming it runs",
      [stores.plugins.has("board"), host.list().map((one) => [one.id, one.version, one.state])],
      [true, [["board", "1.0.0", "failed"]]],
    );
    /*
     * The sentence, checked against the disk rather than against itself. `install`
     * writes both paths into it precisely so that somebody reading the row can find
     * the tree without a shell, and a row naming a path that is not there is the
     * failure this whole arm replaced.
     */
    const named = /are at (\S+)$/.exec(host.find("board")?.failure ?? "")?.[1] ?? "";
    report(
      "and the tree its row names is really where it says",
      named !== "" && existsSync(named),
      host.find("board")?.failure ?? "nothing on the row",
    );

    /*
     * ⚠ **The other direction, and the one that made `discard` stop throwing a
     * trade rather than a free win.** `doRemove` drops the row and the data and
     * *then* removes the tree, so it is the one caller for which "the `rm` failed"
     * may not be carried on past: answering `removed: true` over a tree still on
     * disk is a claim the next call disproves. `installed()`'s directory half reads
     * that leftover as installed for ever, and `<root>/<id>` matches neither
     * `STAGING_NAME` nor `REPLACED_NAME`, so no boot sweep will ever collect it —
     * a `DELETE` answering `true` and removing nothing, permanently.
     *
     * The write bit off the *root* rather than off the id directory, because that
     * is what `rm` needs to unlink the entry.
     */
    chmodSync(pluginRoot, 0o500);
    const refusedRemove = await host
      .remove("board")
      .then((one) => `answered ${String(one)}`, (error: unknown) => (error instanceof Error ? "threw" : "threw a non-error"));
    chmodSync(pluginRoot, 0o700);
    check("a remove whose rm fails does not report a removal it did not make", refusedRemove, "threw");
    report(
      "and the tree it could not remove is still there to be found",
      existsSync(holder),
      `${holder} ${existsSync(holder) ? "is" : "is not"} on disk`,
    );
    // And with the bit back, the same call finishes — the refusal above is the
    // filesystem's, not a plugin this daemon has decided it can never be rid of.
    check("and once the filesystem allows it, the same remove lands", await host.remove("board"), true);
    check("with nothing of it left, and nothing claiming otherwise", existsSync(holder), false);

    await host.shutdown();
    stores.close();
  }
}
