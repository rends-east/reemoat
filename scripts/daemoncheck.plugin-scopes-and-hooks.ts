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

  // `id` is a parameter: the fetch window is keyed on it and never given back, so a later section needing a real fetch uses a fresh id.
  const manifestWith = (scopes: string[], net: string[] = [], id = "p"): PluginManifest => {
    // Contribution blocks ride their scopes, as `net`'s host list rides `net`, and any contribution needs api 5.
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
  let answers: () => Response = () => new Response("hi", { status: 200 });

  const api = new PluginApi({
    registry: new SessionRegistry(),
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

  // One manifest swept over every method, so a method added without a `SCOPE_OF` entry is caught here.
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
    // Refused on a daemon with no asker wired: the scope gate runs ahead of the availability check.
    ["model.complete", { agent: "claude", prompt: "hi" }],
    ["model.list", { agent: "claude" }],
  ];
  const denied: string[] = [];
  for (const [method, args] of METHODS) {
    if ((await codeOf(nothing, method, args)) !== "plugin_scope_denied") denied.push(method);
  }
  check("every method needs a scope, and a plugin with none reaches nothing", denied, []);
  // No scope is inert: each one gates a method or is refused when its own contribution block is missing.
  const inert: string[] = [];
  for (const scope of PLUGIN_SCOPES) {
    const only = manifestWith([scope], scope === "net" ? ["api.example.com"] : []);
    let gatesCall = false;
    for (const [method, args] of METHODS) {
      // Probed at an unlisted host: the allowlist runs after the gate, and a listed host would record a real request.
      const probe = method === "net.fetch" ? { url: "https://nowhere.invalid/" } : args;
      if ((await codeOf(only, method, probe)) !== "plugin_scope_denied") {
        gatesCall = true;
        break;
      }
    }
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
  // The table mirrors the module-private `SCOPE_OF` by hand, so a new scoped method needs a row here and this count moved.
  check("and the sweep is the whole of that table", METHODS.length, 23);

  // The plugin-side context must expose every method and ask the host for the one it is named for; host-side checks cannot see that half.
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
      // Three empty objects: every builder ignores or spreads its arguments, so this reaches the call whatever its signature.
      void (fn as (...args: unknown[]) => unknown)({}, {}, {});
      if (asked[before] !== method) misnamed.push(`${method} asked for ${asked[before] ?? "nothing"}`);
    }
    check("every method a plugin may call is one it can reach", unreachable, []);
    check("and each one asks the host for the method it is named for", misnamed, []);
    check("and logging is reachable too, though it is behind no scope", typeof ctx["log"], "function");
    check("nothing was asked for that the table does not hold", asked.length, METHODS.length);
  }

  check("a method that does not exist", await codeOf(manifestWith(["store"]), "sessions.destroy"), "unknown_method");
  check("logging needs nothing", await codeOf(nothing, "log", { message: "hello" }), "ok");
  report("and it reaches the warning sink", warned.some((one) => one.includes("hello")), `${warned.length} warnings`);

  const before = warned.length;
  await codeOf(nothing, "store.get", { key: "k" });
  report("a refused scope is reported as well as refused", warned.length > before, warned[warned.length - 1] ?? "");

  const stored = manifestWith(["store"]);
  check("with the scope it works", await codeOf(stored, "store.set", { key: "k", value: { a: 1 } }), "ok");
  check("and reads back parsed rather than as text", await api.call(stored, "store.get", { key: "k" }), { a: 1 });
  check("a key that was never written", await api.call(stored, "store.get", { key: "nope" }), null);
  check("and a prefix listing is a prefix listing", await api.call(stored, "store.keys", { prefix: "k" }), ["k"]);

  const netted = manifestWith(["net"], ["api.example.com"]);
  check("a host the manifest lists", await codeOf(netted, "net.fetch", { url: "https://api.example.com/x" }), "ok");
  check("and it really went there", reached, ["https://api.example.com/x"]);
  check("a host it does not list", await codeOf(netted, "net.fetch", { url: "https://elsewhere.example/" }), "host_not_allowed");
  check("http rather than https", await codeOf(netted, "net.fetch", { url: "http://api.example.com/" }), "insecure_url");
  check("something that is not a URL", await codeOf(netted, "net.fetch", { url: "api.example.com" }), "invalid_url");
  check("and nothing refused was ever requested", reached, ["https://api.example.com/x"]);

  const spray: string[] = [];
  for (let i = 0; i < 40; i += 1) spray.push(await codeOf(netted, "net.fetch", { url: "https://api.example.com/" }));
  report(
    "a plugin cannot poll a host as fast as it likes",
    spray.includes("fetch_rate_limited"),
    `${spray.filter((one) => one === "ok").length} of ${spray.length} allowed`,
  );

  // `safeRelPath` refuses a typed `.git`; only the `probeRequestable` re-test refuses one reached through a symlink.
  {
    const tree = join(homedir(), ".reemoat-check-files");
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(join(tree, "sub"), { recursive: true });
    mkdirSync(join(tree, ".git"), { recursive: true });
    writeFileSync(join(tree, "notes.txt"), "hello\n");
    writeFileSync(join(tree, ".git", "config"), "[core]\n");
    writeFileSync(join(tree, "fat.bin"), "z".repeat(64 * 1024 + 1));
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
    check("nor .git reached through a link", await reads("g/config"), "invalid_path");
    check("a directory is not a file", await reads("sub"), "not_a_file");
    check("and a file past the ceiling is refused rather than truncated", await reads("fat.bin"), "file_too_large");
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

  // A declared `content-length` is refused before a byte is read, an undeclared body while it is still arriving.
  {
    const fresh = manifestWith(["net"], ["late.example.com"], "late");
    answers = () =>
      new Response("x", { status: 200, headers: { "content-length": String(8 * 1024 * 1024) } });
    check(
      "a response that declares more than a plugin may read",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/a" }),
      "response_too_large",
    );

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
    report("refused while it was still arriving", pulls > 0 && pulls < 64, `${pulls} chunks read`);

    // `highWaterMark: 0`: the default strategy pulls once at construction, before any reader, which would break the zero-pull assertion.
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

    // The fetch bound must fit the IPC channel once JSON-escaped; an all-quote body is the worst realistic escape.
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

    // A string body sets no `content-length`, so one byte over reaches `readBounded` rather than the header check.
    answers = () => new Response("a".repeat(MAX_PLUGIN_FETCH_BYTES + 1), { status: 200 });
    check(
      "and one byte more than that is refused",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/e" }),
      "response_too_large",
    );

    // Control bytes escape to six characters, so a body inside the read bound can still overflow the channel and is refused here.
    answers = () =>
      new Response(String.fromCharCode(1).repeat(MAX_PLUGIN_FETCH_BYTES), { status: 200 });
    check(
      "a body inside the bound that could not be delivered is refused here, not at the channel",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/f" }),
      "response_too_large",
    );

    answers = () => new Response("hi", { status: 200 });
  }

  // `agents.list` sits behind `sessions.read`: it is what a plugin needs before `sessions.create`.
  report(
    "asking what this machine could run needs only sessions.read",
    Array.isArray(await api.call(manifestWith(["sessions.read"]), "agents.list", {})),
    "an array of availability rows",
  );

  check("a session this machine does not have", await codeOf(manifestWith(["sessions.read"]), "sessions.get", { id: "s_nope" }), "session_not_found");
  check("and an argument that is not a string", await codeOf(manifestWith(["sessions.read"]), "sessions.get", { id: 7 }), "bad_request");

  // Each method is probed with each scope missing in turn; empty arguments make the probes that pass the gate fail on validation rather than act.
  const scopeNeededBy = async (method: string): Promise<string> => {
    const refused: string[] = [];
    for (const missing of PLUGIN_SCOPES) {
      const held = PLUGIN_SCOPES.filter((one) => one !== missing);
      const manifest = manifestWith([...held], held.includes("net") ? ["api.example.com"] : []);
      if ((await codeOf(manifest, method, {})) === "plugin_scope_denied") refused.push(missing);
    }
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
    ["agents.list", "sessions.read"],
    ["files.read", "files.read"],
    ["store.get", "store"],
    ["store.set", "store"],
    ["store.delete", "store"],
    ["store.keys", "store"],
    ["store.entries", "store"],
    ["net.fetch", "net"],
    ["model.complete", "model"],
    // Not `sessions.read`: reading an agent's model list spawns that agent.
    ["model.list", "model"],
  ]);
}

