import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import type { PluginManifest } from "../src/plugins/protocol.js";
import type { PluginRuntime } from "../src/plugins/runtime.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability } from "../src/runtime/types.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { memoryPluginData, storeOf, rowFor, stubAgentConfig } from "./daemoncheck.fixtures.js";
import { tarOf, bodyOf } from "./daemoncheck.bodies.js";

process.stdout.write("\nwhat a plugin is allowed to ask the daemon for\n");
{
  const { MAX_PLUGIN_FETCH_BYTES, PluginApi, PluginApiError } = await import("../src/plugins/api.js");
  const { MAX_PLUGIN_MESSAGE_BYTES } = await import("../src/plugins/runtime.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { PLUGIN_SCOPES } = await import("../src/plugins/protocol.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");

  /*
   * `id` is a parameter because `PluginApi` keys its fetch window on it and
   * nothing gives the window back: the 40-request spray below spends `p`'s budget
   * for the rest of the process, so a later section wanting a real `net.fetch`
   * answer has to ask under a different name. (That the window outlives the
   * plugin is its own finding — a plugin uninstalled and reinstalled under one id
   * inherits the previous one's spent budget.)
   */
  const manifestWith = (scopes: string[], net: string[] = [], id = "p"): PluginManifest => {
    /*
     * ⚠ **The contribution blocks ride their scopes, exactly as `net`'s host list
     * rides `net`.** `harness` and `system` are biconditional with the blocks they
     * disclose — a scope with an empty block reads, to whoever is approving an
     * install, as a plugin that adds nothing — so a helper that declared the scope
     * and nothing else would refuse before it reached the thing under test. And the
     * `api` follows: a contribution below rung 5 is refused rather than silently
     * dropped, so this helper cannot pin `1` once it declares one.
     */
    const contributes: Record<string, unknown> = {};
    if (scopes.includes("harness")) {
      contributes["harnesses"] = [{ id: "h", name: "H", command: "hcli", args: ["acp"] }];
    }
    if (scopes.includes("system")) {
      contributes["systems"] = [
        {
          id: "s",
          name: "S",
          apiType: "anthropic",
          baseUrl: "https://api.example.com/anthropic",
          authHeader: { name: "authorization", prefix: "Bearer " },
          models: [{ id: "m", name: "M" }],
        },
      ];
    }
    const api = Object.keys(contributes).length > 0 ? 5 : 1;
    const parsed = parseManifest(
      JSON.stringify({ id, name: "P", version: "1.0.0", api, scopes, net, contributes }),
    );
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.manifest;
  };

  const reached: string[] = [];
  const warned: string[] = [];
  /*
   * What the far end says, swappable — because the *response* half of `net.fetch`
   * was driven by nothing at all. This answered `"hi"` and only ever `"hi"`, so
   * neither the `content-length` refusal nor `readBounded` — a function whose
   * whole reason for existing is that `response.text()` arrived too late to be a
   * measurement — was ever reached.
   */
  let answers: () => Response = () => new Response("hi", { status: 200 });

  const api = new PluginApi({
    registry: new SessionRegistry(),
    /*
     * Written out here once, and hoisted to {@link memoryPluginData} the moment
     * `SqlitePluginDataStore` had to be driven against the same object: the two
     * implementations refuse and page identically or `checkPluginWrite` is shared
     * for nothing, and a second copy of the fake is exactly how that stops being
     * true. Its docblock keeps the argument for why it is keyed on the *pair*.
     */
    data: memoryPluginData(),
    git: hostGit,
    onWarning: (detail) => warned.push(detail),
    fetchImpl: ((url: URL) => {
      reached.push(String(url));
      return Promise.resolve(answers());
    }) as unknown as typeof fetch,
  });

  const codeOf = async (manifest: PluginManifest, method: string, args: unknown = {}): Promise<string> => {
    try {
      await api.call(manifest, method, args);
      return "ok";
    } catch (error) {
      return error instanceof PluginApiError ? error.code : "threw";
    }
  };

  /*
   * **Every method, refused for a plugin that declared nothing.** Written as a
   * sweep over one manifest rather than as a case per method, so a method added
   * without a `SCOPE_OF` entry is caught here rather than being reachable by
   * everybody — which is the failure mode that gate has.
   */
  const nothing = manifestWith([]);
  const METHODS: [string, unknown][] = [
    ["sessions.list", {}],
    ["sessions.get", { id: "s" }],
    ["sessions.events", { id: "s" }],
    ["sessions.changes", { id: "s" }],
    ["sessions.diff", { id: "s", path: "a" }],
    ["sessions.workspace", { id: "s" }],
    ["sessions.create", { agent: "claude", cwd: "/tmp" }],
    ["sessions.prompt", { id: "s", text: "hi" }],
    ["sessions.cancel", { id: "s" }],
    ["sessions.stop", { id: "s" }],
    ["sessions.setMeta", { id: "s" }],
    ["sessions.answerPermission", { id: "s", permissionId: "p", optionId: "o" }],
    ["sessions.answerElicitation", { id: "s", elicitationId: "e" }],
    ["agents.list", {}],
    ["files.read", { sessionId: "s", path: "a" }],
    ["store.get", { key: "k" }],
    ["store.set", { key: "k", value: 1 }],
    ["store.delete", { key: "k" }],
    ["store.keys", {}],
    ["store.entries", {}],
    ["net.fetch", { url: "https://api.example.com/" }],
    /*
     * The one method that spends the operator's quota rather than the machine's
     * access. In this sweep for the same reason as every other: the plugin
     * declaring nothing must be refused *before* anything is asked of an agent —
     * the scope gate runs ahead of the availability check, so this is refused on
     * a daemon that has no asker wired at all.
     */
    ["model.complete", { agent: "claude", prompt: "hi" }],
    /*
     * And its sibling, which spends no quota and still spawns an agent — so it
     * sits behind the same scope and is refused on the same terms. In this sweep
     * for the same reason as every other: the gate runs ahead of the availability
     * check, so a plugin declaring nothing is refused on a daemon with no asker
     * wired at all.
     */
    ["model.list", { agent: "claude" }],
  ];
  const denied: string[] = [];
  for (const [method, args] of METHODS) {
    if ((await codeOf(nothing, method, args)) !== "plugin_scope_denied") denied.push(method);
  }
  check("every method needs a scope, and a plugin with none reaches nothing", denied, []);
  /*
   * ⚠ **This said "every scope is the gate for at least one method", and that
   * stopped being the property rather than stopping being true.** Six of the eight
   * gate a `SCOPE_OF` entry; `harness` and `system` gate nothing at call time and
   * were never going to — a contributed harness is a *declaration*, validated once
   * at install and then read by this daemon rather than called by the plugin. They
   * are scopes because the scope list is the sentence somebody reads before
   * agreeing, and these are the two largest things in it to agree to.
   *
   * So the property is restated rather than weakened: **no scope is inert.** Each
   * one either gates a method or is refused when its own contribution block is
   * missing, and the second half is driven here rather than asserted as a number —
   * a count would go on passing if somebody added a scope that did neither.
   */
  const inert: string[] = [];
  for (const scope of PLUGIN_SCOPES) {
    // Does holding *only* this one open any method? Derived by asking rather than
    // by reading a table — `SCOPE_OF` is module-private on purpose.
    const only = manifestWith([scope], scope === "net" ? ["api.example.com"] : []);
    let gatesCall = false;
    for (const [method, args] of METHODS) {
      /*
       * ⚠ **`net.fetch` is probed at a host the manifest does not list**, and that
       * is not a weaker probe: this sweep asks one thing — did the *scope gate*
       * fire — and the allowlist is checked after the gate and before anything
       * leaves. Probed at the listed host it would perform a real request, which
       * lands in the recorded list two sections down and makes an assertion about
       * *what was requested* fail for a reason that has nothing to do with it.
       */
      const probe = method === "net.fetch" ? { url: "https://nowhere.invalid/" } : args;
      if ((await codeOf(only, method, probe)) !== "plugin_scope_denied") {
        gatesCall = true;
        break;
      }
    }
    // Or is it refused outright when the block it discloses is missing? That is
    // the `net` biconditional, and the two contribution scopes have it too.
    const alone = parseManifest(
      JSON.stringify({ id: "q", name: "Q", version: "1.0.0", api: 5, scopes: [scope], contributes: {} }),
    );
    if (!gatesCall && alone.ok) inert.push(scope);
  }
  check("and no scope in the union is inert", inert, []);
  report(
    "which is six that gate a call and two that disclose a contribution",
    PLUGIN_SCOPES.length === 8,
    `${METHODS.length} methods behind ${PLUGIN_SCOPES.length} scopes`,
  );
  /*
   * ⚠ **The number is written here and has to be moved by hand, which is the
   * whole of what this line is worth.** `SCOPE_OF` holds twenty-three entries —
   * twenty-two scoped methods plus `log`, which needs none and is driven on its
   * own below — and the table above is a hand-written mirror of it. The sweep
   * claims "every method", and that claim is only as good as somebody having
   * added a row here; nothing on this side can derive the list, because `SCOPE_OF`
   * is module-private and exporting it so a driver could read it would make the
   * gate importable by anything else that wanted to reason about it. **Measured
   * while writing this**: `store.entries` had been added to `SCOPE_OF` and never
   * here, so the assertion above was true of twenty of the twenty-one and said
   * "every method" about a table missing one. A further scoped method needs
   * a row and this count moved in the same edit — which `model.complete` duly
   * did, failing all three of these lines until it was written down here — and
   * `model.list` after it.
   */
  check("and the sweep is the whole of that table", METHODS.length, 23);

  /*
   * ⚠ **Every method a plugin may call is one it can *reach*, and this assertion
   * exists because one was not.**
   *
   * `model.complete` had an entry in `SCOPE_OF`, an arm in the dispatcher, a row
   * in the table above, a sentence on the consent screen and a version bump — and
   * no line in the object the child process is handed. `ctx.model` was
   * `undefined`, so a plugin calling it got a `TypeError` before a byte crossed
   * the IPC channel. Eight drivers were green: every one of them tested the host's
   * half, and the two halves meet at `api.ts` and part at `context.ts`.
   *
   * That is the sixth bug of the same shape in one day — *the only check of a
   * place contained the same misunderstanding as the code* — and the first in this
   * direction. The table above says what a plugin is *allowed* to call; this says
   * what a plugin can *say*, and the gap between the two was invisible.
   *
   * Two properties, and the second is the one a smoke test would miss: the
   * function is there, **and** it asks for the method it is named for. A branch
   * calling the wrong string is reachable, well-typed, and answers
   * `unknown_method` at runtime.
   */
  {
    const { pluginContext } = await import("../src/plugins/context.js");
    const asked: string[] = [];
    const ctx = pluginContext(
      (method) => {
        asked.push(method);
        return Promise.resolve(null);
      },
      { id: "p", version: "1.0.0" },
    ) as Record<string, unknown>;

    const unreachable: string[] = [];
    const misnamed: string[] = [];
    for (const [method] of METHODS) {
      const [group, name] = method.split(".");
      const holder = group === undefined ? undefined : ctx[group];
      const fn = holder !== null && typeof holder === "object" ? (holder as Record<string, unknown>)[name ?? ""] : undefined;
      if (typeof fn !== "function") {
        unreachable.push(method);
        continue;
      }
      const before = asked.length;
      // Three empty objects: every builder either ignores its arguments or spreads
      // them, so this reaches the `call` without depending on any one signature.
      void (fn as (...args: unknown[]) => unknown)({}, {}, {});
      if (asked[before] !== method) misnamed.push(`${method} asked for ${asked[before] ?? "nothing"}`);
    }
    check("every method a plugin may call is one it can reach", unreachable, []);
    check("and each one asks the host for the method it is named for", misnamed, []);
    /*
     * `log` is not in the table above because it needs no scope — and it is the
     * one method whose absence would leave a plugin unable to say anything about
     * itself, so it is asserted separately rather than left out with its scope.
     */
    check("and logging is reachable too, though it is behind no scope", typeof ctx["log"], "function");
    check("nothing was asked for that the table does not hold", asked.length, METHODS.length);
  }

  check("a method that does not exist", await codeOf(manifestWith(["store"]), "sessions.destroy"), "unknown_method");
  // The one method with no scope at all, because it is how a plugin says anything
  // about itself and refusing it would make a plugin that declared nothing silent.
  check("logging needs nothing", await codeOf(nothing, "log", { message: "hello" }), "ok");
  report("and it reaches the warning sink", warned.some((one) => one.includes("hello")), `${warned.length} warnings`);

  /*
   * A scope is refused **and reported**. A plugin exceeding what it told somebody
   * it needed is exactly the thing an operator would want to know about, and it is
   * invisible from the plugin's own screens.
   */
  const before = warned.length;
  await codeOf(nothing, "store.get", { key: "k" });
  report("a refused scope is reported as well as refused", warned.length > before, warned[warned.length - 1] ?? "");

  const stored = manifestWith(["store"]);
  check("with the scope it works", await codeOf(stored, "store.set", { key: "k", value: { a: 1 } }), "ok");
  check("and reads back parsed rather than as text", await api.call(stored, "store.get", { key: "k" }), { a: 1 });
  check("a key that was never written", await api.call(stored, "store.get", { key: "nope" }), null);
  check("and a prefix listing is a prefix listing", await api.call(stored, "store.keys", { prefix: "k" }), ["k"]);

  /* ---------------------------------------------------------------- *
   * The one outbound door.
   * ---------------------------------------------------------------- */
  const netted = manifestWith(["net"], ["api.example.com"]);
  check("a host the manifest lists", await codeOf(netted, "net.fetch", { url: "https://api.example.com/x" }), "ok");
  check("and it really went there", reached, ["https://api.example.com/x"]);
  check("a host it does not list", await codeOf(netted, "net.fetch", { url: "https://elsewhere.example/" }), "host_not_allowed");
  check("http rather than https", await codeOf(netted, "net.fetch", { url: "http://api.example.com/" }), "insecure_url");
  check("something that is not a URL", await codeOf(netted, "net.fetch", { url: "api.example.com" }), "invalid_url");
  // A refusal on the *host* must not have gone out first.
  check("and nothing refused was ever requested", reached, ["https://api.example.com/x"]);

  const spray: string[] = [];
  for (let i = 0; i < 40; i += 1) spray.push(await codeOf(netted, "net.fetch", { url: "https://api.example.com/" }));
  report(
    "a plugin cannot poll a host as fast as it likes",
    spray.includes("fetch_rate_limited"),
    `${spray.filter((one) => one === "ok").length} of ${spray.length} allowed`,
  );

  /* ---------------------------------------------------------------- *
   * `files.read`, which had no behavioural assertion at all.
   *
   * ⚠ **The one host method that hands a plugin the contents of a file, and it
   * appeared in this section exactly twice — both times as a row in the scope
   * table.** So what was proven is that it needs the `files.read` scope, and
   * nothing whatever about what it does once it has it. Its five refusals include
   * the pair `files-paths-git.md` calls load-bearing: `safeRelPath` refuses a
   * `.git` segment somebody *typed*, and the resolved re-test through
   * `probeRequestable` is what refuses the same directory reached through a
   * symlink. `server.ts` has a second caller of that pair and drives it; this one
   * did not, and it is the caller that answers a plugin rather than a person.
   *
   * A stub registry rather than the section's real one: this method reads exactly
   * `managed.workspace.root`, and standing up a real session to hand it one path
   * would be a fixture about `SessionRegistry` rather than about this arm.
   * ---------------------------------------------------------------- */
  {
    const tree = join(homedir(), ".reemoat-check-files");
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(join(tree, "sub"), { recursive: true });
    mkdirSync(join(tree, ".git"), { recursive: true });
    writeFileSync(join(tree, "notes.txt"), "hello\n");
    writeFileSync(join(tree, ".git", "config"), "[core]\n");
    writeFileSync(join(tree, "fat.bin"), "z".repeat(64 * 1024 + 1));
    // The link is the whole reason the resolved re-test exists.
    symlinkSync(join(tree, ".git"), join(tree, "g"));

    const filed = new PluginApi({
      registry: {
        get: (id: string) => (id === "s" ? { workspace: { root: tree } } : undefined),
      } as unknown as SessionRegistry,
      data: memoryPluginData(),
      git: hostGit,
      onWarning: () => {},
    });
    const reads = async (path: string): Promise<string> => {
      try {
        return String(await filed.call(manifestWith(["files.read"], [], "files"), "files.read", { sessionId: "s", path }));
      } catch (error) {
        return error instanceof PluginApiError ? error.code : String(error);
      }
    };

    check("a file inside the tree reads", await reads("notes.txt"), "hello\n");
    check("one above it does not", await reads("../secret"), "invalid_path");
    check("nor an absolute path", await reads("/etc/hosts"), "invalid_path");
    check("nor .git spelled out", await reads(".git/config"), "invalid_path");
    // The half `safeRelPath` alone cannot answer, and the reason `probeRequestable`
    // is called at all.
    check("nor .git reached through a link", await reads("g/config"), "invalid_path");
    check("a directory is not a file", await reads("sub"), "not_a_file");
    check("and a file past the ceiling is refused rather than truncated", await reads("fat.bin"), "file_too_large");
    // The stub answers `undefined` for every other id, which is what a registry
    // does for a session that is not here.
    check("and a path is never even looked at for a session this machine does not have", await (async () => {
      try {
        await filed.call(manifestWith(["files.read"], [], "files"), "files.read", { sessionId: "gone", path: "notes.txt" });
        return "no refusal";
      } catch (error) {
        return error instanceof PluginApiError ? error.code : String(error);
      }
    })(), "session_not_found");
    rmSync(tree, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- *
   * What comes back, which nothing asked about.
   *
   * Two bounds and they catch different servers: a `content-length` is refused
   * before a byte is read, and a server that declares nothing is refused *while*
   * it is still sending. The second is the one that matters — a plugin's own
   * allowlisted host answering an endless chunked body could otherwise spend the
   * whole 10s window growing this daemon's heap, which is the measurement
   * `readBounded`'s docblock records.
   * ---------------------------------------------------------------- */
  {
    const fresh = manifestWith(["net"], ["late.example.com"], "late");
    answers = () =>
      new Response("x", { status: 200, headers: { "content-length": String(8 * 1024 * 1024) } });
    check(
      "a response that declares more than a plugin may read",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/a" }),
      "response_too_large",
    );

    // The case the header cannot see: no `content-length`, and it never stops.
    let pulls = 0;
    answers = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        }),
        { status: 200 },
      );
    check(
      "and one that simply keeps sending",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/b" }),
      "response_too_large",
    );
    // Charged per chunk rather than once the body is whole, which is the whole
    // point: a bound that reads everything first is not a bound.
    report("refused while it was still arriving", pulls > 0 && pulls < 64, `${pulls} chunks read`);

    /*
     * ⚠ **Refused before a byte of it is read — which the `/a` case above cannot
     * show.** Its body was the two-character string `"x"`, so a header gate that
     * read the whole thing first and refused it afterwards would have passed that
     * assertion unchanged. A body that counts its own pulls is what separates the
     * two, and the assertion is zero.
     *
     * ⚠ **`highWaterMark: 0`, or this fails against its own fixture.** A
     * `ReadableStream` built with no strategy gets a `CountQueuingStrategy` of one
     * and calls `pull` once at construction — before any reader exists, whatever
     * this daemon does, and `body.cancel()` does not undo it. Measured: one pull
     * with the default, none at zero. At zero the only thing that can move this
     * counter is somebody reading.
     */
    let declaredPulls = 0;
    answers = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              declaredPulls += 1;
              controller.enqueue(new Uint8Array(1024));
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { "content-length": String(MAX_PLUGIN_FETCH_BYTES + 1) } },
      );
    check(
      "one byte past the bound, honestly declared",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/c" }),
      "response_too_large",
    );
    report("and its body was never pulled at all", declaredPulls === 0, `${declaredPulls} chunks read`);

    /*
     * ⚠ **The bound against the channel it has to cross, which nothing checked.**
     * `MAX_PLUGIN_FETCH_BYTES` was `1024 * 1024` while one IPC message carries
     * `MAX_PLUGIN_MESSAGE_BYTES`, so every answer past roughly 250 KiB was
     * fetched in full, charged to the plugin's thirty a minute, read into this
     * daemon's heap — and then refused by `ForkedPlugin.send`, which was the only
     * place the two numbers ever met. So the largest answer the API will hand
     * back is built here and measured inside the `{"t":"answer",…}` envelope
     * `LivePlugin.onChildMessage` actually sends.
     *
     * A body that is all `"` because that is a body's worst *realistic* escape:
     * `JSON.stringify` doubles it, and a JSON payload — the thing `net.fetch`
     * exists to go and fetch — is already a third quotes. Measured at this bound:
     * 131,182 bytes of the 262,144 the channel takes, against 262,254 for the
     * half-channel bound this would otherwise have inherited from `store.entries`.
     */
    answers = () =>
      new Response('"'.repeat(MAX_PLUGIN_FETCH_BYTES), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const largest = (await api.call(fresh, "net.fetch", { url: "https://late.example.com/d" })) as {
      body: string;
    };
    check("a body of exactly the bound is answered rather than refused", largest.body.length, MAX_PLUGIN_FETCH_BYTES);
    const wire = Buffer.byteLength(JSON.stringify({ t: "answer", id: 1, ok: true, value: largest }), "utf8");
    report(
      "and the largest answer it will hand back still crosses the channel it is delivered on",
      wire <= MAX_PLUGIN_MESSAGE_BYTES,
      `${wire} of ${MAX_PLUGIN_MESSAGE_BYTES} bytes`,
    );

    // The other side of that boundary, undeclared, so `readBounded` is the only
    // thing that can catch it. `new Response(string)` sets no `content-length` —
    // measured — which is what makes this the chunked path rather than the header
    // one, with a body one byte over instead of an endless stream.
    answers = () => new Response("a".repeat(MAX_PLUGIN_FETCH_BYTES + 1), { status: 200 });
    check(
      "and one byte more than that is refused",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/e" }),
      "response_too_large",
    );

    /*
     * ⚠ **Inside the read bound and still undeliverable**, which is the case the
     * assembled-answer check at the end of `fetch` exists for. Every C0 control
     * byte is a six-character `\u00XX` escape, so a body at exactly the read bound
     * serialises to 393,326 against a 262,144-byte channel. Refused here with the
     * code the docs publish, rather than assembled, charged and then dropped by
     * `ForkedPlugin.send` naming a limit the plugin was never given.
     */
    answers = () =>
      new Response(String.fromCharCode(1).repeat(MAX_PLUGIN_FETCH_BYTES), { status: 200 });
    check(
      "a body inside the bound that could not be delivered is refused here, not at the channel",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/f" }),
      "response_too_large",
    );

    answers = () => new Response("hi", { status: 200 });
  }

  /*
   * `agents.list` sits behind `sessions.read` rather than a scope of its own: it
   * is the fact a plugin needs *before* `sessions.create`, and a fifth scope for
   * one method would be a fifth line somebody has to understand in the install
   * list.
   */
  report(
    "asking what this machine could run needs only sessions.read",
    Array.isArray(await api.call(manifestWith(["sessions.read"]), "agents.list", {})),
    "an array of availability rows",
  );

  check("a session this machine does not have", await codeOf(manifestWith(["sessions.read"]), "sessions.get", { id: "s_nope" }), "session_not_found");
  check("and an argument that is not a string", await codeOf(manifestWith(["sessions.read"]), "sessions.get", { id: 7 }), "bad_request");

  /* ---------------------------------------------------------------- *
   * Which scope, and not merely that there is one.
   *
   * ⚠ **The sweep above proves every method needs *a* scope. It cannot prove any
   * of them needs the right one** — it runs one manifest declaring nothing, so a
   * table mapping `"sessions.stop"` to `"sessions.read"` would satisfy every
   * assertion in this file up to here while handing a read-only plugin the verb
   * that ends somebody's session. The two halves are not the same claim and only
   * one of them was being made.
   *
   * Derived rather than restated: each method is asked five times, once per
   * manifest holding four of the five scopes, and the scope whose absence is the
   * one that draws `plugin_scope_denied` is the scope that method actually needs.
   * That is what a driver can find out from outside `api.ts`. The comparison at
   * the end is against a literal, which is the copy — **exporting `SCOPE_OF` would
   * let this be derived instead, and it is deliberately not exported**: it is the
   * gate, and a gate exported so a test can read it is a gate anything else can
   * import and reason about.
   *
   * Every probe is sent `{}`, so the four that pass the gate fail immediately on
   * `bad_request` or `session_not_found` rather than doing the thing. That is not
   * tidiness — with real arguments this loop would call `sessions.create` sixteen
   * times and `sessions.stop` on whatever it made.
   * ---------------------------------------------------------------- */
  const scopeNeededBy = async (method: string): Promise<string> => {
    const refused: string[] = [];
    for (const missing of PLUGIN_SCOPES) {
      const held = PLUGIN_SCOPES.filter((one) => one !== missing);
      // A manifest declaring `net` must name hosts, so the list rides the scope
      // rather than being constant — `readNet` refuses the pair that disagrees.
      const manifest = manifestWith([...held], held.includes("net") ? ["api.example.com"] : []);
      if ((await codeOf(manifest, method, {})) === "plugin_scope_denied") refused.push(missing);
    }
    // Never "the first one refused": a method behind two scopes, or behind none
    // once somebody edits the table, is a different fact from a mis-mapping and
    // has to read differently in the output.
    return refused.length === 1 ? String(refused[0]) : `${refused.length} scopes: ${refused.join("+")}`;
  };
  const mapping: [string, string][] = [];
  for (const [method] of METHODS) mapping.push([method, await scopeNeededBy(method)]);
  check("and each of them is behind the right one", mapping, [
    ["sessions.list", "sessions.read"],
    ["sessions.get", "sessions.read"],
    ["sessions.events", "sessions.read"],
    ["sessions.changes", "sessions.read"],
    ["sessions.diff", "sessions.read"],
    ["sessions.workspace", "sessions.read"],
    ["sessions.create", "sessions.write"],
    ["sessions.prompt", "sessions.write"],
    ["sessions.cancel", "sessions.write"],
    ["sessions.stop", "sessions.write"],
    ["sessions.setMeta", "sessions.write"],
    ["sessions.answerPermission", "sessions.write"],
    ["sessions.answerElicitation", "sessions.write"],
    // The one that is not obvious from its name, and the one a refactor would get
    // wrong first. See the comment on `SCOPE_OF` for why it is not its own scope.
    ["agents.list", "sessions.read"],
    ["files.read", "files.read"],
    ["store.get", "store"],
    ["store.set", "store"],
    ["store.delete", "store"],
    ["store.keys", "store"],
    ["store.entries", "store"],
    ["net.fetch", "net"],
    ["model.complete", "model"],
    // Not `sessions.read`, which is where a method called "list" would land by
    // reflex — reading an agent's model list spawns that agent, so it belongs
    // with the one that spends, not with the ones that only look.
    ["model.list", "model"],
  ]);
}

