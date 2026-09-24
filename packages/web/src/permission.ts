import type {
  FileChangeEvent,
  PendingPermissionSnapshot,
  PermissionOptionSummary,
  StoredEvent,
  ToolCallEvent,
  ToolKind,
} from "./wire";

/** The request's own payload first, then the event log joined on `toolCallId`; `unavailable` when neither has anything. */

export interface PermissionContext {
  kind: ToolKind | null;
  command: string | null;
  rawInput: string | null;
  /** kimi puts the command here and sends `rawInput: null`. */
  text: string[];
  target: string | null;
  body: string | null;
  /** The tool's own sentence; the only agent text a heading may be built from. */
  summary: string | null;
  /** Set only for a string `plan` on a request authorizing nothing: no command, body, diff or location. */
  plan: string | null;
  truncated: boolean;
  diffs: FileChangeEvent[];
  locations: string[];
  unavailable: boolean;
}

const EMPTY: PermissionContext = {
  kind: null,
  command: null,
  target: null,
  body: null,
  summary: null,
  plan: null,
  rawInput: null,
  text: [],
  truncated: false,
  diffs: [],
  locations: [],
  unavailable: true,
};

// `clampBlob`'s `{truncated, bytes}` stand-in is not null, so `??` alone would treat it as a payload.
function usable(value: unknown): boolean {
  return value !== null && value !== undefined && !isTruncationMarker(value);
}

export function permissionContext(
  pending: PendingPermissionSnapshot,
  events: readonly StoredEvent[],
): PermissionContext {
  const toolCallId = pending.toolCallId;

  let call: ToolCallEvent | null = null;
  const diffs: FileChangeEvent[] = [];
  // Arguments may arrive on any update, not only the `tool_call`: kimi sends them on the last one.
  let callInput: unknown = null;
  let callText: string[] | null = null;

  if (toolCallId !== null) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]?.event;
      if (event === undefined) continue;
      if (event.type === "file_change" && event.toolCallId === toolCallId) {
        diffs.unshift(event);
        continue;
      }
      if (event.type !== "tool_call" && event.type !== "tool_call_update") continue;
      if (event.toolCallId !== toolCallId) continue;
      if (callInput === null && event.rawInput !== null && event.rawInput !== undefined) {
        callInput = event.rawInput;
      }
      if (
        callText === null &&
        event.type === "tool_call_update" &&
        Array.isArray(event.content) &&
        event.content.length > 0
      ) {
        callText = event.content;
      }
      if (call === null && event.type === "tool_call") call = event;
    }
  }

  const blocks = readContentBlocks(pending.content);
  const fromCall = readTextBlocks(callText);

  // An intact copy always outranks a clamped stand-in; the stand-in stays last so a lost payload still reports clipped.
  const source = usable(pending.rawInput)
    ? pending.rawInput
    : usable(callInput)
      ? callInput
      : usable(blocks.args)
        ? blocks.args
        : usable(fromCall.args)
          ? fromCall.args
          : (pending.rawInput ?? callInput ?? blocks.args ?? fromCall.args);
  const extracted = readInput(source);
  const allDiffs = diffs.length > 0 ? diffs : blocks.diffs;
  const text = blocks.text.length > 0 ? blocks.text : fromCall.text;
  // Not gated on `switch_mode` here (it is missing until the log loads); `planControls` requires it.
  const plan =
    extracted.plan !== null && allDiffs.length === 0 && (call?.locations ?? []).length === 0
      ? extracted.plan
      : null;

  const echoed = extracted.command ?? extracted.target;
  const prose = (echoed === null ? text : text.filter((line) => !line.includes(echoed)))
    // Compared trimmed: `pick` trims, and a markdown file ends with a newline.
    .filter((line) => line.trim() !== plan);

  // Per payload and off the request, so a clamped copy the log recovered is not reported as lost.
  const argsLost = isTruncationMarker(pending.rawInput) && !usable(source);
  const contentLost =
    isTruncationMarker(pending.content) &&
    fromCall.text.length === 0 &&
    allDiffs.length === 0 &&
    plan === null;
  const truncated = argsLost || contentLost;

  const empty =
    extracted.command === null &&
    extracted.target === null &&
    extracted.pretty === null &&
    extracted.body === null &&
    plan === null &&
    !truncated &&
    text.length === 0 &&
    allDiffs.length === 0 &&
    (call?.locations ?? []).length === 0;
  if (empty) return EMPTY;

  return {
    kind: call?.kind ?? null,
    command: extracted.command,
    target: extracted.target,
    body: extracted.body,
    summary: extracted.summary,
    plan,
    rawInput: withoutEchoedFields(source, extracted.pretty, prose, plan),
    text: prose,
    truncated,
    diffs: allDiffs,
    locations: (call?.locations ?? []).map(formatLocation),
    unavailable: false,
  };
}

