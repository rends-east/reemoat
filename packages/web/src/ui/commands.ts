import type { AgentCommand, AgentConfig, AgentConfigOption } from "../wire";
import {
  choiceLabel,
  choiceOverride,
  choiceRefusal,
  drawnChoices,
  labelFor,
  slotFor,
  type ConfigProse,
} from "./agentConfig";

/** prompt entries are the agent's commands, sent as text; config entries are built from agentConfig by category, never id, and send no text. */
export interface CommandEntry {
  kind: "prompt" | "config";
  name: string;
  description: string;
  hint: string | null;
  option: AgentConfigOption | null;
  value: string | null;
}

export interface SlashQuery {
  start: number;
  query: string;
}

/** The slash must be at index 0 of the message: agents parse commands only there, and mid-message paths are common. */
export function slashQuery(text: string, caret: number): SlashQuery | null {
  if (!text.startsWith("/")) return null;
  if (caret < 1 || caret > text.length) return null;
  const query = text.slice(1, caret);
  if (/\s/.test(query)) return null;
  return { start: 0, query };
}

const CATEGORY_COMMAND: Record<string, string> = {
  mode: "mode",
  model: "model",
  thought_level: "effort",
};

export function typeableName(id: string): string | null {
  const name = id.trim().replace(/[^A-Za-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name.length === 0 ? null : name;
}

export function buildCommands(
  commands: readonly AgentCommand[],
  config: AgentConfig | undefined,
  prose?: ReadonlyMap<string, ConfigProse>,
  agent?: string,
): CommandEntry[] {
  const entries: CommandEntry[] = [];
  const taken = new Set<string>();
  // Restored built-ins are appended so they lose ties and name collisions to advertised commands.
  const available = [...commands, ...(RESTORED[agent ?? ""] ?? [])];

  for (const option of config?.options ?? []) {
    if (slotFor(option) === "hidden") continue;
    // A control with nothing to choose between is not a command: its empty second stage would clear the draft.
    if (option.kind !== "select" || option.choices.length === 0) continue;
    const name = CATEGORY_COMMAND[option.category ?? ""] ?? typeableName(option.id);
    if (name === null || taken.has(name)) continue;
    taken.add(name);
    entries.push({
      kind: "config",
      name,
      description: option.description ?? labelFor(option),
      hint: null,
      option,
      value: null,
    });
  }

  // Each mode becomes its own command named by its id; a published command wins the name.
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
        description:
          choice.description ??
          modeProse?.choices.get(choice.value) ??
          override?.description ??
          choiceLabel(mode, choice),
        hint: null,
        option: mode,
        value: choice.value,
      });
    }
  }

  const scoped = available.map((command, index) => ({
    command,
    index,
    tier: commandScope(command.description) === null ? 0 : 1,
  }));
  scoped.sort((a, b) => a.tier - b.tier || a.index - b.index);

  for (const { command } of scoped) {
    // A control shadows a same-named command: over ACP a sent /model is a dead end.
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

/** Scope parsed from claude's description suffix; an unrecognised shape is null and sorts with the built-ins. */
export function commandScope(description: string): "user" | "project" | null {
  const match = /\((user|project)\)\s*$/.exec(description);
  return match === null ? null : (match[1] as "user" | "project");
}

/** Commands claude's getAvailableSlashCommands hides but that measurably work; add one only after driving it. */
const RESTORED: Partial<Record<string, AgentCommand[]>> = {
  claude: [
    {
      name: "clear",
      description: "Start fresh — the agent forgets this conversation, the transcript above stays",
      hint: null,
    },
  ],
};

interface Rankable {
  name: string;
  description: string;
}

/** Prefix-first and never fuzzy; descriptions match only from two characters. */
function rankOf(item: Rankable, query: string): number {
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[:\-_]/).some((segment) => segment.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (query.length >= 2 && item.description.toLowerCase().includes(query)) return 4;
  return -1;
}

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

export interface Completion {
  text: string;
  caret: number;
}

/** Replaces the whole slash token, not just the text before the caret; the hint is never inserted. */
export function completion(text: string, query: SlashQuery, entry: CommandEntry): Completion {
  const rest = text
    .slice(query.start + 1 + query.query.length)
    .replace(/^\S*/, "")
    .replace(/^\s+/, "");
  if (entry.kind === "config") return { text: rest, caret: 0 };
  const head = `/${entry.name} `;
  return { text: head + rest, caret: head.length };
}

export interface TypedConfigCommand {
  entry: CommandEntry;
  option: AgentConfigOption;
  rest: string;
}

/** The config entry a sent message names by its first token, so typing a control does what choosing it does. */
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

export interface ChoiceRow {
  value: string;
  label: string;
  description: string | null;
  group: string | null;
}

/** Each row keeps its flat index in choices, which keyboard navigation counts in. */
export interface ChoiceRun {
  group: string | null;
  items: { choice: ChoiceRow; index: number }[];
}

export function choiceRuns(choices: readonly ChoiceRow[]): ChoiceRun[] {
  const runs: ChoiceRun[] = [];
  choices.forEach((choice, index) => {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.group === choice.group) last.items.push({ choice, index });
    else runs.push({ group: choice.group, items: [{ choice, index }] });
  });
  return runs;
}

export function configChoices(
  option: AgentConfigOption,
  prose?: ConfigProse,
  turnRunning = false,
): ChoiceRow[] {
  return drawnChoices(option).map((choice) => {
    const override = choiceOverride(option, choice.value);
    // The refusal outranks every description so the strip and the typed route agree (Q3.429).
    const refusal = choiceRefusal(option, choice.value, turnRunning);
    return {
      value: choice.value,
      group: choice.group,
      label: choiceLabel(option, choice),
      description:
        refusal ??
        choice.description ??
        prose?.choices.get(choice.value) ??
        override?.description ??
        null,
    };
  });
}
