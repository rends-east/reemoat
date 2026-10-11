import { createHash } from "node:crypto";
import type { SseEvent, TranslateContext, Translator, Untranslatable } from "./types.js";

type Json = Record<string, unknown>;

/** Marks a thinking signature as a Responses reasoning item this module packed; any other signature is another vendor's. */
const SIGNATURE_PREFIX = "rmr1.";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Claude Code's first system block is this line for Anthropic's billing, and no part of the prompt. */
const BILLING_LINE = "x-anthropic-billing-header:";

const STATUS_ERRORS = new Map<number, string>([
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [402, "billing_error"],
  [403, "permission_error"],
  [404, "not_found_error"],
  [413, "request_too_large"],
  [429, "rate_limit_error"],
  [529, "overloaded_error"],
]);

/** What a stream fails with, by the code it gives; any other is an api_error. */
const CODE_ERRORS = new Map<string, string>([
  ["rate_limit_exceeded", "rate_limit_error"],
  ["slow_down", "rate_limit_error"],
  ["server_is_overloaded", "overloaded_error"],
  ["invalid_prompt", "invalid_request_error"],
]);

const UNREADABLE = "The request is not one this gateway can read.";
const SILENT = "The provider failed this answer and did not say why.";
const MAX_NAMED_CHARS = 80;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cannot(sentence: string): Untranslatable {
  return { untranslatable: sentence };
}

function isRefusal(value: unknown): value is Untranslatable {
  return isObject(value) && typeof value["untranslatable"] === "string";
}

/** A name off the wire, quoted and bounded, for a sentence a person reads. */
function named(value: unknown): string {
  const text = typeof value === "string" && value !== "" ? value : "?";
  return `"${text.length <= MAX_NAMED_CHARS ? text : `${text.slice(0, MAX_NAMED_CHARS)}…`}"`;
}

function parse(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: a keep-alive, a terminator, or arguments cut short.
    return null;
  }
}

function request(body: unknown, context: TranslateContext): { body: unknown } | Untranslatable {
  if (!isObject(body)) return cannot(UNREADABLE);
  // A top-level key this does not read is left behind: a harness adds one in an update, and refusing it would end every turn of every session until this file learned its name. What a conversation holds is refused instead.

  const instructions = instructionsOf(body["system"]);
  if (isRefusal(instructions)) return instructions;
  const input: Json[] = [];
  const refused = inputOf(body["messages"], input);
  if (refused !== null) return refused;
  const tools = toolsOf(body["tools"]);
  if (isRefusal(tools)) return tools;
  const choice = choiceOf(body["tool_choice"], tools);
  if (isRefusal(choice)) return choice;
  const format = formatOf(body["output_config"]);
  if (isRefusal(format)) return format;

  const out: Json = { model: typeof body["model"] === "string" ? body["model"] : context.model };
  if (instructions !== "") out["instructions"] = instructions;
  out["input"] = input;
  if (tools.length > 0) Object.assign(out, { tools }, choice);
  const effort = effortOf(body);
  if (effort !== null) {
    out["reasoning"] = { effort, summary: "auto" };
    out["include"] = ["reasoning.encrypted_content"];
  }
  if (format !== null) out["text"] = { format };
  if (typeof body["max_tokens"] === "number") out["max_output_tokens"] = body["max_tokens"];
  if (typeof body["temperature"] === "number") out["temperature"] = body["temperature"];
  if (typeof body["top_p"] === "number") out["top_p"] = body["top_p"];
  const user = isObject(body["metadata"]) ? body["metadata"]["user_id"] : undefined;
  // Hashed: Claude Code's is a JSON string of device, account and session ids, and none of them is this vendor's to hold.
  if (typeof user === "string" && user !== "") out["prompt_cache_key"] = createHash("sha256").update(user).digest("hex");
  out["store"] = false;
  out["stream"] = body["stream"] === true;
  return { body: out };
}

