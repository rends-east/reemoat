/** Pure so webcheck can assert it. Nothing here reads a field's name: adapter key names are not a contract. */

import { sentText } from "./ui/composing";
import { MAX_ANSWER_CHARS } from "./wire";
import type { ElicitationField, ElicitationOption, PendingElicitationSnapshot } from "./wire";

/** A number is held as the string being typed; only elicitationAnswer converts it. */
export type DraftValue = string | boolean | string[];

/** A partial record on purpose — see {@link fieldValue} on why absence is a state. */
export type ElicitationDraft = Readonly<Record<string, DraftValue>>;

/** What goes on the wire, matching ACP's `ElicitationContentValue`. */
export type ContentValue = string | number | boolean | string[];

export type RenderKind =
  | {
      k: "text";
      /** Whether the box may hold a newline: every string but one whose format is a single token (Q3.652). */
      multiline: boolean;
      /** How many lines the box starts at; it grows from there. */
      rows: number;
      format: ElicitationField["format"];
      min: number | null;
      max: number | null;
    }
  | { k: "number"; integer: boolean; min: number | null; max: number | null }
  | { k: "boolean" }
  | { k: "select"; options: ElicitationOption[] }
  | { k: "multiselect"; options: ElicitationOption[]; min: number | null; max: number | null };

export interface RenderField {
  key: string;
  label: string;
  hint: string | null;
  required: boolean;
  kind: RenderKind;
  fallback: DraftValue | undefined;
  alternativeTo: string | null;
}

export interface RenderStep {
  key: string;
  fields: RenderField[];
}

export interface ElicitationForm {
  message: string;
  fields: RenderField[];
  /** Presentational only: grouped fields keep their own keys and are validated and sent independently. */
  steps: RenderStep[];
  /** Decided structurally, never by matching text: shown unless every choice field carries its own description. */
  showsPrompt: boolean;
}

export type ProblemCode =
  | "required"
  | "too_short"
  | "too_long"
  | "not_a_number"
  | "not_an_integer"
  | "below_min"
  | "above_max"
  | "too_few"
  | "too_many"
  | "not_an_option";

export interface FieldProblem {
  key: string;
  code: ProblemCode;
  reason: string;
}

export interface ElicitationAnswer {
  /** Exactly the `content` the route takes. Untouched optionals are absent. */
  content: Record<string, ContentValue>;
  problems: FieldProblem[];
  canSubmit: boolean;
}

const TALL_ABOVE = 240;

/** One frozen instance, so a default argument cannot defeat a caller's `useMemo`. */
const EMPTY_EXCLUSIONS: ReadonlySet<string> = Object.freeze(new Set<string>());

export function elicitationForm(
  pending: PendingElicitationSnapshot,
  fields: readonly ElicitationField[],
): ElicitationForm {
  const rendered = fields.map(toRenderField);
  const asking = rendered.filter(
    (field) => field.kind.k === "select" || field.kind.k === "multiselect",
  );
  return {
    message: pending.message,
    fields: rendered,
    steps: groupIntoSteps(rendered),
    showsPrompt: asking.length === 0 || asking.some((field) => field.hint === null),
  };
}

/** Step description, then the form message for a single step, then the field title: the two agents fill these in oppositely. */
export function askTitle(form: ElicitationForm, index: number): string {
  const leader = form.steps[index]?.fields[0];
  if (leader === undefined) return form.message;
  if (leader.hint !== null) return leader.hint;
  if (form.steps.length === 1) return form.message;
  return leader.label;
}

/** The agent's declared alternativeTo first, then the step, so a daemon older than that field still pairs the box. */
function questionOf(form: ElicitationForm, key: string): RenderField | null {
  const field = form.fields.find((entry) => entry.key === key);
  if (field === undefined) return null;
  const declared =
    field.alternativeTo === null
      ? undefined
      : form.fields.find((entry) => entry.key === field.alternativeTo);
  const asks =
    declared ??
    form.steps.find((step) => step.fields.some((entry) => entry.key === key) && step.fields[0]?.key !== key)
      ?.fields[0];
  if (asks === undefined) return null;
  return asks.kind.k === "select" || asks.kind.k === "multiselect" ? asks : null;
}

