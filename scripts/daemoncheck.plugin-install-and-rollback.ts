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
  // An uninstall must sweep the plugin's pasted keys: `prune` touches neither credential table, so skipping it leaves a third party's key behind.
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

  // An archive holding one folder must work too; nothing deeper than one level is searched.
  const nested = await install({ "board/plugin.json": manifestOf({ version: "0.1.1" }), "board/server.js": SERVER });
  check("an archive holding one folder is the same plugin", nested.kind === "ok" ? nested.replaced : nested, "0.1.0");

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

  const again = await install({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER });
  check("reinstalling the same version works", again.kind, "ok");

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

  // `unpackArchive` is shared with the import route but its codes are not: this drives `archiveCode`, the translation, at `PLUGIN_LIMITS`.
  const { PLUGIN_LIMITS } = await import("../src/archive.js");

  // `tarOf` always writes an honest size field, so only a header declaring more than it carries reaches `archive_unreadable`.
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
  // A listing, not a probe per case: some of these are refused after members were written, so the root must hold only the prior plugin.
  check(
    "and after every one of those the machine is exactly as it was",
    [host.list().map((one) => [one.id, one.version, one.state]), readdirSync(join(root, "plugins"))],
    [[["board", "0.2.0", "running"]], ["board"]],
  );

  // One install at a time, daemon-wide: nothing charges an installed plugin once it lands, so the bound is on arrival (Q7.97).
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

  // A reinstall of the running version moves the incumbent aside; a throw from `seed` after the row is written must restore it, not lose both trees.
  // A registry whose list throws is how `seed` is made to fail.
  {
    let listThrows = false;
    const shaky = {
      watchSessions: () => () => {},
      list: () => {
        if (listThrows) throw new Error("the registry was being torn down");
        return [];
      },
      get: () => undefined,
      // Present because `syncContributions` calls through it; the cast hides a missing member from `typecheck`.
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
    // Not failed, and deliberately not running: the rollback restarts the incumbent without waiting.
    const back = shakyHost.list().map((one) => [one.id, one.version, one.state !== "failed"]);
    check("and the plugin somebody was iterating on is still there, and not failed", back, [["board", "2.0.0", true]]);
    check("with the tree its row names", existsSync(join(shakyRoot, "board", "2.0.0")), true);
    check("and nothing moved aside left behind", readdirSync(join(shakyRoot, "board")), ["2.0.0"]);
    check("and its data untouched", shakyStores.pluginData.keys("board", ""), ["card:1"]);

    // A failed first install must leave no `plugin_data` rows: nothing could reach them, and they would reappear under the next install.
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

    // A row this build cannot validate is hidden from `list` and `get` but not from `records.has`, and a downgrade leaves one; its data must survive.
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
    // `find`, not a count: this record store is shared with the host above.
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

  // Two paths, because they cancel in different places: the busy arm before it returns, a refusal in the `finally`.
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

    // Only a refusal that stops mid-stream has anything left to release: the ceiling, where `unpackArchive` stops reading.
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

  // A broken update must leave the plugin that was there, not none.
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

  // At the installed version the destination is the running plugin's own directory, so the old tree is moved aside, not cleared.
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

  // A switched-off plugin's update is still started and stopped again, so a broken one is refused and a good one lands switched off.
  // `setEnabled` answers busy only while an install holds the mutex; none races here, so busy becomes null and the dedicated case proves the refusal.
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

  // Every mutation shares the mutex, so a remove or a switch mid-install is refused and the install's data survives.
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

  // An update must sweep no credentials; it holds because the update path never calls `doRemove`.
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
  check("and everything it kept", stores.pluginData.keys("board", ""), []);
  // Swept by namespace prefix out of both credential tables: a prefix needs no manifest, so an unreadable row cannot defeat it.
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

  // `install`'s `finally` is not reached by an OOM or a SIGKILL, so `open` sweeps staging at the root and moved-aside trees one level below an id.
  // Laid out by hand and aged with `utimesSync`: the sweep reads the real clock on purpose.
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
  // Shaped almost right, which is why `STAGING_NAME` is exact rather than a prefix test.
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

  // Aged last: creating an entry bumps the parent's mtime.
  for (const path of [staleStaging, oddStaging, staleReplaced, oddReplaced, deepReplaced, deepStaging, published]) {
    utimesSync(path, old, old);
  }
  // `lutimes`, not `utimes`: ageing through the link would leave the link fresh, and the mtime test rather than the directory test would save it.
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
  // The half with no symptom: a sweep of the whole tree would delete a plugin's own files that happen to wear either name.
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

  // A second shutdown is the same promise and resolves only once the children are down; `scripts/daemon.ts` closes the stores after it.
  {
    let stops = 0;
    let release = (): void => {};
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

    // A body that charges bytes and never time: `install` holds the mutex while `unpackArchive` waits for a chunk that never comes.
    const trickle = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    const parked = host.install({ body: trickle, name: "trickle.tar.gz" });
    // Nothing settles this, and an unhandled install would reject later if anything did.
    void parked.then(
      () => {},
      () => {},
    );
    // Kept reachable for the rest of the run, or its descriptor is collected and takes the process down (see `retain`); the stream, not just the promise.
    retain(trickle, parked);
    await settle();

    // Raced against a bell because what is pinned is a hang: awaiting alone would sit here instead of failing.
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
    // The deadline is module-private, so it is read off the warning; asserted both ways, since a deleted wait writes the same sentence in no time.
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

    // An install admitted after shutdown would fork a child no stop reaches; `shuttingDown` is set before anything can ask.
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

  // Swept over all four because what is pinned is `exclusive`; `install` and `installFromSource` check for themselves, outside the helper.
  {
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
      // No network: this is about the claim `installFromSource` makes before it fetches anything.
      fetchArchive: () => Promise.resolve(new Response(new Uint8Array(archive()), { status: 200 })),
    });
    const source = { kind: "github", repo: "rends-east/reemoat-board", commit: "b".repeat(40) } as const;

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
      // Serially, so each answers about the state this driver set rather than a neighbour's.
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
    const afterwards = await sweep();
    report(
      "and every one of them is answerable again",
      afterwards.every(([, answer]) => answer !== "busy"),
      afterwards.map(([name, answer]) => `${name}: ${answer}`).join(", "),
    );

    // `exclusive` answers busy for a shutdown too; the two that check for themselves say shutting_down.
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

  // A counted launch, so a launch that should not happen is a number rather than a late module-not-found.
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

  // A rollback that cannot put the tree back keeps the row, marks it failed and names both paths.
  {
    const pluginRoot = join(realpathSync(tmp("plugin-unrestored-")), "plugins");
    const stores = openStores({ path: join(tmp("plugin-unrestored-db-"), "d.db"), instanceId: "i_unrestored" });
    let puts = 0;
    // The row refused and the tree carried off in one act: a failing rename is not portably producible, so its source is taken away instead.
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

    // The same version again: the only path on which anything is moved aside.
    const blown = await put();
    // The old restart is voided, so reading the row in the same tick would pass either way.
    await settle();
    check(
      "an update whose row will not land is refused",
      blown.kind === "refused" ? blown.code : blown.kind,
      "plugin_write_failed",
    );
    // Kept: the row is the only thing that can say where the files are.
    check(
      "the row is still there rather than silently dropped",
      [records.has("board"), host.list().map((one) => one.id)],
      [true, ["board"]],
    );
    // Failed rather than started: `entryFor` resolves the path the rename failed to produce.
    check("and it does not claim the plugin is running", host.list().map((one) => one.state), ["failed"]);
    const failure = host.find("board")?.failure ?? "";
    report(
      "its failure names both the path its row promises and the one the tree is at",
      failure.includes(join(pluginRoot, "board", "1.0.0")) && failure.includes(".replaced-"),
      failure || "nothing on the row",
    );
    report(
      "and nothing was started against the path that is not there",
      counted.launches() - launchedBefore === 1,
      `${counted.launches() - launchedBefore} launches, of which the build that failed is one`,
    );

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

  // An `rm` failing inside a rollback must be reported and returned from, not thrown out of the catch in `install`.
  if (process.getuid?.() === 0) {
    // A mode of 0o500 refuses root nothing, and faking the failure would answer is-this-covered with a false yes.
    process.stdout.write("  skip  running as root, for whom a read-only directory is not a refusal\n");
  } else {
    const pluginRoot = join(realpathSync(tmp("plugin-unremovable-")), "plugins");
    const holder = join(pluginRoot, "board");
    let bite = false;
    // `seed` is the one hook between the row write and the end of the `try`; it takes the write bit off the directory the rollback needs.
    const shaky = {
      watchSessions: () => () => {},
      list: () => {
        if (!bite) return [];
        bite = false;
        chmodSync(holder, 0o500);
        throw new Error("the registry was being torn down");
      },
      get: () => undefined,
      // Present because `syncContributions` calls through it; the cast hides a missing member from `typecheck`.
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

    // A failed `discard` leaves the destination occupied, so the rename after it fails too; each assertion names its own half.
    bite = true;
    const outcome = await put().then(
      (answer) => (answer.kind === "refused" ? answer.code : answer.kind),
      () => "threw",
    );
    // Put back before asserting, so a FAIL does not also leave a directory the temp sweep cannot remove.
    chmodSync(holder, 0o700);
    await settle();

    check("an rm that fails inside a rollback is a refusal rather than a throw", outcome, "plugin_write_failed");
    report(
      "and the failure is reported rather than swallowed",
      warnings.some((one) => one.startsWith(`could not remove ${join(holder, "1.0.0")}`)),
      warnings.join(" · ") || "nothing reported",
    );
    // Identity, not presence: the failed build's `LivePlugin` sits in `live` under the same id.
    check("the incumbent is the plugin this host still holds", host.find("board") === incumbent, true);
    check(
      "and its row still names the version somebody installed, without claiming it runs",
      [stores.plugins.has("board"), host.list().map((one) => [one.id, one.version, one.state])],
      [true, [["board", "1.0.0", "failed"]]],
    );
    // Checked against the disk: a row naming a path that is not there is the failure this arm replaced.
    const named = /are at (\S+)$/.exec(host.find("board")?.failure ?? "")?.[1] ?? "";
    report(
      "and the tree its row names is really where it says",
      named !== "" && existsSync(named),
      host.find("board")?.failure ?? "nothing on the row",
    );

    // `doRemove` drops the row and data before the tree, so a failed `rm` there must throw: no boot sweep would ever collect the leftover.
    // The write bit comes off the root, which is what `rm` needs to unlink the entry.
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
    check("and once the filesystem allows it, the same remove lands", await host.remove("board"), true);
    check("with nothing of it left, and nothing claiming otherwise", existsSync(holder), false);

    await host.shutdown();
    stores.close();
  }
}
