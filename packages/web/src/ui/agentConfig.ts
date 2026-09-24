import { hasLiveAgent } from "../wire";
import type {
  AgentConfig,
  AgentConfigChoice,
  AgentConfigOption,
  SessionSnapshot,
  StoredEvent,
} from "../wire";

export type Slot = "left" | "right" | "overflow" | "hidden" | "nested";

/** The one host for every nested control, so the strip has the same shape on every agent. */
export const NESTED_HOST = "mode";

/** Slot by category, never by id; an unknown category goes to overflow, never dropped. */
const CATEGORY_SLOT: Record<string, Slot> = {
  mode: "left",
  model: "right",
  thought_level: "right",
  model_config: "hidden",
  collaboration_mode: "nested",
};

/** `Object.hasOwn`: an agent-chosen category such as `toString` would otherwise throw mid-render. */
export function slotFor(option: Pick<AgentConfigOption, "category">): Slot {
  const category = option.category ?? "";
  return Object.hasOwn(CATEGORY_SLOT, category) ? (CATEGORY_SLOT[category] ?? "overflow") : "overflow";
}

/** Our name only where agents disagree; keyed on category, never id. */
const CATEGORY_LABEL: Record<string, string> = {
  thought_level: "Effort",
  mode: "Mode",
};

export function labelFor(option: Pick<AgentConfigOption, "category" | "name">): string {
  const category = option.category ?? "";
  return (Object.hasOwn(CATEGORY_LABEL, category) ? CATEGORY_LABEL[category] : undefined) ?? option.name;
}

