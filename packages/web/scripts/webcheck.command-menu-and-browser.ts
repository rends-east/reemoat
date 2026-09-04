import { readFileSync, readdirSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { snapshot, workspaceAt } from "./webcheck.ws.js";
import {
  allRows,
  commandsPlan,
  configProse,
  currentView,
  folderNames,
  folderPathOf,
  foldersOf,
  machineTabs,
  matchesQuery,
  rowSubpath,
  selectMachine,
  selectedMachineIn,
  sessionGroups,
  sessionLabel,
  setQuery,
  toggleFolder,
  visibleRows,
  waitingFloor,
} from "./webcheck.modules.js";

/* ------------------------------------------------------------------ *
 * A shared class string, and what a call site may add to it
 * ------------------------------------------------------------------ */

/*
 * ⚠ **Appending a Tailwind utility to a shared class string does not override the
 * one already in it, and seven call sites believed it did for a year.**
 *
 * `MENU_ROW` was `"… items-start …"`. `ProfileMenu`'s four rows, `SessionBrowser`'s
 * filter, `RowAction` and `MachineInstalls`'s plugin row all wrote
 * `` `${MENU_ROW} items-center` ``, and `RowAction`'s docblock said so in words —
 * *"a menu act is one line, so this overrides it to `items-center`"*. None of them
 * won. Tailwind v4 emits utilities in **alphabetical order**, so the generated
 * stylesheet holds `.items-center` before `.items-start` and the constant outranks
 * every append regardless of which way round the class attribute reads. Order
 * inside `class` decides nothing; order inside the CSS decides everything.
 *
 * Reported as *"the text sits slightly below the icons to its left"* — a 14px icon
 * pinned to the top of a `text-xs` line box while the glyphs beside it start a
 * half-leading plus the ascender gap lower. Every pure assertion was green, the
 * types were right, and the docblock claiming the behaviour was itself the bug.
 *
 * So the fix was `menuRow(align)` — the caller states it and cannot be overruled —
 * and **this is the mechanism that keeps it stated**. It is deliberately a sweep
 * over *every* shared class string rather than a check on `menuRow`: what failed
 * was the idiom, not the constant, and the next shared string to grow an
 * `items-`/`justify-`/`text-size` opinion inherits the same trap.
 *
 * Read off disk, like every other placement rule in this file, because nothing
 * typed can hold "these two words are in the same CSS family".
 */
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

  /*
   * The families where two members cannot both apply, listed rather than derived:
   * a derived list would need Tailwind's own table, and what is wanted here is the
   * handful a shared row string actually sets. `text-` is split — a size and a
   * colour are different properties and compose fine, so only the size half is a
   * clash.
   */
/*
   * `(?<![\w:-])` is what keeps a **variant** out of this. `sm:hidden` beside a base
   * `flex` is the responsive idiom and it works — a variant is emitted after its
   * bare form, so it really does win. What cannot win is a second *bare* utility of
   * the same family, which is the whole subject here.
   */
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

  /*
   * What counts as a shared class string: an exported SCREAMING_CASE constant whose
   * value is one literal, and an exported function returning one. Both live in
   * `bits.tsx` today; the walk is over every file so that stops being an assumption.
   */
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

  /*
   * A call site is `${NAME}` or `${name(…)}` inside a template literal, and what it
   * "adds" is the rest of that literal. `[^`]*` ends at the closing backtick, which
   * holds because no call site nests a second template inside the first.
   */
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
          /*
           * ⚠ **Overlap in the *family* is the failure, never a difference in the
           * member** — and the first version of this check got that backwards. It
           * let an append pass when the shared string already contained the same
           * word somewhere, which is exactly true of `menuRow`: its body names both
           * `items-center` and `items-start`, so `` `${menuRow("center")} items-start` ``
           * — the original bug, re-typed — sailed through. Restating a utility the
           * shared string already decides is dead text at best and a silent no-op at
           * worst; both are worth a row here.
           */
          clashes.push(`${file}: ${match[1]} decides ${family} (${ownHits.join("/")}), the call site adds ${addedHits.join("/")}`);
        }
      }
    }
  }

  // A sweep that found nothing to sweep passes silently, which is the failure mode
  // of every source-text assertion in this file.
  check("the sweep found the shared class strings", defined.size >= 5, true);
  check("and found call sites interpolating them", sites >= 10, true);
  check("no call site appends a utility the shared string already decides", clashes, []);
}

