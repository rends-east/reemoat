import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** A loopback stand-in for a model endpoint: records what a harness sends and answers in the protocol it asked in. */

export type ProbeProtocol = "messages" | "responses" | "chat";
export type RequestKind = ProbeProtocol | "count_tokens" | "models" | "upgrade" | "other";

export type Step =
  | { kind: "text" }
  | { kind: "thinking" }
  | { kind: "error"; status: number }
  | { kind: "cut" }
  | { kind: "silent"; seconds: number; ping: boolean };

export interface Recorded {
  n: number;
  atMs: number;
  method: string;
  path: string;
  kind: RequestKind;
  headers: Record<string, string>;
  body: unknown;
  bodyBytes: number;
  /** What the recorder did with it, in words. */
  answered: string;
  /** Whether the opaque reasoning blob handed out earlier came back, and whether it came back whole. */
  blob: "absent" | "identical" | "altered";
  /** The harness hung up before the answer was complete. */
  clientClosedEarly: boolean;
}

export interface RecorderOptions {
  /** One step per inference request, in arrival order; the last repeats. */
  script: readonly Step[];
  /** The credential this probe handed the harness, so anything else on the wire is named as foreign. */
  bearer: string;
  blobBytes: number;
  countTokens: "ok" | "404";
  /** Full request bodies are written here; they hold vendor prompts, so never under the repository. */
  dumpDir: string | null;
}

export interface Recorder {
  baseUrl: string;
  port: number;
  requests: Recorded[];
  blob: string;
  close(): Promise<void>;
}

const BLOB_MARK = "PROBEBLOB";

/** Step grammar: text | thinking | error:<status> | cut | silent:<seconds>[:ping], each optionally *<count>. */
export function parseScript(spec: string): Step[] {
  const steps: Step[] = [];
  for (const raw of spec.split(",")) {
    const [word = "", times = "1"] = raw.trim().split("*");
    const count = Number(times);
    if (!Number.isInteger(count) || count < 1) throw new Error(`bad repeat in "${raw}"`);
    const [name = "", a, b] = word.split(":");
    let step: Step;
    if (name === "text") step = { kind: "text" };
    else if (name === "thinking") step = { kind: "thinking" };
    else if (name === "cut") step = { kind: "cut" };
    else if (name === "error") {
      const status = Number(a);
      if (!Number.isInteger(status) || status < 400 || status > 599) throw new Error(`bad status in "${raw}"`);
      step = { kind: "error", status };
    } else if (name === "silent") {
      const seconds = Number(a);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`bad seconds in "${raw}"`);
      step = { kind: "silent", seconds, ping: b === "ping" };
    } else throw new Error(`unknown step "${raw}"`);
    for (let i = 0; i < count; i += 1) steps.push(step);
  }
  if (steps.length === 0) throw new Error("empty script");
  return steps;
}

export function makeBlob(bytes: number): string {
  // Deterministic and base64-shaped, so a harness that validates the field's alphabet still carries it.
  const body = createHash("sha256").update("doorprobe").digest("base64").replace(/[^A-Za-z0-9]/g, "");
  let out = BLOB_MARK;
  while (out.length < bytes) out += body;
  return out.slice(0, Math.max(bytes, BLOB_MARK.length));
}