function instructionsOf(system: unknown): string | Untranslatable {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return cannot(UNREADABLE);
  const texts: string[] = [];
  for (const block of system) {
    if (!isObject(block) || block["type"] !== "text" || typeof block["text"] !== "string") return cannot(blockRefusal(block));
    if (block["text"] !== "" && !block["text"].startsWith(BILLING_LINE)) texts.push(block["text"]);
  }
  return texts.join("\n\n");
}

function blockRefusal(block: unknown): string {
  return `The conversation holds a block of type ${named(isObject(block) ? block["type"] : undefined)}, which cannot be carried to this provider.`;
}

function inputOf(messages: unknown, input: Json[]): Untranslatable | null {
  if (!Array.isArray(messages)) return cannot(UNREADABLE);
  const called = new Set<string>();
  for (const message of messages) {
    if (!isObject(message)) return cannot(UNREADABLE);
    const content = message["content"];
    const blocks: unknown = typeof content === "string" ? [{ type: "text", text: content }] : content;
    if (!Array.isArray(blocks)) return cannot(UNREADABLE);
    const role = message["role"];
    let refused: Untranslatable | null;
    if (role === "assistant") refused = assistantItems(blocks, input, called);
    else if (role === "user") refused = spokenItems("user", blocks, input, called);
    else if (role === "system") refused = spokenItems("developer", blocks, input, called);
    else refused = cannot(`The conversation holds a message from ${named(role)}, which has no counterpart at this provider.`);
    if (refused !== null) return refused;
  }
  return null;
}

function spokenItems(role: "user" | "developer", blocks: unknown[], input: Json[], called: Set<string>): Untranslatable | null {
  let parts: Json[] = [];
  const flush = (): void => {
    if (parts.length > 0) input.push({ type: "message", role, content: parts });
    parts = [];
  };
  for (const block of blocks) {
    if (!isObject(block)) return cannot(UNREADABLE);
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push({ type: "input_text", text: block["text"] });
    } else if (block["type"] === "image" && role === "user") {
      const image = imageOf(block);
      if (isRefusal(image)) return image;
      parts.push(image);
    } else if (block["type"] === "tool_result" && role === "user") {
      const id = block["tool_use_id"];
      if (typeof id !== "string" || !called.has(id)) {
        return cannot(`A tool result answers the call ${named(id)}, which the conversation never made.`);
      }
      const output = outputOf(block["content"]);
      if (isRefusal(output)) return output;
      flush();
      input.push({ type: "function_call_output", call_id: id, output });
    } else {
      return cannot(blockRefusal(block));
    }
  }
  flush();
  return null;
}

function assistantItems(blocks: unknown[], input: Json[], called: Set<string>): Untranslatable | null {
  const first = input.length;
  let parts: Json[] = [];
  const flush = (): void => {
    if (parts.length > 0) input.push({ type: "message", role: "assistant", content: parts });
    parts = [];
  };
  for (const block of blocks) {
    if (!isObject(block)) return cannot(UNREADABLE);
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push({ type: "output_text", text: block["text"], annotations: [] });
    } else if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
      flush();
      called.add(block["id"]);
      input.push({ type: "function_call", call_id: block["id"], name: block["name"], arguments: JSON.stringify(block["input"] ?? {}) });
    } else if (block["type"] === "thinking" || block["type"] === "redacted_thinking") {
      const reasoning = unpackReasoning(block["signature"]);
      if (reasoning !== null) {
        flush();
        input.push(reasoning);
      }
    } else {
      return cannot(blockRefusal(block));
    }
  }
  flush();
  // Responses refuses a reasoning item with nothing after it, and a turn cut after its thinking leaves exactly that.
  while (input.length > first && input.at(-1)?.["type"] === "reasoning") input.pop();
  return null;
}