/* ------------------------------------------------------------------ *
 * Slash commands
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe composer's command menu\n");
{
  const { slashQuery, buildCommands, filterCommands, completion, configChoices, choiceRuns, typeableName, commandScope, typedConfigCommand } =
    await import("../src/ui/commands.js");

  /*
   * The name a synthesized command gets, and the case bug it had.
   *
   * Lowercasing turned claude's real mode `acceptEdits` into `acceptedits` —
   * neither what the agent calls it nor anything a person would read back. Case
   * was never needed for typeability (nothing here is a shell) and `rankOf` folds
   * it anyway, which is why the last assertion here matters as much as the first.
   */
  check("an agent's own camelCase survives", typeableName("acceptEdits"), "acceptEdits");
  check("and so does the longest real one", typeableName("bypassPermissions"), "bypassPermissions");
  check("what could not be typed as one token is replaced", typeableName("something new!"), "something-new");
  check("separators never dangle", typeableName("  --weird--  "), "weird");
  check("and a name with nothing left is no name at all", typeableName("!!!"), null);

  /*
   * Parsing, and the rule is deliberately narrower than every editor's.
   *
   * The `/` must be at index 0 of the whole message. Kimi's adapter runs
   * `startsWith("/")` against the leading text block whole and claude's CLI parses
   * a command only at the start of a message — so a `/` anywhere else is not a
   * command on either agent, and this app's composer is full of paths that would
   * otherwise open a menu mid-sentence.
   */
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

  // Conservation: `start` always points at the slash, so the token can be spliced
  // back out of the text it came from. A parser that returned an offset nobody
  // could reconstruct from would corrupt the draft on every completion.
  const reconstruct = (text: string, caret: number): string | null => {
    const found = slashQuery(text, caret);
    return found === null ? null : text.slice(found.start, found.start + 1 + found.query.length);
  };
  check("the query round-trips out of the text", reconstruct("/model", 4), "/mod");

  /*
   * Building the list — and this is the assertion the whole feature rests on.
   *
   * Kimi publishes none of model, effort or mode as a command, and neither agent
   * publishes `/mode`. They exist because they are synthesized from the controls
   * by *category*, which is the only thing claude's `effort` and kimi's
   * `thinking` have in common. If this ever regresses to an id-keyed table it
   * fails silently on exactly one agent.
   *
   * The fixture carries a real choice because a control with none is no longer a
   * command — see "a control with nothing to choose between", below.
   */
  const option = (id: string, category: string | null, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    description: null,
    category,
    kind: "select",
    value: id,
    // Named after the option so a mode fixture's lone choice collides with the
    // `/mode` command already taken and expands to nothing — which keeps these
    // assertions about the three synthesized controls and not about the mode
    // shortcuts, which have their own section below.
    choices: [{ value: id, name: id, description: null, group: null }],
    ...over,
  });

  const claudeConfig = { modes: null, options: [option("mode", "mode"), option("model", "model"), option("effort", "thought_level")] };
  const kimiConfig = { modes: null, options: [option("mode", "mode"), option("model", "model"), option("thinking", "thought_level")] };
  // Kimi's real published list, measured: six builtins, and not one of them is a
  // model, an effort or a mode.
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
  /*
   * The row is called `effort` and it *describes itself* as Effort, on the agent
   * whose own word is `Thinking`.
   *
   * The two halves used to disagree by one tap: the command name came from
   * `CATEGORY_COMMAND` (ours, because an id is not portable) and the description
   * fell back to `option.name` (the agent's). Measured 2026-08-04, kimi's control
   * is `id: "thinking"`, `name: "Thinking"` — so the menu offered `/effort`
   * described as "Thinking", and the chip it opens said "Thinking" too. This is
   * the assertion that keeps the one concept to one word.
   */
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

  // `model_config` is hidden from the strip by product decision; a slash command
  // would let it back in through the side door. An unknown category still gets an
  // entry, because demoting is not dropping.
  const odd = buildCommands([] as never, {
    modes: null,
    options: [option("fast", "model_config"), option("something new!", "unheard_of")],
  } as never);
  check("a hidden category gets no command", odd.map((e) => e.name), ["something-new"]);

  /*
   * The collision rule. Neither agent publishes `/model` today, but claude's list
   * is the CLI's own minus a denylist that contains neither `model` nor `effort`,
   * so this can go live with any CLI release — and when it does, sending `/model`
   * as text is a dead end, because ACP has no interactive picker to answer with.
   */
  const shadowed = buildCommands(
    [{ name: "model", description: "Change the model", hint: null }, { name: "compact", description: "Compact", hint: null }] as never,
    claudeConfig as never,
  );
  check("a control shadows an identically-named command", shadowed.filter((e) => e.name === "model").map((e) => e.kind), ["config"]);
  check("and the shadowed one is dropped, never offered twice", shadowed.map((e) => e.name), ["mode", "model", "effort", "compact"]);

  /*
   * Each mode as its own command, which is what makes `/plan` mean something.
   *
   * Measured 2026-08-03, claude publishes six modes and **no `plan` command** —
   * so `/plan` exists only because the choices are lifted to the top level, and
   * nothing here knows the word: an agent with different modes gets different
   * commands from the same rule.
   */
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
  /*
   * `/default` and not `/manual`, which was built and taken back out.
   *
   * The name is the agent's id, always. That is what makes these portable — both
   * agents call this mode `default` underneath — and it is what somebody who knows
   * the agent will reach for. What "default" fails to *say* is answered by the
   * description under the row rather than by this client deciding the command is
   * called something else; see `choiceOverride`.
   */
  check(
    "named by the agent's id, which is what a person types",
    modal.find((e) => e.name === "default")?.value,
    "default",
  );
  // One tap, not two: a mode carries the value it applies, so choosing it never
  // opens a second stage. That is the field the composer branches on.
  check("a mode carries the value it applies", modal.find((e) => e.name === "plan")?.value, "plan");
  check("while the control itself opens its choices", modal.find((e) => e.name === "mode")?.value, null);
  check(
    "and it explains itself with the agent's own sentence",
    modal.find((e) => e.name === "plan")?.description,
    "Planning mode, no actual tool execution",
  );
  // The name is the floor when the agent gives no sentence — never an invented one.
  check(
    "falling back to the choice's name",
    modal.find((e) => e.name === "acceptEdits")?.description,
    "Accept Edits",
  );

  /*
   * And here the collision rule runs the *other* way, deliberately. `/model`
   * shadows a published command because sending it as text is a dead end; a mode
   * shortcut is a convenience, and a command somebody actually installed is more
   * specific intent than one we synthesized.
   */
  const contested = buildCommands(
    [{ name: "plan", description: "Write an implementation plan", hint: null }] as never,
    withModes as never,
  );
  /*
   * **Typing a control has to do what choosing it does**, and until this existed
   * it did the opposite: the name went to the agent as text.
   *
   * Measured against claude — `/plan I want to build…` was delivered as a prompt and
   * came back "/plan isn't available in this environment". A mode change spent as
   * a whole turn, on the one surface whose names are ours *precisely* so they are
   * portable and typeable. The menu applies these on selection and sends nothing;
   * Enter has to reach the same place.
   *
   * Two shapes, split by `value`: a mode carries one and is therefore a change,
   * with anything after the name being the message to send once it lands; the
   * three controls carry none and are a question, so they open their choice list
   * and there is nothing to send.
   */
  const typedMode = typedConfigCommand("/plan", modal as never);
  check("a typed mode shortcut is recognised", typedMode?.entry.name, "plan");
  check("and carries the value it will apply", typedMode?.entry.value, "plan");
  check("with nothing left to send", typedMode?.rest, "");

  // The reported case: the mode *and* a prompt in one message.
  const withPrompt = typedConfigCommand("/plan I want to build a tg bot", modal as never);
  check("an argument after the name survives as the message", withPrompt?.rest, "I want to build a tg bot");
  check("and the mode is still what gets applied", withPrompt?.entry.value, "plan");

  // A control rather than a change: nothing to send, so `rest` is not a message
  // and the caller opens the choice list instead.
  check("a control with no value is recognised too", typedConfigCommand("/mode", modal as never)?.entry.value, null);

  /*
   * The refusals, which are the half that keeps this from eating ordinary
   * messages. The `startsWith("/")` rule is `slashQuery`'s, for its reasons: a
   * slash is a command only at index 0, and this composer is full of paths.
   */
  check("a slash mid-message is not a command", typedConfigCommand("see /plan for details", modal as never), null);
  check("nor is a path", typedConfigCommand("/usr/bin/env", modal as never), null);
  check("an unknown name is left to the agent", typedConfigCommand("/compact", modal as never), null);
  // A published `prompt` command is the agent's own and is sent as typed — that
  // is the only way ACP has to invoke one at all.
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

  // Modes only. A model list expanded this way would put `/opus[1m]` in the menu,
  // and effort's five values mean nothing standing on their own.
  const modelly = buildCommands([] as never, {
    modes: null,
    options: [option("model", "model", { choices: [{ value: "opus[1m]", name: "Opus", description: null, group: null }] })],
  } as never);
  check("no other category is expanded into its values", modelly.map((e) => e.name), ["model"]);

  /*
   * Built-ins before installed skills, and where that fact is read from.
   *
   * ACP's `AvailableCommand` is `{name, description, input}` — there is nowhere
   * to put a scope, so claude puts it on the end of the description. Parsing
   * prose is not nice; what makes it acceptable is the direction it fails in.
   */
  check("claude's scope suffix is read", commandScope("Router for the gstack suite. (gstack) (user)"), "user");
  check("project scope too", commandScope("Something. (project)"), "project");
  // The load-bearing half: anything else is "no information", which sorts with
  // the built-ins — so kimi, which says nothing of the sort, keeps its own order
  // exactly, and a claude that reworded this degrades to that rather than to a
  // wrong answer. The cost of being wrong is menu order, never behaviour.
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
  // Stable, not merely sorted: `zzz` before `bbb` proves nothing alphabetised it.
  check("nothing is alphabetised", mixed[0]?.name, "zzz-builtin");

  /*
   * Commands the adapter hides but which measurably work.
   *
   * claude filters eight names before sending, so no client can offer them
   * however it is written — but that is about advertising, not capability.
   * Measured 2026-08-03: seed a codeword, send `/clear`, ask for it back, get
   * `NO MEMORY`. One entry, restored because it was driven, not guessed at.
   */
  const restored = buildCommands([{ name: "help", description: "Help", hint: null }] as never, undefined, undefined, "claude");
  // Appended, never prepended — and the order is the assertion. `rankOf` breaks
  // ties by build index, so prepending made `/clear` (irreversible agent amnesia)
  // outrank `/compact` and `/context` for the query `c`, which is the most
  // natural prefix in claude's entire list.
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
  // Per agent, never global: kimi's adapter has its own six builtins and no such
  // denylist, so inventing a command for it would be inventing one outright.
  check("kimi is offered nothing it did not publish", buildCommands([] as never, undefined, undefined, "kimi"), []);
  check("and an unknown agent likewise", buildCommands([] as never, undefined, undefined, "nobody"), []);
  // A restored command is as real as a published one, so it claims its name.
  check(
    "a restored name is defended against a mode shortcut",
    buildCommands([] as never, {
      modes: null,
      options: [option("mode", "mode", { choices: [{ value: "clear", name: "Clear", description: null, group: null }] })],
    } as never, undefined, "claude").filter((e) => e.name === "clear").map((e) => e.kind),
    ["prompt"],
  );

  // Conservation, both directions: no name appears twice, and the discriminant and
  // its payload cannot drift apart.
  check("every name is unique", new Set(onKimi.map((e) => e.name)).size, onKimi.length);
  check(
    "a config entry always carries its option and a prompt entry never does",
    onKimi.every((e) => (e.kind === "config") === (e.option !== null)),
    true,
  );
  // A value without an option would be a change the composer cannot apply.
  check(
    "and a value never travels without the option it belongs to",
    [...modal, ...contested, ...onKimi].every((e) => e.value === null || e.option !== null),
    true,
  );
  // An older daemon sends no config at all, and both sources can be empty. Neither
  // may throw, and empty must stay empty so the menu can never open onto nothing.
  check("an older daemon still gets the agent's commands", buildCommands(kimiCommands as never, undefined).length, 6);
  check("and with nothing at all there is nothing to show", buildCommands([] as never, undefined), []);

  /*
   * Ranking. Prefix-first and never fuzzy: a subsequence match over an unfamiliar
   * sixty-item list is unpredictable, and being guessable is the only property a
   * typeahead actually has to have.
   */
  check("an empty query is the identity, order and all", filterCommands(onKimi, ""), onKimi);
  // The tiers, in one query: `usage` matches as a name prefix, `status` only as a
  // substring inside its name, and `mcp` only through its description ("…server
  // status"). All three are matches; the order is the whole point.
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
  // Claude renames every MCP command to `mcp:name`, and nobody types the prefix.
  check(
    "a segment prefix finds an mcp command",
    filterCommands(buildCommands([{ name: "mcp:github", description: "GitHub", hint: null }] as never, undefined), "github").map((e) => e.name),
    ["mcp:github"],
  );
  // A one-letter substring matches nearly every sentence, which would quietly turn
  // the filtered list back into the unfiltered one.
  // `v` appears in no name here and in one description ("Show MCP server status").
  check("one character never matches a description", filterCommands(onKimi, "v").map((e) => e.name), []);
  check("but two do", filterCommands(onKimi, "token").map((e) => e.name), ["usage"]);
  check(
    "nothing is invented and nothing is copied",
    filterCommands(onKimi, "s").every((entry) => onKimi.includes(entry)),
    true,
  );

  /*
   * Completion. The hint is shown and never inserted — `<optional custom
   * summarization instructions>` is a real one, and putting it in the box would
   * send those words to the model as if somebody had typed them.
   */
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

  /*
   * The two composed, which is the pair that was never composed and the bug that
   * hid in the gap.
   *
   * `slashQuery` deliberately allows a caret *inside* the token — asserted above
   * as "the caret decides how much is the query" — while every `completion` case
   * here passed a query whose length happened to equal the whole token. So the
   * arithmetic that sliced at the caret rather than at the token end looked right
   * and was not: the rest of the name survived as an argument. Reached by
   * arrowing left, or by tapping back to fix a typo; neither closes the menu.
   *
   * Driven through `slashQuery` rather than with a hand-written query, because a
   * hand-written one is how the two stayed apart.
   */
  const at = (text: string, caret: number, entry: unknown) =>
    completion(text, slashQuery(text, caret) as never, entry as never);
  check("a caret inside the name still completes the whole name", at("/compact", 4, compact), {
    text: "/compact ",
    caret: 9,
  });
  check("and the tail of the name is not left behind as an argument", at("/compact", 1, compact).text, "/compact ");
  check("a real argument past the caret survives", at("/compact now please", 3, compact).text, "/compact now please");
  // The silent half: a control clears the token, and "the token" is the whole
  // token. This left `del` sitting in an otherwise empty box.
  check("a control mid-token clears all of it", at("/model", 3, model), { text: "", caret: 0 });
  check("and keeps what genuinely followed it", at("/model sonnet", 3, model).text, "sonnet");

  /*
   * The second stage's labels, which must agree with the chip's. Claude's effort
   * `default` is the value where the agent's own name says nothing and the true
   * answer had to be read out of the CLI — so it is read through `adaptiveLabel`
   * here rather than beside it.
   */
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

  /*
   * The other `default`, where the answer is a caption rather than a rename — and
   * the asymmetry with the effort case above is the whole point of the fixture.
   *
   * Measured 2026-08-06, the two agents name one identical mode id differently:
   *
   *   claude  value "default"  name "Manual"   description null
   *   kimi    value "default"  name "Default"  description "Manual approvals; …"
   *
   * Renaming both to `Manual` was built first and taken back out. The premise is
   * weaker here than at `thought_level`: kimi *did* say what its mode means, in a
   * sentence, so the name is not the only thing there is — and a client that
   * renames what an agent calls something is a client inventing vocabulary. So the
   * name stands on both and only the sentence is supplied.
   *
   * Both fixtures, because a rule here is silently correct on whichever agent the
   * author happened to be running.
   */
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

  /*
   * The prose fallback, which is the arm that matters in a live session and the
   * arm nothing reached.
   *
   * `snapshotConfig` keeps only the *selected* choice's description, so every
   * other choice's sentence can arrive only from the transcript. Both callers
   * take a `prose` map for that, and every case above passed `undefined` — so the
   * two arms under test were the two a real session mostly does not take.
   */
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
  // And a mode *shortcut* takes the same road: `/plan` should say what plan mode
  // is, not repeat its own name back.
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

  /*
   * A control with nothing to choose between is not a command.
   *
   * `kind: "boolean"` carries no choices at all, and a select can arrive empty.
   * Either used to produce a row whose second stage was a list of length zero —
   * so choosing it cleared the whole draft and then rendered nothing, because the
   * menu only opens onto a non-empty list. A dead end that ate what you typed.
   */
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

  /* ---------------------------------------------------------------- *
   * The second stage names what the chip names, and adds no heading
   *
   * ⭐ One control drawn two ways a keystroke apart. `ChoiceSection` has drawn a
   * heading whenever `choice.group` changed since it existed; this list had no
   * `group` field at all, so opencode's 356 `OpenRouter/…` rows and six
   * `OpenCode Zen/…` ones ran together here while the chip's menu separated them.
   * Both draw one thing now, and the thing they draw carries no heading of this
   * client's: the repeated provider comes out of the names and nothing puts it
   * back, which is what was asked for a release after the headings shipped.
   *
   * The fixture holds one provider because a session's control does —
   * `narrowToSystem` cuts the published list down to the system that session
   * routes through before this ever sees it.
   * ---------------------------------------------------------------- */
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
    /*
     * ⚠ The runs are markup only: a `listbox` may hold `option`s and `group`s and
     * nothing else, so a heading between rows has to be a wrapper. What must not
     * move is the **flat** index — the arrow keys, `aria-activedescendant` and the
     * scroll effect all count in the unwrapped list, so a row's position is its
     * position in `choices` and never in its run.
     */
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
    /*
     * Consecutive, never gathered. A heading that reappeared after another one
     * would be a second run — the list's own order decides, because reordering an
     * agent's list to tidy the headings is this client deciding what order the
     * agent meant.
     */
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

