import type * as acp from "@agentclientprotocol/sdk";
import { parseQuestionRequest, questionResponse, type CursorQuestion } from "../acp/cursor.js";

export const ASK_TOOL_NAME = "ask_question";

/** What an agent asked through ask_question: cursor's own AskQuestion shape, so its model already knows how to fill it. */
export interface PosedQuestion {
  title: string | null;
  questions: CursorQuestion[];
}

/** `answer` is the call's own result, or null when the card outlived the call and the answer will come as a message. */
export type PoseResult = { ok: true; answer: string | null } | { ok: false; message: string };

/** Under the 60 s cursor's MCP client allows any call, so an answer in time is the result, as every other harness's is (Q2.251). */
export const ASK_WAIT_MS = 50_000;

export const ASK_INSTRUCTIONS =
  "ask_question puts multiple-choice questions in front of your user as a card with a button per option and returns their answer. " +
  "If they have not answered within a minute it returns without one: then end your turn at once, writing nothing, and the " +
  "answer arrives as your user's next message.";

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
    "user to choose; your own AskQuestion tool is not available in this client. It waits for the answer and returns it. If " +
    "your user has not answered within a minute it returns without one: then end your turn at once, writing nothing and not " +
    "repeating the question, and the answer arrives as your user's next message. If they skip the card you are told so.",
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

export const ASK_PENDING =
  "Your user has not answered yet, and the card stays open. End your turn now and write nothing: their answer arrives as " +
  "your user's next message.";

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

/** The call's result when the answer came while it waited. */
export function answerResult(posed: PosedQuestion, response: acp.CreateElicitationResponse): string {
  const outcome = questionResponse(response, posed.questions).outcome;
  if (outcome.outcome === "cancelled") return "Your user closed the card without answering: carry on without an answer.";
  if (outcome.outcome === "skipped") return "Your user skipped the question: carry on without an answer.";
  return ["Your user answered:", ...answerLines(posed, outcome.answers)].join("\n");
}

/** The message an answer is delivered as once the call has returned, or null for a card dismissed with nothing to say. */
export function answerText(posed: PosedQuestion, response: acp.CreateElicitationResponse): string | null {
  const outcome = questionResponse(response, posed.questions).outcome;
  if (outcome.outcome === "cancelled") return null;
  if (outcome.outcome === "skipped") return "Skipped your ask_question: carry on without an answer.";
  return ["Answer to your ask_question:", ...answerLines(posed, outcome.answers)].join("\n");
}

function answerLines(posed: PosedQuestion, answers: readonly { questionId: string; selectedOptionIds: string[] }[]): string[] {
  return posed.questions.map((question) => {
    const picked = answers.find((answer) => answer.questionId === question.id)?.selectedOptionIds ?? [];
    const labels = question.options.filter((option) => picked.includes(option.id)).map((option) => option.label);
    return `${question.prompt} — ${labels.length === 0 ? "(no answer)" : labels.join(", ")}`;
  });
}
