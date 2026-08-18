/**
 * A question the agent asked, as something a person can fill in.
 *
 * Sibling of `permission.ts`, which is the same job for the other half of *does
 * anything need me*. Everything here is pure so `webcheck` can assert it with no
 * DOM — which matters more than usual, because every rule below is silently wrong
 * in a direction nobody notices: a zero sent for a field somebody left blank, an
 * empty string that reads as an answer, a Submit button enabled onto a 400.
 *
 * **Much smaller than it would have been, because the daemon projects.** The raw
 * ACP schema is an open union of JSON-Schema fragments; by the time it reaches
 * here it is a fixed `ElicitationField[]` with `enum`/`oneOf` already normalized,
 * unknown property types already refused, and `pattern` already dropped. So there
 * is no schema parsing in this file, no `unknown` to narrow, and no truncation
 * marker to recognise — the daemon refuses an oversized form outright rather than
 * handing over a stand-in, because `{truncated: true, bytes}` is a fine thing to
 * show above an Approve button and useless above a form.
 *
 * **Nothing here reads a field's name.** claude's adapter keys an
 * `AskUserQuestion` as `question_0`, `question_0_custom`, `question_1`… and it
 * would be easy to match those and fuse each "Other" box into the question above
 * it. That is the `"reject_once"` mistake one surface over: those names are what
 * one adapter happens to send today. `webcheck` pins it by running the whole
 * fixture again with the keys renamed and asserting the same form comes out.
 *
 * What falls out is that the *generic* rendering is already almost exactly what
 * Claude Code draws: `message` is the prompt, a select is option rows carrying
 * each option's own description, and the adapter's own `title: "Other"` field
 * lands underneath as an optional one-line box.
 */

import { MAX_ANSWER_CHARS } from "./wire";
import type { ElicitationField, ElicitationOption, PendingElicitationSnapshot } from "./wire";

/**
 * What a control holds while it is being filled in.
 *
 * A number lives here as **the string being typed**, and that is the whole reason
 * this is not `ContentValue`. `-`, `1.` and `1e` are real intermediate states, and
 * coercing on every keystroke deletes what is in the box.
 * {@link elicitationAnswer} is the only place that crosses over.
 */
export type DraftValue = string | boolean | string[];

/** A partial record on purpose — see {@link fieldValue} on why absence is a state. */
export type ElicitationDraft = Readonly<Record<string, DraftValue>>;

/** What goes on the wire, matching ACP's `ElicitationContentValue`. */
export type ContentValue = string | number | boolean | string[];

/** How a field is drawn. Closed, so the JSX can switch exhaustively. */
export type RenderKind =
  | { k: "text"; multiline: boolean; format: ElicitationField["format"]; min: number | null; max: number | null }
  | { k: "number"; integer: boolean; min: number | null; max: number | null }
  | { k: "boolean" }
  | { k: "select"; options: ElicitationOption[] }
  | { k: "multiselect"; options: ElicitationOption[]; min: number | null; max: number | null };

export interface RenderField {
  key: string;
  /** `title`, falling back to the raw key. Never invented, never prettified. */
  label: string;
  hint: string | null;
  required: boolean;
  kind: RenderKind;
  /** The agent's own default, already the right type for the control. */
  fallback: DraftValue | undefined;
}

/**
 * One question, with whatever belongs to it.
 *
 * The unit the card steps through. Usually a choice plus the free-text box the
 * agent offered beside it; for a plain form, one field on its own.
 */
export interface RenderStep {
  key: string;
  fields: RenderField[];
}

export interface ElicitationForm {
  message: string;
  fields: RenderField[];
  /**
   * The fields grouped into questions, in order.
   *
   * **This is a change of mind, recorded rather than quietly made.** The rule
   * below — an optional options-less text field directly after a field with
   * choices belongs to it — was refused once, on the grounds that an MCP form's
   * `{choice, notes}` pair would be fused too, where `notes` is a second question
   * in its own right.
   *
   * What made that argument wrong is that the grouping is **presentational
   * only**: both fields keep their own key and both are validated and sent
   * independently, so the worst a wrong grouping does is put two questions on one
   * card together. That is a cosmetic misread, not an answer that means something
   * else — which is what the original objection was actually about.
   *
   * And the gain is not cosmetic: without a notion of "one question", stepping
   * through three questions means six screens, half of them a bare text box with
   * no idea what it is for.
   */
  steps: RenderStep[];
  /**
   * Whether `message` says anything the fields do not.
   *
   * With one question the adapter puts the question itself in `message` and
   * leaves the field's description empty, so it is the only text there is. With
   * several it puts a preamble there — "Please answer the following questions." —
   * and gives each question its own description, so drawing it costs a line of
   * boilerplate above questions that already speak for themselves.
   *
   * Decided **structurally** and never by matching that sentence: a string one
   * adapter happens to send today is exactly what `labelFor` and the
   * field-name rule forbid keying on. The question asked instead is "do the
   * substantive fields carry their own text" — and only fields with choices
   * count, because the adapter's own free-text box always has a description and
   * would otherwise answer for the question above it.
   */
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
  /** One sentence, drawn under the field. `webcheck` asserts `code`. */
  reason: string;
}