export function answerMark(form: ElicitationForm, field: RenderField): "one" | "many" | null {
  const asks = questionOf(form, field.key);
  if (asks === null) return null;
  return asks.kind.k === "multiselect" ? "many" : "one";
}

/** Writing your own answer clears a single-select's pick; picking never erases typed text. Multi-selects displace nothing. */
export function displacedBy(form: ElicitationForm, key: string): string[] {
  const asks = questionOf(form, key);
  if (asks === null) return [];
  return asks.kind.k === "select" ? [asks.key] : [];
}

/** Any field in the step counts, and a step with no fields answers itself. */
export function stepAnswered(
  form: ElicitationForm,
  index: number,
  content: Record<string, ContentValue>,
): boolean {
  const step = form.steps[index];
  if (step === undefined || step.fields.length === 0) return true;
  return step.fields.some((field) => Object.prototype.hasOwnProperty.call(content, field.key));
}

function groupIntoSteps(fields: readonly RenderField[]): RenderStep[] {
  const steps: RenderStep[] = [];
  for (const field of fields) {
    const open = steps.at(-1);
    const leader = open?.fields[0];
    const followsAChoice =
      leader !== undefined && (leader.kind.k === "select" || leader.kind.k === "multiselect");
    const isFollowUp = field.kind.k === "text" && !field.required && open?.fields.length === 1;
    if (open !== undefined && followsAChoice && isFollowUp) {
      open.fields.push({ ...field, hint: null });
      continue;
    }
    steps.push({ key: field.key, fields: [field] });
  }
  return steps;
}

function toRenderField(field: ElicitationField): RenderField {
  const base = {
    key: field.key,
    label: field.title ?? field.key,
    hint: field.description,
    required: field.required,
    alternativeTo: field.alternativeTo ?? null,
  };

  const options = field.options ?? [];
  switch (field.kind) {
    case "string":
      return options.length > 0
        ? {
            ...base,
            kind: { k: "select", options },
            fallback: typeof field.default === "string" ? field.default : undefined,
          }
        : {
            ...base,
            kind: {
              k: "text",
              multiline: field.format === null,
              rows: field.format === null && field.max !== null && field.max > TALL_ABOVE ? 3 : 1,
              format: field.format,
              min: field.min,
              max: field.max,
            },
            fallback: typeof field.default === "string" ? field.default : undefined,
          };
    case "number":
    case "integer":
      return {
        ...base,
        kind: { k: "number", integer: field.kind === "integer", min: field.min, max: field.max },
        fallback: typeof field.default === "number" ? String(field.default) : undefined,
      };
    case "boolean":
      return {
        ...base,
        kind: { k: "boolean" },
        fallback: typeof field.default === "boolean" ? field.default : undefined,
      };
    case "multi_select":
      return {
        ...base,
        kind: { k: "multiselect", options, min: field.min, max: field.max },
        fallback: Array.isArray(field.default) ? field.default : undefined,
      };
  }
}

export function fieldValue(field: RenderField, draft: ElicitationDraft): DraftValue | undefined {
  return Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : field.fallback;
}

/**
 * canSubmit is no problems plus something to submit (askUserQuestionsToCreateRequest marks nothing required), except a field-less form.
 * Emptiness is tested before any parse, since Number of a blank string is 0.
 */
