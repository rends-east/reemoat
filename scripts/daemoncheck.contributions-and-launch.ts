import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore } from "../src/events.js";
import type { SystemId } from "../src/acp/systems.js";
import { hostGit } from "../src/git.js";
import { SessionRegistry } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { openStores } from "../src/store/sqlite.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import { stubAgentConfig } from "./daemoncheck.fixtures.js";
import { tarOf, bodyOf } from "./daemoncheck.bodies.js";

process.stdout.write("\nwhat a plugin may add to a machine\n");
{
  const { parseManifest, isContributedId, contributedId, MAX_PLUGIN_HARNESSES, MAX_PLUGIN_SYSTEMS } = await import(
    "../src/plugins/manifest.js"
  );
  const { Contributions } = await import("../src/plugins/contributions.js");
  type Installed = Parameters<typeof Contributions.prototype.refresh>[0][number];
  const { hostable, routedModelNaming, systemSecretFor, BUILTIN_CATALOGUE, SYSTEM_IDS } = await import("../src/acp/systems.js");
  const { SESSION_SCOPED_ENV, AGENT_IDS, AGENT_LOGIN, resolveAgent } = await import("../src/acp/agents.js");
  const { PLUGIN_API_VERSION } = await import("../src/plugins/protocol.js");

  const withContributes = (contributes: unknown, scopes: string[] = ["harness", "system"]): ReturnType<typeof parseManifest> =>
    parseManifest(
      JSON.stringify({ id: "acme", name: "Acme", version: "1.0.0", api: PLUGIN_API_VERSION, scopes, contributes }),
    );
  const said = (contributes: unknown, scopes?: string[]): string => {
    const answer = withContributes(contributes, scopes);
    return answer.ok ? "ok" : answer.message;
  };

  const HARNESS = { id: "gemini", name: "Gemini", command: "gemini", args: ["acp"], envNames: ["GEMINI_API_KEY"] };
  const SYSTEM = {
    id: "groq",
    name: "Groq",
    apiType: "anthropic",
    baseUrl: "https://api.groq.com/anthropic",
    authHeader: { name: "authorization", prefix: "Bearer " },
    models: [{ id: "llama-4", name: "Llama 4" }],
  };
  const both = { harnesses: [HARNESS], systems: [SYSTEM] };

  check("a plugin that adds a harness and a provider", said(both), "ok");

  // The probe is detached and its outcome swallowed, so the occasions are asserted: install, update and enable probe; disable, remove and boot do not.
  {
    const { PluginHost } = await import("../src/plugins/host.js");
    const asked: string[] = [];
    const ask = {
      capabilities: (agent: string) => {
        asked.push(agent);
        return Promise.reject(new Error("gemini rejected session/new: authentication required."));
      },
    } as never;
    const PROBE_SERVER = "export async function settings() { return { title: null, blocks: [] }; }";
    const probeStores = openStores({ path: join(tmp("probe-db-"), "d.db"), instanceId: "i_probe" });
    const probeRegistry = {
      watchSessions: () => () => {},
      list: () => [],
      get: () => undefined,
      sessionRuntime: { forgetStartRefusal: () => {}, forgetAvailability: () => {} },
    } as unknown as SessionRegistry;
    const probeRoot = join(tmp("probe-root-"), "plugins");
    const probeHost = await PluginHost.open({
      root: probeRoot,
      records: probeStores.plugins,
      data: probeStores.pluginData,
      registry: probeRegistry,
      api: { git: hostGit, ask },
      timeouts: { start: 3_000, invoke: 3_000 },
    });
    const manifest = JSON.stringify({
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      api: PLUGIN_API_VERSION,
      scopes: ["harness"],
      contributes: { harnesses: [HARNESS] },
    });
    // The capability read is fired and not awaited, so a tick has to pass before the array holds anything.
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    const put = async (version: string): Promise<void> => {
      await probeHost.install({
        body: bodyOf(tarOf({ "plugin.json": manifest.replace("1.0.0", version), "server.js": PROBE_SERVER })),
        name: "p.tar.gz",
      });
      await settle();
    };

    await put("1.0.0");
    check("installing a plugin asks its harness whether it starts", asked, ["acme:gemini"]);

    asked.length = 0;
    await put("1.1.0");
    check("and so does updating it, since the program may be a different one", asked, ["acme:gemini"]);

    asked.length = 0;
    await probeHost.setEnabled("acme", false);
    await settle();
    check("switching it off asks nothing, there being nothing to start", asked, []);

    await probeHost.setEnabled("acme", true);
    await settle();
    check("and switching it on asks again", asked, ["acme:gemini"]);

    asked.length = 0;
    await probeHost.remove("acme");
    await settle();
    check("removing it asks nothing", asked, []);

    // Boot does not probe: that would put a spawn per contributed harness in front of the resume pass.
    await put("1.2.0");
    asked.length = 0;
    await probeHost.shutdown();
    const rebooted = await PluginHost.open({
      root: probeRoot,
      records: probeStores.plugins,
      data: probeStores.pluginData,
      registry: probeRegistry,
      api: { git: hostGit, ask },
      timeouts: { start: 3_000, invoke: 3_000 },
    });
    await settle();
    check("and a daemon coming up asks nothing either", asked, []);
    await rebooted.shutdown();
  }

  // Reinstalling on a machine at the ceiling must not count the incumbent's own contributions; the update case below pins that skip.
  {
    const { PluginHost, MAX_CONTRIBUTED_HARNESSES } = await import("../src/plugins/host.js");
    const CEIL_SERVER = "export async function settings() { return { title: null, blocks: [] }; }";
    const ceilStores = openStores({ path: join(tmp("ceiling-db-"), "d.db"), instanceId: "i_ceiling" });
    const ceilRegistry = {
      watchSessions: () => () => {},
      list: () => [],
      get: () => undefined,
      sessionRuntime: { forgetStartRefusal: () => {}, forgetAvailability: () => {} },
    } as unknown as SessionRegistry;
    // The real catalogue rather than a tally: PluginHost refreshes it after every install, update and remove.
    const ceilContributions = new Contributions([]);
    const contributedCount = (): number =>
      ceilContributions.harnessIds().filter((id) => isContributedId(id)).length;
    const ceilHost = await PluginHost.open({
      root: join(tmp("ceiling-root-"), "plugins"),
      records: ceilStores.plugins,
      data: ceilStores.pluginData,
      registry: ceilRegistry,
      contributions: ceilContributions,
      api: { git: hostGit, ask: { capabilities: () => Promise.resolve({}) } as never },
      timeouts: { start: 3_000, invoke: 3_000 },
    });

    const ceilManifest = (id: string, version: string, count: number): string =>
      JSON.stringify({
        id,
        name: id,
        version,
        api: PLUGIN_API_VERSION,
        scopes: ["harness"],
        contributes: {
          harnesses: Array.from({ length: count }, (_, n) => ({
            id: `h${n}`,
            name: `H${n}`,
            command: "gemini",
            args: ["acp"],
            envNames: [`GEMINI_${n}_API_KEY`],
          })),
        },
      });
    const ceilInstall = async (
      id: string,
      version: string,
      count: number,
    ): Promise<Awaited<ReturnType<typeof ceilHost.install>>> =>
      ceilHost.install({
        body: bodyOf(tarOf({ "plugin.json": ceilManifest(id, version, count), "server.js": CEIL_SERVER })),
        name: `${id}.tar.gz`,
      });
    const ceilCode = (outcome: Awaited<ReturnType<typeof ceilHost.install>>): string =>
      outcome.kind === "refused" ? outcome.code : outcome.kind;
    const ceilMessage = (outcome: Awaited<ReturnType<typeof ceilHost.install>>): string =>
      outcome.kind === "refused" ? outcome.message : `not refused: ${outcome.kind}`;

    // `MAX_PLUGIN_HARNESSES` is 2, so the machine ceiling of 8 is four plugins.
    const perPlugin = 2;
    const plugins = MAX_CONTRIBUTED_HARNESSES / perPlugin;
    for (let n = 0; n < plugins; n += 1) {
      check(
        `filling the machine to its ceiling, plugin ${n + 1} of ${plugins}`,
        ceilCode(await ceilInstall(`fill${n}`, "1.0.0", perPlugin)),
        "ok",
      );
    }

    check(
      "the machine is at its ceiling and not over it",
      contributedCount(),
      MAX_CONTRIBUTED_HARNESSES,
    );

    check(
      "one contribution past the ceiling is refused",
      ceilCode(await ceilInstall("over", "1.0.0", 1)),
      "plugin_too_many_contributions",
    );
    check(
      "and the refusal names the ceiling rather than blaming the plugin",
      ceilMessage(await ceilInstall("over", "1.0.0", 1)),
      `this machine already has ${MAX_CONTRIBUTED_HARNESSES} agents added by plugins, which is as many as it will run`,
    );
    check(
      "and nothing was installed for it",
      ceilStores.plugins.list().some((one) => one.id === "over"),
      false,
    );

    check(
      "updating a plugin on a machine already at the ceiling is not refused",
      ceilCode(await ceilInstall("fill0", "1.1.0", perPlugin)),
      "ok",
    );
    check(
      "and the update really replaced the row rather than adding one",
      ceilStores.plugins.list().find((one) => one.id === "fill0")?.version,
      "1.1.0",
    );
    check(
      "and the machine is still exactly at its ceiling afterwards",
      contributedCount(),
      MAX_CONTRIBUTED_HARNESSES,
    );

    await ceilHost.remove("fill0");
    check(
      "removing a plugin makes room under the ceiling",
      ceilCode(await ceilInstall("over", "1.0.0", perPlugin)),
      "ok",
    );
    await ceilHost.shutdown();
  }

  const atApi = (api: number): string => {
    const answer = parseManifest(
      JSON.stringify({ id: "acme", name: "Acme", version: "1.0.0", api, scopes: ["harness"], contributes: { harnesses: [HARNESS] } }),
    );
    return answer.ok ? "ok" : answer.message;
  };
  check("declared below the rung it needs", atApi(4).includes("need plugin API 5"), true);
  check("and at it", atApi(5), "ok");
  // The gate fires on a non-empty block only, keeping parseManifest idempotent: the record store re-validates on every read.
  check(
    "an empty block at an older rung is not a contribution",
    (() => {
      const answer = parseManifest(
        JSON.stringify({ id: "acme", name: "Acme", version: "1.0.0", api: 1, scopes: [], contributes: { harnesses: [], systems: [] } }),
      );
      return answer.ok;
    })(),
    true,
  );

  check("a scope with nothing under it", said({ systems: [SYSTEM] }, ["harness", "system"]).includes("needs contributes.harnesses"), true);
  check("and a block with no scope", said({ harnesses: [HARNESS] }, []).includes('"harness" scope is not declared'), true);
  check("and `contributes` left out entirely, with a scope declared", said(undefined, ["harness"]).includes("needs contributes.harnesses"), true);

  const harnessSaid = (patch: Record<string, unknown>): string =>
    said({ harnesses: [{ ...HARNESS, ...patch }] }, ["harness"]);
  check("a command with a path in it", harnessSaid({ command: "/usr/bin/gemini" }).includes("program name"), true);
  check("a command with a capital in it", harnessSaid({ command: "Gemini" }).includes("program name"), true);
  // Naming a built-in's command would let a plugin drive the operator's signed-in CLI under the plugin's own name.
  check(
    "a command that is one of this machine's own agents",
    AGENT_IDS.map((id) => harnessSaid({ command: AGENT_LOGIN[id].command }).includes("already runs that program")),
    AGENT_IDS.map(() => true),
  );
  check("and `script`, which is what a login's pty is allocated with", harnessSaid({ command: "script" }).includes("already runs that program"), true);
  check("an argument that is not a string", harnessSaid({ args: [1] }).includes("not a string"), true);
  check("two harnesses with one id", said({ harnesses: [HARNESS, HARNESS] }, ["harness"]).includes("declared twice"), true);
  check(
    "more harnesses than one plugin may add",
    said({ harnesses: Array.from({ length: MAX_PLUGIN_HARNESSES + 1 }, (_, at) => ({ ...HARNESS, id: `h${at}` })) }, ["harness"]).includes(
      `at most ${MAX_PLUGIN_HARNESSES}`,
    ),
    true,
  );
  check(
    "more providers than one plugin may add",
    said({ systems: Array.from({ length: MAX_PLUGIN_SYSTEMS + 1 }, (_, at) => ({ ...SYSTEM, id: `s${at}` })) }, ["system"]).includes(
      `at most ${MAX_PLUGIN_SYSTEMS}`,
    ),
    true,
  );

  check("a variable name that is not one", harnessSaid({ envNames: ["gemini key"] }).includes("in capitals"), true);
  check("this daemon's own prefix", harnessSaid({ envNames: ["REEMOAT_TOKEN"] }).includes("belongs to this daemon"), true);
  // Swept, not sampled: LocalRuntime spreads the routed-model env last, so a claimed name would restore what agentEnv strips.
  check(
    "every session-scoped variable this daemon strips",
    SESSION_SCOPED_ENV.filter((name) => !harnessSaid({ envNames: [name] }).includes("another agent on this machine reads it")),
    [],
  );
  // envNames decides where a person is invited to paste a secret, so a built-in's credential name there is a phishing box.
  check(
    "and every credential slot a built-in reads",
    AGENT_IDS.flatMap((id) => AGENT_LOGIN[id].envNames).filter(
      (name) => !harnessSaid({ envNames: [name] }).includes("another agent on this machine reads it"),
    ),
    [],
  );
  check(
    "and the variable that names a built-in's binary",
    harnessSaid({ envNames: ["CLAUDE_CODE_EXECUTABLE"] }).includes("another agent on this machine reads it"),
    true,
  );
  check("routedModelEnv is held to the same rule", harnessSaid({ routedModelEnv: ["ANTHROPIC_API_KEY"] }).includes("another agent"), true);

  const systemSaid = (patch: Record<string, unknown>): string => said({ systems: [{ ...SYSTEM, ...patch }] }, ["system"]);
  check("a protocol this daemon cannot configure", systemSaid({ apiType: "vertex" }).includes('must be "anthropic" or "openai"'), true);
  // routingHeaders hands name and prefix plus secret straight to providers/set, so a CR or LF in either is header injection.
  check(
    "a header name with a newline in it",
    systemSaid({ authHeader: { name: "x-api-key\r\nx-forwarded-for", prefix: "" } }).includes("lower-case header name"),
    true,
  );
  check("a header prefix that is not one", systemSaid({ authHeader: { name: "authorization", prefix: "Bearer \n" } }).includes("short word"), true);
  check("a base URL that is not a URL", systemSaid({ baseUrl: "api.groq.com" }).includes("not a URL"), true);
  check("a base URL carrying a password", systemSaid({ baseUrl: "https://me:pw@api.groq.com/x" }).includes("user name or a password"), true);
  check("a base URL carrying a query", systemSaid({ baseUrl: "https://api.groq.com/x?k=1" }).includes("query or a fragment"), true);
  // Normalised on the way in, so what is stored and compared is the address a key is actually sent to.
  check(
    "and a base URL is stored resolved rather than as written",
    (() => {
      const answer = withContributes({ systems: [{ ...SYSTEM, baseUrl: "https://api.groq.com/a/../evil/" }] }, ["system"]);
      return answer.ok ? answer.manifest.contributes.systems[0]?.baseUrl : answer.message;
    })(),
    "https://api.groq.com/evil",
  );

  // http is allowed only to this machine and network, where a self-hosted model (Ollama, vLLM, LM Studio) lives.
  const httpTo = (host: string): boolean => systemSaid({ baseUrl: `http://${host}/v1` }) === "ok";
  check(
    "http to this machine and to this network",
    ["127.0.0.1:11434", "localhost:11434", "[::1]:8000", "10.0.0.5:8000", "172.16.3.4", "192.168.1.5:1234", "ollama.local", "box.internal"].map(httpTo),
    [true, true, true, true, true, true, true, true],
  );
  check(
    "and to nowhere else",
    ["api.groq.com", "172.32.0.1", "192.169.1.1", "8.8.8.8", "example.com", "localhost.evil.example"].map(httpTo),
    [false, false, false, false, false, false],
  );
  // URL canonicalises every IPv4 spelling before hostname is read; 010.0.0.1 is octal for 8.0.0.1, a public address.
  check(
    "an address written the long way round is classified by what it is, not by how it is spelled",
    ["0x7f.0.0.1", "2130706433", "127.1", "0177.0.0.1", "010.0.0.1"].map(httpTo),
    [true, true, true, true, false],
  );
  // Cloud instance metadata is refused under https too: it is never an inference endpoint.
  check(
    "an address that is never an inference endpoint, under either scheme",
    [
      systemSaid({ baseUrl: "http://169.254.169.254/latest" }).includes("metadata service"),
      systemSaid({ baseUrl: "https://169.254.169.254/latest" }).includes("metadata service"),
      systemSaid({ baseUrl: "https://[fd00:ec2::254]/latest" }).includes("metadata service"),
      // URL serialises the IPv4-mapped form as hex, so the dotted-quad arm never sees it.
      systemSaid({ baseUrl: "https://[::ffff:169.254.169.254]/latest" }).includes("metadata service"),
    ],
    [true, true, true, true],
  );
  // isPrivateHost is true for any .internal name, so metadata.google.internal needs its own name check.
  check(
    "and a metadata service named rather than numbered, which is how anybody would reach one",
    [
      systemSaid({ baseUrl: "http://metadata.google.internal/computeMetadata/v1" }).includes("metadata service"),
      systemSaid({ baseUrl: "https://metadata.google.internal/computeMetadata/v1" }).includes("metadata service"),
      systemSaid({ baseUrl: "http://metadata/computeMetadata/v1" }).includes("metadata service"),
    ],
    [true, true, true],
  );
  check("while a model on the same private zone still is", httpTo("llm.corp.internal"), true);
  // The reserved-program check covers the whole argv, or env claude walks past it.
  check(
    "a reserved program passed as an argument rather than named as the command",
    [
      harnessSaid({ command: "env", args: ["claude"] }).includes("as an argument"),
      harnessSaid({ command: "sh", args: ["-c", "exec claude"] }).includes("as an argument"),
      harnessSaid({ command: "sh", args: ["--agent=codex"] }).includes("as an argument"),
    ],
    [true, true, true],
  );
  check("while a flag that merely contains one is left alone", harnessSaid({ args: ["--profile", "codexish"] }), "ok");

  check(
    "a provider naming a harness this plugin does not add",
    said({ harnesses: [HARNESS], systems: [{ ...SYSTEM, nativeHarness: "claude" }] }).includes("not a harness this plugin adds"),
    true,
  );
  check(
    "and one naming its own",
    said({
      harnesses: [HARNESS],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [] }],
    }),
    "ok",
  );
  check(
    "a provider with no endpoint and no harness of its own",
    said({ systems: [{ ...SYSTEM, baseUrl: null, authHeader: null }] }, ["system"]).includes("needs a nativeHarness"),
    true,
  );
  check("a provider with an endpoint and no header", systemSaid({ authHeader: null }).includes("needs an authHeader"), true);
  check(
    "a routed provider naming no model",
    systemSaid({ models: [] }).includes("at least one model"),
    true,
  );
  check(
    "a keyEnv its own harness does not read",
    said({
      harnesses: [HARNESS],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [], keyEnv: "OTHER_KEY" }],
    }).includes("does not read"),
    true,
  );

  // Shape only, never membership: fromRow and readCustomAgent run at boot, where membership would drop sessions of a switched-off plugin.
  check(
    "what could be an id a plugin contributed",
    ["acme:gemini", "a:b", "acme-tools:gemini-cli"].map(isContributedId),
    [true, true, true],
  );
  check(
    "and what could not",
    ["claude", "", ":", "acme:", ":gemini", "acme:gemini:extra", "Acme:gemini", "acme:GEMINI"].map(isContributedId),
    [false, false, false, false, false, false, false, false],
  );
  check("a built-in id can never be mistaken for one", AGENT_IDS.filter(isContributedId), []);
  check("and the namespace is applied by this daemon rather than written by an author", contributedId("acme", "gemini"), "acme:gemini");

  const installed = (id: string, contributes: unknown, enabled = true): Installed => {
    // Scopes follow the blocks: each is a biconditional, so a scope with no block is refused before the thing under test.
    const holds = (contributes ?? {}) as Record<string, unknown>;
    const scopes = [
      ...(Array.isArray(holds["harnesses"]) && holds["harnesses"].length > 0 ? ["harness"] : []),
      ...(Array.isArray(holds["systems"]) && holds["systems"].length > 0 ? ["system"] : []),
    ];
    const answer = parseManifest(
      JSON.stringify({ id, name: id.toUpperCase(), version: "1.0.0", api: PLUGIN_API_VERSION, scopes, contributes }),
    );
    if (!answer.ok) throw new Error(`${id}: ${answer.message}`);
    return { id, version: "1.0.0", manifest: answer.manifest, enabled, installedAt: 1, updatedAt: 1, source: null };
  };

  const acme = installed("acme", both);
  const machine = new Contributions([acme]);

  check("a contributed harness is namespaced on the way out", machine.harness("acme:gemini")?.command ?? null, "gemini");
  check("and a local id on its own reaches nothing", machine.harness("gemini"), null);
  // Built-ins first and contributed after, never interleaved: pickers group by first appearance.
  check("the built-ins keep their order and the contributed follow", machine.systemIds().slice(0, SYSTEM_IDS.length), [...SYSTEM_IDS]);
  check("and the contributed are after them", machine.systemIds().slice(SYSTEM_IDS.length), ["acme:groq"]);
  check("harnesses the same way", machine.harnessIds(), [...AGENT_IDS, "acme:gemini"]);
  const two = new Contributions([installed("zeta", { systems: [{ ...SYSTEM, id: "z" }] }), installed("alpha", { systems: [{ ...SYSTEM, id: "a" }] })]);
  check("two plugins are ordered by their own ids, not by which arrived first", two.systemIds().slice(SYSTEM_IDS.length), ["alpha:a", "zeta:z"]);

  // Disabled and unknown are separate answers because they have opposite remedies.
  const off = new Contributions([installed("acme", both, false)]);
  check(
    "a plugin somebody switched off still owns its ids",
    [off.harnessState("acme:gemini"), off.systemState("acme:groq")],
    ["disabled", "disabled"],
  );
  check("and offers neither of them", [off.harness("acme:gemini"), off.system("acme:groq")], [null, null]);
  check("and does not list them", [off.harnessIds().length, off.systemIds().length], [AGENT_IDS.length, SYSTEM_IDS.length]);
  check(
    "while a plugin nobody has is a different answer entirely",
    [machine.harnessState("other:thing"), machine.systemState("other:thing")],
    ["unknown", "unknown"],
  );
  check("and a built-in is never either of those", [machine.harnessState("claude"), machine.systemState("anthropic")], ["enabled", "enabled"]);
  // Only a live plugin asked about its own id in the other table separates split harness and system sets from a merged one.
  check(
    "a live plugin's provider is not a harness it switched off, nor the other way round",
    [machine.harnessState("acme:groq"), machine.systemState("acme:gemini")],
    ["unknown", "unknown"],
  );

  const refusalOf = (id: string, cat: typeof machine): string => {
    try {
      resolveAgent(id, cat);
      return "ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  check("a harness whose plugin is switched off", refusalOf("acme:gemini", off).includes("switched off on this machine"), true);
  check("and one whose plugin is gone", refusalOf("acme:gemini", new Contributions([])).includes("no longer installed"), true);
  check("and neither of them mentions installing anything", [refusalOf("acme:gemini", off), refusalOf("acme:gemini", new Contributions([]))].filter((why) => /npm|PATH/.test(why)), []);

  const smartRouted = new Contributions([
    installed("acme", { harnesses: [{ ...HARNESS, routedModelEnv: ["GEMINI_MODEL"] }], systems: [SYSTEM] }),
  ]);
  const claudeRouting = { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] };
  const codexRouting = { providerId: "custom-gateway", supported: ["openai"] };
  const geminiRouting = { providerId: "g", supported: ["anthropic"] };
  const routings: Record<string, { providerId: string; supported: string[] } | null> = {
    claude: claudeRouting,
    codex: codexRouting,
    kimi: null,
    opencode: null,
  };

  // Native short-circuits before routing is consulted, which makes a contributed pair with no provider methods runnable.
  const native = new Contributions([
    installed("acme", {
      harnesses: [HARNESS],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [] }],
    }),
  ]);
  check("a contributed harness on its own contributed provider is native", hostable("acme:gemini", "acme:groq", null, native), null);
  check(
    "while nothing else can reach a provider with no endpoint",
    hostable("claude", "acme:groq", claudeRouting, native),
    "Groq can only be reached by the CLI it ships with.",
  );
  check("a contributed harness routed at a contributed provider it can speak to", hostable("acme:gemini", "acme:groq", geminiRouting, smartRouted), null);
  check("a built-in routed at a contributed provider it can speak to", hostable("claude", "acme:groq", claudeRouting, machine), null);
  // The sentence is asserted, not just non-null: which variable codex reads for a gateway model has never been measured.
  const openaiShaped = new Contributions([installed("acme", { systems: [{ ...SYSTEM, apiType: "openai" }] })]);
  check(
    "an openai-shaped provider paired with codex is refused on the pinning arm",
    hostable("codex", "acme:groq", codexRouting, openaiShaped),
    "This agent cannot be told which model to use on another system.",
  );
  check(
    "and on the protocol arm where the protocol is the thing that is wrong",
    hostable("codex", "acme:groq", codexRouting, machine),
    "This agent cannot run Groq models.",
  );
  const dumb = new Contributions([
    installed("acme", { harnesses: [{ ...HARNESS, id: "plain" }], systems: [SYSTEM] }),
  ]);
  check("a contributed harness with no model variable", hostable("acme:plain", "acme:groq", geminiRouting, dumb), "This agent cannot be told which model to use on another system.");
  const smart = new Contributions([
    installed("acme", { harnesses: [{ ...HARNESS, id: "plain", routedModelEnv: ["GEMINI_MODEL"] }], systems: [SYSTEM] }),
  ]);
  check("and one that named one", hostable("acme:plain", "acme:groq", geminiRouting, smart), null);
  check(
    "and what it names is set to the model, without a template language anywhere",
    routedModelNaming("acme:plain", smart)?.("llama-4") ?? null,
    { GEMINI_MODEL: "llama-4" },
  );
  check("a built-in's naming is untouched by any of this", routedModelNaming("claude", machine)?.("m") ?? null, {
    ANTHROPIC_MODEL: "m",
    ANTHROPIC_CUSTOM_MODEL_OPTION: "m",
  });
  check("a provider that is no longer here", hostable("claude", "acme:groq", claudeRouting, new Contributions([])), "This provider is no longer on this machine.");
  check("and one whose plugin is switched off", hostable("claude", "acme:groq", claudeRouting, off), "This provider comes from a plugin that is switched off on this machine.");
  check(
    "and every built-in pairing answers exactly what it did with no plugins at all",
    AGENT_IDS.flatMap((harness) =>
      SYSTEM_IDS.filter(
        (system) =>
          hostable(harness, system, routings[harness] ?? null, machine) !==
          hostable(harness, system, routings[harness] ?? null, BUILTIN_CATALOGUE),
      ).map((system) => `${harness}/${system}`),
    ),
    [],
  );

  const paired = new Contributions([
    installed("acme", {
      harnesses: [{ ...HARNESS, id: "gemini", envNames: ["GEMINI_API_KEY"] }],
      systems: [{ ...SYSTEM, baseUrl: null, authHeader: null, nativeHarness: "gemini", loginVia: "gemini", models: [], keyEnv: "GEMINI_API_KEY" }],
    }),
  ]);
  check(
    "a key saved on a contributed harness answers for its own provider",
    systemSecretFor(
      "acme:groq",
      null,
      (agent): Record<string, string> => (agent === "acme:gemini" ? { GEMINI_API_KEY: "sk-x" } : {}),
      paired,
    ),
    "sk-x",
  );
  check(
    "and a provider this machine does not offer has no key, borrowed or otherwise",
    systemSecretFor("acme:groq", null, () => ({ GEMINI_API_KEY: "sk-x" }), new Contributions([])),
    null,
  );

  // The delete route removes before it validates, so a key under a switched-off plugin's harness stays deletable; read off the source since the order is the property.
  {
    const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const del = /app\.delete\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
    check(
      "the route that clears a pasted credential does not depend on the harness still being offered",
      [
        del.length > 0,
        /const had = credentials\.list\(\)\.some/.test(del) && /credentials\.remove\(named, envName\);/.test(del),
        /removed: had/.test(del),
        !/return jsonError\(c, 400, "invalid_agent"/.test(del),
        /agent !== null && !registry\.sessionRuntime\.credentialSlots\(agent\)/.test(del),
      ],
      [true, true, true, true, true],
    );
  }
}