/* ------------------------------------------------------------------ *
 * The command list's cache rule
 *
 * Four answers, all of them silent when wrong, and three of them were written
 * down as prose in a docblock while the code underneath did something else. Out
 * of `ensureCommands` as a pure function for exactly that reason — there is no
 * daemon here to drive, and a rule nothing can assert is a rule that drifts.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhen to refetch the agent's commands\n");
{
  check("nothing held and the agent has published: fetch", commandsPlan(undefined, 3, false), "fetch");
  check("what is held is what the daemon says: leave it", commandsPlan(3, 3, false), "current");
  check("the daemon has moved on: fetch again", commandsPlan(3, 4, false), "fetch");

  /*
   * `!==` and never `>`. A daemon restart puts the revision back to 0 while a
   * client still holds 5, and 5 is the *stale* one — the agent that published it
   * is gone. So this drops rather than declining to fetch, which is the whole
   * rule that was stated in two docblocks and implemented in neither: the
   * composer went on offering a dead agent's hundred commands.
   */
  check("a restarted daemon's zero drops what is held", commandsPlan(5, 0, false), "drop");
  check("and so does an older daemon that sends nothing at all", commandsPlan(5, undefined, false), "drop");
  check("with nothing held, dropping is still the answer", commandsPlan(undefined, 0, false), "drop");

  /*
   * A revision that arrives mid-flight is deferred, not discarded. The effect
   * that calls this is keyed on the revision, so a dropped call never comes
   * back — and on kimi, which never republishes, the client would hold a
   * superseded list for the life of the tab.
   */
  check("a bump during a fetch is remembered", commandsPlan(undefined, 6, true), "defer");
  check("and so is one that arrives while a stale list is held", commandsPlan(5, 6, true), "defer");
  // Except when there is nothing to chase: an in-flight request for the revision
  // we already hold needs no follow-up.
  check("but a fetch in flight for what is held is not", commandsPlan(6, 6, true), "current");
  // Dropping outranks everything, including a request in the air.
  check("and a drop is not deferred behind one either", commandsPlan(5, 0, true), "drop");
}