process.stdout.write("\nasking an agent one question, and every way that is refused\n");
{
  const { AgentAskRuns, AgentAskError, MAX_ASK_PROMPT_BYTES, MAX_CONCURRENT_ASKS } = await import(
    "../src/agentask.js"
  );

  /**
   * A runtime that answers `availability()` and nothing else.
   *
   * ⚠ **Every case below is refused *before* `launch` is reached**, which is the
   * property that makes this fake honest rather than convenient: `launch` throws,
   * so any assertion that accidentally got past the gate would fail loudly rather
   * than pass on a stub. The refusals that need a real ACP session — the deadline,
   * the output ceiling, the text collection — are not here and are named at the
   * foot of this section rather than left to look covered.
   */
  const runtimeWith = (agents: { id: string; available: boolean; loggedIn: boolean | null; hint?: string }[]): never =>
    ({
      availability: () =>
        Promise.resolve(
          agents.map((one) => ({
            id: one.id,
            displayName: one.id,
            available: one.available,
            hint: one.hint ?? null,
            loggedIn: one.loggedIn,
            lastStartRefusal: null,
          })),
        ),
      launch: () => {
        throw new Error("this driver refuses before anything is launched");
      },
    }) as never;

  const codeOfAsk = async (runs: InstanceType<typeof AgentAskRuns>, agent: string, prompt = "hi"): Promise<string> => {
    try {
      await runs.ask(agent as never, prompt);
      return "none";
    } catch (error) {
      return error instanceof AgentAskError ? error.code : `unexpected: ${String(error)}`;
    }
  };

  const claudeOnly = runtimeWith([{ id: "claude", available: true, loggedIn: true }]);
  const runs = new AgentAskRuns({ runtime: claudeOnly, cwd: tmp("ask-") });

  check("an agent this machine does not have", await codeOfAsk(runs, "kimi"), "model_agent_unknown");
  check(
    "a prompt larger than a prompt may be",
    await codeOfAsk(runs, "claude", "x".repeat(MAX_ASK_PROMPT_BYTES + 1)),
    "model_prompt_too_large",
  );
  check("and nothing to ask at all", await codeOfAsk(runs, "claude", "   "), "model_prompt_empty");

  /*
   * ⚠ **`loggedIn` is three-valued, and `null` must be attempted rather than
   * refused.** Q7.99 records this exact mistake one subsystem over: `null` means
   * *this agent has no non-interactive way to answer*, which is permanently true
   * of kimi — so reading it as "not signed in" refuses an agent that works, and
   * on this path there is no screen on which anybody could discover otherwise.
   *
   * The assertion is that `null` gets **past** the gate: it reaches `launch`,
   * which this fake throws from, so `model_failed` here is the proof that the
   * check did not short-circuit. `false` is refused before that.
   */
  const mixed = new AgentAskRuns({
    runtime: runtimeWith([
      { id: "claude", available: true, loggedIn: false },
      { id: "kimi", available: true, loggedIn: null },
      { id: "codex", available: false, loggedIn: null, hint: "install codex first" },
    ]),
    cwd: tmp("ask-"),
  });
  check("an agent that is installed and signed out", await codeOfAsk(mixed, "claude"), "model_agent_signed_out");
  check(
    "an agent that cannot say whether it is signed in is tried, not refused",
    await codeOfAsk(mixed, "kimi"),
    "model_failed",
  );
  check("an agent that is not installed carries the runtime's own hint", await codeOfAsk(mixed, "codex"), "model_agent_unavailable");
  check(
    "and the hint is what it says rather than a sentence this file invented",
    await mixed.ask("codex" as never, "hi").catch((error: unknown) => (error as Error).message),
    "install codex first",
  );

  /*
   * ⚠ **The daemon-wide cap, and it counts starts as well as running turns.** A
   * cap that only counted `live` would let N calls all get past the check while
   * every one of them was still inside `Session.start` — which is a subprocess
   * spawn and an ACP handshake, i.e. the expensive part. `inFlight` is the sum,
   * and `starting` is why.
   */
  const slow = new AgentAskRuns({
    runtime: {
      availability: () => Promise.resolve([{ id: "claude", displayName: "claude", available: true, hint: null, loggedIn: true, lastStartRefusal: null }]),
      // `Session.start` asks for this *before* it launches, so a fake without it
      // throws there and never reaches the park — which is how the first version
      // of this case measured `model_failed` and an empty `starting`.
      describe: () => ({ displayName: "claude", authHint: "" }),
      clientFileIo: false,
      // Never resolves, so every accepted ask stays in `starting`.
      launch: () => new Promise(() => {}),
    } as never,
    cwd: tmp("ask-"),
  });
  const parked = Array.from({ length: MAX_CONCURRENT_ASKS }, () => slow.ask("claude" as never, "hi").catch(() => "parked"));
  // Let each of them get past the availability await and into `starting`.
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("one more than the machine will run at once", await codeOfAsk(slow, "claude"), "model_busy");
  check("and the cap counted the ones still starting", slow.inFlight, MAX_CONCURRENT_ASKS);

  /* ---------------------------------------------------------------- *
   * ⭐ The capability sweep queues for a slot; an ask is still refused one
   *
   * `GET /agents/capabilities` reads every harness. With four harnesses against a
   * cap of two and an `admit` that **threw**, a `Promise.all` there meant the
   * third and fourth always came back "this machine is already running 2 model
   * requests" — codex permanently greyed out in the builder with a sentence about
   * load. The route was made serial to dodge it, and serial is 5286 ms of cold
   * spawns (claude 1162, kimi 627, codex 2260, opencode 1237) where four metered
   * through the same cap of two is 3061 ms. Measured 2026-08-28 against the real
   * harnesses.
   *
   * ⚠ **The asymmetry is the design.** `ask` is a plugin's question with a screen
   * behind it, and `model_busy` is a refusal it can report — parking it would turn
   * a load message into a hang. The sweep has no per-harness meaning to refuse.
   * ---------------------------------------------------------------- */
  {
    const everyone = ["claude", "kimi", "codex", "opencode"];
    const stuck = new AgentAskRuns({
      runtime: {
        availability: () =>
          Promise.resolve(
            everyone.map((id) => ({ id, displayName: id, available: true, hint: null, loggedIn: true, lastStartRefusal: null })),
          ),
        describe: () => ({ displayName: "stub", authHint: "" }),
        clientFileIo: false,
        // Never resolves, so whatever is admitted stays in `starting` for ever and
        // the cap is genuinely full for the length of this case.
        launch: () => new Promise(() => {}),
      } as never,
      cwd: tmp("caps-"),
    });
    const held = [
      stuck.capabilities("claude" as never, undefined, true).catch(() => "parked"),
      stuck.capabilities("kimi" as never, undefined, true).catch(() => "parked"),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    check("two capability reads fill the machine", stuck.inFlight, MAX_CONCURRENT_ASKS);

    /*
     * The property, and it has to be asserted as *not settling*: a queued caller
     * has no answer yet, which is the whole difference from a refusal. Raced
     * against a timer rather than awaited, because awaiting it is the hang this is
     * about.
     */
    const third = stuck
      .capabilities("codex" as never, undefined, true)
      .then(() => "answered")
      .catch((error: unknown) => (error instanceof AgentAskError ? error.code : "other"));
    const settled = await Promise.race([
      third,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 40)),
    ]);
    check("a third one waits for a slot rather than being told the machine is busy", settled, "still waiting");

    // And the other entry point is untouched: same full machine, immediate refusal.
    check("while an ask on the same full machine is refused at once", await codeOfAsk(stuck, "opencode"), "model_busy");
    /*
     * ⚠ **And the queue is opt-in per *call*, not per method.** A plugin's
     * `model.list` reaches the same reader, and `MAX_CONCURRENT_ASKS` is a bound
     * `docs/PLUGINS.md` publishes to plugin authors — parking one inside its own
     * ten-second invocation would make a documented refusal unobservable and turn
     * a load message into a timeout. Only the sweep asks to wait.
     */
    const listed = await stuck
      .models("opencode" as never)
      .then(() => "answered")
      .catch((error: unknown) => (error instanceof AgentAskError ? error.code : "other"));
    check("and a plugin's model list is refused rather than parked", listed, "model_busy");

    /*
     * ⚠ **A shutdown drains the queue rather than leaving it parked.** Without a
     * wake there, a caller waiting on a slot that will never be handed out waits
     * for the life of the process — a hang with no output.
     *
     * Not awaited, for the reason the block above this one gives about its own
     * `closing`: `shutdown` waits on what was still being born, and these starts
     * never resolve. The wake happens synchronously before that await, which is
     * exactly what this asserts.
     */
    const closingCaps = stuck.shutdown();
    check("and a shutdown wakes what was waiting, with a reason", await third, "model_unavailable");
    void held;
    void closingCaps;
  }

  /*
   * ⚠ **Shutdown waits for what was still being born.** An ask accepted moments
   * before SIGTERM is inside `Session.start` when the drain runs; without
   * awaiting `starting` it would spawn *after* the drain and outlive
   * `process.exit(0)` with nothing holding it. `AgentLoginRuns` records the same
   * measurement. Driven here by leaving two parked starts and asserting that a
   * shutdown does not race past them — and that the door is shut afterwards.
   */
  const closing = slow.shutdown();
  check("an ask arriving during shutdown is refused rather than started", await codeOfAsk(slow, "claude"), "model_unavailable");
  void parked;
  void closing;

  /*
   * ⚠ **Not covered here, and said rather than left looking covered:** the wall
   * clock, the output ceiling and the text collection all need a real ACP
   * handshake, so they are exercised by `pnpm harness` against a live agent
   * rather than by this driver. What this section does cover is every refusal
   * that happens before a process is spawned — which is every refusal a plugin
   * author can actually provoke by getting the call wrong.
   */
}

