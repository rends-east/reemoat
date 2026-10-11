import type { Untranslatable } from "../translate/types.js";

type Json = Record<string, unknown>;

/** Rejected where a ChatGPT plan pays, and a request loses nothing it holds by losing one. */
const DROPPED = [
  "background",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
];

/** Rejected too, and each names something kept at the vendor: left out, the request would go short of it. */
const KEPT_AT_VENDOR = new Map([
  ["previous_response_id", "an earlier answer"],
  ["conversation", "a stored conversation"],
  ["prompt", "a stored prompt"],
]);

/** Tools the vendor runs itself, which a plan is not offered. */
const HOSTED = new Set([
  "image_generation",
  "file_search",
  "code_interpreter",
  "computer",
  "computer_use",
  "computer_use_preview",
  "mcp",
  "tool_search",
  "programmatic_tool_calling",
]);

const UNREADABLE = "The request is not one a ChatGPT plan can be sent.";
const NO_INPUT = "The request carries no input, and a ChatGPT plan is sent the whole conversation each time.";
const ONLY_HOSTED = "The request requires a tool call and offers only tools a ChatGPT plan is not offered.";

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cannot(sentence: string): Untranslatable {
  return { untranslatable: sentence };
}

function isHosted(tool: unknown): tool is Json & { type: string } {
  return isObject(tool) && typeof tool["type"] === "string" && HOSTED.has(tool["type"]);
}

function isSystemMessage(item: unknown): item is Json {
  return isObject(item) && item["role"] === "system" && (item["type"] === undefined || item["type"] === "message");
}

function inputOf(input: unknown): unknown[] | Untranslatable {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return cannot(NO_INPUT);
  return input.map((item: unknown) => (isSystemMessage(item) ? { ...item, role: "developer" } : item));
}

/** Takes the hosted tools out of what is offered, or names the one the request cannot do without. */
function withoutHosted(out: Json): Untranslatable | null {
  const choice = out["tool_choice"];
  if (isHosted(choice)) return cannot(`The request requires the tool "${choice.type}", which a ChatGPT plan is not offered.`);
  const tools = out["tools"];
  if (Array.isArray(tools)) {
    const kept = tools.filter((tool) => !isHosted(tool));
    if (kept.length === 0 && tools.length > 0) {
      if (choice === "required") return cannot(ONLY_HOSTED);
      delete out["tools"];
    } else if (kept.length < tools.length) {
      out["tools"] = kept;
    }
  }
  if (isObject(choice) && choice["type"] === "allowed_tools" && Array.isArray(choice["tools"])) {
    const allowed = choice["tools"].filter((tool) => !isHosted(tool));
    if (allowed.length === 0 && choice["tools"].length > 0) {
      if (choice["mode"] === "required") return cannot(ONLY_HOSTED);
      out["tool_choice"] = "none";
    } else if (allowed.length < choice["tools"].length) {
      out["tool_choice"] = { ...choice, tools: allowed };
    }
  }
  return null;
}

/** A Responses request as the route a ChatGPT plan pays for accepts it, or what in it that route has no place for. */
export function shapeForChatgptPlan(body: unknown): { body: unknown } | Untranslatable {
  if (!isObject(body)) return cannot(UNREADABLE);
  for (const [field, what] of KEPT_AT_VENDOR) {
    if (body[field] !== undefined && body[field] !== null) {
      return cannot(`The request continues from ${what} kept at OpenAI (${field}), and a ChatGPT plan is sent the whole conversation each time.`);
    }
  }
  const input = inputOf(body["input"]);
  if (!Array.isArray(input)) return input;
  const out: Json = { ...body, input, store: false, stream: true };
  for (const field of [...DROPPED, ...KEPT_AT_VENDOR.keys()]) delete out[field];
  return withoutHosted(out) ?? { body: out };
}
