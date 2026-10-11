#!/usr/bin/env node
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_DOORS, type DoorLaunch } from "../src/acp/doors.js";
import { BUILTIN_CATALOGUE, SYSTEMS, type MachineCatalogue, type SystemId, type WireProtocol } from "../src/acp/systems.js";
import { TRANSLATIONS } from "../src/acp/systems.js";
import { SystemCredentials } from "../src/gateway/credentials.js";
import { ModelGatewayEndpoint } from "../src/gateway/endpoint.js";
import { TRANSLATORS } from "../src/gateway/translate/index.js";
import type { GrantSpec, UpstreamRequest, UpstreamResponse, UpstreamTransport } from "../src/gateway/types.js";
import { signInChecks } from "./gatewaycheck.signin.js";
import { translationChecks } from "./gatewaycheck.translate.js";

// Offline driver for the model gateway: a real endpoint on loopback, and a stand-in where the vendor would be.

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** Milliseconds from the request to each chunk of the answer. */
  chunkAt: number[];
}

interface Ask {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Hang up this long after the answer's headers arrive. */
  hangUpAfterMs?: number;
}

function ask(origin: string, one: Ask): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const url = new URL(one.path, origin);
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: one.method ?? "POST", headers: one.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        const chunkAt: number[] = [];
        const done = (): void =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), chunkAt });
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          chunkAt.push(Date.now() - started);
        });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
        if (one.hangUpAfterMs !== undefined) setTimeout(() => req.destroy(), one.hangUpAfterMs);
      },
    );
    req.on("error", (error) => {
      if (one.hangUpAfterMs !== undefined) return;
      reject(error);
    });
    req.end(one.body ?? "");
  });
}

/** A vendor that records what it was sent and answers what the test says next. */
class Vendor implements UpstreamTransport {
  readonly seen: UpstreamRequest[] = [];
  next: (request: UpstreamRequest) => Promise<UpstreamResponse> = async () => text(200, "{}");

  send(request: UpstreamRequest): Promise<UpstreamResponse> {
    this.seen.push(request);
    return this.next(request);
  }

  get last(): UpstreamRequest | undefined {
    return this.seen.at(-1);
  }
}

function text(status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }): UpstreamResponse {
  return {
    status,
    header: (name) => headers[name] ?? null,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

const MESSAGES = (model: string): string => JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });

const keys = new Map<SystemId, string>([["moonshot", "sk-vendor-key"]]);
let machine: MachineCatalogue = BUILTIN_CATALOGUE;
const vendor = new Vendor();
// The real source of credentials, so the sentences below are the ones a session is told.
const credentials = new SystemCredentials({
  machine: () => machine,
  keyFor: (system) => keys.get(system) ?? null,
  signIns: null,
  flows: {},
  transport: { postForm: async () => ({ status: 500, body: null }), getJson: async () => ({ status: 500, body: null }) },
});
const gateway = await ModelGatewayEndpoint.listen({
  secretFor: (system, signal) => credentials.secretFor(system, signal),
  machine: () => machine,
  transport: vendor,
});
const moonshot: GrantSpec = {
  system: "moonshot",
  model: "kimi-k3",
  inbound: "anthropic-messages",
  outbound: { protocol: "anthropic-messages", baseUrl: "https://vendor.invalid/anthropic" },
};
const grant = gateway.open(moonshot);
const asClaude = { "x-api-key": grant.bearer, authorization: "Bearer acp-proxy", "content-type": "application/json" };