/* ------------------------------------------------------------------ *
 * The fleet, grouped — and the one rule that makes grouping safe
 * ------------------------------------------------------------------ */

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

  /*
   * THE rule, restated for the structure that replaced the needs-you zone.
   *
   * Blocked sessions now live inside their machine's section rather than in a flat
   * zone above it, which is what was asked for — so the property that an approval
   * cannot be hidden has to be carried by something else. That something is
   * `blockedCount` on the header: a *collapsed* section still says how many rows
   * under it are waiting. Without it, closing a machine would swallow an approval,
   * which is the one failure this screen exists to prevent.
   */
  const beta = groups.groups.find((g: { id: string }) => g.id === "m_b")!;
  check("a blocked row sits in its own machine's section", beta.active.map((r: { key: string }) => r.key), ["m_b/blocked"]);
  check("and the header counts it, so collapsing cannot hide it", beta.blockedCount, 1);
  const alpha = groups.groups.find((g: { id: string }) => g.id === "m_a")!;
  check("a machine with nothing waiting counts zero", alpha.blockedCount, 0);

  /*
   * Pinned is its own group above the machines — a pin means "this one, wherever
   * it lives", and one scattered per section is a list you reassemble by eye —
   * and it is a **move**, which reverses what this pair asserted for a while.
   *
   * ⚠ It copied, on the argument that lifting the row out made the session you
   * were working in disappear from the list you had been finding it in all day.
   * The reversal is not a change of taste: both groups are on the **same screen
   * at the same time**, a few hundred pixels apart, so the copy was not a second
   * place to find it, it was the same row drawn twice — and a bookmark whose job
   * is "this one, not the other forty" was drawing itself as two of the forty.
   * What the copy said that the pin did not — where the session works — is on the
   * row itself now, via `showPath`.
   */
  check("a pinned row is in the pinned group", groups.pinned.map((r: { key: string }) => r.key), ["m_a/pinned"]);
  check("and is no longer under its own machine", alpha.active.map((r: { key: string }) => r.key), ["m_a/live"]);

  // Ordered by name, never by reachability: `reach` flickers, and a list that
  // reorders itself under a travelling thumb is the failure this app cannot have.
  check("sections are ordered by name", groups.groups.map((g: { name: string }) => g.name), ["alpha", "beta", "gamma"]);
  check("a machine with no sessions still gets one", groups.groups.find((g: { id: string }) => g.id === "m_c") !== undefined, true);

  // Memoised on both arrays, and `emitTranscripts` replaces neither — so a
  // streamed token must not re-derive the whole fleet.
  check("the derivation is memoised by identity", sessionGroups(state) === groups, true);
  check("and a transcript-only change does not invalidate it", sessionGroups({ ...(state as object), transcripts: new Map() } as never) === groups, true);

  const orphaned = sessionGroups({ sessions: [row("lost", "m_gone", {})], machines: [] } as never);
  check("a row with no granted machine becomes an orphan", orphaned.orphans.length, 1);

  /*
   * Pinned *and* blocked, which is the combination the two rules above meet on —
   * and the assertion that inverted when pinning stopped moving rows.
   *
   * `blockedCount` means "rows under this header that are waiting", and it is
   * counted off where `place` actually filed the row rather than off the row's
   * machine id. That used to be a correction: a pinned row was not under its
   * header, so counting it made a machine read "1 waiting" with nothing waiting
   * inside it. Now the row *is* under the header, so the same line gives the
   * ordinary answer — one waiting, one row to find when you open it.
   *
   * The direction that would be safe if this were wrong is the over-count, since
   * it cannot hide an approval; a header contradicting its own contents in either
   * direction is what teaches people to stop believing the count.
   *
   * Below the memoisation checks above, deliberately: `sessionGroups` memoises in
   * module state, so an extra call placed before them replaces the cache and makes
   * the identity assertions fail on a change that is only in this driver.
   */
  const pinnedBlocked = sessionGroups({
    sessions: [
      row("pb", "m_a", { status: "blocked", pendingPermissions: [{ raisedAt: 5, title: "Edit" }], pinned: true }),
    ],
    machines: [machineOf("m_a", "alpha")],
  } as never);
  check("a pinned blocked row is in the pinned group", pinnedBlocked.pinned.map((r: { key: string }) => r.key), ["m_a/pb"]);
  check("and not under its own machine", pinnedBlocked.groups[0]!.active.map((r: { key: string }) => r.key), []);
  /*
   * **And its machine's header does not count it, which is the half worth
   * arguing.**
   *
   * A header's "N waiting" is a promise about the rows *under that header*, and
   * this row is not one of them — a folder saying "1 waiting" that opens onto
   * nothing waiting is how people learn to stop believing the number, which is
   * strictly worse than the number being smaller. Nothing is hidden by it: the
   * pinned group is above the folders on the same screen, `waitingFloor` counts
   * by subtracting what the view draws from everything blocked, and it draws
   * `pinnedFor` — asserted as a superset property over every filter, tab and
   * needle a few blocks down rather than trusted to this comment.
   */
  check("and its machine's header does not promise a row it will not draw", pinnedBlocked.groups[0]!.blockedCount, 0);
  /*
   * And the caret visits it once.
   *
   * `keyboard.ts` locates the current row with `findIndex(key === currentKey)`,
   * which answers with the *first* match — so while a row was drawn twice, `j`
   * from the machine-section copy resolved to the pinned copy's index and jumped
   * across the whole list. Nothing produces a duplicate today; the dedup in
   * `visibleRows` stays, and so does this, because what they defend against is a
   * *future* group that copies rather than the one that used to.
   */
  check("and the render order names it once", visibleRows(pinnedBlocked, currentView(pinnedBlocked)).map((r: { key: string }) => r.key), ["m_a/pb"]);
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
      row("blocked", "m_a", { status: "blocked", pendingPermissions: [{ raisedAt: 1, title: "Edit" }], workspace: workspaceAt("/home/u/api") }),
      row("live", "m_a", { status: "running", workspace: workspaceAt("/home/u/api/packages/web", "/home/u/api") }),
      row("kept", "m_b", { status: "running", pinned: true, workspace: workspaceAt("/home/u/web") }),
      row("other", "m_b", { status: "running", workspace: workspaceAt("/home/u/web") }),
      // A terminal row, and the fixture had none — so every `ended` assertion below
      // was true of a list that could not have contained anything, and `rowsOf`
      // returning `group.active` for the ended filter would have passed just as
      // green. One row is the difference between an assertion and a tautology.
      row("done", "m_b", { status: "exited", exit: { reason: "stopped" }, workspace: workspaceAt("/home/u/web") }),
  ];
  const state = { sessions: rows, machines: [machineOf("m_a", "alpha"), machineOf("m_b", "beta")] } as never;
  const groups = sessionGroups(state);
  const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key);

  /*
   * Which machine's chats are on screen, resolved against what exists.
   *
   * The remembered id is never overwritten by the fallback, so a grant revoked and
   * restored puts you back where you were — and the fallback itself is first *by
   * name*, never by activity, because activity flickers on the four-second poll
   * and a default tab that moves while you look at it is the same failure as a
   * list reordering under a thumb.
   */
  check("with nothing remembered, the first machine by name", selectedMachineIn(groups), "m_a");
  check("the tab bar is store order and adds no sort of its own", machineTabs(groups, currentView(groups)).map((t) => t.id), ["m_a", "m_b"]);
  check("and a tab carries the count its rows would", machineTabs(groups, currentView(groups)).map((t) => t.blockedCount), [1, 0]);

  /*
   * Folders. The key is the repo root where there is one, so a session started
   * three levels inside a repository files under the project a human recognises
   * rather than under `packages/web`.
   */
  check("a plain session files under its own directory", folderPathOf(rows[0] as never), "/home/u/api");
  check("and one inside a repo files under the repo", folderPathOf(rows[1] as never), "/home/u/api");
  check("so one folder holds both", foldersOf(groups, currentView(groups)).map((f) => f.name), ["api"]);
  check("and the row says only what the folder does not", rowSubpath(rows[1] as never, "/home/u/api"), "packages/web");
  check("while the folder's own row says nothing extra", rowSubpath(rows[0] as never, "/home/u/api"), null);

  /*
   * A basename until it collides, then the shortest suffix that separates them.
   * Two rows both reading "api" is the failure this exists to prevent.
   */
  check("unique basenames stay one word", folderNames(["/home/u/api", "/home/u/web"]), ["api", "web"]);
  check("a collision widens only the paths that clash", folderNames(["/home/a/api", "/home/b/api", "/home/a/web"]), ["a/api", "b/api", "web"]);
  check("and widening stops when one side runs out of path", folderNames(["/api", "/home/u/api"]), ["api", "u/api"]);
  check("the filesystem root is named for itself", folderNames(["/"]), ["/"]);

  /*
   * The render order. Pinned leads, **cut to the selected machine**; then that
   * machine's folders; then orphans. `m_b/kept` is pinned and lives on `m_b`, so
   * under `m_a` it is not drawn at all (Q3.550: a section drawn identically on
   * every tab read as the pins having been copied to each machine), and under
   * `m_b` it leads and is named once.
   */
  check("the selected machine's folders, with no other machine's pins", keys(visibleRows(groups, currentView(groups))), [
    "m_a/blocked",
    "m_a/live",
  ]);
  selectMachine("m_b" as never);
  // After the waiting floor, which is `m_a/blocked` seen from `m_b`'s tab: a pin
  // leads its machine's list, and the floor leads everything.
  check("pinned leads on the machine it lives on", keys(visibleRows(groups, currentView(groups))), ["m_a/blocked", "m_b/kept", "m_b/other"]);
  selectMachine("all" as never);
  check("and under All every pin is drawn", keys(visibleRows(groups, currentView(groups)))[0], "m_b/kept");
  selectMachine("m_a" as never);
  check("and blocked leads its folder", foldersOf(groups, currentView(groups))[0]?.rows[0]?.key, "m_a/blocked");
  check("which the folder header says even when shut", foldersOf(groups, currentView(groups))[0]?.blockedCount, 1);

  /*
   * **The hole the tab bar opened, and the thing that closes it.**
   *
   * With `m_b` selected, the blocked session on `m_a` has no row anywhere — its
   * folder is not drawn and its tab can be scrolled off the end of the bar. It has
   * to appear anyway, and it does, above everything else.
   */
  selectMachine("m_b" as never);
  check("selecting the other machine draws its folders", foldersOf(groups, currentView(groups)).map((f) => f.name), ["web"]);
  // `m_b/done` is absent because the default filter is `"active"` — the list is
  // "only the chats that are still going". It is reachable through the filter
  // control, which is the trade the default's own docblock in `groups.ts` states,
  // and the *next* assertion is the one that matters: a blocked row is lifted
  // whatever the filter says.
  check("and the session waiting on the machine you left is lifted to the top", keys(visibleRows(groups, currentView(groups))), [
    "m_a/blocked",
    "m_b/kept",
    "m_b/other",
  ]);
  check("the floor holds exactly that row", keys(waitingFloor(groups, currentView(groups))), ["m_a/blocked"]);
  // Nothing is lifted twice: with its own machine selected it has a folder, so the
  // floor is empty rather than duplicating it.
  selectMachine("m_a" as never);
  check("and nothing is lifted while its own machine is selected", keys(waitingFloor(groups, currentView(groups))), []);

  /*
   * Collapse is per folder, keyed per machine, and a needle overrides it — you
   * search, find three matches, and they must not be inside a folder you shut
   * last month.
   */
  const folder = foldersOf(groups, currentView(groups))[0]!;
  toggleFolder(folder.id);
  check("collapsing a folder removes exactly its rows", keys(visibleRows(groups, currentView(groups))), []);
  selectMachine("m_b" as never);
  check("a pinned row survives any collapse", keys(visibleRows(groups, currentView(groups))).includes("m_b/kept"), true);
  selectMachine("m_a" as never);
  // "blocked" would match nothing: the raw session id is deliberately not
  // searched, so a needle has to name something visible on the row.
  setQuery("api");
  check("but a search opens it again", keys(visibleRows(groups, currentView(groups))), ["m_a/blocked", "m_a/live"]);
  setQuery("");
  toggleFolder(folder.id);
  check("expanding restores it", visibleRows(groups, currentView(groups)).length, 2);

  /*
   * The needle. `sessionLabel` first, which is the exact defect that got the last
   * search box deleted: it matched the machine, the agent, the cwd and the raw
   * session id, and not the one string a person actually reads on the row.
   */
  const titled = row("t", "m_a", { title: "Ship the relay", workspace: workspaceAt("/home/u/api") }) as never;
  check("the title is matched", matchesQuery(titled, "relay"), true);
  check("case does not matter", matchesQuery(titled, "SHIP"), true);
  check("so is the directory", matchesQuery(titled, "/home/u"), true);
  check("and the agent", matchesQuery(titled, "kimi"), true);
  // Not the machine: the needle only ever filters the selected machine's list, so
  // a machine-name match would answer with an empty list and read as broken.
  check("the machine is not", matchesQuery(titled, "m_a"), false);
  check("an empty needle keeps everything", matchesQuery(titled, "   "), true);

  /*
   * The filters still slice, and the default is `"active"` — the list is the
   * chats that are still going.
   *
   * That default went `"active"` → `"all"` → `"active"` again, and the round trip
   * is worth stating because the middle step was not a preference. This filter is
   * the **only** route to an ended session anywhere in the app, and for one
   * revision the control that reaches it was drawn as an inert placeholder; with
   * a dead control, `"active"` puts every finished conversation permanently out
   * of reach. `ChatSearch` wires the icon now, so the narrow default is safe
   * again — and if the control is ever reverted to a placeholder this assertion
   * and `groups.ts`'s initialiser go back to `"all"` together.
   */
  const view = currentView(groups);
  check("the default is the chats that are still going", view.filter, "active");
  selectMachine("m_b" as never);
  /*
   * The floor ignores the filter deliberately, so a blocked session rides above
   * the Ended slice rather than being sliced out of it: a filter is something you
   * asked for, and being asked for an approval is not something you can ask to
   * stop. `m_a/blocked` is therefore first here, and its absence would be the bug.
   */
  check("the ended filter shows terminal rows, and still anything waiting", keys(visibleRows(groups, { ...currentView(groups), filter: "ended" })), ["m_a/blocked", "m_b/done"]);
  check("and active shows the live ones", keys(visibleRows(groups, { ...currentView(groups), filter: "active" })), ["m_a/blocked", "m_b/kept", "m_b/other"]);

  /*
   * **The property, over the whole cross-product.**
   *
   * Every row in the fleet that is waiting on a human is somewhere in the render
   * order — under every filter, whichever tab is selected, and whatever has been
   * typed into the search box. This is the direct successor to "an approval cannot
   * be hidden", restated for a list that now shows one machine at a time, and it is
   * asserted as a superset rather than as a list so that a new section or a new
   * filter cannot open a gap in it by accident.
   *
   * **`all` is in the machine list, and it is not a formality.** The All tab is a
   * whole second way of building the render order — a flat cross-fleet list with no
   * folders, and one that deliberately *excludes* pinned rows so a session is not
   * drawn twice — so it is exactly the kind of new section this property exists to
   * catch. The view comes from `currentView` rather than a literal, which is what
   * makes the assertion about the code the rail runs instead of about a shape
   * assembled here that happens to resemble it.
   */
  const everyBlocked = rows
    .filter((r) => ((r.snapshot as { pendingPermissions?: unknown[] }).pendingPermissions?.length ?? 0) > 0)
    .map((r) => r.key);
  const filters = ["active", "ended", "all"] as const;
  const machines = ["m_a", "m_b", "all"] as const;
  const needles = ["", "web", "zzz-matches-nothing"];
  let holes: string[] = [];
  for (const f of filters) {
    for (const m of machines) {
      selectMachine(m as never);
      for (const q of needles) {
        setQuery(q);
        const shown = new Set(keys(visibleRows(groups, { ...currentView(groups), filter: f })));
        for (const key of everyBlocked) {
          if (!shown.has(key)) holes.push(`${f}/${m}/"${q}" hides ${key}`);
        }
      }
    }
  }
  setQuery("");
  check("no filter, tab or search can hide a session waiting on you", holes, []);

  /*
   * What All *is*, stated directly, because the superset property above only says
   * that nothing is lost — it would pass just as well if All drew every row twice.
   */
  selectMachine("all" as never);
  {
    const view = currentView(groups);
    check("All selects no machine in particular", view.machine, null);
    check("and says so", view.all, true);
    check("it draws no folders", foldersOf(groups, view).length, 0);
    // Pinned is excluded from the flat list: with no folders there is no second
    // place for the row to be, so the two copies would be the same row twice in
    // one list with nothing between them explaining why.
    check("the flat list leaves out what is pinned", keys(allRows(groups, view)).includes("m_b/kept"), false);
    check("and holds the rest of the fleet, newest first", keys(allRows(groups, { ...view, filter: "all" })), [
      "m_a/blocked",
      "m_a/live",
      "m_b/other",
      "m_b/done",
    ]);
    // Nothing is unreachable under All, so the band that exists because one
    // machine is on screen at a time has nothing to lift.
    // Nothing is unreachable under All, so the band that exists because one
    // machine is on screen at a time has nothing to lift.
    check("and nothing has to be lifted, because nothing is elsewhere", waitingFloor(groups, view).length, 0);
  }
  selectMachine("m_a" as never);
  setQuery("");

  /*
   * Orphans obey the filter too, and they did not.
   *
   * They were appended raw, so an ended orphan appeared under Active and a live
   * one was missing from Ended. That is worse than a cosmetic slip because this
   * function *is* the render order `keyboard.ts` walks: `j` would land on a row
   * the rail was not drawing. Rows whose machine is no longer granted are rare,
   * which is exactly why nobody would think to doubt them.
   */
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

