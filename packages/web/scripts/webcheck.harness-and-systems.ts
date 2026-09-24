import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";
import { type SystemInfo } from "./webcheck.modules.js";

process.stdout.write("\nwhich harness can be pointed at which system\n");
{
  const { allModels, choiceRefusal, defaultAgentName, customAgentSubline, groupModels, harnessRowRefusal, hostable, keyMissing, listedByBuild, readyFirst, searchModels, supportingHarnesses } =
    await import("../src/agents.js");

  const system = (over: Partial<SystemInfo> = {}): SystemInfo => ({
    id: "moonshot",
    displayName: "Moonshot",
    apiType: "anthropic",
    routable: true,
    nativeHarness: "kimi",
    loginVia: "kimi",
    models: [{ id: "kimi-k2-thinking", name: "Kimi K2 Thinking" }],
    keySet: true,
    keyUpdatedAt: 1,
    ...over,
  });

  // The routing answers the pinned adapters gave; `daemoncheck` uses the same fixtures, so client and daemon agree.
  const claude = { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] };
  const codex = { providerId: "custom-gateway", supported: ["openai"] };

  check("a native pairing needs no routing at all", hostable("kimi", system(), null), null);
  check("a routable one is allowed", hostable("claude", system(), claude), null);
  // Refusals are read on a phone: no wire vocabulary, and no slash, since a published id is always `<cli>/<model>`.
  const noJargon = (why: string | null): boolean =>
    why !== null &&
    !/\banthropic\b|\bopenai\b|\bapiType\b|\bprovider(Id)?\b|\bsupported\b/i.test(why) &&
    !/\bmodelId\b|\bmodelName\b|\bnativeHarness\b|\bpublished\b|\btable\b|\bsource\b|\//i.test(why);
  check("the vocabulary rule catches the sentence that really shipped", noJargon("Codex accepts openai systems, and Moonshot is anthropic."), false);
  check("and an id where a name goes, which no arm above it would see", noJargon("Kimi Code cannot run kimi-code/k3."), false);
  check("and a refusal that never came is not a well-written refusal", noJargon(null), false);
  check(
    "a protocol mismatch names the harness and the system, in words",
    [hostable("codex", system(), codex), noJargon(hostable("codex", system(), codex))],
    ["Codex cannot run Moonshot models.", true],
  );
  check(
    "a harness that answers nothing says what it does instead",
    [
      hostable("kimi", system({ nativeHarness: "claude" }), null),
      noJargon(hostable("kimi", system({ nativeHarness: "claude" }), null)),
    ],
    ["Kimi Code only runs its own models.", true],
  );
  check(
    "a system nothing can be pointed at names the CLI that reaches it",
    hostable("claude", system({ routable: false }), claude),
    "Only Kimi Code can run Moonshot models.",
  );
  check(
    "and a daemon too old to say is read the same way",
    hostable("claude", system({ routable: undefined }), claude),
    "Only Kimi Code can run Moonshot models.",
  );
  check(
    "with no CLI either, it says so rather than naming nobody",
    hostable("claude", system({ routable: false, nativeHarness: null }), claude),
    "Moonshot cannot be reached from this machine.",
  );

  check(
    "a harness that cannot be told which model to run is refused",
    hostable("claude", system(), { ...claude, pinsModel: false }),
    "Claude Code cannot run Moonshot models.",
  );
  check(
    "and it is the same sentence the protocol arm draws, because the remedy is",
    // The same harness on both sides, so only the arm that produced the sentence differs.
    hostable("claude", system(), { ...claude, pinsModel: false }) ===
      hostable("claude", system({ apiType: "openai" }), claude),
    true,
  );
  check("while a daemon too old to say is read as yes", hostable("claude", system(), claude), null);
  check("and so is one that says yes", hostable("claude", system(), { ...claude, pinsModel: true }), null);

  const anthropic = system({
    id: "anthropic",
    displayName: "Anthropic",
    nativeHarness: "claude",
    loginVia: "claude",
    models: [],
  });
  const caps = {
    claude: {
      models: [
        { id: "default", name: "Default", description: null, group: null },
        { id: "opus", name: "Opus 5", description: null, group: null },
      ],
      routing: claude,
      error: null,
    },
    kimi: { models: [], routing: null, error: null },
  };
  const listed = allModels([anthropic, system()], caps as never);
  const moonshot = system();
  const published = { system: moonshot, modelId: "kimi-code/k3", modelName: "K3", source: "published" } as const;
  const tabled = { system: moonshot, modelId: "kimi-k2-thinking", modelName: "K2", source: "table" } as const;
  check("a routed harness may not use the CLI's own spelling", choiceRefusal("claude", published, claude) !== null, true);
  check("but may use the endpoint's", choiceRefusal("claude", tabled, claude), null);
  check("and the native harness is the exact mirror", [
    choiceRefusal("kimi", published, null),
    choiceRefusal("kimi", tabled, null) !== null,
  ], [null, true]);
  check(
    "a pairing refused for nothing but a key says so",
    choiceRefusal("claude", { ...tabled, system: system({ nativeHarness: null, keySet: false }) }, claude),
    "No Moonshot key on this machine.",
  );
  // A key belongs to the row, not the system: a model needs a key iff its id came from the table (Q3.485).
  const unkeyed = system({ keySet: false });
  check(
    "a routed pairing needs the key, which is every table-spelled model there is",
    keyMissing({ ...tabled, system: unkeyed }, null),
    "No Moonshot key on this machine.",
  );
  check(
    "a native one does not, which is every published one",
    keyMissing({ ...published, system: unkeyed }, null),
    null,
  );
  check(
    "a published model of a keyless system is offered on the model screen too",
    choiceRefusal(null, { ...published, system: unkeyed }, null),
    null,
  );
  const keyOnly = (keySet: boolean): SystemInfo => system({ nativeHarness: null, keySet });
  check("a system with no CLI and no key is blocked", keyMissing({ ...tabled, system: keyOnly(false) }, null) !== null, true);
  check("with a key it is not", keyMissing({ ...tabled, system: keyOnly(true) }, null), null);
  const keyCells = (["published", "table"] as const).flatMap((source) =>
    ([true, false] as const).flatMap((native) =>
      ([true, false] as const).map((keySet) => {
        const host = system({ nativeHarness: native ? "kimi" : null, keySet });
        const choice = { ...(source === "published" ? published : tabled), system: host };
        return {
          label: `${source}/${native ? "native" : "no CLI"}/${keySet ? "key" : "no key"}`,
          greyed: choiceRefusal(null, choice, null) !== null,
          rule: source === "table" && !keySet,
        };
      }),
    ),
  );
  check(
    "a model is greyed for a key iff its id came from the table and no key is saved",
    keyCells.filter((cell) => cell.greyed !== cell.rule).map((cell) => cell.label),
    [],
  );
  check(
    "and both sides of it move, over all eight cells",
    [keyCells.filter((cell) => cell.greyed).map((cell) => cell.label), keyCells.length],
    [["table/native/no key", "table/no CLI/no key"], 8],
  );
  const orPrefixed = system({
    id: "openrouter",
    displayName: "OpenRouter",
    nativeHarness: "opencode",
    nativeModelPrefix: "openrouter/",
    keySet: false,
  });
  const orPub = { system: orPrefixed, modelId: "qwen/q3", modelName: "Qwen: Q3", source: "published" as const };
  check(
    "a routed pairing needs the key even where the id came from the native harness",
    [
      keyMissing(orPub, "claude"),
      keyMissing(orPub, "opencode"),
      keyMissing(orPub, null),
      keyMissing({ ...orPub, system: { ...orPrefixed, keySet: true } }, "claude"),
    ],
    ["No OpenRouter key on this machine.", null, null, null],
  );
  check(
    "so the harness row greys rather than the start failing",
    harnessRowRefusal("claude", orPub, { providerId: "main", supported: ["anthropic"] }),
    "No OpenRouter key on this machine.",
  );
  const zai = system({
    id: "zai",
    displayName: "Z.ai (GLM)",
    nativeHarness: null,
    loginVia: null,
    keySet: false,
    models: [{ id: "glm-4.6", name: "GLM-4.6" }],
  });
  const moonshotRow = choiceRefusal(null, { system: unkeyed, modelId: "kimi-k2-thinking", modelName: "Kimi K2", source: "table" }, null);
  const zaiRow = choiceRefusal(null, { system: zai, modelId: "glm-4.6", modelName: "GLM-4.6", source: "table" }, null);
  check(
    "two keyless systems' table rows are refused alike, native harness or not",
    [moonshotRow, zaiRow],
    ["No Moonshot key on this machine.", "No Z.ai (GLM) key on this machine."],
  );
  check(
    "and it is one sentence with the provider substituted, not two that agree",
    moonshotRow?.replace("Moonshot", "«") === zaiRow?.replace("Z.ai (GLM)", "«"),
    true,
  );
  check(
    "and the whole pair is refused, so the button is still the gate",
    choiceRefusal("claude", { ...tabled, system: unkeyed }, claude),
    "No Moonshot key on this machine.",
  );
  check(
    "a missing key greys the harness row, because nothing on this screen can clear it",
    harnessRowRefusal("claude", { ...tabled, system: unkeyed }, claude),
    "No Moonshot key on this machine.",
  );
  check(
    "while a settled failure outranks it, on a row a key could not rescue",
    harnessRowRefusal("codex", { ...tabled, system: unkeyed }, codex),
    "Cannot run K2.",
  );
  check(
    "one pair, one reason, on the row and on the button under it",
    [
      harnessRowRefusal("codex", { ...tabled, system: unkeyed }, codex),
      choiceRefusal("codex", { ...tabled, system: unkeyed }, codex),
    ],
    ["Cannot run K2.", "Codex cannot run K2."],
  );
  check(
    "and a spelling outranks it too",
    choiceRefusal("claude", { ...published, system: unkeyed }, claude),
    "Claude Code has no model called K3.",
  );
  check(
    "the row, the button and the rule itself all say the same sentence",
    [
      harnessRowRefusal("claude", { ...tabled, system: unkeyed }, claude) === keyMissing({ ...tabled, system: unkeyed }, "claude"),
      choiceRefusal("claude", { ...tabled, system: unkeyed }, claude) === keyMissing({ ...tabled, system: unkeyed }, "claude"),
    ],
    [true, true],
  );
  check(
    "and it tells nobody where to go, on a screen where every row can be greyed",
    /Settings|Machines|Add|Paste|Go to/.test(keyMissing({ ...tabled, system: unkeyed }, "claude") ?? ""),
    false,
  );
  check(
    "a native pairing is still not greyed, however unkeyed the system",
    harnessRowRefusal("kimi", { ...published, system: unkeyed }, null),
    null,
  );
  check(
    "all three rows can be greyed, each for its own true reason",
    (["claude", "codex", "kimi"] as const).map((harness) =>
      harnessRowRefusal(harness, { ...tabled, system: unkeyed }, { claude, codex, kimi: null }[harness]),
    ),
    ["No Moonshot key on this machine.", "Cannot run K2.", "No model called K2."],
  );
  // Each harness gets the spelling that pairs with it, so only the key varies down a column.
  const grid = (): string[] =>
    ([
      ["reachable natively, key saved", system()],
      ["reachable natively, no key", system({ keySet: false })],
      ["key-only, key saved", system({ nativeHarness: null })],
      ["key-only, no key", system({ nativeHarness: null, keySet: false })],
    ] as const).flatMap(([where, host]) =>
      ([
        ["nobody", null, tabled],
        ["nobody · published", null, published],
        ["kimi", "kimi", published],
        ["claude", "claude", tabled],
      ] as const).map(([column, harness, spelling]) => {
        const choice = { ...spelling, system: host };
        const routing = harness === "claude" ? claude : null;
        const row = harness === null ? "—" : harnessRowRefusal(harness, choice, routing);
        return `${where} / ${column}: ${choiceRefusal(harness, choice, routing) ?? "—"} | ${row ?? "—"}`;
      }),
    );
  check("every cell of the pairing table, on the model screen and on the harness screen", grid(), [
    "reachable natively, key saved / nobody: — | —",
    "reachable natively, key saved / nobody · published: — | —",
    "reachable natively, key saved / kimi: — | —",
    "reachable natively, key saved / claude: — | —",
    "reachable natively, no key / nobody: No Moonshot key on this machine. | —",
    "reachable natively, no key / nobody · published: — | —",
    "reachable natively, no key / kimi: — | —",
    "reachable natively, no key / claude: No Moonshot key on this machine. | No Moonshot key on this machine.",
    "key-only, key saved / nobody: — | —",
    "key-only, key saved / nobody · published: — | —",
    "key-only, key saved / kimi: Kimi Code cannot run K3. | Cannot run K3.",
    "key-only, key saved / claude: — | —",
    "key-only, no key / nobody: No Moonshot key on this machine. | —",
    // Fixture-only: `allModels` yields a published spelling only where `nativeHarness` is set.
    "key-only, no key / nobody · published: — | —",
    "key-only, no key / kimi: Kimi Code cannot run K3. | Cannot run K3.",
    "key-only, no key / claude: No Moonshot key on this machine. | No Moonshot key on this machine.",
  ]);
  // A null harness refuses no pairing, only a fact about the row; that un-deadlocked the two pickers (Q3.479).
  check(
    "with no harness chosen, a pairing refuses nothing",
    [choiceRefusal(null, published, null), choiceRefusal(null, tabled, null)],
    [null, null],
  );
  check(
    "but a system with no key still says so",
    choiceRefusal(null, { ...tabled, system: system({ nativeHarness: null, keySet: false }) }, null),
    "No Moonshot key on this machine.",
  );
  // One heading per provider; which harnesses a model is for is on the row (Q3.486).
  check(
    "a provider is one heading however many ways it is reached",
    groupModels([published, tabled]).map((group) => group.system.displayName),
    ["Moonshot"],
  );
  check("with every row under it", groupModels([published, tabled])[0]?.choices.length, 2);

  const buildCaps = (over: Record<string, unknown> = {}) =>
    ({ kimi: { models: [], routing: null, error: null, cli: { version: "0.29.2", source: "path" } }, ...over }) as never;
  const groupOf = (...rows: unknown[]) => groupModels(rows as never)[0] as never;

  check(
    "a group whose rows all came from one harness names the build that published them",
    listedByBuild(groupOf(published), buildCaps(), (id) => (id === "kimi" ? "Kimi Code" : id)),
    "Listed by Kimi Code 0.29.2.",
  );
  check(
    "an override reads like any other chosen build, because the operator chose it",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: { version: "9.9.9", source: "override" } } }), () => "Kimi Code"),
    "Listed by Kimi Code 9.9.9.",
  );
  check(
    "a binary that will not say which build it is still names the program",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: { version: null, source: "path" } } }), () => "Kimi Code"),
    "Listed by Kimi Code.",
  );
  check(
    "a group holding one table row says nothing at all, because no build published that row",
    listedByBuild(groupOf(published, tabled), buildCaps(), () => "Kimi Code"),
    null,
  );
  check(
    "nor does a daemon too old to have sent the field",
    listedByBuild(groupOf(published), { kimi: { models: [], routing: null, error: null } } as never, () => "Kimi Code"),
    null,
  );
  check(
    "nor one whose read found no binary to name",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: null } }), () => "Kimi Code"),
    null,
  );
  check(
    "and a provider no harness is native to has nobody to name",
    listedByBuild(
      groupModels([{ ...published, system: system({ nativeHarness: null }) }] as never)[0] as never,
      buildCaps(),
      () => "Kimi Code",
    ),
    null,
  );
  check(
    "and a source this build has never heard of draws the plain line",
    listedByBuild(groupOf(published), buildCaps({ kimi: { models: [], routing: null, error: null, cli: { version: "1.0.0", source: "future" } } }), () => "Kimi Code"),
    "Listed by Kimi Code 1.0.0.",
  );
  // No vendor sub-headings, driven at OpenRouter's real shape (Q3.503).
  const or = (id: string, name: string) => ({
    system: system({ id: "openrouter", displayName: "OpenRouter", nativeHarness: "opencode", nativeModelPrefix: "openrouter/" }),
    modelId: id,
    modelName: name,
    source: "table" as const,
  });
  const many = (n: number, vendor: string) =>
    Array.from({ length: n }, (_, i) => or(`${vendor}/m${i}`, `M${i}`));
  check(
    "a provider past a dozen rows, every one of them prefixed, is still one heading",
    groupModels([...many(8, "qwen"), ...many(5, "google")]).map(
      (group) => `${group.system.displayName}: ${group.choices.length}`,
    ),
    ["OpenRouter: 13"],
  );
  check(
    "and so is one carrying the whole live catalogue",
    [groupModels(many(289, "qwen")).length, groupModels(many(289, "qwen"))[0]?.choices.length],
    [1, 289],
  );
  check(
    "a bare id among them changes nothing either way",
    groupModels([...many(12, "qwen"), or("plain", "Plain")]).map((group) => group.system.displayName),
    ["OpenRouter"],
  );

  const provider = (id: string, keySet: boolean, source: "published" | "table", model = "m") => ({
    system: system({ id, displayName: id, keySet, nativeHarness: null }),
    modelId: `${id}/${model}`,
    modelName: model,
    source,
  });
  const seen = (rows: readonly { system: { id: string } }[]): string[] => {
    const out: string[] = [];
    for (const one of rows) if (!out.includes(one.system.id)) out.push(one.system.id);
    return out;
  };
  check(
    "providers that are equally ready keep the order the daemon sent them in",
    seen(readyFirst([provider("a", true, "table"), provider("b", true, "table")])),
    ["a", "b"],
  );
  check(
    "and one this machine has a key for goes above one it does not",
    seen(readyFirst([provider("a", false, "table"), provider("b", true, "table")])),
    ["b", "a"],
  );
  check(
    "a provider with no key but a published model is ready, and floats",
    seen(readyFirst([provider("keyless-table", false, "table"), provider("published", false, "published")])),
    ["published", "keyless-table"],
  );
  const native = (id: string, nativeHarness: NonNullable<SystemInfo["nativeHarness"]>, model = "m") => ({
    system: system({ id, displayName: id, keySet: false, nativeHarness, routable: false }),
    modelId: `${id}/${model}`,
    modelName: model,
    source: "published" as const,
  });
  const routable = (id: string, model = "m") => ({
    system: system({ id, displayName: id, keySet: true, nativeHarness: null, routable: true }),
    modelId: `${id}/${model}`,
    modelName: model,
    source: "table" as const,
  });
  const OPEN_ROUTING = { supported: [system().apiType] } as never;
  check(
    "with no harness chosen the order is exactly what it always was",
    seen(readyFirst([native("anthropic", "claude"), routable("openrouter")])),
    ["anthropic", "openrouter"],
  );
  check(
    "and a provider the chosen harness will collapse sinks under one it can run",
    seen(readyFirst([native("anthropic", "claude"), routable("openrouter")], "opencode", OPEN_ROUTING)),
    ["openrouter", "anthropic"],
  );
  check(
    "the native harness still floats its own provider, which is the case this must not break",
    seen(readyFirst([routable("openrouter"), native("anthropic", "claude")], "claude", null)),
    ["anthropic", "openrouter"],
  );
  check(
    "and a collapsed provider keeps its rows rather than being filtered out",
    readyFirst([native("anthropic", "claude"), routable("openrouter")], "opencode", OPEN_ROUTING).length,
    2,
  );
  check(
    "and `allModels` is where the harness reaches it, so the menu and the list agree",
    /readyFirst\(out, harness,/.test(
      stripComments(readFileSync(new URL("../src/agents.ts", import.meta.url), "utf8")),
    ),
    true,
  );
  // The ready provider is second on purpose: leading, `some` and `every` give the same list.
  check(
    "one runnable model is enough to float a provider",
    readyFirst([
      provider("dead", false, "table", "m1"),
      provider("mixed", false, "table", "m1"),
      provider("mixed", false, "published", "m2"),
    ]).map((one) => one.modelId),
    ["mixed/m1", "mixed/m2", "dead/m1"],
  );
  check(
    "and a provider with none of them stays below one that has",
    seen(
      readyFirst([
        provider("dead", false, "table", "m1"),
        provider("dead", false, "table", "m2"),
        provider("live", true, "table"),
      ]),
    ),
    ["live", "dead"],
  );
  check(
    "the models inside a provider keep their own order",
    readyFirst([
      provider("late", false, "table", "m1"),
      provider("late", false, "table", "m2"),
      provider("late", false, "table", "m3"),
      provider("early", true, "table", "x"),
    ]).map((one) => one.modelId),
    ["early/x", "late/m1", "late/m2", "late/m3"],
  );
  // Three providers: at two, a hardcoded offset is indistinguishable from the provider count.
  check(
    "the unready half sinks whole, below a ready provider that came after both",
    seen(
      readyFirst([
        provider("p1", false, "table"),
        provider("p2", false, "table"),
        provider("p3", true, "table"),
      ]),
    ),
    ["p3", "p1", "p2"],
  );
  check("an empty catalogue answers an empty one", readyFirst([]), []);
  {
    const sunk = system({ id: "sunk", displayName: "Sunk", nativeHarness: null, keySet: false });
    const risen = system({ id: "risen", displayName: "Risen", nativeHarness: null, keySet: true });
    check(
      "the catalogue is handed out floated, so both lists drawn from it agree",
      [
        seen(allModels([sunk, risen], {} as never)),
        groupModels(allModels([sunk, risen], {} as never)).map((group) => group.system.id),
      ],
      [
        ["risen", "sunk"],
        ["risen", "sunk"],
      ],
    );
  }
  const openRouterRows = many(40, "qwen");
  const orGroup = groupModels(openRouterRows)[0];
  const codexRouting = { providerId: "custom-gateway", supported: ["openai"] } as never;
  check(
    "a whole provider refuses in one line, however many rows it has",
    [
      hostable("codex", orGroup?.system as never, codexRouting),
      openRouterRows.filter((one) => choiceRefusal("codex", one, codexRouting) !== null).length,
      openRouterRows.length,
    ],
    ["Codex cannot run OpenRouter models.", 40, 40],
  );
  check(
    "while the harness it is native to hides none of it",
    hostable("opencode", orGroup?.system as never, null),
    null,
  );
  const orTable = or("qwen/qwen3-coder", "Qwen3 Coder");
  const orPublished = { ...orTable, source: "published" as const };
  check(
    "a system that relates its spellings refuses neither harness for the name",
    [
      choiceRefusal("opencode", orTable, null),
      choiceRefusal("claude", { ...orTable, system: { ...orTable.system, routable: true } }, claude),
      choiceRefusal("opencode", orPublished, null),
    ],
    [null, null, null],
  );
  check(
    "while a system that does not still refuses, on the same shape",
    [choiceRefusal("kimi", tabled, null), choiceRefusal("claude", published, claude)],
    ["Kimi Code has no model called K2.", "Claude Code has no model called K3."],
  );
  const orSystem = system({ id: "openrouter", displayName: "OpenRouter", nativeHarness: "opencode", nativeModelPrefix: "openrouter/", models: [{ id: "qwen/q3", name: "Qwen: Q3" }] });
  const merged = allModels([orSystem], {
    opencode: { models: [{ id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null }], routing: null, error: null },
  } as never);
  check(
    "one model published and tabled is one row, keyed the published way and named the table's",
    merged.map((one) => `${one.modelId} | ${one.modelName} | ${one.source}`),
    ["qwen/q3 | Qwen: Q3 | published"],
  );

  // `readOpenRouterModels` drops tool-less models; a published row must not bring one back (Q3.520).
  {
    const published = {
      opencode: {
        models: [
          { id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null },
          { id: "openrouter/nous/hermes", name: "OpenRouter/Hermes", description: null, group: null },
        ],
        routing: null,
        error: null,
      },
    } as never;
    check(
      "a published model the catalogue refused for having no tools is not offered",
      allModels([{ ...orSystem, models: [] }], published, ["nous/hermes"]).map((one) => one.modelId),
      ["qwen/q3"],
    );
    check(
      "and with no catalogue read at all, nothing is dropped",
      allModels([{ ...orSystem, models: [] }], published).map((one) => one.modelId),
      ["qwen/q3", "nous/hermes"],
    );
    check(
      "keyed on the id the catalogue uses, not the one the harness prefixes",
      allModels([{ ...orSystem, models: [] }], published, ["openrouter/nous/hermes"]).map((one) => one.modelId),
      ["qwen/q3", "nous/hermes"],
    );
  }
  const zenSystem = system({ id: "zen", displayName: "OpenCode Zen", routable: false, nativeHarness: "opencode", nativeModelPrefix: "opencode/", models: [] });
  const zenNamed = (displayName: string, name: string) =>
    allModels([{ ...zenSystem, displayName }], {
      opencode: { models: [{ id: "opencode/big-pickle", name, description: null, group: null }], routing: null, error: null },
    } as never).map((one) => `${one.modelId} | ${one.modelName}`);
  check(
    "a published model the table has never heard of loses the provider's label",
    zenNamed("OpenCode Zen", "OpenCode Zen/Big Pickle"),
    // Stored unprefixed; `pinNativeModel` puts the prefix back when the agent is asked.
    ["big-pickle | Big Pickle"],
  );
  check(
    "and so does an OpenRouter row the tools filter dropped",
    allModels([system({ id: "openrouter", displayName: "OpenRouter", nativeHarness: "opencode", nativeModelPrefix: "openrouter/", models: [] })], {
      opencode: { models: [{ id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null }], routing: null, error: null },
    } as never).map((one) => `${one.modelId} | ${one.modelName}`),
    ["qwen/q3 | Q3"],
  );
  check(
    "it fails open on every rename, and folds case and nothing else",
    [
      zenNamed("Zen", "OpenCode Zen/Big Pickle"),
      zenNamed("OpenCode Zen", "opencode zen/Big Pickle"),
      zenNamed("OpenCode Zen", "OpenCode Zen /Big Pickle"),
      zenNamed("OpenCode Zen", "Big Pickle"),
      zenNamed("", "/Big Pickle"),
    ],
    [
      ["big-pickle | OpenCode Zen/Big Pickle"],
      ["big-pickle | Big Pickle"],
      ["big-pickle | OpenCode Zen /Big Pickle"],
      ["big-pickle | Big Pickle"],
      ["big-pickle | /Big Pickle"],
    ],
  );
  check(
    "an empty remainder keeps the name, and a live one is trimmed",
    [zenNamed("OpenCode Zen", "OpenCode Zen/"), zenNamed("OpenCode Zen", "OpenCode Zen/   "), zenNamed("OpenCode Zen", "OpenCode Zen/  Big Pickle ")],
    [
      ["big-pickle | OpenCode Zen/"],
      ["big-pickle | OpenCode Zen/   "],
      ["big-pickle | Big Pickle"],
    ],
  );
  check(
    "a harness that does not prefix its names is untouched",
    allModels([system({ displayName: "Moonshot", nativeHarness: "kimi", models: [] })], {
      kimi: { models: [{ id: "kimi-code/k3", name: "K3", description: null, group: null }], routing: null, error: null },
    } as never).map((one) => `${one.modelId} | ${one.modelName}`),
    ["kimi-code/k3 | K3"],
  );
  check(
    "and the preset a stripped row would be called is the short name",
    defaultAgentName(zenNamed("OpenCode Zen", "OpenCode Zen/Big Pickle")[0]?.split(" | ")[1] ?? ""),
    defaultAgentName("Big Pickle"),
  );
  // Driven over both systems at once, because either alone passes by luck.
  const bothPublished = {
    opencode: {
      models: [
        { id: "openrouter/qwen/q3", name: "OpenRouter/Q3", description: null, group: null },
        { id: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle", description: null, group: null },
      ],
      routing: null,
      error: null,
    },
  } as never;
  check(
    "a published list is divided between the systems that share its harness",
    allModels([{ ...orSystem, models: [] }, zenSystem], bothPublished).map(
      (one) => `${one.system.id}: ${one.modelId}`,
    ),
    ["openrouter: qwen/q3", "zen: big-pickle"],
  );
  check(
    "while a system that claims no prefix still takes the whole list",
    allModels([system({ models: [] })], {
      kimi: { models: [{ id: "kimi-code/k3", name: "K3", description: null, group: null }, { id: "plain", name: "P", description: null, group: null }], routing: null, error: null },
    } as never).map((one) => one.modelId),
    ["kimi-code/k3", "plain"],
  );
  const caps3 = { claude: { models: [], routing: claude, error: null }, codex: { models: [], routing: codex, error: null }, kimi: { models: [], routing: null, error: null } };
  check(
    "a model published by a CLI is that CLI's alone",
    supportingHarnesses(published, caps3 as never),
    ["kimi"],
  );
  check(
    "and one the endpoint answers to belongs to whatever can be routed there",
    supportingHarnesses(tabled, caps3 as never),
    ["claude"],
  );
  check(
    "and a missing key changes none of it",
    supportingHarnesses({ ...tabled, system: system({ keySet: false }) }, caps3 as never),
    ["claude"],
  );
  const withPlugin = {
    ...caps3,
    "acme:gemini": { models: [], routing: { providerId: "g", supported: ["anthropic"], pinsModel: true }, error: null },
  };
  const offeredHarnesses = ["claude", "kimi", "codex", "opencode", "acme:gemini"];
  check(
    "a harness a plugin added draws its glyph on the rows it can run",
    supportingHarnesses(tabled, withPlugin as never, offeredHarnesses),
    ["claude", "acme:gemini"],
  );
  check(
    "and a model only it can run is not a row that says nothing",
    supportingHarnesses(
      { ...published, system: system({ nativeHarness: "acme:gemini", routable: false }) },
      withPlugin as never,
      offeredHarnesses,
    ),
    ["acme:gemini"],
  );
  check(
    "while the default is still the five this product ships, in their own order",
    supportingHarnesses(tabled, withPlugin as never),
    ["claude"],
  );
  check(
    "a search reaches the provider's name as well as the model's",
    searchModels([published, tabled], "moonshot", null).length,
    2,
  );
  check("and narrows to one system", searchModels([published, tabled], "", "anthropic"), []);
  check("with whitespace meaning no query at all", searchModels([published, tabled], "   ", null).length, 2);

  // A name missing from a harness's list and a protocol it does not speak are two sentences (Q3.483).
  check(
    "a name collision says which name is missing, in both directions",
    [choiceRefusal("kimi", tabled, null), choiceRefusal("claude", published, claude)],
    ["Kimi Code has no model called K2.", "Claude Code has no model called K3."],
  );
  check(
    "while a protocol nothing can change keeps the older sentence",
    choiceRefusal("codex", tabled, codex),
    "Codex cannot run K2.",
  );
  // Nothing on the wire relates the two name lists, so a refusal names the missing name and stops (Q3.488).
  check(
    "and it mentions neither the system nor a row it did not look for",
    /Moonshot|another name|this model|only/i.test(choiceRefusal("kimi", tabled, null) ?? ""),
    false,
  );
  check(
    "a harness row drops the harness, and the two failures do not share a subline",
    [harnessRowRefusal("kimi", tabled, null), harnessRowRefusal("codex", tabled, codex)],
    ["No model called K2.", "Cannot run K2."],
  );
  check(
    "and a spelling and a protocol never read alike on the same screen",
    harnessRowRefusal("kimi", tabled, null) === harnessRowRefusal("codex", tabled, codex),
    false,
  );
  // A codex speaking this protocol exists only in this fixture, so two rows can share one situation.
  const codexToo = { providerId: "custom-gateway", supported: ["anthropic", "openai"] };
  check(
    "while two rows that *are* in the same situation still read identically",
    [harnessRowRefusal("claude", published, claude), harnessRowRefusal("codex", published, codexToo)],
    ["No model called K3.", "No model called K3."],
  );
  check("and says nothing at all where it can", harnessRowRefusal("claude", tabled, claude), null);
  check("nor before a model has been chosen", harnessRowRefusal("claude", null, claude), null);
  const everyRefusal: (string | null)[] = [
    hostable("codex", system(), codex),
    hostable("kimi", system({ nativeHarness: "claude" }), null),
    hostable("claude", system({ routable: false }), claude),
    hostable("claude", system({ routable: false, nativeHarness: null }), claude),
    choiceRefusal("kimi", tabled, null),
    choiceRefusal("claude", published, claude),
    choiceRefusal("codex", tabled, codex),
    choiceRefusal("claude", { ...tabled, system: unkeyed }, claude),
    choiceRefusal(null, { ...tabled, system: system({ nativeHarness: null, keySet: false }) }, null),
    harnessRowRefusal("kimi", tabled, null),
    harnessRowRefusal("codex", tabled, codex),
    harnessRowRefusal("claude", { ...tabled, system: unkeyed }, claude),
    keyMissing({ ...tabled, system: unkeyed }, "claude"),
  ];
  check("every refusal this screen can draw is a sentence", everyRefusal.filter((why) => why === null || !why.endsWith(".")), []);
  check("and none of them is written for a developer", everyRefusal.filter((why) => !noJargon(why)), []);
  check(
    "and none of them prints an id where a name goes",
    everyRefusal.filter((why) => (why ?? "").includes(published.modelId) || (why ?? "").includes(tabled.modelId)),
    [],
  );
  check(
    "a search reaches the provider's name as well as the model's",
    searchModels([published, tabled], "moonshot", null).length,
    2,
  );
  check("and narrows to one system", searchModels([published, tabled], "", "anthropic"), []);
  check("with whitespace meaning no query at all", searchModels([published, tabled], "   ", null).length, 2);
  check(
    "a native system's models come from its own harness",
    listed.filter((one) => one.system.id === "anthropic").map((one) => `${one.modelId}:${one.source}`),
    ["opus:published"],
  );
  check(
    "and a routed one's from the table",
    listed.filter((one) => one.system.id === "moonshot").map((one) => `${one.modelId}:${one.source}`),
    ["kimi-k2-thinking:table"],
  );
  const both = allModels(
    [system()],
    { kimi: { models: [{ id: "kimi-k2-thinking", name: "K2", description: null, group: null }], routing: null, error: null } } as never,
  );
  check("a system that is both does not list its model twice", both.length, 1);

  check("a default name does not repeat the glyph", defaultAgentName("Kimi K2 Thinking"), "Kimi K2 Thinking");
  check(
    "a tile's subline is the system",
    customAgentSubline(
      { id: "ca_1", name: "n", harness: "claude", system: "moonshot", model: "kimi-k2-thinking", createdAt: 0 },
      [system()],
    ),
    "Moonshot",
  );
  check(
    "and falls back to the id when the daemon has forgotten it",
    customAgentSubline(
      { id: "ca_1", name: "n", harness: "claude", system: "gone", model: "m", createdAt: 0 },
      [system()],
    ),
    "gone",
  );
}

process.stdout.write("\na model id typed rather than listed\n");
{
  const { adoptModels, allModels, choiceRefusal, groupModels, supportingHarnesses } = await import("../src/agents.js");

  const system = (over: Partial<SystemInfo> = {}): SystemInfo => ({
    id: "moonshot",
    displayName: "Moonshot",
    apiType: "anthropic",
    routable: true,
    nativeHarness: "kimi",
    loginVia: "kimi",
    models: [],
    keySet: true,
    keyUpdatedAt: 1,
    ...over,
  });
  const claude = { providerId: "main", supported: ["anthropic", "bedrock", "vertex"] };
  const kimiPublishes = (id: string, name: string) =>
    ({ kimi: { models: [{ id, name, description: null, group: null }], routing: null, error: null } }) as never;
  const none = {} as never;

  // The typed id is substituted into the listing rather than being a third `source` (Q3.501).
  const typed = allModels(adoptModels([system()], [{ system: "moonshot", model: "kimi-k2.7-code-highspeed" }]), none);
  check(
    "a typed id under a routable system is exactly one table row, named by its id",
    typed.map((one) => [one.system.id, one.modelId, one.modelName, one.source]),
    [["moonshot", "kimi-k2.7-code-highspeed", "kimi-k2.7-code-highspeed", "table"]],
  );
  check(
    "trimmed, and an empty one is not a row",
    allModels(adoptModels([system()], [{ system: "moonshot", model: "  kimi-k3 " }, { system: "moonshot", model: "   " }]), none).map((one) => one.modelId),
    ["kimi-k3"],
  );
  check(
    "one the table already names is not carried twice, and the table's name stands",
    allModels(adoptModels([system({ models: [{ id: "kimi-k3", name: "Kimi K3" }] })], [{ system: "moonshot", model: "kimi-k3" }]), none).map((one) => `${one.modelId}:${one.modelName}`),
    ["kimi-k3:Kimi K3"],
  );
  check(
    "and nor is the same id typed twice",
    adoptModels([system()], [{ system: "moonshot", model: "x" }, { system: "moonshot", model: "x" }])[0]?.models.length,
    1,
  );
  check(
    "a system it was not typed under is the same object it was",
    adoptModels([system(), system({ id: "zhipu", displayName: "Z.ai (GLM)", nativeHarness: null, loginVia: null })], [{ system: "moonshot", model: "kimi-k3" }])[1] ===
      undefined
      ? "lost"
      : "kept",
    "kept",
  );
  const dedupe = allModels(adoptModels([system()], [{ system: "moonshot", model: "kimi-k3" }]), kimiPublishes("kimi-k3", "K3"));
  check(
    "one a harness also publishes dedupes to one row: published wins the row, the typed id the name",
    dedupe.map((one) => [one.modelId, one.modelName, one.source]),
    [["kimi-k3", "kimi-k3", "published"]],
  );
  check("and that row needs no key", choiceRefusal(null, dedupe[0]!, null), null);
  const unkeyed = allModels(adoptModels([system({ keySet: false })], [{ system: "moonshot", model: "kimi-k3" }]), none)[0]!;
  check("with no key saved it is greyed by the no-key sentence", choiceRefusal(null, unkeyed, null), "No Moonshot key on this machine.");
  check("and with one it is not", choiceRefusal(null, typed[0]!, null), null);
  check("the native harness is refused it for the name", choiceRefusal("kimi", typed[0]!, null), "Kimi Code has no model called kimi-k2.7-code-highspeed.");
  check("and a routed harness may use it", choiceRefusal("claude", typed[0]!, claude), null);
  check(
    "which is what the row's own glyphs say",
    supportingHarnesses(typed[0]!, { claude: { models: [], routing: claude, error: null } } as never, ["claude", "kimi"]),
    ["claude"],
  );
  check("and it sits in its provider's group like any other row", groupModels(typed).map((one) => [one.system.id, one.choices.length]), [["moonshot", 1]]);
  check(
    "no row where the system is not routable, and none where an older daemon never said",
    [
      adoptModels([system({ id: "anthropic", displayName: "Anthropic", routable: false, nativeHarness: "claude", loginVia: "claude" })], [{ system: "anthropic", model: "claude-opus-5" }])[0]?.models,
      adoptModels([system({ routable: undefined })], [{ system: "moonshot", model: "kimi-k3" }])[0]?.models,
    ],
    [[], []],
  );

  const stored = { system: "moonshot", model: "kimi-k2-thinking" };
  const before = allModels([system({ models: [{ id: "kimi-k3", name: "Kimi K3" }] })], none);
  const after = allModels(adoptModels([system({ models: [{ id: "kimi-k3", name: "Kimi K3" }] })], [stored]), none);
  check(
    "a stored model no list holds is absent from the catalogue as listed, and present once adopted",
    [
      before.some((one) => one.system.id === stored.system && one.modelId === stored.model),
      after.filter((one) => one.system.id === stored.system && one.modelId === stored.model).map((one) => `${one.modelName}:${one.source}`),
    ],
    [false, ["kimi-k2-thinking:table"]],
  );

  const builder = stripComments(readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8"));
  const between = (from: string, to: string): string => {
    const start = builder.indexOf(from);
    if (start === -1) return "";
    const end = builder.indexOf(to, start + from.length);
    return end === -1 ? "" : builder.slice(start, end);
  };
  const listed = between("const listed = useMemo(", "const catalogueAsListed");
  const orphan = between("const catalogue = useMemo(", "const openRouterLine");
  const field = between("<TypedModel", "/>");
  check("the three regions were found", [listed.length > 0, orphan.length > 0, field.length > 0], [true, true, true]);
  check(
    "a typed id is substituted into the listing at the OpenRouter site, and `allModels` is not told",
    [/adoptModels\(read, typed\)/.test(listed), /OPENROUTER_SYSTEM_ID/.test(listed), /allModels/.test(listed)],
    [true, true, false],
  );
  check(
    "and a stored pick is adopted only when the catalogue as listed does not hold it",
    [/catalogueAsListed\.some\(/.test(orphan), /adoptModels\(listed, \[picked\]\)/.test(orphan), /return catalogueAsListed;[\s\S]*adoptModels/.test(orphan)],
    [true, true, true],
  );
  check(
    "Save is still gated on `current`, which is a lookup in that catalogue",
    [/disabled=\{busy \|\| current === null/.test(builder), /catalogue\.find\(/.test(builder)],
    [true, true],
  );
  check(
    "the field is drawn only where the daemon said `routable`, and the id is bounded on the field",
    [
      /group\.system\.routable === true && \(\s*<TypedModel/.test(builder),
      (builder.match(/<TypedModel/g) ?? []).length,
      /maxLength=\{MAX_MODEL_CHARS\}/.test(builder),
    ],
    [true, 1, true],
  );
  const daemon = readFileSync(new URL("../../../src/server.ts", import.meta.url), "utf8");
  check(
    "and the bound is the daemon's",
    [builder.match(/const MAX_MODEL_CHARS = (\d+);/)?.[1] ?? null, daemon.match(/const MAX_MODEL_CHARS = (\d+);/)?.[1] ?? null],
    ["256", "256"],
  );
  check(
    "typing reports the id and nothing else: no pick, no name, no navigation",
    [/onType=\{\(system, model\) =>\s*setTyped\(/.test(builder), (builder.match(/setPicked\(/g) ?? []).length],
    [true, 3],
  );
}
