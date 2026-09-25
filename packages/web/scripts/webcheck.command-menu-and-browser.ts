import { readFileSync, readdirSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { srcFile, srcFiles, stripComments } from "./webcheck.source.js";
import { snapshot, workspaceAt } from "./webcheck.ws.js";
import { storage } from "./webcheck.env.js";
import type { MachineId } from "../src/ids.js";
import {
  LOCAL_DISPLAY_NAME,
  MAX_MACHINE_ORDER,
  RANK_STEP,
  dropSlot,
  allRows,
  canReorder,
  commandsPlan,
  configProse,
  currentView,
  displayCwd,
  effectiveRank,
  folderLabel,
  folderNames,
  folderPathOf,
  foldersOf,
  groupsVersion,
  localMachineAfter,
  machineDisplayName,
  machinesAsDrawn,
  machineTabs,
  nextOrder,
  orderMachines,
  matchesQuery,
  orderSessions,
  rankBetween,
  resolveDrop,
  rowSubpath,
  selectMachine,
  selectedMachineIn,
  sessionGroups,
  setMachineOrder,
  sessionLabel,
  setQuery,
  siblingsOf,
  toggleFolder,
  visibleRows,
} from "./webcheck.modules.js";

// Tailwind v4 emits utilities alphabetically, so a utility appended to a shared class string (MENU_ROW, menuRow) never overrides one it already sets.
process.stdout.write("\nwhat a call site may append to a shared class string\n");
{
  const WEB_SRC = new URL("../src/", import.meta.url);
  const sources: { file: string; text: string }[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        sources.push({
          file: `${prefix}${entry.name}`,
          text: readFileSync(new URL(entry.name, dir), "utf8"),
        });
      }
    }
  };
  walk(WEB_SRC, "");

// `(?<![\w:-])` excludes variants such as `sm:hidden`, which do win over their bare form.
  const FAMILIES: [string, RegExp][] = [
    ["align-items", /(?<![\w:-])items-(?:start|end|center|baseline|stretch)\b/g],
    ["justify-content", /(?<![\w:-])justify-(?:start|end|center|between|around|evenly)\b/g],
    ["font-size", /(?<![\w:-])text-(?:2xs|xs|sm|base|lg|xl|2xl|3xl)\b/g],
    ["display", /(?<![\w:-])(?:flex|grid|block|inline-flex|inline-block|hidden)\b/g],
    ["white-space", /(?<![\w:-])whitespace-[a-z-]+\b/g],
    ["text-align", /(?<![\w:-])text-(?:left|center|right)\b/g],
  ];
  const familiesOf = (text: string): Map<string, string[]> => {
    const found = new Map<string, string[]>();
    for (const [name, pattern] of FAMILIES) {
      const hits = [...new Set(text.match(pattern) ?? [])];
      if (hits.length > 0) found.set(name, hits);
    }
    return found;
  };

  const defined = new Map<string, { where: string; sets: Map<string, string[]> }>();
  const CONST_DEF = /export const ([A-Z][A-Z0-9_]*)\s*=\s*(`[^`]*`|"[^"]*")/g;
  const FN_DEF = /export function ([a-z][A-Za-z0-9]*)\([^)]*\): string \{([\s\S]*?)\n\}/g;
  for (const { file, text } of sources) {
    for (const match of text.matchAll(CONST_DEF)) {
      const sets = familiesOf(match[2] ?? "");
      if (sets.size > 0) defined.set(match[1] ?? "", { where: file, sets });
    }
    for (const match of text.matchAll(FN_DEF)) {
      const sets = familiesOf(match[2] ?? "");
      if (sets.size > 0) defined.set(match[1] ?? "", { where: file, sets });
    }
  }

  // `[^`]*` assumes no call site nests a template literal inside another.
  const clashes: string[] = [];
  let sites = 0;
  const names = [...defined.keys()];
  if (names.length > 0) {
    const CALL = new RegExp(`\\$\\{(${names.join("|")})(?:\\([^)]*\\))?\\}([^\`]*)`, "g");
    for (const { file, text } of sources) {
      for (const match of text.matchAll(CALL)) {
        const def = defined.get(match[1] ?? "");
        if (def === undefined) continue;
        sites += 1;
        const added = familiesOf(match[2] ?? "");
        for (const [family, addedHits] of added) {
          const ownHits = def.sets.get(family);
          if (ownHits === undefined) continue;
          // Any overlap in the family is a clash, even when the shared string already names the same member.
          clashes.push(`${file}: ${match[1]} decides ${family} (${ownHits.join("/")}), the call site adds ${addedHits.join("/")}`);
        }
      }
    }
  }

  check("the sweep found the shared class strings", defined.size >= 5, true);
  check("and found call sites interpolating them", sites >= 10, true);
  check("no call site appends a utility the shared string already decides", clashes, []);
}