export interface ElicitationAnswer {
  /** Exactly the `content` the route takes. Untouched optionals are absent. */
  content: Record<string, ContentValue>;
  problems: FieldProblem[];
  canSubmit: boolean;
}

/**
 * Above this many characters, a string field gets a textarea.
 *
 * ACP has no such field, so it is derived — narrowly. An agent saying
 * `maxLength: 4000` is asking for prose; one saying nothing is asking for an
 * answer, and the commonest unbounded string in practice is the adapter's own
 * one-line "Other" box. Wrong in the cheap direction: a single-line input still
 * scrolls.
 */
const MULTILINE_ABOVE = 240;

/** Turn the daemon's fields into controls. */
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
    // Shown unless every question already carries its own text. A form with no
    // choice fields at all — a free-text or confirmation form — keeps it, because
    // then it really is the only thing saying what is wanted.
    showsPrompt: asking.length === 0 || asking.some((field) => field.hint === null),
  };
}

/**
 * What the card puts at the top of one step: the question, in the agent's words.
 *
 * Three sources and the order between them is the whole rule, because the two
 * agents fill them in oppositely and getting it wrong loses the question
 * entirely on one of them.
 *
 * 1. **The step's own description.** With several questions the adapter puts
 *    each one here and leaves `message` as a preamble, so this is the question.
 * 2. **The form's message, but only when there is one step.** With one question
 *    the adapter does the reverse — the question is in `message` and the field's
 *    description is empty — so the message *is* the question. Reading the field's
 *    `title` first would put the short chip label at the top and drop the
 *    sentence somebody has to answer — measured, that label read "what are we
 *    doing", translated from the original.
 * 3. **The field's title.** Which is what is left for a multi-step form whose
 *    fields carry no description: an MCP `{key: "regions", title: "Regions"}`
 *    multi-select, whose options become the card's unlabelled rows. Without this
 *    arm every step of such a form is titled with the same generic message and
 *    the word "Regions" appears nowhere on screen.
 *
 * Pure and here rather than in the card for the reason the rest of this file is:
 * it is silently correct on whichever agent the author happened to be running.
 */
export function askTitle(form: ElicitationForm, index: number): string {
  const leader = form.steps[index]?.fields[0];
  if (leader === undefined) return form.message;
  if (leader.hint !== null) return leader.hint;
  if (form.steps.length === 1) return form.message;
  return leader.label;
}

