import type { AgentCommand, AgentConfig, AgentConfigOption } from "../wire";
import { choiceOverride, choiceRefusal, labelFor, slotFor, type ConfigProse } from "./agentConfig";

/**
 * What a `/` in the composer means, as pure functions.
 *
 * Here rather than inside the popup for the reason `agentConfig.ts` and `keys.ts`
 * are: `webcheck` has no DOM, so a rule expressed as JSX is untested by
 * construction — and every rule in this file fails *silently*. A parser that
 * opens one character too eagerly, a merge that loses a control, a ranking that
 * buries the command somebody is typing: none of them throw, and none of them are
 * visible from a keyboard that is not the author's.
 */

/**
 * One row of the menu, from one of two sources — and the split is the point.
 *
 * A `prompt` entry is something the agent published. Choosing it writes
 * `/name ` into the box and sending it is the ordinary prompt path, because ACP
 * has no other way to invoke a command: there is no `session/execute_command`,
 * and a command *is* a message that starts with a slash.
 *
 * A `config` entry is synthesized here out of `agentConfig`, **by category and
 * never by id**, and choosing it opens the agent's own structured choices and
 * applies through `POST /sessions/:id/config`. No text is ever sent.
 *
 * That second kind is not a convenience. **Neither agent publishes `/mode` at
 * all**, and kimi publishes none of the three — it publishes six builtins plus
 * skills — so on kimi these exist only because they are built, and could not work
 * any other way: an unrecognised slash command is intercepted by its adapter and
 * answered "Unknown ACP command" without ever reaching the model.
 *
 * Whether *claude* advertises `/model` and `/effort` is deliberately not asserted
 * here, and nothing in this file depends on the answer — see the shadowing rule
 * in `buildCommands`, which holds either way. It was asserted, in two places, in
 * opposite directions from CLAUDE.md and under the same measurement date; a claim
 * this file does not need is a claim it should not be the third place to make.
 */
export interface CommandEntry {
  kind: "prompt" | "config";
  /** Without the leading slash. `compact`, `mcp:github`, `model`, `effort`, `plan`. */
  name: string;
  description: string;
  /**
   * ACP's free-text argument hint, for a placeholder. `prompt` entries only.
   *
   * Shown, never inserted — see {@link completion}.
   */
  hint: string | null;
  /** The control a `config` entry stands for. Non-null exactly when `kind === "config"`. */
  option: AgentConfigOption | null;
  /**
   * The value this entry applies on its own, skipping the choice list.
   *
   * Non-null only for a mode: `/plan` is not "open the mode picker", it is
   * "switch to plan mode", which is one gesture and should cost one tap. Every
   * other `config` entry leaves this null and opens its choices as a second
   * stage. Implies `option !== null`.
   */
  value: string | null;
}

/** Where the slash token starts, and what has been typed into it so far. */
export interface SlashQuery {
  /**
   * Always `0` today, and the arithmetic in {@link completion} reads as an offset
   * only so the splice is obviously a splice. The parse rule below pins the slash
   * to index 0 deliberately, so this is not a hook for a word-boundary variant —
   * that case is the one the rule exists to refuse.
   */
  start: number;
  /**
   * The text between the slash and the caret — which is **not** necessarily the
   * whole token. The caret is allowed to sit inside the name, so `/mo|del` gives
   * `"mo"` while the token is still `model`. {@link completion} is the one place
   * that has to know the difference.
   */
  query: string;
}

/**
 * The slash token under the caret, or `null` when there is not one.
 *
 * **The `/` must be at index 0 of the whole message.** Not "at a word boundary",
 * which is the rule most editors use and the wrong one here, twice over.
 *
 * It is wrong for the agents. Kimi's adapter runs `startsWith("/")` against the
 * leading text block whole, and claude's CLI parses a command only at the start
 * of a message — so a `/` after a space or a newline is not a command on either,
 * and completing one there would build a message that silently does nothing.
 *
 * And it is wrong for this app in particular, whose composer is full of paths:
 * `src/events.ts`, `~/.reemoat/worktrees/…`, `--path-format=absolute`. A menu
 * that opened on `cd /usr` is `j`-in-the-composer wearing a different hat.
 *
 * Closes as soon as whitespace follows the name, because at that point the name
 * is settled and what follows is free text — ACP gives nothing to complete it
 * against but a hint.
 */