process.stdout.write("\nasking an agent one question, and every way that is refused\n");
{
  const { AgentAskRuns, AgentAskError, MAX_ASK_PROMPT_BYTES, MAX_CONCURRENT_ASKS } = await import(
    "../src/agentask.js"
  );

  // Answers availability only and `launch` throws, so any case that got past the gate fails loudly.
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

  // `loggedIn: null` must be attempted, not refused (Q7.99): `model_failed` from the throwing `launch` proves it passed the gate.
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

  // The cap counts starts as well as live turns: `inFlight` includes `starting`, which is the expensive part.
  const slow = new AgentAskRuns({
    runtime: {
      availability: () => Promise.resolve([{ id: "claude", displayName: "claude", available: true, hint: null, loggedIn: true, lastStartRefusal: null }]),
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

  // The capability sweep queues for a slot while an ask is refused one: `model_busy` is reportable, a parked ask would hang.
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

    const third = stuck
      .capabilities("codex" as never, undefined, true)
      .then(() => "answered")
      .catch((error: unknown) => (error instanceof AgentAskError ? error.code : "other"));
    const settled = await Promise.race([
      third,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 40)),
    ]);
    check("a third one waits for a slot rather than being told the machine is busy", settled, "still waiting");

    check("while an ask on the same full machine is refused at once", await codeOfAsk(stuck, "opencode"), "model_busy");
    // The queue is opt-in per call: a plugin's `model.list` is refused like an ask, since `MAX_CONCURRENT_ASKS` is a published bound.
    const listed = await stuck
      .models("opencode" as never)
      .then(() => "answered")
      .catch((error: unknown) => (error instanceof AgentAskError ? error.code : "other"));
    check("and a plugin's model list is refused rather than parked", listed, "model_busy");

    // A shutdown wakes queued callers synchronously; not awaited, because these starts never resolve.
    const closingCaps = stuck.shutdown();
    check("and a shutdown wakes what was waiting, with a reason", await third, "model_unavailable");
    void held;
    void closingCaps;
  }

  // Shutdown waits for asks still inside `Session.start`, or they would spawn after the drain and outlive the process.
  const closing = slow.shutdown();
  check("an ask arriving during shutdown is refused rather than started", await codeOfAsk(slow, "claude"), "model_unavailable");
  void parked;
  void closing;

}

