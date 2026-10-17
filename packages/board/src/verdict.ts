// A role asked to pick an exit: what it is shown, and how its answer is read. One contract for every role (Q2.267).
import { STAY, type Exit, type Sees } from "./config.js";

/** The whole question, contract and context together, as an ask may carry it. */
export const MAX_JUDGE_PROMPT_BYTES = 8 * 1024;
export const MAX_SEEN_LAST_MESSAGE_BYTES = 4 * 1024;
export const MAX_SEEN_DIFF_BYTES = 6 * 1024;
/** A role's instructions, as much of them as a question carries: the rest of the 8 KiB is what the judge reads. */
export const MAX_JUDGE_INSTRUCTIONS_BYTES = 2 * 1024;
/** A harness role has this long to answer before it is taken to abstain. */
export const JUDGE_TIMEOUT_MS = 120_000;
/** A classifier from a plugin, this long. */
export const CLASSIFIER_TIMEOUT_MS = 10_000;

/** What the owning daemon read for a judge, each piece optional: a piece nobody could read is left out. */
export type SeenContext = Partial<Record<Sees, string | null>>;

export interface VerdictAnswer {
  /** An exit's name, stay, or null for no opinion. */
  exit: string | null;
  confidence: number | null;
}

export type Judged = VerdictAnswer & { abstained: string | null };

const encoder = new TextEncoder();

function bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Cut to a byte budget on a character boundary, saying so. */
export function clipBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const mark = "\n…(cut)";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(text.slice(0, mid)) + bytes(mark) <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + mark;
}

const LABELS: Record<Sees, string> = {
  brief: "The task's brief",
  summary: "The task's summary",
  report: "The run's report",
  last_message: "The agent's last message",
  diff_stat: "What the run changed",
  diff: "The run's diff",
};

/**
 * The question a role is asked: the exits with what each means, the answer's one shape, and what the column's `sees` lets it
 * read, each piece within its own bound and the whole within an ask's, cut from the end of the list until it fits.
 */
export function judgePrompt(
  title: string,
  column: string,
  exits: readonly Exit[],
  sees: readonly Sees[],
  context: SeenContext,
  instructions: string | null = null,
): string {
  const lens =
    instructions === null || instructions.trim().length === 0
      ? " "
      : `\n\nYour user wrote these instructions for you in their board; judge by them:\n${clipBytes(instructions.trim(), MAX_JUDGE_INSTRUCTIONS_BYTES)}\n\n`;
  const head =
    `You are deciding where a task on a board goes next. The task is "${title.replace(/["\r\n]/g, " ")}", and its work in the ` +
    `${column.replace(/[\r\n]/g, " ")} column is over.${lens}Pick one exit:\n` +
    exits.map((exit) => `- ${exit.name}: ${exit.means ?? exit.label}`).join("\n") +
    "\n\nAnswer with one JSON object and nothing else: " +
    '{"exit": "<one of the names above>", "confidence": <a number from 0 to 1>}. ' +
    'Answer {"exit": "stay"} to leave the choice to a person, or {"exit": null} if you cannot tell.\n';
  const pieces: string[] = [];
  for (const one of sees) {
    const raw = context[one];
    if (raw === undefined || raw === null || raw.trim().length === 0) continue;
    const bound = one === "last_message" ? MAX_SEEN_LAST_MESSAGE_BYTES : one === "diff" ? MAX_SEEN_DIFF_BYTES : MAX_JUDGE_PROMPT_BYTES;
    pieces.push(`\n${LABELS[one]}:\n${clipBytes(raw.trim(), bound)}\n`);
  }
  while (pieces.length > 0 && bytes(head + pieces.join("")) > MAX_JUDGE_PROMPT_BYTES) {
    const last = pieces.length - 1;
    const room = MAX_JUDGE_PROMPT_BYTES - bytes(head + pieces.slice(0, last).join(""));
    if (room > 200) {
      pieces[last] = clipBytes(pieces[last]!, room);
      if (bytes(head + pieces.join("")) <= MAX_JUDGE_PROMPT_BYTES) break;
    }
    pieces.pop();
  }
  return clipBytes(head + pieces.join(""), MAX_JUDGE_PROMPT_BYTES);
}

/**
 * The answer read strictly: one JSON object, alone or in one fenced block, naming an exit, stay or null, and a confidence
 * from 0 to 1 if any. Anything else is no answer at all.
 */
export function parseVerdict(text: string, exits: readonly Exit[]): VerdictAnswer | null {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced !== null) body = fenced[1]!.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: an answer in prose is no answer.
    return null;
  }
  return readVerdict(parsed, exits);
}

/** The same shape from a classifier, which answers as an object rather than as text. */
export function readVerdict(value: unknown, exits: readonly Exit[]): VerdictAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  const keys = Object.keys(answer);
  if (!keys.includes("exit") || keys.some((key) => key !== "exit" && key !== "confidence")) return null;
  const exit = answer["exit"];
  if (exit !== null && (typeof exit !== "string" || (exit !== STAY && !exits.some((one) => one.name === exit)))) return null;
  const confidence = answer["confidence"];
  if (confidence !== undefined && confidence !== null && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))) return null;
  return { exit: exit as string | null, confidence: typeof confidence === "number" ? confidence : null };
}

/** An answer, or why the role is taken to abstain: unread, below its floor, or none. A confidence it did not give is not checked. */
export function judged(answer: VerdictAnswer | null, minConfidence: number | null): Judged {
  if (answer === null) return { exit: null, confidence: null, abstained: "its answer could not be read" };
  if (answer.exit === null) return { ...answer, abstained: "it could not tell" };
  if (minConfidence !== null && answer.confidence !== null && answer.confidence < minConfidence) {
    return { exit: null, confidence: answer.confidence, abstained: `${Math.round(answer.confidence * 100)}% is below its floor` };
  }
  return { ...answer, abstained: null };
}
