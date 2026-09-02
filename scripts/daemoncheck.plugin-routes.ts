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
                /*
                 * ⚠ **A `list` beside the text, and it is here to be *refused* on
                 * one of the two surfaces.** The clamp's own section drives
                 * `clampView` directly; this is the other half — that the surface
                 * actually reaches it from the route, which is a wiring question
                 * no pure-function assertion can answer. It was on the wire the
                 * whole time (`viewId` is the invoke's `name`) and neither side
                 * read it.
                 */
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

  /*
   * ⚠ **A second fixture that contributes neither surface, because the view route
   * reads the manifest now and every case here asked the other question.** `p`
   * above declares both, so "is this one of the two words this daemon knows" was
   * the whole of what `/views/:viewId` could be driven on, and whether *this
   * plugin* said it draws either was unreachable from this section. `contributes:
   * {}` is what `readContributions` turns into `{ screen: null, settings: false }`,
   * and it is a real plugin rather than a degenerate one: hooks and actions are
   * the other two things a plugin can be, and one that only listens draws nothing.
   */
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
  // Enabled, or the routes below would answer 503 for a reason that has nothing to
  // do with what it contributes — the same trap the read-only pair one screen down
  // states at length.
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

  /*
   * **A daemon built without a plugin host answers 503, never an empty list.**
   * "There are none" and "this daemon does not do that" are different answers, and
   * a client shown the first has no way to discover the second. Same shape
   * `credentials`, `logins` and `uploads` already use.
   */
  const off = await call(bareApp, "/plugins");
  check("a daemon with plugins switched off", [off.status, codeOf(off.body)], [503, "plugins_unavailable"]);
  /*
   * ⚠ **And the same answer from all six, not from the one route somebody
   * happened to drive.** That refusal is written once now — `withPlugins` wraps
   * every one of them — and it was written six times before, with the sentence
   * retyped at five of them and each free to drift into saying something slightly
   * different about the same state. The collapse does not make the sweep
   * unnecessary; the sweep is what keeps the collapse true, because a seventh
   * route written outside the wrapper answers 404 or 500 here rather than 503.
   *
   * `POST /plugins` is the one worth being deliberate about: it is a streaming
   * route, so this refusal is also a body nobody read being released, which is
   * what the exemption middleware's `finally` is for.
   */
  const sweep: [string, RequestInit][] = [
    ["/plugins", {}],
    ["/plugins", { method: "POST", body: "an archive nobody will look at" }],
    /*
     * ⚠ **The list is the assertion, which is why a seventh route has to be
     * added here by hand.** Every one of these goes through `withPlugins`, and a
     * route written outside it on a daemon with `REEMOAT_PLUGINS=0` would not
     * answer `503` — it would throw, or worse, act. `installFromSource` is the
     * one that would act: it opens a socket to GitHub.
     */
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
  /*
   * ⚠ **The surface reaches the clamp, over HTTP, on the route that knows it.**
   * Both answers are the same bytes from the same plugin; the only difference is
   * the last segment of the URL. A screen keeps the list, a settings pane drops it
   * and says so — and asserting the *pair* is what makes this a wiring check
   * rather than a second copy of the clamp's own assertions: either one alone
   * passes for a build that clamps both surfaces the same way.
   */
  check("a screen keeps a list", blocksOf(view.body), ["text", "list"]);
  check("and a settings pane drops it, with a line saying so", blocksOf(settings.body), ["text", "notice"]);

  const noView = await call(pluginApp, "/plugins/p/views/board");
  check("a view that is not one of the two", [noView.status, codeOf(noView.body)], [404, "view_not_found"]);
  const noPlugin = await call(pluginApp, "/plugins/nope/views/screen");
  check("a plugin that is not installed", [noPlugin.status, codeOf(noPlugin.body)], [404, "plugin_not_found"]);

  /*
   * ⚠ **The vocabulary and the manifest are two questions, and only the first was
   * ever asked.** `board` above is refused because no plugin draws a view by that
   * name; `screen` on a plugin contributing none is a view this daemon knows the
   * name of perfectly well and that *this* plugin never said it had. Both are 404
   * `view_not_found`, deliberately — the code is what a client branches on and
   * there is one state here, a view that is not there — so the two are told apart
   * by the sentence, which is why these read the message and the last line holds
   * the older refusal to its own.
   *
   * What the second one used to be is the reason it earns a case: the request
   * reached the child, `runner.ts` threw "this plugin exports no screen",
   * `PluginApiError` made that `plugin_failed`, and `pluginErrorStatus` had no arm
   * for it and defaulted to **502 — "something downstream of this daemon answered
   * badly"**. Nothing answered badly. A working plugin was reported broken for a
   * request its own manifest had already declined, and the traffic that gets here
   * is `pnpm client plugin view` or a hand-typed `/p/:machineId/:pluginId`, since
   * `screenPlugins` and `settingsBlockFor` narrow both surfaces in the browser.
   *
   * ⚠ **That 502 is not what this section sees with the gate taken out, and the
   * difference is the whole reason to assert here rather than to trust the read.**
   * The stub `PluginRuntime` above answers every `invoke` regardless of the
   * manifest — so without the gate these two are a cheerful `200` drawing a screen
   * the plugin does not have, which is a worse answer than the 502 and the one a
   * driver with no `fork` in it can actually produce.
   */
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
  /*
   * An action id reaching a plugin is a string somebody put in a URL. Checked here
   * rather than inside the plugin, because a plugin author writing a `switch` over
   * their own ids should not also have to defend against ones they never declared.
   */
  const undeclared = await call(pluginApp, "/plugins/p/actions/nope", { method: "POST", body: "{}" });
  check("one it does not", [undeclared.status, codeOf(undeclared.body)], [404, "action_not_found"]);

  const state = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: false }) });
  check("switching one off over HTTP", [state.status, ((state.body["plugin"] as { enabled?: boolean })?.enabled ?? null)], [200, false]);
  const badState = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: "no" }) });
  check("with something that is not a boolean", [badState.status, codeOf(badState.body)], [400, "bad_request"]);

  /* ---------------------------------------------------------------- *
   * The other axis.
   *
   * These scopes are the **caller's**, and they are not the plugin's. A read-only
   * grant may look at a plugin's screen and may press nothing on it; installing
   * needs `machine:admin`, which is the same scope removing a workspace needs and
   * the only other route that asks for it. Neither has anything to say about what
   * the plugin itself may reach, which is `manifest.scopes` and is checked
   * somewhere else entirely.
   * ---------------------------------------------------------------- */
  const readOnly = tokenWith("reader", ["session:read"]);
  const writer = tokenWith("writer", ["session:read", "session:write"]);
  const readList = await call(pluginApp, "/plugins", {}, readOnly);
  check("a read-only grant may list plugins", readList.status, 200);
  /*
   * ⚠ **The positive half, which is the half that was only ever asserted in
   * prose.** "May look at a plugin's screen and press nothing on it" is one
   * sentence and two claims, and a `read` that had drifted to `write` would break
   * the sheet for every read-only grant on the machine while every assertion here
   * went on passing — the negative half below cannot see it.
   *
   * Switched back on with an admin token first, because the pair is only a pair
   * while there is something to look at: a disabled plugin answers 503 for a
   * reason that has nothing to do with who is asking, and a 503 read as "allowed"
   * would make this assertion pass against a route nobody may reach.
   */
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

  /*
   * Only `GET`, `POST` and `DELETE`, which is what `CORS_ALLOW_METHODS` advertises
   * — the driver asserts that containment globally, and this is the note saying
   * these six routes were written inside it deliberately.
   */
  const removed = await call(pluginApp, "/plugins/p", { method: "DELETE" });
  check("removing one", [removed.status, removed.body["removed"]], [200, true]);
  /*
   * ⚠ **The same answer twice — and this pair wanted a 404 for the second send
   * until the route was the only 404 left on a replayable verb.** `isReplayable`
   * in `packages/web/src/machine.ts` whitelists `GET` and `DELETE` on a stated
   * property that this route sat inside while contradicting: "the daemon's are
   * idempotent — stopping an already-stopped session or removing an
   * already-removed workspace answers the same way twice".
   *
   * The failure is not the mistyped id anybody thinks of first. It is a removal
   * that **worked** and whose answer was lost on the wire: the replay lands after
   * the row, the data and the tree are already gone, the daemon says
   * `plugin_not_found`, and `pluginFailure` draws that as "That plugin is not
   * installed on this machine any more." — true, exactly what the caller asked
   * for, and read by a person as the act having failed. Across a fleet that is one
   * red row per dropped packet, on machines where nothing went wrong.
   *
   * So the two sends are asserted as a *pair* rather than one at a time: what a
   * replay must not be able to see is any difference at all between them, and the
   * pair is the only shape that says so — either line alone passes for a build
   * that answers 200 to the first and something else to the second. `removed` is
   * the one field that legitimately tells them apart, which is the next line and
   * is what keeps this from being green against a route that answered `{}` twice.
   *
   * `409 plugin_busy` is untouched and is now the only refusal on the route: there
   * nothing was removed *and* the answer would be different a moment later, which
   * is not what `removed: false` says. The cost is stated where the route states
   * it — a mistyped id is no longer refused, and `pnpm client plugin remove`
   * prints "removed" over one.
   */
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

  /*
   * ⚠ **`shutting_down` is the first thing the install handler tests**, before
   * the name, before the declared length and before a byte of the body is read.
   * A daemon on its way out has 20 seconds of shutdown budget and a hard exit
   * behind it, so unpacking an archive it will never finish starting is work that
   * ends as a half-published tree with no process to prove it. Driven last here
   * because it is a one-way flag on the registry, and the routes above need one
   * that is still serving.
   */
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

  /**
   * A child that comes straight up, or one whose build will not run.
   *
   * `fail` rather than silence for the second, because what is being driven here
   * is `pluginInstallStatus` and not the start deadline: a start that times out
   * takes the whole `timeouts.start` window to reach the same code, and the code
   * is the subject.
   */
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

  /**
   * A daemon whose plugin host is scripted, and the HTTP surface in front of it.
   *
   * `refusesToWrite` swaps the record store for one whose `put` throws, which is
   * the only honest way to reach `plugin_write_failed` — the alternative is a
   * filesystem that has actually failed, and `PluginRecordStore` is an interface
   * precisely so that a driver does not need one. It also drives the half of
   * `install`'s catch nothing else reaches: a throw **after** the tree has been
   * published used to leave the new `LivePlugin` running out of a directory the
   * catch had just deleted.
   */
  const rigFor = async (
    name: string,
    options: {
      starts: boolean;
      refusesToWrite?: boolean;
      /**
       * What `POST /plugins/source` gets back instead of reaching GitHub.
       *
       * The seam exists so this driver can hold every refusal on that path — a
       * 404, a redirect, a body over the bound — with no network. See
       * `PluginHostOptions.fetchArchive`.
       */
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
    // Assigned rather than passed as `null`, because a `body: null` and no body at
    // all are the same Request and the route's own `body === null` arm needs the
    // second one.
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

  /*
   * ⚠ **201 and 200 are the answer to "which of the two happened".** Install and
   * update are one verb because the manifest is what says which — a separate
   * `PUT` would need the caller to know whether the plugin is already there,
   * which is a question the archive answers on arrival. `replaced` carries the
   * version that went, and the status carries the same fact for anything reading
   * only that.
   */
  const created = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check("a plugin arrives over HTTP", [created.status, created.body["replaced"]], [201, null]);
  const updated = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf({ version: "1.1.0" })));
  check(
    "and the same id again is an update rather than a second plugin",
    [updated.status, updated.body["replaced"], (updated.body["plugin"] as { version?: string } | undefined)?.version],
    [200, "1.0.0", "1.1.0"],
  );

  /*
   * The name is a **label** — recorded beside the row, never turned into a path —
   * and it is sanitized anyway, because it is echoed back and a control character
   * in an echoed string is the response-splitting `sanitizeUploadName` exists to
   * refuse. The same function the upload and import routes use, so all three
   * agree about what a filename may be.
   *
   * The empty case is not a corner: the route reads `?name=` with `?? ""`, so a
   * client that forgets the query is refused rather than storing `null`.
   */
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

  /*
   * ⚠ **A `content-length` is honoured to refuse and never to accept.** Refusing
   * on one this daemon believes costs nothing; *trusting* one would let a body
   * that lies walk past `unpackArchive`'s counter, which is the thing actually
   * enforcing the bound. Both halves are here: a header claiming more than a
   * plugin may be is refused with nothing read, and a body that really is larger
   * is refused by the counter with the same code.
   */
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

  /*
   * The rest of `pluginInstallStatus`, one case per arm. **The split is by whose
   * problem it is**: `413` for the bounds so a client can tell "too big" from
   * "wrong", `409` for a plugin that will not start — the tree is unchanged and
   * the old version is still running, which is a conflict rather than a failure —
   * and `400` for everything about the archive or the manifest, all of which are
   * things the person who built it can fix.
   */
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

  // A `POST` with no body at all, which is what a client that built its request
  // wrong sends. Refused before the host is reached, so there is nothing to undo.
  const bodyless = await post(good.app, "?name=board.tar.gz", null);
  check("a request with no body", [bodyless.status, errorOf(bodyless.body).code], [400, "bad_request"]);

  /*
   * One install at a time, for the whole daemon, and this is the half that is
   * actually reachable from outside: the relay allows 256 concurrent streams, so
   * "a person installs a plugin about as often as they install anything" is a
   * statement about people rather than about what can arrive.
   */
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

  /*
   * ⚠ **`409` rather than `400` for a build that will not run, and the reason is
   * what the machine looks like afterwards.** The tree is unchanged, the row is
   * untouched and the version that was there is running again — that is a
   * conflict with the state of the machine, not a malformed request, and a `400`
   * would tell somebody to go and fix an archive that is fine.
   */
  const broken = await rigFor("broken", { starts: false });
  const refused = await post(broken.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check(
    "a plugin whose build will not start",
    [refused.status, errorOf(refused.body).code],
    [409, "plugin_start_failed"],
  );
  check("and nothing was installed", broken.host.list(), []);
  await broken.close();

  /*
   * `503`, because the remedy is on this machine and the request itself was fine
   * — which is what that status says and what a `400` would deny. The row is
   * where the throw happens, so everything the try moved has to move back: the
   * published tree is discarded and the plugin is not left running out of a
   * directory that is no longer there.
   */
  const unwritable = await rigFor("unwritable", { starts: true, refusesToWrite: true });
  const notWritten = await post(unwritable.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check(
    "a row the database would not take",
    [notWritten.status, errorOf(notWritten.body).code],
    [503, "plugin_write_failed"],
  );
  check("and no row was written", unwritable.rows.has("board"), false);
  check("and the tree it had published is gone", existsSync(join(unwritable.host.pluginRoot, "board", "1.0.0")), false);
  /*
   * ⚠ **The half that used to be missing, and it was the worse half.**
   * `install`'s catch restored `existing` and had no arm for the case where there
   * was none — while the `plugin_start_failed` path a few lines above it did, and
   * the catch's own docblock claimed it made "the same restore" and named
   * `records.put` on a busy database as its case. So a *first* install that threw
   * after the tree was published answered `503` and left a `LivePlugin` in `live`
   * with a child running, no row behind it and no directory under it: `list()`
   * reported `running` at the version that had just been refused, and went on
   * doing so until the daemon was restarted, at which point the plugin silently
   * disappeared. `<root>/board` was left behind as well, which
   * `PluginHost.installed` reads as something installed — so `remove` of an id
   * nobody ever installed answered `true`.
   *
   * All four are asserted rather than the two that happened to hold, because the
   * two that held are exactly what made the other two easy to miss.
   */
  check("and the listing does not report a plugin that is not installed", unwritable.host.list(), []);
  check("nor is one left running out of a tree that is gone", await unwritable.host.remove("board"), false);
  check(
    "and the directory made to hold it went with it",
    existsSync(join(unwritable.host.pluginRoot, "board")),
    false,
  );
  await unwritable.close();

  /* ── installing from a commit, rather than from a file ─────────────────── */

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

  /*
   * ⚠ **The address is built by the daemon and asserted here, because that is the
   * whole of the fence.** Nothing on the wire names a host: a caller who could
   * would have a daemon that fetches arbitrary addresses as its owner. `codeload`
   * directly rather than `github.com/<repo>/archive/<sha>.tar.gz`, which answers
   * `302` — and this path refuses redirects, so building the redirecting spelling
   * would make every install fail.
   */
  const fromSource = await sourceRig("source", () => tarball());
  const arrived = await postSource(fromSource.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("a plugin arrives from a commit", [arrived.status, arrived.body["replaced"]], [201, null]);
  check("and the daemon built the address itself", fromSource.urls, [
    `https://codeload.github.com/${REPO_NAME}/tar.gz/${SHA}`,
  ]);
  /*
   * The row records where it came from, and on this path that is the pin rather
   * than a filename somebody's browser happened to choose. Written and never read
   * for a decision — the same standing this column already had.
   */
  check("and the row records the commit it came from", fromSource.rows.get("board")?.source, `github:${REPO_NAME}@${SHA}`);

  const again = await postSource(fromSource.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("and the same id again is an update, exactly as an upload would be", [again.status, again.body["replaced"]], [200, "1.0.0"]);
  await fromSource.close();

  /*
   * ⚠ **The normalisation case, and it is the one worth a named test.**
   * `parseManifest` synthesises an absent `contributes` into
   * `{screen: null, settings: false, actions: [], hooks: []}` and turns an absent
   * `description` into `null`. A consent check comparing the manifest field for
   * field would therefore fire on a plugin that simply did not write a
   * `contributes` block — which is most of them — and an alarm that cries wolf is
   * an alarm people learn to click through. `consentGap` compares three fields
   * that survive normalisation as plain string arrays, and this asserts that the
   * plainest possible manifest installs without one.
   */
  const plainest = await sourceRig("plain", () => tarball({ contributes: undefined, description: undefined }));
  const plain = await postSource(plainest.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("a manifest that writes no contributes at all is not a consent breach", plain.status, 201);
  await plainest.close();

  /*
   * ⚠ **Refused, and refused *before the plugin ran*.** On the upload path the
   * browser opened the archive itself and `consentBroken` reports afterwards —
   * tolerable, because the reader there read the very bytes that were sent. Here
   * nothing local ever opened the archive, so this one has to be a refusal rather
   * than a notification, and it has to land before `ensureStarted`. The second
   * assertion is the half that matters: not merely a 409, but nothing installed.
   */
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

  /*
   * A caller that sends no consent at all is not a client bug: `pnpm client` has
   * no screen to have shown anybody, and `install` skips the check for it. What
   * that costs is stated rather than hidden — the archive is still validated, and
   * the scopes still land on the row where somebody can read them.
   */
  const unasked = await postSource(sneaky.app, { source: { kind: "github", repo: REPO_NAME, commit: SHA } });
  check("a caller that consented to nothing at all is not held to nothing", unasked.status, 201);
  await sneaky.close();

  /*
   * ⚠ **The fourth compared field, and it is what makes a browser *older than
   * this daemon* safe.** Such a client draws no row for a contributed harness —
   * `catalogue.ts`'s tolerance of unknown fields guarantees it goes on working and
   * therefore guarantees it under-discloses — and there is no fix on that side.
   * What it sends is a consent with no `adds`, so a commit that adds a harness is
   * refused here with a sentence instead of installing a command line nobody was
   * shown.
   *
   * ⚠ **And the refusal is `plugin_consent_broken` rather than a new code**, which
   * is not laziness: the whole point is that the *old* client renders it, and
   * `pluginFailure` already has a sentence for that one.
   */
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
  /*
   * ⚠ **The *argv* is in the sentence, because the argv is what was agreed to.**
   * A person who sees "it adds gemini" and gets a plugin that runs something else
   * under that name has been told nothing useful, so the compared string carries
   * the command line and the refusal repeats it.
   */
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

  /*
   * ⚠ **The bound holds with no `content-length`, which is the only way it is
   * ever exercised in the fleet.** Measured: codeload sends none — the tarball is
   * generated as it is sent. So a guard reading that header would bound precisely
   * nothing on the one URL this path fetches, and the real bound is
   * `unpackArchive` charging each chunk against `PLUGIN_LIMITS.maxBytes` as it
   * reads. This drives exactly that shape: a streamed body, no header, over the
   * ceiling.
   */
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

  /*
   * What the far end said, as codes a person can act on. `404` keeps its own,
   * because "that commit is not there, or the repository is private" is the one
   * refusal here somebody can do something about; everything else is `502`,
   * because nothing was wrong with the request and this daemon is not the thing
   * that is unwell.
   */
  const farEnd: [string, () => Response | Promise<Response>, number, string][] = [
    ["a commit that is not there", () => new Response("no", { status: 404 }), 502, "plugin_source_not_found"],
    ["a forge having a bad day", () => new Response("no", { status: 500 }), 502, "plugin_source_unavailable"],
    [
      // What `redirect: "error"` produces, which is a throw rather than a status.
      // The `github.com/<repo>/archive` spelling is the one that redirects, and it
      // is built nowhere — this is the guard that says so.
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

  /*
   * ⚠ **A tag and a short sha are refused, and that is a security decision.** A
   * tag moves under `git tag -f`, so a plugin pinned "at v1.2.0" is a plugin whose
   * code can change under an identifier that did not — and what is being pinned is
   * code that runs as this machine's owner with no sandbox. Both are well-formed
   * enough to look like an oversight when refused, which is why the message names
   * them.
   */
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

  /*
   * ⚠ **Both axes, on the newest route.** A route's scope is the caller's;
   * `manifest.scopes` is the plugin's, and neither implies the other. Installing
   * is `machine:admin` — a grant that can drive sessions all day may not put code
   * on the machine — and this is the route where getting that wrong would let a
   * `session:write` grant fetch and run somebody else's code as the owner.
   */
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

  /**
   * A child scripted per bucket of `pluginErrorStatus`.
   *
   * ⚠ **Read the code, never the status.** That function exists so the statuses
   * are at least not misleading, not so anybody branches on them, and the split is
   * by *whose problem it is*: a plugin that is off or broken is on this machine
   * and the request was fine (`503`), a plugin that did not answer in time is
   * worth asking again (`504`), and everything else is something downstream of
   * this daemon answering badly (`502`).
   */
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
              // Counted rather than reported one at a time: the question is how
              // many of the twenty-four the host would carry at once.
              if (message.ok === false && String(message.error).includes("calls out")) refused += 1;
              answered += 1;
              if (answered === 24) {
                queueMicrotask(() =>
                  options.onMessage({ t: "done", id: holding, ok: true, value: { title: `refused ${refused}`, blocks: [] } }),
                );
              }
              return true;
            }
            // Whatever the host said about the call below, handed back as this
            // plugin's own view — which is the only way it is visible from
            // outside the child at all.
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
          /*
           * ⚠ **A channel that refuses the write, which every fake here reported
           * as succeeding.** `plugin_request_too_large` is raised where
           * `child.send` answers `false`, so with five runtimes all returning
           * `true` the arm — and the status it maps to — was unreachable from
           * this driver. It settles the invocation immediately on purpose: the
           * measured defect it replaced was three oversized forms spending the
           * whole invoke deadline each and exhausting the timeout budget.
           */
          if (message.t === "invoke" && behaviour === "oversize") return false;
          /*
           * A plugin doing the obvious thing an author of a task board does:
           * asking about every session at once. All of them are emitted inside a
           * single microtask, so every one is counted before the first answer
           * releases its slot — which is exactly the fan-out
           * `MAX_INFLIGHT_HOST_CALLS` exists to bound, and which nothing bounded
           * before. What the child hands back is how many it was refused.
           */
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
      // Short, because two of these cases are a deadline being reached and the
      // production ten seconds each would put most of a minute into `pnpm check`.
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
      // Carried out of the view, because the last case below is a plugin
      // reporting what the daemon told *it* and the route's status says nothing
      // about that.
      title: (body["result"] as { view?: { title?: string | null } } | undefined)?.view?.title ?? null,
    };
  };

  const up = await rigFor("up", "up");
  check("a plugin that answers", await view(up.app), { status: 200, code: "none", title: "screen" });

  /*
   * Eight at once is the bound and the ninth is **refused rather than queued**:
   * the caller is an HTTP request somebody is waiting on, and holding it behind
   * seven others only moves the timeout. `503` and not `502` for the same reason
   * a 429 is not a 400 — the remedy is to ask again.
   */
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

  /*
   * A timeout is its own code and its own status, because the remedy differs:
   * `plugin_failed` is the plugin author's problem and `plugin_timeout` is "ask
   * again, or look at whether this machine is busy".
   */
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

  /*
   * ⚠ **`413`, and it used to be `502` by falling off the end.**
   * `pluginErrorStatus` had no arm for `plugin_request_too_large`, so it took the
   * default — whose stated reason is "something downstream of this daemon
   * answered badly", when nothing downstream answered at all: the message never
   * reached the child because it does not fit one IPC frame. `docs/API.md` said
   * `503`, a third answer agreeing with neither. `413` is what this daemon already
   * says for `payload_too_large` and both import ceilings, and it is the one that
   * points at the caller, where the remedy is.
   */
  const oversize = await rigFor("oversize", "oversize");
  check("a request too large for the channel", await view(oversize.app), {
    status: 413,
    code: "plugin_request_too_large",
    title: null,
  });
  await oversize.close();

  /*
   * ⚠ **The other direction, which had no ceiling at all.**
   * `MAX_INFLIGHT_INVOCATIONS` bounds host → child and was published in both
   * bounds tables; nothing bounded child → host, and the two are not symmetric in
   * cost — `sessions.changes` and `sessions.diff` each fork git. Twenty-four at
   * once is one line an author of a task board writes without thinking about it,
   * and the answer is a refusal per excess call rather than a queue: the child
   * asked for them now, and holding them only moves the deadline it is already
   * waiting on.
   */
  const greedy = await rigFor("greedy", "greedy");
  check("a plugin that asks for everything at once is answered, and told no past the bound", await view(greedy.app), {
    status: 200,
    code: "none",
    title: "refused 8",
  });
  await greedy.close();

  /*
   * ⚠ **`plugin_scope_denied → 403` is the one arm of `pluginErrorStatus` that
   * nothing can reach, and it is unreachable rather than undriven.** A scope
   * refusal is raised inside `PluginApi.call`, which is only ever entered from the
   * child's own `call` message — `LivePlugin.onMessage` catches it and sends the
   * plugin an `answer` carrying that code, so it crosses back to the **plugin**
   * and never out of `invoke`. The two axes really are two: the caller's scope
   * decided this request at the route, and the plugin's decided this call inside
   * the child, and the second one has no way to become the first one's status.
   *
   * Driven from the only side it is visible from rather than written down as a
   * note: a child that asks for a method its manifest does not declare, and hands
   * back whatever it was told as its own view. What the route answers is `200`,
   * because from where it is standing the plugin did its job.
   */
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