export interface DrawnControls {
  options: readonly AgentConfigOption[];
  stale: boolean;
  /** A control never leaves the strip: withdrawn, empty and placeholder slots are drawn unavailable. */
  unavailable: ReadonlySet<string>;
  /** Slots this agent will never offer; a set rather than an id, because chips are keyed on id. */
  never: ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();


const ALWAYS_DRAWN: readonly string[] = Object.keys(CATEGORY_SLOT).filter(
  (category) => CATEGORY_SLOT[category] === "left" || CATEGORY_SLOT[category] === "right",
);

/** An empty select, so `commands.ts` builds no entry and `Absent` draws it. */
function placeholderFor(category: string): AgentConfigOption {
  const spelled = category
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return {
    id: `reemoat:${category}`,
    name: labelFor({ category, name: spelled }),
    description: null,
    category,
    kind: "select",
    value: "",
    choices: [],
  };
}

export function drawnControls(
  session: Pick<SessionSnapshot, "status" | "agentConfig">,
  held: AgentConfig | undefined,
): DrawnControls {
  const live = session.agentConfig?.options ?? [];
  if (live.length > 0) {
    const liveIds = new Set(live.map((option) => option.id));
    const dropped = (held?.options ?? []).filter((option) => !liveIds.has(option.id));
    return withUnusable(dropped.length === 0 ? live : [...live, ...dropped], dropped, false, true);
  }
  // Every state keeps the standard slots, so the row never changes shape (Q3.418).
  if (hasLiveAgent(session.status)) return withUnusable([], [], false, false);
  const remembered = held?.options ?? [];
  if (remembered.length === 0) return withUnusable([], [], false, false);
  return withUnusable(remembered, [], held !== undefined, false);
}

function withUnusable(
  options: readonly AgentConfigOption[],
  dropped: readonly AgentConfigOption[],
  stale: boolean,
  /** Picks the missing slot's sentence (transient or never), never whether it is drawn. */
  published: boolean,
): DrawnControls {
  const unavailable = new Set(dropped.map((option) => option.id));
  for (const option of options) {
    if (option.kind === "select" && option.choices.length === 0) unavailable.add(option.id);
  }
  const filled = new Set<string>();
  for (const option of options) {
    if (option.category !== null && option.category !== undefined) filled.add(option.category);
    filled.add(option.id);
  }
  const drawn = [...options];
  const never = new Set<string>();
  for (const category of ALWAYS_DRAWN) {
    const stand = placeholderFor(category);
    if (filled.has(category) || filled.has(stand.id)) continue;
    drawn.push(stand);
    unavailable.add(stand.id);
    if (published) never.add(stand.id);
  }
  return {
    options: drawn,
    stale,
    unavailable: unavailable.size === 0 ? NOTHING : unavailable,
    never: never.size === 0 ? NOTHING : never,
  };
}

export function unavailableHint(
  option: Pick<AgentConfigOption, "category">,
  never: boolean,
): string {
  if (option.category === "thought_level") {
    return "The model in use offers no levels here. Another model may.";
  }
  if (never) {
    return option.category === "mode"
      ? "This agent has no modes."
      : "This agent offers no choice here.";
  }
  return "The agent is not offering this control at the moment.";
}

/** Hand-mirrored from the daemon; `webcheck` pins them against `src/registry.ts`. */
const ULTRACODE_VALUE = "ultracode";
const XHIGH_VALUE = "xhigh";

/** Restarts the agent in either direction, so the daemon refuses it mid-turn; a deliberate superset of its gate (Q3.429). */
export function restartsAgent(option: AgentConfigOption, value: string | boolean): boolean {
  if (option.category !== "thought_level" || option.kind !== "select") return false;
  if (!option.choices.some((choice) => choice.value === ULTRACODE_VALUE)) return false;
  if (!option.choices.some((choice) => choice.value === XHIGH_VALUE)) return false;
  return (value === ULTRACODE_VALUE) !== (option.value === ULTRACODE_VALUE);
}

export function choiceRefusal(
  option: AgentConfigOption,
  value: string | boolean,
  turnRunning: boolean,
): string | null {
  return turnRunning && restartsAgent(option, value)
    ? "Restarts the agent, so not while this turn is running — wait for it, or Stop."
    : null;
}

export const UNAVAILABLE_VALUE = "—";

/** `caption` never depends on `available`, so only the value changes (Q3.564). */
export interface ChipParts {
  caption: string | null;
  value: string;
}

export function chipParts(option: AgentConfigOption, available: boolean, prose?: ConfigProse): ChipParts {
  return {
    caption: showsCaption(option) ? labelFor(option) : null,
    value: available ? chipValue(option, prose) : UNAVAILABLE_VALUE,
  };
}

export type PendingChoices = ReadonlyMap<string, string | boolean>;

export function withChoice(option: AgentConfigOption, pending: PendingChoices | null): AgentConfigOption {
  const wanted = pending?.get(option.id);
  if (wanted === undefined || wanted === option.value) return option;
  return { ...option, value: wanted };
}

/** Must equal `CATEGORY_ICON`'s keys; `webcheck` asserts they agree (Q3.559). */
const CAPTION_SILENT = new Set(["mode", "model", "thought_level", "model_config"]);

export function showsCaption(option: Pick<AgentConfigOption, "category">): boolean {
  return !CAPTION_SILENT.has(option.category ?? "");
}

/** Right-hand controls in a fixed reading order; the rest alphabetical. */
const RIGHT_ORDER: Record<string, number> = { model: 0, thought_level: 1 };

const rightOrder = (category: string | null): number => {
  const key = category ?? "";
  return (Object.hasOwn(RIGHT_ORDER, key) ? RIGHT_ORDER[key] : undefined) ?? 9;
};

export function splitOptions(
  options: readonly AgentConfigOption[],
  unavailable: ReadonlySet<string> = NOTHING,
): Record<Slot, AgentConfigOption[]> {
  const out: Record<Slot, AgentConfigOption[]> = { left: [], right: [], overflow: [], hidden: [], nested: [] };
  for (const option of options) out[slotFor(option)].push(option);
  // A boolean has no choices, so it can neither host nor nest.
  const nestable = out.nested.filter((option) => option.kind !== "boolean");
  if (nestable.length !== out.nested.length) {
    out.overflow.push(...out.nested.filter((option) => option.kind === "boolean"));
    out.nested = nestable;
  }
  // A nested control without a usable host is demoted to overflow, never dropped.
  const host = out.left.find(
    (option) =>
      option.category === NESTED_HOST && option.kind !== "boolean" && !unavailable.has(option.id),
  );
  if (out.nested.length > 0 && host === undefined) {
    out.overflow.push(...out.nested);
    out.nested = [];
  }
  out.right.sort(
    (a, b) =>
      rightOrder(a.category) - rightOrder(b.category) ||
      a.name.localeCompare(b.name),
  );
  out.overflow.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Model chips name the model from the description's head (claude's name is `Default (recommended)`). */
export function chipValue(option: AgentConfigOption, prose?: ConfigProse): string {
  const choice = drawnChoices(option).find((candidate) => candidate.value === option.value);
  const name = choiceLabel(option, choice ?? { value: String(option.value), name: String(option.value) });
  if (option.category !== "model") return name;

  const description = choice?.description ?? prose?.choices.get(String(option.value)) ?? null;
  if (description === null) return name;
  // Separator required: without one the description is a sentence.
  const parts = description.split(/\s[·—–]\s/);
  if (parts.length === 1) return name;
  const head = parts[0]?.trim() ?? "";
  if (head.length === 0 || head.length > 40) return name;
  // Off the `default` row, a head is believed only if its first word matches the row name.
  if (String(option.value) !== "default" && familyWord(head) !== familyWord(name)) {
    return name.replace(/\s*\([^()]*\)\s*$/, "") || name;
  }
  const model = head.split(/\s+with\s+/i)[0]?.trim() ?? head;
  return model.length === 0 ? name : model;
}

function familyWord(text: string): string {
  return (text.trim().split(/[\s(\[]+/)[0] ?? "").toLowerCase();
}

export interface ChoiceOverride {
  label: string | null;
  description: string;
}

export function choiceOverride(
  option: Pick<AgentConfigOption, "category">,
  selected: string | boolean,
): ChoiceOverride | null {
  if (selected !== "default") return null;
  if (option.category === "thought_level") {
    return { label: "Adaptive", description: "The model decides how much to think, per turn" };
  }
  if (option.category === "mode") {
    return { label: null, description: "The agent asks before running each tool" };
  }
  return null;
}

/** The one place a choice is named; the value is never touched. */
export function choiceLabel(
  option: Pick<AgentConfigOption, "category">,
  choice: Pick<AgentConfigChoice, "value" | "name">,
): string {
  const override = choiceOverride(option, choice.value)?.label ?? null;
  if (override !== null) return override;
  return option.category === "mode" ? capitalised(choice.name) : choice.name;
}

/** `toUpperCase`, not `toLocaleUpperCase`: the reader's locale must not rename an agent's identifier. */
function capitalised(name: string): string {
  const first = name.slice(0, 1);
  const upper = first.toUpperCase();
  return upper === first ? name : `${upper}${name.slice(1)}`;
}

/** Strips a provider prefix only when every row shares it and every value is namespaced (Q3.503, Q3.507). */
export function drawnChoices(
  option: Pick<AgentConfigOption, "choices">,
): readonly AgentConfigChoice[] {
  const cached = DRAWN.get(option.choices);
  if (cached !== undefined) return cached;
  const drawn = stripProvider(option.choices);
  DRAWN.set(option.choices, drawn);
  return drawn;
}

const DRAWN = new WeakMap<readonly AgentConfigChoice[], readonly AgentConfigChoice[]>();

function stripProvider(choices: readonly AgentConfigChoice[]): readonly AgentConfigChoice[] {
  if (choices.length === 0) return choices;
  let head: string | null = null;
  for (const choice of choices) {
    if (choice.group !== null || !namespaced(choice.value)) return choices;
    const part = providerSplit(choice.name);
    if (part === null || (head !== null && part.head !== head)) return choices;
    head = part.head;
  }
  return choices.map((choice) => {
    const part = providerSplit(choice.name);
    return part === null ? choice : { ...choice, name: part.tail };
  });
}

/** Whether the agent routes on this value: `openrouter/x/y` does, `sonnet` does not. */
function namespaced(value: string): boolean {
  const at = value.indexOf("/");
  return at > 0 && at !== value.length - 1;
}

function providerSplit(name: string): { head: string; tail: string } | null {
  const at = name.indexOf("/");
  if (at < 0) return null;
  const head = name.slice(0, at).trim();
  const tail = name.slice(at + 1).trim();
  return head.length === 0 || tail.length === 0 ? null : { head, tail };
}

export interface ConfigProse {
  description: string | null;
  choices: Map<string, string>;
}

const PROSE = new WeakMap<readonly StoredEvent[], Map<string, ConfigProse>>();

/** State comes from the snapshot, never the log; this only recovers the descriptions the snapshot strips. */
export function configProse(events: readonly StoredEvent[]): ReadonlyMap<string, ConfigProse> {
  const cached = PROSE.get(events);
  if (cached !== undefined) return cached;
  const computed = scanConfigProse(events);
  PROSE.set(events, computed);
  return computed;
}

function scanConfigProse(events: readonly StoredEvent[]): Map<string, ConfigProse> {
  const out = new Map<string, ConfigProse>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type !== "agent_config") continue;
    for (const option of event.options) {
      const choices = new Map<string, string>();
      for (const choice of option.choices) {
        if (choice.description !== null && choice.description.length > 0) {
          choices.set(String(choice.value), choice.description);
        }
      }
      out.set(option.id, { description: option.description, choices });
    }
    break;
  }
  return out;
}

export function effortFollowUp(
  changed: Pick<AgentConfigOption, "category"> | undefined,
  before: readonly AgentConfigOption[],
  after: readonly AgentConfigOption[],
): { configId: string; value: string } | null {
  if (changed === undefined || changed.category !== "model") return null;
  const was = before.find((option) => option.category === "thought_level");
  const now = after.find((option) => option.category === "thought_level");
  if (was === undefined || now === undefined || now.kind !== "select" || now.choices.length === 0) return null;
  const values = (option: AgentConfigOption): string => option.choices.map((choice) => choice.value).join(" ");
  if (values(was) === values(now)) return null;
  const preferred = now.choices.find((choice) => choice.value === "default") ?? now.choices[0];
  if (preferred === undefined || preferred.value === now.value) return null;
  return { configId: now.id, value: preferred.value };
}