export function slashQuery(text: string, caret: number): SlashQuery | null {
  if (!text.startsWith("/")) return null;
  // Caret 0 sits *before* the slash: nothing has been committed to yet, and a
  // menu that opened there would answer a question nobody has asked.
  if (caret < 1 || caret > text.length) return null;
  const query = text.slice(1, caret);
  // Any whitespace at all, including the newline that a multi-line message
  // starts with. `\s` rather than a space so a tab and a newline cannot each be
  // rediscovered as a special case later.
  if (/\s/.test(query)) return null;
  // The caret is inside the name, but the name may continue past it; if what
  // follows is an argument the token is still the name, and if it is more of the
  // name that is fine too. What must not happen is completing a token whose tail
  // is already whitespace-separated — that is the case above.
  return { start: 0, query };
}

/**
 * Which control becomes which command name.
 *
 * Keyed on ACP's `category`, exactly like `CATEGORY_SLOT` in `agentConfig.ts` and
 * for exactly the same reason: claude publishes reasoning effort as `effort` and
 * kimi publishes the same concept as `thinking`, so a table keyed on ids gives
 * one agent a `/effort` and the other nothing. The *name* is ours because the id
 * is not portable — which is the whole trick that makes these three commands mean
 * the same thing on every agent.
 */
const CATEGORY_COMMAND: Record<string, string> = {
  mode: "mode",
  model: "model",
  thought_level: "effort",
};

/**
 * A command name that can actually be typed.
 *
 * Used where the agent's own identifier is the only candidate there is: an
 * unknown category, and every mode value. Using an id to *name* a control is not
 * the same thing as finding one by it — the rule this file is built on is about
 * lookup.
 *
 * **Case is preserved**, and it was not: lowercasing turned claude's real mode
 * `acceptEdits` into `acceptedits`, which is neither what the agent calls it nor
 * what anybody would read back. Case was never needed for typeability — nothing
 * here is a shell — and `rankOf` folds it anyway, so typing `acceptedits` still
 * finds it. Only characters that could not survive being typed as one token are
 * replaced.
 */