function imageOf(block: Json): Json | Untranslatable {
  const source = block["source"];
  if (isObject(source)) {
    if (source["type"] === "base64" && typeof source["media_type"] === "string" && typeof source["data"] === "string") {
      return { type: "input_image", image_url: `data:${source["media_type"]};base64,${source["data"]}`, detail: "auto" };
    }
    if (source["type"] === "url" && typeof source["url"] === "string") {
      return { type: "input_image", image_url: source["url"], detail: "auto" };
    }
  }
  return cannot(`An image arrives as ${named(isObject(source) ? source["type"] : undefined)}, which cannot be carried to this provider.`);
}

function outputOf(content: unknown): string | Json[] | Untranslatable {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return cannot(UNREADABLE);
  const parts: Json[] = [];
  for (const block of content) {
    if (isObject(block) && block["type"] === "text" && typeof block["text"] === "string") {
      parts.push({ type: "input_text", text: block["text"] });
    } else if (isObject(block) && block["type"] === "image") {
      const image = imageOf(block);
      if (isRefusal(image)) return image;
      parts.push(image);
    } else {
      return cannot(`A tool result holds a block of type ${named(isObject(block) ? block["type"] : undefined)}, which cannot be carried to this provider.`);
    }
  }
  return parts.every((part) => part["type"] === "input_text") ? parts.map((part) => part["text"]).join("\n") : parts;
}

function toolsOf(tools: unknown): Json[] | Untranslatable {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) return cannot(UNREADABLE);
  const out: Json[] = [];
  for (const tool of tools) {
    if (!isObject(tool)) return cannot(UNREADABLE);
    // A typed tool is one its own vendor runs or defines: there is no schema here to hand on.
    if (tool["type"] !== undefined && tool["type"] !== null && tool["type"] !== "custom") continue;
    if (typeof tool["name"] !== "string") return cannot(UNREADABLE);
    out.push({
      type: "function",
      name: tool["name"],
      ...(typeof tool["description"] === "string" ? { description: tool["description"] } : {}),
      parameters: isObject(tool["input_schema"]) ? tool["input_schema"] : { type: "object", properties: {} },
      strict: false,
    });
  }
  return out;
}

function choiceOf(choice: unknown, tools: Json[]): Json | Untranslatable {
  if (!isObject(choice)) return {};
  const out: Json = {};
  if (choice["type"] === "auto") out["tool_choice"] = "auto";
  else if (choice["type"] === "any") out["tool_choice"] = "required";
  else if (choice["type"] === "none") out["tool_choice"] = "none";
  else if (choice["type"] === "tool") {
    if (!tools.some((tool) => tool["name"] === choice["name"])) {
      return cannot(`The request requires the tool ${named(choice["name"])}, which is not among those this provider can be given.`);
    }
    out["tool_choice"] = { type: "function", name: choice["name"] };
  } else {
    return cannot(`The request chooses tools by ${named(choice["type"])}, which has no counterpart at this provider.`);
  }
  if (choice["disable_parallel_tool_use"] === true) out["parallel_tool_calls"] = false;
  return out;
}

function formatOf(config: unknown): Json | null | Untranslatable {
  const format = isObject(config) ? config["format"] : undefined;
  if (!isObject(format)) return null;
  if (format["type"] !== "json_schema") {
    return cannot(`The request asks for output as ${named(format["type"])}, which has no counterpart at this provider.`);
  }
  return { type: "json_schema", name: "output", schema: format["schema"], strict: false };
}

function effortOf(body: Json): string | null {
  const asked = isObject(body["output_config"]) ? body["output_config"]["effort"] : undefined;
  if (typeof asked === "string" && EFFORTS.has(asked)) return asked;
  const thinking = isObject(body["thinking"]) ? body["thinking"]["type"] : undefined;
  return typeof thinking === "string" && thinking !== "disabled" ? "medium" : null;
}

function packReasoning(item: Json): string {
  const kept: Json = {
    id: item["id"],
    encrypted_content: item["encrypted_content"] ?? null,
    summary: Array.isArray(item["summary"]) ? item["summary"] : [],
  };
  if (Array.isArray(item["content"]) && item["content"].length > 0) kept["content"] = item["content"];
  return SIGNATURE_PREFIX + Buffer.from(JSON.stringify(kept), "utf8").toString("base64url");
}