export async function startRecorder(options: RecorderOptions): Promise<Recorder> {
  const startedAt = Date.now();
  const requests: Recorded[] = [];
  const blob = makeBlob(options.blobBytes);
  let inference = 0;
  if (options.dumpDir !== null) mkdirSync(options.dumpDir, { recursive: true });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString("utf8");
      const path = req.url ?? "/";
      const kind = classify(req.method ?? "GET", path);
      const entry: Recorded = {
        n: requests.length + 1,
        atMs: Date.now() - startedAt,
        method: req.method ?? "GET",
        path,
        kind,
        headers: maskHeaders(req, options.bearer),
        body: parseJson(text),
        bodyBytes: raw.length,
        answered: "",
        blob: blobState(text, blob),
        clientClosedEarly: false,
      };
      requests.push(entry);
      res.on("close", () => {
        if (!res.writableFinished) entry.clientClosedEarly = true;
      });
      if (options.dumpDir !== null) {
        const name = `${String(entry.n).padStart(3, "0")}-${kind}.json`;
        writeFileSync(join(options.dumpDir, name), text.length > 0 ? text : "{}");
      }
      if (kind === "messages" || kind === "responses" || kind === "chat") {
        const step = options.script[Math.min(inference, options.script.length - 1)] ?? { kind: "text" };
        inference += 1;
        entry.answered = describeStep(step);
        answerInference(res, kind, step, entry.body, blob);
        return;
      }
      if (kind === "count_tokens") {
        if (options.countTokens === "404") {
          entry.answered = "404";
          sendJson(res, 404, errorBody("messages", 404));
        } else {
          entry.answered = "200 input_tokens";
          sendJson(res, 200, { input_tokens: 42 });
        }
        return;
      }
      if (kind === "models") {
        entry.answered = "200 model list";
        sendJson(res, 200, modelList(req, modelOf(entry.body)));
        return;
      }
      entry.answered = "404 no such route";
      sendJson(res, 404, { error: { message: "doorprobe: no such route", type: "not_found" } });
    });
  });

  server.on("upgrade", (req, socket) => {
    requests.push({
      n: requests.length + 1,
      atMs: Date.now() - startedAt,
      method: req.method ?? "GET",
      path: req.url ?? "/",
      kind: "upgrade",
      headers: maskHeaders(req, options.bearer),
      body: null,
      bodyBytes: 0,
      answered: "socket destroyed (no websocket here)",
      blob: "absent",
      clientClosedEarly: false,
    });
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    blob,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function classify(method: string, path: string): RequestKind {
  const bare = path.split("?")[0] ?? path;
  if (bare.endsWith("/messages/count_tokens")) return "count_tokens";
  if (method === "POST" && bare.endsWith("/messages")) return "messages";
  if (method === "POST" && bare.endsWith("/responses")) return "responses";
  if (method === "POST" && bare.endsWith("/chat/completions")) return "chat";
  if (method === "GET" && bare.endsWith("/models")) return "models";
  return "other";
}

const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "cookie",
  "chatgpt-account-id",
  "openai-organization",
  "openai-project",
  "x-goog-api-key",
]);

/** A credential is reported by its shape and whether it is the probe's own; its value never leaves this function. */
function maskHeaders(req: IncomingMessage, bearer: string): Record<string, string> {
  const out: Record<string, string> = {};
  // rawHeaders, not headers: node keeps only the first of two authorization lines, and which one a harness sends first is the measurement.
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = (req.rawHeaders[i] ?? "").toLowerCase();
    const value = req.rawHeaders[i + 1] ?? "";
    let shown: string;
    if (CREDENTIAL_HEADERS.has(name)) {
      const scheme = /^(Bearer|Basic)\s/i.exec(value)?.[1] ?? "";
      const secret = scheme === "" ? value : value.slice(scheme.length + 1);
      const whose = secret === bearer ? "the probe's own" : "FOREIGN";
      const digest = createHash("sha256").update(secret).digest("hex").slice(0, 8);
      shown = `${scheme === "" ? "" : `${scheme} `}‹${whose}, ${secret.length} chars, sha256 ${digest}›`;
    } else {
      shown = value.includes(bearer) ? value.split(bearer).join("‹probe bearer›") : value;
    }
    out[name] = Object.hasOwn(out, name) ? `${out[name]} ‖ ${shown}` : shown;
  }
  return out;
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function blobState(text: string, blob: string): Recorded["blob"] {
  if (!text.includes(BLOB_MARK)) return "absent";
  return text.includes(blob) ? "identical" : "altered";
}

