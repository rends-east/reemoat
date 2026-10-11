import { readdirSync, readFileSync } from "node:fs";
import { encodeSse, sseDecoder } from "../src/gateway/sse.js";
import { messagesToResponses } from "../src/gateway/translate/messages-to-responses.js";
import type { SseEvent } from "../src/gateway/translate/types.js";

// The translating half of gatewaycheck: Anthropic Messages in, OpenAI Responses out, against the vectors in vectors/gateway.

type Check = (name: string, got: unknown, want: unknown) => void;
type Json = Record<string, unknown>;

/** An event with its data parsed, which is how a vector holds one. */
interface Wire {
  event: string | null;
  data: Json;
}

interface Vector {
  file: string;
  kind: string;
  about: string;
  model: string;
  messages: unknown;
  responses: unknown;
  cases?: { about: string; messages: unknown; untranslatable: string }[];
  accepted?: Wire[];
}

const VECTORS = new URL("../vectors/gateway/", import.meta.url);
const MODEL = "probe-model";
const translator = messagesToResponses;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key order is nobody's contract, so a vector may be written in any. */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canon(value[key])]),
  );
}

function sent(event: Wire): SseEvent {
  return { event: event.event, data: JSON.stringify(event.data) };
}

function read(event: SseEvent): Wire {
  return { event: event.event, data: JSON.parse(event.data) as Json };
}

/** Every event pushed and then the end, which is all a caller ever does. */
function translated(events: Wire[], model = MODEL): Wire[] {
  const one = translator.stream({ model });
  const out = events.flatMap((event) => one.push(sent(event)));
  out.push(...one.end());
  return out.map(read);
}

/** The same answer as bytes off a socket, one at a time. */
function overTheWire(events: Wire[], newline: string, model = MODEL): Wire[] {
  const text = events.map((event) => encodeSse(sent(event))).join("");
  const decoder = sseDecoder();
  const one = translator.stream({ model });
  const out: SseEvent[] = [];
  for (const byte of Buffer.from(text.replaceAll("\n", newline), "utf8")) {
    for (const event of decoder.push(Uint8Array.of(byte))) out.push(...one.push(event));
  }
  out.push(...one.end());
  return out.map(read);
}

function decoded(chunks: (string | Uint8Array)[]): SseEvent[] {
  const decoder = sseDecoder();
  return chunks.flatMap((chunk) => decoder.push(chunk));
}

/** What a harness's parser turns on: which event, which block, which kind of delta. Pings and values are left out. */
function shape(events: Wire[]): string[] {
  return events
    .filter((event) => event.event !== "ping")
    .map((event) => {
      const { data } = event;
      const block = isObject(data["content_block"]) ? data["content_block"] : {};
      const delta = isObject(data["delta"]) ? data["delta"] : {};
      const keys = Object.keys(isObject(data["message"]) ? data["message"] : data).sort().join(",");
      const detail = event.event === "message_delta" ? delta["stop_reason"] : (block["type"] ?? delta["type"]);
      return `${[event.event, data["index"], detail].filter((part) => part !== undefined).join(" ")} {${keys}}`;
    });
}

/** The shape without each event's keys, for a sequence written out by hand. */
function outline(events: Wire[]): string[] {
  return shape(events).map((line) => line.slice(0, line.indexOf(" {")));
}

function deltasOf(events: Wire[], type: string, field: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const event of events) {
    const delta = event.data["delta"];
    if (event.event !== "content_block_delta" || !isObject(delta) || delta["type"] !== type) continue;
    const index = Number(event.data["index"]);
    out.set(index, [...(out.get(index) ?? []), String(delta[field])]);
  }
  return out;
}

function stopOf(events: Wire[]): unknown {
  const last = events.find((event) => event.event === "message_delta")?.data["delta"];
  return isObject(last) ? last["stop_reason"] : null;
}

function inputOf(result: { body: unknown } | { untranslatable: string }): Json[] {
  const body = "body" in result && isObject(result.body) ? result.body : {};
  return Array.isArray(body["input"]) ? (body["input"] as Json[]) : [];
}

function response(status: string, output: Json[], extra: Json = {}): Json {
  return { id: "resp_1", object: "response", created_at: 0, status, model: MODEL, output, usage: null, ...extra };
}

