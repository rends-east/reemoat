import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import type { Scope } from "../src/auth.js";
import type { PluginRuntime } from "../src/plugins/runtime.js";
import type { PluginRecordStore } from "../src/plugins/store.js";
import { createApp } from "../src/server.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { tokenWith, tokenFor, verifier } from "./daemoncheck.fixtures.js";
import { tarOf } from "./daemoncheck.bodies.js";

process.stdout.write("\nthe plugin routes\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { PLUGIN_API_VERSION } = await import("../src/plugins/protocol.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const parsed = parseManifest(
    JSON.stringify({
      id: "p",
      name: "P",
      version: "1.0.0",
      api: 1,
      scopes: [],
      contributes: { screen: { title: "P" }, settings: true, actions: [{ id: "go", title: "Go", on: "screen" }] },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.message);

  const runtime: PluginRuntime = {
    launch(options) {
      return Promise.resolve({
        send(message) {
          if (message.t === "init") {
            queueMicrotask(() => options.onMessage({ t: "ready" }));
            return true;
          }
          if (message.t === "invoke") {
            queueMicrotask(() =>
              options.onMessage({
                t: "done",
                id: message.id,
                ok: true,
                // A list beside the text, to show the route reaches the surface clamp: a screen keeps it, a settings pane drops it.
                value: {
                  title: message.name,
                  blocks: [
                    { type: "text", text: message.name, tone: "default" },
                    { type: "list", empty: "nothing", rows: [{ id: "a", title: "A" }] },
                  ],
                },
              }),
            );
          }
          // Reports the write, as `ForkedPlugin` does; nothing here ever refuses one.
          return true;
        },
        stop: () => Promise.resolve(),
        recentLogs: () => [],
      });
    },
  };

  // A plugin contributing neither surface, so the view route is driven on the manifest and not only on the vocabulary.
  const quiet = parseManifest(
    JSON.stringify({ id: "quiet", name: "Quiet", version: "1.0.0", api: 1, scopes: [], contributes: {} }),
  );
  if (!quiet.ok) throw new Error(quiet.message);

  const stores = openStores({ path: join(tmp("plugin-routes-"), "d.db"), instanceId: "i_routes" });
  stores.plugins.put({
    id: "p",
    version: "1.0.0",
    manifest: parsed.manifest,
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    source: null,
  });
  // Enabled, or the routes below would answer 503 for an unrelated reason.
  stores.plugins.put({
    id: "quiet",
    version: "1.0.0",
    manifest: quiet.manifest,
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    source: null,
  });
  const registry = new SessionRegistry(stores.events, stores.sessions);
  const host = await PluginHost.open({
    root: join(tmp("plugin-routes-root-"), "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
    runtime,
    timeouts: { start: 500, invoke: 500 },
  });

  const { app: pluginApp } = createApp({
    registry,
    verifier,
    instanceId: "i_routes",
    startedAt: Date.now(),
    plugins: host,
  });
  const { app: bareApp } = createApp({
    registry,
    verifier,
    instanceId: "i_bare",
    startedAt: Date.now(),
  });

  const call = async (
    app: typeof pluginApp,
    path: string,
    init: RequestInit = {},
    token = tokenFor("routes"),
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  const codeOf = (body: Record<string, unknown>): string =>
    ((body["error"] as { code?: string } | undefined)?.code ?? "none");

  const listing = await call(pluginApp, "/plugins");
  // The api is read from the constant rather than written down, so this assertion
  // survives the next accept-both step instead of pinning today's ceiling.
  check(
    "the listing",
    [listing.status, (listing.body["plugins"] as { id?: string }[]).map((one) => one.id), listing.body["api"]],
    [200, ["p", "quiet"], PLUGIN_API_VERSION],
  );

  // Without a plugin host the daemon answers 503, never an empty list: none and unsupported are different answers.
  const off = await call(bareApp, "/plugins");
  check("a daemon with plugins switched off", [off.status, codeOf(off.body)], [503, "plugins_unavailable"]);
  const sweep: [string, RequestInit][] = [
    ["/plugins", {}],
    ["/plugins", { method: "POST", body: "an archive nobody will look at" }],
    // The list is the assertion: a route written outside withPlugins would throw or act rather than answer 503.
    [
      "/plugins/source",
      {
        method: "POST",
        body: JSON.stringify({ source: { kind: "github", repo: "o/r", commit: "a".repeat(40) } }),
      },
    ],
    ["/plugins/p", { method: "DELETE" }],
    ["/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: true }) }],
    ["/plugins/p/views/screen", {}],
    ["/plugins/p/actions/go", { method: "POST", body: "{}" }],
  ];
  const swept: [number, string][] = [];
  for (const [path, init] of sweep) {
    const answer = await call(bareApp, path, init);
    swept.push([answer.status, codeOf(answer.body)]);
  }
  check(
    "and so does every one of the seven",
    swept,
    sweep.map(() => [503, "plugins_unavailable"]),
  );

  check(
    "no credential at all",
    (await pluginApp.request("/plugins")).status,
    401,
  );

  const blocksOf = (body: Record<string, unknown>): string[] => {
    const shown = (body["result"] as { view?: { blocks?: { type?: string }[] } } | undefined)?.view?.blocks ?? [];
    return shown.map((one) => one.type ?? "?");
  };
  const view = await call(pluginApp, "/plugins/p/views/screen");
  check("a screen", [view.status, ((view.body["result"] as { view?: { title?: string } })?.view?.title ?? null)], [200, "screen"]);
  const settings = await call(pluginApp, "/plugins/p/views/settings");
  check("and a settings pane", ((settings.body["result"] as { view?: { title?: string } })?.view?.title ?? null), "settings");
  // Asserted as a pair: either line alone passes for a build that clamps both surfaces alike.
  check("a screen keeps a list", blocksOf(view.body), ["text", "list"]);
  check("and a settings pane drops it, with a line saying so", blocksOf(settings.body), ["text", "notice"]);

  const noView = await call(pluginApp, "/plugins/p/views/board");
  check("a view that is not one of the two", [noView.status, codeOf(noView.body)], [404, "view_not_found"]);
  const noPlugin = await call(pluginApp, "/plugins/nope/views/screen");
  check("a plugin that is not installed", [noPlugin.status, codeOf(noPlugin.body)], [404, "plugin_not_found"]);

  // Both are 404 view_not_found, so the sentence is what tells the vocabulary refusal from the manifest one.
  const sayOf = (body: Record<string, unknown>): string =>
    String((body["error"] as { message?: string } | undefined)?.message ?? "");
  const noScreen = await call(pluginApp, "/plugins/quiet/views/screen");
  check(
    "a screen on a plugin that declares none",
    [noScreen.status, codeOf(noScreen.body), sayOf(noScreen.body)],
    [404, "view_not_found", "this plugin declares no such view"],
  );
  const noSettings = await call(pluginApp, "/plugins/quiet/views/settings");
  check(
    "and a settings pane on the same one",
    [noSettings.status, codeOf(noSettings.body), sayOf(noSettings.body)],
    [404, "view_not_found", "this plugin declares no such view"],
  );
  check(
    "while the vocabulary refusal still says the other thing",
    sayOf(noView.body),
    "a plugin draws a screen and a settings pane, and no other view",
  );

  const acted = await call(pluginApp, "/plugins/p/actions/go", { method: "POST", body: "{}" });
  check("an action the manifest declares", acted.status, 200);
  // Undeclared action ids are refused here, so a plugin need not defend against ids it never declared.
  const undeclared = await call(pluginApp, "/plugins/p/actions/nope", { method: "POST", body: "{}" });
  check("one it does not", [undeclared.status, codeOf(undeclared.body)], [404, "action_not_found"]);

  const state = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: false }) });
  check("switching one off over HTTP", [state.status, ((state.body["plugin"] as { enabled?: boolean })?.enabled ?? null)], [200, false]);
  const badState = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: "no" }) });
  check("with something that is not a boolean", [badState.status, codeOf(badState.body)], [400, "bad_request"]);

  // These scopes are the caller's; what the plugin itself may reach is manifest.scopes, checked elsewhere.
  const readOnly = tokenWith("reader", ["session:read"]);
  const writer = tokenWith("writer", ["session:read", "session:write"]);
  const readList = await call(pluginApp, "/plugins", {}, readOnly);
  check("a read-only grant may list plugins", readList.status, 200);
  // Switched back on first: a disabled plugin answers 503 whoever asks, which would mask this check.
  await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: true }) });
  const readView = await call(pluginApp, "/plugins/p/views/screen", {}, readOnly);
  check(
    "and may look at its screen",
    [readView.status, ((readView.body["result"] as { view?: { title?: string } })?.view?.title ?? null)],
    [200, "screen"],
  );
  const readAction = await call(pluginApp, "/plugins/p/actions/go", { method: "POST", body: "{}" }, readOnly);
  check("and may press nothing", [readAction.status, codeOf(readAction.body)], [403, "insufficient_scope"]);
  const writerInstall = await call(pluginApp, "/plugins", { method: "POST", body: "" }, writer);
  check("installing needs more than session:write", [writerInstall.status, codeOf(writerInstall.body)], [403, "insufficient_scope"]);
  const writerRemove = await call(pluginApp, "/plugins/p", { method: "DELETE" }, writer);
  check("and so does removing", [writerRemove.status, codeOf(writerRemove.body)], [403, "insufficient_scope"]);
  const writerState = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: true }) }, writer);
  check("and switching one off", [writerState.status, codeOf(writerState.body)], [403, "insufficient_scope"]);

  // Only the verbs CORS_ALLOW_METHODS advertises.
  const removed = await call(pluginApp, "/plugins/p", { method: "DELETE" });
  check("removing one", [removed.status, removed.body["removed"]], [200, true]);
  // Removing twice answers the same because the client replays DELETE; only removed tells the two sends apart.
  const gone = await call(pluginApp, "/plugins/p", { method: "DELETE" });
  check(
    "and removing it again answers exactly as the first send did",
    [
      [removed.status, codeOf(removed.body)],
      [gone.status, codeOf(gone.body)],
    ],
    [
      [200, "none"],
      [200, "none"],
    ],
  );
  check(
    "with `removed` the only thing telling the two apart",
    [removed.body["removed"], gone.body["removed"]],
    [true, false],
  );

  const verbs = new Set(
    pluginApp.routes.filter((route) => route.path.startsWith("/plugins")).map((route) => route.method.toUpperCase()),
  );
  check("the plugin routes use no verb the CORS list withholds", [...verbs].sort(), ["DELETE", "GET", "POST"]);

  // shutting_down is tested before anything is read; driven last because the flag is one-way.
  await registry.shutdown();
  const late = await call(pluginApp, "/plugins", { method: "POST", body: "an archive that arrived too late" });
  check("installing into a daemon that is going away", [late.status, codeOf(late.body)], [503, "shutting_down"]);

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}