process.stdout.write("\nwho may ask\n");
{
  check("the address is loopback and names no path", /^http:\/\/127\.0\.0\.1:\d+$/.test(grant.origin), true);
  check("a credential is 256 bits of its own", [/^[0-9a-f]{64}$/.test(grant.bearer), gateway.open(moonshot).bearer !== grant.bearer], [true, true]);

  const before = vendor.seen.length;
  const refusals = [
    (await ask(grant.origin, { path: "/v1/messages", headers: { "content-type": "application/json" }, body: MESSAGES("kimi-k3") })).status,
    (await ask(grant.origin, { path: "/v1/messages", headers: { "x-api-key": "0".repeat(64) }, body: MESSAGES("kimi-k3") })).status,
    (await ask(grant.origin, { path: "/v1/messages", headers: { authorization: "Bearer acp-proxy" }, body: MESSAGES("kimi-k3") })).status,
    (await ask(grant.origin, { path: "/v1/messages", headers: { ...asClaude, origin: "https://evil.example" }, body: MESSAGES("kimi-k3") })).status,
    (await ask(grant.origin, { path: "/v1/messages", headers: { ...asClaude, host: "rebound.example" }, body: MESSAGES("kimi-k3") })).status,
  ];
  check("nobody without one, with a wrong one, from a page or under another name", refusals, [401, 401, 401, 403, 403]);
  check("and none of those reached the vendor", vendor.seen.length, before);

  check(
    "what a harness asks before it holds anything is answered and goes nowhere",
    [
      (await ask(grant.origin, { method: "HEAD", path: "/api/hello" })).status,
      (await ask(grant.origin, { method: "GET", path: "/" })).status,
      vendor.seen.length,
    ],
    [204, 204, before],
  );

  const asBearer = await ask(grant.origin, {
    path: "/v1/messages",
    headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
    body: MESSAGES("kimi-k3"),
  });
  check("the credential is taken as a bearer too", asBearer.status, 200);

  const other = gateway.open(moonshot);
  other.close();
  check(
    "a closed one is nobody again, and closing it leaves the rest open",
    [
      (await ask(grant.origin, { path: "/v1/messages", headers: { "x-api-key": other.bearer }, body: MESSAGES("kimi-k3") })).status,
      (await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") })).status,
    ],
    [401, 200],
  );
}

process.stdout.write("\nwhat reaches the vendor\n");
{
  const body = MESSAGES("kimi-k3");
  vendor.next = async () => text(200, `{"ok":true}`, { "content-type": "application/json", "x-vendor-internal": "1", "retry-after": "7" });
  const answer = await ask(grant.origin, {
    path: "/v1/messages?beta=true",
    headers: {
      ...asClaude,
      accept: "application/json",
      "user-agent": "claude-cli/2.1.296",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
      "x-claude-code-session-id": "s-1",
      "x-stainless-os": "MacOS",
      cookie: "a=b",
    },
    body,
  });
  const sent = vendor.last;
  check("the address is the table's with the protocol's own path and the harness's query", sent?.url, "https://vendor.invalid/anthropic/v1/messages?beta=true");
  check("the body is the harness's, byte for byte", sent?.body.toString("utf8"), body);
  check("signed with the vendor's key in the vendor's header", sent?.headers["authorization"], "Bearer sk-vendor-key");
  check(
    "and carrying only what describes the request",
    Object.keys(sent?.headers ?? {}).sort(),
    ["accept", "anthropic-beta", "anthropic-version", "authorization", "content-type", "user-agent"],
  );
  check(
    "the harness's own credential is in no header and no value",
    JSON.stringify(sent?.headers ?? {}).includes(grant.bearer) || JSON.stringify(sent?.headers ?? {}).includes("acp-proxy"),
    false,
  );
  check("the answer comes back as the vendor gave it", [answer.status, answer.body], [200, `{"ok":true}`]);
  check(
    "with its type and its retry hint and nothing else of the vendor's",
    [answer.headers["content-type"], answer.headers["retry-after"], answer.headers["x-vendor-internal"] ?? null],
    ["application/json", "7", null],
  );

  vendor.next = async () => text(200, `{"input_tokens":3}`);
  await ask(grant.origin, { path: "/v1/messages/count_tokens?beta=true", headers: asClaude, body });
  check("a token count goes to its own path", vendor.last?.url, "https://vendor.invalid/anthropic/v1/messages/count_tokens?beta=true");

  for (const status of [404, 429, 500, 529]) {
    vendor.next = async () => text(status, `{"type":"error","error":{"type":"x","message":"vendor ${status}"}}`);
    const passed = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body });
    check(`a ${status} is the harness's to read`, [passed.status, passed.body.includes(`vendor ${status}`)], [status, true]);
  }

  // The key is read on each request: a session open across a change of key signs its next turn with the new one.
  keys.set("moonshot", "sk-replaced");
  vendor.next = async () => text(200, "{}");
  await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body });
  check("a key replaced mid-session signs the next request", vendor.last?.headers["authorization"], "Bearer sk-replaced");
  keys.set("moonshot", "sk-vendor-key");

  const routes = [
    (await ask(grant.origin, { path: "/v1/responses", headers: asClaude, body })).status,
    (await ask(grant.origin, { path: "/v1/chat/completions", headers: asClaude, body })).status,
    (await ask(grant.origin, { path: "/v1/models", method: "GET", headers: asClaude })).status,
    (await ask(grant.origin, { path: "/v1/messages", method: "GET", headers: asClaude })).status,
    (await ask(grant.origin, { path: "/anything/else", headers: asClaude, body })).status,
  ];
  check("a launch opened for one protocol reaches no other, and nothing outside the table", routes, [404, 404, 404, 404, 404]);

  const openai = gateway.open({
    system: "moonshot",
    model: "m",
    inbound: "openai-responses",
    outbound: { protocol: "openai-responses", baseUrl: "https://vendor.invalid/v1" },
  });
  await ask(openai.origin, { path: "/v1/responses", headers: { authorization: `Bearer ${openai.bearer}` }, body: JSON.stringify({ model: "m" }) });
  const chat = gateway.open({
    system: "moonshot",
    model: "m",
    inbound: "openai-chat",
    outbound: { protocol: "openai-chat", baseUrl: "https://vendor.invalid/v1" },
  });
  const afterResponses = vendor.last?.url;
  await ask(chat.origin, { path: "/v1/chat/completions", headers: { authorization: `Bearer ${chat.bearer}` }, body: JSON.stringify({ model: "m" }) });
  check(
    "an OpenAI base carries its version, and the path is appended to it",
    [afterResponses, vendor.last?.url],
    ["https://vendor.invalid/v1/responses", "https://vendor.invalid/v1/chat/completions"],
  );
  openai.close();
  chat.close();
}