function event(type: string, fields: Json): Wire {
  return { event: type, data: { type, ...fields } };
}

function textAnswer(last: Wire): Wire[] {
  const item = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [] }] };
  return [
    event("response.created", { response: response("in_progress", []) }),
    event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
    event("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" }),
    event("response.output_item.done", { output_index: 0, item }),
    last,
  ];
}

function reasoningAnswer(item: Json): Wire[] {
  return [
    event("response.created", { response: response("in_progress", []) }),
    event("response.output_item.added", { output_index: 0, item: { id: item["id"], type: "reasoning", summary: [] } }),
    event("response.output_item.done", { output_index: 0, item }),
    event("response.completed", { response: response("completed", [item]) }),
  ];
}

function nextTurn(signature: unknown): Json {
  return {
    model: MODEL,
    max_tokens: 1,
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature }, { type: "text", text: "two" }] },
      { role: "user", content: "three" },
    ],
  };
}

export async function translationChecks(check: Check): Promise<void> {
  const vectors = readdirSync(VECTORS)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((file) => ({ ...(JSON.parse(readFileSync(new URL(file, VECTORS), "utf8")) as Omit<Vector, "file">), file }));
  const ofKind = (kind: string): Vector[] => vectors.filter((vector) => vector.kind === kind);
  const streams = ofKind("stream").map((vector) => ({ ...vector, responses: vector.responses as Wire[], messages: vector.messages as Wire[] }));

  process.stdout.write("\nan event stream, decoded and encoded\n");
  {
    check("an event is its name and its data", decoded(["event: a\ndata: 1\n\n"]), [{ event: "a", data: "1" }]);
    check("data over several lines is one value, and an event with no name has none", decoded(["data: a\ndata: b\n\n"]), [{ event: null, data: "a\nb" }]);
    check(
      "a comment, an id and a retry are not events, and a name with no data is not dispatched",
      decoded([": ping\n\nid: 7\nretry: 5\nevent: lonely\n\ndata: x\n\n"]),
      [{ event: null, data: "x" }],
    );
    check(
      "lines end in LF, CRLF or a bare CR",
      [decoded(["event: a\r\ndata: 1\r\n\r\n"]), decoded(["event: a\rdata: 1\r\r"]), decoded(["event: a\r", "\ndata: 1\r", "\n\r", "\n"])],
      [[{ event: "a", data: "1" }], [{ event: "a", data: "1" }], [{ event: "a", data: "1" }]],
    );
    check(
      "one space after the colon is the separator, a second is the value's, and a bare field is empty",
      decoded(["data:x\n\ndata:  y\n\ndata\n\n"]),
      [{ event: null, data: "x" }, { event: null, data: " y" }, { event: null, data: "" }],
    );
    check("an event the stream ended inside is never dispatched", decoded(["data: whole\n\nevent: cut\ndata: half\n"]), [{ event: null, data: "whole" }]);
    check("a byte-order mark is not part of the first field", [decoded(["﻿data: 1\n\n"]), decoded([Buffer.from("﻿data: 1\n\n", "utf8")])], [
      [{ event: null, data: "1" }],
      [{ event: null, data: "1" }],
    ]);

    const text = "event: one\r\ndata: {\"a\":\"é日本🙂\"}\r\n\r\n: keep-alive\n\ndata: first\ndata: second\n\nevent: three\rdata: 3\r\r";
    const bytes = Buffer.from(text, "utf8");
    const whole = decoded([text]);
    check("a mixed stream decodes to its three events", whole, [
      { event: "one", data: '{"a":"é日本🙂"}' },
      { event: null, data: "first\nsecond" },
      { event: "three", data: "3" },
    ]);
    check("fed one byte at a time it is the same, a character split across chunks included", decoded([...bytes].map((byte) => Uint8Array.of(byte))), whole);
    const splits = [...bytes.keys()].filter((at) => JSON.stringify(decoded([bytes.subarray(0, at), bytes.subarray(at)])) !== JSON.stringify(whole));
    check("and the same cut in two at every byte", splits, []);

    const multiline = { event: "x", data: "a\nb\r\nc" };
    check("an encoded event keeps each line of its data in a field of its own", encodeSse(multiline), "event: x\ndata: a\ndata: b\ndata: c\n\n");
    check("and what is encoded decodes to itself", decoded(whole.map(encodeSse)), whole);
  }

  process.stdout.write("\nMessages to Responses: what is asked\n");
  {
    check("the translator says which way it goes", [translator.inbound, translator.outbound], ["anthropic-messages", "openai-responses"]);
    check("there are vectors of every kind", [ofKind("request").length > 0, ofKind("refusals").length > 0, streams.length > 0], [true, true, true]);
    check("and none of a kind nobody reads", vectors.filter((vector) => !["request", "refusals", "stream"].includes(vector.kind)).map((vector) => vector.file), []);

    for (const vector of ofKind("request")) {
      check(`${vector.file}: ${vector.about}`, canon(translator.request(vector.messages, { model: vector.model })), canon({ body: vector.responses }));
    }

    const turn = ofKind("request").find((vector) => vector.file === "request-claude-turn.txt");
    const asked = isObject(turn?.messages) ? turn.messages : {};
    const result = translator.request(asked, { model: MODEL });
    const out = "body" in result && isObject(result.body) ? result.body : {};
    const text = JSON.stringify(out);
    check(
      "a recorded turn keeps every tool, and nothing of Anthropic's bookkeeping crosses",
      [(out["tools"] as unknown[]).length, text.includes("cache_control"), text.includes("billing"), text.includes("device_id"), "metadata" in out, "context_management" in out],
      [(asked["tools"] as unknown[]).length, false, false, false, false, false],
    );
    check(
      "the system message inside the conversation becomes a developer item where it stood",
      (out["input"] as Json[]).map((item) => item["role"]),
      ["user", "developer"],
    );
    check("its cache key is 64 characters that are not the harness's ids", /^[0-9a-f]{64}$/.test(String(out["prompt_cache_key"])), true);

    const effort = (body: Json): unknown => {
      const result = translator.request({ model: MODEL, messages: [], ...body }, { model: MODEL });
      return "body" in result && isObject(result.body) ? (result.body["reasoning"] ?? null) : result;
    };
    check(
      "effort is the harness's own word where it names one, medium where it only asks for thinking, and absent otherwise",
      [
        effort({ output_config: { effort: "low" }, thinking: { type: "adaptive" } }),
        effort({ output_config: { effort: "max" } }),
        effort({ thinking: { type: "enabled", budget_tokens: 1024 } }),
        effort({ thinking: { type: "adaptive" } }),
        effort({ thinking: { type: "disabled" } }),
        effort({}),
        effort({ output_config: { effort: "unheard-of" } }),
      ],
      [
        { effort: "low", summary: "auto" },
        { effort: "max", summary: "auto" },
        { effort: "medium", summary: "auto" },
        { effort: "medium", summary: "auto" },
        null,
        null,
        null,
      ],
    );

    const choice = (tool_choice: Json): unknown => {
      const tools = [{ name: "Read", input_schema: { type: "object" } }];
      const result = translator.request({ model: MODEL, messages: [], tools, tool_choice }, { model: MODEL });
      const body = "body" in result && isObject(result.body) ? result.body : {};
      return [body["tool_choice"], body["parallel_tool_calls"] ?? null];
    };
    check(
      "each way of choosing a tool has its counterpart",
      [choice({ type: "auto" }), choice({ type: "any" }), choice({ type: "none" }), choice({ type: "tool", name: "Read" }), choice({ type: "any", disable_parallel_tool_use: true })],
      [["auto", null], ["required", null], ["none", null], [{ type: "function", name: "Read" }, null], ["required", false]],
    );
    const serverOnly = translator.request(
      { model: MODEL, messages: [], tools: [{ type: "web_search_20250305", name: "web_search" }], tool_choice: { type: "auto" } },
      { model: MODEL },
    );
    check(
      "a list holding only another vendor's server tool is no list, and nothing is chosen from it",
      "body" in serverOnly && isObject(serverOnly.body) ? ["tools" in serverOnly.body, "tool_choice" in serverOnly.body] : serverOnly,
      [false, false],
    );
    const plain = translator.request({ model: MODEL, max_tokens: 5, system: "be brief", messages: [{ role: "user", content: "hi" }] }, { model: "held" });
    check("a body of strings is carried as one of blocks would be, never stored, and streamed only when asked", canon(plain), canon({
      body: {
        model: MODEL,
        instructions: "be brief",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 5,
        store: false,
        stream: false,
      },
    }));
  }

  process.stdout.write("\nwhat cannot be carried, as a sentence\n");
  {
    for (const vector of ofKind("refusals")) {
      for (const one of vector.cases ?? []) {
        check(one.about, translator.request(one.messages, { model: vector.model }), { untranslatable: one.untranslatable });
      }
    }
    const long = translator.request({ model: MODEL, messages: [{ role: "user", content: [{ type: "x".repeat(500) }] }] }, { model: MODEL });
    check("a name off the wire is bounded before it reaches a transcript", "untranslatable" in long && long.untranslatable.length < 200, true);
  }

  process.stdout.write("\nResponses to Messages: an answer as it streams\n");
  {
    for (const vector of streams) {
      const whole = translated(vector.responses, vector.model);
      check(`${vector.file}: ${vector.about}`, canon(whole), canon(vector.messages));
      check(
        `${vector.file}: the same one byte at a time, under LF and under CRLF`,
        [canon(overTheWire(vector.responses, "\n", vector.model)), canon(overTheWire(vector.responses, "\r\n", vector.model))],
        [canon(whole), canon(whole)],
      );
      if (vector.accepted === undefined) continue;
      check(`${vector.file}: in shape, the stream Claude Code accepted from the recorder`, shape(whole), shape(vector.accepted));
      check(
        `${vector.file}: and in words`,
        [deltasOf(whole, "text_delta", "text"), deltasOf(whole, "thinking_delta", "thinking")].map((deltas) => [...deltas.values()]),
        [deltasOf(vector.accepted, "text_delta", "text"), deltasOf(vector.accepted, "thinking_delta", "thinking")].map((deltas) => [...deltas.values()]),
      );
    }

    const calls = streams.find((vector) => vector.file === "stream-tool-calls.txt");
    const pieces = deltasOf(calls?.messages ?? [], "input_json_delta", "partial_json");
    check(
      "arguments split across deltas arrive in as many pieces and join to the call's own JSON",
      [pieces.get(1)?.length, JSON.parse((pieces.get(1) ?? []).join("")), JSON.parse((pieces.get(2) ?? []).join(""))],
      [3, { path: "a.txt", limit: 10 }, { command: "ls" }],
    );

    const quiet = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "all at once", annotations: [] }] };
    const atOnce = translated([
      event("response.created", { response: response("in_progress", []) }),
      event("response.output_item.done", { output_index: 0, item: quiet }),
      event("response.output_item.done", { output_index: 1, item: { ...quiet, id: "msg_2", content: [] } }),
      event("response.completed", { response: response("completed", [quiet]) }),
    ]);
    check(
      "an item that arrives only finished still says what it held, and one that held nothing opens no block",
      outline(atOnce),
      ["message_start", "content_block_start 0 text", "content_block_delta 0 text_delta", "content_block_stop 0", "message_delta end_turn", "message_stop"],
    );
    const byIdOnly = translated([
      event("response.created", { response: response("in_progress", []) }),
      event("response.output_item.added", { output_index: 0, item: { ...quiet, status: "in_progress", content: [] } }),
      event("response.output_text.delta", { item_id: "msg_1", delta: "all at " }),
      event("response.output_text.delta", { output_index: 0, delta: "once" }),
      event("response.output_item.done", { item: quiet }),
      event("response.completed", { response: response("completed", [quiet]) }),
    ]);
    check(
      "an item named by its place in one event and by its id in the next is one block, said once",
      [outline(byIdOnly).filter((line) => line.startsWith("content_block_start")).length, [...deltasOf(byIdOnly, "text_delta", "text").values()]],
      [1, [["all at ", "once"]]],
    );
    check("a stream that never came emits nothing", translated([]), []);
  }

  process.stdout.write("\nreasoning rides the conversation\n");
  {
    const blob = `PROBEBLOB${"Hw0+/=".repeat(3000)}`.slice(0, 16384);
    const item = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "why" }], encrypted_content: blob, status: "completed" };
    const signature = deltasOf(translated(reasoningAnswer(item)), "signature_delta", "signature").get(0)?.[0];
    check("a reasoning item is packed into the thinking block's signature under this module's mark", signature?.startsWith("rmr1."), true);

    const back = inputOf(translator.request(nextTurn(signature), { model: MODEL }));
    const again = back.find((entry) => entry["type"] === "reasoning");
    check("and comes back as the item it was, in place", canon(back.map((entry) => entry["type"] === "reasoning" ? entry : entry["role"])), canon([
      "user",
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "why" }], encrypted_content: blob },
      "assistant",
      "user",
    ]));
    check("with 16 KiB of opaque content byte for byte", [again?.["encrypted_content"] === blob, String(again?.["encrypted_content"]).length], [true, 16384]);

    const answered = translator.whole(200, response("completed", [item]), { model: MODEL });
    const block = isObject(answered) && Array.isArray(answered["content"]) ? (answered["content"][0] as Json) : {};
    check("an answer that was not streamed packs the same signature", block["signature"], signature);

    const silent = translated(reasoningAnswer({ ...item, summary: [] }));
    check(
      "reasoning with no summary is still a thinking block: one empty delta, then the signature",
      outline(silent).slice(1, 5),
      ["content_block_start 0 thinking", "content_block_delta 0 thinking_delta", "content_block_delta 0 signature_delta", "content_block_stop 0"],
    );

    const kinds = (signed: unknown): unknown[] => inputOf(translator.request(nextTurn(signed), { model: MODEL })).map((entry) => entry["type"]);
    const unsigned = deltasOf(translated(reasoningAnswer({ id: "rs_2", type: "reasoning", summary: [] })), "signature_delta", "signature").get(0)?.[0];
    check(
      "another vendor's signature, a damaged one of ours and one with nothing to replay are dropped and never refused",
      [kinds("EqQBCgIYAhIM1gbcDa9GJwZA2b3h"), kinds(`${signature?.slice(0, 40)}`), kinds("rmr1."), kinds(unsigned), kinds(undefined)],
      Array.from({ length: 5 }, () => ["message", "message", "message"]),
    );
    const redacted = { model: MODEL, messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "text", text: "two" }] }] };
    check("and so is thinking that was redacted", inputOf(translator.request(redacted, { model: MODEL })).length, 1);
  }

  process.stdout.write("\nhow an answer ends\n");
  {
    const call = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "Read", arguments: "{}" };
    const ended = (status: string, reason: string | null): Wire =>
      event(status === "completed" ? "response.completed" : "response.incomplete", {
        response: response(status, [], { incomplete_details: reason === null ? null : { reason } }),
      });
    const withCall = [...textAnswer(event("response.output_item.done", { output_index: 1, item: call })), ended("completed", null)];
    check(
      "each stop reason: finished, a tool called, out of tokens, filtered",
      [
        stopOf(translated(textAnswer(ended("completed", null)))),
        stopOf(translated(withCall)),
        stopOf(translated(textAnswer(ended("incomplete", "max_output_tokens")))),
        stopOf(translated(textAnswer(ended("incomplete", "content_filter")))),
      ],
      ["end_turn", "tool_use", "max_tokens", "refusal"],
    );
    check(
      "and the same four where the answer was not streamed",
      [
        response("completed", []),
        response("completed", [call]),
        response("incomplete", [call], { incomplete_details: { reason: "max_output_tokens" } }),
        response("incomplete", [], { incomplete_details: { reason: "content_filter" } }),
      ].map((body) => (translator.whole(200, body, { model: MODEL }) as Json)["stop_reason"]),
      ["end_turn", "tool_use", "max_tokens", "refusal"],
    );

    const unfinished: string[] = [];
    for (const vector of streams) {
      for (let kept = 0; kept < vector.responses.length - 1; kept += 1) {
        const one = translator.stream({ model: vector.model });
        const out = [...vector.responses.slice(0, kept).flatMap((sentEvent) => one.push(sent(sentEvent))), ...one.end()].map(read);
        const count = (name: string): number => out.filter((got) => got.event === name).length;
        const finished = count("message_stop") + count("message_delta") > 0;
        const balanced = count("content_block_start") === count("content_block_stop");
        const quietAfter = one.push(sent(vector.responses[kept] as Wire)).length + one.end().length === 0;
        if (finished || !balanced || !quietAfter) unfinished.push(`${vector.file} after ${kept}`);
      }
    }
    check("cut after any event, every open block is closed, nothing says the answer finished, and nothing follows", unfinished, []);

    const failed = (code: string | null, message: string | null): Wire[] =>
      translated(textAnswer(event("response.failed", { response: response("failed", [], { error: { code, message } }) })));
    const errorOf = (events: Wire[]): unknown => events.find((got) => got.event === "error")?.data ?? null;
    check(
      "a failed answer is the error a Messages client reads, by what the provider called it",
      [
        errorOf(failed("rate_limit_exceeded", "slow down")),
        errorOf(failed("server_error", "broke")),
        errorOf(failed("server_is_overloaded", "busy")),
        errorOf(failed("something_new", "odd")),
        errorOf(failed(null, null)),
      ],
      [
        { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        { type: "error", error: { type: "api_error", message: "broke" } },
        { type: "error", error: { type: "overloaded_error", message: "busy" } },
        { type: "error", error: { type: "api_error", message: "odd" } },
        { type: "error", error: { type: "api_error", message: "The provider failed this answer and did not say why." } },
      ],
    );
    check("a context that is full is said in the words a client compacts on", errorOf(failed("context_length_exceeded", "Your input exceeds the context window.")), {
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long: Your input exceeds the context window." },
    });
    const flat = translated(textAnswer({ event: "error", data: { type: "error", code: "rate_limit_exceeded", message: "flat", param: null } }));
    const nested = translated(textAnswer({ event: "error", data: { type: "error", error: { code: "rate_limit_exceeded", message: "nested" } } }));
    check("an error event is read flat, as documented, and nested, as some send it", [errorOf(flat), errorOf(nested)], [
      { type: "error", error: { type: "rate_limit_error", message: "flat" } },
      { type: "error", error: { type: "rate_limit_error", message: "nested" } },
    ]);
    check("after an error nothing finishes the answer", [flat.at(-1)?.event, flat.some((got) => got.event === "message_stop")], ["error", false]);

    const strange = translated([
      event("response.created", { response: response("in_progress", []) }),
      event("response.output_item.added", { output_index: 0, item: { id: "cmp_1", type: "compaction" } }),
      event("response.completed", { response: response("completed", []) }),
    ]);
    const sentence = 'The provider answered with an item of type "compaction", which this conversation has no place for.';
    check("an item of a type nobody here knows ends the answer with its name, streamed or not", [
      errorOf(strange),
      strange.some((got) => got.event === "message_stop"),
      translator.whole(200, response("completed", [{ id: "cmp_1", type: "compaction" }]), { model: MODEL }),
    ], [
      { type: "error", error: { type: "invalid_request_error", message: sentence } },
      false,
      { type: "error", error: { type: "invalid_request_error", message: sentence } },
    ]);
  }

  process.stdout.write("\na whole answer, and a refusal\n");
  {
    for (const vector of streams.filter((one) => one.accepted !== undefined)) {
      const last = vector.responses.at(-1)?.data["response"];
      const whole = translator.whole(200, last, { model: vector.model }) as Json;
      const streamed = translated(vector.responses, vector.model);
      const text = [...deltasOf(streamed, "text_delta", "text").values()].flat().join("");
      const usage = streamed.find((got) => got.event === "message_delta")?.data["usage"];
      check(
        `${vector.file}: not streamed, it is the message the stream adds up to`,
        [whole["type"], whole["role"], whole["model"], (whole["content"] as Json[]).map((block) => block["type"]), (whole["content"] as Json[]).at(-1)?.["text"], whole["stop_reason"], whole["usage"]],
        ["message", "assistant", vector.model, outline(streamed).filter((line) => line.startsWith("content_block_start")).map((line) => line.split(" ")[2]), text, stopOf(streamed), usage],
      );
    }
    const used = translator.whole(200, response("completed", [], { usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 }, output_tokens: 80 } }), { model: MODEL });
    check("tokens read from a cache and written to one are counted beside the input, as Messages counts them", (used as Json)["usage"], {
      input_tokens: 50,
      cache_creation_input_tokens: 150,
      cache_read_input_tokens: 1000,
      output_tokens: 80,
    });
    const tool = translator.whole(200, response("completed", [{ id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a"}' }]), { model: MODEL });
    check("a call's arguments are an object again", (tool as Json)["content"], [{ type: "tool_use", id: "call_1", name: "Read", input: { path: "a" } }]);

    const types = [400, 401, 402, 403, 404, 413, 422, 429, 500, 502, 503, 529].map(
      (status) => ((translator.error(status, { error: { message: "said", type: "x", code: "y" } }) as Json)["error"] as Json)["type"],
    );
    check("each status a provider refuses with is the type Messages gives that status", types, [
      "invalid_request_error",
      "authentication_error",
      "billing_error",
      "permission_error",
      "not_found_error",
      "request_too_large",
      "invalid_request_error",
      "rate_limit_error",
      "api_error",
      "api_error",
      "api_error",
      "overloaded_error",
    ]);
    check(
      "with the provider's words, or a sentence where it gave none",
      [translator.error(429, { error: { message: "Rate limit reached.", type: "tokens", code: "rate_limit_exceeded" } }), translator.error(502, "<html>bad gateway</html>"), translator.error(400, { error: "plain" })],
      [
        { type: "error", error: { type: "rate_limit_error", message: "Rate limit reached." } },
        { type: "error", error: { type: "api_error", message: "The provider answered 502 and did not say why." } },
        { type: "error", error: { type: "invalid_request_error", message: "plain" } },
      ],
    );
    check("a refused request that was too long says so in the same words as a failed stream", translator.error(400, { error: { message: "Too many tokens.", code: "context_length_exceeded" } }), {
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long: Too many tokens." },
    });
    check("a whole answer with a refusing status is that refusal", translator.whole(404, { error: { message: "No such model." } }, { model: MODEL }), {
      type: "error",
      error: { type: "not_found_error", message: "No such model." },
    });
  }

  process.stdout.write("\nnothing malformed throws\n");
  {
    const junk: unknown[] = [undefined, null, 1, "x", [], {}, { messages: [null] }, { messages: [{ role: "user", content: [null] }] }, { messages: [{ role: "user" }] }];
    const bodies: unknown[] = [
      ...junk,
      { messages: [{ role: "assistant", content: [{ type: "tool_use" }] }] },
      { messages: [{ role: "user", content: [{ type: "tool_result" }] }] },
      { messages: [{ role: "user", content: [{ type: "image" }] }] },
      { messages: [], tools: [null] },
      { messages: [], tools: {} },
      { messages: [], system: 5 },
      { messages: [], tool_choice: "auto", output_config: "x", thinking: [], metadata: [] },
    ];
    const events: SseEvent[] = [
      { event: null, data: "[DONE]" },
      { event: "response.created", data: "{" },
      { event: null, data: "null" },
      { event: "response.output_item.added", data: "{}" },
      { event: null, data: '{"type":"response.output_text.delta"}' },
      { event: null, data: '{"type":"response.function_call_arguments.delta","delta":"{"}' },
      { event: null, data: '{"type":"response.reasoning_summary_text.delta","delta":"x","output_index":9}' },
      { event: null, data: '{"type":"response.output_item.done","item":{}}' },
      { event: null, data: '{"type":"response.completed","response":null}' },
    ];
    const thrown: string[] = [];
    const attempt = (what: string, run: () => unknown): void => {
      try {
        run();
      } catch (caught) {
        thrown.push(`${what}: ${String(caught)}`);
      }
    };
    for (const body of bodies) {
      attempt(`request ${JSON.stringify(body)}`, () => translator.request(body, { model: MODEL }));
      attempt(`whole ${JSON.stringify(body)}`, () => translator.whole(200, body, { model: MODEL }));
      attempt(`whole ${JSON.stringify(body)} with an output`, () => translator.whole(200, { output: [body] }, { model: MODEL }));
      attempt(`error ${JSON.stringify(body)}`, () => translator.error(500, body));
    }
    for (let from = 0; from < events.length; from += 1) {
      attempt(`stream from event ${from}`, () => {
        const one = translator.stream({ model: MODEL });
        for (const sentEvent of events.slice(from)) one.push(sentEvent);
        one.end();
      });
    }
    check("a request, an answer, an error or a stream this module cannot read is refused or passed over, never a crash", thrown, []);
    const unread = translator.request({ messages: [{ role: "user" }] }, { model: MODEL });
    check("and an unreadable request is a sentence too", unread, { untranslatable: "The request is not one this gateway can read." });
  }
}
