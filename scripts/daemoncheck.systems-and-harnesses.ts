import { mkdirSync } from "node:fs";
import { credentialEnvNames, type AgentId } from "../src/acp/agents.js";
import type { BuiltinSystemId } from "../src/acp/systems.js";
import { LocalRuntime } from "../src/runtime/local.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import { storeOf, rowFor } from "./daemoncheck.fixtures.js";

process.stdout.write("\nbeing told a session appeared\n");
{
  const { SessionRegistry } = await import("../src/registry.js");

  const root = tmp("observer-");
  mkdirSync(root, { recursive: true });
  const warnings: string[] = [];
  const registry = new SessionRegistry(
    undefined,
    storeOf([rowFor("s_one", root), rowFor("s_two", root)]),
    undefined,
    undefined,
    undefined,
    (detail) => warnings.push(detail),
  );

  // Registered first: a throw must not stop the observers after it, and is reported rather than swallowed.
  let threw = 0;
  const unstable = registry.watchSessions(() => {
    threw += 1;
    throw new Error("this observer is broken");
  });
  const seen: [string, string][] = [];
  const stop = registry.watchSessions((managed, arrival) => seen.push([managed.id, arrival]));

  registry.restore({ reapOrphans: false });

  check(
    "every session already here is announced, as restored",
    seen,
    [
      ["s_one", "restored"],
      ["s_two", "restored"],
    ],
  );
  report("a throwing observer is called for every one of them", threw === 2, `${threw} calls`);
  report(
    "each throw is reported rather than swallowed",
    warnings.filter((one) => one.includes("this observer is broken")).length === 2,
    `${warnings.length} warnings`,
  );

  unstable();
  stop();
  const before = seen.length;
  registry.restore({ reapOrphans: false });
  check("and unsubscribing really stops it", seen.length, before);

  await registry.shutdown();
}