function readContentBlocks(content: unknown): {
  diffs: FileChangeEvent[];
  text: string[];
  args: unknown;
} {
  if (!Array.isArray(content)) return { diffs: [], text: [], args: null };
  const diffs: FileChangeEvent[] = [];
  const text: string[] = [];
  let args: unknown = null;

  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as Record<string, unknown>;

    if (block["type"] === "diff") {
      if (typeof block["path"] !== "string" || typeof block["newText"] !== "string") continue;
      diffs.push({
        type: "file_change",
        path: block["path"],
        oldText: typeof block["oldText"] === "string" ? block["oldText"] : null,
        newText: block["newText"],
        source: "diff",
        toolCallId: null,
      });
      continue;
    }

    if (block["type"] === "content") {
      const inner = block["content"];
      if (typeof inner !== "object" || inner === null) continue;
      const record = inner as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string" && record["text"].length > 0) {
        const parsed = args === null ? asArguments(record["text"]) : null;
        // A block that is entirely a JSON object is the tool echoing its input, so read it as arguments.
        if (parsed !== null) args = parsed;
        else text.push(record["text"]);
      }
    }
  }

  return { diffs, text, args };
}

function readTextBlocks(content: string[] | null): { text: string[]; args: unknown } {
  if (content === null) return { text: [], args: null };
  const text: string[] = [];
  let args: unknown = null;
  for (const entry of content) {
    if (entry.length === 0) continue;
    const parsed = args === null ? asArguments(entry) : null;
    if (parsed !== null) args = parsed;
    else text.push(entry);
  }
  return { text, args };
}

// Drops string fields the prose or the plan already draw verbatim; `null` when nothing is left.
function withoutEchoedFields(
  source: unknown,
  pretty: string | null,
  prose: readonly string[],
  plan: string | null,
): string | null {
  if (pretty === null || (prose.length === 0 && plan === null)) return pretty;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return pretty;
  const record = source as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      kept[key] = value;
      continue;
    }
    // Trimmed against the plan too: the plan's own block has already left `prose`.
    if (prose.includes(value) || value.trim() === plan) continue;
    kept[key] = value;
  }
  const keys = Object.keys(kept).length;
  if (keys === Object.keys(record).length) return pretty;
  return keys === 0 ? null : JSON.stringify(kept, null, 2);
}

function asArguments(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    // Prose that merely begins and ends with a brace. Left as prose.
    return null;
  }
}

export interface ExtractedInput {
  command: string | null;
  target: string | null;
  /** Drawn as text rather than inside `pretty`'s escaped JSON. */
  body: string | null;
  summary: string | null;
  plan: string | null;
  pretty: string | null;
  truncated: boolean;
}

const NOTHING: ExtractedInput = {
  command: null,
  target: null,
  body: null,
  summary: null,
  plan: null,
  pretty: null,
  truncated: false,
};

const TARGET_FIELDS = ["path", "file_path", "filePath", "filename", "file", "url", "uri", "notebook_path"];
const COMMAND_FIELDS = ["command", "cmd", "script", "query", "pattern"];
const BODY_FIELDS = ["content", "new_string", "newText", "new_str", "text", "body"];
const SUMMARY_FIELDS = ["description", "summary", "explanation"];
/** Picked on the last arm only, so a plan never comes with a command or body. */
const PLAN_FIELDS = ["plan"];

/** Memoised by identity: the transcript tail reads it on every streamed token, and a StoredEvent is never mutated. */
const READ_INPUT = new WeakMap<object, ExtractedInput>();

export function readInput(rawInput: unknown): ExtractedInput {
  if (typeof rawInput !== "object" || rawInput === null) return computeInput(rawInput);
  const cached = READ_INPUT.get(rawInput);
  if (cached !== undefined) return cached;
  const computed = computeInput(rawInput);
  READ_INPUT.set(rawInput, computed);
  return computed;
}

