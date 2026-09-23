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
   * ⚠ **The chip's notice rule stops at the chip.** claude 2.1.280 describes a
   * session resumed on a model an alias has moved past as `Newer version available
   * · select Opus for Opus 5.5`; the chip draws the row's name instead, and this
   * row is where the sentence belongs — under the name, saying what to pick. So the
   * menu draws both exactly as the agent sent them.
   */
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

  /*
   * ⭐ **And when the view stops drawing it, the floor lifts it — which needed no
   * fleet at all.**
   *
   * `waitingFloor` walked `groups.groups` for its candidates, and `place` in
   * `sessionGroups` *moves* a pinned row into `groups.pinned` (and an ungranted
   * one into `groups.orphans`), returning `null`. So a pinned blocked row was in
   * neither `active` nor `ended`, was never a candidate, and — per the assertion
   * three lines up — was never counted in `blockedCount` either. The subtraction
   * the comment above calls "everything blocked minus what the view draws" was
   * over a **subset** of the fleet.
   *
   * One machine and one needle is the whole reproduction: every count reads zero
   * and only the header dot is left, which is the "typing four letters into the
   * search box hid an approval" failure `waitingFloor`'s own comment records as
   * fixed for the other groups. Driven through both doors the comment names — a
   * needle: `pinnedFor` cuts by the needle, so the row leaves the view while
   * still being blocked, which is precisely the state the floor exists for.
   */
  setQuery("zzz-matches-nothing");
  check(
    "a needle that hides a pinned blocked row does not hide the approval",
    visibleRows(pinnedBlocked, currentView(pinnedBlocked)).map((r: { key: string }) => r.key),
    ["m_a/pb"],
  );
  check(
    "and it is the floor that is holding it up",
    waitingFloor(pinnedBlocked, currentView(pinnedBlocked)).map((r: { key: string }) => r.key),
    ["m_a/pb"],
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
      /*
       * ⚠ **The `createdAt`s are distinct on purpose, and this fixture had one
       * value for all of them.** The rail's order is the reader's now — a rank
       * defaulting to `createdAt` — so identical ages put every row into the
       * comparator's *tie-break*, and the assertions below would have been
       * pinning "sorted by key" while reading like claims about position. Newest
       * first, so `live` (4) leads `blocked` (1) in the folder they share, which
       * is the assertion that says the hoist is gone.
       */
      row("blocked", "m_a", { createdAt: 1, status: "blocked", pendingPermissions: [{ raisedAt: 1, title: "Edit" }], workspace: workspaceAt("/home/u/api") }),
      row("live", "m_a", { createdAt: 4, status: "running", workspace: workspaceAt("/home/u/api/packages/web", "/home/u/api") }),
      row("kept", "m_b", { createdAt: 3, status: "running", pinned: true, workspace: workspaceAt("/home/u/web") }),
      // ⚠ **A second pin, on the *other* machine, and the fixture had none.** With
      // one pin in the fleet every list of pins is the same list, so "cut to the
      // selected machine" was a claim nothing here could have falsified — which is
      // how `siblingsOf` came to walk the fleet's pins while the rail drew this
      // tab's. It is `active`, so the default filter keeps it.
      row("far", "m_a", { createdAt: 6, status: "running", pinned: true, workspace: workspaceAt("/home/u/api") }),
      row("other", "m_b", { createdAt: 2, status: "running", workspace: workspaceAt("/home/u/web") }),
      // A terminal row, and the fixture had none — so every `ended` assertion below
      // was true of a list that could not have contained anything, and `rowsOf`
      // returning `group.active` for the ended filter would have passed just as
      // green. One row is the difference between an assertion and a tautology.
      row("done", "m_b", { createdAt: 5, status: "exited", exit: { reason: "stopped" }, workspace: workspaceAt("/home/u/web") }),
  ];
  const state = { sessions: rows, machines: [machineOf("m_a", "alpha"), machineOf("m_b", "beta")] } as never;
  const groups = sessionGroups(state);
  const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key);
  const byKey = (key: string) => rows.find((r) => r.key === key) as never;

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
   * ⭐ **The order the machines are in, and the half a source pin cannot see.**
   *
   * `sessionGroups` is memoised on the identity of `state.sessions` and
   * `state.machines`, and a reorder replaces neither — so without the order's
   * version in that guard a drop repaints nothing until the four-second poll
   * happens to hand over a new `machines` array. That reads as a drag doing nothing
   * for four seconds and then jumping, and **every assertion written off the source
   * text stays green with the guard reverted**, which is why this pair is driven
   * against the real function instead.
   */
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
    /*
     * The tab bar still adds no sort of its own: what it draws is exactly what the
     * store handed it, which is the property the assertion above this block is
     * about and the reason the order was applied in `store.ts` rather than here.
     */
    check(
      "the tab bar is still store order, now that the store has an opinion",
      machineTabs(sessionGroups(state), currentView(sessionGroups(state))).map((t) => t.id),
      sessionGroups(state).groups.map((g) => g.id),
    );
    check("and the fallback tab is the first in that order, not the first by name", selectedMachineIn(sessionGroups(state)), "m_b");
    check("it is written where a reload will find it", storage.get("reemoat.machineOrder"), JSON.stringify(["m_b", "m_a"]));
    /*
     * Both readers of the tab list subscribe to the screen's own version rather
     * than to a second store, so the bridge in `groups.ts` is what makes a reorder
     * repaint. Asserted as a number moving, because a missing `subscribeMachineOrder`
     * leaves every other assertion here green.
     */
    check("and the screen's own version moved, so both axes re-render", groupsVersion() > versionBefore, true);
    const settled = groupsVersion();
    setMachineOrder(["m_b", "m_a"]);
    check("committing the same order again tells nobody", groupsVersion(), settled);
    /*
     * ⚠ **Reset, and this is not tidiness.** Every section below reads
     * `sessionGroups` on its own fixtures out of one shared `storage` Map in one
     * process, so an order left behind here reorders somebody else's assertion
     * three sections away — where it would be read as a defect in whatever that
     * section is about.
     *
     * ⚠ **And `setMachineOrder([])` is not a reset; it was the spelling here, and it
     * did nothing.** `nextOrder` keeps a slot for every id it has ever stored — the
     * revoke-and-restore promise — so an empty drawn list writes back exactly what
     * was there, the idempotence guard returns early, and `["m_b", "m_a"]` stayed
     * in memory for every section below. Deleting the storage key does not reach
     * module state either. Nothing can take an id back out, by design, so the
     * reset is to put these two back in the order the name sort would draw them.
     * Found by the `local` section below, which read the leftover as its own.
     */
    setMachineOrder(["m_a", "m_b"]);
    storage.delete("reemoat.machineOrder");
  }

  /*
   * The merge itself, driven directly. `natural` arrives from `store.ts` already
   * sorted by name, so clause 3 *is* the name sort rather than a replacement for
   * it — which is what a machine nobody has dragged relies on.
   */
  {
    const natural = [{ id: "m_a" }, { id: "m_b" }, { id: "m_c" }] as never as { id: MachineId }[];
    const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
    check("with nothing stored, the order is the name sort it always was", ids(orderMachines(natural, [])), ["m_a", "m_b", "m_c"]);
    check("a stored order leads, and the rest keep the name sort behind it", ids(orderMachines(natural, ["m_c"])), ["m_c", "m_a", "m_b"]);
    check("a machine the fleet no longer holds is dropped at draw time, not at write time", ids(orderMachines(natural, ["m_gone", "m_c"])), ["m_c", "m_a", "m_b"]);
    check("and a hand-edited duplicate cannot draw one machine twice", ids(orderMachines(natural, ["m_c", "m_c"])), ["m_c", "m_a", "m_b"]);
    /*
     * ⚠ **`natural` decides membership; `stored` decides only order.** Reading
     * them as symmetric is the mistake `agentStrip.ts` records having to name, and
     * here the consequence is sharper: `web-shell.md` says a machine with no
     * sessions still gets a tab, and that tab is the only route to starting a
     * session on a machine somebody has just added.
     */
    check("membership is the fleet's, and this may not narrow it", orderMachines(natural, ["m_a"]).length, natural.length);

    check("what is written back keeps a slot for a machine the fleet lost", nextOrder(["m_a", "m_gone", "m_b"], ["m_b", "m_a"]), ["m_b", "m_gone", "m_a"]);
    check("and a machine nobody had heard of is written at the end", nextOrder([], ["m_a", "m_b"]), ["m_a", "m_b"]);
    check("a duplicate cannot survive the round trip", nextOrder(["m_a", "m_a"], ["m_a"]), ["m_a"]);
    check(
      "and the stored list is bounded rather than validated",
      nextOrder([], Array.from({ length: 300 }, (_, i) => `m_${String(i)}`)).length,
      MAX_MACHINE_ORDER,
    );

    /*
     * ⚠ **Rounded by construction rather than by arithmetic.** `dropIndex` divides
     * travel by one measured row and is exact on a uniform column; a machine tab is
     * its label's width, so past the first neighbour that division drifts. This
     * counts midpoints instead and carries the same property — an entry swaps when
     * the dragged one is more than half over it — off a grid that is not one.
     */
    check(
      "an entry takes its neighbour's place as the pointer passes that neighbour's middle",
      [dropSlot([50, 150, 250], 0, 149), dropSlot([50, 150, 250], 0, 151), dropSlot([50, 150, 250], 0, 251), dropSlot([50, 150, 250], 2, 49)],
      [0, 1, 2, 0],
    );
    check("and a pointer that has not moved reports the slot it started in", dropSlot([50, 150, 250], 1, 150), 1);
  }

  /*
   * ⭐ **The machine this app runs beside: `local`, and first.** The owner's report
   * was the rail reading `M · MacBoo…` for its own computer, in name order — the
   * 2026-09-15 reversal had moved `local` off the stored label and onto a badge in
   * Settings → Machines, and nothing on the home screen read
   * `AppState.localMachineId` at all. Both halves are one fact asked twice, and
   * each is asserted here once: the name through `machineDisplayName`, the place
   * through `orderMachines`' `first`.
   */
  {
    const m = (id: string, name: string) => ({ id: id as MachineId, name });
    check("this computer's machine is called local", machineDisplayName(m("m_b", "MacBook-Pro"), "m_b" as MachineId), "local");
    check("and the word is the one constant", LOCAL_DISPLAY_NAME, "local");
    check("every other machine keeps its own name", machineDisplayName(m("m_a", "alpha"), "m_b" as MachineId), "alpha");
    check("and with no local daemon every machine does", machineDisplayName(m("m_b", "MacBook-Pro"), null), "MacBook-Pro");

    /*
     * ⚠ **One word, one computer.** Q7.139 migrated nothing, so a machine the app
     * set up while `local` was the stored label is still called that — the owner's
     * Mac carries `m_2405b5ea56616a65` labelled `local` beside the machine it runs
     * now — and any other can be renamed to it. Drawn plainly, two tiles read
     * `local` under one monogram. So another machine's `local` is drawn in
     * `qualifiedName`'s shape, which for that machine is exactly its
     * `machines.name`. Case-folded, and whether or not this computer is known.
     */
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

    /*
     * ⚠ **Which computer this is, merged rather than assigned** — `localMachineAfter`.
     * `host_local_daemon` answers only a daemon that passes `/health` inside its
     * probe, so an assigned answer put the host name and the name order back on
     * every wake where the daemon was restarting. And it answers across two roots,
     * so on a computer carrying a daemon for another fleet that one answers
     * whenever this server's is down — every cold launch, since the app stops its
     * own at quit — and must not move `local` off this computer's row.
     */
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

    /*
     * ⚠ **The memo, driven, for the reason the reorder's is.** `localMachineId`
     * is patched on its own — at a `runResume`, for a daemon that came up after
     * the app — and replaces neither `sessions` nor `machines`, so a guard without
     * it keeps the rail on the host name, in name order, until the poll hands over
     * a new array. Same `sessions`, same `machines`, and only the local id differs.
     *
     * Machine ids of its own, which no section has ever stored: an id in the
     * stored order is exactly what clause 1 must defer to, so borrowing `m_a` and
     * `m_b` would test the leftover rather than the rule. And a name that sorts
     * *last*, so leading is the clause's doing and not the alphabet's.
     */
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
    /*
     * The collision, through the real function: this computer and a machine
     * labelled `local` in one fleet draw one `local` between them.
     */
    const twin = [...fleet, machineOf("m_2405b5ea56616a65", "local")];
    const both = sessionGroups({ sessions: [], machines: twin, localMachineId: "m_zed" } as never);
    check(
      "a fleet holding a machine labelled local still draws the word once",
      both.groups.map((g) => g.name),
      ["local", "local-2405b5ea56616a65", "MacBook-Pro"],
    );
    check("losing it puts the name and the name order back", sessionGroups(away).groups.map((g) => [g.id, g.name]), [["m_mac", "MacBook-Pro"], ["m_zed", "zed"]]);

    /*
     * A drag stores the whole drawn list, so the first one pins this machine at
     * the place it was drawn — and after that clause 2 holds it wherever it is put.
     * These two ids are this section's alone, so what is left behind reorders
     * nobody else's fixture.
     */
    setMachineOrder(["m_mac", "m_zed"]);
    check("dragged down, it stays down", sessionGroups(here).groups.map((g) => g.id), ["m_mac", "m_zed"]);
    check("and is still called local there", sessionGroups(here).groups.map((g) => g.name), ["MacBook-Pro", "local"]);
    storage.delete("reemoat.machineOrder");

    /*
     * Off disk, for the call sites a value test cannot reach. Two positives —
     * the two labels that are not `MachineGroup.name` go through the one function
     * — and the negative that matters: Settings → Machines is where the label is
     * managed, so it must never draw the display name, or a rename would open on
     * `local`.
     */
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
    /*
     * ⚠ **And its default is that list's first reachable machine.** The picker is
     * drawn from `drawn`, so pinning only `drawn` leaves `reachable` free to go back
     * to `state.machines` — the control plane's order — with the tiles still right
     * and the default some other machine than the one the rail leads with.
     */
    check(
      "whose reachable machines are the drawn ones, in the drawn order",
      /const reachable = drawn\.map\(\(one\) => one\.machine\)\.filter\(/.test(start),
      true,
    );
    check("and the default is the first of them", /const selected = machine \?\? reachable\[0\]\?\.id \?\? null;/.test(start), true);
    check("with no second list of machines to disagree with it", /state\.machines/.test(start), false);
    /*
     * ⚠ **Every file under Settings, not one.** The label is renamed in
     * `MachineSection.tsx` (`RenameMachine`), one file along from the list this
     * used to read — so a rename field seeded from the display name would store
     * `local` on the row every client reads while this stayed green.
     */
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
    /*
     * ⚠ **And no screen spells the word itself.** A component writing
     * `id === state.localMachineId ? "local" : name` would draw the same thing
     * today and be the copy that disagrees tomorrow — the census is over every
     * file under `ui/` and the store, where each such copy would have to live.
     */
    check("the word is spelled once, in machineOrder.ts", (read("machineOrder.ts").match(/"local"/g) ?? []).length, 1);
    check(
      "and nowhere a screen or the store could draw it from",
      srcFiles().filter((file) => (file.startsWith("ui/") || file === "store.ts") && /"local"/.test(stripComments(srcFile(file)))),
      [],
    );
  }

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
   * ⚠ **A row with no folder header above it names the directory *without* the
   * `~/` that says which root** — `folderLabel`, not `displayCwd`.
   *
   * Every session on a machine is under the same root in the ordinary case, so
   * `~/` is two characters of pure agreement repeated down the rail, and they are
   * the two nearest the eye. Reported from a phone against the pinned rows.
   *
   * ⚠ **Withholding the folder itself was tried first and was wrong**, so the
   * negative is asserted beside the positive: cutting a pinned row against its own
   * `folderPathOf` blanks the line for every session launched at its repository
   * root, which is most of them. The folder has to still be there. Q3.581.
   */
  const ROOTS = ["/home/u"];
  check("a row drops the root marker and keeps the folder", folderLabel("/home/u/api", ROOTS), "api");
  check("and the marker is what displayCwd still carries", displayCwd("/home/u/api", ROOTS), "~/api");
  check("a session deeper in keeps every level below the root", folderLabel("/home/u/api/packages/web", ROOTS), "api/packages/web");
  check("the root itself stays the marker rather than becoming empty", folderLabel("/home/u", ROOTS), "~");
  check("and a path under no root is untouched", folderLabel("/opt/srv/thing", []), "…/srv/thing");
  check("withholding the folder is not the fix", rowSubpath(rows[0] as never, folderPathOf(rows[0] as never)), null);

  /*
   * ⚠ **And the title an unnamed session falls back to is the same string**, which
   * is a coupling rather than a preference: `SessionLine` suppresses the subline
   * when it would repeat the title, **by comparing the two strings**. A title
   * reading `~/thing` beside a subline reading `thing` draws one folder twice —
   * the exact defect that comparison was added to prevent. Asserted as the
   * composition the row actually performs, so the two cannot drift apart.
   */
  const unnamed = { snapshot: { title: null, workspace: { requestedCwd: "/home/u/api" } } };
  check("an unnamed session is named after its folder, with no marker", sessionLabel(unnamed as never, ROOTS), "api");
  check(
    "and the row's own path is the same string, so the duplicate is suppressed",
    sessionLabel(unnamed as never, ROOTS) === folderLabel("/home/u/api", ROOTS),
    true,
  );

  /*
   * Read off disk, because the arm above lives in the JSX and a driver with no DOM
   * cannot reach it. Without this the assertions are true of `paths.ts` and say
   * nothing about which function the rail actually calls.
   */
  {
    const rail = stripComments(readFileSync(new URL("../src/ui/SessionBrowser.tsx", import.meta.url), "utf8"));
    check(
      "the rail draws a folderless row with folderLabel, and no longer with displayCwd",
      [/folderLabel\(row\.snapshot\.workspace\.requestedCwd, roots\)/.test(rail), /displayCwd\(/.test(rail)],
      [true, false],
    );
    /*
     * ⚠ **Asserted on the element, not on a window of characters.** This was one
     * regex expecting `false`, requiring `folderPath={…}` within eighty characters
     * of `drag={drag.bind(row, PINNED_FOLDER)}` — and the four props already
     * between them are longer than that, so writing the forbidden prop in the
     * obvious place would have left the pattern unmatched and the check green over
     * the defect it names. A negative regex with a distance in it asserts the
     * distance, not the property.
     *
     * Sliced instead: every `<SessionLine … />` in the file, the Pinned one picked
     * out by the marker it drags against, and the prop looked for inside its own
     * element. The two floors under it are that the slice found exactly one Pinned
     * row, and that the sweep does see `folderPath` where it is genuinely passed —
     * so neither an element that stopped matching nor a prop that was renamed can
     * make this quiet.
     */
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
    "m_a/far",
    "m_a/live",
    "m_a/blocked",
  ]);
  selectMachine("m_b" as never);
  // After the waiting floor, which is `m_a/blocked` seen from `m_b`'s tab: a pin
  // leads its machine's list, and the floor leads everything.
  check("pinned leads on the machine it lives on", keys(visibleRows(groups, currentView(groups))), ["m_a/blocked", "m_b/kept", "m_b/other"]);
  selectMachine("all" as never);
  check("and under All every pin is drawn", keys(visibleRows(groups, currentView(groups))).slice(0, 2), ["m_a/far", "m_b/kept"]);
  /*
   * ⭐ **And the keyboard walks the list that is drawn, which it did not.**
   *
   * `siblingsOf` is what `Alt`+`↑`/`↓` moves a row within, and for a pinned row it
   * answered `groups.pinned` — every pin in the fleet — while the rail draws
   * `pinnedFor`, cut to the selected machine. So under `m_b`, `Alt`+`↓` on the
   * only pin drawn computed a position against a pin on `m_a`, wrote it, and
   * looked like it had done nothing; on the re-spacing path it wrote fresh
   * positions to `m_a`'s rows, which is a change with no visible cause anywhere on
   * screen.
   *
   * ⚠ **The filter is still ignored and that is not the same thing.** A row the
   * filter withholds is one the reader chose to hide, and stepping past it keeps
   * one press meaning one place however that control is set. A pin on another
   * machine is on a list this tab cannot draw at all.
   */
  selectMachine("m_b" as never);
  check("the keyboard's siblings for a pinned row are the pins on screen", keys(siblingsOf(byKey("m_b/kept"), groups)), ["m_b/kept"]);
  selectMachine("m_a" as never);
  check("and on the other tab they are that tab's", keys(siblingsOf(byKey("m_a/far"), groups)), ["m_a/far"]);
  selectMachine("all" as never);
  check("while All walks every pin, because All draws every pin", keys(siblingsOf(byKey("m_b/kept"), groups)), ["m_a/far", "m_b/kept"]);
  selectMachine("m_a" as never);
  /*
   * ⭐ **A blocked row does *not* lead its folder, and the absence is the
   * assertion.** It did, for as long as the rail sorted itself, and the hoist is
   * gone with the rest of that sorting: a position belongs to the reader, and one
   * that moves because an agent asked a question is one that moved by itself. Both
   * rows here are in `/home/u/api`; `live` is newer, so `live` is first.
   *
   * What carries "an approval cannot be hidden" is the line under this one, plus
   * the ringed dot and the semibold title on the row itself, plus `waitingFloor`'s
   * subtraction — three signals, none of which is a position, and all of which
   * work on a folder that is shut.
   */
  check("a blocked row keeps the place its reader gave it", keys(foldersOf(groups, currentView(groups))[0]?.rows ?? []), ["m_a/live", "m_a/blocked"]);
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
  // Exactly its rows: the pin above the folders is in a different group and stays.
  check("collapsing a folder removes exactly its rows", keys(visibleRows(groups, currentView(groups))), ["m_a/far"]);
  selectMachine("m_b" as never);
  check("a pinned row survives any collapse", keys(visibleRows(groups, currentView(groups))).includes("m_b/kept"), true);
  selectMachine("m_a" as never);
  // "blocked" would match nothing: the raw session id is deliberately not
  // searched, so a needle has to name something visible on the row.
  setQuery("api");
  check("but a search opens it again", keys(visibleRows(groups, currentView(groups))), ["m_a/far", "m_a/live", "m_a/blocked"]);
  setQuery("");
  toggleFolder(folder.id);
  check("expanding restores it", visibleRows(groups, currentView(groups)).length, 3);

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
    /*
     * ⚠ **This read "newest first" and meant `lastActivity`.** Under All the order
     * is the reader's too — anything else would make a conversation's position
     * depend on which tab it is read from. `done` (5) then `live` (4) then `other`
     * (2) then `blocked` (1), and the terminal row sitting at the top is the
     * honest consequence of one order per list: pushing it down would be a second
     * rule quietly undoing a drop onto it.
     */
    check("and holds the rest of the fleet in the order its reader gave it", keys(allRows(groups, { ...view, filter: "all" })), [
      "m_b/done",
      "m_a/live",
      "m_b/other",
      "m_a/blocked",
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
      // Distinct ages, so what these assert is a position rather than the
      // comparator's tie-break on the row key. Newest first.
      row("live", "m_gone", { createdAt: 3, status: "running" }),
      row("done", "m_gone", { createdAt: 1, status: "exited", exit: { reason: "stopped" } }),
      // Interrupted is the one the Ended filter must *not* collect — the daemon
      // ended it and is bringing it back — and it is the row most likely to be
      // mis-bucketed by a second, hand-written copy of the rule.
      row("back", "m_gone", { createdAt: 2, status: "exited", exit: { reason: "daemon_restarted" } }),
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
  /*
   * ⭐ **The rail is a scroller before it is a drag surface**, and this is the one
   * assertion that would catch the inversion of `agent-strip.md`'s own fix.
   *
   * There, `touch-none` on the handle is what makes a phone able to drag at all,
   * and the class being silently dead was a real defect that shipped. Here the
   * same class is the defect: the row *is* the surface a finger scrolls the
   * session list with, so `touch-action: none` on it takes scrolling away from
   * nine tenths of the rail to buy a gesture that arms only after 400ms of
   * stillness. `rowDrag.ts` sets it on the node imperatively for the *length* of a
   * drag, which cannot reach this string.
   *
   * ⚠ Not comment-stripped, exactly like the `groups.pinned` pair above: the ban
   * has to cover a mention in prose too, or the next reader writes "we could use
   * `touch-none` here" and the check goes quiet.
   */
  check("the rail is a scroller before it is a drag surface", /touch-none/.test(browser), false);
  /*
   * **And the axis it *does* claim is named, with the other two given back.** The
   * ban above says what may not be on this box; this says what is, because a
   * scroller that declares nothing leaves the swipe racing the pan it is trying to
   * replace. `pan-y` keeps the list scrolling and `pinch-zoom` keeps the page
   * zoomable, which a bare `pan-y` would not — and it is one arbitrary value
   * rather than two utilities, since two setting one property are resolved by
   * Tailwind's emission order rather than by the class string.
   */
  check("and the axis it does claim is named, with the other two given back", /\[touch-action:pan-y_pinch-zoom\]/.test(browser), true);
  /*
   * ⚠ **Comment-stripped, unlike the ban above it, and for the opposite reason.**
   * `touch-none` is banned as a *string* so prose cannot reintroduce it quietly;
   * this reads the row's own class expression, and the docblock beside it says in
   * as many words why `.press` is not there — a `scale(0.97)` held for the length
   * of a gesture reads as broken, which is `agent-strip.md`'s measurement. The
   * explanation may not be the thing that fails the check.
   */
  const rowClass = (() => {
    const code = stripComments(browser);
    const at = code.indexOf("lifted\n          ?");
    return at < 0 ? code.slice(code.indexOf("lifted"), code.indexOf("lifted") + 400) : code.slice(at, at + 400);
  })();
  check("and the row that lifts does not shrink under the finger", /\bpress\b/.test(rowClass), false);
  /*
   * The guard that does not depend on the cascade at all. React attaches
   * `onTouchMove` passively, so this can only be an `addEventListener`, and both
   * of the gesture's touch listeners are non-passive for the same reason: some
   * engines decide at `touchstart` whether a gesture can be refused at all, from
   * whether such a listener exists.
   */
  const rowDrag = readFileSync(new URL("../src/ui/rowDrag.ts", import.meta.url), "utf8");
  check(
    "a live drag can refuse the scroll it would otherwise become",
    /addEventListener\("touchmove", going\.move, \{ passive: false \}\)/.test(rowDrag),
    true,
  );
  check("and the drop suppresses the tap it sits on", /onClickCapture/.test(rowDrag), true);
  /*
   * All four endings, one `end`. A drag can finish by the pointer going up, by the
   * engine cancelling it, by the capture being taken away, or by the row ceasing
   * to exist — the last of which the phone's list → detail does on every
   * navigation, mid-gesture or not.
   */
  check(
    "and every way a drag can end is wired",
    ["onPointerUp:", "onPointerCancel:", "onLostPointerCapture:", "useEffect(() => end", "touchend"].map((form) =>
      rowDrag.includes(form),
    ),
    [true, true, true, true, true],
  );
  /*
   * ⚠ **`pointercancel` ends a mouse gesture and must not end a touch one.** For a
   * pointer it means the gesture is over; for a finger it means the browser has
   * decided the gesture is *its*, which is exactly the state this drag exists to
   * take back — and treating the two alike is what made three phone reports read
   * the same. The finger lifting is what ends it.
   */
  check(
    "a cancelled pointer ends a mouse drag and never a touch one",
    /onPointerCancel: \(event\) => \{[\s\S]{0,200}event\.pointerType === "mouse"/.test(rowDrag),
    true,
  );
  check("and losing capture is read the same way", /onLostPointerCapture: \(event\) => \{[\s\S]{0,300}event\.pointerType === "mouse"/.test(rowDrag), true);
  /*
   * ⭐ **A finger's gesture runs on the touch stream, and it *begins* there.**
   *
   * The pointer stream stops when the browser claims the gesture, so the drag was
   * moved onto `touchmove` — but the setup stayed in `onPointerDown`, and that is
   * the assumption three phone fixes never questioned: that `pointerdown` arrives
   * before the engine has decided what the touch is for. Blink dispatches it
   * first; nothing requires that, and on an engine that dispatches `touchstart`
   * first every one of those fixes was one event too late, every time, on that
   * engine only — which is the shape of a bug that works on every desktop and has
   * never once worked on a phone.
   *
   * So `touchstart` is where a finger's press is decided, and the row is found
   * from the event rather than from a closure.
   */
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
  /*
   * ⚠ **On the scroller, and put there by the ref callback.** A touch's target is
   * latched at `touchstart`, so the scroller is in the path of every event of the
   * gesture including those delivered after the finger has left it — and being an
   * ordinary element it is clear of the passive-by-default treatment `window`,
   * `document` and `body` receive. The ref callback rather than an effect because
   * they have to exist before the first `touchstart` the node can receive, and
   * because it is the only thing that answers the node being *replaced*.
   */
  check(
    "and they go on the scroller as it arrives, and come off the node they went on",
    /const scrollerRef = useCallback\([\s\S]{0,400}previous\.removeEventListener\("touchstart"/.test(rowDrag),
    true,
  );
  /*
   * ⭐ **Said in the one channel a thumb is covering the screen with.** A hold has
   * no visible beginning: for 400ms the app must look like it is doing nothing and
   * then it must be unmistakable that it is not — and the visual half of that is
   * under the finger, which is the part of the screen nobody can see. Optional at
   * the call because no desktop engine implements it and a missing method may not
   * be the reason a drag does not start.
   */
  check("and the arming is felt as well as drawn", /navigator\.vibrate\?\.\(/.test(rowDrag), true);
  /*
   * ⭐ **A mouse waits for movement and a finger waits for time**, and the split is
   * the whole reason this gesture existed and did nothing for a week. Holding a
   * button still for 400ms is a *touch* idiom — invented because a finger's other
   * verb on this surface is "scroll the rail" and the two have to be separated
   * before either commits. A pointer has a button: the press already says which
   * row, so waiting only put a window in front of the gesture in which the natural
   * response cancelled it.
   */
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
  /*
   * ⚠ **The pointer is taken when the drag arms, and taking it at the press
   * silently broke opening a session by clicking it.** A captured pointer
   * retargets everything that follows to the capturing element, the synthesised
   * `click` included — and the row is a `<div>` holding a navigating `<button>`,
   * so that click was delivered to the wrapper and the button was never in its
   * path. Measured through the debugging protocol rather than reasoned: `mousedown`
   * on the row's label, `click` on the wrapper, while the same click on the kebab
   * reaches its own button because that press returns before capturing anything.
   *
   * Comment-stripped, because the sentence above has to be allowed to say
   * `setPointerCapture` while the press is not allowed to call it.
   */
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
  /*
   * One `arm`, reached two ways. It was inline in the long-press timer, which is
   * exactly how a mouse came to have no way in at all — the decision and
   * everything after it were one block, so there was nowhere to enter but the top.
   */
  check("both reach the same arming, so only the decision differs", /const arm = \(\): void => \{/.test(rowDrag), true);
  /*
   * A row holds text, and a native drag of it would race ours and win — a ghost of
   * the title following the cursor while the row itself stays put.
   */
  check("and the browser's own drag is refused", /onDragStart: \(event: React\.DragEvent/.test(rowDrag), true);
  /*
   * ⚠ **The keyboard's way in survives the menu rows going.** `Move up` and `Move
   * down` are gone — reordering is a drag — and Q3.533's rule does not go with
   * them: a pointer gesture that is the only way to reorder is a control a
   * keyboard cannot reach at all. The row takes `Alt`+arrows, held with a modifier
   * because the bare ones belong to the list.
   */
  check("a keyboard can still reorder without a menu row to do it from", /event\.altKey/.test(rowDrag), true);
  check("and the menu no longer carries the two rows it did", /"Move up"|"Move down"/.test(readFileSync(new URL("../src/ui/SessionMenu.tsx", import.meta.url), "utf8")), false);
  /*
   * And the refusal says so, once somebody has plainly tried. A press is not yet a
   * question; a press that travelled is.
   */
  check("a machine that cannot store an order says so when somebody drags", /daemon is too old to store an order/.test(rowDrag), true);
  /*
   * ⭐ **Neighbours stand aside; nothing draws a line.** An insertion rule drawn as
   * a 2px bar tells a reader *where* but not *what*, and the list it is drawn over
   * stays visibly unchanged until the drop — so the gesture reads as aiming rather
   * than as moving. The agent strip's answer is the right one and is taken whole:
   * the rows between where the dragged one left and where it is going shift by
   * exactly one row, and the drop then changes nothing anybody can see.
   */
  // The bar itself, not the word: the docblocks beside it explain what it replaced
  // and may not be what fails the check.
  check("no insertion rule is drawn", [/drag\.line/.test(browser), /h-0\.5 bg-fg/.test(browser)], [false, false]);
  check("the neighbours move instead", /shiftFor\(/.test(browser), true);
  check("and the shift is a measured pixel count rather than a class", /transform: `translateY\(\$\{shift\}px\)`/.test(browser), true);
  check(
    "transitioned only while a drag is live, and never on the row under the pointer",
    /sliding && !lifted \? "transition-transform" : ""/.test(browser),
    true,
  );
  /*
   * ⚠ **Leaving Pinned unpins even where the folder is not drawn.** A collapsed
   * folder, or one the filter is hiding, is still where a session lives — so the
   * drop writes `pinned: false` and leaves the position alone rather than refusing
   * because it cannot see a list to place the row in.
   */
  check("leaving Pinned unpins whether or not the folder is on screen", /if \(zone === undefined\) \{[\s\S]{0,300}pinned: nowPinned/.test(rowDrag), true);
  /*
   * ⭐ **And a drop is never refused for arithmetic.** It answered *"there is no
   * room between those two rows, move a neighbour first"* — a sentence handing the
   * reader a problem they did not cause, cannot see and cannot act on. The gap is
   * the module's business: `resolveDrop` re-spaces and the drop happens.
   */
  check("a drop is never refused for want of room", /no room between those two rows/.test(rowDrag), false);
  check("it re-spaces instead", /resolveDrop\(/.test(rowDrag), true);
  /*
   * ⭐ **The last place in Pinned is reachable, and leaving Pinned costs a
   * deliberate movement.** With the group's own edge as the boundary, "last, still
   * pinned" was a band half a row tall with *unpinning* on the far side of it — so
   * aiming at the end of the list unpinned instead. The margin is asymmetric on
   * purpose: a row already in Pinned holds on past the edge, a row arriving from a
   * folder is not leaving anything and has no need to.
   */
  check("a row in Pinned holds on to it past the edge", /const sticky = going\.origin\.zone === PINNED_FOLDER \? UNPIN_MARGIN : 0;/.test(rowDrag), true);
  /*
   * ⚠ **And the boundary is distance, never an edge.** Widening the band only for
   * rows already pinned fixed the last slot for those and left it unreachable for
   * a row arriving from a folder — the same bug, reported a second time. Inside a
   * group is distance zero and the header gap between two groups splits down the
   * middle, so nothing has an edge to fall off.
   */
  check("and the boundary between two groups is whichever is nearer", /const nearer = gap\(pinnedZone\) - sticky <= gap\(ownZone\) \? pinnedZone : ownZone;/.test(rowDrag), true);
  /*
   * ⚠ **A translate does not make room.** A row carried between groups makes one a
   * row taller and the other a row shorter; shifting the rows below an insertion
   * point moves them *over* whatever follows the group, which is Pinned riding on
   * top of the sessions under it.
   */
  check("a group joined reserves the height and one left gives it back", /spaceFor\(/.test(browser), true);
  check("and it is the group that takes it, not the rows", /marginBottom/.test(browser), true);
  /*
   * ⚠ **The room and the rows move on one clock.** The rows animate under
   * `transition-transform`; the height they were moving into appeared in a jump,
   * so a row crossing into Pinned slid while everything below it snapped. Bare
   * `transition-[margin-bottom]` takes the same default duration and easing, which
   * is the point: two numbers that had to agree became one.
   */
  check("and it animates on the same clock the rows do", /transition-\[margin-bottom\]/.test(browser), true);
  /*
   * ⚠ **And the dragged row is anchored to where it actually is.** Carrying it up
   * into Pinned makes that group a row taller, which pushes the folder it came
   * from — and the row itself — down by exactly one row. Against a fixed origin
   * the transform did not know, and the row leapt a row's height at the crossing.
   */
  check("the dragged row's offset is measured from its real base", /getBoundingClientRect\(\)\.top - going\.applied/.test(rowDrag), true);
  /*
   * Unpinning is the one outcome of this gesture that carrying the row back does
   * not undo, so it is the one that says what release will do before it happens.
   */
  check("what release will do is said at the pointer", /Release to unpin/.test(browser), true);
  check("and it follows the pointer without a render a frame", /pillRef/.test(browser), true);
  /*
   * ⚠ **The row is the drag surface except where it already carries a control.** A
   * mouse takes the pointer at the press, so the kebab's own `click` was retargeted
   * to the row and the menu stopped opening at all.
   */
  check("the row's trailing controls are not a place to grab it by", /data-no-drag/.test(browser), true);
  check("and the gesture honours that rather than testing for a tag", /closest\("\[data-no-drag\]"\)/.test(rowDrag), true);
  /*
   * iOS cancels a long press it has decided is a text selection, which fires
   * `pointercancel` before the timer runs: a press that does nothing, on a phone,
   * with nothing on screen saying why.
   */
  check("a long press is not handed to the platform's own selection", /-webkit-touch-callout/.test(rowDrag), true);
  /*
   * ⚠ **`-webkit-touch-callout` is set from `touchstart` and not from
   * `pointerdown`**, which is the same ordering argument as the gesture's own: iOS
   * decides at `touchstart` whether a long press on this element raises its
   * callout, and set from a handler that may run afterwards it arrives after the
   * decision it exists to change.
   */
  check(
    "and it is switched off before the engine has decided, not after",
    (() => {
      const code = stripComments(rowDrag);
      const at = code.indexOf("const onTouchStart");
      return at < 0 ? false : code.slice(at, code.indexOf("const onTouchMove", at)).includes("-webkit-touch-callout");
    })(),
    true,
  );

  /*
   * ⚠ **Only one index means "it did not move", and it used to be two.**
   *
   * `origin.index` counts the zone's rows *with* the dragged one among them;
   * `target.index` is a slot among the others, which is what `resolveDrop` takes.
   * In those two coordinate systems the sole drop that changes nothing is
   * `target === origin` — slot `origin + 1` puts the row one place *below* where
   * it was. Treating that as a no-op swallowed every move down by exactly one
   * place, in silence, and the last slot of a group is reachable from the row
   * above it in no other way. Reported twice, in two different words, before the
   * two coordinate systems were written down beside each other.
   *
   * Comment-stripped, so the paragraph above may describe the bug in the terms
   * the code is banned from using.
   */
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

  /*
   * ⚠ **Every row draws its menu, and the rule this replaces was a reveal on
   * hover for every row but a pinned one.**
   *
   * Reported as "why do the pinned ones have three dots and the others not" —
   * which is the reveal working exactly as written and being wrong anyway: two
   * rows a few pixels apart, alike in every other way, and one of them has a
   * control. Keyed on a *pointer* query rather than a width read, which was the
   * right half; what it got wrong is that a row's only menu, hidden until the
   * pointer is already on the row, is undiscoverable — and a list is being read
   * rather than aimed at for almost all of the time it is on screen.
   *
   * The ink was already being spent, so nothing about the row's width, its
   * truncation point or the tap pad's reach past the scroller moves: pinned rows
   * have drawn it unconditionally all along.
   */
  check(
    "the row's menu is drawn on every row, pinned or not",
    (() => {
      const code = stripComments(browser);
      /*
       * ⚠ **Anchored on `SessionMenu`, because `data-no-drag` is no longer
       * unique in this file.** This read the *first* occurrence, which was the
       * kebab only for as long as the kebab was the only control on the row —
       * the rename field now carries the marker too, and it is drawn earlier, so
       * the old spelling silently started asserting against the wrong tag. What
       * is being pinned is unchanged: the kebab's opening tag is a constant
       * class string, so a conditional reveal reintroduced there fails outright.
       */
      const menu = code.indexOf("<SessionMenu");
      if (menu < 0) return "the kebab is gone";
      const at = code.lastIndexOf("data-no-drag", menu);
      return at < 0 ? "the kebab is not marked" : code.slice(at, code.indexOf(">", at) + 1).replace(/\s+/g, " ").trim();
    })(),
    'data-no-drag className="mr-2.5">',
  );
  check("and the reveal it used to be keyed on is gone with it", /focus-within:opacity-100/.test(browser), false);

  /*
   * ⚠ **Typing beats the reorder shortcut, which is the app's standing rule and
   * the one place a new handler skipped it.** `web-shell.md`: typing beats every
   * layer (`isTypingInto`). The rename field is a descendant of the element
   * carrying `onKeyDown` and is autofocused, and on macOS Option+↑/↓ is a caret
   * movement inside a text field — so without the guard, renaming a session
   * silently reorders the list instead of moving the caret.
   */
  {
    const drag = stripComments(readFileSync(new URL("../src/ui/rowDrag.ts", import.meta.url), "utf8"));
    // `lastIndexOf`, because `RowDrag` declares `onKeyDown:` in its interface
    // before `bind` implements it, and the declaration is not what is guarded.
    const at = drag.lastIndexOf("onKeyDown:");
    check(
      "typing beats the reorder shortcut, like every other key in this app",
      at >= 0 && /^[\s\S]{0,200}isTypingInto\(/.test(drag.slice(at)),
      true,
    );
  }

  /*
   * ⚠ **A re-space writes the neighbours through one guarded helper, and both
   * paths use it.**
   *
   * `resolveDrop` can hand back every row in a folder, and the loop that used to
   * write them tested nothing and reported per row. Two failures came out of that,
   * and both are invisible in a screenshot: under the All tab `PINNED_FOLDER` is
   * one group spanning machines, so a neighbour can be on a daemon that has never
   * heard of `rank` and answers 400 to a body carrying only that field; and a
   * re-space of thirty rows answered with thirty toasts.
   *
   * Asserted as *no bare loop over `landed.also`* plus the two properties of the
   * helper, because the fix is a shape rather than a value and there is no driver
   * in this repository that can reach the gesture itself.
   */
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

  /*
   * ⚠ **The rename field is a control on the drag surface, and it has to say so.**
   *
   * `rowDrag.ts` states the rule — the row is the drag surface *except* where it
   * already carries a control, marked on the markup rather than tested by tag —
   * and a text field is the case where breaking it costs the most: a mouse
   * drag-select over the name passes `MOUSE_SLOP` and arms the drag, and a long
   * press to place a caret passes `PRESS_MS` and does the same, after which the
   * row wears `user-select: none` and the field cannot be selected in at all.
   * Asserted against the *wrapper immediately before* `RenameField` rather than
   * anywhere in the file, so a marker that drifts off it fails.
   */
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


/* ------------------------------------------------------------------ *
 * Whose order the rail is in
 *
 * It used to be the app's: blocked rows to the top of their folder, everything
 * else by its most recent event. Both were defensible, both were opinions about
 * somebody else's conversations, and together they meant a list rearranged itself
 * under a thumb on the four-second poll. The position belongs to the reader now.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhose order the rail is in\n");
{
  const at = (id: string, over: Record<string, unknown> = {}) =>
    ({ key: `m/${id}`, ref: { machineId: "m", sessionId: id }, machineName: "m", snapshot: { ...snapshot, id, ...over }, daemonNow: 0, fetchedAt: 0 }) as never;
  const ids = (rows: readonly { key: string }[]) => rows.map((row) => row.key.slice(2));

  /*
   * ⭐ **Three answers, not two, and the absent one is written as a *missing
   * property* rather than as `rank: undefined`.** Spelling it the other way makes
   * the case pass for the wrong reason: `"rank" in snapshot` is what tells a
   * daemon that has never heard of the field from one saying nobody has moved this
   * row, and only the first takes the gesture away.
   */
  check("an unset position is the moment the session was made", effectiveRank({ createdAt: 100 }), 100);
  check("and so is one the daemon says nobody has set", effectiveRank({ createdAt: 100, rank: null }), 100);
  check("while a set one is itself", effectiveRank({ createdAt: 100, rank: 7 }), 7);
  check(
    "a daemon that cannot store an order is known by the absent field, never by a version",
    [canReorder({}), canReorder({ rank: null }), canReorder({ rank: 7 })],
    [false, true, true],
  );

  /*
   * ⚠ **Total, and that is correctness rather than tidiness.** Two sessions can
   * share a millisecond, the input order changes between polls, and
   * `Array.prototype.sort`'s stability says nothing about a list whose *input* is
   * re-derived — so a comparator answering 0 for such a pair is two rows that swap
   * places on the poll, which is the exact behaviour this whole change removes.
   */
  const tied = [at("c", { createdAt: 5 }), at("a", { createdAt: 5 }), at("b", { createdAt: 5 })];
  check("rows sharing a millisecond still have one order", ids(orderSessions(tied)), ["a", "b", "c"]);
  check("and it does not depend on the order they arrived in", ids(orderSessions([...tied].reverse())), ["a", "b", "c"]);
  check("ordering twice changes nothing", ids(orderSessions(orderSessions(tied))), ["a", "b", "c"]);
  check("and the input is never mutated", ids(tied), ["c", "a", "b"]);

  /*
   * **A new session is at the top of its folder, above a row somebody dragged
   * there** — because a drop writes an instant between two that have already
   * passed, and `RANK_STEP` is one millisecond. Any larger step would put a
   * dragged row above sessions that do not exist yet.
   */
  const dragged = at("dragged", { createdAt: 10, rank: 1000 + RANK_STEP });
  const fresh = at("fresh", { createdAt: 2000 });
  check("a session created since a drag still leads it", ids(orderSessions([dragged, fresh])), ["fresh", "dragged"]);
  check("and a row nobody touched sits by its age", ids(orderSessions([at("old", { createdAt: 1 }), at("new", { createdAt: 9 })])), ["new", "old"]);

  /*
   * **A drop is one write, and it lands strictly between its neighbours.** The
   * ends are the two `null` arms: nothing above means the top of the group.
   */
  check("a drop between two rows lands between them", rankBetween(10, 8), 9);
  /*
   * ⚠ **These two read `8 - RANK_STEP` and `10 + RANK_STEP` and were both wrong**,
   * which is what a case written from the implementation rather than from the
   * intent buys: it agreed with an inversion that sent every drop at the top of a
   * group to the bottom. The order is descending, so higher up the list is a
   * *greater* number.
   */
  check("a drop at the top is one step above what is there", rankBetween(null, 8), 8 + RANK_STEP);
  check("and at the bottom, one step below", rankBetween(10, null), 10 - RANK_STEP);
  check("neighbours in the wrong order are refused rather than guessed", rankBetween(8, 10), null);
  check("and so is a pair with nothing on either side", rankBetween(null, null), null);

  /*
   * ⚠ **Running out of room is a real answer.** At a `createdAt` around 1.77e12 a
   * double's ulp is about 0.0005, so a one-millisecond gap admits roughly eleven
   * bisections before the midpoint *is* an endpoint. Nobody reaches it by
   * accident; what makes it worth detecting is that the failure is silent — two
   * equal positions, the key tie-break decides, and the row appears not to have
   * moved.
   */
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

  /*
   * ⭐ **A drop is never refused for arithmetic.** It used to answer *"there is no
   * room between those two rows, move a neighbour first"* — a sentence handing the
   * reader a problem they did not cause, cannot see and cannot act on. Where a gap
   * is used up the group is re-spaced and the drop happens; what changes is how
   * many rows are written, which is a fact about the request rather than about the
   * gesture.
   */
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

    /*
     * Two rows whose positions are adjacent doubles: the gap is gone, and this is
     * the state that used to be a sentence. Every row of the group is written,
     * strictly descending, with the dragged one in the slot it was dropped into.
     */
    /*
     * The two positions are adjacent doubles — `1e-6` below 1.77e12 is under the
     * ulp there, so the pair is as close as a double can be and the midpoint *is*
     * an endpoint. This is the state that used to be a sentence.
     */
    const packedTop = 1_770_000_000_001;
    const tight = [row("x", packedTop), row("y", packedTop - 1e-6)];
    check("the fixture really has no room left in it", rankBetween(packedTop, packedTop - 1e-6), null);
    const packed = resolveDrop(tight, 1, dragged);
    check("a gap that is used up re-spaces rather than refusing", packed.also.length > 0, true);
    // The fixtures are cast for the driver's stubbed shapes, so the key is read
    // through one narrow accessor rather than by widening every one of them.
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

/* ------------------------------------------------------------------ *
 * Which way a menu opens, decided once
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **A menu panel that does not fit below its trigger grows the scroller it is
   * inside, and a scrollbar appears down the rail.** `SessionBrowser`'s own
   * scroller comment already carries the fact — *a positioned descendant is part
   * of the scrollable overflow region* — and it caught the kebab's tap pad on the
   * horizontal axis. The panel itself is the same class of defect on the vertical
   * one, and it shipped: tapping a session's kebab put a bar down the side of the
   * list.
   *
   * What makes it a check rather than a fix is that the question was answered
   * **twice**, in two files, and one of the two answers was measuring the wrong
   * box. `UsersSection` read `window.innerHeight` while its pane is
   * `overflow-y-auto`, so the viewport said "room below" about a box that ended
   * two hundred pixels higher — invisible there only because that pane carries
   * `no-scrollbar`. One spelling now, in `bits.tsx`, and this is what keeps it one.
   */
  const files = srcFiles();

  /*
   * The property stated directly, rather than a pattern for the one shape the
   * homegrown version happened to have. A first attempt matched
   * `innerHeight - rect.bottom` and a rewrite with one pair of brackets walked
   * straight through it — which is the usual fate of a census that describes the
   * defect instead of the rule.
   */
  const homegrown = files.filter((f) => {
    const body = stripComments(srcFile(f));
    return [...body.matchAll(/setPlacement\(/g)].some(
      (m) => !body.slice(m.index + m[0].length).startsWith("menuPlacement("),
    );
  });
  check("every menu takes its direction from the one helper", homegrown, []);

  /*
   * The two menus that can sit inside a scroller both ask. Named rather than swept,
   * because what is interesting is that these *specific* two do it — a sweep over
   * "every file with a popover" would pass on a file that has no popover left.
   */
  for (const file of ["ui/SessionMenu.tsx", "ui/settings/UsersSection.tsx"]) {
    check(`${file} asks where there is room`, /menuPlacement\(/.test(stripComments(srcFile(file))), true);
  }

  /*
   * And the cap is read off the class that enforces it rather than guessed. The
   * constant it replaced was 240 — neither `max-h-72` nor any real panel's height.
   */
  const bits = stripComments(srcFile("ui/bits.tsx"));
  const cap = /export const MENU_MAX_PX = (\d+);/.exec(bits)?.[1] ?? "";
  const cls = /max-h-(\d+)/.exec(bits)?.[1] ?? "";
  check("the room a menu needs is the height its own class caps it at", cap, String(Number(cls) * 4));
}