/* ------------------------------------------------------------------ *
 * The one list the rail draws and the caret walks
 *
 * The section above asserts that `visibleRows` filters orphans. That was already
 * true and it was not enough: `SessionBrowser` went on mapping `groups.orphans`
 * raw, so "No longer granted" drew rows the single source of render order
 * excludes — and `keyboard.ts` locates the caret with
 * `findIndex(row.key === currentKey)`, which answers `-1` for a row only the JSX
 * knows about, so `j` from an orphan jumped to the top of the fleet. Under the
 * Ended filter the same section drew live rows.
 *
 * So the claim here is not "orphans are filtered" — it is that **one function
 * answers for both readers**. `orphansFor` is that function, exported beside
 * `pinnedFor` for exactly this reason, and both halves of the coupling are
 * asserted below: the behaviour, and the fact that the component reaches for it.
 * ------------------------------------------------------------------ */

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

  // No machines at all, so every row is an orphan: a grant revoked while the tab
  // was open leaves exactly this state, which is why the group exists.
  const groups = sessionGroups({
    sessions: [
      row("live", "m_gone", { status: "running" }),
      row("done", "m_gone", { status: "exited", exit: { reason: "stopped" } }),
      // Interrupted is the one the Ended filter must *not* collect — the daemon
      // ended it and is bringing it back — and it is the row most likely to be
      // mis-bucketed by a second, hand-written copy of the rule.
      row("back", "m_gone", { status: "exited", exit: { reason: "daemon_restarted" } }),
    ],
    machines: [],
  } as never);

  check("the helper exists to be shared", typeof orphansFor, "function");
  // Blocked, then live, then terminal — the order `place` files them in, which is
  // `sessionLists`' own. Unfiltered means every row, in that order, and not the
  // order they were handed to `sessionGroups`.
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

  /*
   * The coupling itself, asserted as an equality rather than as two lists that
   * happen to agree today: whatever `orphansFor` returns is exactly the orphan
   * tail of the render order, on every filter. Reverting `visibleRows` to push
   * `groups.orphans` raw fails the Active and Ended arms here.
   */
  check(
    "the render order carries that same list, on every filter",
    (["all", "active", "ended"] as const).map((filter) =>
      visibleRows(groups, { filter, machine: null, all: false, query: "" })
        .map((r: { key: string }) => r.key)
        .join(","),
    ),
    (["all", "active", "ended"] as const).map((filter) => orphansFor(groups, filter).map((r) => r.key).join(",")),
  );

  /*
   * And the half that lives in JSX, read off disk.
   *
   * A component cannot be rendered here — there is no DOM and no React — but the
   * question this fix turns on is not what the rail *paints*, it is **which array
   * it reads**, and that is a fact about the source. The same argument the cpctl
   * extraction at the foot of this file makes: comparing behaviour where that is
   * possible, and the one line that decides it where it is not. Reverting
   * `SessionBrowser` to `groups.orphans` fails the second of these.
   */
  const browser = readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8");
  check("the rail's orphan section goes through the helper", /\borphansFor\(groups, filter\)/.test(browser), true);
  check("and never reaches past it to the raw group", /groups\.orphans/.test(browser), false);
  check("the rail's pinned section goes through the helper too", /\bpinnedFor\(groups, view\)/.test(browser), true);
  check("and never reaches past that one either", /groups\.pinned/.test(browser), false);

  /*
   * **And both go through the needle, which the assertions above cannot see.**
   *
   * Everything above pins the *filter* half and was written when the filter was
   * the only axis. The search box is a second one, and it reopened the identical
   * hole: `visibleRows` pushes `matching(pinnedFor(…), query)` while the rail drew
   * the raw slice, so four letters typed into the box painted rows that the
   * caret's own list did not contain — `findIndex` answering `-1`, `j` jumping to
   * the top of the fleet. The arms above all run `query: ""`, where `matching`
   * early-returns, so every one of them passes either way.
   *
   * Two halves for the same reason as the pair above: the render order compared
   * against the helpers under a needle that actually excludes something, and the
   * one line of JSX that decides which array is painted.
   */
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

/* ------------------------------------------------------------------ *
 * What a session is called
 * ------------------------------------------------------------------ */

process.stdout.write("\nsession labels\n");
{
  const labelOf = (title: unknown) =>
    sessionLabel({
      snapshot: { title, workspace: { requestedCwd: "/home/u/work/proj" } },
    } as never);

  check("a name wins", labelOf("Fix the reconnect"), "Fix the reconnect");
  // `undefined` is an older daemon and `null` is "nobody has named it". Both mean
  // the same thing to a reader, so both fall back rather than being told apart.
  check("an unnamed session falls back to its path", labelOf(null), "…/work/proj");
  check("and so does one from a daemon that has no titles", labelOf(undefined), "…/work/proj");
  // A whitespace-only title would otherwise render as a blank row, which is worse
  // than a path — hence trimmed rather than merely null-checked.
  check("a whitespace-only name falls back too", labelOf("   "), "…/work/proj");
  check("the result is always a plain string", typeof labelOf("x"), "string");
}