/** See {@link ElicitationForm.steps} for why this rule exists and what it risks. */
function groupIntoSteps(fields: readonly RenderField[]): RenderStep[] {
  const steps: RenderStep[] = [];
  for (const field of fields) {
    const open = steps.at(-1);
    const leader = open?.fields[0];
    const followsAChoice =
      leader !== undefined && (leader.kind.k === "select" || leader.kind.k === "multiselect");
    // One follow-up per question, so a form of three loose text fields does not
    // collapse into one step.
    const isFollowUp = field.kind.k === "text" && !field.required && open?.fields.length === 1;
    if (open !== undefined && followsAChoice && isFollowUp) {
      // Its description goes with it. The adapter explains the box — "Type your
      // own answer instead of choosing an option above (optional)." — because on
      // a flat list it has to; sitting directly under the choices it belongs to,
      // that sentence says what the layout already says. Dropped only *here*, so
      // a text field standing on its own keeps whatever the agent wrote.
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
    // The raw key rather than a prettified one. Renaming something an agent named
    // is what `labelFor` forbids one surface over, and here there is no better
    // version to offer at all.
    label: field.title ?? field.key,
    hint: field.description,
    required: field.required,
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
              multiline: field.max !== null && field.max > MULTILINE_ABOVE,
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
        // Stringified, because the draft holds what is being typed.
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

/**
 * What a control shows: what was typed, else the agent's default, else nothing.
 *
 * Exported so the control and {@link elicitationAnswer} read one rule. Two
 * derivations of "what is in this box" is how a checkbox comes to show itself
 * checked and send nothing.
 */
export function fieldValue(field: RenderField, draft: ElicitationDraft): DraftValue | undefined {
  return Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : field.fallback;
}

/**
 * Validate a draft and build the body in one pass.
 *
 * **`canSubmit` and the request body are the same value**, which is stronger than
 * the `canSend` precedent this mirrors: `canSend` has to *agree* with its route
 * or Send is enabled onto a 400, and here the thing enabling the button is
 * literally the thing being sent, so there is nothing left to agree about.
 *
 * A key **absent** from the draft is a third state doing real work three times:
 * untouched with a default sends the default (the control is showing it, so it
 * *is* the answer), untouched without one is omitted, and a deliberately-emptied
 * multi-select is sent as `[]` rather than dropped.
 *
 * Emptiness is tested **before** any parse, and that ordering is load-bearing:
 * `Number("")` and `Number(" ")` are both `0`, so a parse-first version silently
 * sends a zero nobody typed into a blank optional number field.
 *
 * An untouched optional field is *absent* from `content`, never `""` — the
 * adapter reads a non-empty custom field as overriding that question's selection,
 * so an empty string sent where somebody typed nothing answers a question they
 * skipped.
 */
export function elicitationAnswer(form: ElicitationForm, draft: ElicitationDraft): ElicitationAnswer {
  /*
   * **`Object.create(null)`, because the agent chooses these keys.**
   *
   * A field named `__proto__` is a legal JSON Schema property and an MCP server
   * may send one. On a plain `{}`, `content[field.key] = value` for that key sets
   * the object's *prototype* instead of an own property — so the answer vanished,
   * `JSON.stringify` emitted `{}`, and `canSubmit` still said `true`. Measured:
   * a required `__proto__` field produced `content: {}` with **no problems**, so
   * the card enabled Submit on a form it could not answer and the daemon replied
   * `400 invalid_content` for a form somebody had filled in correctly.
   *
   * With a null prototype it is an ordinary own property, serialises, and reaches
   * the daemon — whose own validator reads `Object.keys` and `hasOwnProperty` and
   * was never exposed to this. One line, and it removes a silent drop rather than
   * adding a rule about names.
   */
  const content: Record<string, ContentValue> = Object.create(null) as Record<string, ContentValue>;
  const problems: FieldProblem[] = [];
  const fail = (key: string, code: ProblemCode, reason: string): void => {
    problems.push({ key, code, reason });
  };

  for (const field of form.fields) {
    const raw = fieldValue(field, draft);

    // Emptiness first, before any parse. See the docblock.
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
        const value = raw.trim();
        const { min, max } = field.kind;
        if (min !== null && value.length < min) {
          fail(field.key, "too_short", `at least ${min} characters`);
          continue;
        }
        if (max !== null && value.length > max) {
          fail(field.key, "too_long", `at most ${max} characters`);
          continue;
        }
        // The daemon's own ceiling, which it applies to every string field before
        // it looks at that field's `maxLength` — and the adapter's free-text box
        // carries no `maxLength` at all, so this was the only thing standing
        // between a long answer and a `400`.
        if (value.length > MAX_ANSWER_CHARS) {
          fail(field.key, "too_long", `at most ${MAX_ANSWER_CHARS} characters`);
          continue;
        }
        content[field.key] = value;
        continue;
      }
      case "select": {
        if (typeof raw !== "string") break;
        // By identity against the value the daemon sent. Reachable when a default
        // names something the option list does not contain, which an agent can do.
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
        // `false` is an answer, which is why the emptiness test above never looks
        // at booleans.
        content[field.key] = raw;
        continue;
      }
      case "multiselect": {
        if (!Array.isArray(raw)) break;
        // Hoisted, because the narrowing is lost inside the closure below.
        const { options, min, max } = field.kind;
        // Deduped keeping first order: two identical choices reach the agent as a
        // repeated label once the adapter joins them.
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

  return { content, problems, canSubmit: problems.length === 0 };
}