function computeInput(rawInput: unknown): ExtractedInput {
  if (rawInput === undefined || rawInput === null) return NOTHING;

  // The daemon's stand-in for a clipped payload; never draw it as an empty command.
  if (isTruncationMarker(rawInput)) {
    return { ...NOTHING, truncated: true };
  }

  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    return trimmed.length > 0 ? { ...NOTHING, command: trimmed } : NOTHING;
  }

  if (typeof rawInput !== "object") return NOTHING;

  const record = rawInput as Record<string, unknown>;

  if (Array.isArray(rawInput) ? rawInput.length === 0 : Object.keys(record).length === 0) {
    return NOTHING;
  }

  const pick = (fields: readonly string[]): string | null => {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  };

  const command = pick(COMMAND_FIELDS);
  const target = pick(TARGET_FIELDS);
  const body = pick(BODY_FIELDS);
  const summary = pick(SUMMARY_FIELDS);
  const plan = pick(PLAN_FIELDS);
  if (command !== null) return { ...NOTHING, command, target, summary };
  if (body !== null) return { ...NOTHING, target, body, summary };

  let pretty: string | null;
  try {
    pretty = JSON.stringify(rawInput, null, 2);
  } catch {
    // A throwing `toJSON` or a cycle: show nothing rather than throw while rendering.
    pretty = null;
  }
  return { ...NOTHING, target, summary, plan, pretty };
}

export function formatLocation(location: { path: string; line: number | null }): string {
  return location.line === null ? location.path : `${location.path}:${location.line}`;
}

/** True when `readInput` finds anything at all; `{}` is nothing (claude sends it before the real arguments). */
export function hasInput(rawInput: unknown): boolean {
  const { command, target, body, summary, plan, pretty, truncated } = readInput(rawInput);
  return truncated || [command, target, body, summary, plan, pretty].some((field) => field !== null);
}

const VERBS: Partial<Record<NonNullable<PermissionContext["kind"]>, string>> = {
  execute: "run",
  edit: "edit",
  read: "read",
  delete: "delete",
  move: "move",
  search: "search",
  fetch: "fetch",
};

function shortTarget(target: string | null): string | null {
  if (target === null || target.includes("://") || !target.includes("/")) return target;
  const last = target.slice(target.lastIndexOf("/") + 1);
  return last.length > 0 ? last : target;
}

export function permissionHeadline(
  agent: string,
  title: string,
  context: PermissionContext,
): string {
  const target = context.target;
  const named = target === null || target.length === 0 || title.includes(target) ? title : `${title} ${target}`;

  // The kind rides the `tool_call`, so fall back to what the request itself carries.
  const kind = context.kind === null ? null : VERBS[context.kind];
  const verb = kind ?? (context.command !== null ? "run" : context.body !== null ? "write" : null);
  if (verb === null) return named;
  // ACP's one `edit` covers both: a whole-file body is a write, a hunk is an edit.
  const said = verb === "edit" && context.body !== null && context.diffs.length === 0 ? "write" : verb;

  const who = agent.length === 0 ? agent : agent[0]!.toUpperCase() + agent.slice(1);
  const object = context.summary ?? shortTarget(target);
  if (object !== null && object.length > 0) return `Allow ${who} to ${said} ${object}?`;
  if (said === "run") return `Allow ${who} to run this command?`;
  return named;
}


/** Refusals left, approvals right, the reversible `allow_once` last and primary. */
export interface PermissionButtons {
  /** In display order. `optionShortcut` indexes into exactly this. */
  order: PermissionOptionSummary[];
  leading: number;
  primaryId: string | null;
}

/** Used only when every kind appears once: plan mode sends several `allow_always` told apart by name alone. */
const KIND_WORDS: Partial<Record<PermissionOptionSummary["kind"], string>> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  reject_once: "Deny",
  reject_always: "Never allow",
};

export function optionLabel(
  options: readonly PermissionOptionSummary[],
  option: PermissionOptionSummary,
): string {
  const counts = new Map<string, number>();
  for (const entry of options) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  if (options.some((entry) => (counts.get(entry.kind) ?? 0) > 1)) return option.name;
  const word = KIND_WORDS[option.kind];
  if (word === undefined) return option.name;
  // Keep the agent's name when it already contains our word: the rest, such as scoped globs, says what is granted.
  return option.name.toLowerCase().includes(word.toLowerCase()) ? option.name : word;
}

/** Ordinary labels reach 24 characters; scoped grants embed a path and are unbounded. */
const BUTTON_LABEL_MAX = 32;

/** Past BUTTON_LABEL_MAX the card draws rows instead of dropping an option (reverses Q3.92). Approvals only, never by id. */
export function permissionLayout(options: readonly PermissionOptionSummary[]): "buttons" | "rows" {
  const wide = options.some(
    (option) =>
      !option.kind.startsWith("reject") && optionLabel(options, option).length > BUTTON_LABEL_MAX,
  );
  return wide ? "rows" : "buttons";
}