// Every failure here is silent, so the assertions read what the agent process was handed, never the absence of an error.

process.stdout.write("\nwhat an assembled session is launched as\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { SYSTEMS } = await import("../src/acp/systems.js");

  interface Launch {
    agent: AgentId;
    env: NodeJS.ProcessEnv;
    how: "opened" | "resumed" | "(neither)";
    routed: string | null;
    /** Session.start and Session.openResumed build the same request but for sessionId, so equal bags mean one bag reached both. */
    bag: Record<string, unknown> | null;
    /** The only honest reading of a native pin: a launch that never sent it still succeeds, on the agent's default. */
    configCalls: string[];
    routedHeaders: Record<string, string> | null;
    /** Whether stdin was closed, which is all a dispose looks like from out here. */
    closed: boolean;
  }

  const launches: Launch[] = [];
  let conversations = 0;

  /**
   * A let: the pin sweep's third axis is a CLI that retired a model between start and resume.
   * current is never the pinned model, so a sent pin and a coincidence cannot be confused.
   */
  let published: { choices: readonly string[]; current: string } = { choices: [], current: "" };

  /** Found by category and never by id, so the id here is deliberately not the word model. */
  const modelControl = (current: string, choices: readonly string[]): Record<string, unknown> => ({
    id: "model-picker",
    name: "Model",
    description: null,
    category: "model",
    type: "select",
    currentValue: current,
    options: choices.map((value) => ({ value, name: value, description: null })),
  });

  const spawnRouted = (agent: AgentId, extra: NodeJS.ProcessEnv): AgentProcess => {
    const launch: Launch = {
      agent,
      env: { ...extra },
      how: "(neither)",
      routed: null,
      routedHeaders: null,
      bag: null,
      configCalls: [],
      closed: false,
    };
    launches.push(launch);
    // Per process, as a real agent's config is, or the resume arm would read the start arm's pin as its own.
    let currentModel = published.current;
    const configOptions = (): Record<string, unknown>[] =>
      published.choices.length === 0 ? [] : [modelControl(currentModel, published.choices)];
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        const conversation = (how: "opened" | "resumed"): void => {
          launch.how = how;
          const { sessionId: _conversationId, ...rest } = params;
          launch.bag = rest;
        };
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                // Empty-object markers, as the real adapters send them: the readers test presence, not true.
                agentCapabilities: { sessionCapabilities: { resume: {} }, providers: {} },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.providers.list:
            // The claude adapter's answer, which is what lets hostable permit moonshot over this harness.
            send({
              jsonrpc: "2.0",
              id,
              result: { providers: [{ providerId: "main", supported: ["anthropic", "bedrock", "vertex"] }] },
            });
            break;
          case acp.methods.agent.providers.set:
            launch.routed = String(params["baseUrl"] ?? "");
            // Recorded so the header and the environment can be compared over one launch.
            launch.routedHeaders = { ...((params["headers"] ?? {}) as Record<string, string>) };
            send({ jsonrpc: "2.0", id, result: {} });
            break;
          case acp.methods.agent.session.new:
            conversation("opened");
            conversations += 1;
            send({ jsonrpc: "2.0", id, result: { sessionId: `conv_${conversations}`, modes: null, configOptions: configOptions() } });
            break;
          case acp.methods.agent.session.resume:
            conversation("resumed");
            // A resume answers with the full configOptions, as session/new does: the adapter's getOrCreateSession builds one answer for both.
            send({ jsonrpc: "2.0", id, result: { modes: null, configOptions: configOptions() } });
            break;
          case acp.methods.agent.session.setConfigOption:
            launch.configCalls.push(`${String(params["configId"])}=${String(params["value"])}`);
            currentModel = String(params["value"]);
            send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
            break;
          case acp.methods.agent.session.prompt:
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => {
        launch.closed = true;
        toAgent.end();
      },
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class RoutedRig extends LocalRuntime {
    // Stubbed: the real answer depends on whether this machine has a claude on its PATH.
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "claude", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(agent: AgentId, extra: NodeJS.ProcessEnv = {}): Promise<AgentProcess> {
      return spawnRouted(agent, extra);
    }
    // Without a key applySystem refuses before providers/set, and every routed assertion below would pass for the wrong reason.
    override systemSecret(): string | null {
      return "sekrit";
    }
  }

  let preset: { harness: AgentId; system: SystemId; model: string } | null = {
    harness: "claude",
    system: "moonshot",
    model: "kimi-k2-thinking",
  };
  const ownLog = new MemoryEventStore();
  const own = new SessionRegistry(ownLog, null, undefined, new RoutedRig());
  own.setCustomAgents((id) => (id === "ca_assembled" ? preset : null));

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

  /** ANTHROPIC_MODEL proves the bag kept the pairing; routed is the other half and cannot be derived from it. */
  const summary = (one: Launch | undefined): string =>
    one === undefined
      ? "(no launch)"
      : `${one.agent} ${one.how} model=${one.env["ANTHROPIC_MODEL"] ?? "-"} routed=${one.routed ?? "-"}`;

  /** The first resume at turn zero takes the empty arm, which opens a conversation; one turn later the same session resumes. */
  const bothArms = async (customAgent: string | null): Promise<Launch[]> => {
    launches.length = 0;
    const managed = await own.create({ agent: "claude", cwd: tmp("assembled-"), customAgent });
    await own.stop(managed.id);
    await managed.resume(5_000);
    check(`${customAgent ?? "bare"}: a turn is accepted before the second stop`, managed.prompt("hello").kind, "accepted");
    await settle();
    await own.stop(managed.id);
    await managed.resume(5_000);
    await own.stop(managed.id);
    return launches.slice();
  };

  const assembled = await bothArms("ca_assembled");
  check("an assembled session: the start, the empty arm and the resume arm", assembled.map(summary), [
    "claude opened model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
    "claude opened model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
    "claude resumed model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
  ]);
  // Both arms get one bag from ManagedSession.launchOptions and a resume adds only agentSessionId: what a fourth launch site would break.
  /** bag alone is not enough: losing the system changes only the spawn env and whether providers/set was sent. */
  const shapeOf = (one: Launch | undefined): unknown =>
    one === undefined ? null : { agent: one.agent, env: one.env, routed: one.routed, bag: one.bag };
  check("and both arms hand the agent the same bag but for the conversation id", shapeOf(assembled[1]), shapeOf(assembled[2]));
  // The one line that reads the table, so the literals above cannot agree only with each other.
  check("and the endpoint it was pointed at is the table's own", assembled[2]?.routed, SYSTEMS.moonshot.baseUrl);

  // Both halves: the secret is in the headers and in no environment value; either alone passes against a daemon that sends it nowhere.
  const carried = assembled.map((one) => one.routedHeaders?.["authorization"] ?? null);
  check("every routed launch signed its traffic with the stored key", carried, [
    "Bearer sekrit",
    "Bearer sekrit",
    "Bearer sekrit",
  ]);
  check(
    "and not one of them put it in the environment the agent can print",
    assembled.flatMap((one) =>
      Object.entries(one.env).flatMap(([name, value]) => (String(value).includes("sekrit") ? [name] : [])),
    ),
    [],
  );
  check("which is a bag rather than nothing at all", assembled[1]?.bag === null || assembled[1]?.bag === undefined, false);

  const bare = await bothArms(null);
  check("a bare harness takes both arms with nothing routed", bare.map(summary), [
    "claude opened model=- routed=-",
    "claude opened model=- routed=-",
    "claude resumed model=- routed=-",
  ]);
  check("and its two arms agree with each other too", shapeOf(bare[1]), shapeOf(bare[2]));

  launches.length = 0;
  const live = await own.create({ agent: "claude", cwd: tmp("repointed-"), customAgent: "ca_assembled" });
  check("a session on a preset starts routed", live.prompt("hello").kind, "accepted");
  await settle();
  await own.stop(live.id);
  check("and one turn puts it on the resume arm for the rest of this block", launches.map(summary), [
    "claude opened model=kimi-k2-thinking routed=https://api.moonshot.ai/anthropic",
  ]);

  const resumed = async (): Promise<string> => {
    launches.length = 0;
    return live
      .resume(5_000)
      .then(() => "(resumed)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
  };

  // A session cannot change harness underneath itself, so a preset re-pointed elsewhere demotes it to its own harness, bare.
  preset = { harness: "codex", system: "openai", model: "gpt-5-codex" };
  check("re-pointing its preset at another harness does not strand the session", await resumed(), "(resumed)");
  check("it comes back on the harness it was started with, and bare", launches.map(summary), [
    "claude resumed model=- routed=-",
  ]);

  await own.stop(live.id);
  preset = { harness: "kimi", system: "moonshot", model: "kimi-k2-thinking" };
  check("and a re-pointing the matrix permits is demoted just as flatly", await resumed(), "(resumed)");
  check("rather than pointing this harness at somebody else's endpoint", launches.map(summary), [
    "claude resumed model=- routed=-",
  ]);

  // The guard compares harnesses rather than disabling presets, and the model differs from the start so the preset is re-read at launch.
  await own.stop(live.id);
  preset = { harness: "claude", system: "moonshot", model: "kimi-k2-0905-preview" };
  check("while a preset still naming this harness is applied", await resumed(), "(resumed)");
  check("at whatever it holds now, read fresh at the launch", launches.map(summary), [
    "claude resumed model=kimi-k2-0905-preview routed=https://api.moonshot.ai/anthropic",
  ]);

  await own.stop(live.id);
  preset = null;
  check("and a preset deleted underneath it still degrades rather than failing", await resumed(), "(resumed)");
  check("to the same bare harness, by the same rule", launches.map(summary), ["claude resumed model=- routed=-"]);

  // Every cell reads the calls on the wire, never the outcome; a start refuses an un-pinnable model, a resume demotes and says so (Q2.215, Q2.216).

  const pinOf = (one: Launch | undefined): string =>
    one === undefined
      ? "(no launch)"
      : `${one.how} config=[${one.configCalls.join(" ")}] env=${one.env["ANTHROPIC_MODEL"] ?? "-"} routed=${one.routed ?? "-"}`;

  const notices = (id: string): { message: string; model: unknown }[] =>
    ownLog.read(id, -1, 1000, Number.MAX_SAFE_INTEGER).flatMap(({ event }) => {
      if (event.type !== "error") return [];
      const data = event.data as { code?: unknown; model?: unknown } | null;
      return data?.code === "model_not_pinned" ? [{ message: event.message, model: data.model }] : [];
    });

  /** Resume cells share one session; a turn precedes the first stop so session/resume, not the empty arm, is driven. */
  const column = async (
    pairing: { harness: AgentId; system: SystemId; model: string },
    offering: readonly string[],
    withoutIt: readonly string[],
    currentWhenGone = "sonnet",
  ): Promise<{ lines: string[]; id: string }> => {
    preset = { ...pairing };

    published = { choices: offering, current: "sonnet" };
    launches.length = 0;
    const managed = await own.create({ agent: pairing.harness, cwd: tmp("pinned-"), customAgent: "ca_assembled" });
    const lines = [`start, offered:  ${pinOf(launches[0])}`];
    check(`${pairing.system}: a turn is accepted before the model is retired`, managed.prompt("hi").kind, "accepted");
    await settle();
    await own.stop(managed.id);

    launches.length = 0;
    await managed.resume(5_000);
    await settle();
    lines.push(`resume, offered: ${pinOf(launches[0])} notices=${notices(managed.id).length}`);
    await own.stop(managed.id);

    published = { choices: withoutIt, current: currentWhenGone };
    launches.length = 0;
    const came = await managed
      .resume(5_000)
      .then(() => "(resumed)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    // startIdleDrain is armed on adoption, so the notice lands a tick after the resume resolves.
    await settle();
    lines.push(`resume, gone:    ${came} ${pinOf(launches[0])} notices=${notices(managed.id).length}`);
    await own.stop(managed.id);

    launches.length = 0;
    const refused = await own
      .create({ agent: pairing.harness, cwd: tmp("pinned-"), customAgent: "ca_assembled" })
      .then(() => "(started)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    lines.push(`start, gone:     ${refused} ${pinOf(launches[0])} disposed=${launches[0]?.closed ?? false}`);
    return { lines, id: managed.id };
  };

  const native = await column({ harness: "claude", system: "anthropic", model: "opus" }, ["opus", "sonnet"], ["sonnet"]);
  check("a native pairing, across both launches and both list states", native.lines, [
    "start, offered:  opened config=[model-picker=opus] env=- routed=-",
    "resume, offered: resumed config=[model-picker=opus] env=- routed=- notices=0",
    "resume, gone:    (resumed) resumed config=[] env=- routed=- notices=1",
    "start, gone:     SystemRoutingError opened config=[] env=- routed=- disposed=true",
  ]);
  check("and the demotion names both models, and its own code", notices(native.id), [
    {
      message:
        'claude has no model called "opus" — it offers sonnet. ' +
        "The conversation was resumed anyway, running sonnet.",
      model: "opus",
    },
  ]);

  // The agent no longer lists the model but is still on it: nothing to send, nothing to announce, and a start must not refuse (Q2.216).
  const still = await column({ harness: "claude", system: "anthropic", model: "opus" }, ["opus", "sonnet"], ["sonnet"], "opus");
  check("a model the agent no longer offers but is already running", still.lines, [
    "start, offered:  opened config=[model-picker=opus] env=- routed=-",
    "resume, offered: resumed config=[model-picker=opus] env=- routed=- notices=0",
    "resume, gone:    (resumed) resumed config=[] env=- routed=- notices=0",
    "start, gone:     (started) opened config=[] env=- routed=- disposed=false",
  ]);
  check("and it says nothing, because there is no demotion to report", notices(still.id), []);

  // Routed: the model is named at spawn and validated by the endpoint, so there is no gone case and nothing may change.
  const routed = await column(
    { harness: "claude", system: "moonshot", model: "kimi-k2-thinking" },
    ["kimi-k2-thinking", "sonnet"],
    ["opus", "sonnet"],
  );
  const endpoint = SYSTEMS.moonshot.baseUrl;
  check("a routed pairing takes neither the pin nor the refusal", routed.lines, [
    `start, offered:  opened config=[] env=kimi-k2-thinking routed=${endpoint}`,
    `resume, offered: resumed config=[] env=kimi-k2-thinking routed=${endpoint} notices=0`,
    `resume, gone:    (resumed) resumed config=[] env=kimi-k2-thinking routed=${endpoint} notices=0`,
    `start, gone:     (started) opened config=[] env=kimi-k2-thinking routed=${endpoint} disposed=false`,
  ]);
  check("and says nothing in the transcript about a model it never asked the agent for", notices(routed.id), []);

  // opencode lists ids under openrouter/ while the preset stores the bare id: the pin succeeds only by respelling, and a bare listing is refused.
  const prefixed = await column(
    { harness: "opencode", system: "openrouter", model: "qwen/qwen3-coder" },
    ["openrouter/qwen/qwen3-coder", "openrouter/z-ai/glm-5.3"],
    ["qwen/qwen3-coder", "openrouter/z-ai/glm-5.3"],
  );
  check("a native pairing whose ids the harness respells", prefixed.lines, [
    "start, offered:  opened config=[model-picker=openrouter/qwen/qwen3-coder] env=- routed=-",
    "resume, offered: resumed config=[model-picker=openrouter/qwen/qwen3-coder] env=- routed=- notices=0",
    "resume, gone:    (resumed) resumed config=[] env=- routed=- notices=1",
    "start, gone:     SystemRoutingError opened config=[] env=- routed=- disposed=true",
  ]);
  check("and its refusal names the id it asked for, not the one it was given", notices(prefixed.id).slice(-1), [
    {
      message:
        'opencode has no model called "openrouter/qwen/qwen3-coder" — ' +
        "it offers qwen/qwen3-coder, openrouter/z-ai/glm-5.3. " +
        "The conversation was resumed anyway, running sonnet.",
      model: "qwen/qwen3-coder",
    },
  ]);

  // Back to the state the block was left in, so nothing below inherits a fixture.
  published = { choices: [], current: "" };

  await own.shutdown();

  // harness has no downstream use, so only reading scripts/daemon.ts shows the thunk still hands it back.
  const wiring = readFileSync(new URL("../scripts/daemon.ts", import.meta.url), "utf8");
  check(
    "and the daemon's own thunk hands the harness back beside the pair",
    /setCustomAgents\(\(id\) => \{[\s\S]{0,400}?harness: one\.harness[\s\S]{0,200}?\}\);/.test(wiring),
    true,
  );
  // Both setters must run before restore, which drops presets whose harness it cannot resolve; indices because the property is an order.
  check(
    "and the catalogue and the presets are both wired before the restore",
    [
      wiring.indexOf("registry.setMachineCatalogue(") < wiring.indexOf("registry.restore("),
      wiring.indexOf("registry.setCustomAgents(") < wiring.indexOf("registry.restore("),
      // Or two -1s would compare as an order and pass with the calls deleted.
      [wiring.indexOf("registry.setMachineCatalogue("), wiring.indexOf("registry.setCustomAgents("), wiring.indexOf("registry.restore(")].every((at) => at > 0),
    ],
    [true, true, true],
  );
}