export function typeableName(id: string): string | null {
  const name = id.trim().replace(/[^A-Za-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name.length === 0 ? null : name;
}

/**
 * The whole menu: the agent's controls first, then the agent's own commands.
 *
 * Controls first because those three exist on every agent, are the ones with no
 * other home on kimi, and are a fixed tiny set that cannot shove the agent's list
 * around as it grows.
 *
 * **The agent's list is sorted into exactly two tiers, and no further.** This
 * said the list is never re-sorted, on the grounds that ranking is the filter's
 * job — see the block above the loop for the measurement that reversed it, and
 * for why the tier is read off the description. Ranking *is* still the filter's
 * job: within a tier the agent's own order decides everything, which is the
 * client-side corollary of the daemon's rule that arrival order stays delivery
 * order.
 */
export function buildCommands(
  commands: readonly AgentCommand[],
  config: AgentConfig | undefined,
  // Read-only: `configProse` memoises, so this Map is shared with `AgentConfigBar`.
  prose?: ReadonlyMap<string, ConfigProse>,
  agent?: string,
): CommandEntry[] {
  const entries: CommandEntry[] = [];
  const taken = new Set<string>();
  /*
   * Restored built-ins count as published from here on: they are commands the
   * agent accepts, so they claim their names against a mode shortcut exactly as
   * the advertised ones do.
   *
   * **Appended, not prepended**, and the order is load-bearing rather than
   * incidental. `rankOf` breaks ties by build index, so prepending made `/clear`
   * — irreversible agent amnesia — outrank `/compact` and `/context` for the
   * query `c`, the most natural prefix in claude's whole list. Restored entries
   * are also the ones we are least sure of, so they lose a name collision to
   * anything the agent advertises itself.
   */
  const available = [...commands, ...(RESTORED[agent ?? ""] ?? [])];

  for (const option of config?.options ?? []) {
    // `model_config` is hidden from the control strip by product decision, and a
    // slash command would reintroduce it through the back door. Unknown
    // categories are still only demoted there, and here they still get an entry.
    if (slotFor(option) === "hidden") continue;
    /*
     * A control with nothing to choose between is not a command.
     *
     * `kind: "boolean"` carries no `choices` at all (`wire.ts` says so), and a
     * select can arrive empty. Either one used to produce a menu row whose second
     * stage was a list of length zero — so choosing it cleared the whole draft
     * (`completion`'s config arm) and then rendered nothing, because `menuOpen`
     * requires a non-empty list. A dead end that eats what you typed.
     *
     * Skipped rather than given a synthetic on/off list: nothing here knows what
     * a particular boolean means, the control strip already draws them as toggles
     * where they belong, and inventing two labels for an agent-defined flag is
     * exactly the id-keyed guessing this file exists to avoid.
     */
    if (option.kind !== "select" || option.choices.length === 0) continue;
    const name = CATEGORY_COMMAND[option.category ?? ""] ?? typeableName(option.id);
    if (name === null || taken.has(name)) continue;
    taken.add(name);
    entries.push({
      kind: "config",
      name,
      // `labelFor`, not `option.name`, so the row that opens the effort control
      // does not describe itself as "Thinking" one line under a name of `effort`.
      description: option.description ?? labelFor(option),
      hint: null,
      option,
      value: null,
    });
  }

  /*
   * Each mode as its own command, so `/plan` means what somebody typing it means.
   *
   * Switching mode is the one control that is a *verb*: it is what you reach for
   * mid-conversation, several times an hour, and "open the mode picker and then
   * choose plan" is two gestures for one intention. So the choices are lifted to
   * the top level and applied in one tap.
   *
   * **Modes only, and by category rather than by id.** The names come from
   * whatever the agent publishes — measured, claude offers `auto`, `default`,
   * `acceptEdits`, `plan`, `dontAsk` and `bypassPermissions` — so nothing here
   * knows the word "plan", and an agent with different modes gets its own. The
   * other categories are deliberately left alone: a model list expanded this way
   * would put `/opus[1m]` in the menu, and reasoning effort has five values whose
   * names mean nothing standing on their own.
   *
   * A published command **wins** a name collision, which is the opposite of the
   * rule above and deliberately so. `/model` shadows because sending it as text
   * is a dead end; a mode shortcut is a convenience, and a command the operator
   * actually installed is more specific intent than a shortcut we synthesized.
   *
   * **The name is the id, always**, and an attempt to make `/default` read better
   * by typing it as `/manual` was built and taken back out. The id is what makes
   * these portable across agents — both call the manual mode `default` underneath
   * — and it is also what somebody who knows the agent will reach for. What
   * "Default" fails to say is answered by the description under the row (see
   * `choiceOverride`), which is the place with room for a sentence, rather than by
   * this client deciding the command is called something else.
   */
  const mode = (config?.options ?? []).find((option) => option.category === "mode" && option.kind === "select");
  if (mode !== undefined) {
    const published = new Set(available.map((command) => command.name));
    const modeProse = prose?.get(mode.id);
    for (const choice of mode.choices) {
      const override = choiceOverride(mode, choice.value);
      const name = typeableName(choice.value);
      if (name === null || taken.has(name) || published.has(name)) continue;
      taken.add(name);
      entries.push({
        kind: "config",
        name,
        // The choice's own sentence where there is one — "Planning mode, no
        // actual tool execution" says far more than "Plan Mode". The snapshot
        // keeps only the *selected* choice's prose, so the rest arrive through
        // `configProse` off the transcript; the override's sentence is what a
        // renamed value falls back to, and the name is the floor under both.
        description:
          choice.description ??
          modeProse?.choices.get(choice.value) ??
          override?.description ??
          choice.name,
        hint: null,
        option: mode,
        value: choice.value,
      });
    }
  }

  /*
   * The agent's own commands, built-ins first — and this reverses a rule.
   *
   * It used to say the list is never re-sorted, on the grounds that ranking is
   * the filter's job and the unfiltered order is the agent's. Measured, that
   * order is *installation* order: 53 of claude's 99 here are `(user)`-scoped
   * skills, and they come first, so opening the menu showed somebody's skill
   * collection while `/compact`, `/context` and `/model` sat past position fifty
   * behind a scroll. An order that buries every command the agent itself ships is
   * not neutrality, it is a worse answer that happened to require no code.
   *
   * Two tiers and nothing finer, order preserved inside each — a stable sort, so
   * what the agent sent still decides everything the scope does not.
   */
  const scoped = available.map((command, index) => ({
    command,
    index,
    tier: commandScope(command.description) === null ? 0 : 1,
  }));
  scoped.sort((a, b) => a.tier - b.tier || a.index - b.index);

  for (const { command } of scoped) {
    /*
     * A control beats an identically-named command, and the shadowed one is
     * dropped rather than renamed.
     *
     * Unconditional, and written not to depend on whether claude advertises
     * `/model` today — its list is the CLI's `supportedCommands()` minus a
     * denylist containing neither `model` nor `effort`, so the collision is live
     * the moment a CLI release adds them, if it has not already. What decides the
     * rule is what happens when it is live: in a terminal `/model` opens an
     * interactive picker, and over ACP there is no interactive picker — so
     * sending it as text is a dead end that ends the turn with a prompt nobody
     * can answer. The control applies through `POST /config` and shows the
     * agent's own choices. The control wins.
     */
    if (taken.has(command.name)) continue;
    taken.add(command.name);
    entries.push({
      kind: "prompt",
      name: command.name,
      description: command.description,
      hint: command.hint,
      option: null,
      value: null,
    });
  }

  return entries;
}

/**
 * Where a command came from, read out of the only place claude says so.
 *
 * `"Router for the gstack skill suite. (gstack) (user)"` — the scope is a suffix
 * on the *description*, because ACP's `AvailableCommand` has nowhere else to put
 * it: `{name, description, input}` is the whole type, the adapter drops `_meta`,
 * and the SDK's own `SlashCommand` carries no scope field either. So this is
 * prose parsing, and it is prose parsing on purpose rather than by oversight.
 *
 * **It fails safe in the only direction that matters.** An unrecognised shape is
 * `null`, which sorts with the built-ins — so an agent that never adopted this
 * convention (kimi says nothing of the sort) keeps its list in exactly the order
 * it sent, and a future claude that changes the wording degrades to that same
 * behaviour rather than to a wrong one. The cost of being wrong here is the order
 * of a menu, not a command that does the wrong thing.
 */
export function commandScope(description: string): "user" | "project" | null {
  const match = /\((user|project)\)\s*$/.exec(description);
  return match === null ? null : (match[1] as "user" | "project");
}

/**
 * Commands the agent's adapter hides but which measurably work.
 *
 * claude's `getAvailableSlashCommands` filters eight names out of the list before
 * sending it — `clear`, `cost`, `keybindings-help`, `login`, `logout`,
 * `output-style:new`, `release-notes`, `todos` — so nothing here can offer them
 * however it is written. That exclusion is about what is *advertised*, not about
 * what the CLI accepts, and the two are not the same thing.
 *
 * Measured 2026-08-03 against claude 0.63.0 over ACP: seeding a codeword,
 * sending `/clear`, then asking for it back answers `NO MEMORY`. It works.
 *
 * **Restored one at a time, and only after being driven.** The other seven are
 * not here because they have not been measured and several plainly should not be:
 * `login` and `logout` would break the session's credentials from a box that has
 * a Settings screen for exactly that, and `keybindings-help` and
 * `output-style:new` are interactive terminal UI with nothing to render into.
 * This is a list to grow by measurement, never by guessing at the other seven.
 */
const RESTORED: Partial<Record<string, AgentCommand[]>> = {
  claude: [
    {
      name: "clear",
      // The consequence is the description, because it is not reversible and this
      // is the only place it can be read before it happens: the daemon's log is
      // not the agent's memory, so the transcript above goes on showing a
      // conversation the agent no longer has.
      description: "Start fresh — the agent forgets this conversation, the transcript above stays",
      hint: null,
    },
  ],
};

/** Anything with a name and a description can be ranked by this. */
interface Rankable {
  name: string;
  description: string;
}

/**
 * Rank by how the query matches, and never fuzzily.
 *
 * Prefix-first is the property that matters: a subsequence match over an
 * unfamiliar sixty-item list puts `keybindings-help` above `compact` for `co`,
 * and nobody can predict it. A typeahead's only real job is to be guessable.
 *
 * The segment tier is what makes `github` find `mcp:github`, which matters
 * because claude renames every MCP command into that shape and nobody types the
 * prefix.
 *
 * Descriptions match only from two characters, since a one-letter substring in a
 * sentence matches everything and would silently turn the list back into no list.
 */
function rankOf(item: Rankable, query: string): number {
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[:\-_]/).some((segment) => segment.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (query.length >= 2 && item.description.toLowerCase().includes(query)) return 4;
  return -1;
}

/**
 * The entries matching a query, best first.
 *
 * An empty query is the identity — same members, same order, same length — so
 * that opening the menu shows the agent's own list as the agent ordered it.
 *
 * Stability is written into the comparator rather than inherited from the engine:
 * `Array.prototype.sort` is specified stable, but a tie broken by the build index
 * is a rule somebody can read, and one enforced nowhere is one somebody deletes
 * as dead.
 */
export function filterCommands(entries: readonly CommandEntry[], query: string): CommandEntry[] {
  if (query.length === 0) return [...entries];
  const needle = query.toLowerCase();
  const ranked: { entry: CommandEntry; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const rank = rankOf(entry, needle);
    if (rank >= 0) ranked.push({ entry, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((row) => row.entry);
}

/** What the composer becomes when an entry is chosen, and where the caret goes. */
export interface Completion {
  text: string;
  caret: number;
}

/**
 * Apply an entry to the draft.
 *
 * A `prompt` entry becomes `/name ` with whatever followed the token preserved,
 * caret after the space, ready for arguments. **The hint is never inserted.** It
 * is prose — `<optional custom summarization instructions>` is a real one — and
 * inserting it as if it were a template would send those words to the model.
 *
 * A `config` entry removes the token entirely. Choosing `/model` is a navigation
 * gesture rather than a message, and because the slash is pinned to index 0 there
 * is no sentence in front of it to destroy.
 *
 * **What is replaced is the whole token, not the text before the caret**, and
 * that distinction is the entire bug this function had. `slashQuery` deliberately
 * lets the caret sit inside the name — arrowing left, or tapping back to fix a
 * typo, both do it and neither closes the menu — so `query.query` is a prefix of
 * the token rather than the token. Slicing at the caret left the rest of the name
 * behind as if it were an argument: `/compact` with the caret at 3 completed to
 * `/context mpact`, which is then *sent to the agent*, and on the `config` arm it
 * silently left `mpact` sitting in an otherwise cleared box. So the tail of the
 * token is consumed first, and only what follows a word boundary survives.
 */
export function completion(text: string, query: SlashQuery, entry: CommandEntry): Completion {
  const rest = text
    .slice(query.start + 1 + query.query.length)
    // The remainder of the token the caret is inside. `\S*` and not `\S+`: it
    // matches nothing when the caret is already at the end, which is the case
    // every other line here is written for.
    .replace(/^\S*/, "")
    .replace(/^\s+/, "");
  if (entry.kind === "config") return { text: rest, caret: 0 };
  const head = `/${entry.name} `;
  return { text: head + rest, caret: head.length };
}

/** A typed message whose first token is one of the synthesized controls. */
export interface TypedConfigCommand {
  entry: CommandEntry;
  /**
   * The control that entry stands for.
   *
   * Carried alongside rather than left on `entry`, where it is
   * `AgentConfigOption | null`: a caller that has one of these has already been
   * told it is a `config` entry, and re-narrowing a field the type says may be
   * null is a null check that reads as defensive when it is in fact impossible.
   */
  option: AgentConfigOption;
  /** Everything after the command name, trimmed. Empty when there was nothing. */
  rest: string;
}

/**
 * The control a *sent* message asks for, if its first token names one.
 *
 * The `/` menu applies these on selection and sends nothing — but somebody who
 * knows the name does not open a menu, they type it and press Enter, and until
 * this existed that went to the agent as **text**. Measured: `/plan I want…`
 * (a slash command with an argument after it) was delivered as a prompt and claude answered "/plan
 * isn't available in this environment", which is a mode change silently becoming
 * a wasted turn. The whole
 * reason these three names are ours rather than the agent's is that they are
 * portable and typeable; typing one has to do what choosing it does.
 *
 * Two shapes, and the difference is `value`:
 *
 *   `/plan`, `/auto`, `/acceptEdits`  — carry a value, so they are a change. Anything
 *                                       after the name is the message to send once it
 *                                       has been applied.
 *   `/mode`, `/model`, `/effort`      — carry none, so they are a *question*. They
 *                                       open their own choice list; there is nothing
 *                                       to send and sending the name as text is the
 *                                       dead end this whole synthesis exists against.
 *
 * Only `config` entries. A published `prompt` command such as `/compact` is the
 * agent's own and is sent as typed, which is the one way to invoke it at all.
 *
 * Same `startsWith("/")` rule as {@link slashQuery}: a slash is a command only at
 * the very start, so a message *mentioning* `/plan` halfway through is a message.
 */
export function typedConfigCommand(
  text: string,
  entries: readonly CommandEntry[],
): TypedConfigCommand | null {
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  const match = /\s/.exec(body);
  const name = match === null ? body : body.slice(0, match.index);
  if (name.length === 0) return null;
  const entry = entries.find((candidate) => candidate.kind === "config" && candidate.name === name);
  if (entry === undefined || entry.option === null) return null;
  return { entry, option: entry.option, rest: match === null ? "" : body.slice(match.index).trim() };
}

/** One row of a `config` entry's second stage. */
export interface ChoiceRow {
  value: string;
  label: string;
  description: string | null;
}

/**
 * A control's choices, labelled the way the composer's chip labels them.
 *
 * Through `choiceOverride` rather than beside it: the menu and the chip must not
 * say two different things about one value, and `default` — effort on claude, mode
 * on claude and kimi — is exactly the value where the agent's own name says nothing.
 *
 * Prose falls back to the transcript for the same reason `chipValue` does — the
 * snapshot keeps only the selected choice's description — and the override's
 * sentence comes last, so kimi's own description of its `default` mode wins over
 * ours and claude's absent one is filled in.
 */
export function configChoices(
  option: AgentConfigOption,
  prose?: ConfigProse,
  turnRunning = false,
): ChoiceRow[] {
  return option.choices.map((choice) => {
    const override = choiceOverride(option, choice.value);
    /*
     * **The refusal outranks every description, so the two doors cannot say
     * different things about one tap.** The strip's own menu draws this same
     * sentence on the same values through `choiceRefusal`; this is the typed
     * `/effort ultracode` route reaching it, and `applyValue` refuses on the same
     * function. Defaulted to `false` so every existing caller compiles and the
     * pure assertions on the labels do not move. Q3.429.
     */
    const refusal = choiceRefusal(option, choice.value, turnRunning);
    return {
      value: choice.value,
      label: override?.label ?? choice.name,
      description:
        refusal ??
        choice.description ??
        prose?.choices.get(choice.value) ??
        override?.description ??
        null,
    };
  });
}