export function permissionButtons(options: readonly PermissionOptionSummary[]): PermissionButtons {
  const refusals = options.filter((option) => option.kind.startsWith("reject"));
  const rest = options.filter((option) => !option.kind.startsWith("reject"));
  const approvals = [
    ...rest.filter((option) => option.kind !== "allow_once"),
    ...rest.filter((option) => option.kind === "allow_once"),
  ];
  return {
    order: [...refusals, ...approvals],
    leading: refusals.length,
    primaryId: approvals.at(-1)?.optionId ?? null,
  };
}

/**
 * claude's curated plan-mode card: matched by optionId only after `plan` and `switch_mode`, on an exact PLAN_SHAPES match (Q3.453).
 * No refusal is drawn: declining is the header's ✕ or the message box (Q3.454).
 */
export interface PlanControl {
  option: PermissionOptionSummary;
  label: string;
  leading: boolean;
  primary: boolean;
}

interface PlanShape {
  shape: readonly (readonly [string, PermissionOptionSummary["kind"]])[];
  order: readonly (readonly [string, string])[];
  primary: string;
}

/** Newest adapter first; the first exact match wins. A new adapter's shape is an entry, never a looser rule (Q3.453). */
const PLAN_SHAPES: readonly PlanShape[] = [
  {
    shape: [
      ["exit-plan-clear-auto", "allow_always"],
      ["exit-plan-auto", "allow_always"],
      ["exit-plan-default", "allow_once"],
      ["reject", "reject_once"],
    ],
    order: [
      ["exit-plan-auto", "Auto mode"],
      ["exit-plan-clear-auto", "Clear + auto"],
    ],
    primary: "exit-plan-clear-auto",
  },
  {
    shape: [
      ["exit-plan-clear-bypass", "allow_always"],
      ["exit-plan-bypass", "allow_always"],
      ["exit-plan-default", "allow_once"],
      ["reject", "reject_once"],
    ],
    order: [
      ["exit-plan-bypass", "Bypass permissions"],
      ["exit-plan-clear-bypass", "Clear + bypass"],
    ],
    primary: "exit-plan-clear-bypass",
  },
  {
    shape: [
      ["exit-plan-clear-accept-edits", "allow_always"],
      ["exit-plan-accept-edits", "allow_always"],
      ["exit-plan-default", "allow_once"],
      ["reject", "reject_once"],
    ],
    order: [
      ["exit-plan-accept-edits", "Auto-accept edits"],
      ["exit-plan-clear-accept-edits", "Clear + accept"],
    ],
    primary: "exit-plan-clear-accept-edits",
  },
  // claude-agent-acp 0.63.0, kept because a machine can lag the pin.
  {
    shape: [
      ["bypassPermissions", "allow_always"],
      ["auto", "allow_always"],
      ["acceptEdits", "allow_always"],
      ["default", "allow_once"],
      ["plan", "reject_once"],
    ],
    order: [
      ["acceptEdits", "Auto-accept edits"],
      ["auto", "Auto mode"],
    ],
    primary: "auto",
  },
];

export function planControls(
  context: PermissionContext,
  options: readonly PermissionOptionSummary[],
): PlanControl[] | null {
  if (context.plan === null || context.kind !== "switch_mode") return null;
  const byId = new Map(options.map((option) => [option.optionId, option]));
  const matched = PLAN_SHAPES.find(
    (candidate) =>
      candidate.shape.length === options.length &&
      candidate.shape.every(([id, kind]) => byId.get(id)?.kind === kind),
  );
  if (matched === undefined) return null;

  const controls: PlanControl[] = [];
  for (const [id, label] of matched.order) {
    const option = byId.get(id);
    if (option === undefined) return null;
    controls.push({
      option,
      label,
      leading: option.kind.startsWith("reject"),
      primary: id === matched.primary,
    });
  }
  return controls;
}

export function withheldDetail(context: PermissionContext): boolean {
  if (context.unavailable) return false;
  return (
    context.body !== null ||
    context.diffs.length > 0 ||
    context.rawInput !== null ||
    context.locations.length > 0 ||
    // A plan alone has a null blob, and its source still belongs behind `details`.
    context.plan !== null
  );
}

/** `detailContext` is the exact complement, so the two halves never draw the same thing. */
export function essentialContext(context: PermissionContext): PermissionContext {
  if (context.unavailable) return context;
  return {
    ...context,
    text: context.plan === null ? context.text : [],
    // The file, diff and arguments go behind `details`; a command stays, because it is the decision.
    body: null,
    diffs: [],
    rawInput: null,
    locations: [],
  };
}