/** Null for anything that cannot be replayed: another vendor's signature, or an item that came back with no encrypted content to stand for it. */
function unpackReasoning(signature: unknown): Json | null {
  if (typeof signature !== "string" || !signature.startsWith(SIGNATURE_PREFIX)) return null;
  const kept = parse(Buffer.from(signature.slice(SIGNATURE_PREFIX.length), "base64url").toString("utf8"));
  if (!isObject(kept) || typeof kept["id"] !== "string" || typeof kept["encrypted_content"] !== "string") return null;
  return {
    type: "reasoning",
    id: kept["id"],
    summary: Array.isArray(kept["summary"]) ? kept["summary"] : [],
    ...(Array.isArray(kept["content"]) ? { content: kept["content"] } : {}),
    encrypted_content: kept["encrypted_content"],
  };
}

function textsOf(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (!isObject(part)) return [];
    const text = typeof part["text"] === "string" ? part["text"] : part["refusal"];
    return typeof text === "string" ? [text] : [];
  });
}

function thoughtOf(item: Json): string {
  const summary = textsOf(item["summary"]);
  return (summary.length > 0 ? summary : textsOf(item["content"])).join("\n\n");
}

function callIdOf(item: Json): unknown {
  return typeof item["call_id"] === "string" ? item["call_id"] : item["id"];
}

function usageOf(response: Json): Json {
  const usage = isObject(response["usage"]) ? response["usage"] : {};
  const details = isObject(usage["input_tokens_details"]) ? usage["input_tokens_details"] : {};
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const read = count(details["cached_tokens"]);
  const written = count(details["cache_write_tokens"]);
  // Responses counts cached tokens inside its input; Messages counts them beside it.
  return {
    input_tokens: Math.max(0, count(usage["input_tokens"]) - read - written),
    cache_creation_input_tokens: written,
    cache_read_input_tokens: read,
    output_tokens: count(usage["output_tokens"]),
  };
}

function stopReasonOf(response: Json, called: boolean): string {
  const reason = isObject(response["incomplete_details"]) ? response["incomplete_details"]["reason"] : undefined;
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return called ? "tool_use" : "end_turn";
}

function failure(type: string, said: unknown, code: unknown, silent: string): Json {
  const words = typeof said === "string" && said.trim() !== "" ? said : silent;
  // The phrase a Messages client reads as the context being full.
  if (code === "context_length_exceeded") return { type: "error", error: { type: "invalid_request_error", message: `prompt is too long: ${words}` } };
  return { type: "error", error: { type, message: words } };
}

/** A failure told inside an answer, where there is a code and no status. */
function answerFailure(failed: Json): Json {
  const code = failed["code"];
  return failure((typeof code === "string" ? CODE_ERRORS.get(code) : undefined) ?? "api_error", failed["message"], code, SILENT);
}

function unknownItem(item: Json): Json {
  const sentence = `The provider answered with an item of type ${named(item["type"])}, which this conversation has no place for.`;
  return failure("invalid_request_error", sentence, undefined, SILENT);
}

function error(status: number, body: unknown): unknown {
  const inner = isObject(body) ? body["error"] : undefined;
  const said = isObject(inner) ? inner["message"] : typeof inner === "string" ? inner : isObject(body) ? body["message"] : undefined;
  const type = STATUS_ERRORS.get(status) ?? (status >= 500 ? "api_error" : "invalid_request_error");
  return failure(type, said, isObject(inner) ? inner["code"] : undefined, `The provider answered ${status} and did not say why.`);
}