process.stdout.write("\nwhich model a one-shot ask runs on\n");
{
  /* ---------------------------------------------------------------- *
   * ⚠ **This daemon has no list of models and could not have one.** There is no
   * field called `model` anywhere in `src/`: selection travels over ACP's
   * `session/set_config_option`, where "model" is one value of the option's
   * `category`, and what exists is whatever the agent's CLI decided this week. So
   * the only honest answer to *which models are there* is to start the agent and
   * read what it publishes — and the only way to drive that offline is a real
   * `Session` over pipes with a fake agent on the far end, which is what this is.
   *
   * The three things a refusal-only fake could never reach: that the list really
   * comes off `session/new`, that a chosen model really reaches
   * `session/set_config_option`, and that a *stale* choice is refused against the
   * agent standing in front of us rather than against the cache somebody read.
   * ---------------------------------------------------------------- */
  const acp = await import("@agentclientprotocol/sdk");
  const { LocalRuntime } = await import("../src/runtime/local.js");
  const { PassThrough } = await import("node:stream");
  const { AgentAskRuns, AgentAskError, ASK_TIMEOUT_MS, MAX_ASK_OUTPUT_BYTES, MAX_ASK_PROMPT_BYTES, MAX_CONCURRENT_ASKS, MODELS_TTL_MS } =
    await import("../src/agentask.js");
  const { PLUGIN_INVOKE_TIMEOUT_MS } = await import("../src/plugins/runtime.js");

  /** Every `session/set_config_option` the daemon sent, as it sent it. */
  const configured: { configId: string; value: unknown }[] = [];
  /** How many `session/new` calls this fake has answered. Feeds the cache case. */
  let opened = 0;
  /** What the agent claims its models are. Rewritten mid-section, on purpose. */
  let models = [
    { value: "opus", name: "Opus 5", description: "the big one" },
    { value: "haiku", name: "Haiku 4.5", description: null },
  ];

  /*
   * ⚠ **A fresh pair of pipes per launch, not one pair shared.** Every case here
   * starts and disposes a session, and `dispose` ends the agent's stdin — so a
   * single pair works exactly once and every case after the first dies with "ACP
   * connection closed". That is an artefact of both ends being in this process,
   * and it is the reason the peer is built inside `launch` rather than around it.
   */
  /*
   * ⚠ **A turn that never answers, opt-in, so every assertion below keeps the fake
   * it already had.** The cancellation case needs an agent that has started and is
   * still talking — a `session/prompt` that resolves at once can only ever be
   * raced by a deadline, never by a caller walking away.
   */
  let hangPrompt = false;
  /*
   * What the agent *says* before it stops, which every case above leaves empty —
   * `stopReason: end_turn` and not one word of answer. The output ceiling is
   * charged **as chunks arrive** rather than measured at the end, so a fixture
   * that answered in one lump could not tell the two apart.
   */
  let sayBack: string[] = [];
  const speak = (): { toAgent: PassThrough; toClient: PassThrough } => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): boolean => toClient.write(`${JSON.stringify(message)}\n`);
    /**
     * The `session/prompt` this peer has been asked and has not answered.
     *
     * ⚠ **A cancelled prompt is answered rather than abandoned, because a real
     * agent answers it and the difference is five seconds a case.** `dispose`
     * sends `session/cancel` and then waits the cancel grace out for the turn to
     * end; a peer that never ends one makes every {@link hangPrompt} case cost
     * that whole grace *after* it already has the answer it was asserting about.
     * Measured before this was here: an ask with a 300 ms deadline rejected on
     * time and settled at 5.3 s, which is long enough to make the deadline
     * unassertable inside any window a driver may sit out.
     */
    let parked: unknown = null;
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            opened += 1;
            /*
             * ⚠ **Two options, and the model one is *not* first.** Found by
             * `category`, never by id or position — the standing rule about every
             * agent control in this fleet, and the one a reflex `options[0]` would
             * break silently on the agent that happens to order them the other way.
             */
            send({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId: "s_models",
                configOptions: [
                  {
                    id: "effort",
                    name: "Effort",
                    category: "thought_level",
                    type: "select",
                    currentValue: "default",
                    options: [{ value: "default", name: "Default" }],
                  },
                  {
                    id: "model-picker",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "opus",
                    options: models,
                  },
                ],
              },
            });
            break;
          case acp.methods.agent.session.setConfigOption:
            configured.push({ configId: message["params"]?.configId, value: message["params"]?.value });
            // ACP defines the response's `configOptions` as the complete list, so
            // this answers with the whole thing rather than a delta.
            send({
              jsonrpc: "2.0",
              id,
              result: {
                configOptions: [
                  {
                    id: "model-picker",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: message["params"]?.value,
                    options: models,
                  },
                ],
              },
            });
            break;
          case acp.methods.agent.session.prompt:
            // Deliberately unanswered where the case under test is a caller that
            // leaves mid-turn; see {@link hangPrompt} — held rather than dropped,
            // so the cancel below can end it the way an agent would.
            if (hangPrompt) {
              parked = id;
              break;
            }
            for (const chunk of sayBack) {
              send({
                jsonrpc: "2.0",
                method: acp.methods.client.session.update,
                params: {
                  sessionId: "s_models",
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
                },
              });
            }
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          case acp.methods.agent.session.cancel:
            // A notification, so there is no id to reply to and the `default` arm
            // below would do nothing at all. What it ends is the parked turn.
            if (parked !== null) {
              send({ jsonrpc: "2.0", id: parked, result: { stopReason: "cancelled" } });
              parked = null;
            }
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return { toAgent, toClient };
  };

  // A runtime that is the local one in every respect except where the agent is —
  // subclassing rather than hand-rolling, so a new required member is a type
  // error here rather than a silently untested path.
  class ModelPipes extends LocalRuntime {
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    // The capability read now asks which build answered, and the real answer spawns
    // whatever `claude --version` is on the host — a subprocess this driver did not
    // start, differing by machine. A fixed choice keeps the read hermetic. `path`
    // is what a copy `deploy/agents.sh` installed reports; `vendored` was the
    // third source and went with the vendored copies (Q4.114).
    override agentCli(): Promise<any> {
      return Promise.resolve({ path: "/stub/claude", version: "0.0.0", source: "path" });
    }
    override availability(): Promise<any> {
      return Promise.resolve([{ id: "claude", displayName: "claude", available: true, hint: null, loggedIn: true, lastStartRefusal: null }]);
    }
    override async launch(): Promise<any> {
      const { toAgent, toClient } = speak();
      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      };
    }
  }

  const runs = new AgentAskRuns({ runtime: new ModelPipes() as never, cwd: process.cwd() });

  const listed = await runs.models("claude" as never);
  check(
    "the models are the ones the agent published, not a list this daemon holds",
    listed.map((one) => [one.id, one.name, one.description]),
    [
      ["opus", "Opus 5", "the big one"],
      ["haiku", "Haiku 4.5", null],
    ],
  );
  check("and it cost one agent to find out", opened, 1);

  /*
   * ⚠ **Cached, because the answer costs a subprocess and an ACP handshake.** A
   * settings pane opened twice must not spawn twice. The negative control is the
   * whole assertion: without it, "the list is right" passes on a build that spawns
   * every time.
   */
  const again = await runs.models("claude" as never);
  check("asking again spawns nothing", opened, 1);
  check("and answers the same thing", again.length, listed.length);
  report("the cache is a ceiling on staleness rather than for ever", MODELS_TTL_MS > 0, `${MODELS_TTL_MS}ms`);

  /*
   * ⚠ **A chosen model reaches `session/set_config_option`, with the option's own
   * id.** `model-picker` is deliberately not `model`: a build that sent the
   * *category* as the id would look right in every log and be refused by every
   * real agent.
   */
  await runs.ask("claude" as never, "hi", "haiku");
  check("a chosen model is sent as the option the agent named", configured, [{ configId: "model-picker", value: "haiku" }]);

  /*
   * ⚠ **Three spellings of "not chosen", and all three mean the agent's own
   * default.** Absent, `null` and `""` arrive from shapes nobody controls — a
   * field left out of a JSON body, a `ctx.store.get` for a key nobody wrote, and a
   * form submitting an untouched control. Picking one as *the* spelling makes the
   * other two an error a plugin author discovers in production, which is exactly
   * what the store contract cost somebody a day of. Swept rather than sampled.
   */
  configured.length = 0;
  const spellings: [string, string | undefined][] = [
    ["left out", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ];
  /*
   * ⚠ **Both halves, because "set nothing" alone passes on a build that
   * *threw*.** An implementation reading `""` as a chosen model refuses it as
   * unknown — which also configures nothing, so an assertion about `configured`
   * would be green while every plugin storing an untouched setting was broken.
   * The refusals are collected rather than allowed to reject, so the difference is
   * a named failure rather than a driver that dies here.
   */
  const refused: string[] = [];
  for (const [name, model] of spellings) {
    await runs.ask("claude" as never, "hi", model).catch((error: unknown) => refused.push(`${name}: ${String(error)}`));
  }
  check("no model chosen, in any of its spellings, is refused", refused, []);
  check("and none of them sets anything", configured, []);

  const codeOfAsk = async (model: string): Promise<string> => {
    try {
      await runs.ask("claude" as never, "hi", model);
      return "none";
    } catch (error) {
      return error instanceof AgentAskError ? error.code : `unexpected: ${String(error)}`;
    }
  };
  const messageOf = async (model: string): Promise<string> =>
    await runs.ask("claude" as never, "hi", model).then(
      () => "none",
      (error: unknown) => (error as Error).message,
    );

  check("a model this agent does not offer", await codeOfAsk("gpt-9"), "model_unknown");
  /*
   * ⚠ **The refusal names what is really there.** "Unknown model" and a full stop
   * sends somebody to guess — and a plugin author has no copy of the agent's list,
   * so guessing is all that is left.
   */
  report("and says what it does offer", (await messageOf("gpt-9")).includes("opus"), await messageOf("gpt-9"));
  check("and nothing was sent for the one it refused", configured, []);

  /*
   * ⚠ **Validated against the agent in front of us, never against the cache.**
   * The list somebody chose from may be up to `MODELS_TTL_MS` old and a CLI update
   * can retire a model in between — so a choice that was valid when the dropdown
   * was drawn has to be refused *by name* rather than sent. Driven by retiring a
   * model behind the cache's back: `models()` still answers the old pair, and the
   * ask still refuses.
   */
  models = [{ value: "opus", name: "Opus 5", description: "the big one" }];
  const stale = await runs.models("claude" as never);
  check("the cache still believes the retired model exists", stale.map((one) => one.id), ["opus", "haiku"]);
  check("but using it is refused against what the agent says now", await codeOfAsk("haiku"), "model_unknown");

  /* ---------------------------------------------------------------- *
   * How much an agent may answer with, and what happens one chunk past it.
   *
   * ⚠ **This was named at the foot of the refusal section as "not covered here",
   * and it stayed uncovered because it needs an agent that actually talks.** It is
   * reachable from this section and from nowhere else in this file: the fake up
   * there throws from `launch` on purpose, and the one down here is a real ACP
   * peer over real pipes.
   *
   * The ceiling **refuses rather than clips**, which is the decision worth pinning
   * rather than the number: an agent answering a request for a six-word title with
   * sixteen kilobytes has misunderstood the question, and half of a misunderstood
   * answer is a worse title than none. So the second case asserts the code and, by
   * asserting a code at all, that no text came back — a build that clipped would
   * answer here rather than throw.
   *
   * Both fixtures are built from the constant, in chunks small enough that the
   * ceiling is met part way through a stream. One oversized message would be
   * refused by a build that measured at the end, which is the build this is about.
   * ---------------------------------------------------------------- */
  const chunk = "y".repeat(1_024);
  const chunksFor = (bytes: number): string[] => Array.from({ length: Math.ceil(bytes / chunk.length) }, () => chunk);

  sayBack = chunksFor(MAX_ASK_OUTPUT_BYTES);
  const whole = await runs.ask("claude" as never, "hi");
  check(
    "an answer that meets the ceiling exactly comes back whole",
    [Buffer.byteLength(whole.text, "utf8"), whole.agent],
    [MAX_ASK_OUTPUT_BYTES, "claude"],
  );
  sayBack = chunksFor(MAX_ASK_OUTPUT_BYTES + chunk.length);
  check(
    "and one chunk past it is refused rather than clipped",
    await runs.ask("claude" as never, "hi").then(
      (answer) => `answered with ${Buffer.byteLength(answer.text, "utf8")} bytes`,
      (error: unknown) => (error instanceof AgentAskError ? error.code : `unexpected: ${String(error)}`),
    ),
    "model_too_large",
  );
  sayBack = [];

  /*
   * ⚠ **The deadline is asserted as a *default* rather than as a number, because
   * driving 120 seconds is not something a driver may do.** What can go wrong here
   * is not the clock: it is `collect` reading `options.timeoutMs` and finding a
   * value where a plugin's call has none. Two sections of this file build their own
   * runs with a driver-sized `timeoutMs` precisely so they do not sit out the real
   * one — so a default that had quietly become half a second would look identical
   * in every other assertion here, and a plugin's ask would die a hundred times
   * faster than the document promises.
   *
   * ⚠ **Asserted as a pair over one window, and the first arm is what makes the
   * second mean anything.** "It was still waiting" is also what a run that never
   * started looks like: a fake that failed to hand back an agent at all would pass
   * that line alone. So the same call is made twice against the same hanging peer,
   * once with a deadline a fifth of the window and once with none, and the answer
   * is that one of them fired and the other did not. The window is deliberately
   * far longer than the short deadline rather than close to it — what precedes
   * `collect` is a real spawn and a real ACP handshake, and an assertion sitting
   * just past the deadline measures those instead.
   */
  hangPrompt = true;
  const patience = 1_500;
  const settlesIn = async (waiting: InstanceType<typeof AgentAskRuns>): Promise<string> =>
    await Promise.race([
      waiting
        .ask("claude" as never, "hi")
        .then(() => "answered", (error: unknown) => (error instanceof AgentAskError ? error.code : "threw")),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), patience)),
    ]);
  const impatient = new AgentAskRuns({ runtime: new ModelPipes() as never, cwd: process.cwd(), timeoutMs: patience / 5 });
  const defaulted = new AgentAskRuns({ runtime: new ModelPipes() as never, cwd: process.cwd() });
  check(
    "a deadline the caller set fires, and the one it did not set is not a driver's",
    [await settlesIn(impatient), await settlesIn(defaulted)],
    ["model_timeout", "still waiting"],
  );
  hangPrompt = false;
  await impatient.shutdown();
  await defaulted.shutdown();

  /*
   * ⚠ **And the numbers a plugin author is handed, held to the constants that
   * enforce them.** `docs/PLUGINS.md` is the only place any of these appears to
   * the person writing against them — there is no screen, no header and no reply
   * that says what the ceilings are — so a bound that moved without that file
   * moving is a published contract this daemon has quietly stopped keeping. Three
   * of the four have no other reader at all: nothing outside `agentask.ts` names
   * `MAX_ASK_OUTPUT_BYTES` or `ASK_TIMEOUT_MS`.
   *
   * Here rather than in `docscheck` because that driver's subject is prose held to
   * what it says about *itself* — its own counts, its own citations. This is a
   * document held to a number in `src/`, which is a fact about the daemon, and it
   * belongs beside the assertions that drive the same number.
   *
   * The blockquote markers and the wrapping are folded out first: these sentences
   * are wrapped for reading, and a fragment that spans a line break would make
   * this an assertion about where somebody's editor put a newline.
   */
  const authors = readFileSync(new URL("../docs/PLUGINS.md", import.meta.url), "utf8").replace(/\n>?[ \t]*/g, " ");
  const published: [string, string][] = [
    ["what one ask may carry", `${MAX_ASK_PROMPT_BYTES / 1024} KiB of prompt, ${MAX_ASK_OUTPUT_BYTES / 1024} KiB back, ${ASK_TIMEOUT_MS / 1_000} s`],
    ["how many at once", `and ${MAX_CONCURRENT_ASKS} at a time for the whole machine`],
    /*
     * The pair that document prints together on purpose, and the one worth
     * checking hardest: an invocation's deadline against this call's, which is
     * the gap that makes `await`ing a model call inside a hook a plugin that
     * stops itself.
     */
    ["the gap between an invocation and an ask", `**${PLUGIN_INVOKE_TIMEOUT_MS / 1_000} seconds** to answer against this call's **${ASK_TIMEOUT_MS / 1_000}**`],
  ];
  for (const [name, sentence] of published) {
    report(`what PLUGINS.md says about ${name} is what this daemon does`, authors.includes(sentence), sentence);
  }

  /*
   * ⚠ **A caller that walks away ends the turn, rather than the turn outliving it
   * by nearly two minutes.** `ASK_TIMEOUT_MS` is 120 s and the only caller this
   * has is a plugin invocation with `PLUGIN_INVOKE_TIMEOUT_MS` — 10 s — to answer
   * in, three of those stopping the plugin altogether. So the measured shape was a
   * plugin timed out, then stopped, then removed with its row and tree deleted,
   * and an agent subprocess still holding one of the two slots this machine allows
   * for another 110 seconds. `LivePlugin.hostCallsAbort` is what now says so, and
   * this is the far end of that signal.
   *
   * ⚠ **Its own `AgentAskRuns`, with a driver-only half-second deadline.** Reusing
   * the section's `runs` would leave a build with the signal reverted hanging out
   * the full two minutes before failing; here it fails in half a second, and as
   * `model_timeout` rather than `model_cancelled`, which is the difference the
   * assertion is about. `timeoutMs` is documented as existing for exactly this.
   */
  const leaving = new AgentAskRuns({ runtime: new ModelPipes() as never, cwd: process.cwd(), timeoutMs: 500 });
  hangPrompt = true;
  const walkAway = new AbortController();
  const asked = leaving.ask("claude" as never, "hi", undefined, walkAway.signal);
  // Long enough for the handshake, `session/new` and the prompt to be in flight —
  // the window this is about is the one *after* the agent has started.
  await new Promise((resolve) => setTimeout(resolve, 50));
  walkAway.abort(new Error("plugin board was stopped"));
  check(
    "a caller that has gone ends the turn rather than waiting the deadline out",
    await asked.then(
      () => "none",
      (error: unknown) => (error instanceof AgentAskError ? error.code : `unexpected: ${String(error)}`),
    ),
    "model_cancelled",
  );
  /*
   * ⚠ **And the agent it started is disposed rather than merely unwaited-for.**
   * The refusal travelling is half the fix; `ask`'s `finally` letting go of the
   * subprocess is the half that gives the slot back, and `inFlight` counts
   * `reserved`, `starting` and `live` together — so this is also the assertion
   * that the abort did not corrupt that accounting.
   */
  check("and the agent it started is let go of", leaving.inFlight, 0);
  hangPrompt = false;
  await leaving.shutdown();

  await runs.shutdown();
}