export function elicitationAnswer(
  form: ElicitationForm,
  draft: ElicitationDraft,
  /** Answers switched off by hand: they stay in their boxes but are not sent. */
  excluded: ReadonlySet<string> = EMPTY_EXCLUSIONS,
): ElicitationAnswer {
  // Null prototype because the agent chooses the keys: a field named __proto__ must stay an own property.
  const content: Record<string, ContentValue> = Object.create(null) as Record<string, ContentValue>;
  const problems: FieldProblem[] = [];
  const fail = (key: string, code: ProblemCode, reason: string): void => {
    problems.push({ key, code, reason });
  };

  for (const field of form.fields) {
    const raw = fieldValue(field, draft);

    const empty =
      raw === undefined ||
      (typeof raw === "string" && raw.trim() === "") ||
      (Array.isArray(raw) && raw.length === 0 && !Object.prototype.hasOwnProperty.call(draft, field.key));
    if (empty) {
      if (field.required) fail(field.key, "required", "this one is needed");
      continue;
    }

    switch (field.kind.k) {
      case "text": {
        if (typeof raw !== "string") break;
        // Lines keep the first one's indentation, as a message does (Q3.646); a single line's ends are never content.
        const lines = sentText(raw);
        const value = lines.includes("\n") ? lines : lines.trim();
        const { min, max } = field.kind;
        if (min !== null && value.length < min) {
          fail(field.key, "too_short", `at least ${min} characters`);
          continue;
        }
        if (max !== null && value.length > max) {
          fail(field.key, "too_long", `at most ${max} characters`);
          continue;
        }
        if (value.length > MAX_ANSWER_CHARS) {
          fail(field.key, "too_long", `at most ${MAX_ANSWER_CHARS} characters`);
          continue;
        }
        content[field.key] = value;
        continue;
      }
      case "select": {
        if (typeof raw !== "string") break;
        if (!field.kind.options.some((option) => option.value === raw)) {
          fail(field.key, "not_an_option", "that is not one of the choices");
          continue;
        }
        content[field.key] = raw;
        continue;
      }
      case "number": {
        if (typeof raw !== "string") break;
        const value = Number(raw.trim());
        if (!Number.isFinite(value)) {
          fail(field.key, "not_a_number", "expected a number");
          continue;
        }
        if (field.kind.integer && !Number.isInteger(value)) {
          fail(field.key, "not_an_integer", "expected a whole number");
          continue;
        }
        if (field.kind.min !== null && value < field.kind.min) {
          fail(field.key, "below_min", `at least ${field.kind.min}`);
          continue;
        }
        if (field.kind.max !== null && value > field.kind.max) {
          fail(field.key, "above_max", `at most ${field.kind.max}`);
          continue;
        }
        content[field.key] = value;
        continue;
      }
      case "boolean": {
        if (typeof raw !== "boolean") break;
        content[field.key] = raw;
        continue;
      }
      case "multiselect": {
        if (!Array.isArray(raw)) break;
        const { options, min, max } = field.kind;
        const chosen = [...new Set(raw)];
        if (chosen.some((entry) => !options.some((option) => option.value === entry))) {
          fail(field.key, "not_an_option", "that is not one of the choices");
          continue;
        }
        if (min !== null && chosen.length < min) {
          fail(field.key, "too_few", `choose at least ${min}`);
          continue;
        }
        if (max !== null && chosen.length > max) {
          fail(field.key, "too_many", `choose at most ${max}`);
          continue;
        }
        content[field.key] = chosen;
        continue;
      }
    }
  }

  // Excluded or displaced answers are removed after the loop, since displacement depends on another field's value.
  for (const field of form.fields) {
    if (!Object.prototype.hasOwnProperty.call(content, field.key)) continue;
    const asks = questionOf(form, field.key);
    const suppressed =
      asks !== null &&
      asks.kind.k === "select" &&
      Object.prototype.hasOwnProperty.call(content, asks.key);
    if (excluded.has(field.key) || suppressed) delete content[field.key];
  }

  return {
    content,
    problems,
    canSubmit: problems.length === 0 && (form.fields.length === 0 || Object.keys(content).length > 0),
  };
}