function whole(status: number, body: unknown, context: TranslateContext): unknown {
  if (status >= 400) return error(status, body);
  if (!isObject(body) || !Array.isArray(body["output"])) return failure("api_error", "The provider's answer could not be read.", undefined, SILENT);
  if (body["status"] === "failed") return answerFailure(isObject(body["error"]) ? body["error"] : {});
  const content: Json[] = [];
  let called = false;
  for (const item of body["output"]) {
    if (!isObject(item)) continue;
    if (item["type"] === "reasoning") {
      content.push({ type: "thinking", thinking: thoughtOf(item), signature: packReasoning(item) });
    } else if (item["type"] === "message") {
      const text = textsOf(item["content"]).join("");
      if (text !== "") content.push({ type: "text", text });
    } else if (item["type"] === "function_call") {
      called = true;
      const input = parse(item["arguments"]);
      content.push({ type: "tool_use", id: callIdOf(item), name: item["name"], input: isObject(input) ? input : {} });
    } else {
      return unknownItem(item);
    }
  }
  return {
    id: typeof body["id"] === "string" ? body["id"] : "msg_gateway",
    type: "message",
    role: "assistant",
    model: context.model,
    content,
    stop_reason: stopReasonOf(body, called),
    stop_sequence: null,
    usage: usageOf(body),
  };
}

interface Block {
  /** The item this block stands for, as events name it: by its place in the output, by its id, or by both. */
  at: number | null;
  id: string | null;
  kind: "text" | "tool_use" | "thinking";
  /** Null until a text block has something to say: an empty one is refused when the conversation comes back. */
  index: number | null;
  /** A delta carried this block's body, so the finished item need not. */
  streamed: boolean;
  /** The reasoning summary part last heard from. */
  part: number | null;
}

function namedBy(data: Json): { at: number | null; id: string | null } {
  const item = data["item"];
  const id = typeof data["item_id"] === "string" ? data["item_id"] : isObject(item) && typeof item["id"] === "string" ? item["id"] : null;
  return { at: typeof data["output_index"] === "number" ? data["output_index"] : null, id };
}