process.stdout.write("\ninstalling a plugin over HTTP, and what each refusal is worth\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");
  const { PLUGIN_LIMITS } = await import("../src/archive.js");

  /** A child that starts, or one that sends fail, which reaches pluginInstallStatus without waiting out the start deadline. */
  const childThat = (starts: boolean): PluginRuntime => ({
    launch(options) {
      return Promise.resolve({
        send(message) {
          if (message.t === "init") {
            queueMicrotask(() =>
              options.onMessage(starts ? { t: "ready" } : { t: "fail", error: "this build will not run" }),
            );
            return true;
          }
          if (message.t === "invoke") {
            queueMicrotask(() => options.onMessage({ t: "done", id: message.id, ok: true, value: null }));
          }
          return true;
        },
        stop: () => Promise.resolve(),
        recentLogs: () => [],
      });
    },
  });

  const manifestOf = (patch: Record<string, unknown> = {}): string =>
    JSON.stringify({ id: "board", name: "Board", version: "1.0.0", api: 1, scopes: [], contributes: {}, ...patch });
  const archiveOf = (patch: Record<string, unknown> = {}): Buffer =>
    tarOf({ "plugin.json": manifestOf(patch), "server.js": "export function settings() { return {}; }" });

  /** refusesToWrite swaps in a record store whose put throws, the only way to reach plugin_write_failed. */
  const rigFor = async (
    name: string,
    options: {
      starts: boolean;
      refusesToWrite?: boolean;
      /** Stands in for the GitHub fetch, so every refusal on the source path runs with no network. */
      fetchArchive?: (url: string, signal: AbortSignal) => Promise<Response>;
    } = { starts: true },
  ): Promise<{
    host: Awaited<ReturnType<typeof PluginHost.open>>;
    app: ReturnType<typeof createApp>["app"];
    /** The real store behind the host, so a case can ask what is durably there. */
    rows: PluginRecordStore;
    close: () => Promise<void>;
  }> => {
    const stores = openStores({ path: join(tmp(`plugin-http-${name}-`), "d.db"), instanceId: `i_http_${name}` });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const records: PluginRecordStore =
      options.refusesToWrite === true
        ? {
            // Delegated one method at a time rather than spread, because a spread
            // of a class instance copies its fields and loses its prototype.
            list: () => stores.plugins.list(),
            get: (id) => stores.plugins.get(id),
            has: (id) => stores.plugins.has(id),
            put: () => {
              throw new Error("the database would not take that row");
            },
            setEnabled: (id, enabled, at) => stores.plugins.setEnabled(id, enabled, at),
            remove: (id) => stores.plugins.remove(id),
          }
        : stores.plugins;
    const host = await PluginHost.open({
      root: join(tmp(`plugin-http-root-${name}-`), "plugins"),
      records,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      runtime: childThat(options.starts),
      timeouts: { start: 500, invoke: 500 },
      ...(options.fetchArchive === undefined ? {} : { fetchArchive: options.fetchArchive }),
    });
    const { app } = createApp({
      registry,
      verifier,
      instanceId: `i_http_${name}`,
      startedAt: Date.now(),
      plugins: host,
    });
    return {
      host,
      app,
      rows: stores.plugins,
      close: async () => {
        await host.shutdown();
        await registry.shutdown();
        stores.close();
      },
    };
  };

  const post = async (
    app: ReturnType<typeof createApp>["app"],
    query: string,
    body: Uint8Array | null,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const init: RequestInit = { method: "POST", headers: { authorization: `Bearer ${tokenFor("http")}`, ...headers } };
    // Assigned rather than passed as null: the route's no-body arm needs a Request with no body at all.
    if (body !== null) init.body = body;
    const response = await app.request(`/plugins${query}`, init);
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  const errorOf = (body: Record<string, unknown>): { code: string; detail: unknown } => {
    const error = body["error"] as { code?: string; detail?: unknown } | undefined;
    return { code: error?.code ?? "none", detail: error?.detail ?? null };
  };

  const good = await rigFor("good");

  // Install and update are one verb: 201 for a new plugin, 200 with replaced for an update.
  const created = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check("a plugin arrives over HTTP", [created.status, created.body["replaced"]], [201, null]);
  const updated = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf({ version: "1.1.0" })));
  check(
    "and the same id again is an update rather than a second plugin",
    [updated.status, updated.body["replaced"], (updated.body["plugin"] as { version?: string } | undefined)?.version],
    [200, "1.0.0", "1.1.0"],
  );

  // The name is only a label, sanitized because it is echoed back, by the same function the upload and import routes use.
  const badNames: [string, string, string][] = [
    ["with no name at all", "", "empty"],
    [
      "with a name holding a control character",
      `?name=${encodeURIComponent(`a${String.fromCharCode(7)}b.tgz`)}`,
      "control_char",
    ],
    ["with a name that is a directory rather than a file", "?name=..", "reserved"],
  ];
  for (const [label, query, reason] of badNames) {
    const answer = await post(good.app, query, new Uint8Array(archiveOf()));
    const error = errorOf(answer.body);
    check(label, [answer.status, error.code, (error.detail as { reason?: string } | null)?.reason ?? null], [
      400,
      "invalid_name",
      reason,
    ]);
  }

  // A content-length is honoured to refuse and never to accept; the unpack counter is what enforces the bound.
  const overDeclared = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf()), {
    "content-length": String(PLUGIN_LIMITS.maxBytes + 1),
  });
  check(
    "a request declaring more than a plugin may be",
    [overDeclared.status, errorOf(overDeclared.body).code],
    [413, "plugin_too_large"],
  );
  const overSent = await post(good.app, "?name=board.tar.gz", new Uint8Array(Buffer.alloc(PLUGIN_LIMITS.maxBytes + 1)));
  check(
    "and one that simply is",
    [overSent.status, errorOf(overSent.body).code],
    [413, "plugin_too_large"],
  );

  // Split by whose problem it is: 413 for bounds, 409 for a plugin that will not start, 400 for the archive or manifest.
  const crowded: Record<string, string> = {};
  for (let index = 0; index <= PLUGIN_LIMITS.maxEntries; index += 1) crowded[`f${index}.txt`] = "x";
  const installRefusals: [string, Buffer, number, string][] = [
    ["more members than a plugin has", tarOf(crowded), 413, "plugin_too_many_entries"],
    [
      "one that unpacks past what a plugin may be",
      tarOf({ "plugin.json": manifestOf(), "big.js": "x".repeat(PLUGIN_LIMITS.maxUnpackedBytes + 1) }),
      413,
      "plugin_unpacked_too_large",
    ],
    ["an archive with no manifest in it", tarOf({ "server.js": "export function settings() {}" }), 400, "manifest_missing"],
    ["a manifest this daemon will not read", tarOf({ "plugin.json": "{", "server.js": "x" }), 400, "manifest_unreadable"],
    ["something that is not an archive at all", Buffer.from("not an archive"), 400, "unsupported_archive"],
    ["an archive holding nothing", gzipSync(Buffer.alloc(1024)), 400, "archive_empty"],
  ];
  for (const [label, bytes, status, code] of installRefusals) {
    const answer = await post(good.app, "?name=board.tar.gz", new Uint8Array(bytes));
    check(label, [answer.status, errorOf(answer.body).code], [status, code]);
  }

  const bodyless = await post(good.app, "?name=board.tar.gz", null);
  check("a request with no body", [bodyless.status, errorOf(bodyless.body).code], [400, "bad_request"]);

  // One install at a time daemon-wide, which is reachable: the relay allows 256 concurrent streams.
  const both = await Promise.all([
    post(good.app, "?name=a.tar.gz", new Uint8Array(archiveOf({ version: "1.2.0" }))),
    post(good.app, "?name=b.tar.gz", new Uint8Array(archiveOf({ version: "1.2.0" }))),
  ]);
  report(
    "two installs at once, and one of them is told to come back",
    both.some((one) => one.status === 409 && errorOf(one.body).code === "plugin_busy") &&
      both.some((one) => one.status === 200),
    both.map((one) => `${one.status} ${errorOf(one.body).code}`).join(", "),
  );
  check("and the machine holds one plugin either way", good.host.list().map((one) => one.id), ["board"]);
  await good.close();

  // 409 rather than 400: a build that will not run leaves the previous version running, which is a conflict.
  const broken = await rigFor("broken", { starts: false });
  const refused = await post(broken.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check(
    "a plugin whose build will not start",
    [refused.status, errorOf(refused.body).code],
    [409, "plugin_start_failed"],
  );
  check("and nothing was installed", broken.host.list(), []);
  await broken.close();

  // 503 because the remedy is on this machine; the published tree must be discarded and nothing left running.
  const unwritable = await rigFor("unwritable", { starts: true, refusesToWrite: true });
  const notWritten = await post(unwritable.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check(
    "a row the database would not take",
    [notWritten.status, errorOf(notWritten.body).code],
    [503, "plugin_write_failed"],
  );
  check("and no row was written", unwritable.rows.has("board"), false);
  check("and the tree it had published is gone", existsSync(join(unwritable.host.pluginRoot, "board", "1.0.0")), false);
  check("and the listing does not report a plugin that is not installed", unwritable.host.list(), []);
  check("nor is one left running out of a tree that is gone", await unwritable.host.remove("board"), false);
  check(
    "and the directory made to hold it went with it",
    existsSync(join(unwritable.host.pluginRoot, "board")),
    false,
  );
  await unwritable.close();

  const SHA = "a".repeat(40);
  const REPO_NAME = "rends-east/reemoat-board";

  /** What the far end said, scripted. The daemon never reaches a network here. */
  const sourceRig = async (
    name: string,
    answer: (url: string) => Response | Promise<Response>,
  ): Promise<Awaited<ReturnType<typeof rigFor>> & { urls: string[] }> => {
    const urls: string[] = [];
    const rig = await rigFor(name, {
      starts: true,
      fetchArchive: async (url) => {
        urls.push(url);
        return await answer(url);
      },
    });
    return { ...rig, urls };
  };

  const postSource = async (
    app: ReturnType<typeof createApp>["app"],
    body: unknown,
    scopes: Scope[] = ["session:read", "session:write", "machine:admin"],
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.request("/plugins/source", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenWith("http", scopes)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };

  const tarball = (patch: Record<string, unknown> = {}): Response =>
    new Response(new Uint8Array(archiveOf(patch)), { status: 200 });

  // The daemon builds the codeload address itself: nothing on the wire names a host, and the github.com archive spelling redirects.
  const fromSource = await sourceRig("source", () => tarball());
  const arrived = await postSource(fromSource.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("a plugin arrives from a commit", [arrived.status, arrived.body["replaced"]], [201, null]);
  check("and the daemon built the address itself", fromSource.urls, [
    `https://codeload.github.com/${REPO_NAME}/tar.gz/${SHA}`,
  ]);
  // The row records the pin; it is written and never read for a decision.
  check("and the row records the commit it came from", fromSource.rows.get("board")?.source, `github:${REPO_NAME}@${SHA}`);

  const again = await postSource(fromSource.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("and the same id again is an update, exactly as an upload would be", [again.status, again.body["replaced"]], [200, "1.0.0"]);
  await fromSource.close();

  // consentGap compares only fields that survive normalisation, so a manifest with no contributes is not a breach.
  const plainest = await sourceRig("plain", () => tarball({ contributes: undefined, description: undefined }));
  const plain = await postSource(plainest.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("a manifest that writes no contributes at all is not a consent breach", plain.status, 201);
  await plainest.close();

  // Nothing local opened this archive, so a consent gap is refused before the plugin starts rather than reported after.
  const sneaky = await sourceRig("sneaky", () =>
    tarball({ scopes: ["store", "sessions.read"], contributes: { hooks: ["permission.requested"] } }),
  );
  const overreached = await postSource(sneaky.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check(
    "a commit asking for more than was shown",
    [overreached.status, errorOf(overreached.body).code],
    [409, "plugin_consent_broken"],
  );
  check("and nothing was installed", [sneaky.host.list(), sneaky.rows.has("board")], [[], false]);

  // No consent at all is the CLI's case, and install skips the check for it.
  const unasked = await postSource(sneaky.app, { source: { kind: "github", repo: REPO_NAME, commit: SHA } });
  check("a caller that consented to nothing at all is not held to nothing", unasked.status, 201);
  await sneaky.close();

  // An older browser sends no adds, so a commit adding a harness is refused with the code that client already renders.
  const adder = await sourceRig("adder", () =>
    tarball({
      api: 5,
      scopes: ["harness"],
      contributes: { harnesses: [{ id: "gemini", name: "Gemini", command: "gemini", args: ["acp"] }] },
    }),
  );
  const unshown = await postSource(adder.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: ["harness"], net: [], hooks: [] },
  });
  check(
    "a commit that adds an agent nobody was shown",
    [unshown.status, errorOf(unshown.body).code],
    [409, "plugin_consent_broken"],
  );
  // The argv is in the sentence, because the argv is what was agreed to.
  check(
    "and the sentence names what it would have run",
    String((unshown.body["error"] as { message?: string } | undefined)?.message ?? "").includes(
      "harness gemini runs gemini acp",
    ),
    true,
  );
  check("and nothing was installed", [adder.host.list(), adder.rows.has("board")], [[], false]);
  const shown = await postSource(adder.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: ["harness"], net: [], hooks: [], adds: ["harness gemini runs gemini acp"] },
  });
  check("while the same commit, disclosed, installs", shown.status, 201);
  await adder.close();

  // codeload sends no content-length, so the real bound is unpackArchive charging each chunk.
  const flood = await sourceRig("flood", () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= PLUGIN_LIMITS.maxBytes + chunk.byteLength) {
            controller.close();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
  });
  const flooded = await postSource(flood.app, { source: { kind: "github", repo: REPO_NAME, commit: SHA } });
  check(
    "an archive over the ceiling, arriving with no content-length",
    [flooded.status, errorOf(flooded.body).code],
    [413, "plugin_too_large"],
  );
  await flood.close();

  const farEnd: [string, () => Response | Promise<Response>, number, string][] = [
    ["a commit that is not there", () => new Response("no", { status: 404 }), 502, "plugin_source_not_found"],
    ["a forge having a bad day", () => new Response("no", { status: 500 }), 502, "plugin_source_unavailable"],
    [
      // What a refused redirect produces: a throw rather than a status.
      "a redirect, which this path refuses to follow",
      () => Promise.reject(new Error("unexpected redirect")),
      502,
      "plugin_source_unavailable",
    ],
  ];
  for (const [label, answer, status, code] of farEnd) {
    const rig = await sourceRig(`far-${code}-${status}-${label.length}`, answer);
    const said = await postSource(rig.app, { source: { kind: "github", repo: REPO_NAME, commit: SHA } });
    check(label, [said.status, errorOf(said.body).code], [status, code]);
    await rig.close();
  }

  // A tag or a short sha is refused: a tag can move, and the pinned code runs as the owner.
  const bad = await sourceRig("bad", () => tarball());
  const shapes: [string, unknown][] = [
    ["no source at all", {}],
    ["a forge this daemon does not install from", { source: { kind: "gitlab", repo: REPO_NAME, commit: SHA } }],
    ["a repo that is not owner/name", { source: { kind: "github", repo: "board", commit: SHA } }],
    ["a repo reaching for a third path segment", { source: { kind: "github", repo: "a/b/c", commit: SHA } }],
    ["a tag where a commit belongs", { source: { kind: "github", repo: REPO_NAME, commit: "v1.2.0" } }],
    ["a short sha", { source: { kind: "github", repo: REPO_NAME, commit: SHA.slice(0, 7) } }],
  ];
  const refusals: [number, string][] = [];
  for (const [, body] of shapes) {
    const said = await postSource(bad.app, body);
    refusals.push([said.status, errorOf(said.body).code]);
  }
  check(
    `every malformed source, refused before a socket is opened (${shapes.map(([label]) => label).join("; ")})`,
    refusals,
    shapes.map(() => [400, "plugin_source_invalid"]),
  );
  check("and none of them reached the far end", bad.urls, []);

  // Installing is machine:admin: a session:write grant may not put code on the machine.
  const asWriter = await postSource(
    bad.app,
    { source: { kind: "github", repo: REPO_NAME, commit: SHA } },
    ["session:read", "session:write"],
  );
  check(
    "a session:write grant may not install from a commit",
    [asWriter.status, errorOf(asWriter.body).code],
    [403, "insufficient_scope"],
  );
  check("and it reached the far end no more than the malformed ones did", bad.urls, []);
  await bad.close();
}

process.stdout.write("\nwhat a plugin's own refusal becomes over HTTP\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");

  const parsed = parseManifest(
    JSON.stringify({
      id: "p",
      name: "P",
      version: "1.0.0",
      api: 1,
      scopes: [],
      contributes: { screen: { title: "P" }, settings: true },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.message);

  /** A child scripted per bucket of pluginErrorStatus; clients read the code, never the status. */
  const childThat = (behaviour: "up" | "wontStart" | "silent" | "throws" | "asks" | "oversize" | "greedy"): PluginRuntime => ({
    launch(options) {
      /** Which invocation the `asks` child is still holding while it asks. */
      let holding = 0;
      /** The `greedy` child's tally: how many answers came back, and how many said no. */
      let answered = 0;
      let refused = 0;
      return Promise.resolve({
        send(message) {
          if (message.t === "init") {
            queueMicrotask(() =>
              options.onMessage(
                behaviour === "wontStart" ? { t: "fail", error: "this build will not run" } : { t: "ready" },
              ),
            );
            return true;
          }
          if (message.t === "answer") {
            if (behaviour === "greedy") {
              // Counted rather than reported one at a time: the question is how many the host carries at once.
              if (message.ok === false && String(message.error).includes("calls out")) refused += 1;
              answered += 1;
              if (answered === 24) {
                queueMicrotask(() =>
                  options.onMessage({ t: "done", id: holding, ok: true, value: { title: `refused ${refused}`, blocks: [] } }),
                );
              }
              return true;
            }
            // What the host said about the call, handed back as the plugin's own view: the only way to see it from outside.
            const said = message.ok ? "allowed" : message.error;
            queueMicrotask(() =>
              options.onMessage({ t: "done", id: holding, ok: true, value: { title: said, blocks: [] } }),
            );
            return true;
          }
          if (message.t === "invoke" && behaviour === "asks") {
            holding = message.id;
            queueMicrotask(() => options.onMessage({ t: "call", id: 1, method: "store.get", args: { key: "k" } }));
            return true;
          }
          // A channel that refuses the write is where plugin_request_too_large comes from, and it settles the invocation at once.
          if (message.t === "invoke" && behaviour === "oversize") return false;
          // All calls are emitted in one microtask, so every one counts before the first answer frees a slot.
          if (message.t === "invoke" && behaviour === "greedy") {
            holding = message.id;
            queueMicrotask(() => {
              for (let i = 1; i <= 24; i += 1) {
                options.onMessage({ t: "call", id: i, method: "store.get", args: { key: `k${i}` } });
              }
            });
            return true;
          }
          if (message.t === "invoke" && behaviour !== "silent") {
            queueMicrotask(() =>
              options.onMessage(
                behaviour === "throws"
                  ? { t: "done", id: message.id, ok: false, error: "the plugin threw" }
                  : { t: "done", id: message.id, ok: true, value: { title: "screen", blocks: [] } },
              ),
            );
          }
          return true;
        },
        stop: () => Promise.resolve(),
        recentLogs: () => [],
      });
    },
  });

  const rigFor = async (
    name: string,
    behaviour: "up" | "wontStart" | "silent" | "throws" | "asks" | "oversize" | "greedy",
  ): Promise<{ app: ReturnType<typeof createApp>["app"]; close: () => Promise<void> }> => {
    const stores = openStores({ path: join(tmp(`plugin-code-${name}-`), "d.db"), instanceId: `i_code_${name}` });
    stores.plugins.put({
      id: "p",
      version: "1.0.0",
      manifest: parsed.manifest,
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: null,
    });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const host = await PluginHost.open({
      root: join(tmp(`plugin-code-root-${name}-`), "plugins"),
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      runtime: childThat(behaviour),
      // Short, because two of these cases wait for a deadline to pass.
      timeouts: { start: 100, invoke: 100 },
    });
    const { app } = createApp({
      registry,
      verifier,
      instanceId: `i_code_${name}`,
      startedAt: Date.now(),
      plugins: host,
    });
    return {
      app,
      close: async () => {
        await host.shutdown();
        await registry.shutdown();
        stores.close();
      },
    };
  };

  const view = async (
    app: ReturnType<typeof createApp>["app"],
  ): Promise<{ status: number; code: string; title: string | null }> => {
    const response = await app.request("/plugins/p/views/screen", {
      headers: { authorization: `Bearer ${tokenFor("codes")}` },
    });
    const text = await response.text();
    const body = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    return {
      status: response.status,
      code: (body["error"] as { code?: string } | undefined)?.code ?? "none",
      title: (body["result"] as { view?: { title?: string | null } } | undefined)?.view?.title ?? null,
    };
  };

  const up = await rigFor("up", "up");
  check("a plugin that answers", await view(up.app), { status: 200, code: "none", title: "screen" });

  // The ninth concurrent invocation is refused rather than queued: the caller is an HTTP request somebody is waiting on.
  const flood = await Promise.all(Array.from({ length: 9 }, () => view(up.app)));
  report(
    "and nine at once, one of which is told the plugin is busy",
    flood.some((one) => one.status === 503 && one.code === "plugin_overloaded"),
    flood.map((one) => `${one.status} ${one.code}`).join(", "),
  );
  await up.close();

  const wontStart = await rigFor("wontStart", "wontStart");
  check("a plugin that will not start", await view(wontStart.app), {
    status: 503,
    code: "plugin_unavailable",
    title: null,
  });
  await wontStart.close();

  // A timeout has its own code and status because the remedy is to ask again.
  const silent = await rigFor("silent", "silent");
  check("a plugin that never answers", await view(silent.app), { status: 504, code: "plugin_timeout", title: null });
  await silent.close();

  const throws = await rigFor("throws", "throws");
  check("a plugin that answers with a failure", await view(throws.app), {
    status: 502,
    code: "plugin_failed",
    title: null,
  });
  await throws.close();

  // 413 points at the caller: the message never reached the child because it does not fit one IPC frame.
  const oversize = await rigFor("oversize", "oversize");
  check("a request too large for the channel", await view(oversize.app), {
    status: 413,
    code: "plugin_request_too_large",
    title: null,
  });
  await oversize.close();

  // Child-to-host calls are bounded too and refused past the bound rather than queued: sessions.changes and sessions.diff each fork git.
  const greedy = await rigFor("greedy", "greedy");
  check("a plugin that asks for everything at once is answered, and told no past the bound", await view(greedy.app), {
    status: 200,
    code: "none",
    title: "refused 8",
  });
  await greedy.close();

  // plugin_scope_denied crosses back to the plugin as an answer and never out of invoke, so the route still answers 200.
  const asks = await rigFor("asks", "asks");
  const asked = await view(asks.app);
  check("a plugin asking for something it did not declare is still a 200", [asked.status, asked.code], [200, "none"]);
  report(
    "and what it was told is the refusal, delivered to it rather than to the caller",
    asked.title?.startsWith("plugin_scope_denied: store.get needs") === true,
    asked.title ?? "nothing came back",
  );
  await asks.close();
}