process.stdout.write("\nwhat is refused here, and how each harness is told\n");
{
  const errorOf = (answer: Answer): unknown => JSON.parse(answer.body);
  const before = vendor.seen.length;

  const wrong = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("claude-haiku-4-5") });
  check("another model is refused in the harness's own error shape, as a status it ends a turn on", [wrong.status, errorOf(wrong)], [
    400,
    {
      type: "error",
      error: { type: "invalid_request_error", message: "This session runs on kimi-k3; the agent asked Moonshot for claude-haiku-4-5." },
    },
  ]);
  const unnamed = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: "not json" });
  check("and so is a request that names none", [unnamed.status, (errorOf(unnamed) as { error: { message: string } }).error.message], [
    400,
    "This session runs on kimi-k3; the agent asked Moonshot for another model.",
  ]);

  keys.delete("moonshot");
  const keyless = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") });
  check("no key is a sentence naming the provider", [keyless.status, (errorOf(keyless) as { error: { message: string } }).error.message], [
    400,
    "No key is saved for Moonshot on this machine, so nothing can sign these requests.",
  ]);
  keys.set("moonshot", "sk-vendor-key");

  machine = { ...BUILTIN_CATALOGUE, system: () => null };
  const gone = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") });
  check("a provider that left the machine is said so", [gone.status, (errorOf(gone) as { error: { message: string } }).error.message], [
    400,
    "This session's provider is no longer on this machine.",
  ]);
  machine = BUILTIN_CATALOGUE;
  check("none of the four reached the vendor", vendor.seen.length, before);

  // A 401 passed through reads as the agent's own sign-in failing, which replaces the agent and repairs nothing (Q6.123).
  for (const status of [401, 403]) {
    vendor.next = async () => text(status, `{"error":{"message":"Invalid  Authentication\\n","type":"invalid_authentication_error"}}`);
    const refused = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") });
    check(`the vendor's ${status} is this machine's key being refused, never the agent's sign-in`, [refused.status, errorOf(refused)], [
      400,
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Moonshot refused the key saved on this machine: Invalid Authentication." },
      },
    ]);
  }
  vendor.next = async () => text(401, "<html>nope</html>", { "content-type": "text/html" });
  const wordless = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") });
  check("and a refusal with no words of its own still ends as a sentence", (errorOf(wordless) as { error: { message: string } }).error.message, "Moonshot refused the key saved on this machine.");

  vendor.next = async () => {
    throw new Error("getaddrinfo ENOTFOUND vendor.invalid");
  };
  const unreachable = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") });
  check("a vendor that cannot be reached is a status a harness tries again on, with no address in it", [unreachable.status, errorOf(unreachable)], [
    502,
    { type: "error", error: { type: "api_error", message: "Moonshot could not be reached from this machine." } },
  ]);

  const responses = gateway.open({
    system: "moonshot",
    model: "m",
    inbound: "openai-responses",
    outbound: { protocol: "openai-responses", baseUrl: "https://vendor.invalid/v1" },
  });
  const openaiShaped = await ask(responses.origin, { path: "/v1/responses", headers: { authorization: `Bearer ${responses.bearer}` }, body: JSON.stringify({ model: "other" }) });
  check("an OpenAI-shaped harness is told in its shape, with the code", [openaiShaped.status, errorOf(openaiShaped)], [
    400,
    {
      error: {
        message: "This session runs on m; the agent asked Moonshot for other.",
        type: "invalid_request_error",
        code: "gateway_wrong_model",
      },
    },
  ]);
  responses.close();

  const unpinned = gateway.open({ ...moonshot, model: null });
  vendor.next = async () => text(200, "{}");
  const any = await ask(unpinned.origin, { path: "/v1/messages", headers: { "x-api-key": unpinned.bearer }, body: MESSAGES("whatever") });
  check("a launch that named no model is held to none", any.status, 200);
  unpinned.close();
}

process.stdout.write("\na stream, a hang-up and a body too large\n");
{
  const encoder = new TextEncoder();
  let aborted = false;
  vendor.next = async (request) => {
    request.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return {
      status: 200,
      header: (name) => (name === "content-type" ? "text/event-stream" : null),
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (request.signal.aborted) return;
          controller.enqueue(encoder.encode("event: message_stop\ndata: {}\n\n"));
          controller.close();
        },
      }),
    };
  };
  const stream = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") });
  const [first = 0, last = 0] = [stream.chunkAt[0], stream.chunkAt.at(-1)];
  check("a stream arrives as it is written, the first event well before the last", [stream.chunkAt.length >= 2, last - first >= 200], [true, true]);
  check("and whole", stream.body, "event: ping\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");

  aborted = false;
  await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3"), hangUpAfterMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  check("a harness that hangs up stops the vendor generating", aborted, true);

  vendor.next = async () => ({
    status: 200,
    header: () => null,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
        controller.error(new Error("socket hang up"));
      },
    }),
  });
  const cut = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: MESSAGES("kimi-k3") }).then(
    (answer) => answer.body.includes("message_stop"),
    () => false,
  );
  check("a stream the vendor cut ends as a cut, never as a finished answer", cut, false);

  const before = vendor.seen.length;
  const huge = Buffer.alloc(33 * 1024 * 1024, 0x20);
  const tooLarge = await ask(grant.origin, { path: "/v1/messages", headers: asClaude, body: huge }).then(
    (answer) => answer.status,
    () => 413,
  );
  check("a body past the bound is refused and never forwarded", [tooLarge, vendor.seen.length], [413, before]);
}