process.stdout.write("\nthe composer's command menu\n");
{
  const { slashQuery, buildCommands, filterCommands, completion, configChoices, choiceRuns, typeableName, commandScope, typedConfigCommand } =
    await import("../src/ui/commands.js");

  check("an agent's own camelCase survives", typeableName("acceptEdits"), "acceptEdits");
  check("and so does the longest real one", typeableName("bypassPermissions"), "bypassPermissions");
  check("what could not be typed as one token is replaced", typeableName("something new!"), "something-new");
  check("separators never dangle", typeableName("  --weird--  "), "weird");
  check("and a name with nothing left is no name at all", typeableName("!!!"), null);

  check("a bare slash opens an empty query", slashQuery("/", 1), { start: 0, query: "" });
  check("and typing filters it", slashQuery("/mo", 3), { start: 0, query: "mo" });
  check("the caret decides how much is the query", slashQuery("/model", 3), { start: 0, query: "mo" });
  check("a path is not a command", slashQuery("cd /usr", 7), null);
  check("nor is a slash after a newline", slashQuery("hi\n/model", 9), null);
  check("nor one after a space", slashQuery(" /model", 7), null);
  check("a space ends the name, and the menu with it", slashQuery("/model ", 7), null);
  check("as does an argument", slashQuery("/model sonnet", 13), null);
  check("empty text has no query", slashQuery("", 0), null);
  check("and a caret before the slash has none either", slashQuery("/mo", 0), null);

  const reconstruct = (text: string, caret: number): string | null => {
    const found = slashQuery(text, caret);
    return found === null ? null : text.slice(found.start, found.start + 1 + found.query.length);
  };
  check("the query round-trips out of the text", reconstruct("/model", 4), "/mod");

  // Model, effort and mode commands are synthesized by category, never by id: kimi publishes none of them.
  const option = (id: string, category: string | null, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    description: null,
    category,
    kind: "select",
    value: id,
    // Named after the option so a mode fixture's lone choice collides with `/mode` and expands to nothing.
    choices: [{ value: id, name: id, description: null, group: null }],
    ...over,
  });

  const claudeConfig = { modes: null, options: [option("mode", "mode"), option("model", "model"), option("effort", "thought_level")] };
  const kimiConfig = { modes: null, options: [option("mode", "mode"), option("model", "model"), option("thinking", "thought_level")] };
  const kimiCommands = [
    { name: "compact", description: "Compact the conversation context", hint: "<optional instructions>" },
    { name: "status", description: "Show current session status", hint: null },
    { name: "usage", description: "Show session token usage", hint: null },
    { name: "mcp", description: "Show MCP server status", hint: null },
    { name: "tasks", description: "List background tasks", hint: null },
    { name: "help", description: "Show available ACP commands", hint: null },
  ];

  const onKimi = buildCommands(kimiCommands as never, kimiConfig as never);
  check(
    "kimi gets /model, /effort and /mode though it publishes none of them",
    onKimi.filter((e) => e.kind === "config").map((e) => e.name),
    ["mode", "model", "effort"],
  );
  check(
    "and claude gets the same three from differently-named ids",
    buildCommands([] as never, claudeConfig as never).map((e) => e.name),
    ["mode", "model", "effort"],
  );
  const kimiEffort = onKimi.find((e) => e.name === "effort");
  check("and on kimi the effort row does not describe itself as Thinking", kimiEffort?.description, "Effort");
  check("kimi's own commands keep the agent's order", onKimi.filter((e) => e.kind === "prompt").map((e) => e.name), [
    "compact",
    "status",
    "usage",
    "mcp",
    "tasks",
    "help",
  ]);

  const odd = buildCommands([] as never, {
    modes: null,
    options: [option("fast", "model_config"), option("something new!", "unheard_of")],
  } as never);
  check("a hidden category gets no command", odd.map((e) => e.name), ["something-new"]);

  const shadowed = buildCommands(
    [{ name: "model", description: "Change the model", hint: null }, { name: "compact", description: "Compact", hint: null }] as never,
    claudeConfig as never,
  );
  check("a control shadows an identically-named command", shadowed.filter((e) => e.name === "model").map((e) => e.kind), ["config"]);
  check("and the shadowed one is dropped, never offered twice", shadowed.map((e) => e.name), ["mode", "model", "effort", "compact"]);

  const withModes = {
    modes: null,
    options: [
      option("mode", "mode", {
        value: "default",
        choices: [
          { value: "default", name: "Manual", description: "Standard behavior", group: null },
          { value: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution", group: null },
          { value: "acceptEdits", name: "Accept Edits", description: null, group: null },
        ],
      }),
    ],
  };
  const modal = buildCommands([] as never, withModes as never);
  check("every mode becomes a command of its own", modal.map((e) => e.name), [
    "mode",
    "default",
    "plan",
    "acceptEdits",
  ]);
  check(
    "named by the agent's id, which is what a person types",
    modal.find((e) => e.name === "default")?.value,
    "default",
  );
  check("a mode carries the value it applies", modal.find((e) => e.name === "plan")?.value, "plan");
  check("while the control itself opens its choices", modal.find((e) => e.name === "mode")?.value, null);
  check(
    "and it explains itself with the agent's own sentence",
    modal.find((e) => e.name === "plan")?.description,
    "Planning mode, no actual tool execution",
  );
  check(
    "falling back to the choice's name",
    modal.find((e) => e.name === "acceptEdits")?.description,
    "Accept Edits",
  );

  const contested = buildCommands(
    [{ name: "plan", description: "Write an implementation plan", hint: null }] as never,
    withModes as never,
  );
  const typedMode = typedConfigCommand("/plan", modal as never);
  check("a typed mode shortcut is recognised", typedMode?.entry.name, "plan");
  check("and carries the value it will apply", typedMode?.entry.value, "plan");
  check("with nothing left to send", typedMode?.rest, "");

  const withPrompt = typedConfigCommand("/plan I want to build a tg bot", modal as never);
  check("an argument after the name survives as the message", withPrompt?.rest, "I want to build a tg bot");
  check("and the mode is still what gets applied", withPrompt?.entry.value, "plan");
  // The message after the name is sent as the box sends one: the separator goes, the first line's indentation stays (Q3.646).
  check(
    "a message on the lines below keeps its indentation",
    typedConfigCommand("/plan\n    def f():\n        pass\n", modal as never)?.rest,
    "    def f():\n        pass",
  );
  check("while the spaces after the name are only its separator", typedConfigCommand("/plan   do it  ", modal as never)?.rest, "do it");

  check("a control with no value is recognised too", typedConfigCommand("/mode", modal as never)?.entry.value, null);

  check("a slash mid-message is not a command", typedConfigCommand("see /plan for details", modal as never), null);
  check("nor is a path", typedConfigCommand("/usr/bin/env", modal as never), null);
  check("an unknown name is left to the agent", typedConfigCommand("/compact", modal as never), null);
  const published = buildCommands(
    [{ name: "review", description: "Review the diff", hint: null }] as never,
    withModes as never,
  );
  check("a published command is never intercepted", typedConfigCommand("/review the auth code", published as never), null);

  check(
    "a published command keeps its name against a mode shortcut",
    contested.find((e) => e.name === "plan")?.kind,
    "prompt",
  );
  check("and the name is still offered exactly once", contested.filter((e) => e.name === "plan").length, 1);

  const modelly = buildCommands([] as never, {
    modes: null,
    options: [option("model", "model", { choices: [{ value: "opus[1m]", name: "Opus", description: null, group: null }] })],
  } as never);
  check("no other category is expanded into its values", modelly.map((e) => e.name), ["model"]);

  check("claude's scope suffix is read", commandScope("Router for the gstack suite. (gstack) (user)"), "user");
  check("project scope too", commandScope("Something. (project)"), "project");
  check("and anything else is simply unknown", commandScope("Compact the conversation context"), null);
  check("a bare word in parentheses is not a scope", commandScope("Does a thing (somehow)"), null);

  const mixed = buildCommands(
    [
      { name: "aaa-installed", description: "A skill. (gstack) (user)", hint: null },
      { name: "zzz-builtin", description: "Compact the conversation", hint: null },
      { name: "mmm-project", description: "Local one. (project)", hint: null },
      { name: "bbb-builtin", description: "Show status", hint: null },
    ] as never,
    undefined,
  );
  check("built-ins come first, and the agent's order decides inside each tier", mixed.map((e) => e.name), [
    "zzz-builtin",
    "bbb-builtin",
    "aaa-installed",
    "mmm-project",
  ]);
  check("nothing is alphabetised", mixed[0]?.name, "zzz-builtin");

  const restored = buildCommands([{ name: "help", description: "Help", hint: null }] as never, undefined, undefined, "claude");
  check("a hidden built-in the agent still accepts is restored", restored.map((e) => e.name), ["help", "clear"]);
  check(
    "and it says what it costs, since nothing else can",
    restored.find((e) => e.name === "clear")?.description.includes("transcript above stays"),
    true,
  );
  const cQuery = filterCommands(
    buildCommands(
      [
        { name: "compact", description: "Compact the conversation", hint: null },
        { name: "context", description: "Show context", hint: null },
      ] as never,
      undefined,
      undefined,
      "claude",
    ),
    "c",
  );
  check("and it does not outrank the reversible commands it shares a prefix with", cQuery.map((e) => e.name), [
    "compact",
    "context",
    "clear",
  ]);
  check("kimi is offered nothing it did not publish", buildCommands([] as never, undefined, undefined, "kimi"), []);
  check("and an unknown agent likewise", buildCommands([] as never, undefined, undefined, "nobody"), []);
  check(
    "a restored name is defended against a mode shortcut",
    buildCommands([] as never, {
      modes: null,
      options: [option("mode", "mode", { choices: [{ value: "clear", name: "Clear", description: null, group: null }] })],
    } as never, undefined, "claude").filter((e) => e.name === "clear").map((e) => e.kind),
    ["prompt"],
  );

  check("every name is unique", new Set(onKimi.map((e) => e.name)).size, onKimi.length);
  check(
    "a config entry always carries its option and a prompt entry never does",
    onKimi.every((e) => (e.kind === "config") === (e.option !== null)),
    true,
  );
  check(
    "and a value never travels without the option it belongs to",
    [...modal, ...contested, ...onKimi].every((e) => e.value === null || e.option !== null),
    true,
  );
  check("an older daemon still gets the agent's commands", buildCommands(kimiCommands as never, undefined).length, 6);
  check("and with nothing at all there is nothing to show", buildCommands([] as never, undefined), []);

  check("an empty query is the identity, order and all", filterCommands(onKimi, ""), onKimi);
  check("a name prefix, then a substring, then a description", filterCommands(onKimi, "us").map((e) => e.name), [
    "usage",
    "status",
    "mcp",
  ]);
  check("case does not matter", filterCommands(onKimi, "COMP").map((e) => e.name), ["compact"]);
  check(
    "a name prefix outranks a description match",
    filterCommands(onKimi, "mo").map((e) => e.name),
    ["mode", "model"],
  );
  check(
    "a segment prefix finds an mcp command",
    filterCommands(buildCommands([{ name: "mcp:github", description: "GitHub", hint: null }] as never, undefined), "github").map((e) => e.name),
    ["mcp:github"],
  );
  check("one character never matches a description", filterCommands(onKimi, "v").map((e) => e.name), []);
  check("but two do", filterCommands(onKimi, "token").map((e) => e.name), ["usage"]);
  check(
    "nothing is invented and nothing is copied",
    filterCommands(onKimi, "s").every((entry) => onKimi.includes(entry)),
    true,
  );

  const compact = onKimi.find((e) => e.name === "compact");
  check("choosing a command leaves it ready for arguments", completion("/comp", { start: 0, query: "comp" }, compact as never), {
    text: "/compact ",
    caret: 9,
  });
  const help = onKimi.find((e) => e.name === "help");
  check(
    "a command with a hint completes identically, because the hint is never inserted",
    completion("/he", { start: 0, query: "he" }, help as never).text,
    "/help ",
  );
  const model = onKimi.find((e) => e.name === "model");
  check("choosing a control clears the token instead", completion("/model", { start: 0, query: "model" }, model as never), {
    text: "",
    caret: 0,
  });

  const at = (text: string, caret: number, entry: unknown) =>
    completion(text, slashQuery(text, caret) as never, entry as never);
  check("a caret inside the name still completes the whole name", at("/compact", 4, compact), {
    text: "/compact ",
    caret: 9,
  });
  check("and the tail of the name is not left behind as an argument", at("/compact", 1, compact).text, "/compact ");
  check("a real argument past the caret survives", at("/compact now please", 3, compact).text, "/compact now please");
  check("a control mid-token clears all of it", at("/model", 3, model), { text: "", caret: 0 });
  check("and keeps what genuinely followed it", at("/model sonnet", 3, model).text, "sonnet");

  // Effort labels are read through adaptiveLabel, so the menu names them the way the chip does.
  const effort = option("effort", "thought_level", {
    choices: [
      { value: "default", name: "Default", description: null, group: null },
      { value: "high", name: "High", description: "Think hard", group: null },
    ],
  });
  check("the menu names adaptive effort the way the chip does", configChoices(effort as never).map((row) => row.label), [
    "Adaptive",
    "High",
  ]);
  check(
    "and explains it where there is room",
    configChoices(effort as never)[0]?.description,
    "The model decides how much to think, per turn",
  );

  const claudeMode = option("mode", "mode", {
    value: "default",
    choices: [{ value: "default", name: "Manual", description: null, group: null }],
  });
  const kimiMode = option("mode", "mode", {
    value: "default",
    choices: [
      { value: "default", name: "Default", description: "Manual approvals; tools execute normally.", group: null },
    ],
  });
  check("kimi goes on calling its mode what it calls it", configChoices(kimiMode as never).map((row) => row.label), ["Default"]);
  check("and so does claude", configChoices(claudeMode as never).map((row) => row.label), ["Manual"]);
  check(
    "kimi's own sentence is the one shown",
    configChoices(kimiMode as never)[0]?.description,
    "Manual approvals; tools execute normally.",
  );
  check(
    "while claude's silence is filled in rather than left blank",
    configChoices(claudeMode as never)[0]?.description,
    "The agent asks before running each tool",
  );

  const resumedModel = option("model", "model", {
    value: "claude-opus-5[1m]",
    choices: [
      { value: "opus", name: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks", group: null },
      {
        value: "claude-opus-5[1m]",
        name: "Opus 5 (1M context)",
        description: "Newer version available · select Opus for Opus 5.5",
        group: null,
      },
    ],
  });
  check(
    "the menu draws the CLI's own notice under the row's own name",
    configChoices(resumedModel as never)
      .filter((row) => row.value === "claude-opus-5[1m]")
      .map((row) => ({ label: row.label, description: row.description })),
    [{ label: "Opus 5 (1M context)", description: "Newer version available · select Opus for Opus 5.5" }],
  );

  const proseFor = configProse([
    {
      seq: 1,
      at: 0,
      event: {
        type: "agent_config",
        modes: null,
        options: [
          {
            id: "mode",
            name: "mode",
            description: "How the agent asks",
            category: "mode",
            kind: "select",
            value: "plan",
            choices: [
              { value: "plan", name: "Plan Mode", description: "Planning mode, no actual tool execution", group: null },
              { value: "auto", name: "Auto", description: null, group: null },
            ],
          },
        ],
      },
    },
  ] as never);
  const bare = option("mode", "mode", {
    value: "plan",
    choices: [
      { value: "plan", name: "Plan Mode", description: null, group: null },
      { value: "auto", name: "Auto", description: null, group: null },
    ],
  });
  check(
    "a choice with no description of its own is explained from the transcript",
    configChoices(bare as never, proseFor.get("mode")).map((row) => row.description),
    ["Planning mode, no actual tool execution", null],
  );
  check(
    "and so does the mode shortcut built from it",
    buildCommands([] as never, { modes: null, options: [bare] } as never, proseFor).find((e) => e.name === "plan")
      ?.description,
    "Planning mode, no actual tool execution",
  );
  check(
    "with the choice's own sentence still winning where it has one",
    buildCommands(
      [] as never,
      {
        modes: null,
        options: [
          option("mode", "mode", {
            value: "plan",
            choices: [{ value: "plan", name: "Plan Mode", description: "Its own words", group: null }],
          }),
        ],
      } as never,
      proseFor,
    ).find((e) => e.name === "plan")?.description,
    "Its own words",
  );

  check(
    "a boolean control is not offered as a command",
    buildCommands([] as never, {
      modes: null,
      options: [option("verbose", "output", { kind: "boolean", value: false, choices: [] })],
    } as never),
    [],
  );
  check(
    "nor is a select with nothing in it",
    buildCommands([] as never, {
      modes: null,
      options: [option("model", "model", { choices: [] })],
    } as never),
    [],
  );

  {
    const models = option("model", "model", {
      value: "openrouter/z-ai/glm-5.3-flash",
      choices: [
        { value: "openrouter/aion-labs/aion-2.0", name: "OpenRouter/Aion-2.0", description: null, group: null },
        { value: "openrouter/z-ai/glm-5.3-flash", name: "OpenRouter/GLM 5.3 Flash", description: null, group: null },
        { value: "openrouter/qwen/qwen3-coder", name: "OpenRouter/Qwen3 Coder", description: null, group: null },
      ],
    });
    const rows = configChoices(models as never);
    check(
      "the typed menu names the model and never the provider every row came from",
      rows.map((row) => [row.group, row.label]),
      [
        [null, "Aion-2.0"],
        [null, "GLM 5.3 Flash"],
        [null, "Qwen3 Coder"],
      ],
    );
    check(
      "and the values it would send are the agent's own, untouched",
      rows.map((row) => row.value),
      ["openrouter/aion-labs/aion-2.0", "openrouter/z-ai/glm-5.3-flash", "openrouter/qwen/qwen3-coder"],
    );
    // Runs are markup only: arrow keys, aria-activedescendant and scrolling count rows by their flat index in `choices`.
    check(
      "a model list with no heading of the agent's own is one run, renumbering nothing",
      choiceRuns(rows).map((run) => [run.group, run.items.map((item) => item.index)]),
      [[null, [0, 1, 2]]],
    );
    check(
      "an ungrouped list is one run, so the markup is what it always was",
      choiceRuns(configChoices(option("mode", "mode") as never)).map((run) => [
        run.group,
        run.items.length,
      ]),
      [[null, 1]],
    );
    check(
      "and nothing at all is no runs rather than one empty one",
      choiceRuns([]).length,
      0,
    );
    check(
      "a heading that comes back after another one is a second run",
      choiceRuns([
        { value: "a", label: "A", description: null, group: "One" },
        { value: "b", label: "B", description: null, group: "Two" },
        { value: "c", label: "C", description: null, group: "One" },
      ]).map((run) => [run.group, run.items.map((item) => item.index)]),
      [
        ["One", [0]],
        ["Two", [1]],
        ["One", [2]],
      ],
    );
  }
}

process.stdout.write("\nwhen to refetch the agent's commands\n");
{
  check("nothing held and the agent has published: fetch", commandsPlan(undefined, 3, false), "fetch");
  check("what is held is what the daemon says: leave it", commandsPlan(3, 3, false), "current");
  check("the daemon has moved on: fetch again", commandsPlan(3, 4, false), "fetch");

  // `!==`, never `>`: a restarted daemon resets the revision to 0, so a higher held revision is the stale one.
  check("a restarted daemon's zero drops what is held", commandsPlan(5, 0, false), "drop");
  check("and so does an older daemon that sends nothing at all", commandsPlan(5, undefined, false), "drop");
  check("with nothing held, dropping is still the answer", commandsPlan(undefined, 0, false), "drop");

  check("a bump during a fetch is remembered", commandsPlan(undefined, 6, true), "defer");
  check("and so is one that arrives while a stale list is held", commandsPlan(5, 6, true), "defer");
  check("but a fetch in flight for what is held is not", commandsPlan(6, 6, true), "current");
  check("and a drop is not deferred behind one either", commandsPlan(5, 0, true), "drop");
}

process.stdout.write("\nmachine groups\n");
{
  const row = (id: string, machine: string, over: Record<string, unknown>) => ({
    key: `${machine}/${id}`,
    ref: { machineId: machine, sessionId: id },
    machineName: machine,
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });
  const machineOf = (id: string, name: string) => ({
    id,
    name,
    reach: "online",
    offlineReason: null,
    route: null,
    tokenDegraded: false,
    scopes: [],
  });

  const rows = [
    row("blocked", "m_b", { status: "blocked", pendingPermissions: [{ raisedAt: 5, title: "Edit" }] }),
    row("live", "m_a", { status: "running", lastEventAt: 20 }),
    row("pinned", "m_a", { status: "running", lastEventAt: 1, pinned: true }),
    row("done", "m_a", { status: "exited", exit: { reason: "stopped" }, lastEventAt: 30 }),
  ];
  const machines = [machineOf("m_b", "beta"), machineOf("m_a", "alpha"), machineOf("m_c", "gamma")];
  const state = { sessions: rows, machines } as never;

  const groups = sessionGroups(state);

  const beta = groups.groups.find((g: { id: string }) => g.id === "m_b")!;
  check("a blocked row sits in its own machine's section", beta.active.map((r: { key: string }) => r.key), ["m_b/blocked"]);
  check("and the header counts it, so collapsing cannot hide it", beta.blockedCount, 1);
  const alpha = groups.groups.find((g: { id: string }) => g.id === "m_a")!;
  check("a machine with nothing waiting counts zero", alpha.blockedCount, 0);

  check("a pinned row is in the pinned group", groups.pinned.map((r: { key: string }) => r.key), ["m_a/pinned"]);
  check("and is no longer under its own machine", alpha.active.map((r: { key: string }) => r.key), ["m_a/live"]);

  check("sections are ordered by name", groups.groups.map((g: { name: string }) => g.name), ["alpha", "beta", "gamma"]);
  check("a machine with no sessions still gets one", groups.groups.find((g: { id: string }) => g.id === "m_c") !== undefined, true);

  check("the derivation is memoised by identity", sessionGroups(state) === groups, true);
  check("and a transcript-only change does not invalidate it", sessionGroups({ ...(state as object), transcripts: new Map() } as never) === groups, true);

  const orphaned = sessionGroups({ sessions: [row("lost", "m_gone", {})], machines: [] } as never);
  check("a row with no granted machine becomes an orphan", orphaned.orphans.length, 1);

  // Keep below the memoisation checks: sessionGroups memoises in module state, so an earlier call breaks the identity assertions.
  const pinnedBlocked = sessionGroups({
    sessions: [
      row("pb", "m_a", { status: "blocked", pendingPermissions: [{ raisedAt: 5, title: "Edit" }], pinned: true }),
    ],
    machines: [machineOf("m_a", "alpha")],
  } as never);
  check("a pinned blocked row is in the pinned group", pinnedBlocked.pinned.map((r: { key: string }) => r.key), ["m_a/pb"]);
  check("and not under its own machine", pinnedBlocked.groups[0]!.active.map((r: { key: string }) => r.key), []);
  check("and its machine's header does not promise a row it will not draw", pinnedBlocked.groups[0]!.blockedCount, 0);
  check("and the render order names it once", visibleRows(pinnedBlocked, currentView(pinnedBlocked)).map((r: { key: string }) => r.key), ["m_a/pb"]);

  setQuery("zzz-matches-nothing");
  check(
    "a needle hides a pinned blocked row as it hides any other: the search is its reader's (Q3.674)",
    visibleRows(pinnedBlocked, currentView(pinnedBlocked)).map((r: { key: string }) => r.key),
    [],
  );
  setQuery("");
}

process.stdout.write("\nwhat is actually on screen\n");
{
  const row = (id: string, machine: string, over: Record<string, unknown> = {}) => ({
    key: `${machine}/${id}`,
    ref: { machineId: machine, sessionId: id },
    machineName: machine,
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });
  const machineOf = (id: string, name: string) => ({ id, name, reach: "online", offlineReason: null, route: null, tokenDegraded: false, scopes: [] });

  const rows = [
      // Distinct createdAt values keep the order assertions off the comparator's tie-break.
      row("blocked", "m_a", { createdAt: 1, status: "blocked", pendingPermissions: [{ raisedAt: 1, title: "Edit" }], workspace: workspaceAt("/home/u/api") }),
      row("live", "m_a", { createdAt: 4, status: "running", workspace: workspaceAt("/home/u/api/packages/web", "/home/u/api") }),
      row("kept", "m_b", { createdAt: 3, status: "running", pinned: true, workspace: workspaceAt("/home/u/web") }),
      // A pin on each machine, so a fleet-wide pin list cannot pass for the selected machine's.
      row("far", "m_a", { createdAt: 6, status: "running", pinned: true, workspace: workspaceAt("/home/u/api") }),
      row("other", "m_b", { createdAt: 2, status: "running", workspace: workspaceAt("/home/u/web") }),
      // A terminal row, so the `ended` assertions are not vacuous.
      row("done", "m_b", { createdAt: 5, status: "exited", exit: { reason: "stopped" }, workspace: workspaceAt("/home/u/web") }),
  ];
  const state = { sessions: rows, machines: [machineOf("m_a", "alpha"), machineOf("m_b", "beta")] } as never;
  const groups = sessionGroups(state);
  const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key);
  const byKey = (key: string) => rows.find((r) => r.key === key) as never;

  check("with nothing remembered, the first machine by name", selectedMachineIn(groups), "m_a");
  check("the tab bar is store order and adds no sort of its own", machineTabs(groups, currentView(groups)).map((t) => t.id), ["m_a", "m_b"]);
  check("and a tab carries the count its rows would", machineTabs(groups, currentView(groups)).map((t) => t.blockedCount), [1, 0]);

  {
    const before = sessionGroups(state);
    const versionBefore = groupsVersion();
    setMachineOrder(["m_b", "m_a"]);
    check("a reorder invalidates the fleet memo", sessionGroups(state) === before, false);
    check(
      "and the tabs come back in the order somebody set",
      machineTabs(sessionGroups(state), currentView(sessionGroups(state))).map((t) => t.id),
      ["m_b", "m_a"],
    );
    check(
      "the tab bar is still store order, now that the store has an opinion",
      machineTabs(sessionGroups(state), currentView(sessionGroups(state))).map((t) => t.id),
      sessionGroups(state).groups.map((g) => g.id),
    );
    check("and the fallback tab is the first in that order, not the first by name", selectedMachineIn(sessionGroups(state)), "m_b");
    check("it is written where a reload will find it", storage.get("reemoat.machineOrder"), JSON.stringify(["m_b", "m_a"]));
    check("and the screen's own version moved, so both axes re-render", groupsVersion() > versionBefore, true);
    const settled = groupsVersion();
    setMachineOrder(["m_b", "m_a"]);
    check("committing the same order again tells nobody", groupsVersion(), settled);
    // Reset: every section shares one storage Map and module state, and `setMachineOrder([])` is no reset because nextOrder keeps every stored id.
    setMachineOrder(["m_a", "m_b"]);
    storage.delete("reemoat.machineOrder");
  }

  {
    const natural = [{ id: "m_a" }, { id: "m_b" }, { id: "m_c" }] as never as { id: MachineId }[];
    const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
    check("with nothing stored, the order is the name sort it always was", ids(orderMachines(natural, [])), ["m_a", "m_b", "m_c"]);
    check("a stored order leads, and the rest keep the name sort behind it", ids(orderMachines(natural, ["m_c"])), ["m_c", "m_a", "m_b"]);
    check("a machine the fleet no longer holds is dropped at draw time, not at write time", ids(orderMachines(natural, ["m_gone", "m_c"])), ["m_c", "m_a", "m_b"]);
    check("and a hand-edited duplicate cannot draw one machine twice", ids(orderMachines(natural, ["m_c", "m_c"])), ["m_c", "m_a", "m_b"]);
    check("membership is the fleet's, and this may not narrow it", orderMachines(natural, ["m_a"]).length, natural.length);

    check("what is written back keeps a slot for a machine the fleet lost", nextOrder(["m_a", "m_gone", "m_b"], ["m_b", "m_a"]), ["m_b", "m_gone", "m_a"]);
    check("and a machine nobody had heard of is written at the end", nextOrder([], ["m_a", "m_b"]), ["m_a", "m_b"]);
    check("a duplicate cannot survive the round trip", nextOrder(["m_a", "m_a"], ["m_a"]), ["m_a"]);
    check(
      "and the stored list is bounded rather than validated",
      nextOrder([], Array.from({ length: 300 }, (_, i) => `m_${String(i)}`)).length,
      MAX_MACHINE_ORDER,
    );

    check(
      "an entry takes its neighbour's place as the pointer passes that neighbour's middle",
      [dropSlot([50, 150, 250], 0, 149), dropSlot([50, 150, 250], 0, 151), dropSlot([50, 150, 250], 0, 251), dropSlot([50, 150, 250], 2, 49)],
      [0, 1, 2, 0],
    );
    check("and a pointer that has not moved reports the slot it started in", dropSlot([50, 150, 250], 1, 150), 1);
  }

  {
    const m = (id: string, name: string) => ({ id: id as MachineId, name });
    check("this computer's machine is called local", machineDisplayName(m("m_b", "MacBook-Pro"), "m_b" as MachineId), "local");
    check("and the word is the one constant", LOCAL_DISPLAY_NAME, "local");
    check("every other machine keeps its own name", machineDisplayName(m("m_a", "alpha"), "m_b" as MachineId), "alpha");
    check("and with no local daemon every machine does", machineDisplayName(m("m_b", "MacBook-Pro"), null), "MacBook-Pro");

    check(
      "another machine labelled local is drawn by its qualified name",
      machineDisplayName(m("m_2405b5ea56616a65", "local"), "m_b" as MachineId),
      "local-2405b5ea56616a65",
    );
    check("in any case", machineDisplayName(m("m_2405b5ea56616a65", "Local"), "m_b" as MachineId), "Local-2405b5ea56616a65");
    check(
      "and before this computer is known, too — so its name never waits on that",
      machineDisplayName(m("m_2405b5ea56616a65", "local"), null),
      "local-2405b5ea56616a65",
    );
    check("while this computer keeps the word even if its own label is local", machineDisplayName(m("m_b", "local"), "m_b" as MachineId), "local");
    check(
      "and a label that only contains the word is left alone",
      [machineDisplayName(m("m_x", "local-dev"), "m_b" as MachineId), machineDisplayName(m("m_y", "mylocal"), "m_b" as MachineId)],
      ["local-dev", "mylocal"],
    );

    {
      const ours = new Set<string>(["m_seed", "m_live"]);
      const held = (id: MachineId) => ours.has(id);
      const after = (known: string | null, answer: string | null) =>
        localMachineAfter(known as MachineId | null, answer as MachineId | null, held);
      check("a read that finds nothing does not clear a known id", after("m_seed", null), "m_seed");
      check("and nothing known and nothing found is still nothing", after(null, null), null);
      check("a different machine of ours replaces it", after("m_seed", "m_live"), "m_live");
      check("the same answer changes nothing", after("m_live", "m_live"), "m_live");
      check("a machine this account does not hold never displaces one", after("m_seed", "m_stranger"), "m_seed");
      check("but with nothing known it is taken, and matches no row", after(null, "m_stranger"), "m_stranger");
      check("and one of ours then replaces the stranger", after("m_stranger", "m_live"), "m_live");
    }

    const natural = [{ id: "m_a" }, { id: "m_b" }, { id: "m_c" }] as never as { id: MachineId }[];
    const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
    const local = "m_c" as MachineId;
    check("nobody has placed it, so it leads", ids(orderMachines(natural, [], local)), ["m_c", "m_a", "m_b"]);
    check(
      "ahead of the stored ids, not appended behind them",
      ids(orderMachines(natural, ["m_b"], local)),
      ["m_c", "m_b", "m_a"],
    );
    check("a position somebody stored for it wins", ids(orderMachines(natural, ["m_b", "m_c", "m_a"], local)), ["m_b", "m_c", "m_a"]);
    check("even when that position is last", ids(orderMachines(natural, ["m_a", "m_b", "m_c"], local)), ["m_a", "m_b", "m_c"]);
    check("a local id the fleet does not hold changes nothing", ids(orderMachines(natural, ["m_b"], "m_other" as MachineId)), ["m_b", "m_a", "m_c"]);
    check("and neither does no local daemon at all", ids(orderMachines(natural, ["m_b"], null)), ["m_b", "m_a", "m_c"]);
    check(
      "it is never drawn twice, whatever storage holds",
      ids(orderMachines(natural, ["m_c", "m_c", "m_gone"], local)),
      ["m_c", "m_a", "m_b"],
    );
    check("and membership is still the fleet's", orderMachines(natural, [], local).length, natural.length);

    // Ids no section has stored, and a name that sorts last, so leading is the local clause's doing.
    const fleet = [machineOf("m_mac", "MacBook-Pro"), machineOf("m_zed", "zed")];
    const away = { sessions: [], machines: fleet, localMachineId: null } as never;
    const here = { sessions: (away as { sessions: [] }).sessions, machines: fleet, localMachineId: "m_zed" } as never;
    const before = sessionGroups(away);
    check("with no local daemon the rail is the name sort", before.groups.map((g) => [g.id, g.name]), [["m_mac", "MacBook-Pro"], ["m_zed", "zed"]]);
    const after = sessionGroups(here);
    check("which computer this is invalidates the fleet memo", after === before, false);
    check("and the rail leads with it", after.groups.map((g) => g.id), ["m_zed", "m_mac"]);
    check("under the name local", after.groups.map((g) => g.name), ["local", "MacBook-Pro"]);
    check(
      "which is the name on its tab, on both axes",
      machineTabs(after, currentView(after)).map((t) => t.name),
      ["local", "MacBook-Pro"],
    );
    check("and the fallback tab is this computer's", selectedMachineIn(after), "m_zed");
    check("while the record keeps the real label", fleet.map((one) => one.name), ["MacBook-Pro", "zed"]);
    check(
      "New session lists the rail's machines, in its order and under its names",
      machinesAsDrawn(here).map((one) => [one.machine.id, one.name]),
      [["m_zed", "local"], ["m_mac", "MacBook-Pro"]],
    );
    check("and a second read with nothing changed is the cached one", sessionGroups(here), after);
    const twin = [...fleet, machineOf("m_2405b5ea56616a65", "local")];
    const both = sessionGroups({ sessions: [], machines: twin, localMachineId: "m_zed" } as never);
    check(
      "a fleet holding a machine labelled local still draws the word once",
      both.groups.map((g) => g.name),
      ["local", "local-2405b5ea56616a65", "MacBook-Pro"],
    );
    check("losing it puts the name and the name order back", sessionGroups(away).groups.map((g) => [g.id, g.name]), [["m_mac", "MacBook-Pro"], ["m_zed", "zed"]]);

    // Ids unique to this section, so the order left in module state reorders no other fixture.
    setMachineOrder(["m_mac", "m_zed"]);
    check("dragged down, it stays down", sessionGroups(here).groups.map((g) => g.id), ["m_mac", "m_zed"]);
    check("and is still called local there", sessionGroups(here).groups.map((g) => g.name), ["MacBook-Pro", "local"]);
    storage.delete("reemoat.machineOrder");

    const read = (file: string) => stripComments(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
    check(
      "a row under All names its machine through the one rule",
      /showMachine && ` · \$\{machineDisplayName\(\{ id: row\.ref\.machineId, name: row\.machineName \}, state\.localMachineId\)\}`/.test(read("ui/SessionBrowser.tsx")),
      true,
    );
    check(
      "and so does a session's own header",
      /machineName=\{machineDisplayName\(\{ id: sessionRef\.machineId, name: row\.machineName \}, state\.localMachineId\)\}/.test(read("ui/SessionView.tsx")),
      true,
    );
    check("the store names a group through it", /name: machineDisplayName\(machine, state\.localMachineId\)/.test(read("store.ts")), true);
    const start = read("ui/NewSession.tsx");
    check("and New session reads the rail's list rather than the control plane's", /const drawn = machinesAsDrawn\(state\);/.test(start), true);
    check(
      "whose reachable machines are the drawn ones, in the drawn order",
      /const reachable = drawn\.map\(\(one\) => one\.machine\)\.filter\(/.test(start),
      true,
    );
    check("and the default is the first of them", /const selected = machine \?\? reachable\[0\]\?\.id \?\? null;/.test(start), true);
    check("with no second list of machines to disagree with it", /state\.machines/.test(start), false);
    const settings = srcFiles().filter((file) => file.startsWith("ui/settings/"));
    check(
      "the sweep over Settings reaches the list and the rename field",
      ["ui/settings/MachinesSection.tsx", "ui/settings/MachineSection.tsx"].every((file) => settings.includes(file)),
      true,
    );
    check(
      "and no file under it draws the display name, so Settings keeps the real label",
      settings.filter((file) => /machineDisplayName|machinesAsDrawn|LOCAL_DISPLAY_NAME|sessionGroups|machineTabs|MachineGroup|DrawnMachine/.test(stripComments(srcFile(file)))),
      [],
    );
    check("the word is spelled once, in machineOrder.ts", (read("machineOrder.ts").match(/"local"/g) ?? []).length, 1);
    check(
      "and nowhere a screen or the store could draw it from",
      srcFiles().filter((file) => (file.startsWith("ui/") || file === "store.ts") && /"local"/.test(stripComments(srcFile(file)))),
      [],
    );
  }

  check("a plain session files under its own directory", folderPathOf(rows[0] as never), "/home/u/api");
  check("and one inside a repo files under the repo", folderPathOf(rows[1] as never), "/home/u/api");
  check("so one folder holds both", foldersOf(groups, currentView(groups)).map((f) => f.name), ["api"]);
  check("and the row says only what the folder does not", rowSubpath(rows[1] as never, "/home/u/api"), "packages/web");
  check("while the folder's own row says nothing extra", rowSubpath(rows[0] as never, "/home/u/api"), null);

  // A folderless row drops the `~/` root marker but keeps the folder (Q3.581).
  const ROOTS = ["/home/u"];
  check("a row drops the root marker and keeps the folder", folderLabel("/home/u/api", ROOTS), "api");
  check("and the marker is what displayCwd still carries", displayCwd("/home/u/api", ROOTS), "~/api");
  check("a session deeper in keeps every level below the root", folderLabel("/home/u/api/packages/web", ROOTS), "api/packages/web");
  check("the root itself stays the marker rather than becoming empty", folderLabel("/home/u", ROOTS), "~");
  check("and a path under no root is untouched", folderLabel("/opt/srv/thing", []), "…/srv/thing");
  check("withholding the folder is not the fix", rowSubpath(rows[0] as never, folderPathOf(rows[0] as never)), null);

  // An unnamed session falls back to folderLabel, and SessionLine suppresses the subline by comparing the two strings.
  const unnamed = { snapshot: { title: null, workspace: { requestedCwd: "/home/u/api" } } };
  check("an unnamed session is named after its folder, with no marker", sessionLabel(unnamed as never, ROOTS), "api");
  check(
    "and the row's own path is the same string, so the duplicate is suppressed",
    sessionLabel(unnamed as never, ROOTS) === folderLabel("/home/u/api", ROOTS),
    true,
  );

  {
    const rail = stripComments(readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8"));
    check(
      "the rail draws a folderless row with folderLabel, and no longer with displayCwd",
      [/folderLabel\(row\.snapshot\.workspace\.requestedCwd, roots\)/.test(rail), /displayCwd\(/.test(rail)],
      [true, false],
    );
    // Sliced per element: a distance-bounded negative regex would pass once the forbidden prop moved further away.
    const rows = rail.match(/<SessionLine[\s\S]*?\/>/g) ?? [];
    const pinnedRow = rows.filter((element) => element.includes("PINNED_FOLDER"));
    check("the Pinned rail row was found as an element", pinnedRow.length, 1);
    check(
      "and Pinned passes no folderPath, so its rows still name a folder",
      pinnedRow.every((element) => !/folderPath=/.test(element)),
      true,
    );
    check(
      "while the folder section's row does pass one, so the sweep is not blind",
      rows.filter((element) => /folderPath=/.test(element)).length,
      1,
    );
  }

  check("unique basenames stay one word", folderNames(["/home/u/api", "/home/u/web"]), ["api", "web"]);
  check("a collision widens only the paths that clash", folderNames(["/home/a/api", "/home/b/api", "/home/a/web"]), ["a/api", "b/api", "web"]);
  check("and widening stops when one side runs out of path", folderNames(["/api", "/home/u/api"]), ["api", "u/api"]);
  check("the filesystem root is named for itself", folderNames(["/"]), ["/"]);

  // Pinned rows are cut to the selected machine (Q3.550).
  check("the selected machine's folders, with no other machine's pins", keys(visibleRows(groups, currentView(groups))), [
    "m_a/far",
    "m_a/live",
    "m_a/blocked",
  ]);
  selectMachine("m_b" as never);
  check("pinned leads on the machine it lives on", keys(visibleRows(groups, currentView(groups))), ["m_b/kept", "m_b/other"]);
  selectMachine("all" as never);
  check("and under All every pin is drawn", keys(visibleRows(groups, currentView(groups))).slice(0, 2), ["m_a/far", "m_b/kept"]);
  selectMachine("m_b" as never);
  check("the keyboard's siblings for a pinned row are the pins on screen", keys(siblingsOf(byKey("m_b/kept"), groups)), ["m_b/kept"]);
  selectMachine("m_a" as never);
  check("and on the other tab they are that tab's", keys(siblingsOf(byKey("m_a/far"), groups)), ["m_a/far"]);
  selectMachine("all" as never);
  check("while All walks every pin, because All draws every pin", keys(siblingsOf(byKey("m_b/kept"), groups)), ["m_a/far", "m_b/kept"]);
  selectMachine("m_a" as never);
  check("a blocked row keeps the place its reader gave it", keys(foldersOf(groups, currentView(groups))[0]?.rows ?? []), ["m_a/live", "m_a/blocked"]);
  check("which the folder header says even when shut", foldersOf(groups, currentView(groups))[0]?.blockedCount, 1);

  selectMachine("m_b" as never);
  check("selecting the other machine draws its folders", foldersOf(groups, currentView(groups)).map((f) => f.name), ["web"]);
  check("and nothing from the machine you left, however long it has been waiting", keys(visibleRows(groups, currentView(groups))), [
    "m_b/kept",
    "m_b/other",
  ]);
  check(
    "which that machine's tab still counts, so the wait is said without moving anything",
    machineTabs(groups, currentView(groups)).map((t) => [t.id, t.blockedCount]),
    [
      ["m_a", 1],
      ["m_b", 0],
    ],
  );
  selectMachine("m_a" as never);

  const folder = foldersOf(groups, currentView(groups))[0]!;
  toggleFolder(folder.id);
  check("collapsing a folder removes exactly its rows", keys(visibleRows(groups, currentView(groups))), ["m_a/far"]);
  selectMachine("m_b" as never);
  check("a pinned row survives any collapse", keys(visibleRows(groups, currentView(groups))).includes("m_b/kept"), true);
  selectMachine("m_a" as never);
  setQuery("api");
  check("but a search opens it again", keys(visibleRows(groups, currentView(groups))), ["m_a/far", "m_a/live", "m_a/blocked"]);
  setQuery("");
  toggleFolder(folder.id);
  check("expanding restores it", visibleRows(groups, currentView(groups)).length, 3);

  const titled = row("t", "m_a", { title: "Ship the relay", workspace: workspaceAt("/home/u/api") }) as never;
  check("the title is matched", matchesQuery(titled, "relay"), true);
  check("case does not matter", matchesQuery(titled, "SHIP"), true);
  check("so is the directory", matchesQuery(titled, "/home/u"), true);
  check("and the agent", matchesQuery(titled, "kimi"), true);
  check("the machine is not", matchesQuery(titled, "m_a"), false);
  check("an empty needle keeps everything", matchesQuery(titled, "   "), true);

  const view = currentView(groups);
  check("the default is the chats that are still going", view.filter, "active");
  selectMachine("m_b" as never);
  check("the ended filter shows terminal rows and nothing else", keys(visibleRows(groups, { ...currentView(groups), filter: "ended" })), ["m_b/done"]);
  check("and active shows the live ones", keys(visibleRows(groups, { ...currentView(groups), filter: "active" })), ["m_b/kept", "m_b/other"]);

  // Swept, because "waiting moves nothing" is a claim about every view: the same list with nobody waiting draws the same.
  const calm = sessionGroups({
    sessions: rows.map((r) =>
      r.key === "m_a/blocked"
        ? row("blocked", "m_a", { createdAt: 1, status: "idle", pendingPermissions: [], workspace: workspaceAt("/home/u/api") })
        : r,
    ),
    machines: [machineOf("m_a", "alpha"), machineOf("m_b", "beta")],
  } as never);
  const filters = ["active", "ended", "all"] as const;
  const machines = ["m_a", "m_b", "all"] as const;
  const needles = ["", "web", "zzz-matches-nothing"];
  const moved: string[] = [];
  for (const f of filters) {
    for (const m of machines) {
      selectMachine(m as never);
      for (const q of needles) {
        setQuery(q);
        const waiting = keys(visibleRows(groups, { ...currentView(groups), filter: f }));
        const quiet = keys(visibleRows(calm, { ...currentView(calm), filter: f }));
        if (JSON.stringify(waiting) !== JSON.stringify(quiet)) moved.push(`${f}/${m}/"${q}": ${waiting.join(",")} vs ${quiet.join(",")}`);
      }
    }
  }
  setQuery("");
  check("waiting on somebody never moves a row, adds one or takes one away, in any filter, tab or search", moved, []);
  check(
    "and no section lifts waiting sessions out of their place",
    [stripComments(srcFile("ui/SessionBrowser.tsx")).includes("Waiting elsewhere"), srcFile("ui/groups.ts").includes("waitingFloor")],
    [false, false],
  );

  selectMachine("all" as never);
  {
    const view = currentView(groups);
    check("All selects no machine in particular", view.machine, null);
    check("and says so", view.all, true);
    check("it draws no folders", foldersOf(groups, view).length, 0);
    check("the flat list leaves out what is pinned", keys(allRows(groups, view)).includes("m_b/kept"), false);
    check("and holds the rest of the fleet in the order its reader gave it", keys(allRows(groups, { ...view, filter: "all" })), [
      "m_b/done",
      "m_a/live",
      "m_b/other",
      "m_a/blocked",
    ]);
  }
  selectMachine("m_a" as never);
  setQuery("");

  const withOrphans = sessionGroups({
    sessions: [
      row("gone-live", "m_x", { status: "running" }),
      row("gone-done", "m_x", { status: "exited", exit: { reason: "stopped" } }),
    ],
    machines: [],
  } as never);
  const orphanView = (filter: "active" | "ended" | "all") => ({ filter, machine: null, all: false, query: "" });
  check("an ended orphan is not in the active slice", keys(visibleRows(withOrphans, orphanView("active"))), ["m_x/gone-live"]);
  check("and a live orphan is not in the ended slice", keys(visibleRows(withOrphans, orphanView("ended"))), ["m_x/gone-done"]);
  check("both are there unfiltered", visibleRows(withOrphans, orphanView("all")).length, 2);
}

process.stdout.write("\nthe orphan section, drawn and walked from one list\n");
{
  const { matching, orphansFor } = await import("../src/ui/groups.js");

  const row = (id: string, machine: string, over: Record<string, unknown> = {}) => ({
    key: `${machine}/${id}`,
    ref: { machineId: machine, sessionId: id },
    machineName: machine,
    snapshot: { ...snapshot, id, ...over },
    daemonNow: 0,
    fetchedAt: 0,
  });

  const groups = sessionGroups({
    sessions: [
      // Distinct ages, so the order assertions do not fall to the key tie-break.
      row("live", "m_gone", { createdAt: 3, status: "running" }),
      row("done", "m_gone", { createdAt: 1, status: "exited", exit: { reason: "stopped" } }),
      row("back", "m_gone", { createdAt: 2, status: "exited", exit: { reason: "daemon_restarted" } }),
    ],
    machines: [],
  } as never);

  check("the helper exists to be shared", typeof orphansFor, "function");
  check("unfiltered it is the whole group", orphansFor(groups, "all").map((r) => r.key), [
    "m_gone/live",
    "m_gone/back",
    "m_gone/done",
  ]);
  check("Active keeps the one the daemon is bringing back", orphansFor(groups, "active").map((r) => r.key), [
    "m_gone/live",
    "m_gone/back",
  ]);
  check("and Ended is only what somebody ended", orphansFor(groups, "ended").map((r) => r.key), ["m_gone/done"]);

  check(
    "the render order carries that same list, on every filter",
    (["all", "active", "ended"] as const).map((filter) =>
      visibleRows(groups, { filter, machine: null, all: false, query: "" })
        .map((r: { key: string }) => r.key)
        .join(","),
    ),
    (["all", "active", "ended"] as const).map((filter) => orphansFor(groups, filter).map((r) => r.key).join(",")),
  );

  const browser = readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8");
  check("the rail's orphan section goes through the helper", /\borphansFor\(groups, filter\)/.test(browser), true);
  check("and never reaches past it to the raw group", /groups\.orphans/.test(browser), false);
  // Not comment-stripped on purpose: `touch-none` is banned from SessionBrowser.tsx even in prose.
  check("the rail is a scroller before it is a drag surface", /touch-none/.test(browser), false);
  check("and the axis it does claim is named, with the other two given back", /\[touch-action:pan-y_pinch-zoom\]/.test(browser), true);
  // Comment-stripped, unlike the ban above, so the docblock explaining why `.press` is absent cannot fail it.
  const rowClass = (() => {
    const code = stripComments(browser);
    const at = code.indexOf("lifted\n          ?");
    return at < 0 ? code.slice(code.indexOf("lifted"), code.indexOf("lifted") + 400) : code.slice(at, at + 400);
  })();
  check("and the row that lifts does not shrink under the finger", /\bpress\b/.test(rowClass), false);
  const rowDrag = readFileSync(new URL("../src/ui/rowDrag.ts", import.meta.url), "utf8");
  check(
    "a live drag can refuse the scroll it would otherwise become",
    /addEventListener\("touchmove", going\.move, \{ passive: false \}\)/.test(rowDrag),
    true,
  );
  check("and the drop suppresses the tap it sits on", /onClickCapture/.test(rowDrag), true);
  check(
    "and every way a drag can end is wired",
    ["onPointerUp:", "onPointerCancel:", "onLostPointerCapture:", "useEffect(() => end", "touchend"].map((form) =>
      rowDrag.includes(form),
    ),
    [true, true, true, true, true],
  );
  check(
    "a cancelled pointer ends a mouse drag and never a touch one",
    /onPointerCancel: \(event\) => \{[\s\S]{0,200}event\.pointerType === "mouse"/.test(rowDrag),
    true,
  );
  check("and losing capture is read the same way", /onLostPointerCapture: \(event\) => \{[\s\S]{0,300}event\.pointerType === "mouse"/.test(rowDrag), true);
  check(
    "and a finger's gesture begins at touchstart, not at pointerdown",
    [
      /node\.addEventListener\("touchstart", going\.start, \{ passive: false \}\)/.test(rowDrag),
      /const onTouchStart = \(event: TouchEvent\): void => \{/.test(rowDrag),
      /closest<HTMLElement>\("\[data-row-key\]\[data-zone\]"\)/.test(rowDrag),
    ],
    [true, true, true],
  );
  check(
    "with the finger lifting as the ending",
    [
      /node\.addEventListener\("touchend", going\.stop\)/.test(rowDrag),
      /node\.addEventListener\("touchcancel", going\.stop\)/.test(rowDrag),
    ],
    [true, true],
  );
  check(
    "and they go on the scroller as it arrives, and come off the node they went on",
    /const scrollerRef = useCallback\([\s\S]{0,400}previous\.removeEventListener\("touchstart"/.test(rowDrag),
    true,
  );
  check("and the arming is felt as well as drawn", /navigator\.vibrate\?\.\(/.test(rowDrag), true);
  check(
    "a mouse arms on movement rather than on time",
    [
      /onPointerDown: \(event\) => \{\s*if \(event\.pointerType !== "mouse" \|\| event\.button !== 0\) return;/.test(
        stripComments(rowDrag),
      ),
      /> MOUSE_SLOP\) arm\(\)/.test(rowDrag),
    ],
    [true, true],
  );
  // Comment-stripped so rowDrag.ts prose may name `setPointerCapture`; the press must not call it, or the row's click is retargeted.
  check(
    "and the press captures nothing, because that ate the click that opens a session",
    (() => {
      const code = stripComments(rowDrag);
      const at = code.indexOf("onPointerDown: (event)");
      return at < 0 ? true : code.slice(at, code.indexOf("onPointerMove:", at)).includes("setPointerCapture");
    })(),
    false,
  );
  check("while the arming does capture it", /if \(going\.byMove\) \{\s*try \{\s*going\.node\.setPointerCapture/.test(stripComments(rowDrag)), true);
  check("and a finger still waits out the hold", /timer\.current = setTimeout\(arm, PRESS_MS\)/.test(rowDrag), true);
  check("both reach the same arming, so only the decision differs", /const arm = \(\): void => \{/.test(rowDrag), true);
  check("and the browser's own drag is refused", /onDragStart: \(event: React\.DragEvent/.test(rowDrag), true);
  // Alt+arrows must keep reordering reachable by keyboard (Q3.533).
  check("a keyboard can still reorder without a menu row to do it from", /event\.altKey/.test(rowDrag), true);
  check("and the menu no longer carries the two rows it did", /"Move up"|"Move down"/.test(readFileSync(new URL("../src/ui/SessionMenu.tsx", import.meta.url), "utf8")), false);
  check("a machine that cannot store an order says so when somebody drags", /daemon is too old to store an order/.test(rowDrag), true);
  check("no insertion rule is drawn", [/drag\.line/.test(browser), /h-0\.5 bg-fg/.test(browser)], [false, false]);
  check("the neighbours move instead", /shiftFor\(/.test(browser), true);
  check("and the shift is a measured pixel count rather than a class", /transform: `translateY\(\$\{shift\}px\)`/.test(browser), true);
  check(
    "transitioned only while a drag is live, and never on the row under the pointer",
    /sliding && !lifted \? "transition-transform" : ""/.test(browser),
    true,
  );
  check("leaving Pinned unpins whether or not the folder is on screen", /if \(zone === undefined\) \{[\s\S]{0,300}pinned: nowPinned/.test(rowDrag), true);
  check("a drop is never refused for want of room", /no room between those two rows/.test(rowDrag), false);
  check("it re-spaces instead", /resolveDrop\(/.test(rowDrag), true);
  check("a row in Pinned holds on to it past the edge", /const sticky = going\.origin\.zone === PINNED_FOLDER \? UNPIN_MARGIN : 0;/.test(rowDrag), true);
  check("and the boundary between two groups is whichever is nearer", /const nearer = gap\(pinnedZone\) - sticky <= gap\(ownZone\) \? pinnedZone : ownZone;/.test(rowDrag), true);
  check("a group joined reserves the height and one left gives it back", /spaceFor\(/.test(browser), true);
  check("and it is the group that takes it, not the rows", /marginBottom/.test(browser), true);
  check("and it animates on the same clock the rows do", /transition-\[margin-bottom\]/.test(browser), true);
  check("the dragged row's offset is measured from its real base", /getBoundingClientRect\(\)\.top - going\.applied/.test(rowDrag), true);
  check("what release will do is said at the pointer", /Release to unpin/.test(browser), true);
  check("and it follows the pointer without a render a frame", /pillRef/.test(browser), true);
  check("the row's trailing controls are not a place to grab it by", /data-no-drag/.test(browser), true);
  check("and the gesture honours that rather than testing for a tag", /closest\("\[data-no-drag\]"\)/.test(rowDrag), true);
  check("a long press is not handed to the platform's own selection", /-webkit-touch-callout/.test(rowDrag), true);
  check(
    "and it is switched off before the engine has decided, not after",
    (() => {
      const code = stripComments(rowDrag);
      const at = code.indexOf("const onTouchStart");
      return at < 0 ? false : code.slice(at, code.indexOf("const onTouchMove", at)).includes("-webkit-touch-callout");
    })(),
    true,
  );

  // origin.index counts the dragged row and target.index does not, so only `target === origin` is a no-op.
  check(
    "a drop one place further down is a move, not a no-op",
    (() => {
      const code = stripComments(rowDrag);
      const at = code.indexOf("nowPinned === wasPinned && going.target.zone === going.origin.zone");
      if (at < 0) return "the no-op guard is gone";
      return (code.slice(at, at + 200).split("}")[0] ?? "").replace(/\s+/g, " ").trim();
    })(),
    "nowPinned === wasPinned && going.target.zone === going.origin.zone) { if (going.target.index === going.origin.index) return;",
  );

  check(
    "the row's menu is drawn on every row, pinned or not",
    (() => {
      const code = stripComments(browser);
      // Anchored on `<SessionMenu`: the earlier rename field also carries `data-no-drag`.
      const menu = code.indexOf("<SessionMenu");
      if (menu < 0) return "the kebab is gone";
      const at = code.lastIndexOf("data-no-drag", menu);
      return at < 0 ? "the kebab is not marked" : code.slice(at, code.indexOf(">", at) + 1).replace(/\s+/g, " ").trim();
    })(),
    'data-no-drag className="mr-2.5">',
  );
  check("and the reveal it used to be keyed on is gone with it", /focus-within:opacity-100/.test(browser), false);

  {
    const drag = stripComments(readFileSync(new URL("../src/ui/rowDrag.ts", import.meta.url), "utf8"));
    // `lastIndexOf`: RowDrag's interface declares `onKeyDown:` before `bind` implements it.
    const at = drag.lastIndexOf("onKeyDown:");
    check(
      "typing beats the reorder shortcut, like every other key in this app",
      at >= 0 && /^[\s\S]{0,200}isTypingInto\(/.test(drag.slice(at)),
      true,
    );
  }

  {
    const drag = stripComments(readFileSync(new URL("../src/ui/rowDrag.ts", import.meta.url), "utf8"));
    check(
      "the neighbours a re-space moves go through one helper, on both paths",
      [
        (drag.match(/respace\(landed\.also\)/g) ?? []).length,
        /for \(const also of landed\.also\)/.test(drag),
      ],
      [2, false],
    );
    const body = drag.slice(drag.indexOf("const respace ="), drag.indexOf("const clearTimer ="));
    check(
      "and it skips a row whose daemon cannot store one, and says so once for the group",
      [/canReorder\(entry\.row\.snapshot\)/.test(body), /told = true/.test(body)],
      [true, true],
    );
  }

  check(
    "the rename field is not a place to grab the row by",
    (() => {
      const code = stripComments(browser);
      const field = code.indexOf("<RenameField");
      if (field < 0) return "the rename field is gone";
      const at = code.lastIndexOf("data-no-drag", field);
      return at >= 0 && code.slice(at, field).indexOf("</") < 0;
    })(),
    true,
  );


  {
    // Q3.665: the field takes the name's place, so opening it moves nothing.
    const menuSrc = stripComments(readFileSync(new URL("../src/ui/SessionMenu.tsx", import.meta.url), "utf8"));
    const viewSrc = stripComments(readFileSync(new URL("../src/ui/SessionView.tsx", import.meta.url), "utf8"));
    const at = menuSrc.indexOf("export function RenameField");
    const field = menuSrc.slice(at, menuSrc.indexOf("\n}\n", at));
    const input = field.slice(field.indexOf("<input"), field.indexOf("/>", field.indexOf("<input")));
    check(
      "the rename box is one text line tall with the name's own inset, and its frame takes no room",
      [
        /h-\[var\(--text-sm--line-height\)\]/.test(input),
        /\bpy-0\b/.test(input) && /\bborder-0\b/.test(input) && /\bpx-1\b/.test(input),
        /\bring-1\b/.test(input),
      ],
      [true, true, true],
    );
    check("and the app's focus ring is off on it, both halves", /no-focus-ring/.test(input) && /outline-none/.test(input), true);
    check(
      "it hugs what is typed through a hidden copy in the same grid cell, never by spanning the row",
      [/inline-grid/.test(field), /invisible col-start-1 row-start-1/.test(field), /\bflex-1\b/.test(input)],
      [true, true, false],
    );
    check(
      "and each caller lines its text up with the name it replaces",
      [/onDone=\{\(\) => onRenaming\(false\)\}\s*className="lg:-ml-1"/.test(viewSrc), /onDone=\{\(\) => setRenaming\(false\)\}\s*className="-mx-1"/.test(stripComments(browser))],
      [true, true],
    );
    check(
      "the header's name shows the text caret, and it is the one in the app beside the separators",
      /title="Rename this session"[\s\S]{0,200}?\bcursor-text\b/.test(viewSrc),
      true,
    );
  }

  check("the rail's pinned section goes through the helper too", /\bpinnedFor\(groups, view\)/.test(browser), true);
  check("and never reaches past that one either", /groups\.pinned/.test(browser), false);

  const needled = { filter: "all", machine: null, all: false, query: "web" } as const;
  check(
    "under a needle the render order still carries exactly the helper's rows",
    visibleRows(groups, needled)
      .map((r: { key: string }) => r.key)
      .filter((key: string) => orphansFor(groups, "all").some((r) => r.key === key))
      .join(","),
    matching(orphansFor(groups, "all"), "web")
      .map((r) => r.key)
      .join(","),
  );
  check(
    "and the rail applies it at both call sites",
    [/matching\(pinnedFor\(groups, view\), view\.query\)/.test(browser), /matching\(orphansFor\(groups, filter\), view\.query\)/.test(browser)],
    [true, true],
  );
}

process.stdout.write("\nsession labels\n");
{
  const labelOf = (title: unknown) =>
    sessionLabel({
      snapshot: { title, workspace: { requestedCwd: "/home/u/work/proj" } },
    } as never);

  check("a name wins", labelOf("Fix the reconnect"), "Fix the reconnect");
  check("an unnamed session falls back to its path", labelOf(null), "…/work/proj");
  check("and so does one from a daemon that has no titles", labelOf(undefined), "…/work/proj");
  check("a whitespace-only name falls back too", labelOf("   "), "…/work/proj");
  check("the result is always a plain string", typeof labelOf("x"), "string");
}


process.stdout.write("\nwhose order the rail is in\n");
{
  const at = (id: string, over: Record<string, unknown> = {}) =>
    ({ key: `m/${id}`, ref: { machineId: "m", sessionId: id }, machineName: "m", snapshot: { ...snapshot, id, ...over }, daemonNow: 0, fetchedAt: 0 }) as never;
  const ids = (rows: readonly { key: string }[]) => rows.map((row) => row.key.slice(2));

  // The absent case is a missing property, not `rank: undefined`: `"rank" in snapshot` is what detects an old daemon.
  check("an unset position is the moment the session was made", effectiveRank({ createdAt: 100 }), 100);
  check("and so is one the daemon says nobody has set", effectiveRank({ createdAt: 100, rank: null }), 100);
  check("while a set one is itself", effectiveRank({ createdAt: 100, rank: 7 }), 7);
  check(
    "a daemon that cannot store an order is known by the absent field, never by a version",
    [canReorder({}), canReorder({ rank: null }), canReorder({ rank: 7 })],
    [false, true, true],
  );

  // The comparator must be total: rows with equal ranks would otherwise swap on every poll.
  const tied = [at("c", { createdAt: 5 }), at("a", { createdAt: 5 }), at("b", { createdAt: 5 })];
  check("rows sharing a millisecond still have one order", ids(orderSessions(tied)), ["a", "b", "c"]);
  check("and it does not depend on the order they arrived in", ids(orderSessions([...tied].reverse())), ["a", "b", "c"]);
  check("ordering twice changes nothing", ids(orderSessions(orderSessions(tied))), ["a", "b", "c"]);
  check("and the input is never mutated", ids(tied), ["c", "a", "b"]);

  const dragged = at("dragged", { createdAt: 10, rank: 1000 + RANK_STEP });
  const fresh = at("fresh", { createdAt: 2000 });
  check("a session created since a drag still leads it", ids(orderSessions([dragged, fresh])), ["fresh", "dragged"]);
  check("and a row nobody touched sits by its age", ids(orderSessions([at("old", { createdAt: 1 }), at("new", { createdAt: 9 })])), ["new", "old"]);

  check("a drop between two rows lands between them", rankBetween(10, 8), 9);
  // The order is descending: higher in the list is a greater rank.
  check("a drop at the top is one step above what is there", rankBetween(null, 8), 8 + RANK_STEP);
  check("and at the bottom, one step below", rankBetween(10, null), 10 - RANK_STEP);
  check("neighbours in the wrong order are refused rather than guessed", rankBetween(8, 10), null);
  check("and so is a pair with nothing on either side", rankBetween(null, null), null);

  {
    let above = 1_770_000_000_001;
    const below = 1_770_000_000_000;
    let steps = 0;
    let last: number | null = null;
    while (steps < 200) {
      const mid = rankBetween(above, below);
      if (mid === null) break;
      check(`bisection ${steps} lands strictly inside`, mid < above && mid > below, true);
      last = mid;
      above = mid;
      steps += 1;
    }
    check("bisecting one millisecond runs out rather than writing a tie", steps < 60 && steps > 0, true);
    check("and every value it did answer was usable", last !== null, true);
  }

  {
    const row = (id: string, rank: number) => at(id, { createdAt: 1, rank });
    const a = row("a", 30);
    const b = row("b", 20);
    const c = row("c", 10);
    const dragged = row("d", 5);

    const middle = resolveDrop([a, b, c], 2, dragged);
    check("an ordinary drop is one write", middle.also.length, 0);
    check("landing strictly between its new neighbours", middle.rank < 20 && middle.rank > 10, true);
    check("a drop at the top needs no neighbour above it", resolveDrop([a, b, c], 0, dragged).rank > 30, true);
    check("and one at the bottom none below", resolveDrop([a, b, c], 3, dragged).rank < 10, true);

    const packedTop = 1_770_000_000_001;
    const tight = [row("x", packedTop), row("y", packedTop - 1e-6)];
    check("the fixture really has no room left in it", rankBetween(packedTop, packedTop - 1e-6), null);
    const packed = resolveDrop(tight, 1, dragged);
    check("a gap that is used up re-spaces rather than refusing", packed.also.length > 0, true);
    const keyOf = (value: unknown): string => (value as { key: string }).key;
    const all: { key: string; rank: number }[] = [
      ...packed.also.map((entry) => ({ key: keyOf(entry.row), rank: entry.rank })),
      { key: keyOf(dragged), rank: packed.rank },
    ].sort((l, r) => r.rank - l.rank);
    check("and every position it writes is distinct", new Set(all.map((entry) => entry.rank)).size, all.length);
    check("with the dropped row in the slot it was dropped into", all[1]?.key, keyOf(dragged));
    check(
      "and the whole group lands above where it was, so nothing it passed can tie with it",
      all.every((entry) => entry.rank > 1_770_000_000_000),
      true,
    );
  }
}

{
  // Every menu takes its direction from bits.tsx's menuPlacement, which measures the scroller rather than the viewport.
  const files = srcFiles();

  const homegrown = files.filter((f) => {
    const body = stripComments(srcFile(f));
    return [...body.matchAll(/setPlacement\(/g)].some(
      (m) => !body.slice(m.index + m[0].length).startsWith("menuPlacement("),
    );
  });
  check("every menu takes its direction from the one helper", homegrown, []);

  for (const file of ["ui/SessionMenu.tsx", "ui/settings/UsersSection.tsx"]) {
    check(`${file} asks where there is room`, /menuPlacement\(/.test(stripComments(srcFile(file))), true);
  }

  const bits = stripComments(srcFile("ui/bits.tsx"));
  const cap = /export const MENU_MAX_PX = (\d+);/.exec(bits)?.[1] ?? "";
  const cls = /max-h-(\d+)/.exec(bits)?.[1] ?? "";
  check("the room a menu needs is the height its own class caps it at", cap, String(Number(cls) * 4));
}