process.stdout.write("\nwhich harness can be pointed at which system\n");
{
  const { AGENT_IDS: harnesses, isBuiltinAgentId } = await import("../src/acp/agents.js");
  const {
    hostable,
    routedModelEnv,
    routedPairing,
    routingHeaders,
    BUILTIN_CATALOGUE,
    SYSTEM_IDS,
    SYSTEMS,
    systemSecretFor,
    isBuiltinSystemId,
    ROUTED_MODEL_ENV,
  } = await import("../src/acp/systems.js");
  type MachineCatalogue = Parameters<typeof hostable>[3] & object;
  type ContributedHarness = NonNullable<ReturnType<MachineCatalogue["harness"]>>;

  const routings = {
    claude: { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] },
    codex: { providerId: "custom-gateway", supported: ["openai"] },
    kimi: null,
    opencode: null,
    // grok advertises `loadSession` and the rest but no `providers` marker, so it reaches xAI only as its native harness.
    grok: null,
  } as const;

  const nativeMisses = SYSTEM_IDS.flatMap((system) => {
    const native = SYSTEMS[system].nativeHarness;
    return native === null || hostable(native, system, null) === null ? [] : [system];
  });
  check("a native pairing needs no routing at all", nativeMisses, []);

  const matrix = harnesses.flatMap((harness) =>
    SYSTEM_IDS.map((system) => {
      const refusal = hostable(harness, system, routings[harness]);
      return `${harness} x ${system}: ${refusal === null ? "yes" : "no"}`;
    }),
  );
  check("the matrix is what the adapters allow", matrix, [
    "claude x anthropic: yes",
    "claude x openai: no",
    "claude x openrouter: yes",
    "claude x xai: no",
    "claude x moonshot: yes",
    "claude x zhipu: yes",
    "claude x minimax: yes",
    "claude x zen: no",
    "kimi x anthropic: no",
    "kimi x openai: no",
    "kimi x openrouter: no",
    "kimi x xai: no",
    "kimi x moonshot: yes",
    "kimi x zhipu: no",
    "kimi x minimax: no",
    "kimi x zen: no",
    "codex x anthropic: no",
    "codex x openai: yes",
    "codex x openrouter: no",
    "codex x xai: no",
    "codex x moonshot: no",
    "codex x zhipu: no",
    "codex x minimax: no",
    "codex x zen: no",
    "opencode x anthropic: no",
    "opencode x openai: no",
    "opencode x openrouter: yes",
    "opencode x xai: no",
    "opencode x moonshot: no",
    "opencode x zhipu: no",
    "opencode x minimax: no",
    "opencode x zen: yes",
    "grok x anthropic: no",
    "grok x openai: no",
    "grok x openrouter: no",
    "grok x xai: yes",
    "grok x moonshot: no",
    "grok x zhipu: no",
    "grok x minimax: no",
    "grok x zen: no",
  ]);

  // Routable but un-pinnable must refuse, or the session silently runs the endpoint's default model.
  const claudeEnv = ROUTED_MODEL_ENV.claude;
  delete ROUTED_MODEL_ENV.claude;
  check(
    "a harness that cannot be told which model to run is refused",
    hostable("claude", "moonshot", routings.claude) !== null,
    true,
  );
  ROUTED_MODEL_ENV.claude = claudeEnv;
  check("and putting it back restores the pairing", hostable("claude", "moonshot", routings.claude), null);

  const env = routedModelEnv("claude", "moonshot", "kimi-k2-thinking");
  check("a routed model is named in the environment", env["ANTHROPIC_MODEL"], "kimi-k2-thinking");
  check("and also as a picker row, which is the documented door", env["ANTHROPIC_CUSTOM_MODEL_OPTION"], "kimi-k2-thinking");
  check("a native pairing is spawned with nothing extra", routedModelEnv("kimi", "moonshot", "kimi-k2"), {});
  check("the secret travels as a header", routingHeaders("moonshot", "sekrit"), {
    authorization: "Bearer sekrit",
  });
  check("and a native system has none to send", routingHeaders("anthropic", "sekrit"), {});

  // Decides whether a vendor credential is merged into the spawn env; all arms in one array so a constant answer fails.
  check(
    "which pairings are routed, arm by arm",
    [
      routedPairing("claude", null),
      routedPairing("claude", "nobody:nothing"),
      routedPairing("kimi", "moonshot"),
      routedPairing("kimi", "anthropic"),
      routedPairing("claude", "moonshot"),
    ],
    [false, false, false, false, true],
  );

  {
    // A contributed harness is the only way to put this driver's command through the real resolver.
    const probe: ContributedHarness = {
      id: "probe:env",
      pluginId: "probe",
      pluginName: "Probe",
      name: "Env probe",
      command: "node",
      args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      envNames: [],
      // Non-empty, or `hostable` refuses the pairing before routing is consulted.
      routedModelEnv: ["PROBE_MODEL"],
      authHint: null,
    };
    const withProbe: MachineCatalogue = {
      harness: (id) => (id === probe.id ? probe : BUILTIN_CATALOGUE.harness(id)),
      harnessIds: () => [...BUILTIN_CATALOGUE.harnessIds(), probe.id],
      harnessState: (id) => (id === probe.id ? "enabled" : BUILTIN_CATALOGUE.harnessState(id)),
      system: (id) => BUILTIN_CATALOGUE.system(id),
      systemIds: () => BUILTIN_CATALOGUE.systemIds(),
      systemState: (id) => BUILTIN_CATALOGUE.systemState(id),
    };
    const rig = new LocalRuntime({
      machine: withProbe,
      secrets: () => ({ DAEMONCHECK_PASTED_ONE: "sk-vendor", DAEMONCHECK_PASTED_TWO: "sk-oat" }),
    });
    const spawnedWith = async (routed: boolean): Promise<NodeJS.ProcessEnv> => {
      const child = await rig.launch(probe.id, { PROBE_MODEL: "kimi-k2-thinking" }, routed);
      let out = "";
      for await (const chunk of child.stdout) out += String(chunk);
      await child.waitForExit(5_000);
      return JSON.parse(out) as NodeJS.ProcessEnv;
    };
    const routedEnv = await spawnedWith(routedPairing(probe.id, "moonshot", withProbe));
    const nativeEnv = await spawnedWith(routedPairing(probe.id, "anthropic", withProbe));
    // Computed, never literals, so a `routedPairing` that returns a constant fails.
    check(
      "a routed launch is spawned with none of the harness's own credentials",
      [routedEnv["DAEMONCHECK_PASTED_ONE"] ?? null, routedEnv["DAEMONCHECK_PASTED_TWO"] ?? null],
      [null, null],
    );
    check(
      "while a native launch on the same harness and the same store carries both",
      [nativeEnv["DAEMONCHECK_PASTED_ONE"] ?? null, nativeEnv["DAEMONCHECK_PASTED_TWO"] ?? null],
      ["sk-vendor", "sk-oat"],
    );
    check(
      "with the model this daemon pinned reaching either way",
      [routedEnv["PROBE_MODEL"] ?? null, nativeEnv["PROBE_MODEL"] ?? null],
      ["kimi-k2-thinking", "kimi-k2-thinking"],
    );
  }

  // No `/v1` in the base: the SDK appends `/v1/messages`, and a doubled segment answers an HTML 404.
  check("the routed base for the sixth system carries no version segment", SYSTEMS.openrouter.baseUrl, "https://openrouter.ai/api");
  check("and its key travels as a header like every other routed row", routingHeaders("openrouter", "sekrit"), {
    authorization: "Bearer sekrit",
  });

  check(
    "which systems respell a native model id",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].nativeModelPrefix !== null).map(
      (id) => `${id}: ${SYSTEMS[id].nativeModelPrefix ?? ""}`,
    ),
    ["openrouter: openrouter/", "zen: opencode/"],
  );
  // Only these two spellings are relatable; Moonshot's two lists are different products (Q3.488).
  check(
    "no system offers a key box it could never spend",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].baseUrl === null && SYSTEMS[id].loginVia === null),
    [],
  );
  check(
    "and no natively-reached system claims one it cannot honour",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].nativeModelPrefix !== null && SYSTEMS[id].nativeHarness === null),
    [],
  );
  check(
    "which systems name a key of their own",
    SYSTEM_IDS.filter((id) => SYSTEMS[id].keyEnv !== null).map((id) => `${id}: ${SYSTEMS[id].keyEnv ?? ""}`),
    [
      "openrouter: OPENROUTER_API_KEY",
      "xai: XAI_API_KEY",
      "zen: OPENCODE_API_KEY",
    ],
  );
  // Each named variable must be one its harness reads; a typo silently brings back every key box.
  check(
    "and each one is a variable its own harness reads",
    SYSTEM_IDS.filter((id) => {
      const named = SYSTEMS[id].keyEnv;
      if (named === null) return false;
      const harness = SYSTEMS[id].nativeHarness;
      if (harness === null || !isBuiltinAgentId(harness)) return true;
      return !credentialEnvNames(harness).includes(named);
    }),
    [],
  );
  const held = (agent: string, envName: string, secret: string) => (a: AgentId) =>
    a === agent ? { [envName]: secret } : {};
  check(
    "a stored system key wins, and its harness's key answers when there is none",
    [
      systemSecretFor("openrouter", "stored", held("opencode", "OPENROUTER_API_KEY", "borrowed")),
      systemSecretFor("openrouter", null, held("opencode", "OPENROUTER_API_KEY", "borrowed")),
      systemSecretFor("openrouter", null, () => ({})),
    ],
    ["stored", "borrowed", null],
  );
  // Gated on `keyEnv`: Moonshot must never borrow `KIMI_API_KEY`, a different product and host (Q3.488).
  check(
    "no system with a key of its own borrows one it was never offered",
    SYSTEM_IDS.filter(
      (id) =>
        SYSTEMS[id].keyEnv === null &&
        SYSTEMS[id].nativeHarness !== null &&
        systemSecretFor(id, null, () => ({ KIMI_API_KEY: "x", ANTHROPIC_API_KEY: "x", CODEX_API_KEY: "x" })) !== null,
    ),
    [],
  );

  const templateOf = (why: string): string => {
    let shape = why;
    for (const system of SYSTEM_IDS) shape = shape.split(SYSTEMS[system].displayName).join("{system}");
    return shape;
  };

  check(
    "a system with no routed endpoint names the CLI that reaches it",
    hostable("codex", "anthropic", routings.codex),
    "Anthropic can only be reached by the CLI it ships with.",
  );
  check(
    "a harness that answers nothing about routing says what it does instead",
    hostable("kimi", "zhipu", routings.kimi),
    "This agent only runs its own models.",
  );
  check(
    "a protocol mismatch says which models, never which protocol",
    hostable("codex", "moonshot", routings.codex),
    "This agent cannot run Moonshot models.",
  );
  delete ROUTED_MODEL_ENV.claude;
  check(
    "and one that can be routed but not pinned names the thing that is wrong",
    hostable("claude", "moonshot", routings.claude),
    "This agent cannot be told which model to use on another system.",
  );
  ROUTED_MODEL_ENV.claude = claudeEnv;

  const drawn: { system: BuiltinSystemId; why: string }[] = [];
  for (const pinnable of [true, false]) {
    if (!pinnable) delete ROUTED_MODEL_ENV.claude;
    for (const harness of harnesses) {
      for (const system of SYSTEM_IDS) {
        for (const routing of [routings[harness], null]) {
          const why = hostable(harness, system, routing);
          if (why !== null) drawn.push({ system, why });
        }
      }
    }
    ROUTED_MODEL_ENV.claude = claudeEnv;
  }
  check(
    "every sentence this function can produce is one of four",
    [...new Set(drawn.map((one) => templateOf(one.why)))].sort(),
    [
      "This agent cannot be told which model to use on another system.",
      "This agent cannot run {system} models.",
      "This agent only runs its own models.",
      "{system} can only be reached by the CLI it ships with.",
    ],
  );

  // Deliberately not webcheck's `noJargon`: here a refusal may name its own system and no other, and never a harness.
  const jargonIn = (why: string, about: BuiltinSystemId): string[] => {
    const found: string[] = [];
    if (!why.endsWith(".")) found.push("no full stop");
    if (/\bapiType\b|\bprovider(Id)?\b|\bsupported\b|\bnativeHarness\b|\bbaseUrl\b|\//i.test(why)) {
      found.push("wire vocabulary");
    }
    const lower = why.toLowerCase();
    for (const other of SYSTEM_IDS) {
      if (other === about) continue;
      if (lower.includes(other) || lower.includes(SYSTEMS[other].displayName.toLowerCase())) {
        found.push(`names ${other}`);
      }
    }
    // The subject's display name is removed first: "OpenCode Zen" contains a harness id.
    const scanned = lower.split(SYSTEMS[about].displayName.toLowerCase()).join(" ");
    for (const harness of harnesses) if (scanned.includes(harness)) found.push(`names ${harness}`);
    return found;
  };
  check(
    "and none of them is written for a developer",
    drawn.flatMap(({ system, why }) => jargonIn(why, system).map((reason) => `${why} — ${reason}`)),
    [],
  );
  check(
    "while the sentence that really shipped is caught, and by what",
    jargonIn("This agent accepts openai systems, and Moonshot is anthropic", "moonshot"),
    ["no full stop", "names anthropic", "names openai"],
  );
  // A plain `includes`, not a word boundary: OpenRouter and OpenAI share a prefix, so both directions are asserted.
  check(
    "a harness name is still caught wherever it is not the provider's own",
    [
      jargonIn("Only opencode can run Moonshot models.", "moonshot"),
      jargonIn("OpenCode Zen cannot be run by claude.", "zen"),
      jargonIn("OpenCode Zen can only be reached by the CLI it ships with.", "zen"),
    ],
    [["names opencode"], ["names claude"], []],
  );
  check(
    "and the two ids that share a prefix are not read as naming each other",
    [
      jargonIn("OpenRouter can only be reached by the CLI it ships with.", "openrouter"),
      jargonIn("OpenAI can only be reached by the CLI it ships with.", "openai"),
      jargonIn("This agent cannot run OpenRouter models.", "openrouter"),
    ],
    [[], [], []],
  );

  check("an id this repository ships", isBuiltinSystemId("moonshot"), true);
  check("and one it does not", isBuiltinSystemId("gemini"), false);
  check("and a contributed id is never mistaken for one", isBuiltinSystemId("acme:moonshot"), false);
}