process.stdout.write("\nwhich model a one-shot ask runs on\n");
{
  // The daemon holds no model list: models are read off the agent's `session/new`, through a real `Session` over pipes.
  const acp = await import("@agentclientprotocol/sdk");
  const { LocalRuntime } = await import("../src/runtime/local.js");
  const { PassThrough } = await import("node:stream");
  const { AgentAskRuns, AgentAskError, ASK_TIMEOUT_MS, MAX_ASK_OUTPUT_BYTES, MAX_ASK_PROMPT_BYTES, MAX_CONCURRENT_ASKS, MODELS_TTL_MS } =
    await import("../src/agentask.js");
  const { PLUGIN_INVOKE_TIMEOUT_MS } = await import("../src/plugins/runtime.js");

  /** Every `session/set_config_option` the daemon sent, as it sent it. */
  const configured: { configId: string; value: unknown }[] = [];
  let opened = 0;
  /** The capability cache is keyed on this, so moving it drives a CLI update without a CLI. */
  let stubVersion = "0.0.0";
  /** What `agentCli` waits on; settled except where a cache hit must straddle a `forget`. */
  let cliGate: Promise<void> = Promise.resolve();
  let models = [
    { value: "opus", name: "Opus 5", description: "the big one" },
    { value: "haiku", name: "Haiku 4.5", description: null },
  ];

  // Fresh pipes per launch: `dispose` ends the agent's stdin, so a shared pair works only once.
  // Opt-in: only a prompt that never answers can be raced by a caller walking away.
  let hangPrompt = false;
  // The output ceiling is charged as chunks arrive, so the answer is streamed in chunks.
  let sayBack: string[] = [];
  const speak = (): { toAgent: PassThrough; toClient: PassThrough } => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): boolean => toClient.write(`${JSON.stringify(message)}\n`);
    /** A cancelled prompt is answered, as a real agent does, or every hanging case waits out the cancel grace. */
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
            // The model option is not first: controls are found by `category`, never by id or position.
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
            // `session/cancel` is a notification with no id to answer; it ends the held turn.
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

  class ModelPipes extends LocalRuntime {
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    // A fixed CLI answer keeps the read hermetic; a fresh object per call makes the cache compare fields (`sameCli`).
    override async agentCli(): Promise<any> {
      await cliGate;
      return { path: "/stub/claude", version: stubVersion, source: "path" };
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

  // Cached because an answer costs a spawn and a handshake; the spawn count is the negative control.
  const again = await runs.models("claude" as never);
  check("asking again spawns nothing", opened, 1);
  check("and answers the same thing", again.length, listed.length);
  report("the cache is a ceiling on staleness rather than for ever", MODELS_TTL_MS > 0, `${MODELS_TTL_MS}ms`);

  // `model-picker` is not `model`: a build sending the category as the id would look right and be refused by every agent.
  await runs.ask("claude" as never, "hi", "haiku");
  check("a chosen model is sent as the option the agent named", configured, [{ configId: "model-picker", value: "haiku" }]);

  // Left out, empty and whitespace all mean the agent's own default, swept rather than sampled.
  configured.length = 0;
  const spellings: [string, string | undefined][] = [
    ["left out", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ];
  const refused: string[] = [];
  for (const [name, model] of spellings) {
    await runs.ask("claude" as never, "hi", model).catch((error: unknown) => refused.push(`${name}: ${String(error)}`));
  }
  check("no model chosen, in any of its spellings, is refused", refused, []);
  check("and none of them sets anything", configured, []);

  // null arrives only through a plugin's model.complete, where JSON spells an absent field that way too.
  {
    const { PluginApi } = await import("../src/plugins/api.js");
    const { parseManifest } = await import("../src/plugins/manifest.js");
    const { hostGit } = await import("../src/git.js");
    const parsed = parseManifest(JSON.stringify({ id: "asker", name: "Asker", version: "1.0.0", api: 1, scopes: ["model"] }));
    if (!parsed.ok) throw new Error(parsed.message);
    const plugin = new PluginApi({ registry: new SessionRegistry(), data: memoryPluginData(), git: hostGit, ask: runs });
    const sent: [string, Record<string, unknown>][] = [
      ["left out", {}],
      ["null", { model: null }],
      ["empty", { model: "" }],
      ["whitespace", { model: "   " }],
    ];
    const refusedByPlugin: string[] = [];
    for (const [name, spelled] of sent) {
      await plugin
        .call(parsed.manifest, "model.complete", { agent: "claude", prompt: "hi", ...spelled })
        .catch((error: unknown) => refusedByPlugin.push(`${name}: ${String(error)}`));
    }
    check("nor is one sent by a plugin, null included", refusedByPlugin, []);
    check("and none of those sets anything either", configured, []);
  }

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
  report("and says what it does offer", (await messageOf("gpt-9")).includes("opus"), await messageOf("gpt-9"));
  check("and nothing was sent for the one it refused", configured, []);

  // Validated against the live agent, never the cache: a CLI update can retire a model inside `MODELS_TTL_MS`.
  models = [{ value: "opus", name: "Opus 5", description: "the big one" }];
  const stale = await runs.models("claude" as never);
  check("the cache still believes the retired model exists", stale.map((one) => one.id), ["opus", "haiku"]);
  check("but using it is refused against what the agent says now", await codeOfAsk("haiku"), "model_unknown");

  // A cache hit weighs the CLI build its list came from against the runtime's, so a new build is a fresh read (Q6.112).
  models = [
    { value: "opus", name: "Opus 5", description: "the big one" },
    { value: "opus-next", name: "Opus 6", description: "the new one" },
  ];
  stubVersion = "0.0.1";
  const beforeMove = opened;
  const moved = await runs.models("claude" as never);
  check(
    "a CLI that moved under the cache is asked again, inside MODELS_TTL_MS",
    [opened - beforeMove, moved.map((one) => one.id)],
    [1, ["opus", "opus-next"]],
  );
  await runs.models("claude" as never);
  check("and the new build's answer is held in its turn", opened - beforeMove, 1);

  // A hit re-checks its entry after awaiting the runtime, so a `forget` landing inside it costs a read; forgetting another harness must not.
  const straddle = async (forgetting: () => void): Promise<number> => {
    let releaseCli = (): void => {};
    cliGate = new Promise<void>((resolve) => {
      releaseCli = resolve;
    });
    const beforeForget = opened;
    const across = runs.models("claude" as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    forgetting();
    cliGate = Promise.resolve();
    releaseCli();
    await across;
    return opened - beforeForget;
  };
  check("a cached list read across a forget is not served after it", await straddle(() => runs.forget()), 1);
  check("nor across a forget of this harness alone", await straddle(() => runs.forget("claude" as never)), 1);
  check("while a forget of another harness leaves this one's list standing", await straddle(() => runs.forget("codex" as never)), 0);

  // The output ceiling refuses rather than clips, and is met part way through a stream of small chunks.
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

  // Asserted as a pair over one window: a caller-set deadline fires and the default one must not be driver-sized.
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

  // `docs/PLUGINS.md` is the only place these bounds reach an author, so its sentences are held to the constants; wrapping is folded out first.
  const authors = readFileSync(new URL("../docs/PLUGINS.md", import.meta.url), "utf8").replace(/\n>?[ \t]*/g, " ");
  const published: [string, string][] = [
    ["what one ask may carry", `${MAX_ASK_PROMPT_BYTES / 1024} KiB of prompt, ${MAX_ASK_OUTPUT_BYTES / 1024} KiB back, ${ASK_TIMEOUT_MS / 1_000} s`],
    ["how many at once", `and ${MAX_CONCURRENT_ASKS} at a time for the whole machine`],
    // An invocation's deadline against an ask's: the gap that makes awaiting a model call inside a hook stop the plugin.
    ["the gap between an invocation and an ask", `**${PLUGIN_INVOKE_TIMEOUT_MS / 1_000} seconds** to answer against this call's **${ASK_TIMEOUT_MS / 1_000}**`],
  ];
  for (const [name, sentence] of published) {
    report(`what PLUGINS.md says about ${name} is what this daemon does`, authors.includes(sentence), sentence);
  }

  // A caller walking away must end the turn (`LivePlugin.hostCallsAbort`); the half-second deadline tells `model_cancelled` from `model_timeout`.
  const leaving = new AgentAskRuns({ runtime: new ModelPipes() as never, cwd: process.cwd(), timeoutMs: 500 });
  hangPrompt = true;
  const walkAway = new AbortController();
  const asked = leaving.ask("claude" as never, "hi", undefined, walkAway.signal);
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
  check("and the agent it started is let go of", leaving.inFlight, 0);
  hangPrompt = false;
  await leaving.shutdown();

  // codex takes ~2s to exit after a capability read has its answer; the slot is the process, so it is held until then.
  {
    let exit = (): void => {};
    class SlowExit extends ModelPipes {
      override async launch(): Promise<any> {
        const child = await super.launch();
        const exited = new Promise<void>((resolve) => {
          exit = resolve;
        });
        return {
          ...child,
          waitForExit: async () => {
            await exited;
            return true;
          },
        };
      }
    }
    const pause = (ms: number): Promise<string> => new Promise((resolve) => setTimeout(() => resolve("still waiting"), ms));
    const lingering = new AgentAskRuns({ runtime: new SlowExit() as never, cwd: process.cwd() });

    await lingering.capabilities("claude" as never);
    await pause(50);
    check("a capability read answers while its agent is still exiting, which still holds a slot", lingering.inFlight, 1);
    exit();
    await pause(50);
    check("and gives it back once the agent has exited", lingering.inFlight, 0);

    lingering.forget();
    await lingering.capabilities("claude" as never);
    const drained = lingering.shutdown().then(() => "drained");
    check("a shutdown waits for an agent still exiting rather than finding nothing to stop", await Promise.race([drained, pause(100)]), "still waiting");
    exit();
    check("until it has exited", await drained, "drained");
  }

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
    // Only supervised starts are charged: a read-scoped `view` re-read on a timer must not spend the budget (`StartIntent`).
    const launchedBefore = broken.launches();
    const codes: string[] = [];
    for (let i = 0; i < 5; i += 1) codes.push(await codeOf(plugin.invoke("view", "settings", {})));
    check("five read-only views against a broken plugin start nothing", broken.launches(), launchedBefore);
    check("and every attempt still answers rather than hanging", new Set(codes).has("plugin_unavailable"), true);
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

  /** Holds answers until released: `drain` is sequential, so holding the first parks it while the queue grows toward `MAX_HOOK_QUEUE`. */
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

  const settle = async (of: () => number): Promise<void> => {
    let last = -1;
    for (let round = 0; round < 400 && last !== of(); round += 1) {
      last = of();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  // `launch` throws on purpose: `create` announces before it starts, so this yields the real announcement and a real `session.ended`.
  class NoAgent extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<never> {
      throw new Error("this driver has no agent to start");
    }
  }

  const root = tmp("hooks-");
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
  check(
    "and it is offered the session that was already here",
    plugin.seen().map((one) => [one.kind, one.hook, one.session]),
    [["hook", "session.created", "s_restored"]],
  );

  // An update seeds again, as every freshly started child is offered what is already here; once-only work is the plugin's job.
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

  // A plugin's own create is not echoed back (the `origin` argument), or a `session.created` handler could create sessions without bound.
  const before = plugin.seen().length;
  await registry
    .create({ agent: "kimi", cwd: tmp("hooks-own-"), origin: "watcher" })
    .then(() => null, () => null);
  await settle(() => plugin.seen().length);
  const echoed = plugin.seen().slice(before).map((one) => one.hook);
  check("a plugin is not told about the session it asked for itself", echoed.includes("session.created"), false);
  // Its `session.ended` still arrives, a known gap: a handler creating on it still loops, bounded only by `SESSION_CREATE_BURST`.
  check("but it is still told that session ended, which the loop above does not close", echoed, ["session.ended"]);

  // Hooks are summaries derived from the log, never forwarded `StoredEvent`s, so appending to the log is the honest driver.
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

  // A throwing subscriber is reported and kept: `observe` treats a recorded subscription as handled, so evicting it would end hooks for good.
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

  // The hook queue drops the oldest and reports the count; `deliver` is called directly to drive the bound.
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
  // The first was taken by `drain` before anything queued, so no bound can reach it.
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

  // Concurrent invocations join one launch; without the memo the second would spend one of `MAX_PLUGIN_STARTS`.
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