export function detailContext(context: PermissionContext): PermissionContext {
  return {
    ...context,
    text: context.plan === null ? [] : [context.plan, ...context.text],
    command: null,
    summary: null,
    target: null,
    plan: null,
  };
}


/** `awaitingRecord` (from `store.unreduceSnapshot`): the socket frame clipped it and the next poll brings it; otherwise the ingest clamp lost it. */
export function truncationNotice(context: PermissionContext, awaitingRecord: boolean): string | null {
  if (!context.truncated) return null;
  return awaitingRecord
    ? "Part of this request is too large for the live connection and has not been fetched yet."
    : "Part of this request was too large to keep and is not shown below.";
}

export function isTruncationMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record["truncated"] === true && typeof record["bytes"] === "number";
}

/** Gated on the option-kind enum and the `questions` shape, never on titles or ids (kimi's AskUserQuestion). */
export interface AskedQuestion {
  question: string;
  answers: { optionId: string; label: string; description: string | null }[];
  skip: { optionId: string; name: string } | null;
}

export function askedQuestion(
  pending: PendingPermissionSnapshot,
  events: readonly StoredEvent[],
  context: PermissionContext,
): AskedQuestion | null {
  // A request that authorizes a concrete action is never a question, or the card could hide the command its answer approves.
  if (
    context.command !== null ||
    context.body !== null ||
    context.diffs.length > 0 ||
    context.locations.length > 0
  ) {
    return null;
  }

  const offered = pending.options.filter((option) => option.kind === "allow_once");
  if (offered.length < 2) return null;

  // Exactly one other option is the skip; more is an unmeasured shape.
  const rest = pending.options.filter((option) => option.kind !== "allow_once");
  if (rest.length > 1) return null;

  const questions = readQuestions(pending.rawInput ?? inputFor(pending.toolCallId, events));
  if (questions === null) return null;

  // Refuse a label seen twice, as `answeredQuestions` in tail.ts does: a wrong attribution is worse than none.
  type Asked = (typeof questions)[number];
  const AMBIGUOUS = Symbol("ambiguous");
  const byLabel = new Map<string, { asked: Asked; option: Asked["options"][number] } | typeof AMBIGUOUS>();
  for (const asked of questions) {
    for (const option of asked.options) {
      byLabel.set(option.label, byLabel.has(option.label) ? AMBIGUOUS : { asked, option });
    }
  }

  let asked: Asked | null = null;
  const answers: AskedQuestion["answers"] = [];
  for (const option of offered) {
    const hit = byLabel.get(option.name);
    if (hit === undefined || hit === AMBIGUOUS) return null;
    if (asked === null) asked = hit.asked;
    else if (asked !== hit.asked) return null;
    answers.push({ optionId: option.optionId, label: hit.option.label, description: hit.option.description });
  }
  if (asked === null || answers.length !== offered.length) return null;

  const skip = rest[0];
  return {
    question: asked.question,
    answers,
    skip: skip === undefined ? null : { optionId: skip.optionId, name: skip.name },
  };
}

/** Shared with tail.ts's `answeredQuestions` so both readers agree on the shape. */
export function readQuestions(
  input: unknown,
): { question: string; options: { label: string; description: string | null }[] }[] | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = (input as Record<string, unknown>)["questions"];
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: { question: string; options: { label: string; description: string | null }[] }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const question = record["question"];
    const options = record["options"];
    if (typeof question !== "string" || question.length === 0) return null;
    if (!Array.isArray(options) || options.length === 0) return null;
    const parsed: { label: string; description: string | null }[] = [];
    for (const option of options) {
      if (typeof option !== "object" || option === null) return null;
      const shape = option as Record<string, unknown>;
      const label = shape["label"];
      if (typeof label !== "string") return null;
      const description = shape["description"];
      parsed.push({ label, description: typeof description === "string" ? description : null });
    }
    out.push({ question, options: parsed });
  }
  return out;
}

function inputFor(toolCallId: string | null, events: readonly StoredEvent[]): unknown {
  if (toolCallId === null) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]?.event;
    if (event === undefined) continue;
    if (event.type !== "tool_call" && event.type !== "tool_call_update") continue;
    if (event.toolCallId !== toolCallId) continue;
    if (event.rawInput !== null && event.rawInput !== undefined) return event.rawInput;
  }
  return null;
}