function stream(context: TranslateContext): { push(event: SseEvent): SseEvent[]; end(): SseEvent[] } {
  let blocks: Block[] = [];
  let out: SseEvent[] = [];
  let started = false;
  let finished = false;
  let next = 0;
  let called = false;

  const emit = (type: string, fields: Json): void => {
    out.push({ event: type, data: JSON.stringify({ type, ...fields }) });
  };
  const delta = (index: number, fields: Json): void => emit("content_block_delta", { index, delta: fields });

  const start = (response: unknown): void => {
    if (started) return;
    started = true;
    emit("message_start", {
      message: {
        id: isObject(response) && typeof response["id"] === "string" ? response["id"] : "msg_gateway",
        type: "message",
        role: "assistant",
        model: context.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usageOf({}),
      },
    });
  };

  const fail = (failed: Json): void => {
    out.push({ event: "error", data: JSON.stringify(failed) });
    finished = true;
  };

  const find = (data: Json): Block | undefined => {
    const { at, id } = namedBy(data);
    if (at === null && id === null) return blocks.at(-1);
    return blocks.find((block) => (at !== null && block.at === at) || (id !== null && block.id === id));
  };

  const open = (data: Json, item: Json): Block | null => {
    const block: Block = { ...namedBy(data), kind: "text", index: null, streamed: false, part: null };
    if (item["type"] === "function_call") {
      block.kind = "tool_use";
      called = true;
    } else if (item["type"] === "reasoning") {
      block.kind = "thinking";
    } else if (item["type"] !== "message") {
      fail(unknownItem(item));
      return null;
    }
    if (block.kind !== "text") {
      block.index = next;
      next += 1;
      const content =
        block.kind === "tool_use"
          ? { type: "tool_use", id: callIdOf(item), name: item["name"], input: {} }
          : { type: "thinking", thinking: "", signature: "" };
      emit("content_block_start", { index: block.index, content_block: content });
    }
    blocks.push(block);
    return block;
  };

  const say = (block: Block, text: string): void => {
    if (block.index === null) {
      block.index = next;
      next += 1;
      emit("content_block_start", { index: block.index, content_block: { type: "text", text: "" } });
    }
    delta(block.index, { type: "text_delta", text });
  };

  const close = (block: Block, item: Json): void => {
    if (block.kind === "text" && block.index === null) {
      const text = textsOf(item["content"]).join("");
      if (text !== "") say(block, text);
    }
    const index = block.index;
    if (index === null) return;
    if (block.kind === "tool_use" && !block.streamed && typeof item["arguments"] === "string" && item["arguments"] !== "") {
      delta(index, { type: "input_json_delta", partial_json: item["arguments"] });
    }
    if (block.kind === "thinking") {
      // Always one, empty or not: the shape Messages itself streams for thinking it does not show.
      if (!block.streamed) delta(index, { type: "thinking_delta", thinking: thoughtOf(item) });
      delta(index, { type: "signature_delta", signature: packReasoning(item) });
    }
    emit("content_block_stop", { index });
  };

  const closeOpen = (): void => {
    const indices = blocks.flatMap((block) => (block.index === null ? [] : [block.index]));
    for (const index of indices.sort((a, b) => a - b)) emit("content_block_stop", { index });
    blocks = [];
  };

  const take = (type: string, data: Json): void => {
    switch (type) {
      case "response.created":
        start(data["response"]);
        return;
      case "response.output_item.added":
        if (!isObject(data["item"])) return;
        start(null);
        open(data, data["item"]);
        return;
      case "response.output_text.delta":
      case "response.refusal.delta": {
        if (typeof data["delta"] !== "string" || data["delta"] === "") return;
        start(null);
        const block = find(data) ?? open(data, { type: "message" });
        if (block?.kind === "text") say(block, data["delta"]);
        return;
      }
      case "response.function_call_arguments.delta": {
        const block = find(data);
        if (block?.kind !== "tool_use" || block.index === null || typeof data["delta"] !== "string") return;
        block.streamed = true;
        delta(block.index, { type: "input_json_delta", partial_json: data["delta"] });
        return;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const block = find(data);
        if (block?.kind !== "thinking" || block.index === null || typeof data["delta"] !== "string") return;
        const part = typeof data["summary_index"] === "number" ? data["summary_index"] : block.part;
        const gap = block.streamed && part !== block.part ? "\n\n" : "";
        block.part = part;
        block.streamed = true;
        delta(block.index, { type: "thinking_delta", thinking: gap + data["delta"] });
        return;
      }
      case "response.output_item.done": {
        if (!isObject(data["item"])) return;
        start(null);
        const block = find(data) ?? open(data, data["item"]);
        if (block === null) return;
        close(block, data["item"]);
        blocks = blocks.filter((other) => other !== block);
        return;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = isObject(data["response"]) ? data["response"] : {};
        start(response);
        closeOpen();
        emit("message_delta", { delta: { stop_reason: stopReasonOf(response, called), stop_sequence: null }, usage: usageOf(response) });
        emit("message_stop", {});
        finished = true;
        return;
      }
      case "response.failed": {
        const response = isObject(data["response"]) ? data["response"] : {};
        fail(answerFailure(isObject(response["error"]) ? response["error"] : {}));
        return;
      }
      case "error":
        // Documented flat; codex reads it nested, so some sender nests it.
        fail(answerFailure(isObject(data["error"]) ? data["error"] : data));
        return;
      default:
        return;
    }
  };

  return {
    push(event) {
      if (finished) return [];
      out = [];
      const data = parse(event.data);
      if (isObject(data)) take(typeof data["type"] === "string" ? data["type"] : (event.event ?? ""), data);
      return out;
    },
    end() {
      if (finished) return [];
      finished = true;
      out = [];
      // Blocks are closed and nothing more: with no message_stop the harness reads a cut, which is what happened.
      closeOpen();
      return out;
    },
  };
}

export const messagesToResponses: Translator = {
  inbound: "anthropic-messages",
  outbound: "openai-responses",
  request,
  whole,
  stream,
  error,
};