function modelOf(body: unknown): string {
  const model = (body as { model?: unknown } | null)?.model;
  return typeof model === "string" && model.length > 0 ? model : "probe-model";
}

function wantsStream(body: unknown): boolean {
  return (body as { stream?: unknown } | null)?.stream === true;
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "text":
      return "200 text";
    case "thinking":
      return "200 reasoning + text";
    case "error":
      return `${step.status} error`;
    case "cut":
      return "200, stream cut mid-answer";
    case "silent":
      return `200 after ${step.seconds}s of silence${step.ping ? " with pings" : ""}`;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function modelList(req: IncomingMessage, model: string): unknown {
  if (req.headers["anthropic-version"] !== undefined) {
    return {
      data: [{ type: "model", id: model, display_name: model, created_at: "2026-01-01T00:00:00Z" }],
      has_more: false,
      first_id: model,
      last_id: model,
    };
  }
  return { object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "doorprobe" }] };
}

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

function errorBody(protocol: ProbeProtocol, status: number): unknown {
  const type = ERROR_TYPES[status] ?? "api_error";
  const message = `doorprobe canned ${status}`;
  if (protocol === "messages") return { type: "error", error: { type, message } };
  return { error: { message, type, code: type } };
}

function answerInference(res: ServerResponse, protocol: ProbeProtocol, step: Step, body: unknown, blob: string): void {
  if (step.kind === "error") {
    sendJson(res, step.status, errorBody(protocol, step.status));
    return;
  }
  const model = modelOf(body);
  const thinking = step.kind === "thinking";
  if (!wantsStream(body)) {
    sendJson(res, 200, wholeAnswer(protocol, model, thinking, blob));
    return;
  }
  const events = streamAnswer(protocol, model, thinking, blob);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  if (step.kind === "cut") {
    for (const event of events.slice(0, Math.max(1, Math.floor(events.length / 2)))) res.write(event);
    setTimeout(() => res.destroy(), 50);
    return;
  }
  if (step.kind === "silent") {
    const pinger = step.ping ? setInterval(() => res.write(pingEvent(protocol)), 5_000) : null;
    setTimeout(() => {
      if (pinger !== null) clearInterval(pinger);
      for (const event of events) res.write(event);
      res.end();
    }, step.seconds * 1000);
    return;
  }
  for (const event of events) res.write(event);
  res.end();
}

const ANSWER = "probe-ok";
const THOUGHT = "probe reasoning";