process.stdout.write("\na plugin that will not start, or will not answer\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const parsed = parseManifest(
    JSON.stringify({ id: "p", name: "P", version: "1.0.0", api: 1, scopes: [], contributes: { settings: true } }),
  );
  if (!parsed.ok) throw new Error(parsed.message);
  const manifest = parsed.manifest;

  /**
   * A child this driver controls completely.
   *
   * **This is why `PluginRuntime` is an interface.** A start that never completes,
   * an invocation that is never answered and a crash after `ready` are the three
   * paths worth being sure about, and none of them is reachable by spawning a real
   * process and hoping it misbehaves on cue.
   */
  const scripted = (
    behaviour: { init: "ready" | "fail" | "silent"; answer: "yes" | "silent" },
  ): { runtime: PluginRuntime; launches: () => number; stops: () => number; crash: () => void } => {
    let launches = 0;
    let stops = 0;
    let crash = (): void => undefined;
    const runtime: PluginRuntime = {
      launch(options) {
        launches += 1;
        crash = () => options.onExit("exited with code 1");
        return Promise.resolve({
          send(message) {
            if (message.t === "init") {
              if (behaviour.init === "ready") queueMicrotask(() => options.onMessage({ t: "ready" }));
              if (behaviour.init === "fail") queueMicrotask(() => options.onMessage({ t: "fail", error: "no" }));
              return true;
            }
            if (message.t === "invoke" && behaviour.answer === "yes") {
              queueMicrotask(() =>
                options.onMessage({ t: "done", id: message.id, ok: true, value: { title: null, blocks: [] } }),
              );
            }
            // Reports the write, as `ForkedPlugin` does; nothing here ever refuses one.
            return true;
          },
          stop() {
            stops += 1;
            return Promise.resolve();
          },
          recentLogs: () => ["a line the child printed"],
        });
      },
    };
    return { runtime, launches: () => launches, stops: () => stops, crash: () => crash() };
  };

  const openWith = async (
    runtime: PluginRuntime,
  ): Promise<{ host: Awaited<ReturnType<typeof PluginHost.open>>; warnings: string[]; close: () => Promise<void> }> => {
    const stores = openStores({ path: join(tmp("plugin-life-"), "d.db"), instanceId: `i_${Math.floor(Math.random() * 1e6)}` });
    stores.plugins.put({
      id: "p",
      version: "1.0.0",
      manifest,
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: null,
    });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const warnings: string[] = [];
    const host = await PluginHost.open({
      root: join(tmp("plugin-life-root-"), "plugins"),
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      onWarning: (detail) => warnings.push(detail),
      runtime,
      timeouts: { start: 60, invoke: 60 },
    });
    return {
      host,
      warnings,
      close: async () => {
        await host.shutdown();
        await registry.shutdown();
        stores.close();
      },
    };
  };

  const codeOf = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "threw";
    }
  };

  {
    const silent = scripted({ init: "silent", answer: "yes" });
    const { host, close } = await openWith(silent.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    check("a child that never says it is ready", await codeOf(plugin.invoke("view", "settings", {})), "plugin_unavailable");
    check("is stopped rather than left running", silent.stops() > 0, true);
    report("and its failure carries what it printed", plugin.failure?.includes("a line the child printed") === true, plugin.failure ?? "");
    check("the row says so", host.list().map((one) => one.state), ["failed"]);
    await close();
  }

  {
    const broken = scripted({ init: "fail", answer: "yes" });
    const { host, close } = await openWith(broken.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    /*
     * Three attempts and then no more, for the reason `autoResume` has a budget:
     * a plugin that cannot start will not start because it was asked a fourth
     * time, and a daemon that keeps trying spends a core on it.
     *
     * ⚠ **Who is asking decides whether the attempt is charged**, so this drives
     * both halves. A `view` is `read`-scoped and `PluginScreen` re-reads it on a
     * timer, so a passive caller must be able to hammer a broken plugin without
     * moving the counter — otherwise a grant that can press nothing on a screen
     * spends a budget only `machine:admin` can give back. A `hook` is this
     * daemon's own traffic and pays. See `StartIntent`.
     */
    const launchedBefore = broken.launches();
    const codes: string[] = [];
    for (let i = 0; i < 5; i += 1) codes.push(await codeOf(plugin.invoke("view", "settings", {})));
    check("five read-only views against a broken plugin start nothing", broken.launches(), launchedBefore);
    check("and every attempt still answers rather than hanging", new Set(codes).has("plugin_unavailable"), true);
    /*
     * The supervised half. `deliver` is what the daemon's own hook traffic goes
     * through, and it drains through `ensureStarted("supervised")` — so this is
     * the caller that walks the budget down, and the one the refusal is written for.
     */
    const hookCodes: string[] = [];
    for (let i = 0; i < 5; i += 1) hookCodes.push(await codeOf(plugin.invoke("hook", "turn.ended", {})));
    report("but the daemon's own traffic does spend it", broken.launches() > launchedBefore, `${broken.launches()} launches`);
    check("and a hook that cannot be delivered still answers", new Set(hookCodes).has("plugin_unavailable"), true);
    report("and stops at three", broken.launches() <= 3, `${broken.launches()} launches`);
    report(
      "the last refusal says it has given up",
      plugin.failure?.includes("will not be tried again") === true,
      plugin.failure ?? "",
    );
    // Switching it off and on is new information, exactly as a restart is for
    // auto-resume, so the budget comes back.
    const beforeToggle = broken.launches();
    await host.setEnabled("p", false);
    await host.setEnabled("p", true);
    report("switching it back on returns the budget", broken.launches() > beforeToggle, `${broken.launches()} launches`);
    await close();
  }

  {
    const mute = scripted({ init: "ready", answer: "silent" });
    const { host, close } = await openWith(mute.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    check("a child that never answers", await codeOf(plugin.invoke("view", "settings", {})), "plugin_timeout");
    check("and again", await codeOf(plugin.invoke("view", "settings", {})), "plugin_timeout");
    check("and a third time", await codeOf(plugin.invoke("view", "settings", {})), "plugin_timeout");
    // Three in a row and it is stopped rather than asked a fourth. A person is
    // waiting behind each of these, so what matters is that they all *end*.
    report("three of those stop it", mute.stops() > 0, `${mute.stops()} stops`);
    await close();
  }

  {
    const crashy = scripted({ init: "ready", answer: "yes" });
    const { host, warnings, close } = await openWith(crashy.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    check("a plugin that is up answers", (await plugin.invoke("view", "settings", {})).kind, "view");
    crashy.crash();
    check("a child that dies on its own is a failure", host.list().map((one) => one.state), ["failed"]);
    report("and it is reported", warnings.some((one) => one.includes("exited with code 1")), `${warnings.length} warnings`);
    await close();
  }
}

process.stdout.write("\nhooks reaching a plugin\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");
  const { PLUGIN_HOOKS } = await import("../src/plugins/protocol.js");

  /**
   * A plugin whose answers this driver holds until it lets go.
   *
   * The `hold`/`release` pair is what makes the queue drivable at all. `drain` is
   * sequential — one hook in flight, the next taken only once the last has been
   * answered — so a runtime that answers immediately empties the queue as fast as
   * `deliver` fills it and the bound is never reached. Holding the first answer
   * parks the drain with the queue growing behind it, which is exactly the state
   * {@link MAX_HOOK_QUEUE} exists for: a plugin that has stopped answering while
   * the machine keeps working.
   */
  const scripted = (): {
    runtime: PluginRuntime;
    seen: () => { kind: string; hook: string; session: string; mark: number }[];
    launches: () => number;
    hold: () => void;
    release: () => void;
  } => {
    let launches = 0;
    let holding = false;
    const seen: { kind: string; hook: string; session: string; mark: number }[] = [];
    const held: number[] = [];
    let answer: (id: number) => void = () => undefined;
    const runtime: PluginRuntime = {
      launch(options) {
        launches += 1;
        answer = (id) => queueMicrotask(() => options.onMessage({ t: "done", id, ok: true, value: null }));
        return Promise.resolve({
          send(message) {
            if (message.t === "init") {
              queueMicrotask(() => options.onMessage({ t: "ready" }));
              return true;
            }
            if (message.t === "invoke") {
              const input = message.input as { hook?: unknown; session?: { id?: unknown }; mark?: unknown } | null;
              seen.push({
                kind: message.kind,
                /*
                 * Read off the **payload** rather than off `name`, because they
                 * are two writes and only one of them is what a plugin sees: the
                 * host sends the hook as the invocation's name *and* folds it into
                 * the object the child is handed, and `runner.ts` passes the
                 * second one to `hook(ctx, event)`. A plugin switching on
                 * `event.hook` is switching on this.
                 */
                hook: String(input?.hook ?? ""),
                session: String(input?.session?.id ?? ""),
                mark: typeof input?.mark === "number" ? input.mark : -1,
              });
              if (holding) held.push(message.id);
              else answer(message.id);
            }
            return true;
          },
          stop: () => Promise.resolve(),
          recentLogs: () => [],
        });
      },
    };
    return {
      runtime,
      seen: () => seen,
      launches: () => launches,
      hold: () => {
        holding = true;
      },
      release: () => {
        holding = false;
        for (const id of held.splice(0)) answer(id);
      },
    };
  };

  /**
   * Wait until a counter stops moving.
   *
   * A fixed sleep would be a guess: one hook is a handful of microtasks and the
   * queue case below is two hundred and fifty-seven of them in a row. This ends
   * on the first round that added nothing, so the ordinary case costs one tick.
   */
  const settle = async (of: () => number): Promise<void> => {
    let last = -1;
    for (let round = 0; round < 400 && last !== of(); round += 1) {
      last = of();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  /**
   * An agent that cannot be started, on purpose.
   *
   * ⚠ **What is being driven here is the announcement, not the agent.**
   * `registry.create` calls `announce(managed, "created")` *before*
   * `managed.start()` — the ordering is written into that function so an observer
   * is attached before the first thing the agent says — so a runtime whose
   * `launch` throws produces the real announcement, the real `observe` and a real
   * snapshot in the hook's payload, without this section standing up a second ACP
   * handshake over pipes. The throw is not incidental either: a start that failed
   * is an exit, and an exit is the only thing `session.ended` is derived from.
   */
  class NoAgent extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<never> {
      throw new Error("this driver has no agent to start");
    }
  }

  const root = tmp("hooks-");
  // Populated *before* the host is opened, which is what makes `seed` a real
  // question: a board installed on a working machine is empty until somebody
  // starts something, unless the install offers it what is already there.
  const registry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_restored", join(root, "wt"))]),
    undefined,
    new NoAgent(),
  );
  registry.restore({ reapOrphans: false });

  const plugin = scripted();
  const stores = openStores({ path: join(tmp("hooks-db-"), "d.db"), instanceId: "i_hooks" });
  const warnings: string[] = [];
  const host = await PluginHost.open({
    root: join(root, "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
    onWarning: (detail) => warnings.push(detail),
    runtime: plugin.runtime,
    timeouts: { start: 500, invoke: 500 },
  });

  const installed = await host.install({
    body: bodyOf(
      tarOf({
        "plugin.json": JSON.stringify({
          id: "watcher",
          name: "Watcher",
          version: "1.0.0",
          api: 1,
          scopes: [],
          // Every one of them, so a hook added to the union without a `fan` arm
          // shows up here as a hook nothing ever produced rather than as nothing.
          contributes: { hooks: [...PLUGIN_HOOKS] },
        }),
        "server.js": "export function hook() {}",
      }),
    ),
    name: "watcher.tar.gz",
  });
  check("a plugin declaring hooks installs", installed.kind === "ok" ? installed.summary.id : installed, "watcher");
  check(
    "and its manifest is what decides which it is sent",
    installed.kind === "ok" ? installed.summary.contributes.hooks : null,
    [...PLUGIN_HOOKS],
  );

  await settle(() => plugin.seen().length);
  /*
   * `seed`, which is the one delivery that is not an event: every session this
   * daemon already knows about, offered to a plugin that has only just arrived.
   * It is `install`'s last act and it is why `session.created` is the only hook
   * with two producers.
   */
  check(
    "and it is offered the session that was already here",
    plugin.seen().map((one) => [one.kind, one.hook, one.session]),
    [["hook", "session.created", "s_restored"]],
  );

  /*
   * ⚠ **And again on an update, which reads as a replay if it is found without
   * this note.** `install` calls `seed` unconditionally — first install and update
   * alike — so a plugin updated on a machine holding forty sessions is handed
   * forty `session.created` deliveries it has been handed once already, and its
   * store survives the update (`plugin_data` is keyed on the id and never on the
   * version, deliberately), so a plugin doing anything once-only has to say so
   * itself. `docs/PLUGINS.md` is where an author is told; this is where the daemon
   * is held to it.
   *
   * It is the answer rather than an oversight, and the argument is `open()` one
   * file over: what a seed is *for* is a child that has just come up knowing
   * nothing, and an update makes one — the incumbent is stopped, a fresh
   * `LivePlugin` is built, and the new process has been told nothing at all. Every
   * boot does the same for every installed plugin, for the same reason. So the
   * rule is "a child that has just come up is offered what is already here", and
   * install, update and restart are three ways of coming up rather than three
   * policies. A build that seeded a first install only would pass every line above
   * this one, which is why the pair is here rather than the sentence.
   */
  const seenBeforeUpdate = plugin.seen().length;
  const updated = await host.install({
    body: bodyOf(
      tarOf({
        "plugin.json": JSON.stringify({
          id: "watcher",
          name: "Watcher",
          version: "2.0.0",
          api: 1,
          scopes: [],
          contributes: { hooks: [...PLUGIN_HOOKS] },
        }),
        "server.js": "export function hook() {}",
      }),
    ),
    name: "watcher.tar.gz",
  });
  check(
    "the same id again is an update rather than a second plugin",
    updated.kind === "ok" ? [updated.summary.version, updated.replaced] : updated,
    ["2.0.0", "1.0.0"],
  );
  await settle(() => plugin.seen().length);
  check(
    "and the child it brings up is offered that session again, exactly as a boot would",
    plugin.seen().slice(seenBeforeUpdate).map((one) => [one.hook, one.session]),
    [["session.created", "s_restored"]],
  );

  // A mark rather than `slice(1)`, which is what this was: the seed above is no
  // longer one delivery, and a positional literal here made adding the update case
  // fail an assertion that is about something else entirely. Every other slice in
  // this section already takes its mark first.
  const seenBeforeBirth = plugin.seen().length;
  const failed = await registry
    .create({ agent: "kimi", cwd: tmp("hooks-cwd-") })
    .then(() => null, (error: unknown) => error);
  report("a session whose agent will not start still threw", failed !== null, String(failed).slice(0, 48));
  await settle(() => plugin.seen().length);
  const born = registry.list().map((one) => one.id).filter((id) => id !== "s_restored");
  check("but the session exists, and there is one of it", born.length, 1);
  check(
    "the plugin was told it appeared, and then that it was over",
    plugin.seen().slice(seenBeforeBirth).map((one) => [one.hook, one.session === born[0]]),
    [
      ["session.created", true],
      ["session.ended", true],
    ],
  );

  /*
   * ⚠ **The echo of a plugin's own write is not sent back to it**, which is what
   * keeps `ctx.sessions.create` inside a `session.created` handler from making
   * sessions until `MAX_LIVE_SESSIONS` — each one a worktree and an agent
   * process. `src/agentask.ts`'s header records the same recursion against a
   * session nobody can address; this is the one a plugin is handed on purpose.
   *
   * Driven through `registry.create`'s own `origin` rather than through the API,
   * because that argument *is* the mechanism: the announcement happens inside
   * `create`, so there is no moment afterwards at which anything could stamp it.
   */
  const before = plugin.seen().length;
  await registry
    .create({ agent: "kimi", cwd: tmp("hooks-own-"), origin: "watcher" })
    .then(() => null, () => null);
  await settle(() => plugin.seen().length);
  const echoed = plugin.seen().slice(before).map((one) => one.hook);
  check("a plugin is not told about the session it asked for itself", echoed.includes("session.created"), false);
  /*
   * ⚠ **And `session.ended` still arrives, which is a named non-goal rather than
   * an oversight.** A create whose `start()` throws is an exit, so the plugin
   * that asked is told its own session ended — and a handler answering *that* by
   * creating another still loops. `MAX_LIVE_SESSIONS` does not bound it, because
   * `liveSessionCount` skips terminal sessions; what is left is
   * `SESSION_CREATE_BURST` and a worktree left behind each time round. Closing it
   * needs a per-plugin create budget. Asserted so the gap is written down as
   * behaviour rather than left to be rediscovered.
   */
  check("but it is still told that session ended, which the loop above does not close", echoed, ["session.ended"]);

  /* ---------------------------------------------------------------- *
   * The three hooks derived from the log.
   *
   * ⚠ **Derived, never forwarded.** A plugin is told `turn.ended`, not a
   * `StoredEvent` — the event union is the wire three agents move, and coupling a
   * plugin to it would make every ACP change somebody else's breaking change.
   * Appending straight to the log is therefore the honest way to drive these: it
   * is exactly what the pump does, and what crosses to the plugin is a summary
   * this daemon built rather than the row that produced it.
   * ---------------------------------------------------------------- */
  const restored = registry.get("s_restored");
  if (restored === undefined) throw new Error("the restored session vanished");
  const fromLog = plugin.seen().length;
  restored.log.append({ type: "turn_end", stopReason: "end_turn", usage: null });
  restored.log.append({
    type: "permission_request",
    permissionId: "perm_1",
    toolCallId: null,
    title: "Run the tests?",
    options: [],
    decision: null,
  });
  restored.log.append({
    type: "permission_resolved",
    permissionId: "perm_1",
    toolCallId: null,
    title: "Run the tests?",
    outcome: "selected",
    optionId: "allow",
    by: "client",
  });
  await settle(() => plugin.seen().length);
  check(
    "a turn ending, a question asked and the same question answered",
    plugin.seen().slice(fromLog).map((one) => one.hook),
    ["turn.ended", "permission.requested", "permission.resolved"],
  );

  /* ---------------------------------------------------------------- *
   * A throwing subscriber is reported and **kept**.
   *
   * ⚠ This is the opposite of what `SessionLog.append` does to a listener that
   * throws, and the difference is the whole reason the guard exists. There a
   * listener is one WebSocket and evicting it costs that socket its events; here
   * it is every plugin hook for this session, its unsubscribe is recorded in
   * `watching`, and `observe` reads that map as "already handled" — so one throw
   * out of `managed.snapshot()` ended hooks for that session **for the life of the
   * daemon**, with nothing anywhere saying so and no path back short of a
   * restart. The second append is the half that matters: a report with the
   * subscription gone would look identical in the warnings.
   * ---------------------------------------------------------------- */
  const realSnapshot = restored.snapshot.bind(restored);
  (restored as unknown as { snapshot: () => unknown }).snapshot = () => {
    throw new Error("a snapshot this driver broke");
  };
  const beforeThrow = warnings.length;
  const seenBeforeThrow = plugin.seen().length;
  restored.log.append({ type: "turn_end", stopReason: "end_turn", usage: null });
  await settle(() => warnings.length);
  report(
    "a hook payload that throws is reported",
    warnings.slice(beforeThrow).some((one) => one.includes("a snapshot this driver broke")),
    warnings.at(-1) ?? "nothing reported",
  );
  check("and nothing was delivered for it", plugin.seen().length, seenBeforeThrow);
  (restored as unknown as { snapshot: () => unknown }).snapshot = realSnapshot;
  restored.log.append({ type: "turn_end", stopReason: "end_turn", usage: null });
  await settle(() => plugin.seen().length);
  check(
    "but the next one still arrives, which is the whole property",
    plugin.seen().slice(seenBeforeThrow).map((one) => one.hook),
    ["turn.ended"],
  );

  /* ---------------------------------------------------------------- *
   * What a plugin that has stopped answering misses.
   *
   * Drop-**oldest**, because the newest events are the ones still worth acting
   * on: a board catching up cares about the turn that just ended and not about
   * the one from an hour ago. The count is what keeps that honest — it goes to
   * `onWarning` rather than being swallowed, since a plugin quietly missing half
   * its events looks exactly like a plugin with a bug in it.
   *
   * `deliver` is called directly rather than through a session, because what is
   * being driven is the queue and three hundred real turns would be three hundred
   * fixtures for one bound.
   * ---------------------------------------------------------------- */
  const live = host.find("watcher");
  if (live === null) throw new Error("the plugin vanished");
  plugin.hold();
  const beforeFlood = plugin.seen().length;
  const warnedBeforeFlood = warnings.length;
  for (let mark = 1; mark <= 300; mark += 1) live.deliver("turn.ended", { hook: "turn.ended", mark });
  report(
    "a plugin falling behind is said out loud",
    warnings
      .slice(warnedBeforeFlood)
      .some((one) => one.includes("is behind") && one.includes("hook deliveries dropped")),
    warnings.at(-1) ?? "nothing reported",
  );
  plugin.release();
  await settle(() => plugin.seen().length);
  const delivered = plugin.seen().slice(beforeFlood).map((one) => one.mark);
  // The first was taken by `drain` before the queue could hold anything, so it is
  // in flight rather than queued and no bound can reach it.
  check("the one already in flight was delivered", delivered[0], 1);
  const queued = delivered.slice(1);
  report(
    "and what survived is a contiguous run ending at the newest",
    queued.length > 0 &&
      queued.length < 299 &&
      queued.at(-1) === 300 &&
      queued.every((mark, index) => mark === (queued[0] ?? 0) + index),
    `${delivered.length} of 300 delivered, ${String(queued[0])}…${String(queued.at(-1))}`,
  );

  /* ---------------------------------------------------------------- *
   * Two invocations arriving together join one launch.
   *
   * `this.starting ??=` written out longhand, because the passive gate has to sit
   * between the join and the launch: joining a start somebody else is paying for
   * is free and starting one is not. Without the memo the second caller loses to a
   * half-started child and spends a second of the three `MAX_PLUGIN_STARTS`
   * allows, which is a budget only `machine:admin` can give back.
   * ---------------------------------------------------------------- */
  await live.stop();
  const launchedBefore = plugin.launches();
  const together = await Promise.all([
    live.invoke("hook", "turn.ended", { hook: "turn.ended" }).then(() => "answered", () => "refused"),
    live.invoke("hook", "turn.ended", { hook: "turn.ended" }).then(() => "answered", () => "refused"),
  ]);
  check("both are answered", together, ["answered", "answered"]);
  report(
    "and one launch served both",
    plugin.launches() - launchedBefore === 1,
    `${plugin.launches() - launchedBefore} launches for 2 invocations`,
  );

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}