process.stdout.write("\none protocol carried into another\n");
{
  check(
    "every pair a route may end in has a translator, and no translator stands for a pair no route names",
    TRANSLATORS.map((one) => `${one.inbound} into ${one.outbound}`).sort(),
    TRANSLATIONS.map(([inbound, outbound]) => `${inbound} into ${outbound}`).sort(),
  );

  keys.set("openai", "sk-openai-key");
  const carried = gateway.open({
    system: "openai",
    model: "gpt-x",
    inbound: "anthropic-messages",
    outbound: { protocol: "openai-responses", baseUrl: "https://vendor.invalid/v1" },
  });
  const asked = { "x-api-key": carried.bearer, authorization: "Bearer acp-proxy", "content-type": "application/json" };
  const inbound = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      model: "gpt-x",
      max_tokens: 64,
      stream: true,
      system: [{ type: "text", text: "be brief" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      ...extra,
    });

  const sse = (events: readonly Record<string, unknown>[]): UpstreamResponse => ({
    status: 200,
    header: (name) => (name === "content-type" ? "text/event-stream" : null),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) controller.enqueue(encoder.encode(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }),
  });
  const reply = { id: "resp_1", object: "response", model: "gpt-x", status: "completed", output: [] as unknown[], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
  const item = { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }] };
  const answered = [
    { type: "response.created", response: { ...reply, status: "in_progress", usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...reply, output: [item] } },
  ];

  vendor.next = async () => sse(answered);
  const turn = await ask(carried.origin, {
    path: "/v1/messages?beta=true",
    headers: { ...asked, "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219", "user-agent": "claude-cli/2.1.296" },
    body: inbound(),
  });
  const sent = vendor.last;
  const sentBody = JSON.parse(sent?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
  check("the request goes to the other protocol's path, with nothing of the first one's query", sent?.url, "https://vendor.invalid/v1/responses");
  check(
    "as that protocol's body: the prompt as instructions, the turn as input, nothing stored",
    [sentBody["model"], sentBody["instructions"], Array.isArray(sentBody["input"]), sentBody["store"], sentBody["stream"], "messages" in sentBody, "system" in sentBody],
    ["gpt-x", "be brief", true, false, true, false, false],
  );
  check(
    "signed with that vendor's key, and carrying nothing the harness said about itself or its protocol",
    Object.entries(sent?.headers ?? {}).sort(),
    [
      ["authorization", "Bearer sk-openai-key"],
      ["content-type", "application/json"],
    ],
  );
  const events = turn.body.split("\n").filter((line) => line.startsWith("event: ")).map((line) => line.slice(7));
  check(
    "the answer streams back in the harness's own events, and ends as a finished one",
    [turn.status, turn.headers["content-type"], events[0], events.includes("content_block_delta"), events.at(-1), turn.body.includes(`"text":"hello"`)],
    [200, "text/event-stream", "message_start", true, "message_stop", true],
  );

  vendor.next = async () => sse(answered.slice(0, 4));
  const short = await ask(carried.origin, { path: "/v1/messages", headers: asked, body: inbound() }).then(
    (answer) => answer.body.includes("message_stop"),
    () => false,
  );
  check("an answer the vendor never finished is a cut, never a short reply", short, false);

  vendor.next = async () => text(429, `{"error":{"message":"slow down","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}`, { "retry-after": "3" });
  const limited = await ask(carried.origin, { path: "/v1/messages", headers: asked, body: inbound() });
  check(
    "the vendor's error keeps its status and its retry hint, in the harness's own error shape",
    [limited.status, limited.headers["retry-after"], JSON.parse(limited.body)],
    [429, "3", { type: "error", error: { type: "rate_limit_error", message: "slow down" } }],
  );

  vendor.next = async () => text(200, JSON.stringify({ ...reply, output: [item] }));
  const whole = await ask(carried.origin, { path: "/v1/messages", headers: asked, body: inbound({ stream: false }) });
  const message = JSON.parse(whole.body) as { type?: string; role?: string; content?: { type: string; text?: string }[]; stop_reason?: string };
  check(
    "an answer asked for whole comes back whole",
    [whole.status, message.type, message.role, message.content?.[0]?.text, message.stop_reason],
    [200, "message", "assistant", "hello", "end_turn"],
  );

  const before = vendor.seen.length;
  const uncarried = await ask(carried.origin, {
    path: "/v1/messages",
    headers: asked,
    body: inbound({ messages: [{ role: "user", content: [{ type: "container_upload", file_id: "f" }] }] }),
  });
  const refusal = JSON.parse(uncarried.body) as { type: string; error: { type: string; message: string } };
  check(
    "what cannot be carried is refused here in a sentence naming it, and never sent short",
    [uncarried.status, refusal.type, refusal.error.message.includes("container_upload"), vendor.seen.length],
    [400, "error", true, before],
  );
  check(
    "a token count has no counterpart there, and is the 404 a harness is measured to survive",
    [(await ask(carried.origin, { path: "/v1/messages/count_tokens", headers: asked, body: inbound() })).status, vendor.seen.length],
    [404, before],
  );
  carried.close();
  keys.delete("openai");

  // grok's Messages requests name no version, and the vendor's own endpoint requires one (Q6.127).
  vendor.next = async () => text(200, "{}");
  await ask(grant.origin, { path: "/v1/messages", headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" }, body: MESSAGES("kimi-k3") });
  const unversioned = vendor.last?.headers["anthropic-version"];
  await ask(grant.origin, { path: "/v1/messages", headers: { ...asClaude, "anthropic-version": "2099-01-01" }, body: MESSAGES("kimi-k3") });
  check("a Messages request that names no version is sent with one, and one that does keeps its own", [unversioned, vendor.last?.headers["anthropic-version"]], ["2023-06-01", "2099-01-01"]);

  await translationChecks(check);
}

process.stdout.write("\na sign-in in place of a key\n");
{
  const { SignInError } = await import("../src/gateway/signin/types.js");
  type Tokens = import("../src/gateway/signin/types.js").SignInTokens;
  type Stored = import("../src/acp/systems.js").StoredSignIn;

  const planned: MachineCatalogue = {
    ...BUILTIN_CATALOGUE,
    system: (id) =>
      id === "plan"
        ? { ...SYSTEMS.openai, displayName: "The plan", nativeHarness: null, loginVia: null, signIn: "fake" }
        : BUILTIN_CATALOGUE.system(id),
  };
  let clock = 1_000_000;
  let stored: Stored | null = null;
  const writes: string[] = [];
  let refreshes = 0;
  let nextRefresh: () => Promise<Tokens | "signed_out"> = async () => "signed_out";
  const source = new SystemCredentials({
    machine: () => planned,
    keyFor: () => null,
    signIns: {
      get: () => stored,
      save: (_system, flow, tokens, signedInBy) => {
        writes.push(tokens.refresh);
        stored = { ...tokens, flow, signedInBy, updatedAt: clock };
      },
      remove: () => {
        stored = null;
      },
      hostId: () => "urn:uuid:test",
    },
    flows: {
      fake: {
        id: "fake",
        authorizeOrigin: "https://id.invalid",
        begin: () => {
          throw new Error("not driven here");
        },
        complete: async () => {
          throw new Error("not driven here");
        },
        refresh: async () => {
          refreshes += 1;
          return nextRefresh();
        },
      },
    },
    transport: { postForm: async () => ({ status: 500, body: null }), getJson: async () => ({ status: 500, body: null }) },
    now: () => clock,
  });
  const never = new AbortController().signal;
  const held = (access: string, refresh: string, expiresAt: number): Stored => ({
    flow: "fake",
    clientId: "client",
    access,
    refresh,
    expiresAt,
    account: "somebody@example.com",
    signedInBy: "u_1",
    updatedAt: clock,
  });

  check("with nobody signed in it says so, at a start and on a request", [source.missing("plan"), await source.secretFor("plan", never)], [
    "Nobody is signed in to The plan on this machine.",
    { code: "gateway_no_credential", message: "Nobody is signed in to The plan on this machine.", retryable: false },
  ]);

  stored = held("access-1", "refresh-1", clock + 3_600_000);
  check("a token with time left is spent as it is, and nobody is asked", [source.missing("plan"), await source.secretFor("plan", never), refreshes], [null, "access-1", 0]);

  // A refresh token is spent by its first use, so five requests that find the token stale must make one call between them.
  clock += 3_590_000;
  let release: (tokens: Tokens) => void = () => {};
  nextRefresh = () => new Promise<Tokens>((resolve) => (release = resolve));
  const five = Array.from({ length: 5 }, () => source.secretFor("plan", never));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release({ clientId: "client", access: "access-2", refresh: "refresh-2", expiresAt: clock + 3_600_000, account: "somebody@example.com" });
  check("a token about to stop working is renewed once for every request that found it so", [await Promise.all(five), refreshes], [
    ["access-2", "access-2", "access-2", "access-2", "access-2"],
    1,
  ]);
  check("the renewed sign-in is stored, with who signed in kept", [writes, (stored as Stored | null)?.refresh, (stored as Stored | null)?.signedInBy], [["refresh-2"], "refresh-2", "u_1"]);

  clock += 3_590_000;
  nextRefresh = async () => {
    throw new SignInError("sign_in_unreachable", "The plan's sign-in service could not be reached.");
  };
  check("a provider that cannot be asked is a thing to try again, and the sign-in is kept", [await source.secretFor("plan", never), (stored as Stored | null)?.refresh], [
    { code: "gateway_upstream_unreachable", message: "The plan's sign-in service could not be reached.", retryable: true },
    "refresh-2",
  ]);

  nextRefresh = async () => "signed_out";
  check("a provider that no longer honours it signs the machine out, in a sentence that says what to do", [await source.secretFor("plan", never), stored, source.missing("plan")], [
    { code: "gateway_signed_out", message: "The plan signed this machine out. Sign in again to carry on.", retryable: false },
    null,
    "Nobody is signed in to The plan on this machine.",
  ]);
}

process.stdout.write("\na plan that is signed in to, on the wire\n");
{
  // The real row: its sign-in names the shape a request must take, and a stand-in store holds somebody signed in.
  const plan = new SystemCredentials({
    machine: () => BUILTIN_CATALOGUE,
    keyFor: () => null,
    signIns: {
      get: (system) =>
        system === "chatgpt"
          ? { flow: "openai-siwc", clientId: "c", access: "plan-access", refresh: "r", expiresAt: Date.now() + 3_600_000, account: null, signedInBy: null, updatedAt: 1 }
          : null,
      save: () => {},
      remove: () => {},
      hostId: () => "urn:uuid:x",
    },
    // Named, so the stored sign-in is one this machine can still renew; nothing here is stale enough to ask it.
    flows: {
      "openai-siwc": {
        id: "openai-siwc",
        authorizeOrigin: "https://id.invalid",
        begin: () => {
          throw new Error("not driven here");
        },
        complete: async () => {
          throw new Error("not driven here");
        },
        refresh: async () => "signed_out",
      },
    },
    transport: { postForm: async () => ({ status: 500, body: null }), getJson: async () => ({ status: 500, body: null }) },
  });
  const planVendor = new Vendor();
  const planGate = await ModelGatewayEndpoint.listen({ secretFor: (system, signal) => plan.secretFor(system, signal), machine: () => BUILTIN_CATALOGUE, transport: planVendor });
  const asResponses = planGate.open({ system: "chatgpt", model: "gpt-x", inbound: "openai-responses", outbound: { protocol: "openai-responses", baseUrl: "https://vendor.invalid/v1" } });
  const bearer = { authorization: `Bearer ${asResponses.bearer}`, "content-type": "application/json" };
  const body = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      model: "gpt-x",
      stream: true,
      store: true,
      max_output_tokens: 99,
      temperature: 0.2,
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "s" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      tools: [{ type: "function", name: "shell", parameters: {} }, { type: "image_generation" }],
      ...extra,
    });

  planVendor.next = async () => text(200, "{}", { "content-type": "text/event-stream" });
  await ask(asResponses.origin, { path: "/v1/responses", headers: bearer, body: body() });
  const went = JSON.parse(planVendor.last?.body.toString("utf8") ?? "{}") as Record<string, any>;
  check(
    "a request for a plan is put in the shape the programme takes, whatever the harness sent",
    [went["store"], went["stream"], "max_output_tokens" in went, "temperature" in went, went["input"]?.map((one: any) => one.role), went["tools"]?.map((one: any) => one.type)],
    [false, true, false, false, ["developer", "user"], ["function"]],
  );
  check("and signed with the access token of whoever is signed in", planVendor.last?.headers["authorization"], "Bearer plan-access");

  const before = planVendor.seen.length;
  const whole = await ask(asResponses.origin, { path: "/v1/responses", headers: bearer, body: body({ stream: false }) });
  const kept = await ask(asResponses.origin, { path: "/v1/responses", headers: bearer, body: body({ previous_response_id: "resp_1" }) });
  check(
    "what a plan cannot be sent is refused here, in a sentence, and never sent short",
    [whole.status, (JSON.parse(whole.body) as any).error.message, kept.status, (JSON.parse(kept.body) as any).error.code, planVendor.seen.length],
    [400, "ChatGPT answers only as a stream, and this agent asked for a whole answer.", 400, "gateway_untranslatable", before],
  );

  // A plan's limit clears in hours: passed through as a 429 it is what every harness measured spends minutes retrying.
  planVendor.next = async () => text(429, `{"error":{"message":"You have hit your usage limit.","code":"subscription_sharing_usage_limit_exceeded"}}`);
  const spent = await ask(asResponses.origin, { path: "/v1/responses", headers: bearer, body: body() });
  planVendor.next = async () => text(403, `{"error":{"message":"This account is not eligible.","code":"subscription_sharing_user_not_eligible"}}`);
  const ineligible = await ask(asResponses.origin, { path: "/v1/responses", headers: bearer, body: body() });
  check(
    "a plan at its limit, or one that may not be used here, ends the turn with the vendor's own words",
    [spent.status, JSON.parse(spent.body), ineligible.status, (JSON.parse(ineligible.body) as any).error.message],
    [
      400,
      { error: { message: "The ChatGPT plan signed in on this machine has reached a limit: You have hit your usage limit.", type: "invalid_request_error", code: "gateway_usage_limit" } },
      400,
      "ChatGPT refused this machine's sign-in: This account is not eligible.",
    ],
  );

  // claude asks in Messages: translated first, then shaped, so both sets of rules have been applied to what leaves.
  const asMessages = planGate.open({ system: "chatgpt", model: "gpt-x", inbound: "anthropic-messages", outbound: { protocol: "openai-responses", baseUrl: "https://vendor.invalid/v1" } });
  planVendor.next = async () => text(200, "{}", { "content-type": "text/event-stream" });
  await ask(asMessages.origin, {
    path: "/v1/messages",
    headers: { "x-api-key": asMessages.bearer, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-x", max_tokens: 64, temperature: 1, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const translated = JSON.parse(planVendor.last?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
  check(
    "a harness that asks in another protocol is translated and then shaped",
    [planVendor.last?.url, Array.isArray(translated["input"]), translated["store"], "max_output_tokens" in translated, "temperature" in translated],
    ["https://vendor.invalid/v1/responses", true, false, false, false],
  );
  await planGate.close();
}

process.stdout.write("\na sign-in from start to stored\n");
{
  const { SystemSignInRuns } = await import("../src/gateway/signin/runs.js");
  const { SignInError } = await import("../src/gateway/signin/types.js");
  type Flow = import("../src/gateway/signin/types.js").SignInFlow;
  type Stored = import("../src/acp/systems.js").StoredSignIn;

  const planned: MachineCatalogue = {
    ...BUILTIN_CATALOGUE,
    system: (id) => (id === "plan" ? { ...SYSTEMS.openai, displayName: "The plan", nativeHarness: null, loginVia: null, signIn: "fake" } : BUILTIN_CATALOGUE.system(id)),
  };
  const saved = new Map<string, Stored>();
  const begun: { redirectUri: string; hostId: string }[] = [];
  const fake: Flow = {
    id: "fake",
    authorizeOrigin: "https://id.invalid",
    begin: (input) => {
      begun.push(input);
      return {
        authorizeUrl: `https://id.invalid/authorize?state=st-${begun.length}`,
        state: `st-${begun.length}`,
        verifier: "the-verifier",
        nonce: "the-nonce",
        redirectUri: input.redirectUri,
        hostId: input.hostId,
      };
    },
    complete: async (attempt, handedBack) => {
      if (handedBack.get("state") !== attempt.state) throw new SignInError("sign_in_refused", "The page that came back is not the one this sign-in opened.");
      if (handedBack.get("code") === null) throw new SignInError("sign_in_refused", "The provider's page handed nothing back.");
      return { clientId: "client-1", access: "access-1", refresh: "refresh-1", expiresAt: 9, account: "somebody@example.com" };
    },
    refresh: async () => "signed_out",
  };
  const runs = new SystemSignInRuns({
    machine: () => planned,
    flows: { fake },
    signIns: {
      get: (system) => saved.get(system) ?? null,
      save: (system, flow, tokens, signedInBy) => void saved.set(system, { ...tokens, flow, signedInBy, updatedAt: 1 }),
      remove: (system) => void saved.delete(system),
      hostId: () => "urn:uuid:this-machine",
    },
    transport: { postForm: async () => ({ status: 500, body: null }), getJson: async () => ({ status: 500, body: null }) },
  });
  const get = async (url: string, host?: string): Promise<[number, string]> => {
    const target = new URL(url);
    const answer = await ask(target.origin, { method: "GET", path: `${target.pathname}${target.search}`, ...(host === undefined ? {} : { headers: { host } }) });
    return [answer.status, answer.body];
  };

  check("a system that takes a key has no sign-in to start", await runs.start("moonshot", "u_1"), { refusal: "Moonshot takes a key, not a sign-in." });

  const first = await runs.start("plan", "u_1");
  if ("refusal" in first) throw new Error(first.refusal);
  const redirect = begun[0]?.redirectUri ?? "";
  check(
    "a start names the page to open and where that page hands back: this computer, the path the provider documents, a port of its own",
    [first.phase, first.openUrl, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirect), begun[0]?.hostId],
    ["waiting", "https://id.invalid/authorize?state=st-1", true, "urn:uuid:this-machine"],
  );
  check(
    "what a client is shown of it holds no state, verifier or nonce",
    Object.keys(first).sort(),
    ["account", "expiresAt", "id", "message", "openUrl", "phase", "system"],
  );
  check(
    "the listener answers its one path, to a browser on this computer, and nothing else",
    [(await get(redirect.replace("/auth/callback", "/"))) [0], (await get(`${redirect}?code=c&state=st-1`, "rebound.example"))[0], runs.view(first.id)?.phase],
    [404, 404, "waiting"],
  );
  check(
    "a page that hands back another sign-in's state is refused in words, and nothing is stored",
    [await get(`${redirect}?code=c&state=nope`), runs.view(first.id)?.phase, saved.size],
    [[400, "The page that came back is not the one this sign-in opened."], "failed", 0],
  );

  const second = await runs.start("plan", "u_1");
  if ("refusal" in second) throw new Error(second.refusal);
  const there = begun[1]?.redirectUri ?? "";
  check(
    "the page handing back the right thing signs the system in, as whoever started it",
    [await get(`${there}?code=c&state=st-2`), runs.view(second.id), saved.get("plan")],
    [
      [200, "Signed in. This tab can be closed."],
      { ...second, phase: "done", account: "somebody@example.com" },
      { clientId: "client-1", access: "access-1", refresh: "refresh-1", expiresAt: 9, account: "somebody@example.com", flow: "fake", signedInBy: "u_1", updatedAt: 1 },
    ],
  );

  // A browser on another computer is sent to 127.0.0.1 there, where nothing listens: the address it could not load is pasted in.
  saved.clear();
  const third = await runs.start("plan", "u_2");
  if ("refusal" in third) throw new Error(third.refusal);
  const elsewhere = begun[2]?.redirectUri ?? "";
  check(
    "a pasted address is read only where it is this sign-in's own",
    [
      await runs.redirected(third.id, "not an address"),
      await runs.redirected(third.id, `https://evil.example/auth/callback?code=c&state=st-3`),
      await runs.redirected(third.id, `${there}?code=c&state=st-3`),
      await runs.redirected(third.id, `${elsewhere.replace("/auth/callback", "/other")}?code=c&state=st-3`),
      await runs.redirected("si_nobody", `${elsewhere}?code=c&state=st-3`),
      saved.size,
    ],
    [
      { refusal: "That is not an address." },
      { refusal: "That is not the address this sign-in ends at." },
      { refusal: "That is not the address this sign-in ends at." },
      { refusal: "That is not the address this sign-in ends at." },
      null,
      0,
    ],
  );
  const pasted = await runs.redirected(third.id, `  ${elsewhere}?code=c&state=st-3  `);
  check("and where it is, finishes the sign-in as the callback would", [pasted !== null && !("refusal" in pasted) && pasted.phase, saved.get("plan")?.signedInBy], ["done", "u_2"]);

  const fourth = await runs.start("plan", "u_1");
  const fifth = await runs.start("plan", "u_1");
  if ("refusal" in fourth || "refusal" in fifth) throw new Error("a start refused");
  check(
    "a second start for a system ends the first, and giving one up forgets it",
    [runs.view(fourth.id)?.phase, runs.view(fourth.id)?.message, runs.view(fifth.id)?.phase, runs.abandon(fifth.id), runs.view(fifth.id), runs.abandon(fifth.id)],
    ["failed", "Another sign-in was started in its place.", "waiting", true, null, false],
  );
  runs.shutdown();
}

await signInChecks(check);

process.stdout.write("\nwhat a door hands a harness\n");
{
  const PROTOCOLS: readonly WireProtocol[] = ["anthropic-messages", "openai-responses", "openai-chat"];
  const home = mkdtempSync(join(tmpdir(), "gatewaycheck-door-"));
  const launch = (protocol: WireProtocol): DoorLaunch => ({
    origin: "http://127.0.0.1:4242",
    bearer: "b".repeat(64),
    model: "vendor/some.model-4.5",
    protocol,
    home,
  });

  const claude = HARNESS_DOORS.claude;
  check(
    "claude carries its credential where it does not overwrite it",
    claude?.via === "providers-set" ? [claude.speaks, claude.grantHeaders("c")] : null,
    [["anthropic-messages"], { "x-api-key": "c" }],
  );

  const opencode = HARNESS_DOORS.opencode;
  if (opencode?.via !== "spawn") throw new Error("opencode's door is set at the spawn");
  const inline = PROTOCOLS.map((protocol) => {
    const env = opencode.prepare(launch(protocol));
    return { env, config: JSON.parse(env["OPENCODE_CONFIG_CONTENT"] ?? "{}") as Record<string, any> };
  });
  // Each of these, left to the person's own config, sent a title or a compaction to a vendor nobody chose (Q6.126).
  check(
    "opencode is told one model in every place it reads one, and one provider",
    inline.map(({ config }) => [
      config["model"],
      config["small_model"],
      config["agent"]?.title?.model,
      config["agent"]?.summary?.model,
      config["agent"]?.compaction?.model,
      config["enabled_providers"],
      config["share"],
    ]),
    PROTOCOLS.map(() => [
      "reemoat/vendor/some.model-4.5",
      "reemoat/vendor/some.model-4.5",
      "reemoat/vendor/some.model-4.5",
      "reemoat/vendor/some.model-4.5",
      "reemoat/vendor/some.model-4.5",
      ["reemoat"],
      "disabled",
    ]),
  );
  check(
    "in the protocol the route chose, at the gateway and with the launch's credential",
    inline.map(({ config }) => {
      const provider = config["provider"]?.reemoat;
      return [provider?.npm, provider?.options, Object.keys(provider?.models ?? {})];
    }),
    [
      ["@ai-sdk/anthropic", { baseURL: "http://127.0.0.1:4242/v1", apiKey: "b".repeat(64) }, ["vendor/some.model-4.5"]],
      ["@ai-sdk/openai", { baseURL: "http://127.0.0.1:4242/v1", apiKey: "b".repeat(64) }, ["vendor/some.model-4.5"]],
      ["@ai-sdk/openai-compatible", { baseURL: "http://127.0.0.1:4242/v1", apiKey: "b".repeat(64) }, ["vendor/some.model-4.5"]],
    ],
  );
  check(
    "in a home of this daemon's, so no config of the person's is merged under it",
    ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].map((name) => (inline[0]?.env[name] ?? "").startsWith(`${home}/`)),
    [true, true, true, true],
  );
  check("and its control must read the provider and the model together", opencode.held("m"), "reemoat/m");

  const grok = HARNESS_DOORS.grok;
  if (grok?.via !== "spawn") throw new Error("grok's door is set at the spawn");
  const written = PROTOCOLS.map((protocol) => {
    const env = grok.prepare(launch(protocol));
    return { env, toml: readFileSync(join(home, "config.toml"), "utf8") };
  });
  // default and session_summary both: with either missing the title names an xAI model, and on a pinned session goes to xAI (Q6.127).
  check(
    "grok's file names the model everywhere grok reads one, under a key a person can read",
    written[0]?.toml.split("\n").filter((line) => line.length > 0),
    [
      "[models]",
      `default = "vendor-some-model-4-5"`,
      `session_summary = "vendor-some-model-4-5"`,
      `allowed_models = ["vendor-some-model-4-5"]`,
      "[model.vendor-some-model-4-5]",
      `model = "vendor/some.model-4.5"`,
      `base_url = "http://127.0.0.1:4242/v1"`,
      `api_backend = "messages"`,
      `env_key = "REEMOAT_MODEL_BEARER"`,
      "max_retries = 2",
    ],
  );
  check(
    "in each protocol's own word",
    written.map(({ toml }) => /api_backend = "([a-z_]+)"/.exec(toml)?.[1]),
    ["messages", "responses", "chat_completions"],
  );
  check(
    "the credential is in the environment and never in the file, and an xAI key of the daemon's own is withheld",
    [written[0]?.env["REEMOAT_MODEL_BEARER"], written[0]?.toml.includes("b".repeat(64)), "XAI_API_KEY" in (written[0]?.env ?? {}), written[0]?.env["XAI_API_KEY"] ?? null, written[0]?.env["GROK_HOME"]],
    ["b".repeat(64), false, true, null, home],
  );
  check("the file is this user's alone", (statSync(join(home, "config.toml")).mode & 0o777).toString(8), "600");
  check(
    "a key is letters, digits and dashes whatever the model is called",
    [grok.held("qwen/qwen3-coder:free"), grok.held("///"), grok.held("a".repeat(200)).length],
    ["qwen-qwen3-coder-free", "model", 64],
  );
  check("every door speaks a protocol the gateway serves", Object.values(HARNESS_DOORS).every((door) => door.speaks.every((one) => PROTOCOLS.includes(one))), true);
}

process.stdout.write("\nwhat may be signed, and from where\n");
{
  // A sign-in to a vendor's own client is never a system's key: whatever spends keys here takes a system and has no harness to read one from (Q7.156).
  const SUBSCRIPTION_VARIABLES = ["CLAUDE_CODE_OAUTH_TOKEN"];
  check(
    "no system borrows a variable that holds a subscription sign-in",
    Object.entries(SYSTEMS).filter(([, spec]) => spec.keyEnv !== null && SUBSCRIPTION_VARIABLES.includes(spec.keyEnv)).map(([id]) => id),
    [],
  );

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const callers = files(join(root, "src"))
    .filter((path) => /(?<![.\w])fetch\(/.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
    .sort();
  // Every place this daemon speaks first, named: a fifth is a decision, and the one on a session's path is the gateway's alone.
  check("the daemon's outbound calls are these and no others", callers, [
    "src/enroll.ts",
    "src/gateway/signin/identity.ts",
    "src/gateway/upstream.ts",
    "src/plugins/api.ts",
    "src/plugins/source.ts",
  ]);
}

await gateway.close();
process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