function sse(event: string | null, data: unknown): string {
  return `${event === null ? "" : `event: ${event}\n`}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function pingEvent(protocol: ProbeProtocol): string {
  return protocol === "messages" ? sse("ping", { type: "ping" }) : ": ping\n\n";
}

function wholeAnswer(protocol: ProbeProtocol, model: string, thinking: boolean, blob: string): unknown {
  if (protocol === "messages") {
    return {
      id: "msg_doorprobe",
      type: "message",
      role: "assistant",
      model,
      content: [
        ...(thinking ? [{ type: "thinking", thinking: THOUGHT, signature: blob }] : []),
        { type: "text", text: ANSWER },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  if (protocol === "responses") return responseObject(model, "completed", responseOutput(thinking, blob));
  return {
    id: "chatcmpl-doorprobe",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: ANSWER, ...(thinking ? { reasoning_content: THOUGHT } : {}) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function responseOutput(thinking: boolean, blob: string): unknown[] {
  return [
    ...(thinking
      ? [
          {
            id: "rs_doorprobe",
            type: "reasoning",
            summary: [{ type: "summary_text", text: THOUGHT }],
            encrypted_content: blob,
          },
        ]
      : []),
    {
      id: "msg_doorprobe",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: ANSWER, annotations: [] }],
    },
  ];
}

function responseObject(model: string, status: string, output: unknown[]): unknown {
  return {
    id: "resp_doorprobe",
    object: "response",
    created_at: 0,
    status,
    model,
    output,
    usage:
      status === "completed"
        ? {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 15,
          }
        : null,
  };
}

function streamAnswer(protocol: ProbeProtocol, model: string, thinking: boolean, blob: string): string[] {
  if (protocol === "messages") return messagesStream(model, thinking, blob);
  if (protocol === "responses") return responsesStream(model, thinking, blob);
  return chatStream(model, thinking);
}

function messagesStream(model: string, thinking: boolean, blob: string): string[] {
  const out: string[] = [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_doorprobe",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  ];
  let index = 0;
  if (thinking) {
    out.push(
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: THOUGHT },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: blob },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    );
    index += 1;
  }
  out.push(
    sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }),
    sse("ping", { type: "ping" }),
    sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: ANSWER } }),
    sse("content_block_stop", { type: "content_block_stop", index }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sse("message_stop", { type: "message_stop" }),
  );
  return out;
}

function responsesStream(model: string, thinking: boolean, blob: string): string[] {
  const output = responseOutput(thinking, blob);
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>): string => {
    const text = sse(type, { type, sequence_number: sequence, ...fields });
    sequence += 1;
    return text;
  };
  const out: string[] = [
    event("response.created", { response: responseObject(model, "in_progress", []) }),
    event("response.in_progress", { response: responseObject(model, "in_progress", []) }),
  ];
  output.forEach((item, outputIndex) => {
    const typed = item as { id: string; type: string };
    if (typed.type === "reasoning") {
      out.push(
        event("response.output_item.added", {
          output_index: outputIndex,
          item: { id: typed.id, type: "reasoning", summary: [] },
        }),
        event("response.output_item.done", { output_index: outputIndex, item }),
      );
      return;
    }
    out.push(
      event("response.output_item.added", {
        output_index: outputIndex,
        item: { id: typed.id, type: "message", status: "in_progress", role: "assistant", content: [] },
      }),
      event("response.content_part.added", {
        item_id: typed.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
      event("response.output_text.delta", {
        item_id: typed.id,
        output_index: outputIndex,
        content_index: 0,
        delta: ANSWER,
      }),
      event("response.output_text.done", {
        item_id: typed.id,
        output_index: outputIndex,
        content_index: 0,
        text: ANSWER,
      }),
      event("response.content_part.done", {
        item_id: typed.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: ANSWER, annotations: [] },
      }),
      event("response.output_item.done", { output_index: outputIndex, item }),
    );
  });
  out.push(event("response.completed", { response: responseObject(model, "completed", output) }));
  return out;
}

function chatStream(model: string, thinking: boolean): string[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    sse(null, {
      id: "chatcmpl-doorprobe",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  return [
    chunk({ role: "assistant", content: "" }, null),
    ...(thinking ? [chunk({ reasoning_content: THOUGHT }, null)] : []),
    chunk({ content: ANSWER }, null),
    chunk({}, "stop"),
    sse(null, {
      id: "chatcmpl-doorprobe",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    sse(null, "[DONE]"),
  ];
}

/** What one request said, in the fields a door decision turns on; prose is counted, never printed. */
export function summarise(entry: Recorded): string[] {
  const lines: string[] = [];
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const has = (key: string): boolean => Object.hasOwn(body, key);
  const flag = (key: string): string => (has(key) ? `${key}=${JSON.stringify(body[key])}` : "");
  if (entry.kind === "messages") {
    lines.push(
      [flag("model"), flag("stream"), flag("max_tokens"), flag("thinking"), flag("output_config")]
        .filter((part) => part !== "")
        .join(" "),
    );
    lines.push(`system: ${proseShape(body["system"])}`);
    lines.push(`tools: ${toolShape(body["tools"])}`);
    lines.push(`messages: ${itemShape(body["messages"])}`);
  } else if (entry.kind === "responses") {
    lines.push(
      [
        flag("model"),
        flag("stream"),
        flag("store"),
        flag("include"),
        flag("reasoning"),
        flag("previous_response_id"),
        flag("max_output_tokens"),
        flag("prompt_cache_key"),
        flag("parallel_tool_calls"),
        flag("tool_choice"),
        flag("service_tier"),
      ]
        .filter((part) => part !== "")
        .join(" "),
    );
    lines.push(`instructions: ${proseShape(body["instructions"])}`);
    lines.push(`tools: ${toolShape(body["tools"])}`);
    lines.push(`input: ${itemShape(body["input"])}`);
  } else if (entry.kind === "chat") {
    lines.push(
      [flag("model"), flag("stream"), flag("max_tokens"), flag("max_completion_tokens"), flag("reasoning_effort"), flag("stream_options")]
        .filter((part) => part !== "")
        .join(" "),
    );
    lines.push(`tools: ${toolShape(body["tools"])}`);
    lines.push(`messages: ${itemShape(body["messages"])}`);
  } else if (entry.body !== null) {
    lines.push(`keys: ${Object.keys(body).join(", ")}`);
  }
  const other = Object.keys(body).filter((key) => !KNOWN_KEYS.has(key));
  if (other.length > 0) lines.push(`other keys: ${other.join(", ")}`);
  return lines.filter((line) => line.trim() !== "");
}

const KNOWN_KEYS = new Set([
  "model",
  "stream",
  "max_tokens",
  "thinking",
  "output_config",
  "system",
  "tools",
  "messages",
  "store",
  "include",
  "reasoning",
  "previous_response_id",
  "max_output_tokens",
  "prompt_cache_key",
  "parallel_tool_calls",
  "tool_choice",
  "service_tier",
  "instructions",
  "input",
  "max_completion_tokens",
  "reasoning_effort",
  "stream_options",
]);

function proseShape(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "string") return `string, ${value.length} chars`;
  if (!Array.isArray(value)) return typeof value;
  const chars = value.reduce<number>((sum, block) => {
    const text = (block as { text?: unknown } | null)?.text;
    return sum + (typeof text === "string" ? text.length : 0);
  }, 0);
  const cached = value.filter((block) => (block as { cache_control?: unknown } | null)?.cache_control != null).length;
  return `${value.length} blocks, ${chars} chars, ${cached} with cache_control`;
}

function toolShape(value: unknown): string {
  if (!Array.isArray(value)) return value === undefined ? "absent" : typeof value;
  const names = value.map((tool) => {
    const one = (tool ?? {}) as { name?: unknown; type?: unknown; function?: { name?: unknown } };
    const name = typeof one.name === "string" ? one.name : typeof one.function?.name === "string" ? one.function.name : "";
    const type = typeof one.type === "string" ? one.type : "";
    return name === "" ? `‹${type}›` : type === "" || type === "function" || type === "custom" ? name : `${name}‹${type}›`;
  });
  const shown = names.slice(0, 40).join(", ");
  return `${value.length}: ${shown}${names.length > 40 ? ", …" : ""}`;
}

function itemShape(value: unknown): string {
  if (typeof value === "string") return `string, ${value.length} chars`;
  if (!Array.isArray(value)) return value === undefined ? "absent" : typeof value;
  const parts = value.map((item) => {
    const one = (item ?? {}) as { role?: unknown; type?: unknown; content?: unknown };
    const head = typeof one.role === "string" ? one.role : typeof one.type === "string" ? one.type : "?";
    if (!Array.isArray(one.content)) return head;
    const kinds = one.content.map((block) => {
      const typed = (block ?? {}) as { type?: unknown; cache_control?: unknown };
      return `${typeof typed.type === "string" ? typed.type : "?"}${typed.cache_control != null ? "*" : ""}`;
    });
    return `${head}[${kinds.join(",")}]`;
  });
  return `${value.length}: ${parts.join(" ")}`;
}
