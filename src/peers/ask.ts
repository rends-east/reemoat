import type * as acp from "@agentclientprotocol/sdk";
import { parseQuestionRequest, questionResponse, type CursorQuestion } from "../acp/cursor.js";

export const ASK_TOOL_NAME = "ask_question";

/** What an agent asked through ask_question: cursor's own AskQuestion shape, so its model already knows how to fill it. */
export interface PosedQuestion {
  title: string | null;
  questions: CursorQuestion[];
}

export type PoseResult = { ok: true } | { ok: false; message: string };

export const ASK_INSTRUCTIONS =
  "ask_question puts multiple-choice questions in front of your user as a card with a button per option. " +
  "It returns before anyone answers: end your turn after calling it, and the answer arrives as your user's next message.";

const OPTION = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable id for this option." },
    label: { type: "string", description: "What the button says." },
  },
  required: ["id", "label"],
  additionalProperties: false,
};

export const ASK_TOOL = {
  name: ASK_TOOL_NAME,
  description:
    "Ask your user one or more multiple-choice questions, drawn as a card with a button per option. Use it whenever you want your " +
    "user to choose; your own AskQuestion tool is not available in this client. It returns at once, before anyone answers: " +
    "end your turn right after calling it and do not repeat the question as text. The answer arrives as your user's next " +
    "message, and if they skip the card you are told so.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional heading for the card." },
      questions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id for this question." },
            prompt: { type: "string", description: "The question itself." },
            options: { type: "array", minItems: 1, items: OPTION },
            allowMultiple: { type: "boolean", description: "Whether more than one option may be picked. Defaults to false." },
          },
          required: ["id", "prompt", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export const ASK_RESULT =
  "Shown to your user as a card. End your turn now, without repeating the question as text: their answer arrives as your " +
  "user's next message.";

/** cursor's own parser, so the two doors accept the same questions; a string is the refusal, worded for the model. */
export function parseAskArguments(args: Record<string, unknown>): PosedQuestion | string {
  try {
    const parsed = parseQuestionRequest({ ...args, toolCallId: ASK_TOOL_NAME });
    return { title: parsed.title, questions: parsed.questions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Invalid params: /, "");
  }
}

/** The message an answer is delivered as, or null for a card dismissed with nothing to say. */
export function answerText(posed: PosedQuestion, response: acp.CreateElicitationResponse): string | null {
  const outcome = questionResponse(response, posed.questions).outcome;
  if (outcome.outcome === "cancelled") return null;
  if (outcome.outcome === "skipped") return "Skipped your ask_question: carry on without an answer.";
  const lines = posed.questions.map((question) => {
    const picked = outcome.answers.find((answer) => answer.questionId === question.id)?.selectedOptionIds ?? [];
    const labels = question.options.filter((option) => picked.includes(option.id)).map((option) => option.label);
    return `${question.prompt} — ${labels.length === 0 ? "(no answer)" : labels.join(", ")}`;
  });
  return ["Answer to your ask_question:", ...lines].join("\n");
}
